import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { readDoc } from '../../src/io/doc-import.js';

// Fixtures are LibreOffice "MS Word 97" exports of tests/fixtures/doc/src/*.html
// (see regenerate.sh); pieces-*.doc are rewritten by make-pieces.py to use a
// compressed (8-bit) + UTF-16 piece table, and 4096-byte sectors for -4k.
const fixture = (name) => readFileSync(`tests/fixtures/doc/${name}`);
const load = (name) => readDoc(fixture(name));
const parse = (html) => new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body;
/** One line per top-level or nested text block, like LibreOffice's text export. */
const lines = (html) => [...parse(html).querySelectorAll('p, h1, h2, h3, h4, h5, h6')].map((el) => el.textContent);
/** LibreOffice's UTF-8 text export, without BOM and trailing newline. */
const expectedText = (name) => fixture(name).toString('utf8').replace(/^﻿/, '').replace(/\r?\n$/, '').split(/\r?\n/);

describe('doc import: text', () => {
  it('decodes UTF-16 text, non-ASCII, CJK and emoji, line breaks and escaping', async () => {
    const { html, title } = await load('text.doc');
    expect(title).toBe('Unicode Sample');
    expect(lines(html)).toEqual([
      'Plain first paragraph.',
      'Café naïve über — “curly quotes” and ‘single’ cost 5 €.',
      'CJK 漢字かな and emoji 😀 here.',
      'Line oneLine two after break.',
      'Ampersand & less <tag> done.',
    ]);
    expect(html).toMatch(/Line one(<\/span>)?<br>/);
    expect(html).toContain('Ampersand &amp; less &lt;tag&gt; done.');
    expect(html).not.toMatch(/[\u0000-\u0008\u000b-\u001f]/);
  });

  it('reads compressed (cp1252) and UTF-16 pieces in one document', async () => {
    for (const name of ['pieces-512.doc', 'pieces-4k.doc']) {
      const { html, title } = await load(name);
      expect(title).toBe('Pieces');
      expect(lines(html)).toEqual(expectedText('pieces-512.txt'));
      expect(html).toContain('<strong>bold words</strong>');
      expect(html).toMatch(/<a href="https:\/\/example\.org\/path\?a=1&amp;b=2">(<span[^>]*>)?the example link/);
    }
  });

  it('matches LibreOffice text export for a long document (multiple FKP pages)', async () => {
    const { html, title } = await load('long.doc');
    expect(title).toBe('Long Document');
    const expected = expectedText('long.txt');
    expect(expected.join('\n').length).toBeGreaterThan(32 * 1024); // > 64 KB as UTF-16
    expect(lines(html)).toEqual(expected);
    const body = parse(html);
    expect(body.querySelectorAll('h2').length).toBe(expected.filter((l) => /^Section \d+$/.test(l)).length);
    // Every 7th paragraph starting at 3 has a bold run (except where a heading took its slot).
    expect(body.querySelectorAll('strong').length).toBe(expected.filter((l) => /^Para \d+: .* é$/.test(l)).length);
    expect(body.lastElementChild.textContent).toBe('THE END');
  });
});

describe('doc import: formatting', () => {
  it('maps headings, character formatting and alignment', async () => {
    const { html } = await load('formatting.doc');
    const body = parse(html);
    expect([...body.children].slice(0, 3).map((el) => `${el.tagName}:${el.textContent}`)).toEqual(['H1:Heading One', 'H2:Heading Two', 'H3:Heading Three']);
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('<u>underline</u>');
    expect(html).toContain('<s>strike</s>');
    expect(html).toMatch(/<span style="color: #ff0000[^"]*">red<\/span>/);
    expect(html).toMatch(/<span style="[^"]*font-size: 20pt[^"]*">big<\/span>/);
    expect(body.querySelector('span[style*="Courier New"]')?.textContent).toBe('mono');
    expect(html).toMatch(/<p style="text-align: center">(<span[^>]*>)?Centered paragraph\./);
    expect(html).toMatch(/<p style="text-align: right">(<span[^>]*>)?Right paragraph\./);
    expect(html).toMatch(/<p style="text-align: justify">/);
    // Plain text keeps no stray formatting tags.
    expect(body.querySelector('p').innerHTML).toMatch(/^(<span[^>]*>)?Normal /);
  });
});

