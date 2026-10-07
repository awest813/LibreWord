import { describe, it, expect } from 'vitest';
import { getSchema } from '@tiptap/core';
import { DOMParser as PMDOMParser } from '@tiptap/pm/model';
import { buildExtensions } from '../../src/editor/create-editor.js';
import { jsonToMarkdown } from '../../src/io/markdown.js';
import { docxBuffer } from '../../src/io/docx.js';
import { readDocx } from '../../src/io/docx-import.js';
import { markdownToHtml, textToHtml, preserveSpaces, sanitizeHtml, decodeText, canOpen } from '../../src/io/import.js';
import { cleanWordHtml } from '../../src/io/paste.js';
import { DEFAULT_SETTINGS } from '../../src/storage/db.js';

const schema = getSchema(buildExtensions());
const p = (...content) => ({ type: 'paragraph', content });
const t = (text, marks) => ({ type: 'text', text, ...(marks ? { marks } : {}) });
const doc = (...content) => ({ type: 'doc', content });

/** Parse HTML the way the editor loads an imported document. */
const load = (html) => {
  const el = document.createElement('div');
  el.innerHTML = sanitizeHtml(html);
  return PMDOMParser.fromSchema(schema).parse(el).toJSON();
};
const texts = (json) => json.content.map((b) => (b.content || []).map((c) => c.text || '').join(''));
const viaMarkdown = async (json) => load(await markdownToHtml(jsonToMarkdown(json)));
// As importFile does for .docx.
const viaDocx = async (json) => load(preserveSpaces((await readDocx(await docxBuffer(json, DEFAULT_SETTINGS, {}))).html));

describe('whitespace survives import', () => {
  it('keeps tabs, double spaces and indentation from .docx', async () => {
    const out = await viaDocx(doc(p(t('Name:\tValue')), p(t('two  spaces')), p(t('    indented'))));
    expect(texts(out)).toEqual(['Name:\tValue', 'two  spaces', '    indented']);
  });

  it('keeps indentation from .txt', () => {
    expect(texts(load(preserveSpaces(textToHtml('    return 1\n\tx\nplain'))))).toEqual(['    return 1', '\tx', 'plain']);
  });

  it('leaves ordinary HTML alone', () => {
    expect(preserveSpaces('<p>a b</p>')).toBe('<p>a b</p>');
  });
});

describe('.docx export', () => {
  it('drops characters XML cannot hold instead of writing a corrupt file', async () => {
    const out = await viaDocx(doc(p(t('a\u000Bb\u0001c'))));
    expect(texts(out)).toEqual(['a bc']);
  });

  it('fails loudly on a damaged document part', async () => {
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    zip.file('word/document.xml', '<w:document xmlns:w="x"><w:body>\u0001</w:body></w:document>');
    await expect(readDocx(await zip.generateAsync({ type: 'uint8array' }))).rejects.toThrow(/damaged/);
  });

  it('keeps a nested bullet list after a nested numbered list separate', async () => {
    const li = (...c) => ({ type: 'listItem', content: c });
    const json = doc({
      type: 'bulletList',
      content: [li(p(t('top')),
        { type: 'orderedList', attrs: { start: 1 }, content: [li(p(t('a1'))), li(p(t('a2')))] },
        { type: 'bulletList', content: [li(p(t('b1')))] })],
    });
    const item = (await viaDocx(json)).content[0].content[0];
    expect(item.content.map((n) => n.type)).toEqual(['paragraph', 'orderedList', 'bulletList']);
  });
});

describe('decoding text files', () => {
  const bytes = (...b) => new Uint8Array(b.flat()).buffer;
  it('reads byte-order marks, BOM-less UTF-16, UTF-8 and Windows-1252', () => {
    const le = [...new TextEncoder().encode('ab')].flatMap((c) => [c, 0]);
    expect(decodeText(bytes([0xef, 0xbb, 0xbf], [...new TextEncoder().encode('Grüße')]))).toBe('Grüße');
    expect(decodeText(bytes([0xff, 0xfe], [0x41, 0, 0xfc, 0]))).toBe('Aü');
    expect(decodeText(bytes([0xfe, 0xff], [0, 0x41, 0, 0xfc]))).toBe('Aü');
    expect(decodeText(bytes(Array(20).fill(le).flat()))).toBe('ab'.repeat(20));
    expect(decodeText(bytes([...new TextEncoder().encode('東京 €')]))).toBe('東京 €');
    expect(decodeText(bytes([0x43, 0x61, 0x66, 0xe9, 0x20, 0x80]))).toBe('Café €');
  });

  it('honours a declared charset in HTML', () => {
    const html = [...new TextEncoder().encode('<meta charset="iso-8859-1"><p>')].concat([0xe9]);
    expect(decodeText(bytes(html), { html: true })).toMatch(/<p>é$/);
  });

  it('knows which files it can open', () => {
    for (const n of ['a.docx', 'a.DOC', 'b.odt', 'c.fodt', 'd.rtf', 'e.txt', 'f.md', 'g.html', 'h.dotx', 'i.ott']) expect(canOpen(n)).toBe(true);
    for (const n of ['a.pdf', 'b.xlsx', 'c', 'Q3 vs. Q4']) expect(canOpen(n)).toBe(false);
  });
});

