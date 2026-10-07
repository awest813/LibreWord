import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSchema } from '@tiptap/core';
import { DOMParser as PMDOMParser } from '@tiptap/pm/model';
import JSZip from 'jszip';
import { buildExtensions } from '../../src/editor/create-editor.js';
import { preserveSpaces, sanitizeHtml } from '../../src/io/import.js';
import { rtfToHtml, jsonToRtf } from '../../src/io/rtf.js';

const schema = getSchema(buildExtensions());
const fixture = (name) => readFileSync(`tests/fixtures/rtf/${name}`, 'utf8');
// A 4×3 red PNG (tests/fixtures/rtf/src/red.png).
const PNG = readFileSync('tests/fixtures/rtf/src/red.png');
const PNG_HEX = PNG.toString('hex');
const PNG_URL = `data:image/png;base64,${PNG.toString('base64')}`;

/** Parse HTML the way the editor loads an imported document. */
const load = (html) => {
  const el = document.createElement('div');
  el.innerHTML = preserveSpaces(sanitizeHtml(html));
  return PMDOMParser.fromSchema(schema).parse(el).toJSON();
};
const html = (rtf) => rtfToHtml(rtf).html;
/** Wrap body RTF in a minimal document. */
const doc = (body, head = '') => `{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0\\fswiss Calibri;}{\\f1\\fswiss Arial;}{\\f2\\fmodern Courier New;}}`
  + `{\\colortbl;\\red255\\green0\\blue0;\\red255\\green255\\blue0;\\red0\\green0\\blue255;}${head}\n${body}}`;

const t = (text, marks) => ({ type: 'text', text, ...(marks ? { marks } : {}) });
const p = (...content) => ({ type: 'paragraph', content });
const li = (...content) => ({ type: 'listItem', content });
const pmDoc = (...content) => ({ type: 'doc', content });
const mark = (type, attrs) => ({ type, ...(attrs ? { attrs } : {}) });
const viaRtf = (json, opts) => load(rtfToHtml(jsonToRtf(json, opts)).html);
/** Fill in default attributes, as the editor would when loading the JSON. */
const normalize = (json) => schema.nodeFromJSON(json).toJSON();

// ======================================================================== reader
describe('RTF reader: basics', () => {
  it('rejects input that is not RTF', () => {
    expect(() => rtfToHtml('hello')).toThrow(/Rich Text Format/);
    expect(() => rtfToHtml('<html></html>')).toThrow();
    expect(() => rtfToHtml('\uFEFF{\\rtf1 ok}')).not.toThrow();
  });

  it('reads plain paragraphs and the document title', () => {
    const r = rtfToHtml(doc('\\pard Hello world\\par Second\\par', '{\\info{\\title My \\u8220?Doc\\u8221?}{\\author Someone}}'));
    expect(r.title).toBe('My “Doc”');
    expect(r.html).toBe('<p>Hello world</p><p>Second</p>');
  });

  it('escapes text', () => {
    expect(html(doc('\\pard <b>&amp; \\{x\\}\\\\\\par'))).toBe('<p>&lt;b&gt;&amp;amp; {x}\\</p>');
  });

  it('keeps the last paragraph even without \\par, and returns an empty paragraph for an empty document', () => {
    expect(html(doc('\\pard tail'))).toBe('<p>tail</p>');
    expect(html('{\\rtf1}')).toBe('<p></p>');
  });

  it('handles \\line, \\tab, \\page and special characters', () => {
    expect(html(doc('\\pard a\\line b\\tab c\\~d\\emdash\\endash\\lquote\\rquote\\ldblquote\\rdblquote\\bullet\\-e\\_f\\par')))
      .toBe('<p>a<br>b\tc\u00a0d—–‘’“”•e\u2011f</p>');
    expect(html(doc('\\pard one\\page two\\par'))).toBe('<p>one</p><div data-page-break></div><p>two</p>');
    // The empty paragraph left behind a page break is dropped.
    expect(html(doc('\\pard one\\par\\page\\par two\\par'))).toBe('<p>one</p><div data-page-break></div><p>two</p>');
    expect(html(doc('\\pard one\\par\\pard\\pagebb two\\par'))).toBe('<p>one</p><div data-page-break></div><p>two</p>');
  });

  it('skips destinations that are not body text', () => {
    const body = '{\\header head}{\\footer foot}\\pard A{\\footnote note}{\\*\\bkmkstart b}{\\*\\unknowndest junk}{\\v hidden}'
      + '{\\annotation x}{\\*\\generator gen;}B\\par';
    expect(html(doc(body, '{\\stylesheet{\\s0 Normal;}}{\\*\\rsidtbl \\rsid1}'))).toBe('<p>AB</p>');
  });
});

describe('RTF reader: Unicode and code pages', () => {
  it('skips \\ucN fallback characters, per group', () => {
    expect(html("{\\rtf1\\uc0 \\u8217\\'e9 x}")).toBe('<p>’é x</p>');
    expect(html("{\\rtf1 \\u8220\\'93q}")).toBe('<p>“q</p>');
    expect(html("{\\rtf1 {\\uc2 \\u8220\\'81\\'40a}\\u8220?b}")).toBe('<p>“a“b</p>');
    // A control word counts as one fallback character (its delimiting space goes with it).
    expect(html('{\\rtf1 \\u8226\\bullet  x}')).toBe('<p>• x</p>');
  });

  it('joins surrogate pairs written as two \\u values', () => {
    expect(html('{\\rtf1 \\u-10179?\\u-8704? smile}')).toBe('<p>😀 smile</p>');
  });

  it("decodes \\'hh in the document code page", () => {
    expect(html("{\\rtf1\\ansi \\'93q\\'94 \\'80 caf\\'e9}")).toBe('<p>“q” € café</p>');
    expect(html("{\\rtf1\\ansi\\ansicpg1251 \\'cf\\'f0\\'e8\\'e2\\'e5\\'f2}")).toBe('<p>Привет</p>');
    expect(html("{\\rtf1\\ansi\\ansicpg932 \\'82\\'a0\\'82\\'a2}")).toBe('<p>あい</p>');
  });

  it('uses each font\'s \\fcharset', () => {
    const rtf = "{\\rtf1\\ansi{\\fonttbl{\\f0 Calibri;}{\\f1\\fcharset161 Arial Greek;}{\\f2\\fcharset204 Arial Cyr;}}\\f1 \\'e1\\'e2 {\\f2 \\'c4\\'e0} {\\f0 \\'e9}\\par}";
    expect(load(html(rtf)).content[0].content.map((n) => n.text).join('')).toBe('αβ Да é');
  });

  it('reads raw bytes when given an ArrayBuffer', () => {
    const bytes = Uint8Array.from([...'{\\rtf1\\ansi\\ansicpg1252 caf'].map((c) => c.charCodeAt(0)).concat([0xe9, 0x7d]));
    expect(rtfToHtml(bytes).html).toBe('<p>café</p>');
    expect(rtfToHtml(bytes.buffer).html).toBe('<p>café</p>');
  });

  it('prefers the Unicode version of \\upr groups', () => {
    expect(html("{\\rtf1 {\\upr{ansi \\'3f}{\\*\\ud{uni \\u1488?}}}\\par}")).toBe('<p>uni א</p>');
  });
});

