import fs from 'node:fs';
import path from 'node:path';
import type { APIRequestContext, Browser, BrowserContext, Page } from '@playwright/test';
import { expect, test } from '../fixtures/base';
import { SAMPLE_EPUB } from '../fixtures/books';
import { buildConvertedCopy, makeVariantDir } from '../fixtures/epubVariant';
import {
  KOSYNC_SERVER_URL,
  KOSyncCallLog,
  createAccount,
  newDeviceContext,
  pushProgressAsPeer,
  recordedHints,
  type KOSyncAccount,
  type KOSyncCall,
} from '../fixtures/kosync';
import { LibraryPage } from '../pages/LibraryPage';
import { ReaderPage } from '../pages/ReaderPage';
import { KOSyncSettingsPage } from '../pages/KOSyncSettingsPage';

/**
 * KOSync optional identifier matching (`koreader/koreader-sync-server#55`,
 * SPEC.md §5.8) against a real server.
 *
 * What the unit tests cannot reach, and this can: whether the digests the app
 * computes from a book it has actually opened make a converted copy resolve to
 * the original's record, and whether the reader then lands where it should.
 *
 * `KOSYNC_E2E_SERVER` names the server — see `fixtures/kosync.ts` for why it
 * has to be a public hostname. `KOSYNC_E2E_EPUB` names a source book other
 * than the repo's sample.
 */
const SOURCE_EPUB = process.env['KOSYNC_E2E_EPUB'] ?? SAMPLE_EPUB;
const HEX32 = /^[a-f0-9]{32}$/;
const ACCEPT = 'application/vnd.koreader.v1+json';

