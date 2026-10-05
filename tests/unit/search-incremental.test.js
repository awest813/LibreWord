import { describe, it, expect, afterAll } from 'vitest';
import { Editor } from '@tiptap/core';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { buildExtensions } from '../../src/editor/create-editor.js';
import { MAX_RESULTS, buildRegExp, findMatches, searchKey } from '../../src/editor/search.js';

// Drive the search plugin on a bare EditorState: cheap enough for thousands of edits.
const editor = new Editor({ element: document.createElement('div'), extensions: buildExtensions() });
afterAll(() => editor.destroy());
const { schema } = editor;
const plugin = editor.state.plugins.find((pl) => pl.spec.key === searchKey);

const mulberry32 = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
};

const para = (text) => schema.nodes.paragraph.create(null, text ? schema.text(text) : null);

function textblockPositions(doc) {
  const out = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    out.push({ pos, node });
    return false;
  });
  return out;
}

/** One random edit (or a few in the same transaction). */
function randomEdit(state, rand) {
  const tr = state.tr;
  const steps = rand() < 0.2 ? 2 + Math.floor(rand() * 3) : 1;
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const word = () => Array.from({ length: 1 + Math.floor(rand() * 4) }, () => pick(['a', 'b', 'ab', 'A', ' ', 'x', 'ba'])).join('');
  for (let s = 0; s < steps; s++) {
    const blocks = textblockPositions(tr.doc);
    const { pos, node } = pick(blocks);
    const inside = pos + 1 + Math.floor(rand() * (node.content.size + 1));
    const kind = rand();
    try {
      if (kind < 0.3) {
        tr.insertText(word(), inside);
      } else if (kind < 0.45) {
        // Type inside an existing match when there is one.
        const matches = findMatches(tr.doc, /ab/gi);
        const m = matches.length ? pick(matches) : null;
        if (m) tr.insertText(pick(['a', 'b', 'x', ' ']), m.from + 1 + Math.floor(rand() * (m.to - m.from - 1)));
        else tr.insertText('ab', inside);
      } else if (kind < 0.6) {
        const end = Math.min(pos + node.nodeSize - 1, inside + 1 + Math.floor(rand() * 4));
        if (end > inside) tr.delete(inside, end);
      } else if (kind < 0.7) {
        tr.split(inside);
      } else if (kind < 0.8) {
        // Delete across a block boundary (joins paragraphs) or a whole paragraph.
        const size = tr.doc.content.size;
        const from = Math.max(1, inside - Math.floor(rand() * 6));
        const to = Math.min(size - 1, inside + Math.floor(rand() * 12));
        if (to > from && tr.doc.content.size - (to - from) > 4) tr.delete(from, to);
      } else if (kind < 0.85) {
        tr.insert(inside, schema.nodes.hardBreak.create());
      } else if (kind < 0.9) {
        tr.addMark(pos + 1, pos + node.nodeSize - 1, schema.marks.bold.create());
      } else if (kind < 0.95) {
        tr.setBlockType(pos + 1, pos + 1, rand() < 0.5 ? schema.nodes.heading : schema.nodes.paragraph, rand() < 0.5 ? { level: 2 } : null);
      } else {
        tr.insert(pos + node.nodeSize, para(word()));
      }
    } catch {
      // Some random edits don't fit the schema; skip them.
    }
  }
  const sel = Math.floor(rand() * (tr.doc.content.size + 1));
  try {
    tr.setSelection(TextSelection.near(tr.doc.resolve(sel)));
  } catch { /* keep the mapped selection */ }
  return tr;
}

