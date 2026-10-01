import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export const searchKey = new PluginKey('search');

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
 * Find all matches in the document. Text is collected per textblock so
 * matches can span differently-formatted text nodes but never paragraphs.
 */
export function findMatches(doc, re) {
  const results = [];
  if (!re) return results;
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    let text = '';
    const map = []; // [textOffset, docPos] per text-ish chunk
    node.forEach((child, offset) => {
      const childPos = pos + 1 + offset;
      if (child.isText) {
        map.push([text.length, childPos, child.text.length]);
        text += child.text;
      } else {
        // Inline atoms (images, hard breaks) act as a separator character.
        map.push([text.length, childPos, 1]);
        text += '￼';
      }
    });
    const toDoc = (offset) => {
      for (let i = map.length - 1; i >= 0; i--) {
        if (offset >= map[i][0]) return map[i][1] + (offset - map[i][0]);
      }
      return pos + 1;
    };
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      results.push({ from: toDoc(m.index), to: toDoc(m.index + m[0].length), match: m });
      if (results.length > 10000) return false;
    }
    return false;
  });
  return results;
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
        const text = s.options.regex ? r.match[0].replace(buildRegExp(s.term, s.options), replacement) : replacement;
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
        if (dispatch) {
          const re = buildRegExp(s.term, s.options);
          for (let i = s.results.length - 1; i >= 0; i--) {
            const r = s.results[i];
            const text = s.options.regex ? r.match[0].replace(re, replacement) : replacement;
            const marks = state.doc.resolve(r.from).marksAcross(state.doc.resolve(r.to)) || [];
            if (text) tr.replaceWith(r.from, r.to, state.schema.text(text, marks));
            else tr.delete(r.from, r.to);
          }
          tr.setMeta(searchKey, { type: 'refresh', from: 0 });
          dispatch(tr);
        }
        return s.results.length;
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