test.describe('KOSync identifier matching', () => {
  test.skip(!KOSYNC_SERVER_URL, 'set KOSYNC_E2E_SERVER to a reachable KOSync server');
  // Each test imports a book, paginates it and waits out a five-second push
  // debounce, twice over for the two-device cases.
  test.setTimeout(240_000);

  let variantDir = '';
  let convertedEpub = '';

  test.beforeAll(async ({ browser }) => {
    variantDir = makeVariantDir();
    convertedEpub = path.join(variantDir, 'converted.epub');
    const page = await browser.newPage();
    await buildConvertedCopy(page, SOURCE_EPUB, convertedEpub);
    await page.close();
  });

  test.afterAll(() => {
    if (variantDir) fs.rmSync(variantDir, { recursive: true, force: true });
  });

  test('the Match Other Copies toggle defaults off and persists', async ({ page }) => {
    const account = await createAccount(page.request);
    const settings = new KOSyncSettingsPage(page);

    await settings.goto();
    await settings.connect(KOSYNC_SERVER_URL, account.username, account.password);

    await expect(settings.matchIdentifiersToggle).toBeVisible();
    await expect(settings.matchIdentifiersToggle).not.toBeChecked();

    await settings.matchIdentifiersToggle.click();
    await expect(settings.matchIdentifiersToggle).toBeChecked();

    // Re-entering the form reads the setting back off the settings file.
    await settings.goto();
    await expect(settings.matchIdentifiersToggle).toBeChecked();
  });

  test('with the toggle off the requests carry no identifiers', async ({ browser }) => {
    const device = await openDevice(browser, {
      matchIdentifiers: false,
      strategy: 'prompt',
    });
    await readABit(device);
    const put = await waitForProgressPut(device);
    const get = device.log.progressGets()[0]!;

    expect(get.endpoint).toBe(`/syncs/progress/${put.body!['document']}`);
    expect(get.endpoint).not.toContain('?');
    // Exactly the body pre-feature Readest sends, and no `identifiers` key.
    expect(Object.keys(put.body!).sort()).toEqual([
      'device',
      'device_id',
      'document',
      'percentage',
      'progress',
    ]);
    // [K-ID-1]: a request naming no identifiers gets exactly today's answer.
    expect(put.response).toEqual({
      document: put.body!['document'],
      timestamp: expect.any(Number),
    });
    await device.context.close();
  });

  test('with the toggle on a push offers content and structure, strongest first', async ({
    browser,
  }) => {
    const device = await openDevice(browser, {
      matchIdentifiers: true,
      strategy: 'prompt',
    });
    await readABit(device);
    const put = await waitForProgressPut(device);

    const document = put.body!['document'] as string;
    const identifiers = put.body!['identifiers'] as {
      type: string;
      value: string;
    }[];
    expect(identifiers).toHaveLength(2);
    // [K-ID-5b]: strongest first.
    expect(identifiers[0]).toEqual({ type: 'content', value: document });
    expect(identifiers[1]!.type).toBe('structure');
    expect(identifiers[1]!.value).toMatch(HEX32);
    // [K-ID-15]: Readest cannot reconstruct the name the file was imported
    // under, so it offers no `filename` rather than an approximation of one.
    expect(identifiers.map((i) => i.type)).not.toContain('filename');
    // [K-ID-8]: the list names `document`.
    expect(identifiers.some((i) => i.value === document)).toBe(true);
    // [K-ID-3]: on a create, `match` is the first entry's type.
    expect(put.response).toMatchObject({ document, match: 'content' });

    // The structure digest reached the server as an alias: a read addressed to
    // it resolves to the record the app created.
    const structure = identifiers[1]!.value;
    const viaAlias = await readAsPeer(device.page.request, device.account, structure, [
      `structure:${structure}`,
    ]);
    expect(viaAlias).toMatchObject({ document, match: 'structure' });

    // The read the app makes carries the same list, in the same order.
    const get = device.log.progressGets()[0]!;
    expect(get.endpoint).toBe(
      `/syncs/progress/${document}?ids=content:${document},structure:${structure}`,
    );
    await device.context.close();
  });

  test('a converted copy resolves to the original record and lands in place', async ({
    browser,
  }) => {
    const original = await openDevice(browser, {
      matchIdentifiers: true,
      strategy: 'send',
    });
    const target = Math.round((await totalPages(original.reader)) / 2);
    await original.reader.goToPage(target);
    const put = await waitForProgressPut(original);
    const documentA = put.body!['document'] as string;
    const structure = (put.body!['identifiers'] as { value: string }[])[1]!.value;
    const sectionA = await spineIndex(original.page);
    const fractionA =
      (await original.reader.readingProgress()) / (await totalPages(original.reader));
    await original.context.close();

    // The same book, repacked with different compression, its images
    // re-encoded and a stylesheet injected into every chapter.
    const copy = await openDevice(browser, {
      account: original.account,
      matchIdentifiers: true,
      strategy: 'receive',
      epub: convertedEpub,
    });
    const get = await waitForProgressGet(copy);
    const documentB = get.endpoint.slice('/syncs/progress/'.length).split('?')[0]!;

    expect(documentB, 'the copy is a different file').not.toBe(documentA);
    expect(get.endpoint).toBe(
      `/syncs/progress/${documentB}?ids=content:${documentB},structure:${structure}`,
    );
    // [K-ID-4] / [K-ID-6]: found by the spine, and the position was written by
    // something that shares it.
    expect(get.response).toMatchObject({
      document: documentA,
      match: 'structure',
      progress_match: 'structure',
      progress: put.body!['progress'],
    });

    await expect.poll(() => recordedHints(copy.page)).toContain('Reading Progress Synced');
    expect(await recordedHints(copy.page)).not.toContain('Reading Progress Synced (Approximate)');

    // Landed on the same spine entry — the XPointer was applied as a position,
    // which is the whole point of a match that addresses the document's bytes.
    // The page NUMBER is not the assertion: an injected stylesheet repaginates
    // the copy, so its pages are its own.
    expect(await spineIndex(copy.page)).toBe(sectionA);
    const fractionB = (await copy.reader.readingProgress()) / (await totalPages(copy.reader));
    expect(Math.abs(fractionB - fractionA)).toBeLessThan(0.02);
    await copy.context.close();
  });

  test('a position written by a copy sharing nothing syncs by percentage', async ({
    browser,
    request,
  }) => {
    const original = await openDevice(browser, {
      matchIdentifiers: true,
      strategy: 'send',
    });
    await readABit(original);
    const put = await waitForProgressPut(original);
    const documentA = put.body!['document'] as string;
    const structure = (put.body!['identifiers'] as { value: string }[])[1]!.value;
    const account = original.account;
    await original.context.close();

    // A KOReader peer holding this same file registers the file-name digest
    // Readest declines to compute, as an alias of the same record.
    const filename = 'f'.repeat(32);
    await pushProgressAsPeer(request, account, {
      document: documentA,
      progress: '/body/DocFragment[3]/body/p[1]',
      percentage: 0.2,
      device: 'kpw',
      identifiers: [
        { type: 'content', value: documentA },
        { type: 'structure', value: structure },
        { type: 'filename', value: filename },
      ],
    });

    // A different book the library happens to have named alike takes the
    // record over on that weakest identifier ([K-ID-6], [K-ID-12b]).
    const otherDocument = 'a1'.repeat(16);
    const takeover = await pushProgressAsPeer(request, account, {
      document: otherDocument,
      // An early chapter: following this XPointer would land near the start.
      progress: '/body/DocFragment[2]/body/p[1]',
      percentage: 0.75,
      device: 'pb',
      identifiers: [
        { type: 'content', value: otherDocument },
        { type: 'structure', value: 'b'.repeat(32) },
        { type: 'filename', value: filename },
      ],
    });
    expect(takeover).toMatchObject({ document: documentA, match: 'filename' });

    const again = await openDevice(browser, {
      account,
      matchIdentifiers: true,
      strategy: 'receive',
    });
    const get = await waitForProgressGet(again);
    // Found by its own content digest; the position, though, was written by a
    // file this copy shares no identifier with at all.
    expect(get.response).toMatchObject({
      document: documentA,
      match: 'content',
      progress_match: 'none',
    });

    await expect
      .poll(() => recordedHints(again.page))
      .toContain('Reading Progress Synced (Approximate)');
    // Seeked by percentage: the XPointer names an early chapter, 0.75 does not.
    const landed = (await again.reader.readingProgress()) / (await totalPages(again.reader));
    expect(landed).toBeGreaterThan(0.6);
    await again.context.close();
  });

  test('the proxy admits an identifier read and still rejects the malformed ones', async ({
    request,
  }) => {
    const hash = '0123456789abcdef0123456789abcdef';
    const admitted = await request.post('/api/kosync', {
      data: {
        serverUrl: KOSYNC_SERVER_URL,
        endpoint: `/syncs/progress/${hash}?ids=content:${hash},structure:${'b'.repeat(32)}`,
        method: 'GET',
        headers: { Accept: ACCEPT },
      },
    });
    // Admitted by the allowlist and answered by the server rather than refused
    // at the route: the account does not exist, so the server says so itself.
    expect(admitted.status()).not.toBe(400);

    for (const endpoint of [
      `/syncs/progress/${hash}?admin=true`,
      `/syncs/progress/${hash}?ids=content:abc&next=admin`,
      `/syncs/progress/${hash}?ids=content:abc#frag`,
      `/syncs/progress/${hash}?ids=../users/auth`,
      `/syncs/progress/${hash}?ids=content:abc/extra`,
      `/syncs/progress/${hash}?ids=`,
      `/syncs/progress/${hash}?ids=content:abc,`,
      `/syncs/progress/${hash}?ids=Content:abc`,
      `/syncs/progress/${hash}?ids=content:${'a'.repeat(129)}`,
      '/syncs/progress?ids=content:abc',
      '/unrelated/users/auth/extra',
    ]) {
      const rejected = await request.post('/api/kosync', {
        data: {
          serverUrl: KOSYNC_SERVER_URL,
          endpoint,
          method: 'GET',
          headers: {},
        },
      });
      expect(rejected.status(), endpoint).toBe(400);
      expect(await rejected.json()).toEqual({ error: 'Invalid endpoint' });
    }
  });
});

