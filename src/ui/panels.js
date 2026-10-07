import { h, debounce, escapeHtml } from './dom.js';
import { icon } from './icons.js';
import { searchKey, buildRegExp } from '../editor/search.js';
import { collectHeadings } from '../editor/toc.js';
import { TextSelection } from '@tiptap/pm/state';
import { PX_PER_IN, PX_PER_CM, usesInches } from '../editor/page-setup.js';
import { isDark } from './theme.js';

// ---------------------------------------------------------------------------
// Find & replace
// ---------------------------------------------------------------------------
export class FindPanel {
  constructor(app) {
    this.app = app;
    this.options = { caseSensitive: false, wholeWord: false, regex: false };
    this.findInput = h('input', { type: 'text', placeholder: 'Find in document', 'aria-label': 'Find', spellcheck: 'false' });
    this.replaceInput = h('input', { type: 'text', placeholder: 'Replace with', 'aria-label': 'Replace with', spellcheck: 'false' });
    this.count = h('span', { class: 'find-count', 'aria-live': 'polite' });

    const toggle = (key, ic, label) => {
      const b = h('button', { type: 'button', class: 'icon-btn', title: label, 'aria-label': label, 'aria-pressed': 'false', html: icon(ic) });
      b.addEventListener('click', () => {
        this.options[key] = !this.options[key];
        b.classList.toggle('is-active', this.options[key]);
        b.setAttribute('aria-pressed', String(this.options[key]));
        this.search();
      });
      return b;
    };
    const btn = (ic, label, fn) => h('button', { type: 'button', class: 'icon-btn', title: label, 'aria-label': label, html: icon(ic), onclick: fn });

    this.toggleReplaceBtn = btn('chevronRight', 'Toggle replace', () => this.setReplaceVisible(!this.replaceVisible));
    this.replaceRow = h(
      'div',
      { class: 'find-row' },
      h('span', { style: { width: '32px' } }),
      h('label', { class: 'find-input' }, this.replaceInput),
      h('button', { type: 'button', class: 'btn', onclick: () => this.replace() }, 'Replace'),
      h('button', { type: 'button', class: 'btn', onclick: () => this.replaceAll() }, 'All'),
    );
    this.el = h(
      'div',
      { class: 'find-panel', role: 'search', hidden: true },
      h(
        'div',
        { class: 'find-row' },
        this.toggleReplaceBtn,
        h('label', { class: 'find-input' }, this.findInput, toggle('caseSensitive', 'matchCase', 'Match case'), toggle('wholeWord', 'wholeWord', 'Whole words only'), toggle('regex', 'regex', 'Use regular expression')),
        this.count,
        btn('chevronUp', 'Previous match (Shift+Enter)', () => this.app.editor.commands.findPrevious()),
        btn('chevronDown', 'Next match (Enter)', () => this.app.editor.commands.findNext()),
        btn('close', 'Close (Esc)', () => this.close()),
      ),
      this.replaceRow,
    );

    const searchDebounced = debounce(() => this.search(), 120);
    this.findInput.addEventListener('input', searchDebounced);
    this.findInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        searchDebounced.cancel();
        if (searchKey.getState(this.app.editor.state).term !== this.findInput.value) this.search();
        if (e.shiftKey) this.app.editor.commands.findPrevious();
        else this.app.editor.commands.findNext();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      }
    });
    this.replaceInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) this.replaceAll();
        else this.replace();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      }
    });
    this.setReplaceVisible(false);
  }

  attach(editor) {
    editor.storage.search.onChange = (s) => this.renderCount(s);
  }

  get isOpen() {
    return !this.el.hidden;
  }

  setReplaceVisible(v) {
    this.replaceVisible = v;
    this.replaceRow.hidden = !v;
    this.toggleReplaceBtn.innerHTML = icon(v ? 'chevronDown' : 'chevronRight');
    this.toggleReplaceBtn.setAttribute('aria-expanded', String(v));
  }

  open({ replace = false, term } = {}) {
    this.el.hidden = false;
    this.setReplaceVisible(replace || this.replaceVisible);
    const { state } = this.app.editor;
    const selected = state.doc.textBetween(state.selection.from, state.selection.to, ' ');
    if (term != null) this.findInput.value = term;
    else if (selected && selected.length < 120 && !selected.includes('\n')) this.findInput.value = selected;
    this.search();
    if (replace && this.findInput.value) this.replaceInput.focus();
    else {
      this.findInput.focus();
      this.findInput.select();
    }
  }

  close() {
    this.el.hidden = true;
    this.app.editor.commands.clearSearch();
    this.app.editor.commands.focus();
  }

  search() {
    this.app.editor.commands.setSearch(this.findInput.value, { ...this.options });
  }

  renderCount(s) {
    if (!s.term) {
      this.count.textContent = '';
      this.count.classList.remove('no-results');
      return;
    }
    const n = s.results.length;
    const invalid = !n && s.options?.regex && !buildRegExp(s.term, s.options);
    this.count.textContent = n ? `${s.current + 1} of ${n}` : invalid ? 'Invalid pattern' : 'No results';
    this.count.classList.toggle('no-results', !n);
    this.app.nav?.renderResults(s);
  }

  replace() {
    const ed = this.app.editor;
    const s = searchKey.getState(ed.state);
    if (!s.results.length) return;
    const cur = s.results[s.current];
    // Replace only once the current match is selected (like Word), otherwise select it first.
    if (ed.state.selection.from !== cur.from || ed.state.selection.to !== cur.to) {
      ed.chain().setTextSelection({ from: cur.from, to: cur.to }).scrollIntoView().run();
      return;
    }
    // Like Word, stop once replacing wraps back around to where it started,
    // instead of going on to replace inside text it already replaced
    // ("cat" → "cats" would otherwise give "catss").
    const run = this.replaceRun;
    if (!run || run.doc !== ed.state.doc || run.term !== s.term) this.replaceRun = { origin: cur.from, wrapped: false, count: 0 };
    const r = this.replaceRun;
    const before = ed.state.doc.content.size;
    ed.commands.replaceCurrent(this.replaceInput.value);
    const delta = ed.state.doc.content.size - before;
    const end = cur.to + delta;
    if (r.wrapped && cur.from < r.origin) r.origin += delta;
    r.count++;
    const results = searchKey.getState(ed.state).results;
    let next = results.find((m) => m.from >= end);
    if (!next) {
      r.wrapped = true;
      next = results[0];
    }
    if (!next || (r.wrapped && next.from >= r.origin)) {
      ed.chain().setTextSelection(end).scrollIntoView().run();
      this.app.toast(`Done. Replaced ${r.count} occurrence${r.count === 1 ? '' : 's'}.`);
      this.replaceRun = null;
      return;
    }
    ed.commands.findNext();
    r.doc = ed.state.doc;
    r.term = s.term;
  }

  replaceAll() {
    let n = searchKey.getState(this.app.editor.state).results.length;
    // The command returns the real count, which can exceed the highlighted matches.
    if (n) n = Number(this.app.editor.commands.replaceAll(this.replaceInput.value)) || n;
    this.app.toast(n ? `Replaced ${n} occurrence${n === 1 ? '' : 's'}.` : 'Nothing to replace.');
  }
}

