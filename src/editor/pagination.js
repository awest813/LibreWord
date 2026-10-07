import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

/**
 * Word-style pagination for a single ProseMirror document.
 *
 * The document is laid out as one continuous column the width of a page.
 * After every layout change we measure where each block *would* sit without
 * any page spacing (its "natural" position), then insert spacer widgets so
 * that nothing straddles a page boundary:
 *   - blocks that would cross the bottom margin are pushed to the next page;
 *   - paragraphs taller than the remaining space are split between lines;
 *   - lists, quotes and tables are split between items / rows;
 *   - explicit page breaks push the following block to a new page.
 *
 * Natural positions are recovered by subtracting the spacers that are
 * currently rendered, so a layout pass never needs to remove decorations
 * first and the result converges in a single pass.
 */

export const paginationKey = new PluginKey('pagination');

const EPS = 0.75;
const SPLITTABLE = new Set(['bulletList', 'orderedList', 'taskList', 'listItem', 'taskItem', 'blockquote', 'table']);

/*
 * Spacers come in three kinds:
 * - flow spacers (block or inline) push everything after them down;
 * - cell spacers ({ cell: { from, to } }) sit inside one cell of a table row
 *   that is split across pages, and only push that cell's own content down;
 * - row growth entries ({ growth: true }, never rendered) record how much
 *   taller such a row became, which is what pushes the content after it;
 * - repeated headers ({ header: { tablePos, rows, sig } }) are copies of a
 *   table's header rows shown above the first row on each later page.
 */
function headerWidgets(s) {
  const { tablePos, rows, sig } = s.header;
  return Array.from({ length: rows }, (_, i) => Decoration.widget(
    s.pos,
    (view) => {
      const wrap = view.nodeDOM(tablePos);
      const table = wrap?.nodeName === 'TABLE' ? wrap : wrap?.querySelector?.('table');
      const source = table ? [...table.querySelectorAll(':scope > tbody > tr, :scope > tr')][i] : null;
      const row = source ? source.cloneNode(true) : document.createElement('tr');
      row.querySelectorAll('.column-resize-handle').forEach((el) => el.remove());
      row.querySelectorAll('.selectedCell').forEach((el) => el.classList.remove('selectedCell'));
      row.classList.add('pm-repeat-header');
      row.setAttribute('contenteditable', 'false');
      row.setAttribute('aria-hidden', 'true');
      return row;
    },
    // After the filler spacer at the same position (side -1), before the row.
    { side: -1 + (i + 1) / (rows + 1), ignoreSelection: true, marks: [], key: `pgh:${s.pos}:${i}:${sig}` },
  ));
}

function buildDecorations(doc, spacers) {
  const shown = spacers.filter((s) => !s.growth);
  if (!shown.length) return DecorationSet.empty;
  const decos = shown.flatMap((s) => (s.header ? headerWidgets(s) : [
    Decoration.widget(
      s.pos,
      () => {
        const el = document.createElement(s.inline ? 'span' : 'div');
        el.className = s.inline ? 'pm-page-spacer pm-page-spacer-inline' : 'pm-page-spacer';
        el.style.height = `${s.height}px`;
        el.setAttribute('contenteditable', 'false');
        el.setAttribute('aria-hidden', 'true');
        return el;
      },
      { side: -1, ignoreSelection: true, marks: [], key: `pg:${s.pos}:${s.inline ? 'i' : 'b'}:${s.height.toFixed(1)}` },
    ),
  ]));
  return DecorationSet.create(doc, decos);
}

function sameSpacers(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].pos !== b[i].pos || a[i].inline !== b[i].inline || !a[i].growth !== !b[i].growth || Math.abs(a[i].height - b[i].height) > 0.5) return false;
    if (a[i].cell?.from !== b[i].cell?.from || a[i].cell?.to !== b[i].cell?.to) return false;
    if (a[i].header?.sig !== b[i].header?.sig || a[i].header?.tablePos !== b[i].header?.tablePos) return false;
  }
  return true;
}

