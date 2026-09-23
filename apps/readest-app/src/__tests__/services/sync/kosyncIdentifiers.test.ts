// The `structure` digest is an interoperability contract: a label two clients
// compute differently is worse than no label at all. The vectors below are the
// ones the kosync identifier specification pins, and are reproduced by the
// KOReader (Lua) and CrossPoint (C++) implementations.
import { describe, expect, it } from 'vitest';
import { md5 } from 'js-md5';

import {
  buildIdentifiers,
  canFollowPosition,
  computeStructureDigest,
  formatIdentifiersParam,
  normalizeIdentifiers,
} from '@/services/sync/kosyncIdentifiers';
import { DocumentLoader, type BookDoc } from '@/libs/document';
import type { Book } from '@/types/book';

const CONTAINER = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

// The container loader a BookDoc exposes: a zip entry name in, its text out,
// null for a name the archive does not hold.
const epub = (files: Record<string, string>) =>
  ({ loadText: async (name: string) => files[name] ?? null }) as BookDoc;

const book = (overrides: Partial<Book> = {}): Book =>
  ({
    hash: 'a'.repeat(32),
    format: 'EPUB',
    title: 'Leaves of Grass',
    author: 'Walt Whitman',
    ...overrides,
  }) as Book;

describe('the structure digest', () => {
  // Four rules at once: `&amp;` expands, `%20` does not, `../` is kept and a
  // fragment is stripped.
  it('digests hrefs as the parser yields them, in spine order', async () => {
    const file = epub({
      'META-INF/container.xml': CONTAINER,
      'OEBPS/content.opf': `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>No identifier</dc:title></metadata>
  <manifest>
    <item id="a" href="Text/a%20b.xhtml" media-type="application/xhtml+xml"/>
    <item id="b" href="Text/c&amp;d.xhtml" media-type="application/xhtml+xml"/>
    <item id="c" href="../Text/e.xhtml#part2" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="a"/><itemref idref="b"/><itemref idref="c"/></spine>
</package>`,
    });

    const lines = 'Text/a%20b.xhtml\nText/c&d.xhtml\n../Text/e.xhtml';
    expect(new TextEncoder().encode(lines)).toHaveLength(47);
    expect(md5(lines)).toBe('e07ad0e2e24fbaa64b0c40a8b1ebb13f');
    await expect(computeStructureDigest(file)).resolves.toBe('e07ad0e2e24fbaa64b0c40a8b1ebb13f');
  });

  // The identifier line is the one `unique-identifier` names, with numeric
  // character references expanded.
  it('opens with the package identifier', async () => {
    const file = epub({
      'META-INF/container.xml': CONTAINER,
      'OEBPS/content.opf': `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="other">urn:ignored</dc:identifier>
    <dc:identifier id="pid">urn:a&amp;b&#58;1</dc:identifier>
  </metadata>
  <manifest><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest>
  <spine><itemref idref="c1"/></spine>
</package>`,
    });

    const lines = 'urn:a&b:1\nch1.xhtml';
    expect(new TextEncoder().encode(lines)).toHaveLength(19);
    expect(md5(lines)).toBe('fb3ed76af6e07f28456616a77330b19f');
    await expect(computeStructureDigest(file)).resolves.toBe('fb3ed76af6e07f28456616a77330b19f');
  });

  it('falls back to the first non-empty identifier when none is named', async () => {
    const named = epub({
      'META-INF/container.xml': CONTAINER,
      'OEBPS/content.opf': `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="missing">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier>   </dc:identifier>
    <dc:identifier>  urn:a&amp;b&#58;1  </dc:identifier>
  </metadata>
  <manifest><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest>
  <spine><itemref idref="c1"/></spine>
</package>`,
    });

    await expect(computeStructureDigest(named)).resolves.toBe('fb3ed76af6e07f28456616a77330b19f');
  });

  it('skips a spine entry that resolves to no manifest item', async () => {
    const file = epub({
      'META-INF/container.xml': CONTAINER,
      'OEBPS/content.opf': `<?xml version="1.0" encoding="UTF-8"?>
<opf:package xmlns:opf="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pid">
  <opf:metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pid">urn:a&amp;b:1</dc:identifier>
  </opf:metadata>
  <opf:manifest>
    <opf:item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <opf:item id="noHref" media-type="application/xhtml+xml"/>
  </opf:manifest>
  <opf:spine>
    <opf:itemref idref="c1"/>
    <opf:itemref idref="noHref"/>
    <opf:itemref idref="absent"/>
  </opf:spine>
</opf:package>`,
    });

    await expect(computeStructureDigest(file)).resolves.toBe('fb3ed76af6e07f28456616a77330b19f');
  });

  it('has no digest for a container that is not an OPF-bearing archive', async () => {
    await expect(computeStructureDigest(epub({}))).resolves.toBeNull();
    await expect(computeStructureDigest({} as BookDoc)).resolves.toBeNull();
  });

  // The rest of this suite hands the digest a loader directly; this one opens
  // a real archive the way the reader does.
  it('reads the container through an opened book', async () => {
    const { BlobWriter, TextReader, ZipWriter } = await import('@zip.js/zip.js');
    const writer = new ZipWriter(new BlobWriter('application/epub+zip'));
    await writer.add('mimetype', new TextReader('application/epub+zip'), { level: 0 });
    await writer.add('META-INF/container.xml', new TextReader(CONTAINER));
    await writer.add(
      'OEBPS/content.opf',
      new TextReader(`<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pid">urn:a&amp;b&#58;1</dc:identifier>
    <dc:title>One chapter</dc:title>
    <dc:language>en</dc:language>
  </metadata>
  <manifest><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest>
  <spine><itemref idref="c1"/></spine>
</package>`),
    );
    await writer.add(
      'OEBPS/ch1.xhtml',
      new TextReader(
        '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml">' +
          '<head><title>One</title></head><body><p>One chapter.</p></body></html>',
      ),
    );
    const file = new File([await writer.close()], 'one.epub', { type: 'application/epub+zip' });

    const { book } = await new DocumentLoader(file).open();
    await expect(computeStructureDigest(book)).resolves.toBe('fb3ed76af6e07f28456616a77330b19f');
  });
});

