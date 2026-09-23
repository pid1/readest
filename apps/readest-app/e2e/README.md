# End-to-end tests

Readest has two end-to-end lanes. They cover different layers and are run
separately.

## Web lane — Playwright

Drives the Next.js **web** build (`pnpm dev-web`) in a real browser. Fast, no
Rust build required. Tests run unauthenticated against a fresh browser
context, so each test starts from an isolated, empty local library.

```bash
pnpm test:e2e:web          # run the web e2e suite (auto-starts pnpm dev-web)
pnpm test:e2e:web:headed   # run headed, one test at a time, with traces
pnpm test:e2e:web:ui       # run in the Playwright UI mode
pnpm test:e2e:web:report   # open the last HTML report
```

Every run writes an HTML report to `playwright-report/`; open it with
`pnpm test:e2e:web:report`.

Layout:

| Path                              | Purpose                                                |
| --------------------------------- | ------------------------------------------------------ |
| `playwright.config.ts` (app root) | Runner config, projects, web server.                   |
| `e2e/tests/`                      | Specs (`*.spec.ts`).                                   |
| `e2e/pages/`                      | Page Object Model — actions/queries, no assertions.    |
| `e2e/fixtures/`                   | Shared fixtures; `fixtures/books/` holds sample books. |

Page objects expose locators and actions; assertions stay in the specs so
failures point at test intent. To add coverage, prefer extending a page
object over inlining selectors in a spec.

The demo-book auto-import (`useDemoBooks`) is suppressed by the base fixture
so the library is deterministic; authenticated/sync flows are out of scope
for this lane until a test account is provisioned.

### KOSync identifier matching

`tests/kosync-identifiers.spec.ts` is the one spec that needs a server: a
KOReader Sync server implementing the optional identifier matching of
`koreader/koreader-sync-server#55`. It skips unless `KOSYNC_E2E_SERVER` names
one, and registers a throwaway account per test (an alias is never repointed,
so a second run over the first run's aliases would assert nothing).

```bash
KOSYNC_E2E_SERVER=http://kosync.example.test:8095 pnpm test:e2e:web
```

`KOSYNC_E2E_SERVER` must be a **public** hostname. The web build proxies KOSync
through `/api/kosync`, whose SSRF guard rejects loopback and private literals
by design, and a private literal in the setting makes `KOSyncClient` fetch the
server straight from the page instead — where it fails CORS. A server on
`127.0.0.1` is therefore addressed through a hostname that resolves there
(`localtest.me`, `lvh.me`), which leaves the guard untouched and runs the
request through the route's real endpoint allowlist.

`KOSYNC_E2E_EPUB` names a source book other than the repo's sample; the
converted copy the matching tests need is built from it at run time by
`fixtures/epubVariant.ts`.

## Tauri lane — WebdriverIO

Drives the actual **Tauri** desktop shell via `tauri-driver`. Use this for
coverage that depends on the native build (Rust integration, window
management, platform globals).

```bash
pnpm tauri:dev:test        # start the Tauri app with the webdriver feature
pnpm test:e2e              # run wdio against it (specs: e2e/*.e2e.ts)
```