/**
 * Compute spacer positions for the current DOM. Pure measurement — no DOM writes.
 *
 * With `dirty` ({ from, to } in document positions) only blocks from the
 * edited region onward are measured, and the pass stops as soon as a block
 * after the edit lands exactly where it did before — at that point every
 * later spacer is unchanged and is reused as-is. Typing therefore costs a
 * couple of block measurements regardless of document length.
 */
export function computeLayout(view, geometry, oldSpacers, { dirty = null, prevPageCount = 1, prevTops = null } = {}) {
  const root = view.dom;
  const rootRect = root.getBoundingClientRect();
  const scale = rootRect.width / geometry.width || 1;
  const toY = (clientY) => (clientY - rootRect.top) / scale;

  const { height: H, gap, margins } = geometry;
  const P = H + gap;
  const contentTop = (k) => k * P + margins.top;
  const contentBottom = (k) => k * P + H - margins.bottom;
  const contentHeight = H - margins.top - margins.bottom;
  const pageOf = (y) => Math.max(0, Math.floor((y + EPS) / P));

  // Prefix sums of the spacers currently in the DOM, for natural positions.
  // Cell spacers only affect positions inside their own cell, so they're kept apart.
  const oldFlow = oldSpacers.filter((s) => !s.cell);
  const oldCell = oldSpacers.filter((s) => s.cell);
  const oldPos = oldFlow.map((s) => s.pos);
  const oldSum = [0];
  for (const s of oldFlow) oldSum.push(oldSum[oldSum.length - 1] + s.height);
  const oldBefore = (pos) => flowBefore(pos) + (oldCell.length ? cellBefore(pos) : 0);
  const cellBefore = (pos) => {
    let sum = 0;
    for (const s of oldCell) if (s.pos <= pos && s.cell.from < pos && pos < s.cell.to) sum += s.height;
    return sum;
  };
  const flowBefore = (pos) => {
    let lo = 0;
    let hi = oldPos.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (oldPos[mid] <= pos) lo = mid + 1;
      else hi = mid;
    }
    return oldSum[lo];
  };

  const spacers = [];
  let shift = 0;
  let breakAfterPage = -1;
  let maxBottom = margins.top;
  let currentCell = null; // { from, to } while laying out a cell of a split table row
  let tableHeader = null; // the header rows of the table being laid out row by row

  /**
   * Move a block that doesn't fit to the top of the next page. A table's body
   * row there gets the table's header rows repeated above it, as in Word.
   * Returns the block's new top.
   */
  const toNextPage = (node, pos, anchor, top, k, height) => {
    addSpacer(anchor, contentTop(k + 1) - top);
    let next = contentTop(k + 1);
    const hd = tableHeader;
    if (hd && !currentCell && node.type.name === 'tableRow' && pos >= hd.bodyStart && hd.height + height <= contentHeight + EPS) {
      spacers.push({ pos: anchor, height: hd.height, inline: false, header: { tablePos: hd.tablePos, rows: hd.rows, sig: hd.sig } });
      shift += hd.height;
      next += hd.height;
    }
    return next;
  };

  /** Leading rows made only of header cells repeat on each page (Word's "repeat header rows"). */
  const headerOf = (table, pos) => {
    const isHeader = (row) => row.childCount > 0 && row.content.content.every((c) => c.type.name === 'tableHeader');
    let rows = 0;
    let end = pos + 1;
    while (rows < table.childCount && isHeader(table.child(rows))) end += table.child(rows++).nodeSize;
    if (!rows || rows >= table.childCount) return null;
    const first = view.nodeDOM(pos + 1);
    const last = view.nodeDOM(end - table.child(rows - 1).nodeSize);
    if (first?.nodeType !== 1 || last?.nodeType !== 1) return null;
    const height = (last.getBoundingClientRect().bottom - first.getBoundingClientRect().top) / scale - (oldBefore(end - 1) - oldBefore(pos + 1));
    // A header taller than half a page would leave little room for anything else.
    if (!(height > 0) || height > contentHeight / 2) return null;
    let sig = 0;
    const text = JSON.stringify(table.content.content.slice(0, rows).map((r) => r.toJSON()));
    for (let i = 0; i < text.length; i++) sig = (sig * 31 + text.charCodeAt(i)) | 0;
    return { tablePos: pos, bodyStart: end, rows, height, sig: (sig >>> 0).toString(36) };
  };

  const addSpacer = (pos, height, inline = false) => {
    if (height <= EPS) return;
    const last = spacers[spacers.length - 1];
    if (last && last.pos === pos && last.inline === inline && !last.growth && !last.header && (last.cell || null) === currentCell) last.height += height;
    else spacers.push(currentCell ? { pos, height, inline, cell: currentCell } : { pos, height, inline });
    shift += height;
  };

  const caret = (pos) => {
    try {
      return view.coordsAtPos(pos, 1);
    } catch {
      return null;
    }
  };
  const lineBottomAt = (pos) => {
    const c = caret(pos);
    return c ? toY(c.bottom) - oldBefore(pos) + shift : -Infinity;
  };
  const lineTopAt = (pos) => {
    const c = caret(pos);
    return c ? toY(c.top) - oldBefore(pos) + shift : -Infinity;
  };

  // First position in [from, to] whose line extends below `limit`, or -1.
  const firstPosBelow = (from, to, limit) => {
    if (lineBottomAt(to) <= limit + EPS) return -1;
    let lo = from;
    let hi = to;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (lineBottomAt(mid) > limit + EPS) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  };

  const splitTextblock = (node, pos, anchor, top, height, k) => {
    const start = pos + 1;
    const end = pos + node.nodeSize - 1;
    let bottom = top + height;
    let from = start;
    let page = k;
    for (let guard = 0; guard < 500 && bottom > contentBottom(page) + EPS; guard++) {
      const q = firstPosBelow(from, end, contentBottom(page));
      if (q < 0) break;
      const lineTop = lineTopAt(q);
      // Orphan control: never leave just the first line at the bottom of a page.
      const firstLineBottom = lineBottomAt(start);
      const onlyFirstLineFits = from === start && lineTop <= firstLineBottom + EPS;
      if (q <= start || onlyFirstLineFits) {
        if (from === start && top > contentTop(page) + EPS) {
          const s = contentTop(page + 1) - top;
          addSpacer(anchor, s);
          top += s;
          bottom += s;
          page += 1;
          continue;
        }
        if (q <= from) break; // a single line taller than the page — let it overflow
      }
      const s = contentTop(page + 1) - lineTop;
      if (s <= EPS) break;
      addSpacer(q, s, true);
      bottom += s;
      page += 1;
      from = q + 1;
    }
    return bottom;
  };

  const layoutNode = (node, pos, anchor) => {
    const dom = view.nodeDOM(pos);
    if (!dom || dom.nodeType !== 1) return;
    const rect = dom.getBoundingClientRect();
    const end = pos + node.nodeSize;
    let top = toY(rect.top) - oldBefore(pos) + shift;
    const height = rect.height / scale - (oldBefore(end - 1) - oldBefore(pos));

    if (node.type.name === 'pageBreak') {
      // Each further break in a row adds a blank page, as in Word (and the .docx export).
      breakAfterPage = breakAfterPage >= 0 ? breakAfterPage + 1 : pageOf(top);
      return;
    }

    if (breakAfterPage >= 0) {
      const target = contentTop(breakAfterPage + 1);
      if (top < target - EPS) {
        addSpacer(anchor, target - top);
        top = target;
      }
      breakAfterPage = -1;
    }

    let k = pageOf(top);
    if (top > contentBottom(k) - EPS) {
      // Starts inside the bottom margin / page gap: move to the next page.
      top = toNextPage(node, pos, anchor, top, k, height);
      k += 1;
    }

    let bottom = top + height;
    if (bottom > contentBottom(k) + EPS) {
      if (SPLITTABLE.has(node.type.name) && node.childCount > 0) {
        const outerHeader = tableHeader;
        if (node.type.name === 'table') tableHeader = currentCell ? null : headerOf(node, pos);
        layoutChildren(node, pos + 1, anchor);
        tableHeader = outerHeader;
        return;
      }
      if (node.isTextblock && node.content.size > 0) {
        bottom = splitTextblock(node, pos, anchor, top, height, k);
      } else if (top > contentTop(k) + EPS && height <= contentHeight + EPS) {
        bottom = toNextPage(node, pos, anchor, top, k, height) + height;
      } else if (node.type.name === 'tableRow' && !currentCell) {
        // Taller than a page: break the row across pages, as Word does.
        bottom = splitRow(node, pos, top, height);
      }
    }
    if (bottom > maxBottom) maxBottom = bottom;
  };

  /**
   * Lay out each cell of a table row on its own, all starting at the row's
   * top, so a page break inside one cell doesn't move the others. The row
   * then ends below its tallest cell; that growth is what moves the content
   * after the row (rather than the sum of every cell's spacers).
   */
  const splitRow = (row, pos, top, height) => {
    const naturalBottom = top + height;
    const startShift = shift;
    const outerMax = maxBottom;
    let bottom = naturalBottom;
    row.forEach((cell, offset) => {
      const cellPos = pos + 1 + offset;
      currentCell = { from: cellPos, to: cellPos + cell.nodeSize };
      shift = startShift;
      maxBottom = -Infinity;
      layoutChildren(cell, cellPos + 1, null);
      if (maxBottom === -Infinity) return;
      // Below the last child: its bottom margin, then the cell's padding and border.
      const cellDom = view.nodeDOM(cellPos);
      const lastDom = cell.lastChild && view.nodeDOM(cellPos + cell.nodeSize - 1 - cell.lastChild.nodeSize);
      let trail = 0;
      if (cellDom?.nodeType === 1) {
        const cs = getComputedStyle(cellDom);
        trail += (parseFloat(cs.paddingBottom) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
      }
      if (lastDom?.nodeType === 1) trail += parseFloat(getComputedStyle(lastDom).marginBottom) || 0;
      bottom = Math.max(bottom, maxBottom + trail);
    });
    currentCell = null;
    maxBottom = outerMax;
    shift = startShift;
    const growth = bottom - naturalBottom;
    if (growth > EPS) {
      spacers.push({ pos: pos + row.nodeSize - 1, height: growth, growth: true });
      shift += growth;
    }
    return bottom;
  };

  const layoutChildren = (parent, contentStart, firstAnchor) => {
    let index = 0;
    parent.forEach((child, offset) => {
      const pos = contentStart + offset;
      layoutNode(child, pos, index === 0 && firstAnchor != null ? firstAnchor : pos);
      index += 1;
    });
  };

  const doc = view.state.doc;
  const offsets = [];
  doc.forEach((_child, offset) => offsets.push(offset));

  let startIndex = 0;
  if (dirty) {
    while (startIndex < offsets.length - 1 && offsets[startIndex] + doc.child(startIndex).nodeSize <= dirty.from) startIndex++;
    startIndex = Math.max(0, startIndex - 1);
    // A page break affects the block after it, so never start right after one.
    while (startIndex > 0 && doc.child(startIndex - 1).type.name === 'pageBreak') startIndex--;
    const startPos = offsets[startIndex] ?? 0;
    for (const s of oldSpacers) {
      if (s.pos >= startPos) break;
      spacers.push({ ...s });
      if (!s.cell) shift += s.height;
    }
  }

  // Where each top-level block started (before its own spacer) in this pass,
  // keyed by node identity: unchanged blocks keep the same node object.
  const tops = new Map();
  if (dirty && prevTops) {
    for (let i = 0; i < startIndex; i++) {
      const n = doc.child(i);
      if (prevTops.has(n)) tops.set(n, prevTops.get(n));
    }
  }

  let converged = false;
  for (let i = startIndex; i < offsets.length; i++) {
    const pos = offsets[i];
    const node = doc.child(i);
    const dom = view.nodeDOM(pos);
    const topBefore = dom && dom.nodeType === 1 ? toY(dom.getBoundingClientRect().top) - oldBefore(pos) + shift : null;
    // Converged: an untouched block starts exactly where it did last pass, so
    // it and everything after it will be laid out identically.
    if (
      dirty && prevTops && topBefore != null && i > startIndex && pos >= dirty.to && breakAfterPage < 0 &&
      prevTops.has(node) && Math.abs(prevTops.get(node) - topBefore) < 0.5
    ) {
      for (const s of oldSpacers) if (s.pos >= pos) spacers.push({ ...s });
      for (let j = i; j < offsets.length; j++) {
        const n = doc.child(j);
        if (prevTops.has(n)) tops.set(n, prevTops.get(n));
      }
      converged = true;
      break;
    }
    if (topBefore != null) {
      // The same node object can appear twice (e.g. pasted twice); never trust those.
      if (tops.has(node)) tops.set(node, NaN);
      else tops.set(node, topBefore);
    }
    layoutNode(node, pos, pos);
  }

  // A trailing page break starts a fresh (empty) page.
  if (breakAfterPage >= 0) maxBottom = Math.max(maxBottom, contentTop(breakAfterPage + 1));

  // At one position: block spacer, then repeated header, then inline spacer.
  const rank = (s) => (s.inline ? 2 : s.header ? 1 : 0);
  spacers.sort((a, b) => a.pos - b.pos || rank(a) - rank(b));
  const pageCount = converged ? prevPageCount : Math.max(1, pageOf(maxBottom - EPS * 2) + 1);
  return { spacers, pageCount, scale, tops };
}

