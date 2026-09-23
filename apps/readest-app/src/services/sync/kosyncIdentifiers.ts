import { md5 } from 'js-md5';
import { Book } from '@/types/book';
// Type-only, so this stays off the document lib's foliate-js dependency chain.
import type { BookDoc } from '@/libs/document';
import { makeSafeFilename } from '@/utils/misc';

/**
 * One entry of the optional identifier list both KOSync progress endpoints
 * accept (koreader/koreader-sync-server#55). The server treats `type` as an
 * opaque label, so the four below are a client-side agreement: `content` is
 * the partial MD5 the protocol already addresses documents by, `structure` is
 * a digest over the EPUB spine, `metadata` one over the title and the authors,
 * `filename` one over the file name.
 *
 * `weak` marks a label that can name a different work ([K-ID-16]). It belongs
 * to the PUT body alone: a write resolving only through a weak entry writes
 * under `document` instead of adopting the record it reached ([K-ID-17]), and
 * a read adopts nothing, so the `ids` grammar has no equivalent.
 */
export interface KOSyncIdentifier {
  type: KOSyncIdentifierType;
  value: string;
  weak?: boolean;
}

export type KOSyncIdentifierType = 'content' | 'structure' | 'metadata' | 'filename';

/** Most specific to the file in hand first, as the wire order must be. */
const IDENTIFIER_STRENGTH: KOSyncIdentifierType[] = [
  'content',
  'structure',
  'metadata',
  'filename',
];

/**
 * Labels that can match a different work, which the PUT body says so the
 * server does not let one claim an existing record. `metadata` names a work
 * rather than a file, and two books a library tagged alike carry the same one.
 */
const WEAK_TYPES = new Set<KOSyncIdentifierType>(['metadata']);

/**
 * Identifier types that address the bytes a position was written against, so a
 * stored `progress` string still names the same node. `metadata`, `filename`
 * and anything a future client invents do not: a shared work or name says
 * nothing about the document, and following an XPointer on that basis lands in
 * an arbitrary place. A server without the feature reports no match at all,
 * which stays on the pre-feature path.
 */
const POSITIONAL_MATCH_TYPES = new Set<string>(['content', 'structure']);

/** The identifiers an EPUB's package document yields, `null` where it yields none. */
export interface KOSyncOpfDigests {
  structure: string | null;
  metadata: string | null;
}

const NO_DIGESTS: KOSyncOpfDigests = { structure: null, metadata: null };

/** Server-side limits; a list that breaks one is answered 403. */
const MAX_IDENTIFIERS = 8;
const TYPE_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** The XML whitespace set, which is narrower than `String.prototype.trim`. */
const trimXml = (value: string) => value.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');

/** Case folded, runs of whitespace collapsed, trimmed, as the recipe reads. */
const normalizeMetadataText = (value: string) =>
  trimXml(value.toLowerCase().replace(/[ \t\r\n]+/g, ' '));

/**
 * Whether a stored position may be followed given the type the server matched
 * the writer on. `undefined` is a server that does not implement identifier
 * matching.
 */
export const canFollowPosition = (progressMatch?: string): boolean =>
  progressMatch === undefined || POSITIONAL_MATCH_TYPES.has(progressMatch);

/**
 * The file name a progress record is keyed by. Readest stores books under
 * their hash and `sourceTitle` holds the OPF title, so this is a name derived
 * from the metadata rather than the one the book was imported under — a
 * library row does not keep that (see `bookService`). The extension is the
 * lowercased format, the same value as EXTS in libs/document, not imported
 * here so the sync client stays off the document lib's foliate-js dependency
 * chain.
 */
export const getKOSyncFilename = (book: Book): string =>
  `${makeSafeFilename(book.sourceTitle || book.title)}.${book.format.toLowerCase()}`;

/**
 * md5 of the file's own name, which is what a KOReader peer digests for the
 * `filename` type. Always absent here: the only name Readest can reconstruct
 * comes from the book's title, and a digest over title-derived text matches
 * two different files that a library happens to have titled alike. Offering
 * that under this label would merge their records, permanently — the server
 * never repoints an alias and no endpoint unlinks one. Returns a digest once
 * a library row keeps the name its file was imported under.
 */