describe('table header rows', () => {
  it('marks every leading header row to repeat on each page in Word', async () => {
    const JSZip = (await import('jszip')).default;
    const row = (type, text) => ({ type: 'tableRow', content: [{ type, content: [p(t(text))] }] });
    const json = doc({ type: 'table', content: [row('tableHeader', 'H1'), row('tableHeader', 'H2'), row('tableCell', 'body'), row('tableHeader', 'not a header')] });
    const xml = await (await JSZip.loadAsync(await docxBuffer(json, DEFAULT_SETTINGS, {}))).file('word/document.xml').async('string');
    expect((xml.match(/<w:tblHeader\/>|<w:tblHeader w:val="(true|1|on)"\/>/g) || []).length).toBe(2);
  });
});

describe('Markdown round trip', () => {
  it('keeps text that looks like list markers, rules or setext underlines as text', async () => {
    const lines = ['3. Results', '1990. A great year', '1) first', '-', '---', '+ plus'];
    const out = await viaMarkdown(doc(...lines.map((l) => p(t(l)))));
    expect(out.content.map((b) => b.type)).toEqual(lines.map(() => 'paragraph'));
    expect(texts(out)).toEqual(lines);
  });

  it('keeps highlights and page breaks', async () => {
    const out = await viaMarkdown(doc(p(t('hi', [{ type: 'highlight' }])), { type: 'pageBreak' }, p(t('after'))));
    expect(out.content[0].content[0].marks?.[0]?.type).toBe('highlight');
    expect(out.content.map((b) => b.type)).toEqual(['paragraph', 'pageBreak', 'paragraph']);
  });

  it('keeps table cells whole: pipes in code, lists and line breaks', async () => {
    const cell = (...c) => ({ type: 'tableCell', content: c });
    const json = doc({
      type: 'table',
      content: [
        { type: 'tableRow', content: [cell(p(t('A'))), cell(p(t('B'))), cell(p(t('C')))] },
        { type: 'tableRow', content: [
          cell(p(t('a|b', [{ type: 'code' }]))),
          cell({ type: 'bulletList', content: [{ type: 'listItem', content: [p(t('item1'))] }] }),
          cell(p(t('x'), { type: 'hardBreak' }, t('y'))),
        ] },
      ],
    });
    const row = (await viaMarkdown(json)).content[0].content[1].content;
    expect(row).toHaveLength(3);
    expect(JSON.stringify(row[0])).toContain('a|b');
    expect(JSON.stringify(row[1])).toContain('item1');
    expect(JSON.stringify(row[2])).toContain('hardBreak');
  });

  it('keeps links and images with spaces or brackets in their address', async () => {
    const out = await viaMarkdown(doc(p(
      t('l', [{ type: 'link', attrs: { href: 'https://e.com/a b(c)' } }]),
      { type: 'image', attrs: { src: 'https://e.com/x y.png', alt: 'a]b' } },
    )));
    const [link, img] = out.content[0].content;
    expect(link.marks[0].attrs.href).toBe('https://e.com/a%20b(c)');
    expect(img.attrs.alt).toBe('a]b');
  });

  it('keeps a numbered list starting at 0', () => {
    const md = jsonToMarkdown(doc({ type: 'orderedList', attrs: { start: 0 }, content: [{ type: 'listItem', content: [p(t('zero'))] }] }));
    expect(md.trim()).toBe('0. zero');
  });
});

describe('pasting from Word', () => {
  it('keeps a bulleted list and a following numbered list apart', () => {
    const para = (marker, text, lfo) => `<p class=MsoListParagraph style='mso-list:l${lfo} level1 lfo${lfo}'><span style='mso-list:Ignore'>${marker}<span>&nbsp;&nbsp;</span></span>${text}</p>`;
    const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office"><body>${para('·', 'a', 1)}${para('·', 'b', 1)}${para('1.', 'one', 2)}${para('2.', 'two', 2)}</body></html>`;
    const out = cleanWordHtml(html);
    expect(out).toMatch(/^<ul><li><p[^>]*>a<\/p><\/li><li><p[^>]*>b<\/p><\/li><\/ul><ol><li><p[^>]*>one<\/p><\/li><li><p[^>]*>two<\/p><\/li><\/ol>$/);
  });
});