describe('doc import: structure', () => {
  it('builds tables with merged cells from cell and row marks', async () => {
    const { html } = await load('table.doc');
    const body = parse(html);
    expect([...body.children].map((el) => el.tagName)).toEqual(['P', 'TABLE', 'P']);
    expect(body.firstElementChild.textContent).toBe('Before table.');
    expect(body.lastElementChild.textContent).toBe('After table.');
    const rows = [...body.querySelectorAll('tr')];
    expect(rows.map((tr) => [...tr.children].map((td) => td.textContent))).toEqual([
      ['A1', 'B1', 'C1 tall'],
      ['A2 wide'],
      ['A3', 'B3 bold', 'C3 line oneC3 line two'],
    ]);
    expect(rows[0].children[2].getAttribute('rowspan')).toBe('2');
    expect(rows[1].children[0].getAttribute('colspan')).toBe('2');
    expect(rows[2].children[2].querySelectorAll('p').length).toBe(2);
    expect(rows[2].children[1].innerHTML).toContain('<strong>bold</strong>');
  });

  it('builds bulleted, nested and numbered lists from the list tables', async () => {
    const { html } = await load('lists.doc');
    const body = parse(html);
    expect([...body.children].map((el) => el.tagName)).toEqual(['P', 'UL', 'P', 'OL', 'P']);
    const ul = body.querySelector('ul');
    expect([...ul.children].map((li) => li.firstElementChild.textContent)).toEqual(['Bullet one', 'Bullet two', 'Bullet three']);
    expect(ul.children[1].querySelector('ul > li').textContent).toBe('Nested bullet');
    expect([...body.querySelector('ol').children].map((li) => li.textContent)).toEqual(['Number one', 'Number two', 'Number three']);
  });

  it('keeps hyperlink field results as links and turns page breaks into page-break blocks', async () => {
    const { html } = await load('misc.doc');
    const body = parse(html);
    expect(body.querySelector('a').getAttribute('href')).toBe('https://example.com/');
    expect(body.querySelector('a').textContent).toBe('Example Site');
    expect(body.firstElementChild.textContent).toBe('Visit Example Site today.');
    expect(html).not.toContain('HYPERLINK');
    expect([...body.children].map((el) => el.tagName + (el.textContent ? `:${el.textContent}` : ''))).toEqual(
      ['P:Visit Example Site today.', 'P:Before break.', 'DIV', 'P:After break.'],
    );
    expect(body.children[2].hasAttribute('data-page-break')).toBe(true);
  });
});

describe('doc import: errors and malformed input', () => {
  /**
   * Copy of a fixture with its FIB patched. The FIB starts the WordDocument
   * stream, so it sits at a (mini) sector boundary: wIdent 0xA5EC, nFib ≥ 0xC0.
   */
  const patchFib = (name, patch) => {
    const bytes = new Uint8Array(fixture(name));
    for (let o = 512; o + 4 <= bytes.length; o += 64) {
      if (bytes[o] === 0xec && bytes[o + 1] === 0xa5 && (bytes[o + 2] | (bytes[o + 3] << 8)) >= 0xc0) {
        patch(bytes, o);
        return bytes;
      }
    }
    throw new Error('FIB not found');
  };
  const rejects = async (input, code) => {
    const err = await readDoc(input).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe(code);
    expect(err.message).toBeTruthy();
  };

  it('rejects files that are not compound files', async () => {
    await rejects(new ArrayBuffer(0), 'not-cfb');
    await rejects(new TextEncoder().encode('<html>hello</html>'.padEnd(600, ' ')), 'not-cfb');
    await rejects(new TextEncoder().encode('{\\rtf1\\ansi hello}'.padEnd(600, ' ')), 'rtf');
    await rejects(new Uint8Array([0x50, 0x4b, 3, 4, ...new Array(600).fill(0)]), 'docx');
  });

  it('rejects encrypted documents', async () => {
    await rejects(patchFib('text.doc', (b, o) => { b[o + 0x0b] |= 0x01; }), 'encrypted');
  });

  it('rejects Word 6.0/95 documents', async () => {
    await rejects(patchFib('text.doc', (b, o) => { b[o + 2] = 0x65; b[o + 3] = 0; }), 'old-format');
    await rejects(patchFib('text.doc', (b, o) => { b[o + 2] = 0x68; b[o + 3] = 0; }), 'old-format');
  });

  it('accepts an ArrayBuffer as well as a Uint8Array', async () => {
    const bytes = new Uint8Array(fixture('text.doc'));
    const { html } = await readDoc(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    expect(html).toContain('Plain first paragraph.');
  });

  it('never hangs or throws a non-Error on truncated or garbled files', async () => {
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const check = async (bytes) => {
      try {
        const { html } = await readDoc(bytes);
        expect(typeof html).toBe('string');
      } catch (e) {
        expect(e).toBeInstanceOf(Error);
        expect(e.code).toBeTruthy();
      }
    };
    const started = Date.now();
    for (const name of ['text.doc', 'table.doc', 'lists.doc', 'pieces-4k.doc']) {
      const original = new Uint8Array(fixture(name));
      // Truncations, including mid-header and mid-stream.
      for (const len of [8, 100, 511, 512, 513, 1024, 2048, 3000, 4096, 5000, original.length >> 1, original.length - 1]) {
        await check(original.slice(0, len));
      }
      // Random byte corruption, light and heavy.
      for (let round = 0; round < 40; round++) {
        const bytes = original.slice();
        const hits = round < 20 ? 4 : 400;
        for (let k = 0; k < hits; k++) bytes[Math.floor(rand() * bytes.length)] = Math.floor(rand() * 256);
        await check(bytes);
      }
      // Corrupt the FIB / table pointers specifically.
      for (let round = 0; round < 20; round++) {
        const bytes = patchFib(name, (b, o) => {
          for (let k = 0; k < 8; k++) b[o + 0x20 + Math.floor(rand() * 600)] = Math.floor(rand() * 256);
        });
        await check(bytes);
      }
    }
    expect(Date.now() - started).toBeLessThan(20000);
  });
});