describe('the identifier list', () => {
  it('is ordered strongest first and names the document', async () => {
    const file = epub({
      'META-INF/container.xml': CONTAINER,
      'OEBPS/content.opf': `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pid">urn:a&amp;b&#58;1</dc:identifier>
  </metadata>
  <manifest><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest>
  <spine><itemref idref="c1"/></spine>
</package>`,
    });

    const identifiers = await buildIdentifiers(book({ sourceTitle: 'leaves' }), file);
    expect(identifiers).toEqual([
      { type: 'content', value: 'a'.repeat(32) },
      { type: 'structure', value: 'fb3ed76af6e07f28456616a77330b19f' },
    ]);
    expect(normalizeIdentifiers(identifiers, 'a'.repeat(32))).toEqual(identifiers);
    expect(formatIdentifiersParam(identifiers)).toBe(
      `content:${'a'.repeat(32)},structure:fb3ed76af6e07f28456616a77330b19f`,
    );
  });

  // The content digest alone repeats `document`, and a title-derived name is
  // not the `filename` type.
  it('is empty for a book whose spine cannot be read', async () => {
    expect(await buildIdentifiers(book({ hash: 'b'.repeat(32) }), null)).toEqual([]);
  });

  it('is dropped when it does not name the document, or repeats a type', () => {
    const content = { type: 'content', value: 'c'.repeat(32) } as const;
    expect(normalizeIdentifiers([content], 'd'.repeat(32))).toBeNull();
    expect(normalizeIdentifiers([], 'c'.repeat(32))).toBeNull();
    expect(
      normalizeIdentifiers([content, { type: 'content', value: 'e'.repeat(32) }], 'c'.repeat(32)),
    ).toEqual([content]);
  });
});

describe('progress_match', () => {
  it('follows a stored position only for a type that addresses the bytes', () => {
    expect(canFollowPosition(undefined)).toBe(true);
    expect(canFollowPosition('content')).toBe(true);
    expect(canFollowPosition('structure')).toBe(true);
    expect(canFollowPosition('filename')).toBe(false);
    expect(canFollowPosition('none')).toBe(false);
    expect(canFollowPosition('metadata')).toBe(false);
  });
});
