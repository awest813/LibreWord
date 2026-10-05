import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import { AllSelection } from '@tiptap/pm/state';
import { buildExtensions } from '../../src/editor/create-editor.js';
import { MAX_RESULTS, expandReplacement } from '../../src/editor/search.js';
import { commentRanges } from '../../src/editor/comments.js';

const t = (text, marks) => ({ type: 'text', text, ...(marks ? { marks } : {}) });
const p = (...content) => ({ type: 'paragraph', content });
const doc = (...content) => ({ type: 'doc', content });

const editors = [];
const mk = (content) => {
  const e = new Editor({ element: document.createElement('div'), extensions: buildExtensions(), content });
  editors.push(e);
  return e;
};
afterEach(() => editors.splice(0).forEach((e) => e.destroy()));

// What String#replace puts in place of the match (the text around it is left as is).
const nativeReplacement = (input, re, r, m) => {
  const out = input.replace(re, r);
  return out.slice(m.index, out.length - (input.length - m.index - m[0].length));
};

const selectAllText = (e) => e.commands.setTextSelection({ from: 1, to: e.state.doc.content.size - 1 });
const keydown = (e, init) => {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  return Boolean(e.view.someProp('handleKeyDown', (f) => f(e.view, event)));
};

describe('search and replace', () => {
  it('expands $ patterns like String#replace', () => {
    const input = '> John Smith <';
    const re = /(\w+) (?<last>\w+)/;
    const m = re.exec(input);
    for (const r of ['$2, $1', '$<last>!', '[$&] $$ $` $\' $3 $10 $01 $0 $<none>']) {
      expect(expandReplacement(m, r)).toBe(nativeReplacement(input, re, r, m));
    }
  });

  it('keeps lookaround context when replacing regex matches', () => {
    const e = mk(doc(p(t('foobar foobaz'))));
    e.commands.setSearch('foo(?=bar)', { regex: true });
    expect(e.commands.replaceAll('X')).toBe(1);
    expect(e.state.doc.textContent).toBe('Xbar foobaz');

    const e2 = mk(doc(p(t('price $5'))));
    e2.commands.setSearch('(?<=\\$)\\d', { regex: true });
    e2.commands.replaceCurrent('9');
    expect(e2.state.doc.textContent).toBe('price $9');

    const e3 = mk(doc(p(t('John Smith'))));
    e3.commands.setSearch('(\\w+) (\\w+)', { regex: true });
    e3.commands.replaceAll('$2, $1');
    expect(e3.state.doc.textContent).toBe('Smith, John');
  });

  it('never matches across hard breaks or images, so replacing cannot delete them', () => {
    const e = mk(doc(p(t('a'), { type: 'hardBreak' }, t('b')), p(t('a'), { type: 'image', attrs: { src: 'x.png' } }, t('b a b'))));
    e.commands.setSearch('a.b', { regex: true });
    e.commands.replaceAll('z');
    const json = e.getJSON();
    expect(json.content[0].content.map((n) => n.type)).toEqual(['text', 'hardBreak', 'text']);
    expect(json.content[1].content.map((n) => n.type)).toEqual(['text', 'image', 'text']);
    expect(e.state.doc.textContent).toBe('abab z');
  });

  it('replaces every match, not just the highlighted ones', () => {
    const per = 20;
    const count = Math.ceil((MAX_RESULTS + 10) / per);
    const e = mk(doc(...Array.from({ length: count }, () => p(t('a '.repeat(per).trim())))));
    e.commands.setSearch('a');
    expect(e.commands.replaceAll('b')).toBe(count * per);
    expect(e.state.doc.textContent).not.toContain('a');

    // Each match keeps its own formatting, and so does the text between matches.
    const bold = [{ type: 'bold' }];
    const e2 = mk(doc(p(t('x '), t('a', bold), t(' y a')), p(t('a'))));
    e2.commands.setSearch('a');
    expect(e2.commands.replaceAll('bc')).toBe(3);
    expect(e2.getJSON().content.map((n) => n.content)).toEqual([[t('x '), t('bc', bold), t(' y bc')], [t('bc')]]);
  });
});

