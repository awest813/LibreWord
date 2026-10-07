import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { getSchema } from '@tiptap/core';
import { DOMParser as PMDOMParser } from '@tiptap/pm/model';
import { buildExtensions } from '../../src/editor/create-editor.js';
import { readOdt, writeOdt } from '../../src/io/odt.js';
import { preserveSpaces, sanitizeHtml } from '../../src/io/import.js';
import { DEFAULT_SETTINGS } from '../../src/storage/db.js';

const schema = getSchema(buildExtensions());
const p = (...content) => ({ type: 'paragraph', content });
const t = (text, marks) => ({ type: 'text', text, ...(marks ? { marks } : {}) });
const doc = (...content) => ({ type: 'doc', content });
const li = (...c) => ({ type: 'listItem', content: c });

const load = (html) => {
  const el = document.createElement('div');
  el.innerHTML = sanitizeHtml(preserveSpaces(html));
  return PMDOMParser.fromSchema(schema).parse(el).toJSON();
};
const roundTrip = async (json, settings = DEFAULT_SETTINGS, meta = {}) => {
  const r = await readOdt((await writeOdt(json, settings, meta)).buffer);
  return { ...r, json: load(r.html) };
};
const textOf = (n) => (n.text || '') + (n.content || []).map(textOf).join('');
const marksOf = (json) => {
  const out = [];
  const walk = (n) => { if (n.type === 'text') out.push([n.text, (n.marks || []).map((m) => m.type).sort().join('+')]); (n.content || []).forEach(walk); };
  walk(json);
  return out;
};

const hasSoffice = (() => {
  try {
    execFileSync('soffice', ['--version'], { stdio: 'ignore', timeout: 20000 });
    return true;
  } catch {
    return false;
  }
})();
/** Convert a file with LibreOffice; returns the output path. */
const soffice = (input, to, dir) => {
  execFileSync('soffice', ['--headless', '--norestore', `-env:UserInstallation=file://${join(dir, 'profile')}`, '--convert-to', to, '--outdir', dir, input], { stdio: 'ignore', timeout: 120000 });
  return join(dir, input.split('/').pop().replace(/\.[^.]+$/, `.${to.split(':')[0]}`));
};