// ---------------------------------------------------------------------------
// Navigation pane (headings outline + search results)
// ---------------------------------------------------------------------------
export class NavPane {
  constructor(app) {
    this.app = app;
    this.input = h('input', { type: 'search', placeholder: 'Search document', 'aria-label': 'Search document' });
    this.list = h('div', { class: 'nav-list', role: 'tree', 'aria-label': 'Headings' });
    this.el = h(
      'aside',
      { class: 'nav-pane', hidden: true, 'aria-label': 'Navigation' },
      h('header', {}, h('span', {}, 'Navigation'), h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close navigation pane', html: icon('close'), onclick: () => app.toggleNav(false) })),
      h('label', { class: 'nav-search', html: icon('search') }, this.input),
      this.list,
    );
    this.input.addEventListener('input', debounce(() => {
      const term = this.input.value;
      if (term) this.app.editor.commands.setSearch(term, {});
      else {
        this.app.editor.commands.clearSearch();
        this.renderHeadings();
      }
    }, 150));
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.app.editor.commands[e.shiftKey ? 'findPrevious' : 'findNext']();
      }
    });
    this.refresh = debounce(() => this.render(), 200);
  }

  get visible() {
    return !this.el.hidden;
  }

  render() {
    if (!this.visible || !this.app.editor) return;
    const s = searchKey.getState(this.app.editor.state);
    if (this.input.value && s.term) this.renderResults(s);
    else this.renderHeadings();
  }

  renderHeadings() {
    if (!this.visible) return;
    const ed = this.app.editor;
    const headings = collectHeadings(ed.state.doc);
    this.list.replaceChildren();
    if (!headings.length) {
      this.list.append(h('div', { class: 'nav-empty' }, 'Create an interactive outline of your document by applying Heading styles to your headings.'));
      return;
    }
    const sel = ed.state.selection.from;
    let currentIdx = -1;
    headings.forEach((hd, i) => {
      if (hd.pos <= sel) currentIdx = i;
    });
    const min = Math.min(...headings.map((x) => x.level));
    headings.forEach((hd, i) => {
      const b = h('button', {
        type: 'button',
        class: `nav-item${i === currentIdx ? ' is-current' : ''}`,
        role: 'treeitem',
        style: { paddingLeft: `${8 + (hd.level - min) * 14}px`, fontWeight: hd.level === min ? '600' : '400' },
        title: hd.text,
      }, hd.text);
      b.addEventListener('click', () => this.app.goTo(hd.pos + 1));
      this.list.append(b);
    });
  }

  renderResults(s) {
    if (!this.visible || !this.input.value) return;
    const ed = this.app.editor;
    this.list.replaceChildren();
    if (!s.results.length) {
      this.list.append(h('div', { class: 'nav-empty' }, 'No results.'));
      return;
    }
    this.list.append(h('div', { class: 'nav-empty' }, `${s.results.length} result${s.results.length === 1 ? '' : 's'}`));
    for (const [i, r] of s.results.slice(0, 300).entries()) {
      const before = ed.state.doc.textBetween(Math.max(0, r.from - 40), r.from, ' ');
      const match = ed.state.doc.textBetween(r.from, r.to, ' ');
      const after = ed.state.doc.textBetween(r.to, Math.min(ed.state.doc.content.size, r.to + 60), ' ');
      const b = h('button', {
        type: 'button',
        class: `nav-item nav-result${i === s.current ? ' is-current' : ''}`,
        html: `…${escapeHtml(before.slice(-36))}<mark>${escapeHtml(match)}</mark>${escapeHtml(after.slice(0, 50))}`,
      });
      b.addEventListener('click', () => {
        ed.view.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, r.from, r.to)).setMeta(searchKey, { type: 'focus', index: i }).scrollIntoView());
        ed.view.focus();
      });
      this.list.append(b);
    }
  }
}