describe('RTF reader: character formatting', () => {
  it('maps the usual toggles', () => {
    const out = html(doc('\\pard {\\b b}{\\i i}{\\ul u}{\\ul\\ulnone n}{\\uldb d}{\\strike s}{\\super 2}{\\sub 3}{\\up6 up}{\\b\\b0 off}{\\b\\i\\plain plain}\\par'));
    expect(out).toBe('<p><strong>b</strong><em>i</em><u>u</u>n<u>d</u><s>s</s><sup>2</sup><sub>3</sub><sup>up</sup>offplain</p>');
  });

  it('maps fonts, sizes, colours and highlights to spans and marks', () => {
    const out = html(doc('\\pard {\\f1\\fs28\\cf1 big}{\\highlight2 hl}{\\chcbpat3 shade}{\\f0\\fs22 default}\\par'));
    expect(out).toBe('<p><span style="color: #ff0000; font-size: 14pt; font-family: Arial">big</span>'
      + '<mark data-color="#ffff00" style="background-color: #ffff00">hl</mark>'
      + '<mark data-color="#0000ff" style="background-color: #0000ff">shade</mark>default</p>');
    const json = load(out);
    expect(json.content[0].content[0].marks).toEqual([{ type: 'textStyle', attrs: { fontFamily: 'Arial', fontSize: '14pt', color: '#ff0000' } }]);
    expect(json.content[0].content[1].marks).toEqual([{ type: 'highlight', attrs: { color: '#ffff00' } }]);
  });

  it('turns monospaced runs into inline code, unless the whole paragraph is monospaced', () => {
    expect(html(doc('\\pard run {\\f2 npm test} now\\par'))).toBe('<p>run <code>npm test</code> now</p>');
    expect(html(doc('\\pard\\f2 INT. HOUSE - DAY\\par'))).toBe("<p><span style=\"font-family: &#39;Courier New&#39;\">INT. HOUSE - DAY</span></p>");
  });

  it('drops hidden text', () => {
    expect(html(doc('\\pard a{\\v secret}b\\v c\\v0 d\\par'))).toBe('<p>abd</p>');
  });
});

describe('RTF reader: paragraphs and styles', () => {
  it('maps alignment, indents, spacing and line height', () => {
    expect(html(doc('\\pard\\qc centred\\par\\pard\\qr\\li720\\fi-360 right\\par\\pard\\qj\\sb240\\sa120\\sl480\\slmult1 just\\par')))
      .toBe('<p style="text-align: center">centred</p>'
        + '<p style="text-align: right; margin-left: 48px; text-indent: -24px">right</p>'
        + '<p style="text-align: justify; line-height: 2; padding-top: 12pt; margin-bottom: 6pt">just</p>');
  });

  it('keeps paragraph properties until \\pard', () => {
    expect(html(doc('\\pard\\qc a\\par b\\par\\pard c\\par'))).toBe('<p style="text-align: center">a</p><p style="text-align: center">b</p><p>c</p>');
  });

  it('turns "heading N" styles and outline levels into headings, dropping the style\'s own formatting', () => {
    const sheet = '{\\stylesheet{\\s0 Normal;}{\\s1\\sbasedon0\\keepn\\sb240\\b\\f1\\fs32\\cf3 heading 1;}{\\s2\\b\\fs28 Heading 2;}{\\s15\\fs56 Title;}{\\*\\cs20\\b Strong;}}';
    const body = '\\pard\\plain\\s1\\keepn\\sb240\\b\\f1\\fs32\\cf3 Top {\\cf1 red}\\par'
      + '\\pard\\plain\\s2\\qc\\b\\fs28 Second {\\i it}\\par'
      + '\\pard\\plain\\outlinelevel2 Third {\\b bold}\\par'
      + '\\pard\\plain\\s15\\fs56 The title\\par'
      + '\\pard\\plain\\s0 body\\par';
    expect(html(doc(body, sheet))).toBe('<h1>Top <span style="color: #ff0000">red</span></h1><h2 style="text-align: center">Second <em>it</em></h2>'
      + '<h3>Third <strong>bold</strong></h3><p data-style="title">The title</p><p>body</p>');
  });

  it('turns quote and code styles into blockquotes and code blocks', () => {
    const sheet = '{\\stylesheet{\\s0 Normal;}{\\s5\\li720 Block Text;}{\\s6\\f2 HTML Preformatted;}}';
    const body = '\\pard\\s5\\li720 quoted\\par\\pard\\s5\\li720 more\\par\\pard\\s6\\f2 if (a) \\{\\par\\pard\\s6\\f2   b();\\par\\pard\\s6\\f2 \\}\\par\\pard\\plain after\\par';
    expect(html(doc(body, sheet))).toBe('<blockquote><p>quoted</p><p>more</p></blockquote><pre><code>if (a) {\n  b();\n}</code></pre><p>after</p>');
  });

  it('reads a bottom-bordered empty paragraph as a horizontal rule', () => {
    expect(html(doc('\\pard a\\par\\pard\\brdrb\\brdrs\\brdrw10 \\par\\pard b\\par'))).toBe('<p>a</p><hr><p>b</p>');
  });
});