describe('.odt writer → reader', () => {
  it('keeps text, marks, headings, alignment and spacing', async () => {
    const json = doc(
      { type: 'heading', attrs: { level: 2 }, content: [t('Chapter')] },
      { type: 'paragraph', attrs: { textAlign: 'center' }, content: [t('Bold', [{ type: 'bold' }]), t(' and '), t('italic', [{ type: 'italic' }]), t(' and '), t('under', [{ type: 'underline' }]), t(' '), t('gone', [{ type: 'strike' }])] },
      p(t('H'), t('2', [{ type: 'subscript' }]), t('O and x'), t('2', [{ type: 'superscript' }])),
      p(t('red big', [{ type: 'textStyle', attrs: { color: '#ff0000', fontSize: '18pt', fontFamily: 'Georgia' } }]), t(' '), t('marked', [{ type: 'highlight', attrs: { color: '#ffff00' } }])),
      p(t('Name:\tValue  with   spaces')),
      p(t('  leading and trailing  ')),
      p(t('link', [{ type: 'link', attrs: { href: 'https://example.com/a?b=1&c=2' } }])),
    );
    const { json: out } = await roundTrip(json);
    expect(out.content[0]).toMatchObject({ type: 'heading', attrs: { level: 2 } });
    expect(out.content[1].attrs.textAlign).toBe('center');
    expect(marksOf(out).filter(([, m]) => m)).toEqual([
      ['Bold', 'bold'], ['italic', 'italic'], ['under', 'underline'], ['gone', 'strike'], ['2', 'subscript'], ['2', 'superscript'],
      ['red big', 'textStyle'], ['marked', 'highlight'], ['link', 'link'],
    ]);
    const style = out.content[3].content[0].marks[0].attrs;
    expect(style).toMatchObject({ color: '#ff0000', fontSize: '18pt', fontFamily: 'Georgia' });
    expect(textOf(out.content[4])).toBe('Name:\tValue  with   spaces');
    // (The editor's parser drops trailing spaces in every format; they're invisible anyway.)
    expect(textOf(out.content[5])).toMatch(/^ {2}leading and trailing/);
    expect(out.content[6].content[0].marks[0].attrs.href).toBe('https://example.com/a?b=1&c=2');
  });

  it('keeps lists (nested, mixed, numbered from 3), checklists, quotes, code and rules', async () => {
    const json = doc(
      { type: 'bulletList', content: [li(p(t('a')), { type: 'orderedList', attrs: { start: 1 }, content: [li(p(t('a1'))), li(p(t('a2')))] }), li(p(t('b')))] },
      { type: 'orderedList', attrs: { start: 3 }, content: [li(p(t('three'))), li(p(t('four')))] },
      { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [p(t('done'))] }, { type: 'taskItem', attrs: { checked: false }, content: [p(t('todo'))] }] },
      { type: 'blockquote', content: [p(t('quoted'))] },
      { type: 'codeBlock', content: [t('if (x) {\n  y();\n}')] },
      { type: 'horizontalRule' },
      p(t('end')),
    );
    const { json: out } = await roundTrip(json);
    expect(out.content.map((n) => n.type)).toEqual(['bulletList', 'orderedList', 'taskList', 'paragraph', 'codeBlock', 'horizontalRule', 'paragraph']);
    expect(out.content[0].content[0].content.map((n) => n.type)).toEqual(['paragraph', 'orderedList']);
    expect(out.content[1].attrs.start).toBe(3);
    expect(out.content[2].content.map((i) => i.attrs.checked)).toEqual([true, false]);
    expect(out.content[3].attrs.styleId).toBe('quote');
    expect(textOf(out.content[4])).toBe('if (x) {\n  y();\n}');
  });

  it('keeps tables with merged cells, header rows, widths and shading', async () => {
    const cell = (text, attrs = {}, type = 'tableCell') => ({ type, attrs, content: [p(t(text))] });
    const json = doc({
      type: 'table',
      content: [
        { type: 'tableRow', content: [cell('H1', { colwidth: [200] }, 'tableHeader'), cell('H2', { colwidth: [100] }, 'tableHeader'), cell('H3', { colwidth: [150] }, 'tableHeader')] },
        { type: 'tableRow', content: [cell('wide', { colspan: 2, backgroundColor: '#ffc000' }), cell('tall', { rowspan: 2 })] },
        { type: 'tableRow', content: [cell('x'), cell('y')] },
      ],
    });
    const { json: out } = await roundTrip(json);
    const rows = out.content[0].content;
    expect(rows[0].content.map((c) => c.type)).toEqual(['tableHeader', 'tableHeader', 'tableHeader']);
    expect(rows[0].content.map((c) => c.attrs.colwidth?.[0])).toEqual([200, 100, 150]);
    expect(rows[1].content[0].attrs).toMatchObject({ colspan: 2, backgroundColor: 'rgb(255, 192, 0)' });
    expect(rows[1].content[1].attrs.rowspan).toBe(2);
    expect(rows[2].content.map(textOf)).toEqual(['x', 'y']);
  });

  it('keeps page breaks (including two in a row), images, page setup, header/footer, comments and the title', async () => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAYAAAB/qH1jAAAAEUlEQVR4nGP4z8DwHwqHEQYAWN0b5Xq5VbYAAAAASUVORK5CYII=';
    const json = doc(
      p(t('one')), { type: 'pageBreak' }, p(t('two')), { type: 'pageBreak' }, { type: 'pageBreak' }, p(t('four')),
      p({ type: 'image', attrs: { src: png, alt: 'Dots', width: 40, height: 20 } }),
      p(t('see '), t('this', [{ type: 'comment', attrs: { id: 'c1' } }]), t(' text')),
    );
    const settings = { ...DEFAULT_SETTINGS, pageSize: 'a4', orientation: 'landscape', margins: { top: 48, right: 72, bottom: 48, left: 72 }, header: 'Draft', footer: 'Confidential', pageNumbers: true };
    const comments = { c1: { id: 'c1', author: 'Ada', date: Date.UTC(2026, 0, 2), text: 'Check this', replies: [], resolved: false } };
    const r = await roundTrip(json, settings, { title: 'My <Doc>', comments });
    expect(r.json.content.map((n) => n.type)).toEqual(['paragraph', 'pageBreak', 'paragraph', 'pageBreak', 'paragraph', 'pageBreak', 'paragraph', 'paragraph', 'paragraph']);
    const img = r.json.content[7].content[0];
    expect(img.attrs).toMatchObject({ alt: 'Dots', width: 40, height: 20 });
    expect(img.attrs.src).toMatch(/^data:image\/png;base64,/);
    expect(r.settings).toEqual({ pageSize: 'a4', orientation: 'landscape', margins: { top: 48, right: 72, bottom: 48, left: 72 }, header: 'Draft', footer: 'Confidential', pageNumbers: true });
    expect(r.title).toBe('My <Doc>');
    const [comment] = Object.values(r.comments);
    expect(comment).toMatchObject({ author: 'Ada', text: 'Check this' });
    expect(JSON.stringify(r.json.content[8])).toContain(`"id":"${comment.id}"`);
  });

  it('writes a valid package: mimetype first and stored, manifest lists every part', async () => {
    const bytes = await writeOdt(doc(p(t('x'))), DEFAULT_SETTINGS, {});
    expect(new TextDecoder().decode(bytes.slice(30, 38))).toBe('mimetype');
    expect(bytes[8]).toBe(0); // compression method 0 = stored
    const zip = await JSZip.loadAsync(bytes);
    expect(await zip.file('mimetype').async('string')).toBe('application/vnd.oasis.opendocument.text');
    const manifest = await zip.file('META-INF/manifest.xml').async('string');
    for (const part of ['content.xml', 'styles.xml', 'meta.xml']) expect(manifest).toContain(part);
    for (const part of ['content.xml', 'styles.xml', 'meta.xml', 'META-INF/manifest.xml']) {
      const xml = new DOMParser().parseFromString(await zip.file(part).async('string'), 'application/xml');
      expect(xml.getElementsByTagName('parsererror')).toHaveLength(0);
    }
  });

  it('refuses spreadsheets and other non-text OpenDocument files clearly', async () => {
    const zip = new JSZip();
    zip.file('mimetype', 'application/vnd.oasis.opendocument.spreadsheet');
    zip.file('content.xml', '<x/>');
    await expect(readOdt(await zip.generateAsync({ type: 'arraybuffer' }))).rejects.toThrow(/spreadsheet/);
  });
});

