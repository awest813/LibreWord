import { describe, it, expect } from 'vitest';
import mammoth from 'mammoth';
import { getSchema } from '@tiptap/core';
import { Node as PMNode } from '@tiptap/pm/model';
import { buildExtensions } from '../../src/editor/create-editor.js';
import { jsonToMarkdown } from '../../src/io/markdown.js';
import { docxBuffer, cssColorToHex, fontSizeToHalfPoints } from '../../src/io/docx.js';
import { rtfToText, textToHtml, sanitizeHtml, markdownToHtml } from '../../src/io/import.js';
import { cssLengthToPx, parseLineHeight } from '../../src/editor/paragraph-format.js';
import { buildRegExp, findMatches } from '../../src/editor/search.js';
import { DEFAULT_SETTINGS } from '../../src/storage/db.js';

const schema = getSchema(buildExtensions());
const p = (...content) => ({ type: 'paragraph', content });
const t = (text, marks) => ({ type: 'text', text, ...(marks ? { marks } : {}) });

const sampleDoc = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [t('Title')] },
    p(t('Plain '), t('bold', [{ type: 'bold' }]), t(' and '), t('italic', [{ type: 'italic' }]), t(' and '), t('link', [{ type: 'link', attrs: { href: 'https://example.com' } }])),
    { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('one'))] }, { type: 'listItem', content: [p(t('two'))] }] },
    { type: 'orderedList', attrs: { start: 1 }, content: [{ type: 'listItem', content: [p(t('first'))] }] },
    { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [p(t('done'))] }] },
    {
      type: 'table',
      content: [
        { type: 'tableRow', content: [{ type: 'tableHeader', content: [p(t('H1'))] }, { type: 'tableHeader', content: [p(t('H2'))] }] },
        { type: 'tableRow', content: [{ type: 'tableCell', content: [p(t('a'))] }, { type: 'tableCell', content: [p(t('b|c'))] }] },
      ],
    },
    { type: 'pageBreak' },
    { type: 'codeBlock', attrs: { language: 'js' }, content: [t('let x = 1;\nx++;')] },
    { type: 'blockquote', content: [p(t('quoted'))] },
  ],
};

describe('schema', () => {
  it('accepts the sample document', () => {
    expect(() => PMNode.fromJSON(schema, sampleDoc).check()).not.toThrow();
  });
});

describe('markdown export', () => {
  const md = jsonToMarkdown(sampleDoc);
  it('serializes headings, marks and links', () => {
    expect(md).toContain('# Title');
    expect(md).toContain('Plain **bold** and *italic* and [link](https://example.com)');
  });
  it('serializes lists and task lists', () => {
    expect(md).toContain('- one\n- two');
    expect(md).toContain('1. first');
    expect(md).toContain('- [x] done');
  });
  it('serializes tables with escaped pipes', () => {
    expect(md).toContain('| H1 | H2 |\n| --- | --- |\n| a | b\\|c |');
  });
  it('serializes code blocks and quotes', () => {
    expect(md).toContain('```js\nlet x = 1;\nx++;\n```');
    expect(md).toContain('> quoted');
  });
  it('escapes markdown control characters in text', () => {
    expect(jsonToMarkdown({ type: 'doc', content: [p(t('2 * 3 = [6]'))] })).toBe('2 \\* 3 = \\[6\\]\n');
  });
});