describe('change case', () => {
  it('treats formatting boundaries as part of the same word', () => {
    const e = mk(doc(p(t('hel'), t('lo', [{ type: 'bold' }]), t(' world'))));
    selectAllText(e);
    e.commands.changeCase('title');
    expect(e.state.doc.textContent).toBe('Hello World');
    expect(e.getJSON().content[0].content[1]).toEqual(t('lo', [{ type: 'bold' }]));

    const e2 = mk(doc(p(t('the cat '), t('sat', [{ type: 'italic' }]), t(' down. it ran')), p(t('next one'))));
    selectAllText(e2);
    e2.commands.changeCase('sentence');
    expect(e2.state.doc.textBetween(0, e2.state.doc.content.size, '|')).toBe('The cat sat down. It ran|Next one');
  });
});

describe('comments', () => {
  it('leaves a valid caret after commenting a whole-document selection', () => {
    const e = mk(doc(p(t('one')), { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [p(t('x'))] }] }] }));
    e.view.dispatch(e.state.tr.setSelection(new AllSelection(e.state.doc)));
    expect(e.commands.setComment('c1')).toBe(true);
    expect(e.state.selection.$from.parent.inlineContent).toBe(true);
    expect(commentRanges(e.state.doc).get('c1')).toBeTruthy();
  });

  it('drops pasted copies of anchors that are still in the document, keeps cut ones', () => {
    const c1 = [{ type: 'comment', attrs: { id: 'c1' } }];
    const html = '<p><span data-comment-id="c1">bb</span></p>';

    const e = mk(doc(p(t('aa'), t('bb', c1), t(' text')), p(t('end'))));
    e.commands.setTextSelection(e.state.doc.content.size - 1);
    e.view.pasteHTML(html, new Event('paste'));
    expect(e.state.doc.textContent).toBe('aabb textendbb');
    expect(commentRanges(e.state.doc).get('c1')).toEqual({ from: 3, to: 5 });

    // Cut: the original anchor is gone by the time the text is pasted.
    const e2 = mk(doc(p(t('aa'), t('bb', c1), t(' text')), p(t('end'))));
    e2.commands.deleteRange({ from: 3, to: 5 });
    e2.commands.setTextSelection(e2.state.doc.content.size - 1);
    e2.view.pasteHTML(html, new Event('paste'));
    const r = commentRanges(e2.state.doc).get('c1');
    expect(r && e2.state.doc.textBetween(r.from, r.to)).toBe('bb');
  });

  it('drops pasted anchors for comments this document does not have', () => {
    const e = new Editor({ element: document.createElement('div'), extensions: buildExtensions({ isKnownComment: (id) => id === 'c1' }), content: '<p>x</p>' });
    editors.push(e);
    e.commands.setTextSelection(2);
    e.view.pasteHTML('<p><span data-comment-id="c1">aa</span><span data-comment-id="c9">bb</span></p>', new Event('paste'));
    const ranges = commentRanges(e.state.doc);
    expect(ranges.has('c1')).toBe(true);
    expect(ranges.has('c9')).toBe(false);
    expect(e.state.doc.textContent).toBe('xaabb');
  });
});

describe('font size', () => {
  it('grows sizes in units other than pt/px from the rendered size', () => {
    for (const size of ['x-large', '1.5em', '120%']) {
      const e = mk(`<p><span style="font-size: ${size}">abc</span></p>`);
      e.commands.setTextSelection({ from: 1, to: 4 });
      e.commands.growFont();
      const next = e.getAttributes('textStyle').fontSize;
      expect(next).toMatch(/^\d+(\.\d+)?pt$/);
      expect(parseFloat(next)).toBeGreaterThan(8);
    }
    const e = mk('<p><span style="font-size: 24px">abc</span></p>');
    e.commands.setTextSelection({ from: 1, to: 4 });
    e.commands.growFont();
    expect(e.getAttributes('textStyle').fontSize).toBe('20pt');
  });
});

describe('keyboard', () => {
  it('keeps Tab in the editor in the first list item', () => {
    const e = mk(doc({ type: 'bulletList', content: [{ type: 'listItem', content: [p(t('one'))] }] }));
    e.commands.setTextSelection(3);
    expect(keydown(e, { key: 'Tab' })).toBe(true);
  });
});
