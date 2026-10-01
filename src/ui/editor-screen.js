import { TextSelection } from '@tiptap/pm/state';
import { createEditor } from '../editor/create-editor.js';
import { pageGeometry, PAGE_SIZES, PX_PER_IN, PX_PER_CM, PX_PER_PT, usesInches } from '../editor/page-setup.js';
import { getDoc, saveDoc } from '../storage/db.js';
import { exportDocument, printCss, printDocument } from '../io/export.js';
import { sanitizeHtml } from '../io/import.js';
import { h, toast, debounce, isPopoverOpen, closePopover } from './dom.js';
import { icon } from './icons.js';
import { Ribbon } from './ribbon.js';
import { FindPanel, NavPane, Ruler } from './panels.js';
import { openDialog, promptDialog } from './dialog.js';
import { openBackstage } from './backstage.js';
import { pickFile } from './start.js';

const VIEW_KEY = 'lw:view';
const loadView = () => {
  try {
    return JSON.parse(localStorage.getItem(VIEW_KEY)) || {};
  } catch {
    return {};
  }
};

const countWords = (text) => {
  const m = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’\-_.@]*/gu);
  return m ? m.length : 0;
};

const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('libreword') : null;
const TAB_ID = Math.random().toString(36).slice(2);

/** Downscale very large images before embedding them in the document. */
export async function imageFileToDataUrl(file, maxDim = 2000) {
  const raw = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
  if (file.size < 600 * 1024 || !/^image\/(png|jpeg|webp)$/.test(file.type)) return raw;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
    const out = canvas.toDataURL(type, 0.88);
    return out.length < raw.length ? out : raw;
  } catch {
    return raw;
  }
}

export class EditorScreen {
  constructor(root, { docId, onHome, onOpenDoc, onNewDoc, onImport }) {
    this.root = root;
    this.docId = docId;
    this.nav_ = { onHome, onOpenDoc, onNewDoc, onImport };
    const saved = loadView();
    this.view = {
      layout: saved.layout === 'web' ? 'web' : 'print',
      ruler: saved.ruler !== false,
      // The navigation pane covers the page on narrow screens; start closed there.
      nav: Boolean(saved.nav) && window.innerWidth > 900,
      marks: Boolean(saved.marks),
      spellcheck: saved.spellcheck !== false,
      zoom: Math.min(5, Math.max(0.1, Number(saved.zoom) || 1)),
    };
    this.pageCount = 1;
    this.saveState = 'saved';
    this.painterActive = false;
    this.speaking = false;
    this.destroyed = false;
    this.cleanups = [];
  }

