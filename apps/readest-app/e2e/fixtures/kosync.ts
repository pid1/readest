import { createHash, randomBytes } from 'node:crypto';
import type { APIRequestContext, Browser, BrowserContext, Page, Request } from '@playwright/test';

/**
 * A real KOReader Sync server implementing the optional identifier matching of
 * `koreader/koreader-sync-server#55` (SPEC.md §5.8). These specs talk to it
 * over the wire; there is no stub.
 *
 * `KOSYNC_E2E_SERVER` must name it by a **public** hostname. The web build
 * proxies KOSync through `/api/kosync`, whose SSRF guard (`isLanAddress`)
 * rejects loopback and private literals by design — so a server on
 * `127.0.0.1` is addressed through a hostname that resolves there
 * (`localtest.me` and `lvh.me` both do), leaving the guard untouched and
 * running the request through the route's real endpoint allowlist.
 *
 * With no server configured the KOSync specs skip.
 */
export const KOSYNC_SERVER_URL = process.env['KOSYNC_E2E_SERVER'] ?? '';

/** The KOSync media type; the server answers 412 without it. */
const ACCEPT = 'application/vnd.koreader.v1+json';

const md5 = (value: string) => createHash('md5').update(value).digest('hex');

export interface KOSyncAccount {
  username: string;
  password: string;
  /** `x-auth-key`: the md5 of the password, as KOSync authenticates with. */
  userkey: string;
}

/**
 * Registers a throwaway account.
 *
 * One per test, because `[K-ID-12]` never repoints an alias: a second run over
 * the aliases the first left behind would resolve through them and assert
 * nothing. Aliases are namespaced per account (`[K-ID-10]`), so a fresh
 * account is a clean slate.
 */
export const createAccount = async (request: APIRequestContext): Promise<KOSyncAccount> => {
  const username = `readest-e2e-${randomBytes(6).toString('hex')}`;
  const password = randomBytes(8).toString('hex');
  const response = await request.post(`${KOSYNC_SERVER_URL}/users/create`, {
    headers: { Accept: ACCEPT, 'Content-Type': 'application/json' },
    data: { username, password: md5(password) },
  });
  if (!response.ok()) {
    throw new Error(`could not create ${username}: ${response.status()} ${await response.text()}`);
  }
  // Logged so the account's Redis keys can be inspected after a run.
  console.log(`[kosync-e2e] account=${username}`);
  return { username, password, userkey: md5(password) };
};

export interface KOSyncIdentifierWire {
  type: string;
  value: string;
}

/** Push a position as some other device would, bypassing the app entirely. */
export const pushProgressAsPeer = async (
  request: APIRequestContext,
  account: KOSyncAccount,
  body: {
    document: string;
    progress: string;
    percentage: number;
    device: string;
    identifiers?: KOSyncIdentifierWire[];
  },
): Promise<Record<string, unknown>> => {
  const response = await request.put(`${KOSYNC_SERVER_URL}/syncs/progress`, {
    headers: authHeaders(account),
    data: body,
  });
  if (!response.ok()) {
    throw new Error(`peer push failed: ${response.status()} ${await response.text()}`);
  }
  return response.json();
};

/** Read a position back from the server, naming no identifiers. */
export const readProgressAsPeer = async (
  request: APIRequestContext,
  account: KOSyncAccount,
  document: string,
): Promise<Record<string, unknown>> => {
  const response = await request.get(`${KOSYNC_SERVER_URL}/syncs/progress/${document}`, {
    headers: authHeaders(account),
  });
  return response.json();
};

const authHeaders = (account: KOSyncAccount) => ({
  Accept: ACCEPT,
  'Content-Type': 'application/json',
  'x-auth-user': account.username,
  'x-auth-key': account.userkey,
});

/** One KOSync call the app made, as the proxy route received it. */
export interface KOSyncCall {
  method: string;
  endpoint: string;
  body?: Record<string, unknown>;
  /** The server's answer, as the proxy passed it back. */
  response?: Record<string, unknown>;
}

/**
 * Records every KOSync call the app makes, read off the proxy payload — which
 * carries the client's own `endpoint` and request body verbatim, so this is
 * the request the client constructed rather than a paraphrase of it. The
 * server's answer is attached to the same entry.
 */
export class KOSyncCallLog {
  readonly calls: KOSyncCall[] = [];
  private readonly byRequest = new Map<Request, KOSyncCall>();

  constructor(page: Page) {
    page.on('request', (request) => this.record(request));
    page.on('response', async (response) => {
      const call = this.byRequest.get(response.request());
      if (!call) return;
      call.response = await response.json().catch(() => undefined);
    });
  }

  private record(request: Request) {
    if (!request.url().includes('/api/kosync')) return;
    try {
      const payload = JSON.parse(request.postData() ?? '{}');
      const call: KOSyncCall = {
        method: payload.method,
        endpoint: payload.endpoint,
        body: payload.body,
      };
      this.calls.push(call);
      this.byRequest.set(request, call);
    } catch {
      // A malformed payload is not this helper's business to report.
    }
  }

  progressPuts(): KOSyncCall[] {
    return this.calls.filter((c) => c.method === 'PUT' && c.endpoint.startsWith('/syncs/progress'));
  }

  progressGets(): KOSyncCall[] {
    return this.calls.filter((c) => c.method === 'GET' && c.endpoint.startsWith('/syncs/progress'));
  }
}

/**
 * A browser context with its own empty library, so two of them stand in for
 * two devices holding two copies of one book. Mirrors the `page` override in
 * `fixtures/base.ts`: the demo-book auto-import is suppressed.
 *
 * Also records the reader's transient hints (`HintInfo` clears its message
 * after two seconds, which is too short to poll for reliably) into
 * `window.__kosyncHints`.
 */
export const newDeviceContext = async (browser: Browser): Promise<BrowserContext> => {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    try {
      window.localStorage.setItem('demoBooksFetched', 'true');
    } catch {
      // localStorage may be unavailable in some contexts; ignore.
    }
    const hints: string[] = [];
    (window as unknown as { __kosyncHints: string[] }).__kosyncHints = hints;
    const read = () => {
      const text = document.querySelector('.hintinfo h2')?.textContent?.trim();
      if (text && hints[hints.length - 1] !== text) hints.push(text);
    };
    new MutationObserver(read).observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });
  return context;
};

/** Every hint the reader has shown in this page, in order. */
export const recordedHints = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __kosyncHints?: string[] }).__kosyncHints ?? []);