describe('RTF reader: lists', () => {
  const listtable = '{\\*\\listtable'
    + "{\\list\\listtemplateid1{\\listlevel\\levelnfc23\\levelstartat1{\\leveltext\\'01\\u8226 ?;}{\\levelnumbers;}\\fi-360\\li720}"
    + "{\\listlevel\\levelnfc23{\\leveltext\\'01o;}{\\levelnumbers;}\\fi-360\\li1440}\\listid10}"
    + "{\\list\\listtemplateid2{\\listlevel\\levelnfc0\\levelstartat3{\\leveltext\\'02\\'00.;}{\\levelnumbers\\'01;}\\fi-360\\li720}"
    + "{\\listlevel\\levelnfc4\\levelstartat1{\\leveltext\\'02\\'01.;}{\\levelnumbers\\'01;}\\fi-360\\li1440}\\listid20}}"
    + '{\\*\\listoverridetable{\\listoverride\\listid10\\listoverridecount0\\ls1}{\\listoverride\\listid20\\listoverridecount0\\ls2}}';

  it('builds nested lists from \\ls/\\ilvl and the list table (Word layout: \\listtext before \\pard)', () => {
    const body = "{\\listtext\\pard\\plain\\f1 \\'b7\\tab}\\pard\\fi-360\\li720\\ls1\\ilvl0 one\\par"
      + "{\\listtext\\pard\\plain o\\tab}\\pard\\fi-360\\li1440\\ls1\\ilvl1 nested\\par"
      + "{\\listtext\\pard\\plain\\f1 \\'b7\\tab}\\pard\\fi-360\\li720\\ls1\\ilvl0 two\\par"
      + '{\\listtext\\pard\\plain 3.\\tab}\\pard\\fi-360\\li720\\ls2\\ilvl0 three\\par'
      + '{\\listtext\\pard\\plain a.\\tab}\\pard\\fi-360\\li1440\\ls2\\ilvl1 sub\\par'
      + '{\\listtext\\pard\\plain 4.\\tab}\\pard\\fi-360\\li720\\ls2\\ilvl0 four\\par'
      + '\\pard after\\par';
    expect(html(doc(body, listtable))).toBe('<ul><li><p>one</p><ul><li><p>nested</p></li></ul></li><li><p>two</p></li></ul>'
      + '<ol start="3"><li><p>three</p><ol><li><p>sub</p></li></ol></li><li><p>four</p></li></ol><p>after</p>');
  });

  it('continues numbering when a list resumes after an interruption', () => {
    const body = '\\pard\\ls2\\ilvl0 a\\par\\pard\\ls2\\ilvl0 b\\par\\pard break\\par\\pard\\ls2\\ilvl0 c\\par';
    expect(html(doc(body, listtable))).toBe('<ol start="3"><li><p>a</p></li><li><p>b</p></li></ol><p>break</p><ol start="5"><li><p>c</p></li></ol>');
  });

  it('reads WordPad-style \\pn lists', () => {
    const body = "\\pard{\\pntext\\f1\\'b7\\tab}{\\*\\pn\\pnlvlblt\\pnf1\\pnindent0{\\pntxtb\\'b7}}\\fi-360\\li720 dot\\par"
      + "{\\pntext\\f1\\'b7\\tab}dot2\\par"
      + '\\pard{\\pntext 1.\\tab}{\\*\\pn\\pnlvlbody\\pndec\\pnstart1{\\pntxta.}}\\fi-360\\li720 num\\par'
      + '\\pard plain\\par';
    expect(html(doc(body))).toBe('<ul><li><p>dot</p></li><li><p>dot2</p></li></ul><ol><li><p>num</p></li></ol><p>plain</p>');
  });

  it('guesses the list type from \\listtext when there is no list table', () => {
    const body = '\\pard{\\listtext 1.\\tab}\\ls7 first\\par\\pard{\\listtext \\u8226?\\tab}\\ls8 bullet\\par';
    expect(html(doc(body))).toBe('<ol><li><p>first</p></li></ol><ul><li><p>bullet</p></li></ul>');
  });

  it('turns ☐/☒ paragraphs into a checklist', () => {
    expect(html(doc('\\pard\\fi-360\\li360 \\u9746? Done\\par\\pard\\fi-360\\li360 \\u9744? Todo\\par')))
      .toBe('<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>Done</p></li><li data-type="taskItem" data-checked="false"><p>Todo</p></li></ul>');
  });
});