// ---------------------------------------------------------------------------
// Horizontal ruler with draggable margins and paragraph indent
// ---------------------------------------------------------------------------
export class Ruler {
  constructor(app) {
    this.app = app;
    this.canvas = h('canvas', { class: 'ruler-ticks', 'aria-hidden': 'true' });
    this.marginL = h('div', { class: 'ruler-margin' });
    this.marginR = h('div', { class: 'ruler-margin' });
    this.handleL = h('button', { type: 'button', class: 'ruler-handle', title: 'Left Margin', 'aria-label': 'Left margin', 'aria-keyshortcuts': 'ArrowLeft ArrowRight' });
    this.handleR = h('button', { type: 'button', class: 'ruler-handle', title: 'Right Margin', 'aria-label': 'Right margin', 'aria-keyshortcuts': 'ArrowLeft ArrowRight' });
    this.handleIndent = h('button', { type: 'button', class: 'ruler-handle indent', title: 'Left Indent', 'aria-label': 'Paragraph left indent', 'aria-keyshortcuts': 'ArrowLeft ArrowRight' });
    this.track = h('div', { class: 'ruler-track' }, this.marginL, this.marginR, this.canvas, this.handleL, this.handleR, this.handleIndent);
    this.el = h('div', { class: 'ruler' }, this.track);
    this.drag(this.handleL, 'left');
    this.drag(this.handleR, 'right');
    this.drag(this.handleIndent, 'indent');
  }