function expectMatchesFullScan(state, preferredFrom = state.selection.from) {
  const s = searchKey.getState(state);
  const expected = findMatches(state.doc, buildRegExp(s.term, s.options));
  // Compared as strings: deep-equality diffs of 10k-element arrays are slow.
  const got = s.results.map((r) => `${r.from}-${r.to}`);
  expect(got.join()).toBe(expected.map((r) => `${r.from}-${r.to}`).join());
  // The stored exec() matches are still valid for $-replacements.
  expect(s.results.every((r) => state.doc.textBetween(r.from, r.to) === r.match[0])).toBe(true);
  let current = -1;
  if (expected.length) {
    current = expected.findIndex((r) => r.from >= preferredFrom);
    if (current < 0) current = 0;
  }
  expect(s.current).toBe(current);
  // One highlight per match, plus the current-match highlight.
  const decos = s.decorations.find().sort((a, b) => a.from - b.from || a.to - b.to);
  const plain = decos.filter((d) => d.type.attrs.class === 'search-match');
  expect(plain.map((d) => `${d.from}-${d.to}`).join()).toBe(got.join());
  const cur = decos.filter((d) => d.type.attrs.class === 'search-match-current');
  expect(cur.map((d) => `${d.from}-${d.to}`)).toEqual(current >= 0 ? [got[current]] : []);
}

function run({ seed, term, options = {}, paragraphs, edits }) {
  const rand = mulberry32(seed);
  const doc = schema.nodes.doc.create(null, paragraphs.map((text) => para(text)));
  let state = EditorState.create({ doc, plugins: [plugin] });
  state = state.apply(state.tr.setMeta(searchKey, { type: 'set', term, options, from: 0 }));
  let preferredFrom = 0;
  expectMatchesFullScan(state, preferredFrom);
  for (let i = 0; i < edits; i++) {
    const tr = randomEdit(state, rand);
    state = state.apply(tr);
    // The current match follows the cursor on edits; selection-only changes leave it alone.
    if (tr.docChanged) preferredFrom = state.selection.from;
    expectMatchesFullScan(state, preferredFrom);
  }
  return state;
}

const sampleParagraphs = (n, rand) => Array.from({ length: n }, (_, i) =>
  i % 7 === 3 ? '' : Array.from({ length: 3 + Math.floor(rand() * 8) }, () => ['ab', 'cab', 'xx', 'abab', 'b a', 'AB'][Math.floor(rand() * 6)]).join(' '));

describe('incremental search', () => {
  for (const [label, term, options] of [
    ['plain text', 'ab', {}],
    ['case sensitive', 'ab', { caseSensitive: true }],
    ['whole word', 'ab', { wholeWord: true }],
    ['regex', 'a+b?|ba', { regex: true }],
  ]) {
    it(`matches a full rescan after random edits (${label})`, () => {
      for (let seed = 1; seed <= 4; seed++) {
        run({ seed, term, options, paragraphs: sampleParagraphs(40, mulberry32(seed * 99)), edits: 150 });
      }
    });
  }

  it('matches a full rescan when results are capped at MAX_RESULTS', () => {
    // ~12k matches: edits near the start, the cut-off and the end all have to keep the first MAX_RESULTS.
    const line = Array.from({ length: 40 }, () => 'ab').join(' ');
    const paragraphs = Array.from({ length: 300 }, () => line);
    const state = run({ seed: 7, term: 'ab', paragraphs, edits: 80 });
    expect(searchKey.getState(state).results.length).toBe(MAX_RESULTS);
  }, 30000);

  it('refills results when edits drop the count below the cap', () => {
    const line = Array.from({ length: 40 }, () => 'ab').join(' ');
    const doc = schema.nodes.doc.create(null, Array.from({ length: 280 }, () => para(line)));
    let state = EditorState.create({ doc, plugins: [plugin] });
    state = state.apply(state.tr.setMeta(searchKey, { type: 'set', term: 'ab', options: {}, from: 0 }));
    expect(searchKey.getState(state).results.length).toBe(MAX_RESULTS);
    // Delete the first 20 paragraphs (800 matches) in one go; 400 more lay beyond the old cut-off.
    const end = textblockPositions(state.doc)[20].pos;
    state = state.apply(state.tr.delete(0, end));
    expectMatchesFullScan(state);
    expect(searchKey.getState(state).results.length).toBe(MAX_RESULTS);
    // And again, now below the cap.
    state = state.apply(state.tr.delete(0, textblockPositions(state.doc)[20].pos));
    expectMatchesFullScan(state);
    expect(searchKey.getState(state).results.length).toBe(9600);
  }, 30000);
});
