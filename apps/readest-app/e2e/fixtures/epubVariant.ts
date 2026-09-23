import { unzipSync, zipSync } from 'fflate';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';

/**
 * Builds the "converted copy" of an EPUB that the KOSync identifier feature
 * exists for: a file that shares not one byte with the original yet describes
 * the same book.
 *
 * This is what CrossPoint's EPUB optimizer does, and the three things it does
 * are the three things done here:
 *
 *  - **repacked with different compression** — every entry is re-stored, so no
 *    entry's bytes survive;
 *  - **images re-encoded** — decoded and re-encoded through a canvas in the
 *    browser, which is the optimizer's own mechanism (and the reason this
 *    helper needs a {@link Page});
 *  - **a stylesheet injected into every chapter** — a `<link>` in each spine
 *    document's `<head>`, plus the manifest `<item>` it refers to.
 *
 * What it deliberately does NOT touch is the `<spine>`: no entry is added,
 * removed, renamed or reordered, and the package identifier is left alone. So
 * the `structure` digest of the copy equals the original's while its `content`
 * digest cannot, which is exactly the case `[K-ID-4]` is about.
 */
export const buildConvertedCopy = async (
  page: Page,
  sourcePath: string,
  outPath: string,
): Promise<string> => {
  const entries = unzipSync(new Uint8Array(fs.readFileSync(sourcePath)));

  const opfPath = readOpfPath(entries);
  const cssHref = 'kosync-e2e-injected.css';
  const cssPath = path.posix.join(path.posix.dirname(opfPath), cssHref);
  const spineHrefs = readSpineHrefs(entries, opfPath);

  const out: Record<string, [Uint8Array, { level: 0 }]> = {};
  const store = (name: string, data: Uint8Array) => {
    out[name] = [data, { level: 0 }];
  };

  for (const [name, data] of Object.entries(entries)) {
    if (name.endsWith('/')) continue;
    if (/\.(png|jpe?g)$/i.test(name)) {
      store(name, await reencodeImage(page, name, data));
    } else if (name === opfPath) {
      store(name, encode(addManifestItem(decode(data), cssHref)));
    } else if (spineHrefs.has(name)) {
      store(name, encode(injectStylesheet(decode(data), relativeHref(name, cssPath))));
    } else {
      store(name, data);
    }
  }
  store(cssPath, encode('/* injected into every chapter by the optimizer */\np { widows: 2; }\n'));

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, zipSync(out, { level: 0 }));
  return outPath;
};

/** A scratch directory for built variants, removed by the caller. */
export const makeVariantDir = (): string =>
  fs.mkdtempSync(path.join(os.tmpdir(), 'readest-kosync-e2e-'));

const decode = (data: Uint8Array) => new TextDecoder().decode(data);
const encode = (text: string) => new TextEncoder().encode(text);

const readOpfPath = (entries: Record<string, Uint8Array>): string => {
  const container = decode(entries['META-INF/container.xml']!);
  const rootfiles = [...container.matchAll(/<rootfile\b[^>]*>/g)].map((m) => m[0]);
  const declared = rootfiles.find((r) => r.includes('application/oebps-package+xml'));
  const fullPath = /full-path="([^"]+)"/.exec(declared ?? rootfiles[0] ?? '')?.[1];
  if (!fullPath) throw new Error('no OPF rootfile in META-INF/container.xml');
  return fullPath;
};

/** The archive member name of every spine document, in no particular order. */
const readSpineHrefs = (entries: Record<string, Uint8Array>, opfPath: string): Set<string> => {
  const opf = decode(entries[opfPath]!);
  const hrefs = new Map<string, string>();
  for (const [, attrs] of opf.matchAll(/<item\b([^>]*)>/g)) {
    const id = /\bid="([^"]*)"/.exec(attrs!)?.[1];
    const href = /\bhref="([^"]*)"/.exec(attrs!)?.[1];
    if (id && href && !hrefs.has(id)) hrefs.set(id, href);
  }
  const dir = path.posix.dirname(opfPath);
  const members = new Set<string>();
  for (const [, attrs] of opf.matchAll(/<itemref\b([^>]*)>/g)) {
    const idref = /\bidref="([^"]*)"/.exec(attrs!)?.[1];
    const href = idref ? hrefs.get(idref) : undefined;
    if (href)
      members.add(path.posix.normalize(path.posix.join(dir, decodeURI(href.split('#')[0]!))));
  }
  return members;
};

const relativeHref = (from: string, to: string): string => {
  const rel = path.posix.relative(path.posix.dirname(from), to);
  return rel.startsWith('.') ? rel : `./${rel}`;
};

const injectStylesheet = (xhtml: string, href: string): string => {
  const link = `<link rel="stylesheet" type="text/css" href="${href}"/>`;
  return xhtml.includes('</head>') ? xhtml.replace('</head>', `${link}\n</head>`) : xhtml;
};

const addManifestItem = (opf: string, href: string): string =>
  opf.replace(
    '</manifest>',
    `  <item id="kosync-e2e-injected-css" href="${href}" media-type="text/css"/>\n</manifest>`,
  );

/**
 * Decode and re-encode one image through the browser's canvas, keeping the
 * format so the manifest's media type stays true. Every byte of the result is
 * the encoder's, which is the point.
 */
const reencodeImage = async (page: Page, name: string, data: Uint8Array): Promise<Uint8Array> => {
  const mime = /\.png$/i.test(name) ? 'image/png' : 'image/jpeg';
  const encoded = await page.evaluate(
    async ({ bytes, mime }) => {
      const blob = new Blob([new Uint8Array(bytes)], { type: mime });
      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
      const out: Blob = await new Promise((resolve) =>
        canvas.toBlob((b) => resolve(b!), mime, 0.62),
      );
      return Array.from(new Uint8Array(await out.arrayBuffer()));
    },
    { bytes: Array.from(data), mime },
  );
  return new Uint8Array(encoded);
};