  /** New margins (or indent) after moving a handle `dx` page pixels from `start`, kept in range. */
  moved(kind, dx, start) {
    const g = this.app.geometry;
    if (kind === 'left') return { ...start.margins, left: Math.max(0, Math.min(g.width - start.margins.right - 72, start.margins.left + dx)) };
    if (kind === 'right') return { ...start.margins, right: Math.max(0, Math.min(g.width - start.margins.left - 72, start.margins.right - dx)) };
    return Math.max(0, Math.min(g.contentWidth - 48, start.indent + dx));
  }

  drag(handle, kind) {
    // Arrow keys nudge the handle one ruler step (Shift: four steps), like dragging.
    handle.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const snap = usesInches() ? PX_PER_IN / 16 : PX_PER_CM / 4;
      const dx = (e.key === 'ArrowLeft' ? -1 : 1) * snap * (e.shiftKey ? 4 : 1);
      const next = this.moved(kind, dx, { margins: { ...this.app.settings.margins }, indent: this.currentIndent() });
      if (kind === 'indent') this.app.editor.commands.setParagraphIndent({ indent: next });
      else this.app.updateSettings({ margins: next });
    });
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      handle.classList.add('is-dragging');
      const startX = e.clientX;
      const zoom = this.app.view.zoom;
      const start = { margins: { ...this.app.settings.margins }, indent: this.currentIndent() };
      const snap = usesInches() ? PX_PER_IN / 16 : PX_PER_CM / 4;
      let pending = null;
      let frame = 0;
      const flush = () => {
        frame = 0;
        if (!pending) return;
        const p = pending;
        pending = null;
        if (kind === 'indent') this.app.editor.commands.setParagraphIndent({ indent: p });
        else this.app.updateSettings({ margins: p }, { transient: true });
      };
      const move = (ev) => {
        pending = this.moved(kind, Math.round((ev.clientX - startX) / zoom / snap) * snap, start);
        if (!frame) frame = requestAnimationFrame(flush);
      };
      const up = () => {
        handle.classList.remove('is-dragging');
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        if (frame) cancelAnimationFrame(frame);
        flush();
        if (kind !== 'indent') this.app.updateSettings({ margins: { ...this.app.settings.margins } });
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
  }

  currentIndent() {
    const ed = this.app.editor;
    if (!ed) return 0;
    const attrs = ed.isActive('heading') ? ed.getAttributes('heading') : ed.getAttributes('paragraph');
    return attrs.indent || 0;
  }

  render() {
    const g = this.app.geometry;
    const z = this.app.view.zoom;
    const width = g.width * z;
    this.track.style.width = `${width}px`;
    this.marginL.style.cssText = `left:0;width:${g.margins.left * z}px`;
    this.marginR.style.cssText = `right:0;width:${g.margins.right * z}px`;
    this.handleL.style.left = `${g.margins.left * z}px`;
    this.handleR.style.left = `${(g.width - g.margins.right) * z}px`;
    this.updateIndent();

    const dpr = window.devicePixelRatio || 1;
    const hgt = 18;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = hgt * dpr;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${hgt}px`;
    const ctx = this.canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, hgt);
    const dark = isDark();
    ctx.strokeStyle = dark ? '#aaa' : '#666';
    ctx.fillStyle = dark ? '#ddd' : '#333';
    ctx.font = '10px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 1;
    const inches = usesInches();
    const unit = (inches ? PX_PER_IN : PX_PER_CM) * z;
    const sub = inches ? 8 : 4;
    const origin = g.margins.left * z;
    const start = -Math.floor(origin / unit) * sub;
    const end = Math.ceil((width - origin) / unit) * sub;
    ctx.beginPath();
    for (let i = start; i <= end; i++) {
      const x = Math.round(origin + (i / sub) * unit) + 0.5;
      if (x < 0 || x > width) continue;
      if (i % sub === 0) {
        if (i !== 0) ctx.fillText(String(Math.abs(i / sub)), x, hgt / 2);
      } else if (i % (sub / 2) === 0) {
        ctx.moveTo(x, 5);
        ctx.lineTo(x, hgt - 5);
      } else if (z >= 0.6) {
        ctx.moveTo(x, 7.5);
        ctx.lineTo(x, hgt - 7.5);
      }
    }
    ctx.stroke();
  }

  updateIndent() {
    const g = this.app.geometry;
    const z = this.app.view.zoom;
    this.handleIndent.style.left = `${(g.margins.left + this.currentIndent()) * z}px`;
  }
}
