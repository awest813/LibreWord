import { Extension } from '@tiptap/core';
import { Fragment } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export const searchKey = new PluginKey('search');
export const MAX_RESULTS = 10000;

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function buildRegExp(term, { caseSensitive = false, wholeWord = false, regex = false } = {}) {
  if (!term) return null;
  let source = regex ? term : escapeRegExp(term);
  if (wholeWord) source = `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`;
  try {
    return new RegExp(source, `gu${caseSensitive ? '' : 'i'}`);
  } catch {
    return null;
  }
}

/**
 * Find all matches in the document. Text is collected per run of text nodes
 * so matches can span differently-formatted text but never paragraphs or
 * inline atoms (images, hard breaks) — replacing such a match would delete them.
 */
export function findMatches(doc, re, limit = MAX_RESULTS) {
  const results = [];
  if (!re) return results;
  let full = false;
  doc.descendants((node, pos) => {
    if (full) return false;
    if (!node.isTextblock) return true;
    let text = '';
    let start = pos + 1;
    const search = () => {
      re.lastIndex = 0;
      let m;
      while (!full && text && (m = re.exec(text))) {
        if (m[0].length === 0) {
          re.lastIndex++;
          continue;
        }
        results.push({ from: start + m.index, to: start + m.index + m[0].length, match: m });
        if (results.length >= limit) full = true;
      }
      text = '';
    };
    node.forEach((child, offset) => {
      if (child.isText) {
        if (!text) start = pos + 1 + offset;
        text += child.text;
      } else search();
    });
    search();
    return false;
  });
  return results;
}

