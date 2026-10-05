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
 * Collect the matches in one textblock into `results`. Text is gathered per run
 * of text nodes so matches can span differently-formatted text but never
 * paragraphs or inline atoms (images, hard breaks) — replacing such a match
 * would delete them. Returns true once `limit` results have been collected.
 */
function scanTextblock(node, pos, re, results, limit) {
  let full = results.length >= limit;
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
  return full;
}

/** Find all matches in the document (or in the textblocks ending after `from`), in order, up to `limit`. */
export function findMatches(doc, re, limit = MAX_RESULTS, from = 0) {
  const results = [];
  if (!re) return results;
  let full = false;
  doc.nodesBetween(from, doc.content.size, (node, pos) => {
    if (full) return false;
    if (!node.isTextblock) return true;
    full = scanTextblock(node, pos, re, results, limit);
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

const emptyState = {
  term: '', options: {}, re: null, results: [], current: -1, matchDecos: DecorationSet.empty, decorations: DecorationSet.empty,
};

const matchDeco = (r) => Decoration.inline(r.from, r.to, { class: 'search-match' });

/** The current match is highlighted by a second decoration layered on its plain one (classes merge). */
function withCurrent(doc, matchDecos, results, current) {
  const r = results[current];
  return r ? matchDecos.add(doc, [Decoration.inline(r.from, r.to, { class: 'search-match-current' })]) : matchDecos;
}

/** Index of the first result at or after `pos` (wrapping to 0), or -1 without results. */
function currentAt(results, pos) {
  if (!results.length) return -1;
  let lo = 0;
  let hi = results.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (results[mid].from >= pos) hi = mid;
    else lo = mid + 1;
  }
  return lo < results.length ? lo : 0;
}

function recompute(doc, term, options, preferredFrom = 0) {
  const re = buildRegExp(term, options);
  const results = findMatches(doc, re);
  const current = currentAt(results, preferredFrom);
  const matchDecos = results.length ? DecorationSet.create(doc, results.map(matchDeco)) : DecorationSet.empty;
  return { term, options, re, results, current, matchDecos, decorations: withCurrent(doc, matchDecos, results, current) };
}

// Beyond these a transaction is treated like a new document and rescanned in full.
const MAX_INCREMENTAL_STEPS = 50;

/**
 * The textblocks of `tr.doc` touched by the transaction's steps, sorted, or
 * null when rescanning everything is about as cheap.
 */
function changedTextblocks(tr) {
  const { doc } = tr;
  const { maps } = tr.mapping;
  if (maps.length > MAX_INCREMENTAL_STEPS) return null;
  const blocks = new Map();
  let size = 0;
  for (let i = 0; i < maps.length; i++) {
    maps[i].forEach((_oldStart, _oldEnd, start, end) => {
      for (let j = i + 1; j < maps.length; j++) {
        start = maps[j].map(start, -1);
        end = maps[j].map(end, 1);
      }
      // One position of slack on each side catches the blocks on either side of a
      // change that sits exactly on a block boundary (joins, splits, deletions).
      doc.nodesBetween(Math.max(0, start - 1), Math.min(doc.content.size, end + 1), (node, pos) => {
        if (!node.isTextblock) return true;
        if (!blocks.has(pos)) {
          blocks.set(pos, node);
          size += node.nodeSize;
        }
        return false;
      });
    });
  }
  if (size > doc.content.size / 2) return null;
  return [...blocks].sort((a, b) => a[0] - b[0]).map(([pos, node]) => ({ from: pos, to: pos + node.nodeSize, node }));
}

/**
 * Update the results for a document change without rescanning the whole
 * document: map the old results through the change, rescan only the touched
 * textblocks and splice the two together. Produces the same results as
 * `recompute` (including the MAX_RESULTS cap) at a fraction of the cost.
 */
function update(prev, tr, preferredFrom) {
  const { doc, mapping } = tr;
  const { re } = prev;
  if (!re) return prev;
  const blocks = changedTextblocks(tr);
  if (!blocks) return recompute(doc, prev.term, prev.options, preferredFrom);

  // Old results outside the touched textblocks survive with mapped positions.
  const kept = [];
  for (let i = 0, b = 0; i < prev.results.length; i++) {
    const r = prev.results[i];
    const from = mapping.map(r.from, 1);
    const to = mapping.map(r.to, -1);
    if (to - from !== r.to - r.from) continue;
    while (b < blocks.length && blocks[b].to < from) b++;
    if (b < blocks.length && blocks[b].from <= from) continue;
    kept.push(from === r.from && to === r.to ? r : { from, to, match: r.match });
  }
  const fresh = [];
  for (const block of blocks) scanTextblock(block.node, block.from, re, fresh, Infinity);
  let results = [];
  for (let i = 0, j = 0; i < kept.length || j < fresh.length; ) {
    results.push(j >= fresh.length || (i < kept.length && kept[i].from < fresh[j].from) ? kept[i++] : fresh[j++]);
  }

  // Keep only the first MAX_RESULTS matches, as a full scan would.
  let cutFrom = Infinity; // decorations from here on are dropped
  let more = [];
  if (prev.results.length >= MAX_RESULTS) {
    // The old scan stopped at its last match; everything before it (mapped) is
    // known, the rest of the document was never searched.
    const known = mapping.map(prev.results[prev.results.length - 1].to, -1);
    let count = results.findIndex((r) => r.from >= known);
    if (count < 0) count = results.length;
    if (count >= MAX_RESULTS) {
      if (results.length > MAX_RESULTS) cutFrom = results[MAX_RESULTS].from;
    } else {
      // Too few known matches left: search on from the block where the old scan stopped.
      const $known = doc.resolve(known);
      cutFrom = $known.parent.isTextblock ? $known.before() : known;
      results = results.filter((r) => r.from < cutFrom);
      more = findMatches(doc, re, MAX_RESULTS - results.length, cutFrom);
      results = results.concat(more);
    }
  } else if (results.length > MAX_RESULTS) {
    cutFrom = results[MAX_RESULTS].from;
  }
  if (results.length > MAX_RESULTS) results = results.slice(0, MAX_RESULTS);

  // Decorations follow the same plan: map, drop the touched blocks, add the new matches.
  let matchDecos = prev.matchDecos.map(mapping, doc);
  const remove = [];
  for (const block of blocks) {
    for (const d of matchDecos.find(block.from, block.to)) if (d.from >= block.from && d.from <= block.to) remove.push(d);
  }
  if (cutFrom < Infinity) {
    for (const d of matchDecos.find(cutFrom, doc.content.size)) if (d.from >= cutFrom) remove.push(d);
  }
  if (remove.length) matchDecos = matchDecos.remove(remove);
  const added = fresh.filter((r) => r.from < cutFrom).concat(more);
  if (added.length) matchDecos = matchDecos.add(doc, added.map(matchDeco));

  const current = currentAt(results, preferredFrom);
  return { ...prev, results, current, matchDecos, decorations: withCurrent(doc, matchDecos, results, current) };
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
              return { ...prev, current: meta.index, decorations: withCurrent(newState.doc, prev.matchDecos, prev.results, meta.index) };
            }
            if (!prev.term) return prev;
            const preferredFrom = meta?.from ?? newState.selection.from;
            if (tr.docChanged) return update(prev, tr, preferredFrom);
            if (meta?.type === 'refresh') return recompute(newState.doc, prev.term, prev.options, preferredFrom);
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