describe('docx export', () => {
  it('round-trips through mammoth', async () => {
    const buf = await docxBuffer(sampleDoc, DEFAULT_SETTINGS, { title: 'Test' });
    expect(buf.subarray(0, 2).toString()).toBe('PK');
    const { value } = await mammoth.convertToHtml({ buffer: buf });
    expect(value).toContain('<h1>Title</h1>');
    expect(value).toContain('<strong>bold</strong>');
    expect(value).toContain('<em>italic</em>');
    expect(value).toContain('<a href="https://example.com">link</a>');
    expect(value).toMatch(/<ul><li>one<\/li><li>two<\/li><\/ul>/);
    expect(value).toMatch(/<ol><li>first<\/li><\/ol>/);
    expect(value).toContain('<table>');
    expect(value).toContain('b|c');
  });

  it('embeds data-URL images', async () => {
    // 1×1 transparent PNG
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    const doc = { type: 'doc', content: [p({ type: 'image', attrs: { src: png, alt: 'dot' } })] };
    const buf = await docxBuffer(doc, DEFAULT_SETTINGS, {});
    const { value } = await mammoth.convertToHtml({ buffer: buf });
    expect(value).toMatch(/<img [^>]*src="data:image\/png;base64,/);
  });

  it('converts colors and font sizes', () => {
    expect(cssColorToHex('#abc')).toBe('AABBCC');
    expect(cssColorToHex('rgb(255, 0, 128)')).toBe('FF0080');
    expect(cssColorToHex('red')).toBe('FF0000');
    expect(cssColorToHex('nonsense')).toBeUndefined();
    expect(fontSizeToHalfPoints('12pt')).toBe(24);
    expect(fontSizeToHalfPoints('16px')).toBe(24);
  });
});

describe('import', () => {
  it('converts text to escaped paragraphs', () => {
    expect(textToHtml('a <b>\r\nc')).toBe('<p>a &lt;b&gt;</p><p>c</p>');
  });
  it('extracts text from simple RTF', () => {
    const bs = String.fromCharCode(92);
    const rtf = `{${bs}rtf1${bs}ansi{${bs}fonttbl${bs}f0 Arial;}${bs}f0 Hello ${bs}b World${bs}b0${bs}par Caf${bs}'e9 ${bs}u8364? ${bs}{x${bs}}${bs}par}`;
    expect(rtfToText(rtf)).toBe('Hello World\nCafé € {x}');
  });
  it('sanitizes dangerous HTML', () => {
    const out = sanitizeHtml('<p onclick="x()">hi<script>alert(1)</script><a href="javascript:alert(1)">l</a><img src="x" onerror="y()"></p>');
    expect(out).not.toMatch(/script|onclick|onerror|javascript:/);
    expect(out).toContain('hi');
  });
  it('converts GFM task lists from markdown', async () => {
    const html = await markdownToHtml('- [x] done\n- [ ] todo\n');
    expect(html).toContain('data-type="taskList"');
    expect(html).toContain('data-checked="true"');
    expect(html).not.toContain('<input');
  });
});

describe('paragraph format parsing', () => {
  it('parses CSS lengths', () => {
    expect(cssLengthToPx('12pt')).toBe(16);
    expect(cssLengthToPx('1in')).toBe(96);
    expect(cssLengthToPx('2.54cm')).toBeCloseTo(96);
    expect(cssLengthToPx('bogus')).toBeNull();
  });
  it('parses line heights', () => {
    expect(parseLineHeight('1.5')).toBe('1.5');
    expect(parseLineHeight('115%')).toBe('1.15');
    expect(parseLineHeight('normal')).toBeNull();
    expect(parseLineHeight('20px')).toBeNull();
  });
});

describe('search', () => {
  const doc = PMNode.fromJSON(schema, {
    type: 'doc',
    content: [p(t('The cat sat on the '), t('cat', [{ type: 'bold' }]), t('alog.')), p(t('Concatenate CAT'))],
  });
  it('finds case-insensitive matches across text nodes', () => {
    const res = findMatches(doc, buildRegExp('catalog'));
    expect(res).toHaveLength(1);
    expect(doc.textBetween(res[0].from, res[0].to)).toBe('catalog');
  });
  it('respects case sensitivity and whole words', () => {
    expect(findMatches(doc, buildRegExp('cat'))).toHaveLength(4);
    expect(findMatches(doc, buildRegExp('cat', { caseSensitive: true }))).toHaveLength(3);
    expect(findMatches(doc, buildRegExp('cat', { wholeWord: true }))).toHaveLength(2);
  });
  it('supports regular expressions and rejects invalid ones', () => {
    expect(findMatches(doc, buildRegExp('c.t', { regex: true }))).toHaveLength(4);
    expect(buildRegExp('(', { regex: true })).toBeNull();
  });
});

describe('docx comments', () => {
  it('writes comment threads anchored to the commented text', async () => {
    const JSZip = (await import('jszip')).default;
    const mark = [{ type: 'comment', attrs: { id: 'c1' } }];
    const doc = { type: 'doc', content: [p(t('Before '), t('commented', mark), t(' after'))] };
    const comments = { c1: { id: 'c1', author: 'Ada Lovelace', initials: 'AL', date: 0, text: 'Check this', resolved: false, replies: [{ author: 'Bob', date: 0, text: 'Done' }] } };
    const buf = await docxBuffer(doc, DEFAULT_SETTINGS, { comments });
    const zip = await JSZip.loadAsync(buf);
    const xml = await zip.file('word/comments.xml').async('string');
    expect(xml).toContain('w:author="Ada Lovelace"');
    expect(xml).toContain('Check this');
    expect(xml).toContain('Done');
    const body = await zip.file('word/document.xml').async('string');
    expect(body).toMatch(/<w:commentRangeStart w:id="0"\/>.*commented.*<w:commentRangeEnd w:id="0"\/>/s);
  });
});

describe('paste from Word', async () => {
  const { cleanWordHtml, isWordHtml } = await import('../../src/io/paste.js');
  const word = `<html xmlns:o="urn:schemas-microsoft-com:office:office"><body>
<p class=MsoNormal>Intro<o:p></o:p></p>
<p class=MsoListParagraphCxSpFirst style='text-indent:-.25in;mso-list:l0 level1 lfo1'><span style='mso-list:Ignore'>·<span>&nbsp;&nbsp;</span></span>Apple<o:p></o:p></p>
<p class=MsoListParagraphCxSpMiddle style='margin-left:1.0in;text-indent:-.25in;mso-list:l0 level2 lfo1'><span style='mso-list:Ignore'>o<span>&nbsp;</span></span>Green<o:p></o:p></p>
<p class=MsoListParagraphCxSpLast style='text-indent:-.25in;mso-list:l0 level1 lfo1'><span style='mso-list:Ignore'>·<span>&nbsp;</span></span>Banana<o:p></o:p></p>
<p class=MsoNormal>Steps</p>
<p class=MsoListParagraph style='text-indent:-.25in;mso-list:l1 level1 lfo2'><span style='mso-list:Ignore'>1.<span>&nbsp;</span></span>First</p>
</body></html>`;
  it('detects Word HTML', () => {
    expect(isWordHtml(word)).toBe(true);
    expect(isWordHtml('<p>plain</p>')).toBe(false);
  });
  it('rebuilds nested bullet and numbered lists', () => {
    const out = cleanWordHtml(word).replace(/\s+/g, ' ');
    expect(out).toMatch(/<ul><li><p[^>]*>Apple<\/p><ul><li><p[^>]*>Green<\/p><\/li><\/ul><\/li><li><p[^>]*>Banana<\/p><\/li><\/ul>/);
    expect(out).toMatch(/<ol><li><p[^>]*>First<\/p><\/li><\/ol>/);
    expect(out).not.toMatch(/mso-list|·|o:p|class="Mso/);
  });
});

describe('search limits', async () => {
  const { MAX_RESULTS } = await import('../../src/editor/search.js');
  it('stops collecting matches at the cap', () => {
    const many = PMNode.fromJSON(schema, { type: 'doc', content: Array.from({ length: 30 }, () => p(t('e'.repeat(500)))) });
    expect(findMatches(many, buildRegExp('e'))).toHaveLength(MAX_RESULTS);
  });
});

describe('docx import', async () => {
  const { readDocx } = await import('../../src/io/docx-import.js');
  const mark = [{ type: 'comment', attrs: { id: 'c1' } }];
  const doc = {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 2 }, content: [t('Section')] },
      { type: 'paragraph', attrs: { textAlign: 'center', lineHeight: '2', spaceAfter: 0 }, content: [t('Centered '), t('red', [{ type: 'textStyle', attrs: { color: '#ff0000', fontSize: '14pt', fontFamily: 'Georgia, serif' } }]), t(' note', mark)] },
      { type: 'paragraph', attrs: { styleId: 'quote' }, content: [t('A quote')] },
      ...sampleDoc.content.slice(1),
    ],
  };
  const settings = { ...DEFAULT_SETTINGS, pageSize: 'a4', orientation: 'landscape', margins: { top: 48, bottom: 48, left: 72, right: 72 }, header: 'ACME', footer: 'Draft', pageNumbers: true };
  const comments = { c1: { id: 'c1', author: 'Ada', initials: 'A', date: Date.UTC(2026, 0, 2), text: 'Check', resolved: true, replies: [{ author: 'Bob', date: Date.UTC(2026, 0, 3), text: 'OK' }] } };

  it('round-trips LibreWord .docx exports with formatting', async () => {
    const buf = await docxBuffer(doc, settings, { comments });
    const r = await readDocx(buf);
    const html = r.html.replace(/\s+/g, ' ');
    expect(html).toContain('<h2>Section</h2>');
    expect(html).toMatch(/<p style="text-align: center; line-height: 2; margin-bottom: 0pt">Centered /);
    expect(html).toMatch(/color: #ff0000; font-size: 14pt; font-family: Georgia/);
    expect(html).toContain('<p data-style="quote">A quote</p>');
    expect(html).toMatch(/<strong>bold<\/strong>/);
    expect(html).toMatch(/<a href="https:\/\/example.com">/);
    expect(html).toMatch(/<ul><li><p>one<\/p><\/li><li><p>two<\/p><\/li><\/ul>/);
    expect(html).toMatch(/<ol><li><p>first<\/p><\/li><\/ol>/);
    expect(html).toMatch(/<table><tbody><tr><th[^>]*><p><strong>H1<\/strong><\/p><\/th>.*<tr><td[^>]*><p>a<\/p><\/td>/);
    expect(html).toContain('<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>done</p></li></ul>');
    expect(html).not.toMatch(/<p><\/p><div data-page-break>/);
    expect(html).toContain('<div data-page-break></div>');
    expect(html).toMatch(/<span data-comment-id="d0">[^<]*note<\/span>/);
  });

  it('reads page setup, header/footer and threaded comments', async () => {
    const r = await readDocx(await docxBuffer(doc, settings, { comments }));
    expect(r.settings).toMatchObject({ pageSize: 'a4', orientation: 'landscape', margins: { top: 48, bottom: 48, left: 72, right: 72 }, header: 'ACME', footer: 'Draft', pageNumbers: true });
    expect(r.comments.d0).toMatchObject({ author: 'Ada', text: 'Check', resolved: true });
    expect(r.comments.d0.replies).toEqual([expect.objectContaining({ author: 'Bob', text: 'OK' })]);
  });

  it('nests multi-level lists', async () => {
    const nested = { type: 'doc', content: [{ type: 'bulletList', content: [
      { type: 'listItem', content: [p(t('a')), { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('a1'))] }] }] },
      { type: 'listItem', content: [p(t('b'))] },
    ] }] };
    const r = await readDocx(await docxBuffer(nested, DEFAULT_SETTINGS, {}));
    expect(r.html).toBe('<ul><li><p>a</p><ul><li><p>a1</p></li></ul></li><li><p>b</p></li></ul>');
  });
});