/** Expand `$&`, `$1`, `$<name>`… in a replacement for a stored exec() match, like String#replace. */
export function expandReplacement(m, replacement) {
  const groups = m.length - 1;
  return replacement.replace(/\$(?:([$&`'])|(\d\d?)|<([^>]*)>)/g, (all, sym, num, name) => {
    if (sym === '$') return '$';
    if (sym === '&') return m[0];
    if (sym === '`') return m.input.slice(0, m.index);
    if (sym === "'") return m.input.slice(m.index + m[0].length);
    if (num) {
      if (num.length === 2 && +num >= 1 && +num <= groups) return m[+num] ?? '';
      const n = +num[0];
      if (n >= 1 && n <= groups) return (m[n] ?? '') + num.slice(1);
      return all;
    }
    if (!m.groups) return all;
    return m.groups[name] ?? '';
  });
}

const emptyState = { term: '', options: {}, results: [], current: -1, decorations: DecorationSet.empty };

function decorate(doc, results, current) {
  if (!results.length) return DecorationSet.empty;
  return DecorationSet.create(
    doc,
    results.map((r, i) => Decoration.inline(r.from, r.to, { class: i === current ? 'search-match search-match-current' : 'search-match' })),
  );
}

function recompute(doc, term, options, preferredFrom = 0) {
  const re = buildRegExp(term, options);
  const results = findMatches(doc, re);
  let current = -1;
  if (results.length) {
    current = results.findIndex((r) => r.from >= preferredFrom);
    if (current < 0) current = 0;
  }
  return { term, options, results, current, decorations: decorate(doc, results, current) };
}

export const Search = Extension.create({
  name: 'search',

  addStorage() {
    return { onChange: null };
  },

  addCommands() {
    const select = (tr, r) => tr.setSelection(TextSelection.create(tr.doc, r.from, r.to)).scrollIntoView();
    return {
      setSearch: (term, options = {}) => ({ state, tr, dispatch }) => {
        if (dispatch) dispatch(tr.setMeta(searchKey, { type: 'set', term, options, from: state.selection.from }));
        return true;
      },
      clearSearch: () => ({ tr, dispatch }) => {
        if (dispatch) dispatch(tr.setMeta(searchKey, { type: 'clear' }));
        return true;
      },
      findNext: () => ({ state, tr, dispatch }) => {
        const s = searchKey.getState(state);
        if (!s.results.length) return false;
        const sel = state.selection.to;
        let i = s.results.findIndex((r) => r.from >= sel);
        if (i < 0) i = 0;
        if (dispatch) dispatch(select(tr.setMeta(searchKey, { type: 'focus', index: i }), s.results[i]));
        return true;
      },
      findPrevious: () => ({ state, tr, dispatch }) => {
        const s = searchKey.getState(state);
        if (!s.results.length) return false;
        const sel = state.selection.from;
        let i = -1;
        for (let j = s.results.length - 1; j >= 0; j--) {
          if (s.results[j].to <= sel) { i = j; break; }
        }
        if (i < 0) i = s.results.length - 1;
        if (dispatch) dispatch(select(tr.setMeta(searchKey, { type: 'focus', index: i }), s.results[i]));
        return true;
      },
      replaceCurrent: (replacement) => ({ state, tr, dispatch }) => {
        const s = searchKey.getState(state);
        if (!s.results.length) return false;
        const r = s.results[s.current >= 0 ? s.current : 0];
        const text = s.options.regex ? expandReplacement(r.match, replacement) : replacement;
        if (dispatch) {
          const marks = state.doc.resolve(r.from).marksAcross(state.doc.resolve(r.to)) || [];
          if (text) tr.replaceWith(r.from, r.to, state.schema.text(text, marks));
          else tr.delete(r.from, r.to);
          tr.setMeta(searchKey, { type: 'refresh', from: r.from + text.length });
          dispatch(tr);
        }
        return true;
      },
      replaceAll: (replacement) => ({ state, tr, dispatch }) => {
        const s = searchKey.getState(state);
        if (!s.results.length) return false;
        // Highlighting stops at MAX_RESULTS; replacing must not.
        const results = findMatches(state.doc, buildRegExp(s.term, s.options), Infinity);
        if (dispatch) {
          // One step per paragraph rather than per match: some plugins' cost grows
          // with the number of steps squared, which froze the tab on large documents.
          for (let end = results.length; end > 0; ) {
            const $first = state.doc.resolve(results[end - 1].from);
            const start = $first.start();
            let i = end - 1;
            while (i > 0 && results[i - 1].from >= start) i--;
            const nodes = [];
            let cursor = results[i].from;
            for (const r of results.slice(i, end)) {
              $first.parent.content.cut(cursor - start, r.from - start).forEach((n) => nodes.push(n));
              const text = s.options.regex ? expandReplacement(r.match, replacement) : replacement;
              const marks = state.doc.resolve(r.from).marksAcross(state.doc.resolve(r.to)) || [];
              if (text) nodes.push(state.schema.text(text, marks));
              cursor = r.to;
            }
            tr.replaceWith(results[i].from, cursor, Fragment.fromArray(nodes));
            end = i;
          }
          tr.setMeta(searchKey, { type: 'refresh', from: 0 });
          dispatch(tr);
        }
        return results.length;
      },
    };
  },

  addProseMirrorPlugins() {
    const ext = this;
    return [
      new Plugin({
        key: searchKey,
        state: {
          init: () => emptyState,
          apply(tr, prev, _old, newState) {
            const meta = tr.getMeta(searchKey);
            if (meta?.type === 'clear') return emptyState;
            if (meta?.type === 'set') return recompute(newState.doc, meta.term, meta.options, meta.from);
            if (meta?.type === 'focus') {
              return { ...prev, current: meta.index, decorations: decorate(newState.doc, prev.results, meta.index) };
            }
            if (!prev.term) return prev;
            if (tr.docChanged || meta?.type === 'refresh') {
              return recompute(newState.doc, prev.term, prev.options, meta?.from ?? newState.selection.from);
            }
            return prev;
          },
        },
        props: {
          decorations: (state) => searchKey.getState(state).decorations,
        },
        view: () => ({
          update(view, prevState) {
            const s = searchKey.getState(view.state);
            if (s !== searchKey.getState(prevState)) ext.storage.onChange?.(s);
          },
        }),
      }),
    ];
  },
});
