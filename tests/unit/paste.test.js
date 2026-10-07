import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { Editor } from '@tiptap/core';
import { buildExtensions } from '../../src/editor/create-editor.js';
import { rtfPictures, transformPastedHTML, lastPasteReport } from '../../src/io/paste.js';

// jsdom has no ClipboardEvent; ProseMirror's pasteHTML only needs the type.
globalThis.ClipboardEvent ||= class extends Event {
  constructor(type, init = {}) {
    super(type, init);
    this.clipboardData = init.clipboardData || null;
  }
};

const editors = [];
const paste = (html, content = '<p></p>') => {
  const e = new Editor({ element: document.createElement('div'), extensions: buildExtensions(), content });
  editors.push(e);
  e.commands.setTextSelection(1);
  e.view.pasteHTML(html);
  return e;
};
afterEach(() => editors.splice(0).forEach((e) => e.destroy()));
const fixture = (name) => readFileSync(`tests/fixtures/clipboard/${name}.html`, 'utf8');
const marksOn = (json, text) => {
  let found = null;
  const walk = (n) => {
    if (n.type === 'text' && n.text.includes(text)) found ??= n.marks || [];
    (n.content || []).forEach(walk);
  };
  walk(json);
  return found;
};
const types = (json) => json.content.map((n) => n.type);
const textOf = (n) => (n.text || '') + (n.content || []).map(textOf).join('');