describe('RTF reader: tables', () => {
  it('reads rows, cells, widths and multi-paragraph cells', () => {
    const body = '\\trowd\\trgaph108\\trleft0\\cellx1500\\cellx4500\\pard\\intbl A1\\cell\\pard\\intbl B1\\par\\pard\\intbl B1b\\cell\\row'
      + '\\trowd\\trgaph108\\trleft0\\cellx1500\\cellx4500\\pard\\intbl A2\\cell\\pard\\intbl {\\b B2}\\cell\\row'
      + '\\pard after\\par';
    expect(html(doc(body))).toBe('<table><tbody><tr><td colwidth="100"><p>A1</p></td><td colwidth="200"><p>B1</p><p>B1b</p></td></tr>'
      + '<tr><td colwidth="100"><p>A2</p></td><td colwidth="200"><p><strong>B2</strong></p></td></tr></tbody></table><p>after</p>');
  });

  it('reads merged cells, header rows and shading', () => {
    const body = '\\trowd\\trhdr\\cellx1500\\cellx3000\\cellx4500\\pard\\intbl {\\b H1}\\cell\\pard\\intbl H2\\cell\\pard\\intbl H3\\cell\\row'
      // a cell spanning two grid columns, and the start of a vertical merge
      + '\\trowd\\cellx3000\\clvmgf\\clcbpat2\\cellx4500\\pard\\intbl wide\\cell\\pard\\intbl tall\\cell\\row'
      + '\\trowd\\cellx1500\\cellx3000\\clvmrg\\cellx4500\\pard\\intbl a\\cell\\pard\\intbl b\\cell\\pard\\intbl \\cell\\row'
      // legacy horizontal merge
      + '\\trowd\\clmgf\\cellx1500\\clmrg\\cellx3000\\cellx4500\\pard\\intbl merged\\cell\\pard\\intbl \\cell\\pard\\intbl z\\cell\\row';
    const out = html(doc(body));
    expect(out).toBe('<table><tbody>'
      + '<tr><th colwidth="100"><p>H1</p></th><th colwidth="100"><p>H2</p></th><th colwidth="100"><p>H3</p></th></tr>'
      + '<tr><td colspan="2" colwidth="100,100"><p>wide</p></td><td rowspan="2" colwidth="100" style="background-color: #ffff00"><p>tall</p></td></tr>'
      + '<tr><td colwidth="100"><p>a</p></td><td colwidth="100"><p>b</p></td></tr>'
      + '<tr><td colspan="2" colwidth="100,100"><p>merged</p></td><td colwidth="100"><p>z</p></td></tr>'
      + '</tbody></table>');
    const table = load(out).content[0];
    expect(table.content[0].content.map((c) => c.type)).toEqual(['tableHeader', 'tableHeader', 'tableHeader']);
    expect(table.content[1].content[1].attrs).toMatchObject({ rowspan: 2, colwidth: [100], backgroundColor: 'rgb(255, 255, 0)' });
  });

  it('closes a table that is missing its final \\row', () => {
    expect(html(doc('\\trowd\\cellx1500\\pard\\intbl x\\cell'))).toBe('<table><tbody><tr><td colwidth="100"><p>x</p></td></tr></tbody></table>');
  });

  it('keeps lists inside cells', () => {
    const body = '\\trowd\\cellx3000\\pard\\intbl{\\listtext 1.\\tab}\\ls1 one\\par\\pard\\intbl{\\listtext 2.\\tab}\\ls1 two\\cell\\row';
    expect(html(doc(body))).toContain('<td colwidth="200"><ol><li><p>one</p></li><li><p>two</p></li></ol></td>');
  });
});

describe('RTF reader: fields and pictures', () => {
  it('turns HYPERLINK fields into links, dropping the link styling', () => {
    const body = 'see {\\field{\\*\\fldinst{HYPERLINK "https://example.com/a?b=1&c=2" }{\\*\\datafield 00ff}}{\\fldrslt{\\ul\\cf3 the {\\b site}}}} now'
      + ' {\\field{\\*\\fldinst HYPERLINK \\\\l "_Toc1"}{\\fldrslt here}}'
      + ' {\\field{\\*\\fldinst HYPERLINK "javascript:alert(1)"}{\\fldrslt bad}}'
      + ' {\\field{\\*\\fldinst PAGE \\\\* MERGEFORMAT}{\\fldrslt 7}}\\par';
    expect(html(doc(`\\pard ${body}`))).toBe('<p>see <a href="https://example.com/a?b=1&amp;c=2">the <strong>site</strong></a> now <a href="#_Toc1">here</a> bad 7</p>');
  });

  it('reads PNG and JPEG pictures with their display size', () => {
    const out = html(doc(`\\pard a{\\*\\shppict{\\pict{\\*\\picprop{\\sp{\\sn wzDescription}{\\sv red box}}}\\picscalex200\\picscaley100\\picw4\\pich3\\picwgoal60\\pichgoal45\\pngblip\n${PNG_HEX.replace(/(.{40})/g, '$1\n')}}}`
      + '{\\nonshppict{\\pict\\wmetafile8 0102}}b\\par'));
    expect(out).toBe(`<p>a<img src="${PNG_URL}" alt="red box" width="8" height="3">b</p>`);
    // Without a goal size, the image's own pixel size.
    expect(html(doc(`\\pard {\\pict\\pngblip ${PNG_HEX}}\\par`))).toBe(`<p><img src="${PNG_URL}" width="4" height="3"></p>`);
    const jpeg = 'ffd8ffc0000b080002000301012200ffd9';
    expect(html(doc(`\\pard {\\pict\\jpegblip ${jpeg}}\\par`))).toMatch(/^<p><img src="data:image\/jpeg;base64,[^"]+" width="3" height="2"><\/p>$/);
  });

  it('reads \\bin picture data and skips metafiles', () => {
    const bin = String.fromCharCode(...PNG);
    expect(html(doc(`\\pard {\\pict\\pngblip\\bin${PNG.length} ${bin}}x\\par`))).toBe(`<p><img src="${PNG_URL}" width="4" height="3">x</p>`);
    expect(html(doc('\\pard {\\pict\\emfblip 0102}{\\pict\\wmetafile8 0102}x\\par'))).toBe('<p>x</p>');
  });

  it('round-trips pictures into the editor', () => {
    const json = load(html(doc(`\\pard {\\pict\\pngblip\\picwgoal600\\pichgoal450 ${PNG_HEX}}\\par`)));
    expect(json.content[0].content[0]).toMatchObject({ type: 'image', attrs: { src: PNG_URL, width: 40, height: 30 } });
  });
});

describe('RTF reader: robustness', () => {
  it('survives deeply nested groups', () => {
    const deep = `{\\rtf1 ${'{'.repeat(20000)}x${'}'.repeat(20000)} after\\par}`;
    expect(() => rtfToHtml(deep)).not.toThrow();
    expect(html(deep)).toContain('after');
  });

  it('never throws on truncated or mangled documents', () => {
    const src = fixture('libreoffice-from-docx.rtf');
    for (let cut = 7; cut < src.length; cut += 97) {
      expect(() => rtfToHtml(src.slice(0, cut))).not.toThrow();
    }
    const junk = ['{\\rtf1 }}}} x', '{\\rtf1 \\', "{\\rtf1 \\'", "{\\rtf1 \\'zz", '{\\rtf1 \\u', '{\\rtf1 \\bin999999 x', '{\\rtf1 \\cell\\row\\cell', '{\\rtf1 {\\pict\\pngblip zz}',
      '{\\rtf1 {\\field{\\fldrslt x}}', '{\\rtf1 \\ls99\\ilvl99 x\\par', '{\\rtf1 \\trowd\\cellx-5\\cellx99999999999 \\intbl a\\cell\\row'];
    for (const s of junk) expect(() => rtfToHtml(s)).not.toThrow();
    // Random byte noise after a valid header.
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const alphabet = '{}\\\'abcdefghijklmnopqrstuvwxyz0123456789 -;*';
    for (let n = 0; n < 50; n++) {
      let s = '{\\rtf1 ';
      for (let k = 0; k < 400; k++) s += alphabet[Math.floor(rand() * alphabet.length)];
      expect(() => rtfToHtml(s)).not.toThrow();
    }
  });
});