const getFilenameDigest = (_book: Book): string | null => null;

/**
 * The list as the wire accepts it, or `null` when it cannot be sent. The
 * server requires an entry equal to `document`, at most eight entries, no
 * repeated type and values matching its own pattern, and answers 403 to
 * anything else — so a list that fails here is dropped and the plain request
 * made instead.
 */
export const normalizeIdentifiers = (
  identifiers: KOSyncIdentifier[],
  document: string,
): KOSyncIdentifier[] | null => {
  const seen = new Set<string>();
  const valid = identifiers.filter(({ type, value }) => {
    if (seen.has(type) || !TYPE_PATTERN.test(type) || !VALUE_PATTERN.test(value)) return false;
    seen.add(type);
    return true;
  });
  if (valid.length === 0 || valid.length > MAX_IDENTIFIERS) return null;
  if (!valid.some(({ value }) => value === document)) return null;
  return valid;
};

/**
 * The `ids` query parameter: `type:value,type:value`, in list order. A read
 * adopts nothing, so `weak` has no place in the grammar and is dropped here.
 */
export const formatIdentifiersParam = (identifiers: KOSyncIdentifier[]): string =>
  identifiers.map(({ type, value }) => `${type}:${value}`).join(',');

const parseXml = (text: string): Document | null => {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  return doc.getElementsByTagNameNS('*', 'parsererror').length > 0 ? null : doc;
};

// Element names are matched on the local name, so a prefixed `<opf:spine>` and
// a default-namespaced `<spine>` are the same element. Attribute names are
// matched literally and unprefixed, which is how the package format writes
// them.
const childrenNamed = (root: Element, name: string) =>
  Array.from(root.getElementsByTagNameNS('*', name));

const firstNamed = (root: Element, name: string): Element | undefined =>
  childrenNamed(root, name)[0];

const getOpfPath = (container: Document): string | null => {
  const root = container.documentElement;
  if (!root) return null;
  const rootfiles = childrenNamed(root, 'rootfile');
  const declared = rootfiles.find(
    (rootfile) => rootfile.getAttribute('media-type') === 'application/oebps-package+xml',
  );
  return (declared ?? rootfiles[0])?.getAttribute('full-path') || null;
};

/**
 * The lines the `structure` digest is taken over: the package identifier, then
 * one manifest href per spine entry in document order. Every value is the one
 * the parser yields, with entity references expanded and percent-encoding left
 * alone, and hrefs are neither resolved against the OPF directory nor reduced
 * to a basename — the list is what an XPointer's `DocFragment[N]` counts.
 */
const getStructureLines = (opf: Document): string[] | null => {
  const pkg = opf.documentElement;
  if (!pkg) return null;
  const manifest = firstNamed(pkg, 'manifest');
  const spine = firstNamed(pkg, 'spine');
  if (!manifest || !spine) return null;

  const lines: string[] = [];
  const metadata = firstNamed(pkg, 'metadata');
  if (metadata) {
    const identifiers = childrenNamed(metadata, 'identifier');
    const uniqueId = pkg.getAttribute('unique-identifier');
    const named = uniqueId
      ? identifiers.find((identifier) => identifier.getAttribute('id') === uniqueId)
      : undefined;
    const identifier =
      trimXml(named?.textContent ?? '') ||
      identifiers.map((element) => trimXml(element.textContent ?? '')).find(Boolean);
    if (identifier) lines.push(identifier);
  }

  const hrefs = new Map<string, string>();
  for (const item of childrenNamed(manifest, 'item')) {
    const id = item.getAttribute('id');
    const href = item.getAttribute('href');
    if (id !== null && href !== null && !hrefs.has(id)) hrefs.set(id, href);
  }

  let spineEntries = 0;
  for (const itemref of childrenNamed(spine, 'itemref')) {
    const idref = itemref.getAttribute('idref');
    const href = idref === null ? undefined : hrefs.get(idref);
    if (href === undefined) continue;
    lines.push(href.split('#')[0]!);
    spineEntries += 1;
  }
  return spineEntries > 0 ? lines : null;
};