describe('pasting from Google Docs', () => {
  const json = () => paste(fixture('google-docs')).getJSON();

  it('keeps structure: heading, lists with nesting, checklist, rule, page break, table, picture', () => {
    const j = json();
    expect(types(j)).toEqual(['heading', 'paragraph', 'paragraph', 'bulletList', 'orderedList', 'taskList', 'horizontalRule', 'paragraph', 'pageBreak', 'paragraph', 'table', 'paragraph']);
    expect(j.content[3].content[0].content.map((n) => n.type)).toEqual(['paragraph', 'bulletList']);
    expect(j.content[5].content.map((i) => [i.attrs.checked, textOf(i)])).toEqual([[true, 'Done task'], [false, 'Open task']]);
    // Docs' own strikethrough on ticked items isn't kept; the checkbox pictures are gone.
    expect(marksOn(j, 'Done task').map((m) => m.type)).not.toContain('strike');
    expect(JSON.stringify(j.content[5])).not.toContain('image');
  });

  it('keeps text formatting without restating the defaults', () => {
    const j = json();
    const m = (t) => marksOn(j, t).map((x) => x.type).sort();
    expect(m('Bold')).toContain('bold');
    expect(m('italic')).toContain('italic');
    expect(m('underlined')).toContain('underline');
    expect(m('struck')).toContain('strike');
    expect(marksOn(j, 'highlighted').find((x) => x.type === 'highlight').attrs.color).toMatch(/255, 255, 0|#ff0/);
    expect(marksOn(j, 'red').find((x) => x.type === 'textStyle').attrs.color).toMatch(/255, 0, 0|#ff0000/);
    expect(m('2').some((t) => t === 'subscript' || t === 'superscript')).toBe(true);
    const times = marksOn(j, 'Times 14').find((x) => x.type === 'textStyle').attrs;
    expect(times).toMatchObject({ fontSize: '14pt' });
    expect(times.fontFamily).toMatch(/Times New Roman/);
    // Black text and the 11pt default aren't written onto every run.
    const plain = marksOn(j, ', H').find((x) => x.type === 'textStyle')?.attrs || {};
    expect(plain.color || null).toBeNull();
    expect(plain.fontSize || null).toBeNull();
    // Sub/superscript aren't shrunk twice.
    expect(JSON.stringify(marksOn(j, '2'))).not.toContain('0.6em');
    // Heading text takes the heading style's look.
    expect(marksOn(j, 'Project Plan').find((x) => x.type === 'textStyle')?.attrs?.fontSize || null).toBeNull();
    expect(textOf(j.content[1])).toContain('a\ttab and  two spaces.');
  });

  it('unwraps Google redirect links and keeps alignment, table widths and shading', () => {
    const j = json();
    const link = marksOn(j, 'a centered link').find((x) => x.type === 'link');
    expect(link.attrs.href).toBe('https://example.com/page?a=1');
    expect(j.content[2].attrs.textAlign).toBe('center');
    const row = j.content[10].content[0].content;
    expect(row.map((c) => c.attrs.colwidth)).toEqual([[200], [100]]);
    expect(row[0].attrs.backgroundColor).toMatch(/207, 226, 243|#cfe2f3/);
    expect(j.content[10].content[1].content[0].attrs.colspan).toBe(2);
  });
});

describe('pasting from Word (desktop)', () => {
  it('keeps named styles, highlights, tabs, lists, tables with widths and page breaks', () => {
    const e = paste(fixture('word-desktop'));
    const j = e.getJSON();
    expect(j.content.slice(0, 3).map((n) => [n.type, n.attrs?.styleId ?? n.attrs?.level])).toEqual([['paragraph', 'title'], ['paragraph', 'subtitle'], ['heading', 1]]);
    expect(j.content.filter((n) => n.attrs?.styleId).map((n) => n.attrs.styleId)).toEqual(['title', 'subtitle', 'quote', 'intense-quote', 'no-spacing']);
    expect(marksOn(j, 'highlight').map((m) => m.type)).toContain('highlight');
    expect(textOf(j.content.find((n) => textOf(n).startsWith('Indented')))).toBe('Indented\tafter tab');
    const list = j.content.find((n) => n.type === 'bulletList');
    expect(list.content[0].content.map((n) => n.type)).toEqual(['paragraph', 'bulletList']);
    const table = j.content.find((n) => n.type === 'table');
    expect(table.content[0].content.map((c) => c.attrs.colwidth)).toEqual([[200], [100]]);
    expect(types(j)).toContain('pageBreak');
    // Footnote references don't link to anchors that don't exist here.
    const ref = j.content.find((n) => textOf(n).startsWith('Footnote ref'));
    expect(JSON.stringify(ref)).not.toContain('_ftn');
    expect(marksOn(ref, '1').map((m) => m.type)).toContain('superscript');
  });

  it('drops pictures Word left as local temp files, unless its RTF has them', () => {
    paste(fixture('word-desktop'));
    expect(lastPasteReport.droppedImages).toBe(1);
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==';
    const hex = [...atob(png)].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
    const rtf = `{\\rtf1{\\*\\shppict{\\pict{\\*\\picprop{\\sp{\\sn x}}}\\picw1\\pich1\\pngblip\n${hex}}}{\\nonshppict{\\pict\\wmetafile8 0102}}}`;
    expect(rtfPictures(rtf)).toEqual([`data:image/png;base64,${png}`]);
    const html = transformPastedHTML(fixture('word-desktop'), { rtf });
    expect(lastPasteReport.droppedImages).toBe(0);
    expect(html).toContain(`src="data:image/png;base64,${png}"`);
  });
});

describe('pasting from Word for the web', () => {
  it('rebuilds headings and the per-item lists, without stray spaces or internal font names', () => {
    const j = paste(fixture('word-online')).getJSON();
    expect(types(j).slice(0, 4)).toEqual(['heading', 'paragraph', 'bulletList', 'orderedList']);
    expect(j.content[1].attrs.textAlign).toBe('center');
    const ul = j.content[2];
    expect(ul.content.map(textOf)).toEqual(['Item oneNested item', 'Item two']);
    expect(ul.content[0].content.map((n) => n.type)).toEqual(['paragraph', 'bulletList']);
    expect(j.content[3].content.map(textOf)).toEqual(['Step one', 'Step two']);
    expect(textOf(j)).not.toContain(' ');
    expect(JSON.stringify(j)).not.toMatch(/EmbeddedFont|MSFontService/);
    expect(marksOn(j, 'italic underline').map((m) => m.type).sort()).toEqual(expect.arrayContaining(['italic', 'underline']));
  });
});

describe('pasting from LibreOffice and web pages', () => {
  it('reads <font>, align, background highlights, CSS page breaks and relative column widths', () => {
    const j = paste(fixture('libreoffice')).getJSON();
    expect(j.content[1].attrs.textAlign).toBe('center');
    const red = marksOn(j, 'Red bold serif');
    expect(red.map((m) => m.type)).toContain('bold');
    expect(red.find((m) => m.type === 'textStyle').attrs).toMatchObject({ fontSize: '14pt' });
    expect(red.find((m) => m.type === 'textStyle').attrs.color).toMatch(/201, 33, 30|#c9211e/);
    expect(marksOn(j, 'highlighted').map((m) => m.type)).toContain('highlight');
    expect(j.content.find((n) => textOf(n) === 'Right aligned').attrs.textAlign).toBe('right');
    expect(types(j)).toContain('pageBreak');
    const widths = j.content.find((n) => n.type === 'table').content[0].content.map((c) => c.attrs.colwidth?.[0]);
    expect(widths).toEqual([416, 208]);
  });

  it('keeps alignment from old HTML and drops unsafe links', () => {
    const j = paste(fixture('web-page')).getJSON();
    const para = (t) => j.content.find((n) => textOf(n).startsWith(t));
    expect(para('Old centered').attrs.textAlign).toBe('center');
    expect(para('Right by attribute').attrs.textAlign).toBe('right');
    expect(para('Justified div').attrs.textAlign).toBe('justify');
    expect(marksOn(j, 'Blue font tag').find((m) => m.type === 'textStyle').attrs.color).toBe('blue');
    expect(types(j)).toEqual(expect.arrayContaining(['blockquote', 'codeBlock']));
    expect(JSON.stringify(j)).not.toContain('javascript:');
  });
});

describe('pasting into an empty line', () => {
  it('takes the first pasted paragraph’s style and alignment, as Word does', () => {
    const j = paste('<p data-style="title" style="text-align:center">Title</p><p>Body</p>').getJSON();
    expect(j.content[0]).toMatchObject({ type: 'paragraph', attrs: { styleId: 'title', textAlign: 'center' } });
  });

  it('keeps the existing paragraph’s style when pasting into its text', () => {
    const e = new Editor({ element: document.createElement('div'), extensions: buildExtensions(), content: '<p style="text-align:right">abc</p>' });
    editors.push(e);
    e.commands.setTextSelection(4);
    e.view.pasteHTML('<p data-style="title">X</p><p>Y</p>');
    expect(e.getJSON().content[0].attrs).toMatchObject({ textAlign: 'right', styleId: null });
  });
});

describe('copying to other apps', () => {
  it('adds inline formatting, checkbox text and Word page breaks, and LibreWord strips them on paste', () => {
    const e = new Editor({
      element: document.createElement('div'),
      extensions: buildExtensions(),
      content: '<p data-style="title">Big</p><ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>done</p></li></ul><div data-page-break></div><p>after</p>',
    });
    editors.push(e);
    const serializer = e.view.someProp('clipboardSerializer');
    const holder = document.createElement('div');
    holder.append(serializer.serializeFragment(e.state.doc.content, { document }));
    const html = holder.innerHTML;
    expect(html).toMatch(/<p[^>]*style="font-size:28pt[^"]*"[^>]*>Big/);
    expect(html).toContain('☒ ');
    expect(html).toMatch(/<br[^>]*page-break-before:always/);
    // Pasted back into LibreWord (ProseMirror marks its own HTML with data-pm-slice).
    const own = html.replace('<p ', '<p data-pm-slice="0 0 []" ');
    const back = paste(own).getJSON();
    expect(types(back)).toEqual(['paragraph', 'taskList', 'pageBreak', 'paragraph']);
    expect(back.content[0].attrs.styleId).toBe('title');
    expect(textOf(back.content[1])).toBe('done');
    expect(back.content[1].content[0].attrs.checked).toBe(true);
  });
});