describe('RTF reader: files written by LibreOffice', () => {
  it('a document converted from .docx (pandoc styles)', () => {
    const r = rtfToHtml(fixture('libreoffice-from-docx.rtf'));
    expect(r.title).toBe('Sample Title');
    const out = r.html;
    expect(out).toMatch(/^<p data-style="title">Sample Title<\/p><h1>Heading One<\/h1>/);
    expect(out).toContain('<strong>bold</strong>, <em>italic</em>, <s>strike</s>, H<sub>2</sub>O and x<sup>2</sup> and café “quotes” — Ωmega 😀.');
    expect(out).toMatch(/<h2>Heading Two<\/h2><ul><li><p[^>]*>Bullet one<\/p><\/li><li><p[^>]*>Bullet two<\/p><ul><li><p[^>]*>Nested bullet<\/p><\/li><\/ul><\/li><li><p[^>]*>Bullet three<\/p><\/li><\/ul>/);
    expect(out).toMatch(/<ol><li><p[^>]*>First<\/p><\/li><li><p[^>]*>Second<\/p><ol><li><p[^>]*>Sub a<\/p><\/li><\/ol><\/li><li><p[^>]*>Third<\/p><\/li><\/ol>/);
    expect(out).toMatch(/<table><tbody><tr><td colwidth="264"><p[^>]*>(<span[^>]*>)?Name/);
    expect(out).toMatch(/<td colwidth="264"><p[^>]*>(<span[^>]*>)?<strong>2<\/strong>/);
    expect(out).toContain('A <a href="https://example.com/">link to example</a> here.');
    expect(out).toMatch(/<img src="data:image\/png;base64,[^"]+" alt="red" width="40" height="30">/);
    expect(out).toContain('<h3>Heading Three</h3>');
  });

  it('a document converted from .odt', () => {
    const out = rtfToHtml(fixture('libreoffice-from-odt.rtf')).html;
    expect(out).toMatch(/^<p data-style="title">Sample Title<\/p><h1>Heading One<\/h1>/);
    expect(out).toMatch(/<ul><li><p[^>]*>Bullet one<\/p><\/li><li><p[^>]*>Bullet two<\/p><ul><li><p[^>]*>Nested bullet<\/p>/);
    expect(out).toMatch(/<ol><li><p[^>]*>First<\/p>/);
    expect(out).toMatch(/<td colwidth="312"><p[^>]*><strong>Name<\/strong><\/p><\/td>/);
    expect(out).toMatch(/<img src="data:image\/png;base64,[^"]+" width="40" height="30">/);
  });

  it('a document converted from HTML (direct formatting, merged cells, scripts, page break)', () => {
    const r = rtfToHtml(fixture('libreoffice-from-html.rtf'));
    expect(r.title).toBe('Formatting Test');
    const out = r.html;
    expect(out).toMatch(/<p style="text-align: center[^"]*">Centered <span style="color: #ff0000">red<\/span> and <span style="font-size: 14pt; font-family: Arial">Arial 14<\/span> <mark data-color="#ffff00" style="background-color: #ffff00">hl<\/mark><\/p>/);
    expect(out).toMatch(/<p style="[^"]*margin-left: 96px; text-indent: 48px">Indented para<\/p>/);
    expect(out).toMatch(/<p style="text-align: right[^"]*"><u>under<\/u> <s>strike<\/s> <sup>sup<\/sup> <sub>sub<\/sub><\/p>/);
    expect(out).toMatch(/<td colspan="2"[^>]*><p[^>]*>Merged<\/p><\/td><\/tr><tr><td rowspan="2"[^>]*><p[^>]*>Tall<\/p><\/td><td[^>]*><p[^>]*>b1<\/p><\/td><\/tr><tr><td[^>]*><p[^>]*>c1<\/p><\/td><\/tr>/);
    expect(out).toContain('Ελληνικά and Русский and 日本語');
    expect(out).toMatch(/<div data-page-break><\/div><p[^>]*>After break<\/p>$/);
  });

  it('loads into the editor schema', () => {
    for (const name of ['libreoffice-from-docx.rtf', 'libreoffice-from-odt.rtf', 'libreoffice-from-html.rtf']) {
      const json = load(rtfToHtml(fixture(name)).html);
      const types = new Set();
      const walk = (n) => { types.add(n.type); (n.content || []).forEach(walk); };
      walk(json);
      expect(types.has('paragraph')).toBe(true);
      expect(types.has('table')).toBe(true);
    }
  });
});