  // ------------------------------------------------------------------ lifecycle
  async mount() {
    const doc = await getDoc(this.docId);
    if (!doc) return false;
    this.title = doc.title;
    this.settings = doc.settings;
    this.createdAt = doc.createdAt;
    this.buildChrome();
    this.applyView();

    this.editor = createEditor({
      element: this.pageStack,
      content: doc.json || sanitizeHtml(doc.html) || '<p></p>',
      getGeometry: () => (this.view.layout === 'print' ? this.geometry : null),
      onLayout: ({ pageCount }) => this.onLayout(pageCount),
      getPageOf: (pos) => this.pageOfPos(pos),
      onUpdate: () => this.onDocChange(),
      onSelectionUpdate: () => this.onSelectionChange(),
      onTransaction: () => this.scheduleUiUpdate(),
      editorProps: {
        handlePaste: (view, event) => this.handleFiles(event.clipboardData?.files, null),
        handleDrop: (view, event) => {
          const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
          return this.handleFiles(event.dataTransfer?.files, pos);
        },
        handleClick: (view, pos, event) => {
          const a = event.target.closest?.('a[href]');
          if (a && (event.ctrlKey || event.metaKey)) {
            window.open(a.href, '_blank', 'noopener,noreferrer');
            return true;
          }
          return false;
        },
        handleDOMEvents: {
          contextmenu: (view, event) => {
            this.showContextMenu(event);
            return true;
          },
        },
      },
    });
    this.editorEl = this.editor.view.dom;
    this.editorEl.setAttribute('spellcheck', String(this.view.spellcheck));
    this.find.attach(this.editor);
    this.applyGeometry();
    this.ruler.render();
    this.updateTitle();
    this.ribbon.update();
    this.updateStats();
    this.nav.render();
    this.setZoom(this.view.zoom, { keepScroll: false });
    // On phones, fit the page to the screen instead of scrolling sideways.
    if (this.view.layout === 'print' && this.canvas.clientWidth < this.geometry.width * this.view.zoom + 48) {
      this.zoomTo('width', { persist: false });
    }

    // Keyboard shortcuts that live outside the editor.
    const onKey = (e) => this.handleKeydown(e);
    document.addEventListener('keydown', onKey, true);
    this.cleanups.push(() => document.removeEventListener('keydown', onKey, true));

    const onHide = () => {
      if (document.visibilityState === 'hidden') this.flush();
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onHide);
    this.cleanups.push(() => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onHide);
    });

    const onResize = debounce(() => {
      if (this.view.layout === 'web') this.applyGeometry();
    }, 100);
    window.addEventListener('resize', onResize);
    this.cleanups.push(() => window.removeEventListener('resize', onResize));

    const onWheel = (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      this.setZoom(this.view.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
    };
    this.canvas.addEventListener('wheel', onWheel, { passive: false });

    if (channel) {
      const onMsg = (e) => {
        if (e.data?.type === 'saved' && e.data.id === this.docId && e.data.tab !== TAB_ID && !this.conflictShown) {
          this.conflictShown = true;
          toast('This document was changed in another tab.', {
            timeout: 10000,
            action: { label: 'Reload', run: () => this.nav_.onOpenDoc(this.docId, { force: true }) },
          });
        }
      };
      channel.addEventListener('message', onMsg);
      this.cleanups.push(() => channel.removeEventListener('message', onMsg));
    }
    return true;
  }

  async destroy() {
    if (this.destroyed) return;
    await this.flush();
    this.destroyed = true;
    if (this.speaking) speechSynthesis.cancel();
    closePopover();
    this.cleanups.forEach((fn) => fn());
    this.editor?.destroy();
    this.printStyle?.remove();
  }

  // ------------------------------------------------------------------ DOM
  buildChrome() {
    const btn = (ic, label, fn, extra = {}) => {
      const b = h('button', { type: 'button', class: 'icon-btn', title: label, 'aria-label': label, html: icon(ic), ...extra });
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', fn);
      return b;
    };

    this.titleInput = h('input', { class: 'doc-title-input', type: 'text', 'aria-label': 'Document name', spellcheck: 'false', maxlength: '200' });
    this.titleInput.value = this.title;
    this.titleInput.addEventListener('input', () => this.sizeTitle());
    this.titleInput.addEventListener('change', () => this.rename(this.titleInput.value));
    this.titleInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'Escape') {
        if (e.key === 'Escape') this.titleInput.value = this.title;
        e.preventDefault();
        this.editor.commands.focus();
      }
    });
    this.saveStateEl = h('span', { class: 'save-state', 'aria-live': 'polite' });
    this.undoBtn = btn('undo', 'Undo (Ctrl+Z)', () => this.editor.chain().focus().undo().run());
    this.redoBtn = btn('redo', 'Redo (Ctrl+Y)', () => this.editor.chain().focus().redo().run());
    const searchInput = h('input', { type: 'search', placeholder: 'Search', 'aria-label': 'Search in document' });
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.openFind(false, searchInput.value);
        searchInput.value = '';
      }
    });

    const titlebar = h(
      'header',
      { class: 'titlebar' },
      h('button', {
        type: 'button',
        class: 'app-logo',
        title: 'Home — all documents',
        'aria-label': 'Home — all documents',
        html: '<svg width="26" height="26" viewBox="0 0 48 48" aria-hidden="true"><rect width="48" height="48" rx="10" fill="#fff"/><path d="M12 14h4.2l3.3 14.4L23.2 14h3.6l3.7 14.4L33.8 14H38l-5.6 20h-3.9L25 20.6 21.5 34h-3.9z" fill="#185abd"/></svg>',
        onclick: () => this.nav_.onHome(),
      }),
      btn('save', 'Save (Ctrl+S)', () => this.saveNow(true)),
      this.undoBtn,
      this.redoBtn,
      h('div', { class: 'doc-title-wrap' }, this.titleInput, this.saveStateEl),
      h('label', { class: 'titlebar-search', html: icon('search') }, searchInput),
      h('div', { class: 'titlebar-right' }, btn('moon', 'Toggle dark mode', () => this.toggleTheme())),
    );

    this.ribbon = new Ribbon(this);
    this.find = new FindPanel(this);
    this.nav = new NavPane(this);
    this.ruler = new Ruler(this);

    this.sheets = h('div', { class: 'page-sheets', 'aria-hidden': 'true' });
    this.pageStack = h('div', { class: 'page-stack' }, this.sheets);
    this.canvasInner = h('div', { class: 'canvas-inner' }, this.ruler.el, this.pageStack);
    this.canvas = h('div', { class: 'canvas' }, this.canvasInner);
    this.canvas.addEventListener('mousedown', (e) => {
      // Clicking the grey area beside / below the page puts the caret at the nearest spot.
      if (e.target === this.canvas || e.target === this.canvasInner) {
        e.preventDefault();
        const r = this.editorEl.getBoundingClientRect();
        const pos = this.editor.view.posAtCoords({ left: Math.min(Math.max(e.clientX, r.left + 1), r.right - 1), top: Math.min(Math.max(e.clientY, r.top + 1), r.bottom - 1) });
        this.editor.chain().focus().setTextSelection(pos ? pos.pos : this.editor.state.doc.content.size).run();
      }
    });

    this.statusPage = h('button', { type: 'button', class: 'sb-item', title: 'Go to page' }, 'Page 1 of 1');
    this.statusPage.addEventListener('click', () => this.goToPageDialog());
    this.statusWords = h('button', { type: 'button', class: 'sb-item', title: 'Word count' }, '0 words');
    this.statusWords.addEventListener('click', () => this.wordCountDialog());
    this.zoomSlider = h('input', { type: 'range', class: 'zoom-slider', min: '0', max: '100', step: '1', 'aria-label': 'Zoom' });
    this.zoomSlider.addEventListener('input', () => {
      const v = Number(this.zoomSlider.value);
      const z = v <= 50 ? 0.1 + (v / 50) * 0.9 : 1 + ((v - 50) / 50) * 4;
      this.setZoom(Math.abs(z - 1) < 0.04 ? 1 : z);
    });
    this.zoomLabel = h('button', { type: 'button', class: 'sb-item zoom-label', title: 'Zoom level' }, '100%');
    this.zoomLabel.addEventListener('click', () => this.zoomDialog());
    this.layoutBtns = {
      print: btn('printLayout', 'Print Layout', () => this.setLayout('print')),
      web: btn('webLayout', 'Web Layout', () => this.setLayout('web')),
    };
    const statusbar = h(
      'footer',
      { class: 'statusbar' },
      this.statusPage,
      this.statusWords,
      h('span', { class: 'sb-item sb-optional' }, navigator.language || 'English'),
      h('div', { class: 'sb-spacer' }),
      btn('focus', 'Focus', () => this.setFocusMode(true)),
      this.layoutBtns.print,
      this.layoutBtns.web,
      btn('zoomOut', 'Zoom out', () => this.setZoom(this.view.zoom - 0.1)),
      this.zoomSlider,
      btn('zoomIn', 'Zoom in', () => this.setZoom(this.view.zoom + 0.1)),
      this.zoomLabel,
    );

    const focusExit = h('button', { type: 'button', class: 'btn focus-exit', onclick: () => this.setFocusMode(false) }, 'Exit Focus');
    this.screen = h(
      'div',
      { class: 'editor-screen' },
      titlebar,
      this.ribbon.el,
      h('div', { class: 'workspace' }, this.nav.el, this.canvas, this.find.el),
      statusbar,
      focusExit,
    );
    this.root.replaceChildren(this.screen);
    this.printStyle = h('style', { media: 'print' });
    document.head.append(this.printStyle);
  }

  get geometry() {
    return pageGeometry(this.settings);
  }

  applyGeometry() {
    const g = this.geometry;
    const el = this.editorEl;
    if (this.view.layout === 'print') {
      this.pageStack.style.width = `${g.width}px`;
      if (el) {
        el.style.width = `${g.width}px`;
        el.style.padding = `${g.margins.top}px ${g.margins.right}px ${g.margins.bottom}px ${g.margins.left}px`;
        el.style.minHeight = `${this.pageCount * (g.height + g.gap) - g.gap}px`;
      }
    } else {
      const avail = Math.max(320, (this.canvas.clientWidth - 48) / this.view.zoom);
      this.pageStack.style.width = `${avail}px`;
      if (el) {
        el.style.width = '100%';
        el.style.padding = `48px ${Math.max(24, Math.min(96, avail * 0.06))}px`;
        el.style.minHeight = `${Math.max(400, (this.canvas.clientHeight - 48) / this.view.zoom)}px`;
      }
    }
    this.printStyle.textContent = printCss(this.settings);
    this.renderSheets();
    this.editor?.commands.repaginate();
  }

  renderSheets() {
    const g = this.geometry;
    if (this.view.layout !== 'print') {
      this.sheets.replaceChildren();
      return;
    }
    const n = this.pageCount;
    while (this.sheets.children.length > n) this.sheets.lastChild.remove();
    while (this.sheets.children.length < n) {
      this.sheets.append(h('div', { class: 'page-sheet' }, h('div', { class: 'hf hf-header' }), h('div', { class: 'hf hf-footer' })));
    }
    const { header, footer, pageNumbers } = this.settings;
    [...this.sheets.children].forEach((sheet, i) => {
      sheet.style.top = `${i * (g.height + g.gap)}px`;
      sheet.style.height = `${g.height}px`;
      const [hd, ft] = sheet.children;
      hd.textContent = header || '';
      hd.style.cssText = `top:${Math.max(12, g.margins.top / 2 - 8)}px;padding:0 ${g.margins.right}px 0 ${g.margins.left}px`;
      const parts = [];
      if (footer) parts.push(footer);
      if (pageNumbers) parts.push(`Page ${i + 1} of ${n}`);
      ft.textContent = parts.join('   ');
      ft.style.cssText = `bottom:${Math.max(12, g.margins.bottom / 2 - 8)}px;padding:0 ${g.margins.right}px 0 ${g.margins.left}px`;
    });
  }

  onLayout(pageCount) {
    if (this.destroyed) return;
    const changed = pageCount !== this.pageCount;
    this.pageCount = pageCount;
    if (changed || this.sheets.children.length !== pageCount) {
      const g = this.geometry;
      if (this.view.layout === 'print') this.editorEl.style.minHeight = `${pageCount * (g.height + g.gap) - g.gap}px`;
      this.renderSheets();
    }
    this.updatePageStatus();
  }

  pageOfPos(pos) {
    if (this.view.layout !== 'print' || !this.editor) return null;
    const g = this.geometry;
    const view = this.editor.view;
    const rootRect = view.dom.getBoundingClientRect();
    const scale = rootRect.width / g.width || 1;
    const c = view.coordsAtPos(Math.min(pos + 1, view.state.doc.content.size));
    const y = (c.top - rootRect.top) / scale;
    return Math.max(1, Math.floor(y / (g.height + g.gap)) + 1);
  }

  // ------------------------------------------------------------------ state sync
  scheduleUiUpdate() {
    if (this.uiFrame) return;
    this.uiFrame = requestAnimationFrame(() => {
      this.uiFrame = 0;
      if (this.destroyed) return;
      this.ribbon.update();
      this.undoBtn.disabled = !this.editor.can().undo();
      this.redoBtn.disabled = !this.editor.can().redo();
      this.ruler.updateIndent();
    });
  }

  onDocChange() {
    this.setSaveState('unsaved');
    this.queueSave();
    this.statsDebounced();
    this.nav.refresh();
  }

  onSelectionChange() {
    this.updatePageStatus();
    this.selectionStatsDebounced();
    if (this.nav.visible && !this.nav.input.value) this.nav.refresh();
  }

  statsDebounced = debounce(() => this.updateStats(), 250);
  selectionStatsDebounced = debounce(() => this.updateStats(), 120);

  updateStats() {
    if (this.destroyed || !this.editor) return;
    const { state } = this.editor;
    const all = state.doc.textBetween(0, state.doc.content.size, '\n', ' ');
    this.words = countWords(all);
    const { from, to, empty } = state.selection;
    if (!empty) {
      const sel = countWords(state.doc.textBetween(from, to, '\n', ' '));
      this.statusWords.textContent = `${sel.toLocaleString()} of ${this.words.toLocaleString()} words`;
    } else {
      this.statusWords.textContent = `${this.words.toLocaleString()} word${this.words === 1 ? '' : 's'}`;
    }
  }

  updatePageStatus() {
    if (this.view.layout !== 'print') {
      this.statusPage.textContent = 'Web Layout';
      return;
    }
    let page = 1;
    try {
      page = this.pageOfPos(Math.max(0, this.editor.state.selection.head - 1)) || 1;
    } catch {
      /* ignore */
    }
    this.statusPage.textContent = `Page ${Math.min(page, this.pageCount)} of ${this.pageCount}`;
  }

  setSaveState(state) {
    this.saveState = state;
    const labels = { saved: 'Saved', saving: 'Saving…', unsaved: 'Editing', error: 'Not saved' };
    this.saveStateEl.textContent = `· ${labels[state]}`;
    this.saveStateEl.title = state === 'saved' ? 'All changes saved to this device' : '';
  }

  updateTitle() {
    document.title = `${this.title || 'Untitled document'} — LibreWord`;
    this.sizeTitle();
    this.setSaveState(this.saveState);
  }

  sizeTitle() {
    if (!this.measureCtx) this.measureCtx = document.createElement('canvas').getContext('2d');
    const cs = getComputedStyle(this.titleInput);
    this.measureCtx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const w = this.measureCtx.measureText(this.titleInput.value || 'Untitled document').width;
    this.titleInput.style.width = `${Math.min(420, Math.max(80, Math.ceil(w) + 24))}px`;
  }

  // ------------------------------------------------------------------ persistence
  queueSave = debounce(() => this.saveNow(false), 700);

  async saveNow(announce = false) {
    this.queueSave.cancel();
    if (this.destroyed || !this.editor) return;
    if (this.saving) {
      this.saveAgain = true;
      return this.saving;
    }
    this.setSaveState('saving');
    const { state } = this.editor;
    const preview = state.doc.textBetween(0, Math.min(state.doc.content.size, 1200), ' ', ' ').replace(/\s+/g, ' ').trim().slice(0, 280);
    if (this.words == null) this.updateStats();
    this.saving = saveDoc(this.docId, { json: this.editor.getJSON(), preview, words: this.words, title: this.title, settings: this.settings })
      .then(() => {
        this.setSaveState('saved');
        channel?.postMessage({ type: 'saved', id: this.docId, tab: TAB_ID });
        if (announce) toast('Saved to this device', { type: 'success', timeout: 1800 });
      })
      .catch((err) => {
        console.error(err);
        this.setSaveState('error');
        toast(`Couldn't save: ${err.message || err}`, { type: 'error', timeout: 6000 });
      })
      .finally(() => {
        this.saving = null;
        if (this.saveAgain) {
          this.saveAgain = false;
          this.saveNow();
        }
      });
    return this.saving;
  }

  async flush() {
    if (this.destroyed || !this.editor) return;
    if (this.saveState === 'unsaved' || this.queueSave) {
      this.queueSave.cancel();
      if (this.saveState !== 'saved') await this.saveNow();
    }
    await this.saving;
  }

  rename(title) {
    const t = title.trim() || 'Untitled document';
    this.title = t;
    this.titleInput.value = t;
    this.updateTitle();
    this.saveNow();
  }

  updateSettings(partial, { transient = false } = {}) {
    this.settings = { ...this.settings, ...partial, margins: { ...this.settings.margins, ...(partial.margins || {}) } };
    this.applyGeometry();
    this.ruler.render();
    this.ribbon.update();
    if (!transient) this.saveNow();
  }

  // ------------------------------------------------------------------ view
  applyView() {
    this.pageStack.classList.toggle('web-layout', this.view.layout === 'web');
    this.canvas.classList.toggle('no-ruler', !this.view.ruler || this.view.layout === 'web');
    this.screen.classList.toggle('show-marks', this.view.marks);
    this.nav.el.hidden = !this.view.nav;
    this.layoutBtns.print.classList.toggle('is-active', this.view.layout === 'print');
    this.layoutBtns.web.classList.toggle('is-active', this.view.layout === 'web');
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify({ ...this.view, zoom: this.savedZoom ?? this.view.zoom }));
    } catch {
      /* private mode */
    }
  }

  setLayout(layout) {
    this.view.layout = layout;
    this.applyView();
    this.applyGeometry();
    this.ruler.render();
    this.ribbon.update();
    this.updatePageStatus();
  }

  toggleRuler() {
    this.view.ruler = !this.view.ruler;
    this.applyView();
    this.ruler.render();
    this.ribbon.update();
  }

  toggleNav(force) {
    this.view.nav = force ?? !this.view.nav;
    this.applyView();
    if (this.view.nav) {
      this.nav.render();
      this.nav.input.focus();
    }
    this.ribbon.update();
    if (this.view.layout === 'web') this.applyGeometry();
  }

  toggleMarks() {
    this.view.marks = !this.view.marks;
    this.applyView();
    this.ribbon.update();
    this.editor.commands.repaginate();
  }

  toggleSpellcheck() {
    this.view.spellcheck = !this.view.spellcheck;
    this.editorEl.setAttribute('spellcheck', String(this.view.spellcheck));
    // Force browsers to re-run (or drop) spell checking.
    this.editorEl.blur();
    this.editor.commands.focus();
    this.applyView();
    this.ribbon.update();
  }

  setFocusMode(on) {
    this.screen.classList.toggle('focus-mode', on);
    if (on) toast('Focus mode — press Esc to exit', { timeout: 2200 });
    this.editor.commands.focus();
    if (this.view.layout === 'web') this.applyGeometry();
  }

  toggleTheme() {
    const root = document.documentElement;
    const isDark = root.dataset.theme === 'dark' || (!root.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
    root.dataset.theme = isDark ? 'light' : 'dark';
    try {
      localStorage.setItem('lw:theme', root.dataset.theme);
    } catch { /* ignore */ }
    this.ruler.render();
    this.ribbon.update();
  }

  toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => toast('Full screen is not available here.'));
  }

  setZoom(z, { keepScroll = true, persist = true } = {}) {
    const zoom = Math.round(Math.min(5, Math.max(0.1, z)) * 100) / 100;
    const old = this.view.zoom;
    const c = this.canvas;
    const centerRatio = keepScroll && c.scrollHeight ? (c.scrollTop + c.clientHeight / 2) / c.scrollHeight : 0;
    this.view.zoom = zoom;
    if (persist) this.savedZoom = zoom;
    this.pageStack.style.zoom = String(zoom);
    this.zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
    this.zoomSlider.value = String(zoom <= 1 ? ((zoom - 0.1) / 0.9) * 50 : 50 + ((zoom - 1) / 4) * 50);
    if (this.view.layout === 'web') this.applyGeometry();
    this.ruler.render();
    if (keepScroll && old !== zoom) c.scrollTop = centerRatio * c.scrollHeight - c.clientHeight / 2;
    this.applyView();
  }

  zoomTo(mode, opts) {
    const g = this.geometry;
    const w = this.canvas.clientWidth - 48;
    const hgt = this.canvas.clientHeight - (this.view.ruler ? 60 : 48);
    if (mode === 'width') this.setZoom(w / g.width, opts);
    else this.setZoom(Math.min(w / g.width, hgt / g.height), opts);
  }

  goTo(pos) {
    const ed = this.editor;
    const p = Math.max(0, Math.min(pos, ed.state.doc.content.size));
    ed.view.dispatch(ed.state.tr.setSelection(TextSelection.near(ed.state.doc.resolve(p))));
    ed.view.focus();
    // Scroll so the target sits near the top of the viewport, like Word's navigation.
    const coords = ed.view.coordsAtPos(ed.state.selection.from);
    const cr = this.canvas.getBoundingClientRect();
    this.canvas.scrollTop += coords.top - cr.top - 80;
  }

  onChromeResize() {
    if (this.view.layout === 'web') this.applyGeometry();
  }

  toast(msg, opts) {
    toast(msg, opts);
  }

  // ------------------------------------------------------------------ actions
  openFind(replace = false, term) {
    this.find.open({ replace, term });
  }

  openBackstage(section) {
    openBackstage(this, section);
  }

  async exportAs(format) {
    try {
      await this.flush();
      if (format === 'pdf') toast('Choose “Save as PDF” as the printer to create a PDF.', { timeout: 4500 });
      await exportDocument(this.editor, format, { title: this.title, settings: this.settings });
    } catch (err) {
      console.error(err);
      toast(`Export failed: ${err.message || err}`, { type: 'error', timeout: 6000 });
    }
  }

  print() {
    this.flush();
    printDocument(this.title);
  }

  clipboard(kind) {
    this.editor.view.focus();
    const ok = document.execCommand(kind);
    if (!ok) toast(`Use ${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+${kind === 'cut' ? 'X' : 'C'} to ${kind}.`);
  }

  async paste(plain) {
    const view = this.editor.view;
    view.focus();
    try {
      if (!plain && navigator.clipboard?.read) {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          const imgType = item.types.find((t) => t.startsWith('image/'));
          if (item.types.includes('text/html')) {
            view.pasteHTML(await (await item.getType('text/html')).text());
            return;
          }
          if (imgType) {
            const blob = await item.getType(imgType);
            await this.insertImageFile(new File([blob], 'pasted-image', { type: imgType }));
            return;
          }
        }
      }
      const text = await navigator.clipboard.readText();
      if (text) view.pasteText(text);
    } catch {
      toast(`Your browser blocked clipboard access. Press ${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+V to paste.`, { timeout: 4500 });
    }
  }

  handleFiles(files, pos) {
    const images = [...(files || [])].filter((f) => f.type.startsWith('image/'));
    if (!images.length) {
      const docs = [...(files || [])].filter((f) => /\.(docx|md|markdown|txt|html?|rtf)$/i.test(f.name));
      if (docs.length && pos != null) {
        this.nav_.onImport(docs[0]);
        return true;
      }
      return false;
    }
    (async () => {
      for (const f of images) await this.insertImageFile(f, pos);
    })();
    return true;
  }

  async insertImageFile(file, pos = null) {
    try {
      const src = await imageFileToDataUrl(file);
      const chain = this.editor.chain().focus();
      if (pos != null) chain.setTextSelection(pos);
      chain.insertContent({ type: 'image', attrs: { src, alt: file.name.replace(/\.[^.]+$/, '') } }).run();
    } catch (err) {
      toast(`Couldn't insert image: ${err.message || err}`, { type: 'error' });
    }
  }

  async insertImageFromFile() {
    const file = await pickFile('image/*');
    if (file) this.insertImageFile(file);
  }

  async insertImageFromUrl() {
    const r = await promptDialog({
      title: 'Insert Picture',
      fields: [
        { name: 'src', label: 'Address', type: 'url', placeholder: 'https://example.com/picture.png', required: true },
        { name: 'alt', label: 'Alt text', placeholder: 'Describe the picture' },
      ],
      confirmLabel: 'Insert',
    });
    if (r?.src && /^(https?:|data:image\/)/i.test(r.src.trim())) {
      this.editor.chain().focus().insertContent({ type: 'image', attrs: { src: r.src.trim(), alt: r.alt || null } }).run();
    } else if (r) toast('Please enter an http(s) address.', { type: 'error' });
  }

  async editLink() {
    const ed = this.editor;
    if (ed.isActive('link')) ed.chain().extendMarkRange('link').run();
    const { from, to } = ed.state.selection;
    const text = ed.state.doc.textBetween(from, to, ' ');
    const current = ed.getAttributes('link').href || '';
    const fields = [{ name: 'href', label: 'Address', type: 'text', value: current, placeholder: 'https://' }];
    if (from === to) fields.unshift({ name: 'text', label: 'Text to display', value: '' });
    const r = await promptDialog({ title: current ? 'Edit Link' : 'Insert Link', fields, confirmLabel: current ? 'Update' : 'Insert' });
    if (!r) return ed.commands.focus();
    let href = r.href.trim();
    if (!href) return ed.chain().focus().extendMarkRange('link').unsetLink().run();
    if (!/^([a-z][a-z0-9+.-]*:|#|\/)/i.test(href)) href = /^[^\s@]+@[^\s@]+$/.test(href) ? `mailto:${href}` : `https://${href}`;
    if (/^(javascript|data|vbscript):/i.test(href)) return toast('That address is not allowed.', { type: 'error' });
    if (from === to) {
      const label = r.text?.trim() || href;
      ed.chain().focus().insertContent({ type: 'text', text: label, marks: [{ type: 'link', attrs: { href } }] }).run();
    } else {
      ed.chain().focus().extendMarkRange('link').setLink({ href }).run();
    }
    return text;
  }

  insertDateTime() {
    const now = new Date();
    const formats = [
      now.toLocaleDateString(),
      now.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
      now.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }),
      now.toISOString().slice(0, 10),
      now.toLocaleString(),
      now.toLocaleTimeString(),
    ];
    const list = h('div', { class: 'menu', role: 'listbox', style: { minWidth: '320px' } });
    const p = openDialog({ title: 'Date and Time', body: list, buttons: [{ label: 'Cancel', value: null }] });
    for (const f of formats) {
      list.append(h('button', {
        type: 'button',
        class: 'menu-item',
        onclick: () => {
          list.closest('dialog').close();
          this.editor.chain().focus().insertContent(f).run();
        },
      }, h('span'), h('span', {}, f), h('span')));
    }
    return p;
  }

  formatPainter() {
    const ed = this.editor;
    if (this.painterActive) return this.endPainter();
    const marks = ed.state.storedMarks || ed.state.selection.$from.marks();
    this.painterMarks = marks.map((m) => ({ type: m.type.name, attrs: m.attrs }));
    this.painterActive = true;
    this.editorEl.classList.add('painter-active');
    this.ribbon.update();
    const onUp = () => {
      setTimeout(() => {
        if (!this.painterActive) return;
        const { empty } = ed.state.selection;
        if (empty) return;
        const chain = ed.chain().focus().unsetAllMarks();
        for (const m of this.painterMarks) chain.setMark(m.type, m.attrs);
        chain.run();
        this.endPainter();
      }, 0);
    };
    this.editorEl.addEventListener('mouseup', onUp);
    this.painterCleanup = () => this.editorEl.removeEventListener('mouseup', onUp);
    return true;
  }

  endPainter() {
    this.painterActive = false;
    this.editorEl.classList.remove('painter-active');
    this.painterCleanup?.();
    this.ribbon.update();
  }

  readAloud() {
    if (!('speechSynthesis' in window)) return;
    if (this.speaking) {
      speechSynthesis.cancel();
      this.speaking = false;
      this.ribbon.update();
      return;
    }
    const { state } = this.editor;
    const { from, to, empty } = state.selection;
    const text = empty ? state.doc.textBetween(from, state.doc.content.size, '\n', ' ') : state.doc.textBetween(from, to, '\n', ' ');
    if (!text.trim()) return toast('Nothing to read.');
    const u = new SpeechSynthesisUtterance(text.slice(0, 32000));
    u.lang = document.documentElement.lang || navigator.language;
    u.onend = u.onerror = () => {
      this.speaking = false;
      this.ribbon.update();
    };
    this.speaking = true;
    speechSynthesis.speak(u);
    this.ribbon.update();
    return true;
  }

  togglePageNumbers() {
    this.updateSettings({ pageNumbers: !this.settings.pageNumbers });
  }

  showContextMenu(event) {
    // Let the browser handle right-clicks on misspelled words when spellcheck
    // suggestions matter more than our menu: hold Shift for the native menu.
    if (event.shiftKey) return;
    event.preventDefault();
    // Right-clicking outside the selection moves the caret there first (like Word).
    const view = this.editor.view;
    const hit = view.posAtCoords({ left: event.clientX, top: event.clientY });
    const { from, to } = view.state.selection;
    if (hit && (hit.pos < from || hit.pos > to)) {
      view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(hit.pos))));
    }
    import('./context-menu.js').then(({ showEditorContextMenu }) => showEditorContextMenu(this, event));
  }

  // ------------------------------------------------------------------ keyboard
  handleKeydown(e) {
    if (this.destroyed || document.querySelector('dialog[open]')) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (e.key === 'Escape') {
      if (isPopoverOpen()) return;
      if (this.screen.classList.contains('focus-mode')) {
        this.setFocusMode(false);
        e.preventDefault();
      } else if (this.painterActive) {
        this.endPainter();
      } else if (this.find.isOpen && this.find.el.contains(document.activeElement)) {
        this.find.close();
      }
      return;
    }
    if (e.key === 'F1' && mod) {
      e.preventDefault();
      this.ribbon.toggleCollapsed();
      return;
    }
    if (e.key === 'F7') {
      e.preventDefault();
      this.toggleSpellcheck();
      return;
    }
    if (e.key === 'F11' && !mod) {
      e.preventDefault();
      this.toggleFullscreen();
      return;
    }
    if (!mod) return;
    const handled = {
      s: () => this.saveNow(true),
      p: () => this.print(),
      f: () => (e.shiftKey ? null : this.openFind(false)),
      h: () => this.openFind(true),
      k: () => this.editLink(),
      o: () => this.openBackstage('open'),
      g: () => (e.shiftKey ? this.wordCountDialog() : this.goToPageDialog()),
      '/': () => this.shortcutsDialog(),
      '?': () => this.shortcutsDialog(),
      0: () => (e.altKey ? this.setZoom(1) : null),
    }[key];
    if (handled) {
      const r = handled();
      if (r !== null) e.preventDefault();
    }
  }

  // ------------------------------------------------------------------ dialogs (lazy)
  async pageSetupDialog() {
    (await import('./doc-dialogs.js')).pageSetupDialog(this);
  }

  async paragraphDialog() {
    (await import('./doc-dialogs.js')).paragraphDialog(this);
  }

  async headerFooterDialog() {
    (await import('./doc-dialogs.js')).headerFooterDialog(this);
  }

  async wordCountDialog() {
    (await import('./doc-dialogs.js')).wordCountDialog(this);
  }

  async shortcutsDialog() {
    (await import('./doc-dialogs.js')).shortcutsDialog();
  }

  async zoomDialog() {
    (await import('./doc-dialogs.js')).zoomDialog(this);
  }

  async goToPageDialog() {
    (await import('./doc-dialogs.js')).goToPageDialog(this);
  }

  async insertTableDialog() {
    (await import('./doc-dialogs.js')).insertTableDialog(this);
  }
}

export const units = {
  toDisplay: (px) => (usesInches() ? +(px / PX_PER_IN).toFixed(2) : +(px / PX_PER_CM).toFixed(2)),
  fromDisplay: (v) => (usesInches() ? Number(v) * PX_PER_IN : Number(v) * PX_PER_CM),
  label: () => (usesInches() ? 'in' : 'cm'),
  pt: PX_PER_PT,
  sizes: PAGE_SIZES,
};

