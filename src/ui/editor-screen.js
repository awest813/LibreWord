import { TextSelection } from '@tiptap/pm/state';
import { createEditor } from '../editor/create-editor.js';
import { KEEP_MARKS, countWords } from '../editor/word-commands.js';
import { toggleTheme } from './theme.js';
import { pageGeometry, PAGE_SIZES, PX_PER_IN, PX_PER_CM, PX_PER_PT, usesInches } from '../editor/page-setup.js';
import { getDoc, saveDoc, addVersion, getVersion, createDoc, getDocFile } from '../storage/db.js';
import { exportDocument, printCss, printDocument, renderDocumentBlob } from '../io/export.js';
import {
  FILE_FORMATS, LOSSY_NOTES, canSaveToFiles, ensureWritePermission, fileNameFor, formatOfName, handleFromDataTransfer,
  pickSaveLocation, writeToHandle,
} from '../io/file-access.js';
import { sanitizeHtml, canOpen } from '../io/import.js';
import { commentRanges } from '../editor/comments.js';
import { noteError } from '../diagnostics.js';
import { h, toast, debounce, isPopoverOpen, closePopover, isMac, shortcutLabel, setFocusFallback } from './dom.js';
import { icon } from './icons.js';
import { Ribbon } from './ribbon.js';
import { FindPanel, NavPane, Ruler } from './panels.js';
import { CommentsPane, initialsOf } from './comments-pane.js';
import { newId } from '../storage/db.js';
import { openDialog, promptDialog, confirmDialog } from './dialog.js';
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


const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('libreword') : null;
const TAB_ID = Math.random().toString(36).slice(2);

/*
 * Edits not yet in IndexedDB when the page goes away (a reload or navigation
 * within the 700 ms autosave delay) would be lost: IndexedDB writes started
 * while a page unloads don't finish. So the unsaved state is also stashed in
 * localStorage, which writes synchronously, and picked up on the next open if
 * nothing newer was saved since.
 */