// ======================================================================== writer
describe('RTF writer', () => {
  it('writes a complete, 7-bit document with stylesheet, title and page setup', () => {
    const rtf = jsonToRtf(pmDoc(p(t('hi'))), {
      title: 'Ünïcode {title}',
      settings: { pageSize: 'a4', orientation: 'landscape', margins: { top: 96, right: 72, bottom: 48, left: 144 } },
    });
    expect(rtf.startsWith('{\\rtf1\\ansi\\ansicpg1252\\deff0')).toBe(true);
    expect(rtf.endsWith('}')).toBe(true);
    expect(/[^\x09\x0a\x0d\x20-\x7e]/.test(rtf)).toBe(false);
    expect(rtf).toContain('{\\info{\\title \\u220?n\\u239?code \\{title\\}}}');
    for (let level = 1; level <= 6; level++) expect(rtf).toMatch(new RegExp(`\\{\\\\s${level}[^;]*\\\\outlinelevel${level - 1}[^;]* heading ${level};\\}`));
    expect(rtf).toMatch(/\{\\s0[^;]* Normal;\}/);
    expect(rtf).toContain('\\paperw16838\\paperh11906\\margl2160\\margr1080\\margt1440\\margb720\\landscape');
    expect(rtf).toContain('{\\fonttbl{\\f0\\fswiss\\fcharset0 Calibri;}');
    // Braces balance.
    let depth = 0;
    for (let i = 0; i < rtf.length; i++) {
      if (rtf[i] === '\\') { i++; continue; }
      if (rtf[i] === '{') depth++;
      if (rtf[i] === '}') depth--;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
  });

  it('defaults to Letter portrait when no settings are given', () => {
    expect(jsonToRtf(pmDoc())).toContain('\\paperw12240\\paperh15840\\margl1440\\margr1440\\margt1440\\margb1440');
  });

  it('escapes text as \\uN?, with surrogate pairs for characters beyond the BMP', () => {
    const rtf = jsonToRtf(pmDoc(p(t('a\\b{c}\té “q” 😀 \u00a0x'))));
    expect(rtf).toContain('a\\\\b\\{c\\}\\tab \\u233? \\u8220?q\\u8221? \\u-10179?\\u-8704? \\~x');
  });

  it('writes marks as character formatting, links as HYPERLINK fields', () => {
    const rtf = jsonToRtf(pmDoc(p(
      t('b', [mark('bold')]), t('i', [mark('italic'), mark('underline')]), t('s', [mark('strike')]), t('2', [mark('superscript')]), t('3', [mark('subscript')]),
      t('c', [mark('code')]), t('red', [mark('textStyle', { color: '#ff0000', fontFamily: '"Times New Roman", serif', fontSize: '14pt' })]),
      t('y', [mark('highlight', { color: '#ffff00' })]), t('o', [mark('highlight', { color: '#ffcc00' })]),
      t('link', [mark('link', { href: 'https://example.com/"x"' }), mark('comment', { id: 'c1' })]),
    )));
    expect(rtf).toContain('{\\b b}{\\i\\ul i}{\\strike s}{\\super 2}{\\sub 3}{\\f2 c}');
    expect(rtf).toMatch(/\{\\cf(\d+)\\fs28\\f3 red\}/);
    expect(rtf).toContain('{\\f3\\fnil\\fcharset0 Times New Roman;}');
    expect(rtf).toMatch(/\{\\highlight\d+ y\}\{\\chshdng0\\chcbpat\d+ o\}/);
    expect(rtf).toContain('\\red255\\green0\\blue0;');
    expect(rtf).toMatch(/\{\\field\{\\\*\\fldinst\{HYPERLINK "https:\/\/example.com\/%22x%22"\}\}\{\\fldrslt\{\{\\ul\\cf\d+ link\}\}\}\}/);
  });

  it('writes headings with their style and paragraph formatting', () => {
    const rtf = jsonToRtf(pmDoc(
      { type: 'heading', attrs: { level: 2, textAlign: 'center' }, content: [t('H')] },
      { type: 'paragraph', attrs: { textAlign: 'justify', indent: 48, firstLineIndent: -24, spaceBefore: 12, spaceAfter: 3, lineHeight: '1.5' }, content: [t('P')] },
      { type: 'paragraph', attrs: { styleId: 'quote' }, content: [t('Q')] },
    ));
    expect(rtf).toMatch(/\\pard\\plain\\s2\\keepn[^ ]*\\outlinelevel1\\qc\\f1\\fs26\\cf\d+ H\\par/);
    expect(rtf).toContain('\\qj\\li720\\fi-360\\sb240\\sa60\\sl360\\slmult1');
    expect(rtf).toMatch(/\\pard\\plain\\s9[^ ]* Q\\par/);
  });

  it('writes lists with a list table, overrides and \\listtext fallbacks', () => {
    const rtf = jsonToRtf(pmDoc(
      { type: 'bulletList', content: [li(p(t('a')), { type: 'orderedList', attrs: { start: 1 }, content: [li(p(t('x'))), li(p(t('y')))] })] },
      { type: 'orderedList', attrs: { start: 4 }, content: [li(p(t('four'))), li(p(t('five')))] },
      { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [p(t('done'))] }] },
    ));
    expect(rtf).toContain('{\\*\\listtable');
    expect(rtf).toMatch(/\{\\list\\listtemplateid1\\listhybrid\{\\listlevel\\levelnfc23/);
    expect(rtf).toMatch(/\{\\list\\listtemplateid3\\listhybrid\{\\listlevel\\levelnfc0\\levelnfcn0\\leveljc0\\leveljcn0\\levelfollow0\\levelstartat4/);
    expect(rtf).toContain('{\\listoverride\\listid3\\listoverridecount0\\ls3}');
    expect(rtf).toContain('\\ls1\\ilvl0\\fi-360\\li720\\f0\\fs22 {\\listtext\\pard\\plain\\f0\\fs22 \\u8226?\\tab}a\\par');
    expect(rtf).toContain('\\ls2\\ilvl1\\fi-360\\li1440\\f0\\fs22 {\\listtext\\pard\\plain\\f0\\fs22 b.\\tab}y\\par');
    expect(rtf).toContain('{\\listtext\\pard\\plain\\f0\\fs22 5.\\tab}five\\par');
    expect(rtf).toContain('\\u9746? done\\par');
  });

  it('writes tables with widths, merges, shading and header rows', () => {
    const cell = (type, text, attrs = {}) => ({ type, attrs, content: [p(t(text))] });
    const rtf = jsonToRtf(pmDoc({ type: 'table', content: [
      { type: 'tableRow', content: [cell('tableHeader', 'H', { colwidth: [100] }), cell('tableHeader', 'I', { colwidth: [200] })] },
      { type: 'tableRow', content: [cell('tableCell', 'tall', { rowspan: 2, backgroundColor: '#00ff00' }), cell('tableCell', 'b')] },
      { type: 'tableRow', content: [cell('tableCell', 'c')] },
      { type: 'tableRow', content: [cell('tableCell', 'wide', { colspan: 2 })] },
    ] }));
    expect(rtf).toMatch(/\\trowd\\trgaph108\\trleft0\\trhdr[^\n]*\\cellx1500[^\n]*\\cellx4500\n/);
    expect(rtf).toContain('\\pard\\plain\\intbl\\s0\\sa160\\sl276\\slmult1\\f0\\fs22 {\\b H}\\cell');
    expect(rtf).toMatch(/\\clvmgf[^\n]*\\clcbpat\d+\\cellx1500/);
    expect(rtf).toMatch(/\\clvmrg[^\n]*\\cellx1500[^\n]*\\cellx4500\n\\pard\\plain\\intbl[^\n]* \\cell\n\\pard\\plain\\intbl[^\n]* c\\cell/);
    expect(rtf).toMatch(/\\trowd\\trgaph108\\trleft0\\clbrdrt[^\n]*\\cellx4500\n[^\n]* wide\\cell\n\\row/);
  });

  it('embeds PNG and JPEG images and keeps the alt text of others', () => {
    const jpeg = `data:image/jpeg;base64,${Buffer.from('ffd8ffc0000b080002000301012200ffd9', 'hex').toString('base64')}`;
    const rtf = jsonToRtf(pmDoc(p(
      { type: 'image', attrs: { src: PNG_URL, alt: 'red', width: 40, height: null } },
      { type: 'image', attrs: { src: jpeg } },
      { type: 'image', attrs: { src: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=', alt: 'anim' } },
      { type: 'image', attrs: { src: 'https://example.com/x.png' } },
    )));
    // Picture data is wrapped into lines of hex.
    expect(rtf.replace(/\n/g, '')).toContain(`{\\pict{\\*\\picprop{\\sp{\\sn wzDescription}{\\sv red}}}\\pngblip\\picw4\\pich3\\picwgoal600\\pichgoal450${PNG_HEX}}`);
    expect(rtf).toContain('\\jpegblip\\picw3\\pich2\\picwgoal45\\pichgoal30');
    expect(rtf).toContain('{\\i [anim]}');
  });

  it('writes the header, footer and page numbers', () => {
    const rtf = jsonToRtf(pmDoc(p(t('x'))), { settings: { header: 'Top', footer: 'Bottom', pageNumbers: true } });
    expect(rtf).toMatch(/\{\\header\\pard\\plain\\qr[^ ]* Top\\par\}/);
    expect(rtf).toMatch(/\{\\footer\\pard\\plain\\qc[^ ]* Bottom   Page \{\\field\{\\\*\\fldinst\{ PAGE \}\}/);
    // Neither shows up as body text when read back.
    expect(rtfToHtml(rtf).html).toBe('<p>x</p>');
  });

  it('writes a table of contents as plain entries', () => {
    const rtf = jsonToRtf(pmDoc({ type: 'tableOfContents' }, { type: 'heading', attrs: { level: 1 }, content: [t('Intro')] }, { type: 'heading', attrs: { level: 2 }, content: [t('Part')] }));
    const out = rtfToHtml(rtf).html;
    expect(out).toMatch(/^<p[^>]*><span[^>]*>Contents<\/span><\/p><p[^>]*>Intro<\/p><p[^>]*>Part<\/p><h1>Intro<\/h1><h2>Part<\/h2>$/);
  });
});

// =================================================================== round trips
describe('round trip: editor JSON → RTF → editor JSON', () => {
  it('keeps paragraphs, headings and paragraph formatting exactly', () => {
    const json = pmDoc(
      { type: 'heading', attrs: { level: 1 }, content: [t('Title')] },
      { type: 'heading', attrs: { level: 3, textAlign: 'right' }, content: [t('Sub '), t('bold', [mark('bold')])] },
      { type: 'paragraph', attrs: { textAlign: 'justify', indent: 48, firstLineIndent: 24, spaceBefore: 12, spaceAfter: 6, lineHeight: '2' }, content: [t('Formatted')] },
      { type: 'paragraph', attrs: { styleId: 'subtitle' }, content: [t('Sub-title')] },
      { type: 'paragraph', attrs: { styleId: 'caption' }, content: [t('Caption')] },
      p(t('Tabs\tand  double spaces')),
      p(),
      p(t('Ünïcödé “quotes” — 😀 中文 עברית')),
    );
    expect(viaRtf(json)).toEqual(normalize(json));
  });

  it('keeps marks', () => {
    const json = pmDoc(p(
      t('plain '), t('bold', [mark('bold')]), t(' '), t('italic', [mark('italic')]), t(' '), t('under', [mark('underline')]), t(' '),
      t('strike', [mark('strike')]), t(' x'), t('2', [mark('superscript')]), t(' H'), t('2', [mark('subscript')]), t('O '),
      t('code', [mark('code')]), t(' '), t('bi', [mark('bold'), mark('italic')]), t(' '),
      t('link', [mark('link', { href: 'https://example.com/' })]), t(' '),
      t('hl', [mark('highlight', { color: '#ffff00' })]), t(' '), t('shade', [mark('highlight', { color: '#ffcc00' })]),
      { type: 'hardBreak' }, t('styled', [mark('textStyle', { color: '#ff0000', fontFamily: 'Arial', fontSize: '14pt' })]),
    ));
    const back = viaRtf(json);
    const summary = (n) => (n.content || []).map((c) => [c.type, c.text, (c.marks || []).map((m) => m.type + (m.attrs?.href ? `:${m.attrs.href}` : '') + (m.attrs?.color && m.type === 'highlight' ? `:${m.attrs.color}` : '')).sort().join(',')]);
    expect(summary(back.content[0])).toEqual(summary(normalize(json).content[0]));
    const styled = back.content[0].content.at(-1);
    expect(styled.marks[0]).toMatchObject({ type: 'textStyle', attrs: { fontFamily: 'Arial', fontSize: '14pt', color: '#ff0000' } });
  });

  it('keeps nested lists, list starts and checklists', () => {
    const json = pmDoc(
      { type: 'bulletList', content: [
        li(p(t('one'))),
        li(p(t('two')), { type: 'bulletList', content: [li(p(t('two.a'))), li(p(t('two.b')), { type: 'orderedList', attrs: { start: 1, type: null }, content: [li(p(t('deep')))] })] }),
        li(p(t('three'))),
      ] },
      { type: 'orderedList', attrs: { start: 5, type: null }, content: [li(p(t('five'))), li(p(t('six')))] },
      { type: 'orderedList', attrs: { start: 1, type: null }, content: [li(p(t('again')))] },
      { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [p(t('done'))] }, { type: 'taskItem', attrs: { checked: false }, content: [p(t('todo'))] }] },
    );
    expect(viaRtf(json)).toEqual(normalize(json));
  });

  it('keeps blockquotes, code blocks, rules, page breaks and images', () => {
    const json = pmDoc(
      { type: 'blockquote', content: [p(t('quoted')), p(t('more'))] },
      { type: 'codeBlock', attrs: { language: null }, content: [t('if (a) {\n  b();\n}')] },
      { type: 'horizontalRule' },
      p(t('before')),
      { type: 'pageBreak' },
      p(t('after '), { type: 'image', attrs: { src: PNG_URL, alt: 'red', title: null, width: 40, height: 30 } }),
    );
    expect(viaRtf(json)).toEqual(normalize(json));
  });

  it('keeps tables with header rows, spans, widths and shading', () => {
    const cell = (type, text, attrs = {}) => ({ type, attrs: { colspan: 1, rowspan: 1, colwidth: null, backgroundColor: null, ...attrs }, content: [p(t(text))] });
    const json = pmDoc({ type: 'table', content: [
      { type: 'tableRow', content: [cell('tableHeader', 'H1', { colwidth: [120] }), cell('tableHeader', 'H2', { colwidth: [200] }), cell('tableHeader', 'H3', { colwidth: [80] })] },
      { type: 'tableRow', content: [cell('tableCell', 'wide', { colspan: 2, colwidth: [120, 200] }), cell('tableCell', 'tall', { rowspan: 2, colwidth: [80], backgroundColor: 'rgb(255, 204, 0)' })] },
      { type: 'tableRow', content: [cell('tableCell', 'a', { colwidth: [120] }), { ...cell('tableCell', 'b', { colwidth: [200] }), content: [p(t('b1')), { type: 'bulletList', content: [li(p(t('item')))] }] }] },
    ] }, p(t('after')));
    expect(viaRtf(json)).toEqual(normalize(json));
  });

  it('keeps the title', () => {
    expect(rtfToHtml(jsonToRtf(pmDoc(p(t('x'))), { title: 'Résumé 2026' })).title).toBe('Résumé 2026');
  });
});

// ================================================================== LibreOffice
const hasSoffice = (() => {
  try {
    return spawnSync('soffice', ['--version'], { timeout: 30000 }).status === 0;
  } catch {
    return false;
  }
})();

describe('LibreOffice opens the RTF we write', () => {
  it.skipIf(!hasSoffice)('reads the text, headings, lists, tables, page setup and breaks', async () => {
    const cell = (type, text, attrs = {}) => ({ type, attrs, content: [p(t(text))] });
    const json = pmDoc(
      { type: 'heading', attrs: { level: 1 }, content: [t('Report “2026”')] },
      p(t('Body with '), t('bold', [mark('bold')]), t(' and Ωmega 😀.')),
      { type: 'bulletList', content: [li(p(t('Apple'))), li(p(t('Banana')), { type: 'bulletList', content: [li(p(t('Nested')))] })] },
      { type: 'orderedList', attrs: { start: 3 }, content: [li(p(t('Third'))), li(p(t('Fourth')))] },
      { type: 'table', content: [
        { type: 'tableRow', content: [cell('tableHeader', 'Name'), cell('tableHeader', 'Value')] },
        { type: 'tableRow', content: [cell('tableCell', 'Alpha'), cell('tableCell', '1')] },
      ] },
      { type: 'pageBreak' },
      p(t('Second page '), t('link', [mark('link', { href: 'https://example.com/' })])),
    );
    const dir = mkdtempSync(join(tmpdir(), 'lw-rtf-'));
    try {
      writeFileSync(join(dir, 'doc.rtf'), jsonToRtf(json, { title: 'LO check', settings: { pageSize: 'a4', orientation: 'landscape', margins: { top: 96, right: 96, bottom: 96, left: 96 } } }));
      for (const format of ['txt:Text (encoded):UTF8', 'html', 'docx']) {
        const r = spawnSync('soffice', ['--headless', `-env:UserInstallation=file://${join(dir, 'profile')}`, '--convert-to', format, '--outdir', dir, join(dir, 'doc.rtf')], { timeout: 120000 });
        expect(r.status).toBe(0);
      }
      const text = readFileSync(join(dir, 'doc.txt'), 'utf8').replace(/^\uFEFF/, '');
      expect(text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)).toEqual([
        'Report “2026”', 'Body with bold and Ωmega 😀.', '• Apple', '• Banana', '◦ Nested', '3. Third', '4. Fourth', 'Name', 'Value', 'Alpha', '1', 'Second page link',
      ]);
      const out = readFileSync(join(dir, 'doc.html'), 'utf8');
      expect(out).toMatch(/<h1[^>]*>\s*Report “2026”<\/h1>/);
      expect(out).toMatch(/<ul>\s*<li>[\s\S]*Apple[\s\S]*<ul>[\s\S]*Nested[\s\S]*<\/ul>/);
      expect(out).toMatch(/<ol start="3">[\s\S]*Third[\s\S]*Fourth/);
      expect(out).toMatch(/<table[\s\S]*Name[\s\S]*Alpha[\s\S]*<\/table>/);
      expect(out).toMatch(/<a href="https:\/\/example.com\/">/);
      const zip = await JSZip.loadAsync(readFileSync(join(dir, 'doc.docx')));
      const xml = await zip.file('word/document.xml').async('string');
      expect(xml).toContain('<w:pStyle w:val="Heading1"/>');
      expect(xml).toMatch(/<w:br w:type="page"\/>|<w:pageBreakBefore\/>/);
      expect(xml).toMatch(/<w:pgSz w:orient="landscape" w:w="16838" w:h="11906"\/>/);
      expect(await zip.file('docProps/core.xml').async('string')).toContain('<dc:title>LO check</dc:title>');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300000);
});