/**
 * The line the `metadata` digest is taken over: the first `dc:title`, then the
 * `dc:creator`s sorted, each lowercased with runs of whitespace collapsed and
 * trimmed. A title with no author names a shelf of editions and reprints
 * rather than a work, so it yields nothing.
 */
const getMetadataLine = (opf: Document): string | null => {
  const pkg = opf.documentElement;
  if (!pkg) return null;
  const metadata = firstNamed(pkg, 'metadata');
  if (!metadata) return null;

  const title = normalizeMetadataText(childrenNamed(metadata, 'title')[0]?.textContent ?? '');
  if (!title) return null;

  const authors = childrenNamed(metadata, 'creator')
    .map((creator) => normalizeMetadataText(creator.textContent ?? ''))
    .filter(Boolean)
    .sort();
  if (authors.length === 0) return null;

  return `title:${title}\nauthors:${authors.join(';')}`;
};

/**
 * The two digests an EPUB's package document yields, each `null` when the
 * recipe reaches nothing, so the identifier is omitted rather than guessed.
 *
 * `structure` is md5 over the spine, which survives a recompression that
 * rewrites every entry's bytes and changes when the edition or the chapter
 * list does. `metadata` is md5 over the title and the authors, which survives
 * the spine changing and so is the one a conversion that re-chunked it keeps.
 *
 * Reads the two entries through the book's own container loader, which on the
 * desktop and mobile apps already holds them from the Rust EPUB prefetch.
 */
export const computeOpfDigests = async (bookDoc: BookDoc): Promise<KOSyncOpfDigests> => {
  const { loadText } = bookDoc;
  if (!loadText) return NO_DIGESTS;
  try {
    const containerText = await loadText('META-INF/container.xml');
    if (!containerText) return NO_DIGESTS;
    const container = parseXml(containerText);
    if (!container) return NO_DIGESTS;
    const opfPath = getOpfPath(container);
    if (!opfPath) return NO_DIGESTS;

    const opfText = await loadText(opfPath);
    if (!opfText) return NO_DIGESTS;
    const opf = parseXml(opfText);
    if (!opf) return NO_DIGESTS;

    const lines = getStructureLines(opf);
    const metadataLine = getMetadataLine(opf);
    return {
      structure: lines ? md5(lines.join('\n')) : null,
      metadata: metadataLine ? md5(metadataLine) : null,
    };
  } catch (error) {
    console.error('KOSync: failed to read the EPUB package document', error);
    return NO_DIGESTS;
  }
};

// Every push and pull asks for the same answer for as long as the book is
// open, and each one costs two inflates.
const opfDigests = new Map<string, Promise<KOSyncOpfDigests>>();

const getOpfDigests = (book: Book, bookDoc: BookDoc): Promise<KOSyncOpfDigests> => {
  const cached = opfDigests.get(book.hash);
  if (cached) return cached;
  const digests = computeOpfDigests(bookDoc);
  opfDigests.set(book.hash, digests);
  return digests;
};

/**
 * The identifiers this device can offer for a book, strongest first, or an
 * empty list when it has nothing to add to the digest the record is already
 * addressed by. `content` is that digest, so a non-empty list always names
 * `document`; `structure` and `metadata` are present for EPUBs whose package
 * document could be read.
 */
export const buildIdentifiers = async (
  book: Book,
  bookDoc: BookDoc | null,
): Promise<KOSyncIdentifier[]> => {
  const digests = bookDoc ? await getOpfDigests(book, bookDoc) : NO_DIGESTS;
  const values: Partial<Record<KOSyncIdentifierType, string | null>> = {
    content: book.hash,
    structure: digests.structure,
    metadata: digests.metadata,
    filename: getFilenameDigest(book),
  };
  const identifiers = IDENTIFIER_STRENGTH.flatMap((type) => {
    const value = values[type];
    if (!value) return [];
    return [WEAK_TYPES.has(type) ? { type, value, weak: true } : { type, value }];
  });
  // A list naming nothing but the content digest says no more than `document`
  // already does, so there is nothing to offer.
  return identifiers.length > 1 ? identifiers : [];
};