/** Union of the document ranges a transaction touched (in post-transaction positions). */
export function mergeDirty(prev, tr) {
  if (prev === 'all') return 'all';
  let from = Infinity;
  let to = -Infinity;
  const maps = tr.mapping.maps;
  const mapThrough = (pos, i, assoc) => {
    let p = pos;
    for (let k = i + 1; k < maps.length; k++) p = maps[k].map(p, assoc);
    return p;
  };
  tr.steps.forEach((step, i) => {
    let touched = false;
    maps[i].forEach((_os, _oe, ns, ne) => {
      touched = true;
      from = Math.min(from, mapThrough(ns, i, -1));
      to = Math.max(to, mapThrough(ne, i, 1));
    });
    if (!touched) {
      // Mark and attribute steps don't move positions but can change heights.
      const a = step.from ?? step.pos;
      const b = step.to ?? (step.pos != null ? step.pos + 1 : undefined);
      if (a == null || b == null) {
        from = -1;
        return;
      }
      from = Math.min(from, mapThrough(a, i, -1));
      to = Math.max(to, mapThrough(b, i, 1));
    }
  });
  if (from === -1) return 'all';
  if (prev) {
    from = Math.min(from, tr.mapping.map(prev.from, -1));
    to = Math.max(to, tr.mapping.map(prev.to, 1));
  }
  if (from === Infinity) return prev;
  return { from: Math.max(0, from), to };
}