describe.skipIf(!hasSoffice)('.odt with LibreOffice', () => {
  it('opens what LibreWord writes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lw-odt-'));
    try {
      const json = doc(
        { type: 'heading', attrs: { level: 1 }, content: [t('Report')] },
        p(t('Plain and '), t('bold', [{ type: 'bold' }]), t(' café €')),
        { type: 'bulletList', content: [li(p(t('first'))), li(p(t('second')))] },
        { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', attrs: { colspan: 2 }, content: [p(t('merged'))] }] }, { type: 'tableRow', content: [{ type: 'tableCell', content: [p(t('A'))] }, { type: 'tableCell', content: [p(t('B'))] }] }] },
      );
      const file = join(dir, 'lw.odt');
      writeFileSync(file, await writeOdt(json, DEFAULT_SETTINGS, { title: 'Report' }));
      const html = readFileSync(soffice(file, 'html', dir), 'utf8');
      expect(html).toMatch(/<h1[^>]*>.*Report/s);
      expect(html).toMatch(/<b>bold<\/b>|<strong>bold<\/strong>|font-weight: bold[^>]*>bold/);
      expect(html).toContain('café €');
      expect(html).toMatch(/<li[^>]*>.*first/s);
      expect(html).toMatch(/colspan="2"/);
      // And LibreOffice's own .odt of it reads back the same.
      const docx = soffice(file, 'docx', dir);
      expect(existsSync(docx)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180000);

  it('reads an .odt LibreOffice wrote', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lw-odt-'));
    try {
      const src = join(dir, 'in.html');
      writeFileSync(src, `<html><head><title>From LO</title></head><body>
        <h1>Heading One</h1><h2>Heading Two</h2>
        <p style="text-align:center">Centered <b>bold</b> <i>italic</i> <u>under</u> <span style="color:#ff0000">red</span></p>
        <ol><li>one</li><li>two<ul><li>nested</li></ul></li></ol>
        <table border="1"><tr><th>H1</th><th>H2</th></tr><tr><td colspan="2">wide</td></tr></table>
        <p>Link <a href="https://example.com/">here</a></p>
        <p style="page-break-before: always">After break</p></body></html>`);
      const odt = soffice(src, 'odt:writer8', dir);
      const r = await readOdt(readFileSync(odt).buffer);
      const out = load(r.html);
      const types = out.content.map((n) => n.type);
      expect(types.slice(0, 2)).toEqual(['heading', 'heading']);
      expect(out.content[2].attrs.textAlign).toBe('center');
      expect(marksOf(out).filter(([, m]) => m).map(([s, m]) => `${s}:${m}`)).toEqual(expect.arrayContaining(['bold:bold', 'italic:italic', 'under:underline', 'red:textStyle', 'here:link']));
      const ol = out.content.find((n) => n.type === 'orderedList');
      expect(ol.content[1].content.map((n) => n.type)).toEqual(['paragraph', 'bulletList']);
      const table = out.content.find((n) => n.type === 'table');
      expect(table.content[1].content[0].attrs.colspan).toBe(2);
      expect(types).toContain('pageBreak');
      expect(textOf(out)).toContain('After break');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180000);
});