describe('file names', async () => {
  const { fileNameFor, formatOfName } = await import('../../src/io/file-access.js');
  it('keeps periods in titles and swaps only document extensions', () => {
    expect(fileNameFor('Q3 vs. Q4 report', 'docx')).toBe('Q3 vs. Q4 report.docx');
    expect(fileNameFor('Release v1.2 notes', 'md')).toBe('Release v1.2 notes.md');
    expect(fileNameFor('notes.md', 'docx')).toBe('notes.docx');
    expect(fileNameFor('a/b:c?', 'txt')).toBe('a-b-c-.txt');
  });
  it('maps file names to writable formats', () => {
    expect(formatOfName('Report.DOCX')).toBe('docx');
    expect(formatOfName('x.markdown')).toBe('md');
    expect(formatOfName('page.htm')).toBe('html');
    expect(formatOfName('old.rtf')).toBe('rtf');
    expect(formatOfName('letter.odt')).toBe('odt');
    // Read-only formats open as copies.
    expect(formatOfName('legacy.doc')).toBeNull();
    expect(formatOfName('template.dotx')).toBeNull();
  });
});

describe('io regressions', async () => {
  const { Editor } = await import('@tiptap/core');
  const JSZip = (await import('jszip')).default;
  const { staticHtml } = await import('../../src/io/export.js');
  const { readDocx } = await import('../../src/io/docx-import.js');
  const { handleFromDataTransfer } = await import('../../src/io/file-access.js');
  const li = (...content) => ({ type: 'listItem', content });

  it('only returns a dropped handle that belongs to the wanted file', async () => {
    const item = (name) => ({ kind: 'file', getAsFileSystemHandle: () => Promise.resolve({ kind: 'file', name }) });
    const dataTransfer = { items: [item('notes.pdf'), item('report.docx')] };
    expect((await handleFromDataTransfer(dataTransfer, { name: 'report.docx' }))?.name).toBe('report.docx');
    expect(await handleFromDataTransfer({ items: [item('notes.pdf')] }, { name: 'report.docx' })).toBeNull();
    expect(await handleFromDataTransfer(dataTransfer)).toBeNull();
  });

  it('keeps "$" patterns in TOC headings literal in HTML export', () => {
    const editor = new Editor({ extensions: buildExtensions(), content: "<nav data-toc></nav><h1>Cost $& and $' here</h1><p>body</p>" });
    const html = staticHtml(editor);
    editor.destroy();
    expect(html).toContain('<span class="toc-text">Cost $&amp; and $&#39; here</span>');
    expect(html.match(/<nav/g)).toHaveLength(1);
  });

  it('indents nested task lists so they stay lists', async () => {
    const doc = { type: 'doc', content: [{ type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: false }, content: [p(t('parent')), { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [p(t('child'))] }] }] }] }] };
    const md = jsonToMarkdown(doc);
    expect(md).toBe('- [ ] parent\n\n  - [x] child\n');
    const html = await markdownToHtml(md);
    expect(html).not.toContain('<pre>');
    expect(html.match(/data-type="taskList"/g)).toHaveLength(2);
  });

  it('fences code containing backticks', async () => {
    expect(jsonToMarkdown({ type: 'doc', content: [p(t('a`b', [{ type: 'code' }]))] })).toBe('``a`b``\n');
    expect(jsonToMarkdown({ type: 'doc', content: [p(t('`x', [{ type: 'code' }]))] })).toBe('`` `x ``\n');
    expect(await markdownToHtml(jsonToMarkdown({ type: 'doc', content: [p(t('a`b', [{ type: 'code' }]))] }))).toContain('<code>a`b</code>');
    const md = jsonToMarkdown({ type: 'doc', content: [{ type: 'codeBlock', content: [t('x\n```\ny')] }, p(t('after'))] });
    expect(md).toBe('````\nx\n```\ny\n````\n\nafter\n');
    expect(await markdownToHtml(md)).toMatch(/<pre><code>x\n```\ny\n<\/code><\/pre>\s*<p>after<\/p>/);
  });

  it('escapes tildes and entity-like text', async () => {
    const md = jsonToMarkdown({ type: 'doc', content: [p(t('&lt; & ~~no~~'))] });
    expect(md).toBe('\\&lt; & \\~\\~no\\~\\~\n');
    expect(await markdownToHtml(md)).toBe('<p>&amp;lt; &amp; ~~no~~</p>\n');
  });

  it('exports ordered lists with their start number', async () => {
    const doc = { type: 'doc', content: [
      { type: 'orderedList', attrs: { start: 5 }, content: [li(p(t('five'))), li(p(t('six')))] },
      { type: 'orderedList', attrs: { start: 1 }, content: [li(p(t('one')))] },
    ] };
    const buf = await docxBuffer(doc, DEFAULT_SETTINGS, {});
    const numbering = await (await JSZip.loadAsync(buf)).file('word/numbering.xml').async('string');
    expect(numbering).toContain('<w:startOverride w:val="5"/>');
    const { html } = await readDocx(buf);
    expect(html).toBe('<ol start="5"><li><p>five</p></li><li><p>six</p></li></ol><ol><li><p>one</p></li></ol>');
  });

  it('restarts every nested ordered list in Word', async () => {
    const ol = (start, ...items) => ({ type: 'orderedList', attrs: { start }, content: items });
    const doc = { type: 'doc', content: [
      ol(1, li(p(t('A')), ol(1, li(p(t('A.a'))), li(p(t('A.b'))))), li(p(t('B')), ol(1, li(p(t('B.a')))))),
      ol(1, li(p(t('C')), ol(3, li(p(t('C.c'))), li(p(t('C.d')), ol(1, li(p(t('C.d.i')))))))),
    ] };
    const zip = await JSZip.loadAsync(await docxBuffer(doc, DEFAULT_SETTINGS, {}));
    const numbering = await zip.file('word/numbering.xml').async('string');
    const body = await zip.file('word/document.xml').async('string');
    // The restarts each numbering instance (w:num) carries, as { level: start }.
    const restarts = new Map([...numbering.matchAll(/<w:num w:numId="(\d+)">([\s\S]*?)<\/w:num>/g)].map(([, id, xml]) => [
      id, Object.fromEntries([...xml.matchAll(/<w:lvlOverride w:ilvl="(\d+)">\s*<w:startOverride w:val="(\d+)"\/>/g)].map(([, l, v]) => [l, +v])),
    ]));
    // Each list paragraph's text with the level and instance it is numbered with.
    const paras = [...body.matchAll(/<w:p>([\s\S]*?)<\/w:p>/g)].map(([, xml]) => ({
      text: /<w:t[^>]*>([^<]*)</.exec(xml)?.[1],
      level: /<w:ilvl w:val="(\d+)"\/>/.exec(xml)?.[1],
      num: /<w:numId w:val="(\d+)"\/>/.exec(xml)?.[1],
    })).filter((x) => x.num);
    const nested = { 'A.a': ['1', 1], 'B.a': ['1', 1], 'C.c': ['1', 3], 'C.d.i': ['2', 1] };
    for (const [text, [level, start]] of Object.entries(nested)) {
      const para = paras.find((x) => x.text === text);
      expect(para.level).toBe(level);
      expect(restarts.get(para.num)[level]).toBe(start);
    }
    // Separate lists use separate instances; items of one list share theirs.
    const num = (text) => paras.find((x) => x.text === text).num;
    expect(num('A.a')).toBe(num('A.b'));
    expect(new Set(['A', 'A.a', 'B.a', 'C', 'C.c', 'C.d.i'].map(num)).size).toBe(6);
    expect(restarts.get(num('A'))['0']).toBe(1);
  });

  it('converts relative and absolute CSS font sizes', () => {
    expect(fontSizeToHalfPoints('1.5em')).toBe(36);
    expect(fontSizeToHalfPoints('0.875rem')).toBe(21);
    expect(fontSizeToHalfPoints('12')).toBe(24);
    expect(fontSizeToHalfPoints('120%')).toBeUndefined();
    expect(fontSizeToHalfPoints('small')).toBeUndefined();
  });

  it('decodes RTF bytes in the document code page', () => {
    const bs = String.fromCharCode(92);
    const rtf = `{${bs}rtf1${bs}ansi${bs}ansicpg1252 It${bs}'92s ${bs}'93q${bs}'94${bs}~x ${bs}u8220${bs}'93y}`;
    expect(rtfToText(rtf)).toBe('It\u2019s \u201cq\u201d\u00a0x \u201cy');
    const sjis = `{${bs}rtf1${bs}ansi${bs}ansicpg932 ${bs}'82${bs}'a0}`;
    expect(rtfToText(sjis)).toBe('\u3042');
  });
});