export const Pagination = Extension.create({
  name: 'pagination',

  addOptions() {
    return {
      /** () => geometry from pageGeometry(), or null to disable pagination */
      getGeometry: () => null,
      /** Called with { pageCount } after every layout pass. */
      onLayout: () => {},
    };
  },

  addStorage() {
    return { pageCount: 1 };
  },

  addCommands() {
    return {
      repaginate: () => ({ editor }) => {
        editor.storage.pagination.schedule?.();
        return true;
      },
    };
  },

  addProseMirrorPlugins() {
    const ext = this;
    return [
      new Plugin({
        key: paginationKey,
        state: {
          init: () => ({ spacers: [], decorations: DecorationSet.empty, dirty: null }),
          apply(tr, prev, _old, newState) {
            const meta = tr.getMeta(paginationKey);
            if (meta) {
              if (!meta.spacers) return { ...prev, dirty: null };
              return { spacers: meta.spacers, decorations: buildDecorations(newState.doc, meta.spacers), dirty: null };
            }
            if (!tr.docChanged) return prev;
            const spacers = [];
            for (const s of prev.spacers) {
              const r = tr.mapping.mapResult(s.pos, -1);
              if (r.deleted) continue;
              const cell = s.cell && { from: tr.mapping.map(s.cell.from, 1), to: tr.mapping.map(s.cell.to, -1) };
              const header = s.header && { ...s.header, tablePos: tr.mapping.map(s.header.tablePos, 1) };
              spacers.push({ ...s, pos: r.pos, ...(cell ? { cell } : {}), ...(header ? { header } : {}) });
            }
            return {
              spacers,
              decorations: prev.spacers.length ? prev.decorations.map(tr.mapping, tr.doc) : prev.decorations,
              dirty: mergeDirty(prev.dirty, tr),
            };
          },
        },
        props: {
          decorations(state) {
            return paginationKey.getState(state).decorations;
          },
        },
        view(view) {
          let frame = 0;
          let destroyed = false;
          let full = true;

          const run = () => {
            frame = 0;
            if (destroyed || !view.dom.isConnected) return;
            if (view.composing) {
              schedule();
              return;
            }
            const geometry = ext.options.getGeometry();
            const current = paginationKey.getState(view.state);
            if (!geometry) {
              full = true; // re-enabling pagination needs a complete pass
              if (current.spacers.length || current.dirty) view.dispatch(view.state.tr.setMeta(paginationKey, { spacers: [] }));
              ext.storage.pageCount = 1;
              ext.options.onLayout({ pageCount: 1 });
              return;
            }
            if (!full && !current.dirty) return;
            const dirty = full || current.dirty === 'all' ? null : current.dirty;
            full = false;
            const t0 = performance.now();
            const { spacers, pageCount, tops } = computeLayout(view, geometry, current.spacers, {
              dirty,
              prevPageCount: ext.storage.pageCount,
              prevTops: ext.storage.tops,
            });
            ext.storage.tops = tops;
            ext.storage.lastLayoutMs = performance.now() - t0;
            const tr = view.state.tr.setMeta('addToHistory', false);
            view.dispatch(tr.setMeta(paginationKey, sameSpacers(spacers, current.spacers) ? { spacers: null } : { spacers }));
            ext.storage.pageCount = pageCount;
            ext.options.onLayout({ pageCount });
          };

          const schedule = (forceFull = false) => {
            if (forceFull === true) full = true;
            if (!frame && !destroyed) frame = requestAnimationFrame(run);
          };
          const scheduleFull = () => schedule(true);
          ext.storage.schedule = scheduleFull;

          // Content can change height without a transaction (images loading,
          // web fonts swapping in, window resizes) — watch for that too.
          const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(scheduleFull) : null;
          ro?.observe(view.dom);
          document.fonts?.addEventListener?.('loadingdone', scheduleFull);
          view.dom.addEventListener('load', scheduleFull, true);

          scheduleFull();
          return {
            update(_view, prevState) {
              if (prevState.doc !== view.state.doc) schedule();
            },
            destroy() {
              destroyed = true;
              if (frame) cancelAnimationFrame(frame);
              ro?.disconnect();
              document.fonts?.removeEventListener?.('loadingdone', scheduleFull);
              view.dom.removeEventListener('load', scheduleFull, true);
              ext.storage.schedule = null;
            },
          };
        },
      }),
    ];
  },
});