const PENDING_KEY = (id) => `lw:pending:${id}`;
function takePending(id, storedAt) {
  try {
    const raw = localStorage.getItem(PENDING_KEY(id));
    if (!raw) return null;
    localStorage.removeItem(PENDING_KEY(id));
    const pending = JSON.parse(raw);
    return pending?.json && pending.at > (storedAt || 0) ? pending : null;
  } catch {
    return null;
  }
}
const dropPending = (id) => {
  try {
    localStorage.removeItem(PENDING_KEY(id));
  } catch { /* storage unavailable */ }
};

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
      comments: saved.comments !== false && window.innerWidth > 1100,
      marks: Boolean(saved.marks),
      spellcheck: saved.spellcheck !== false,
      zoom: Math.min(5, Math.max(0.1, Number(saved.zoom) || 1)),
    };
    this.pageCount = 1;
    this.saveState = 'saved';
    this.rev = 0; // bumped on every edit; a save only counts as "saved" if no edit raced it
    this.painterActive = false;
    this.speaking = false;
    this.destroyed = false;
    this.cleanups = [];
  }

  // ------------------------------------------------------------------ lifecycle
  async mount() {
    const doc = await getDoc(this.docId);
    if (!doc) return false;
    const pending = takePending(this.docId, doc.updatedAt);
    this.title = pending?.title ?? doc.title;
    this.settings = pending?.settings ?? doc.settings;
    this.createdAt = doc.createdAt;
    this.savedAt = doc.updatedAt;
    this.comments = pending?.comments ?? (doc.comments || {});
    // Link to a file on the device (Chromium): Save writes back to it.
    this.file = doc.file || null;
    // Persisted, so "unsaved changes to the file" survives reloads and "Don't Save".
    this.fileDirty = Boolean(doc.file?.unsaved || pending?.fileDirty);
    this.fileRev = 0; // bumped by every change the file should get
    // The state the document was opened in: saved to version history the
    // first time this session changes it.
    this.openState = { title: doc.title, json: doc.json, html: doc.html, settings: doc.settings, comments: this.comments, words: doc.words, createdAt: doc.updatedAt };
    this.lastVersionAt = 0;
    this.buildChrome();
    this.applyView();

    let contentError = null;
    this.editor = createEditor({
      element: this.pageStack,
      content: pending?.json || doc.json || sanitizeHtml(doc.html) || '<p></p>',
      getGeometry: () => (this.view.layout === 'print' ? this.geometry : null),
      onLayout: ({ pageCount }) => this.onLayout(pageCount),
      getPageOf: (pos) => this.pageOfPos(pos),
      isKnownComment: (id) => Boolean(this.comments?.[id]),
      onPasteReport: ({ droppedImages }) => toast(`${droppedImages} picture${droppedImages === 1 ? '' : 's'} couldn’t be pasted from Word. Use Insert › Pictures to add ${droppedImages === 1 ? 'it' : 'them'}.`, { timeout: 7000 }),
      onUpdate: ({ transaction }) => this.onDocChange(transaction),
      onSelectionUpdate: () => this.onSelectionChange(),
      onTransaction: () => this.scheduleUiUpdate(),
      onContentError: ({ error }) => { contentError = error; },
      editorProps: {
        handlePaste: (view, event) => {
          // Office apps put a picture of the selection on the clipboard next to
          // the HTML; prefer the HTML so text stays text.
          if (event.clipboardData?.types?.includes('text/html')) return false;
          return this.handleFiles(event.clipboardData?.files, null);
        },
        handleDrop: (view, event) => {
          const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
          return this.handleFiles(event.dataTransfer?.files, pos, event.dataTransfer);
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
    // Threads whose text was deleted are kept while editing, so undo can bring
    // them back; a fresh session has no undo history, so drop them now.
    const anchored = commentRanges(this.editor.state.doc);
    if (Object.keys(this.comments).some((id) => !anchored.has(id))) {
      this.comments = Object.fromEntries(Object.entries(this.comments).filter(([id]) => anchored.has(id)));
    }
    // Double-clicking a page's top or bottom margin edits the header/footer, as in Word.
    this.editorEl.addEventListener('dblclick', (e) => {
      if (this.view.layout !== 'print') return;
      const g = this.geometry;
      const r = this.editorEl.getBoundingClientRect();
      const y = ((e.clientY - r.top) / (r.width / g.width)) % (g.height + g.gap);
      if (y < g.margins.top - 4 || (y > g.height - g.margins.bottom + 4 && y < g.height)) {
        e.preventDefault();
        this.headerFooterDialog();
      }
    });
    // Focus synchronously so keystrokes typed right after opening aren't lost.
    this.editor.view.focus();
    this.editorEl.setAttribute('spellcheck', String(this.view.spellcheck));
    this.find.attach(this.editor);
    this.editor.on('requestComment', () => this.addComment());
    this.applyGeometry();
    this.ruler.render();
    this.updateTitle();
    this.renderFileChip();
    this.ribbon.update();
    this.updateStats();
    this.nav.render();
    this.commentsPane.render();
    this.setZoom(this.view.zoom, { keepScroll: false });
    // On phones, fit the page to the screen instead of scrolling sideways.
    if (this.view.layout === 'print' && this.canvas.clientWidth < this.geometry.width * this.view.zoom + 48) {
      this.zoomTo('width', { persist: false });
    }

    // Keyboard shortcuts that live outside the editor.
    const onKey = (e) => this.handleKeydown(e);
    document.addEventListener('keydown', onKey, true);
    this.cleanups.push(() => document.removeEventListener('keydown', onKey, true));
    setFocusFallback(() => !this.destroyed && this.editor.commands.focus());
    this.cleanups.push(() => setFocusFallback(null));

    // Edits are always kept in the browser, but warn before leaving with
    // changes that haven't been written to the linked file yet.
    const onBeforeUnload = (e) => {
      // Also warn when edits can't be stored: autosave paused by another tab, or the document deleted.
      const unstored = (this.conflict && this.conflictDirty) || (this.docGone && this.saveState !== 'saved') || !this.stashPending();
      if (!unstored && (!this.fileDirty || this.leaveConfirmed)) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    this.cleanups.push(() => window.removeEventListener('beforeunload', onBeforeUnload));

    // pagehide comes before the page turns hidden on a reload, so don't wait for that.
    const onHide = (e) => {
      if (e.type === 'pagehide' || document.visibilityState === 'hidden') {
        this.stashPending();
        this.flush();
      }
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
        if (e.data?.type === 'renamed' && e.data.id === this.docId && !this.destroyed) {
          // Renamed from the document list in another tab: adopt it, so the next save keeps it.
          this.title = e.data.title;
          this.titleInput.value = e.data.title;
          this.updateTitle();
          return;
        }
        if (e.data?.type === 'saved' && e.data.id === this.docId && e.data.tab !== TAB_ID && !this.conflict && !this.destroyed) {
          // Pause autosave so this tab doesn't silently overwrite the other tab's changes.
          // Saving explicitly (or leaving the document) keeps this tab's version.
          this.conflict = true;
          // Only this tab's own unsaved edits are worth writing over the other tab's.
          this.conflictDirty = this.saveState !== 'saved';
          this.setSaveState('conflict');
          toast(e.data.reason === 'backup'
            ? 'This document was replaced by a restored backup. Reload to see it, or Save to keep the version open here.'
            : 'This document was changed in another tab. Reload to see those changes, or Save to keep yours.', {
            timeout: 15000,
            action: { label: 'Reload', run: () => !this.destroyed && this.nav_.onOpenDoc(this.docId, { force: true }) },
          });
        }
      };
      channel.addEventListener('message', onMsg);
      this.cleanups.push(() => channel.removeEventListener('message', onMsg));
    }
    if (contentError) {
      // Probably saved by a newer LibreWord. Show what can be shown, but never
      // save it: that would replace the real document with this partial view.
      console.warn(contentError);
      this.unreadable = true;
      this.fileDirty = false; // nothing here can be saved, so don't ask to on leaving
      this.editor.setEditable(false);
      this.setSaveState('error');
      toast('This document uses features this version of LibreWord can’t show, so it opened read-only. Reload to get the latest LibreWord, or restore an earlier version from File › Version History.', { type: 'error', timeout: 20000 });
    } else if (pending) {
      this.userEdited = true;
      this.setSaveState('unsaved');
      this.saveNow();
      this.renderFileChip();
      toast('Recovered changes made just before LibreWord last closed.', { type: 'success', timeout: 5000 });
    }
    return true;
  }

  /** Keep unsaved edits in localStorage until autosave has written them (see takePending). */
  stashPending() {
    if (this.destroyed || !this.editor || this.saveState === 'saved' || this.conflict || this.docGone || this.unreadable) return true;
    try {
      localStorage.setItem(PENDING_KEY(this.docId), JSON.stringify({
        at: Date.now(), json: this.editor.getJSON(), title: this.title, settings: this.settings, comments: this.comments, fileDirty: this.fileDirty,
      }));
      return true;
    } catch {
      return false; // too big for localStorage (large pictures): beforeunload warns instead
    }
  }

  async destroy({ save = true } = {}) {
    if (this.destroyed) return;
    // Leaving keeps this tab's version, even over another tab's changes.
    if (save) await this.flush({ force: true });
    this.destroyed = true;
    this.closeBackstage?.();
    if (this.speaking) speechSynthesis.cancel();
    closePopover();
    this.cleanups.forEach((fn) => fn());
    this.editor?.destroy();
    this.printStyle?.remove();
    this.commentsPane?.destroy();
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
        else this.commitTitle();
        e.preventDefault();
        this.editor.commands.focus();
      }
    });
    this.saveStateEl = h('span', { class: 'save-state', 'aria-live': 'polite' });
    this.undoBtn = btn('undo', `Undo (${shortcutLabel('Mod-Z')})`, () => this.editor.chain().focus().undo().run());
    this.redoBtn = btn('redo', `Redo (${shortcutLabel(isMac ? 'Mod-Shift-Z' : 'Mod-Y')})`, () => this.editor.chain().focus().redo().run());
    const searchInput = h('input', { type: 'search', placeholder: 'Search', 'aria-label': 'Search in document' });
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.openFind(false, searchInput.value);
        searchInput.value = '';
      }
    });

    const titlebar = h(
      'div',
      { class: 'titlebar' },
      h('button', {
        type: 'button',
        class: 'app-logo',
        title: 'Home — all documents',
        'aria-label': 'Home — all documents',
        html: '<svg width="26" height="26" viewBox="0 0 48 48" aria-hidden="true"><rect width="48" height="48" rx="10" fill="#fff"/><path d="M12 14h4.2l3.3 14.4L23.2 14h3.6l3.7 14.4L33.8 14H38l-5.6 20h-3.9L25 20.6 21.5 34h-3.9z" fill="#185abd"/></svg>',
        onclick: () => this.leaveDocument(() => this.nav_.onHome()),
      }),
      (this.saveBtn = btn('save', `Save (${shortcutLabel('Mod-S')})`, () => this.save())),
      this.undoBtn,
      this.redoBtn,
      h('div', { class: 'doc-title-wrap' }, this.titleInput, this.saveStateEl, (this.fileChip = h('button', { type: 'button', class: 'file-chip', hidden: true, onclick: () => (this.fileDirty ? this.saveToFile() : this.openBackstage('info')) }))),
      h('label', { class: 'titlebar-search', html: icon('search') }, searchInput),
      h('div', { class: 'titlebar-right' }, btn('moon', 'Toggle dark mode', () => this.toggleTheme())),
    );

    this.ribbon = new Ribbon(this);
    this.find = new FindPanel(this);
    this.nav = new NavPane(this);
    this.ruler = new Ruler(this);
    this.commentsPane = new CommentsPane(this);

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
      btn('focus', 'Focus mode', () => this.setFocusMode(true)),
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
      h('header', { class: 'app-header' }, titlebar, this.ribbon.el),
      h('main', { class: 'workspace' }, this.nav.el, this.canvas, this.commentsPane.el, this.find.el),
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
        // Pictures taller than a page are shown shrunk to fit one (document.css).
        el.style.setProperty('--lw-content-height', `${g.contentHeight}px`);
      }
    } else {
      const avail = Math.max(320, (this.canvas.clientWidth - 48) / this.view.zoom);
      this.pageStack.style.width = `${avail}px`;
      if (el) {
        el.style.width = '100%';
        el.style.padding = `48px ${Math.max(24, Math.min(96, avail * 0.06))}px`;
        el.style.minHeight = `${Math.max(400, (this.canvas.clientHeight - 48) / this.view.zoom)}px`;
        el.style.removeProperty('--lw-content-height');
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

  onDocChange(transaction) {
    // Plugin housekeeping (e.g. the trailing paragraph) isn't a user edit. TipTap
    // reports the transaction that was dispatched, so housekeeping appended to a
    // non-editing one (focusing a document that ends in a heading) shows up as
    // an update whose own transaction changed nothing.
    if (!transaction || (transaction.docChanged && !transaction.getMeta('appendedTransaction'))) {
      this.userEdited = true;
      this.markFileDirty();
    }
    this.rev++;
    if (this.conflict) this.conflictDirty = true;
    this.setSaveState(this.conflict ? 'conflict' : 'unsaved');
    this.queueSave();
    this.statsDebounced();
    this.nav.refresh();
    // Undo/redo can bring back or take away the only comment.
    if (transaction?.getMeta('history$') && this.view.comments) this.commentsPane.el.hidden = !this.hasComments();
    this.commentsPane.refresh();
  }

  onSelectionChange() {
    this.updatePageStatus();
    this.selectionStatsDebounced();
    this.commentsPane.syncSelection();
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
    const labels = { saved: 'Saved', saving: 'Saving…', unsaved: 'Editing', error: 'Not saved', conflict: 'Changed in another tab' };
    const titles = { saved: 'All changes saved in this browser', conflict: 'Autosave is paused. Save to keep this version, or reload to see the other tab’s changes.' };
    this.saveStateEl.textContent = `· ${labels[state]}`;
    this.saveStateEl.title = titles[state] || '';
    // With a linked file, the file's state is what matters; the chip shows it.
    this.saveStateEl.hidden = Boolean(this.file) && state !== 'error' && state !== 'conflict';
  }

  renderFileChip() {
    const chip = this.fileChip;
    if (!chip) return;
    chip.hidden = !this.file;
    if (!this.file) return;
    const name = this.file.name;
    const state = this.fileSaving ? 'Saving…' : this.fileDirty ? 'Unsaved changes' : 'Saved';
    chip.classList.toggle('is-dirty', this.fileDirty);
    chip.innerHTML = `${icon('file')}<span class="file-chip-name"></span><span class="file-chip-state"></span>`;
    chip.querySelector('.file-chip-name').textContent = name;
    chip.querySelector('.file-chip-state').textContent = state;
    chip.title = this.fileDirty
      ? `Changes are kept in this browser but not yet in ${name}. Click or press ${shortcutLabel('Mod-S')} to save them to the file.`
      : `Linked to ${name} on this device. Save writes your changes back to it.`;
    chip.setAttribute('aria-label', `${name}: ${state}`);
    this.saveStateEl.hidden = this.saveState !== 'error' && this.saveState !== 'conflict';
  }

  markFileDirty() {
    if (!this.file) return;
    this.fileRev++;
    this.leaveConfirmed = false; // a new edit needs a new decision
    if (this.fileDirty) return;
    this.fileDirty = true;
    this.renderFileChip();
  }

  /** The file link as stored with the document (undefined leaves the stored link alone). */
  fileRecord() {
    return this.file ? { ...this.file, unsaved: this.fileDirty } : undefined;
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

  async saveNow(announce = false, { force = false } = {}) {
    this.queueSave.cancel();
    if (this.destroyed || !this.editor || this.unreadable) return;
    if (this.conflict) {
      // Keep this tab's version only when asked to, and only if it has edits of its own;
      // an untouched tab is just stale and must not overwrite the other tab's work.
      if (!force || !this.conflictDirty) {
        if (!force) this.conflictDirty = true;
        return;
      }
      this.conflict = false;
    }
    if (this.saving) {
      this.saveAgain = true;
      return this.saving;
    }
    this.setSaveState('saving');
    const rev = this.rev;
    const { state } = this.editor;
    const preview = state.doc.textBetween(0, Math.min(state.doc.content.size, 1200), ' ', ' ').replace(/\s+/g, ' ').trim().slice(0, 280);
    if (this.words == null) this.updateStats();
    this.saving = saveDoc(this.docId, { json: this.editor.getJSON(), preview, words: this.words, title: this.title, settings: this.settings, comments: this.comments, file: this.fileRecord() })
      .then((stored) => {
        if (stored === false) {
          // The document was deleted (e.g. from another tab): nothing was written.
          this.setSaveState('error');
          if (!this.docGone) toast('This document no longer exists in this browser. Use Save a Copy to keep your work.', { type: 'error', timeout: 8000 });
          this.docGone = true;
          return;
        }
        // Edits made while the write was in flight still need saving.
        if (this.conflict) this.setSaveState('conflict');
        else if (this.rev !== rev) {
          this.setSaveState('unsaved');
          this.queueSave();
        } else {
          this.setSaveState('saved');
          dropPending(this.docId);
        }
        this.savedAt = Date.now();
        this.maybeSnapshot();
        channel?.postMessage({ type: 'saved', id: this.docId, tab: TAB_ID });
        if (announce) toast('Saved to this device', { type: 'success', timeout: 1800 });
      })
      .catch((err) => {
        console.error(err);
        noteError(err, 'autosave');
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

  /** Version history: keep the opening state, then a snapshot every 10 minutes of editing. */
  async maybeSnapshot() {
    if (!this.userEdited) return;
    try {
      if (!this.openSnapshotted) {
        this.openSnapshotted = true;
        this.lastVersionAt = Date.now();
        const o = this.openState;
        if (o.json || (o.html && o.html !== '<p></p>')) await addVersion(this.docId, { ...o, reason: 'opened' });
      } else if (Date.now() - this.lastVersionAt > 10 * 60 * 1000) {
        this.lastVersionAt = Date.now();
        await addVersion(this.docId, this.currentState('auto'));
      }
    } catch (err) {
      console.warn('Version snapshot failed', err);
    }
  }

  currentState(reason) {
    return { title: this.title, json: this.editor.getJSON(), settings: this.settings, comments: this.comments, words: this.words ?? 0, createdAt: Date.now(), reason };
  }

  async restoreVersion(vid) {
    const v = await getVersion(vid);
    if (!v) return;
    if (this.unreadable) {
      // Only a version this build can show lifts read-only mode.
      try {
        if (v.json) this.editor.schema.nodeFromJSON(v.json).check();
      } catch {
        toast('This version also uses features this version of LibreWord can’t show.', { type: 'error', timeout: 6000 });
        return;
      }
      this.unreadable = false;
      this.editor.setEditable(true);
    } else {
      await this.flush();
      await addVersion(this.docId, this.currentState('before-restore'));
    }
    this.comments = v.comments || {};
    this.settings = { ...this.settings, ...(v.settings || {}) };
    this.editor.commands.setContent(v.json || sanitizeHtml(v.html) || '<p></p>', { emitUpdate: true });
    this.rename(v.title || this.title);
    this.applyGeometry();
    this.ruler.render();
    this.commentsPane.render();
    this.applyView();
    await this.saveNow();
    toast(`Restored the version from ${new Date(v.createdAt).toLocaleString()}`, { type: 'success' });
  }

  async openVersionAsCopy(vid) {
    const v = await getVersion(vid);
    if (!v) return;
    const id = await createDoc({ title: `${v.title || this.title} (${new Date(v.createdAt).toLocaleDateString()})`, json: v.json, html: v.html, settings: v.settings, comments: v.comments });
    this.nav_.onOpenDoc(id);
  }

  /** Write pending edits now. `force` also writes over a newer save from another tab. */
  async flush({ force = false } = {}) {
    if (this.destroyed || !this.editor) return;
    for (let i = 0; i < 5; i++) {
      this.queueSave.cancel();
      if (this.saving) {
        await this.saving;
        continue;
      }
      // Retrying straight after a failed write (e.g. the document was deleted) won't help.
      if (this.saveState === 'saved' || (i > 0 && this.saveState === 'error') || (this.conflict && !(force && this.conflictDirty))) break;
      await this.saveNow(false, { force });
    }
  }

  rename(title) {
    const t = title.trim() || 'Untitled document';
    if (t !== this.title && ['docx', 'html'].includes(this.file?.format)) this.markFileDirty();
    this.title = t;
    this.titleInput.value = t;
    this.updateTitle();
    return this.saveNow();
  }

  updateSettings(partial, { transient = false } = {}) {
    this.settings = { ...this.settings, ...partial, margins: { ...this.settings.margins, ...(partial.margins || {}) } };
    this.applyGeometry();
    this.ruler.render();
    this.ribbon.update();
    if (!transient) {
      this.markFileDirty();
      this.saveNow();
    }
  }

  // ------------------------------------------------------------------ view
  applyView() {
    this.pageStack.classList.toggle('web-layout', this.view.layout === 'web');
    this.canvas.classList.toggle('no-ruler', !this.view.ruler || this.view.layout === 'web');
    this.screen.classList.toggle('show-marks', this.view.marks);
    this.nav.el.hidden = !this.view.nav;
    this.commentsPane.el.hidden = !this.view.comments || !this.hasComments();
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
    toggleTheme();
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
    // Zoomed text can round to slightly different line heights; lay out again.
    else if (old !== zoom) this.editor?.commands.repaginate();
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

  // ------------------------------------------------------------------ files on the device
  /** Ctrl+S: write to the linked file, or keep the browser copy up to date. */
  /** Apply a title that's still being typed (the input only fires 'change' on blur). */
  commitTitle() {
    const typed = this.titleInput.value.trim() || 'Untitled document';
    if (typed !== this.title) this.rename(typed);
  }

  async save() {
    this.commitTitle();
    if (this.file) return this.saveToFile();
    if (this.conflict && !this.conflictDirty) {
      toast('This tab has no changes of its own to save. Reload to see the other tab’s changes.', {
        timeout: 8000,
        action: { label: 'Reload', run: () => !this.destroyed && this.nav_.onOpenDoc(this.docId, { force: true }) },
      });
      return false;
    }
    await this.saveNow(false, { force: true });
    toast(canSaveToFiles() ? `Saved in this browser. Use Save As (${shortcutLabel('Mod-Shift-S')}) to save it as a file.` : 'Saved in this browser.', { type: 'success', timeout: 2600 });
    return true;
  }

  fileMeta() {
    return { title: this.title, settings: this.settings, comments: this.comments };
  }

  /** Write the document to its linked file. Resolves true when the file is up to date. */
  async saveToFile() {
    if (this.unreadable) return false;
    if (!this.file) return this.saveAs();
    if (this.fileSaving) return (await this.fileSaving) === true;
    // run() resolves true/false, or { saveAs } when the user chose to save elsewhere.
    const run = async () => {
      const { handle, name, format } = this.file;
      if (!(await ensureWritePermission(handle))) {
        toast(`LibreWord wasn't allowed to save to “${name}”. Use Save As to choose where to save.`, { type: 'error', timeout: 6000 });
        return false;
      }
      // Another LibreWord tab may have saved this document to the file since;
      // that's not an outside change, so pick up its record first.
      const stored = await getDocFile(this.docId).catch(() => null);
      if (stored?.lastModified > (this.file.lastModified || 0)) {
        try {
          if (await stored.handle.isSameEntry(handle)) this.file = { ...this.file, lastModified: stored.lastModified };
        } catch { /* different file */ }
      }
      // Someone else (another app) changed the file since we read or wrote it.
      let current;
      try {
        current = await handle.getFile();
      } catch (err) {
        if (err?.name === 'NotFoundError') {
          toast(`“${name}” was moved or deleted. Choose where to save it.`, { type: 'error', timeout: 6000 });
          return { saveAs: {} };
        }
        throw err;
      }
      if (this.file.lastModified && current.lastModified > this.file.lastModified + 1000) {
        const choice = await openDialog({
          title: 'File changed on disk',
          body: h('p', {}, `“${name}” was changed outside LibreWord after you opened it. Saving will replace those changes with your version.`),
          buttons: [
            { label: 'Cancel', value: null },
            { label: 'Save a Copy…', value: 'copy' },
            { label: 'Replace', value: 'replace', primary: true },
          ],
        });
        if (choice === 'copy') return { saveAs: {} };
        if (choice !== 'replace') return false;
      }
      if (!FILE_FORMATS[format].lossless && !this.lossyAcknowledged) {
        const choice = await openDialog({
          title: `Keep using ${FILE_FORMATS[format].label}?`,
          body: h('p', {}, `${LOSSY_NOTES[format]} To keep everything, save as a Word document instead. Your full document stays in LibreWord either way.`),
          buttons: [
            { label: 'Cancel', value: null },
            { label: 'Save as Word Document…', value: 'docx' },
            { label: `Keep ${FILE_FORMATS[format].label}`, value: 'keep', primary: true },
          ],
        });
        if (choice === 'docx') return { saveAs: { format: 'docx' } };
        if (choice !== 'keep') return false;
        this.lossyAcknowledged = true;
      }
      const fileRev = this.fileRev;
      await this.flush({ force: true });
      const blob = await renderDocumentBlob(this.editor, format, this.fileMeta());
      const lastModified = await writeToHandle(handle, blob);
      this.file = { ...this.file, lastModified };
      // Changes made while writing (text, comments, settings) still need the next save.
      this.fileDirty = this.fileRev !== fileRev;
      await saveDoc(this.docId, { file: this.fileRecord() });
      toast(`Saved to “${name}”`, { type: 'success', timeout: 1800 });
      return true;
    };
    this.fileSaving = run()
      .catch((err) => {
        console.error(err);
        noteError(err, `saving to ${this.file?.format || 'file'}`);
        toast(`Couldn't save “${this.file?.name}”: ${err.message || err}`, { type: 'error', timeout: 6000 });
        return false;
      })
      .finally(() => {
        this.fileSaving = null;
        this.renderFileChip();
      });
    this.renderFileChip();
    const result = await this.fileSaving;
    if (result && typeof result === 'object' && result.saveAs) return this.saveAs(result.saveAs);
    return result === true;
  }

  /**
   * Save to a new file the user picks, and keep saving there. Without the File
   * System Access API, this downloads a .docx copy instead.
   */
  async saveAs({ format = this.file?.format || 'docx' } = {}) {
    if (this.unreadable) return false;
    this.commitTitle();
    if (!canSaveToFiles()) {
      await this.exportAs('docx');
      toast('This browser can’t save straight to files, so a copy was downloaded. Chrome and Edge can save back to the same file.', { timeout: 6000 });
      return false;
    }
    let handle;
    try {
      handle = await pickSaveLocation(fileNameFor(this.title, format), format);
    } catch (err) {
      toast(`Couldn't open the save dialog: ${err.message || err}`, { type: 'error' });
      return false;
    }
    if (!handle) return false;
    const previous = { file: this.file, dirty: this.fileDirty, lossy: this.lossyAcknowledged };
    const chosen = formatOfName(handle.name) || 'docx';
    this.file = { handle, name: handle.name, format: chosen, lastModified: 0 };
    this.fileDirty = true;
    this.lossyAcknowledged = false;
    this.setSaveState(this.saveState);
    const ok = await this.saveToFile();
    if (!ok && this.file?.handle === handle) {
      // Nothing was written: keep the document linked where it was before.
      this.file = previous.file;
      this.fileDirty = previous.dirty;
      this.lossyAcknowledged = previous.lossy;
      this.setSaveState(this.saveState);
      this.renderFileChip();
    }
    return ok;
  }

  /** Stop writing to the linked file; the document stays in the browser. */
  async unlinkFile() {
    if (!this.file) return;
    const name = this.file.name;
    this.file = null;
    this.fileDirty = false;
    this.renderFileChip();
    this.setSaveState(this.saveState);
    await saveDoc(this.docId, { file: null });
    toast(`No longer saving to “${name}”. Your document stays in LibreWord.`);
  }

  /**
   * Before leaving this document: offer to save unsaved changes to the linked
   * file (like Word on close). Resolves false if the user cancels. "Don't Save"
   * leaves the file as it is; the changes stay in LibreWord, still marked unsaved.
   */
  async confirmLeave() {
    if (this.leaveConfirmed || this.destroyed || !this.fileDirty || !this.file) return true;
    const choice = await openDialog({
      title: 'Save changes?',
      body: h('p', {}, `Do you want to save your changes to “${this.file.name}”? Either way they stay in LibreWord.`),
      buttons: [
        { label: 'Cancel', value: null },
        { label: 'Don’t Save', value: 'discard' },
        { label: 'Save', value: 'save', primary: true },
      ],
    });
    if (choice === null) return false;
    if (choice === 'save' && !(await this.saveToFile())) return false;
    this.leaveConfirmed = true;
    return true;
  }

  /** Run `go` once leaving is confirmed. */
  async leaveDocument(go) {
    if (!(await this.confirmLeave())) return false;
    go();
    return true;
  }

  async exportAs(format) {
    try {
      await this.flush();
      if (format === 'pdf') toast('Choose “Save as PDF” as the printer to create a PDF.', { timeout: 4500 });
      await exportDocument(this.editor, format, { title: this.title, settings: this.settings, comments: this.comments });
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
    if (!ok) toast(`Use ${shortcutLabel(kind === 'cut' ? 'Mod-X' : 'Mod-C')} to ${kind}.`);
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
      toast(`Your browser blocked clipboard access. Press ${shortcutLabel('Mod-V')} to paste.`, { timeout: 4500 });
    }
  }

  handleFiles(files, pos, dataTransfer = null) {
    const images = [...(files || [])].filter((f) => f.type.startsWith('image/'));
    if (!images.length) {
      const docs = [...(files || [])].filter((f) => canOpen(f.name));
      if (docs.length && pos != null) {
        // Dropping a document opens it (linked to the file where the browser allows).
        handleFromDataTransfer(dataTransfer, docs[0]).then((handle) => this.leaveDocument(() => this.nav_.onImport(docs[0], handle?.kind === 'file' ? handle : null)));
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
    const list = h('div', { class: 'menu', role: 'group', 'aria-label': 'Available formats', style: { minWidth: '320px' } });
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
    this.painterMarks = marks.filter((m) => !KEEP_MARKS.has(m.type.name)).map((m) => ({ type: m.type.name, attrs: m.attrs }));
    this.painterActive = true;
    this.editorEl.classList.add('painter-active');
    this.ribbon.update();
    const onUp = () => {
      setTimeout(() => {
        if (!this.painterActive) return;
        const { empty } = ed.state.selection;
        if (empty) return;
        const chain = ed.chain().focus().unsetFormattingMarks();
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

  // ------------------------------------------------------------------ comments
  hasComments() {
    if (!this.editor) return Object.keys(this.comments).length > 0;
    let found = false;
    this.editor.state.doc.descendants((n) => {
      if (found) return false;
      if (n.isText && n.marks.some((m) => m.type.name === 'comment')) found = true;
      return !found;
    });
    return found;
  }

  get authorName() {
    try {
      return localStorage.getItem('lw:author') || '';
    } catch {
      return '';
    }
  }

  /** The commenter's name, asking once. Resolves to null if the user cancels. */
  async ensureAuthor() {
    if (this.authorName) return this.authorName;
    const r = await promptDialog({
      title: 'Your name',
      fields: [{ name: 'name', label: 'Name', value: '', placeholder: 'Shown on your comments', hint: 'Stored only in this browser.' }],
      confirmLabel: 'Continue',
    });
    if (!r) return null;
    const name = r.name?.trim() || 'Author';
    try {
      localStorage.setItem('lw:author', name);
    } catch { /* ignore */ }
    return name;
  }

  async addComment() {
    const ed = this.editor;
    const author = await this.ensureAuthor();
    if (!author) return;
    const id = `c${newId().replace(/-/g, '').slice(0, 12)}`;
    if (!ed.chain().focus().setComment(id).run()) {
      toast('Select some text to comment on.');
      return;
    }
    this.comments = { ...this.comments, [id]: { id, author, initials: initialsOf(author), date: Date.now(), text: '', replies: [], resolved: false } };
    this.view.comments = true;
    this.applyView();
    this.commentsPane.el.hidden = false;
    this.commentsPane.render({ focusId: id });
    this.ribbon.update();
  }

  commentsChanged() {
    this.commentsPane.render();
    this.applyView();
    this.ribbon.update();
    this.markFileDirty();
    this.saveNow();
  }

  updateComment(id, patch) {
    if (!this.comments[id]) return;
    this.comments = { ...this.comments, [id]: { ...this.comments[id], ...patch } };
    this.commentsChanged();
  }

  resolveComment(id, resolved = true) {
    this.updateComment(id, { resolved });
  }

  async replyToComment(id, text) {
    const author = await this.ensureAuthor();
    const c = this.comments[id];
    if (!author || !c) return;
    this.updateComment(id, { replies: [...(c.replies || []), { author, initials: initialsOf(author), date: Date.now(), text }] });
  }

  deleteComment(id) {
    // The thread itself stays (unlisted, since nothing in the document refers
    // to it) so that undoing the deletion restores the comment, not just its
    // highlight. Orphaned threads are dropped the next time the document opens.
    this.editor.commands.unsetComment(id);
    this.commentsChanged();
  }

  deleteCurrentComment() {
    const [id] = [...this.commentsPane.active];
    if (id) this.deleteComment(id);
    else toast('Place the cursor inside a comment to delete it.');
  }

  toggleComments(force) {
    this.view.comments = force ?? !this.view.comments;
    this.applyView();
    if (this.view.comments && !this.hasComments()) toast('This document has no comments yet.');
    this.commentsPane.render();
    this.ribbon.update();
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
    // Dialogs and the backstage handle their own keys, except Save, Print and Open,
    // which close the backstage and run (rather than falling through to the browser).
    if (this.destroyed || document.querySelector('dialog[open]')) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (this.closeBackstage) {
      if (!mod || !['s', 'p', 'o'].includes(key)) return;
      this.closeBackstage();
    }
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
    // F6 (Ctrl+F6 where the browser keeps F6 for its address bar) moves between
    // the document and the ribbon, the keyboard way out of the document, where
    // Tab types a tab character.
    if (e.key === 'F6' && !e.altKey) {
      e.preventDefault();
      if (this.editorEl.contains(document.activeElement)) {
        this.ribbon.el.querySelector('.ribbon-tab[aria-selected="true"]')?.focus();
      } else {
        this.editor.view.focus();
      }
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
    // Link and Go To act on the document, not on the title or search box being typed in.
    if (['k', 'g'].includes(key) && e.target.matches?.('input, textarea, select')) return;
    const handled = {
      s: () => (e.shiftKey ? this.saveAs() : this.save()),
      p: () => this.print(),
      f: () => (e.shiftKey ? null : this.openFind(false)),
      h: () => this.openFind(true),
      k: () => this.editLink(),
      o: () => this.openBackstage('open'),
      g: () => (e.shiftKey ? this.wordCountDialog() : this.goToPageDialog()),
      '/': () => this.shortcutsDialog(),
      '?': () => this.shortcutsDialog(),
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