// --- helpers ---

interface Device {
  account: KOSyncAccount;
  context: BrowserContext;
  page: Page;
  log: KOSyncCallLog;
  reader: ReaderPage;
}

/**
 * A browser context standing in for one device: its own empty library, its own
 * KOSync settings, one imported book, opened.
 */
const openDevice = async (
  browser: Browser,
  options: {
    matchIdentifiers: boolean;
    strategy: 'prompt' | 'silent' | 'send' | 'receive';
    account?: KOSyncAccount;
    epub?: string;
  },
): Promise<Device> => {
  const context = await newDeviceContext(browser);
  const page = await context.newPage();
  const account = options.account ?? (await createAccount(page.request));
  const log = new KOSyncCallLog(page);

  const settings = new KOSyncSettingsPage(page);
  await settings.goto();
  await settings.connect(KOSYNC_SERVER_URL, account.username, account.password);
  await settings.setStrategy(options.strategy);
  await settings.setMatchIdentifiers(options.matchIdentifiers);
  await settings.close();

  const library = new LibraryPage(page);
  await library.goto();
  await library.importBook(options.epub ?? SOURCE_EPUB);
  await expect(library.bookCards()).toHaveCount(1);
  await library.openFirstBook();

  const reader = new ReaderPage(page);
  await reader.waitForReady();
  return { account, context, page, log, reader };
};

/** Move the position, which is what schedules a push. */
const readABit = async (device: Device): Promise<void> => {
  for (let i = 0; i < 3; i += 1) {
    await device.reader.nextPage();
    await device.page.waitForTimeout(300);
  }
};

/**
 * The spine index the reader is currently showing. Two copies of one book
 * paginate differently once a stylesheet is injected, but a position applied
 * from an XPointer lands on the same spine entry in both — `DocFragment[N]`
 * counts exactly the entries the `structure` digest is taken over.
 */
const spineIndex = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const view = document.querySelector('foliate-view') as
      | (HTMLElement & {
          renderer?: { primaryIndex?: number };
        })
      | null;
    return view?.renderer?.primaryIndex ?? -1;
  });

const totalPages = async (reader: ReaderPage): Promise<number> =>
  Number((await reader.pageJumpInput.inputValue()).split('/')[1]);

/** The first progress write, once the server has answered it. */
const waitForProgressPut = async (device: Device): Promise<KOSyncCall> => {
  await expect
    .poll(() => device.log.progressPuts()[0]?.response !== undefined, {
      timeout: 60_000,
    })
    .toBe(true);
  return device.log.progressPuts()[0]!;
};

/** The first progress read, once the server has answered it. */
const waitForProgressGet = async (device: Device): Promise<KOSyncCall> => {
  await expect
    .poll(() => device.log.progressGets()[0]?.response !== undefined, {
      timeout: 60_000,
    })
    .toBe(true);
  return device.log.progressGets()[0]!;
};

/** A read made straight at the server, as another device would make it. */
const readAsPeer = async (
  request: APIRequestContext,
  account: KOSyncAccount,
  document: string,
  ids: string[],
): Promise<Record<string, unknown>> => {
  const response = await request.get(
    `${KOSYNC_SERVER_URL}/syncs/progress/${document}?ids=${ids.join(',')}`,
    {
      headers: {
        Accept: ACCEPT,
        'x-auth-user': account.username,
        'x-auth-key': account.userkey,
      },
    },
  );
  return response.json();
};
