import { getDoc, updateDoc } from './database';
import { escapeHtml, safeFileName, sanitizeDocumentHtml } from './documentHtml';
import Quill from 'quill';
import 'quill/dist/quill.snow.css';
import html2pdf from 'html2pdf.js';
import { saveAs } from 'file-saver';

let LineHeightStyle = null;
try {
  const Parchment = Quill.import('parchment');
  if (Parchment && Parchment.Attributor && typeof Parchment.Attributor.Style === 'function') {
    LineHeightStyle = new Parchment.Attributor.Style('lineheight', 'line-height', {
      scope: Parchment.Scope.BLOCK,
      whitelist: ['1', '1.2', '1.5', '2']
    });
    Quill.register(LineHeightStyle, true);
  }
} catch (e) {
  console.warn('LineHeightStyle init skipped:', e);
}

const MENU_CONFIG = {
  file: [
    { label: 'New Document', shortcut: 'Ctrl+N', action: 'newDoc' },
    { label: 'Import...', shortcut: 'Ctrl+O', action: 'importDoc' },
    { type: 'separator' },
    { label: 'Export as PDF', action: 'export', args: 'pdf' },
    { label: 'Export as Word (.doc)', action: 'export', args: 'doc' },
    { label: 'Export as HTML', action: 'export', args: 'html' },
    { label: 'Export as Text', action: 'export', args: 'txt' },
    { type: 'separator' },
    { label: 'Print...', shortcut: 'Ctrl+P', action: 'print' },
  ],
  edit: [
    { label: 'Undo', shortcut: 'Ctrl+Z', action: 'undo' },
    { label: 'Redo', shortcut: 'Ctrl+Y', action: 'redo' },
    { type: 'separator' },
    { label: 'Cut', shortcut: 'Ctrl+X', action: 'cut' },
    { label: 'Copy', shortcut: 'Ctrl+C', action: 'copy' },
    { label: 'Paste', shortcut: 'Ctrl+V', action: 'paste' },
    { label: 'Select All', shortcut: 'Ctrl+A', action: 'selectAll' },
    { type: 'separator' },
    { label: 'Find & Replace', shortcut: 'Ctrl+H', action: 'findReplace' },
  ],
  insert: [
    { label: 'Image...', action: 'insertImage' },
    { label: 'Link...', shortcut: 'Ctrl+K', action: 'insertLink' },
    { type: 'separator' },
    { label: 'Table...', action: 'insertTable' },
    { type: 'separator' },
    { label: 'Page Break', shortcut: 'Ctrl+Enter', action: 'pageBreak' },
    { label: 'Horizontal Rule', action: 'horizontalRule' },
    { type: 'separator' },
    { label: 'Date & Time', action: 'insertDateTime' },
  ],
  format: [
    { label: 'Bold', shortcut: 'Ctrl+B', action: 'format', args: 'bold' },
    { label: 'Italic', shortcut: 'Ctrl+I', action: 'format', args: 'italic' },
    { label: 'Underline', shortcut: 'Ctrl+U', action: 'format', args: 'underline' },
    { label: 'Strikethrough', action: 'format', args: 'strike' },
    { type: 'separator' },
    { label: 'Superscript', action: 'format', args: ['script', 'super'] },
    { label: 'Subscript', action: 'format', args: ['script', 'sub'] },
    { type: 'separator' },
    { label: 'Clear Formatting', action: 'clearFormat' },
  ],
  view: [
    { label: 'Ruler', type: 'toggle', id: 'toggle-ruler', checked: true, action: 'toggleRuler' },
    { type: 'separator' },
    { label: 'Zoom In', shortcut: 'Ctrl+=', action: 'zoomIn' },
    { label: 'Zoom Out', shortcut: 'Ctrl+-', action: 'zoomOut' },
    { label: 'Reset Zoom', shortcut: 'Ctrl+0', action: 'zoomReset' },
    { type: 'separator' },
    { label: 'Full Screen', shortcut: 'F11', action: 'fullScreen' },
  ],
  help: [
    { label: 'Keyboard Shortcuts', shortcut: 'Ctrl+/', action: 'showShortcuts' },
    { type: 'separator' },
    { label: 'About LibreWord', action: 'about' },
  ],
};

const CONTEXT_MENU_ITEMS = [
  { label: 'Cut', shortcut: 'Ctrl+X', action: 'cut' },
  { label: 'Copy', shortcut: 'Ctrl+C', action: 'copy' },
  { label: 'Paste', shortcut: 'Ctrl+V', action: 'paste' },
  { type: 'separator' },
  { label: 'Select All', action: 'selectAll' },
  { type: 'separator' },
  { label: 'Bold', shortcut: 'Ctrl+B', action: 'format', args: 'bold' },
  { label: 'Italic', shortcut: 'Ctrl+I', action: 'format', args: 'italic' },
  { label: 'Underline', shortcut: 'Ctrl+U', action: 'format', args: 'underline' },
  { type: 'separator' },
  { label: 'Find & Replace', shortcut: 'Ctrl+H', action: 'findReplace' },
];

export default class {
  constructor(docId) {
    this.docId = docId;
    this.currentZoom = 100;
    this.rulerVisible = true;
    this.activeMenu = null;
    this.destroyed = false;
    this.pendingSave = Promise.resolve();
    this.exportStatusTimeout = null;
    this._boundCleanup = this.destroy.bind(this);
    this._boundKeydown = this._handleKeydown.bind(this);
    this._boundClick = this._handleDocClick.bind(this);
    this._boundSelectionChange = this._handleSelectionChange.bind(this);
    
    const container = document.createElement('div');
    container.setAttribute('spellcheck', 'true');
    document.querySelector('#editor-container').appendChild(container);

    this.quill = new Quill(container, {
      theme: 'snow',
      placeholder: 'Start writing your masterpiece...',
      modules: {
        toolbar: [
          [{ 'font': [] }, { 'size': ['small', false, 'large', 'huge'] }],
          ['bold', 'italic', 'underline', 'strike'],
          [{ 'color': [] }, { 'background': [] }],
          [{ 'script': 'sub' }, { 'script': 'super' }],
          [{ 'header': [1, 2, 3, false] }],
          [{ 'list': 'ordered' }, { 'list': 'bullet' }],
          [{ 'indent': '-1' }, { 'indent': '+1' }, { 'align': [] }],
          ...(LineHeightStyle ? [[{ 'lineheight': ['1', '1.2', '1.5', '2'] }]] : []),
          ['blockquote', 'code-block'],
          ['link', 'image', 'video'],
          ['table'],
          ['clean']
        ],
        table: true,
        history: {
          delay: 1000,
          maxStack: 200,
          userOnly: true
        }
      }
    });

    const toolbar = document.querySelector('.ql-toolbar');
    const toolbarTarget = document.querySelector('#toolbar-container');
    if (toolbar && toolbarTarget) {
      toolbarTarget.appendChild(toolbar);
    }

    window._lw = this;
    this.init();
  }

  async init() {
    const doc = await getDoc(this.docId);
    if (doc && doc.content) {
      this.quill.clipboard.dangerouslyPasteHTML(sanitizeDocumentHtml(doc.content));
    }

    this.updateStats();
    this.buildMenuBar();
    this.setupAutoSave();
    this.setupHandlers();
    this.setupFindReplace();
    this.setupZoomAndOrientation();
    this.setupContextMenu();
    this.setupHeaderButtons();
    this.setupViewModes();
    this.drawRuler();

    document.addEventListener('keydown', this._boundKeydown);
    document.addEventListener('click', this._boundClick);
    document.addEventListener('selectionchange', this._boundSelectionChange);
    window.addEventListener('beforeunload', this._boundCleanup);
  }

  async flushSave() {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }

    if (!this.quill) {
      await this.pendingSave;
      return;
    }

    const content = this.quill.root.innerHTML;
    this.pendingSave = updateDoc(this.docId, undefined, content);
    await this.pendingSave;
  }

  async flushDocumentState() {
    const titleInput = document.getElementById('doc-title');
    const title = titleInput && titleInput.value.trim() ? titleInput.value.trim() : 'Untitled Document';
    const content = this.quill ? this.quill.root.innerHTML : '';

    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }

    this.pendingSave = updateDoc(this.docId, title, content);
    await this.pendingSave;

    return { title, content };
  }

  async destroy() {
    if (this.destroyed) return;
    this.destroyed = true;

    document.removeEventListener('keydown', this._boundKeydown);
    document.removeEventListener('click', this._boundClick);
    document.removeEventListener('selectionchange', this._boundSelectionChange);
    window.removeEventListener('beforeunload', this._boundCleanup);

    if (this.exportStatusTimeout) {
      clearTimeout(this.exportStatusTimeout);
      this.exportStatusTimeout = null;
    }

    await this.flushSave();
    this.closeDialogOverlay();
    this.quill = null;
  }

  setExportStatus(message = '', color = '#94a3b8', timeout = 0) {
    const status = document.getElementById('export-status');
    if (!status) return;

    if (this.exportStatusTimeout) {
      clearTimeout(this.exportStatusTimeout);
      this.exportStatusTimeout = null;
    }

    status.textContent = message;
    status.style.color = color;

    if (timeout > 0) {
      this.exportStatusTimeout = setTimeout(() => {
        status.textContent = '';
        status.style.color = '';
        this.exportStatusTimeout = null;
      }, timeout);
    }
  }

  updateStats() {
    const text = this.quill.getText().trim();
    const wordCount = text ? text.split(/\s+/).filter(Boolean).length : 0;
    const charCount = text.length;

    const wordEl = document.getElementById('word-count');
    const charEl = document.getElementById('char-count');
    if (wordEl) wordEl.innerText = `Words: ${wordCount}`;
    if (charEl) charEl.innerText = `Characters: ${charCount}`;
    this.updateCursorPosition();
    this.updatePageInfo();
  }

  updatePageInfo() {
    const pageInfo = document.getElementById('page-info');
    if (!pageInfo || !this.quill) return;
    const ed = document.querySelector('.ql-editor');
    if (!ed) return;
    if (ed.classList.contains('web-layout')) {
      pageInfo.textContent = 'Continuous';
      return;
    }
    const isLandscape = ed.classList.contains('landscape');
    const pageHeightCm = isLandscape ? 21 : 29.7;
    const pageHpx = pageHeightCm * 37.8;
    const pages = Math.max(1, Math.ceil(ed.scrollHeight / pageHpx));
    pageInfo.textContent = pages === 1 ? '1 page' : `${pages} pages`;
  }

  updateCursorPosition() {
    const sel = this.quill.getSelection();
    const el = document.getElementById('cursor-position');
    if (!el) return;
    if (!sel) { el.innerText = ''; return; }
    const text = this.quill.getText(0, sel.index);
    const lines = text.split('\n');
    const ln = lines.length;
    const col = lines[lines.length - 1].length + 1;
    el.innerText = `Ln ${ln}, Col ${col}`;
  }

  setupAutoSave() {
    this.quill.on('text-change', () => {
      this.updateStats();
      const status = document.getElementById('save-status');
      if (status) {
        status.innerHTML = '<span class="status-dot" style="background: #fbbf24; box-shadow: 0 0 6px #fbbf24;"></span> Saving...';
      }
      if (this.saveTimeout) clearTimeout(this.saveTimeout);
      this.saveTimeout = setTimeout(async () => {
        this.saveTimeout = null;
        this.pendingSave = updateDoc(this.docId, undefined, this.quill.root.innerHTML);
        await this.pendingSave;
        if (status) {
          status.innerHTML = '<span class="status-dot" style="background: #10b981; box-shadow: 0 0 6px #10b981;"></span> Saved';
        }
      }, 1000);
    });
  }

  setupHeaderButtons() {
    const btnUndo = document.getElementById('btn-undo');
    const btnRedo = document.getElementById('btn-redo');
    if (btnUndo) btnUndo.onclick = () => { try { this.quill.history.undo(); } catch (e) { /* no history */ } };
    if (btnRedo) btnRedo.onclick = () => { try { this.quill.history.redo(); } catch (e) { /* no history */ } };
  }

  buildMenuBar() {
    const bar = document.getElementById('menu-bar');
    if (!bar) return;
    if (bar.children.length > 0) return;
    bar.innerHTML = '';

    Object.entries(MENU_CONFIG).forEach(([key, items]) => {
      const trigger = document.createElement('div');
      trigger.className = 'menu-trigger';
      trigger.textContent = key.charAt(0).toUpperCase() + key.slice(1);

      const dropdown = document.createElement('div');
      dropdown.className = 'menu-dropdown hidden';

      items.forEach(item => {
        if (item.type === 'separator') {
          const sep = document.createElement('div');
          sep.className = 'menu-separator';
          dropdown.appendChild(sep);
          return;
        }

        const row = document.createElement('div');
        row.className = 'menu-dropdown-item';

        let labelHtml = '';
        if (item.type === 'toggle' && item.checked) {
          labelHtml = '<span class="check-mark">\u2713</span>';
        } else if (item.type === 'toggle') {
          labelHtml = '<span class="check-mark"></span>';
        }
        labelHtml += item.label;

        row.innerHTML = `<span>${labelHtml}</span>${item.shortcut ? '<span class="shortcut">' + item.shortcut + '</span>' : ''}`;

        row.addEventListener('click', (e) => {
          e.stopPropagation();
          this.closeMenus();
          this.executeAction(item.action, item.args);
        });

        dropdown.appendChild(row);
      });

      trigger.appendChild(dropdown);

      trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.activeMenu === key) {
          this.closeMenus();
        } else {
          this.closeMenus();
          dropdown.classList.remove('hidden');
          trigger.classList.add('active');
          this.activeMenu = key;
        }
      });

      trigger.addEventListener('mouseenter', () => {
        if (this.activeMenu && this.activeMenu !== key) {
          this.closeMenus();
          dropdown.classList.remove('hidden');
          trigger.classList.add('active');
          this.activeMenu = key;
        }
      });

      bar.appendChild(trigger);
    });
  }

  closeMenus() {
    document.querySelectorAll('.menu-dropdown').forEach(d => d.classList.add('hidden'));
    document.querySelectorAll('.menu-trigger').forEach(t => t.classList.remove('active'));
    this.activeMenu = null;
  }

  closeDialogOverlay() {
    const overlay = document.getElementById('dialog-overlay');
    if (!overlay) return;
    if (overlay._closeHandler) {
      overlay.removeEventListener('click', overlay._closeHandler);
      overlay._closeHandler = null;
    }
    overlay.classList.add('hidden');
  }

  executeAction(action, args) {
    const actions = {
      newDoc: () => { if (window.LW) window.LW.newDoc(); },
      importDoc: () => { if (window.LW) window.LW.importDoc(); },
      export: (fmt) => this.doExport(fmt),
      print: () => window.print(),
      undo: () => { try { this.quill.history.undo(); } catch (e) {} },
      redo: () => { try { this.quill.history.redo(); } catch (e) {} },
      cut: () => document.execCommand('cut'),
      copy: () => document.execCommand('copy'),
      paste: () => document.execCommand('paste'),
      selectAll: () => this.quill.setSelection(0, this.quill.getLength()),
      findReplace: () => {
        const bar = document.getElementById('find-replace-bar');
        if (bar) { bar.classList.toggle('hidden'); if (!bar.classList.contains('hidden')) document.getElementById('find-input')?.focus(); }
      },
      insertImage: () => {
        const url = prompt('Enter image URL:');
        if (url) {
          const range = this.quill.getSelection(true);
          this.quill.insertEmbed(range.index, 'image', url);
          this.quill.setSelection(range.index + 1);
        }
      },
      insertLink: () => {
        const url = prompt('Enter link URL:');
        if (url) {
          const range = this.quill.getSelection(true);
          const text = this.quill.getText(range.index, range.length) || url;
          this.quill.deleteText(range.index, range.length);
          this.quill.insertText(range.index, text, 'link', url);
          this.quill.setSelection(range.index + text.length);
        }
      },
      insertTable: () => this.showTablePicker(),
      pageBreak: () => {
        const range = this.quill.getSelection(true);
        this.quill.clipboard.dangerouslyPasteHTML(
          range.index,
          '<div class="page-break"><br></div><p><br></p>'
        );
        this.quill.setSelection(range.index + 2);
      },
      horizontalRule: () => {
        const range = this.quill.getSelection(true);
        this.quill.insertEmbed(range.index, 'hr', true);
        this.quill.setSelection(range.index + 1);
      },
      insertDateTime: () => {
        const now = new Date();
        const str = now.toLocaleString();
        const range = this.quill.getSelection(true);
        this.quill.insertText(range.index, str);
        this.quill.setSelection(range.index + str.length);
      },
      format: (a) => {
        if (Array.isArray(a)) {
          this.quill.format(a[0], a[1]);
        } else {
          const currentFormat = this.quill.getFormat();
          this.quill.format(a, !currentFormat[a]);
        }
      },
      clearFormat: () => {
        const range = this.quill.getSelection();
        if (range) this.quill.removeFormat(range.index, range.length);
      },
      toggleRuler: () => {
        this.rulerVisible = !this.rulerVisible;
        const container = document.getElementById('ruler-container');
        if (container) container.style.display = this.rulerVisible ? 'flex' : 'none';
      },
      zoomIn: () => this.setZoom(this.currentZoom + 10),
      zoomOut: () => this.setZoom(this.currentZoom - 10),
      zoomReset: () => this.setZoom(100),
      fullScreen: () => {
        if (!document.fullscreenElement) {
          document.documentElement.requestFullscreen?.();
        } else {
          document.exitFullscreen?.();
        }
      },
      showShortcuts: () => this.showDialog('Keyboard Shortcuts', this.getShortcutsHtml()),
      about: () => this.showDialog('About LibreWord', this.getAboutHtml()),
    };

    const fn = actions[action];
    if (fn) fn(args);
  }

  doExport(fmt) {
    if (this.destroyed) return;
    const el = document.getElementById('export-format');
    if (el) { el.value = fmt; el.dispatchEvent(new Event('change')); }
  }

  showDialog(title, bodyHtml) {
    const overlay = document.getElementById('dialog-overlay');
    const box = document.getElementById('dialog-box');
    if (!overlay || !box) return;
    this.closeDialogOverlay();
    const close = () => {
      overlay.classList.add('hidden');
      if (overlay._closeHandler) {
        overlay.removeEventListener('click', overlay._closeHandler);
        overlay._closeHandler = null;
      }
    };
    box.innerHTML = `
      <div class="dialog-title">${escapeHtml(title)}</div>
      <div class="dialog-body">${bodyHtml}</div>
      <div class="dialog-actions">
        <button type="button" class="btn btn-primary dialog-close-btn">Close</button>
      </div>
    `;
    overlay.classList.remove('hidden');
    box.querySelector('.dialog-close-btn').onclick = close;
    overlay._closeHandler = (e) => { if (e.target === overlay) close(); };
    overlay.addEventListener('click', overlay._closeHandler);
  }

  getShortcutsHtml() {
    return `<table>
      <tr><td>Ctrl + B</td><td>Bold</td></tr>
      <tr><td>Ctrl + I</td><td>Italic</td></tr>
      <tr><td>Ctrl + U</td><td>Underline</td></tr>
      <tr><td>Ctrl + Z</td><td>Undo</td></tr>
      <tr><td>Ctrl + Y</td><td>Redo</td></tr>
      <tr><td>Ctrl + X</td><td>Cut</td></tr>
      <tr><td>Ctrl + C</td><td>Copy</td></tr>
      <tr><td>Ctrl + V</td><td>Paste</td></tr>
      <tr><td>Ctrl + A</td><td>Select All</td></tr>
      <tr><td>Ctrl + H</td><td>Find & Replace</td></tr>
      <tr><td>Ctrl + K</td><td>Insert Link</td></tr>
      <tr><td>Ctrl + P</td><td>Print</td></tr>
      <tr><td>Ctrl + N</td><td>New Document</td></tr>
      <tr><td>Ctrl + O</td><td>Import Document</td></tr>
      <tr><td>Ctrl + =</td><td>Zoom In</td></tr>
      <tr><td>Ctrl + -</td><td>Zoom Out</td></tr>
      <tr><td>Ctrl + 0</td><td>Reset Zoom</td></tr>
      <tr><td>Ctrl + Enter</td><td>Page Break</td></tr>
      <tr><td>F11</td><td>Full Screen</td></tr>
    </table>`;
  }

  getAboutHtml() {
    return `
      <div style="text-align:center;margin-bottom:16px;">
        <svg width="48" height="48" viewBox="0 0 32 32" fill="none" style="margin:0 auto;">
          <rect width="32" height="32" rx="8" fill="url(#abg)"/>
          <path d="M10 10H22V12H10V10ZM10 15H22V17H10V15ZM10 20H18V22H10V20Z" fill="white"/>
          <defs><linearGradient id="abg" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse"><stop stop-color="#38BDF8"/><stop offset="1" stop-color="#2563EB"/></linearGradient></defs>
        </svg>
      </div>
      <p style="text-align:center;font-size:1rem;font-weight:600;margin-bottom:8px;">LibreWord</p>
      <p style="text-align:center;">Premium Document System v1.0</p>
      <p style="text-align:center;margin-top:12px;">A modern, lightweight word processor<br>built for the web.</p>
    `;
  }

  showTablePicker() {
    const picker = document.getElementById('table-picker');
    const grid = document.getElementById('table-picker-grid');
    const label = document.getElementById('table-picker-label');
    if (!picker || !grid) return;

    grid.innerHTML = '';
    const maxRows = 6;
    const maxCols = 8;

    for (let r = 0; r < maxRows; r++) {
      for (let c = 0; c < maxCols; c++) {
        const cell = document.createElement('div');
        cell.className = 'table-picker-cell';
        cell.dataset.row = r;
        cell.dataset.col = c;

        cell.addEventListener('mouseenter', () => {
          grid.querySelectorAll('.table-picker-cell').forEach(el => {
            const er = parseInt(el.dataset.row);
            const ec = parseInt(el.dataset.col);
            el.classList.toggle('highlight', er <= r && ec <= c);
          });
          label.textContent = `${r + 1} x ${c + 1}`;
        });

        cell.addEventListener('click', () => {
          const rows = r + 1;
          const cols = c + 1;
          this.insertTable(rows, cols);
          picker.classList.add('hidden');
        });

        grid.appendChild(cell);
      }
    }

    label.textContent = '0 x 0';

    const toolbar = document.querySelector('#toolbar-container');
    if (toolbar) {
      picker.style.transform = '';
      const rect = toolbar.getBoundingClientRect();
      const pickerWidth = 220;
      const left = Math.min(rect.left + 300, window.innerWidth - pickerWidth - 16);
      picker.style.top = rect.bottom + 4 + 'px';
      picker.style.left = Math.max(16, left) + 'px';
    } else {
      picker.style.top = '120px';
      picker.style.left = '50%';
      picker.style.transform = 'translateX(-50%)';
    }

    picker.classList.remove('hidden');

    const close = (e) => {
      if (!picker.contains(e.target)) {
        picker.classList.add('hidden');
        document.removeEventListener('click', close);
      }
    };
    setTimeout(() => document.addEventListener('click', close), 10);
  }

  insertTable(rows, cols) {
    try {
      const tableModule = this.quill.getModule('table');
      if (tableModule && typeof tableModule.insertTable === 'function') {
        tableModule.insertTable(rows, cols);
        return;
      }
    } catch (e) { /* fallback */ }

    const range = this.quill.getSelection(true);
    if (!range) return;
    let tableHtml = '<table border="1" style="border-collapse:collapse;width:100%;">';
    for (let r = 0; r < rows; r++) {
      tableHtml += '<tr>';
      for (let c = 0; c < cols; c++) {
        tableHtml += '<td style="border:1px solid #d1d5db;padding:6px 10px;min-width:40px;"><br></td>';
      }
      tableHtml += '</tr>';
    }
    tableHtml += '</table><p><br></p>';
    this.quill.clipboard.dangerouslyPasteHTML(range.index, tableHtml);
    this.quill.setSelection(range.index + 1);
  }

  setupContextMenu() {
    const menu = document.getElementById('context-menu');
    if (!menu) return;

    this.quill.root.addEventListener('contextmenu', (e) => {
      if (this.destroyed) return;
      e.preventDefault();
      e.stopPropagation();

      menu.innerHTML = '';
      CONTEXT_MENU_ITEMS.forEach(item => {
        if (item.type === 'separator') {
          const sep = document.createElement('div');
          sep.className = 'context-separator';
          menu.appendChild(sep);
          return;
        }
        const row = document.createElement('div');
        row.className = 'context-menu-item';
        row.innerHTML = `<span>${item.label}</span>${item.shortcut ? '<span class="shortcut">' + item.shortcut + '</span>' : ''}`;
        row.addEventListener('click', (ev) => {
          ev.stopPropagation();
          menu.classList.add('hidden');
          this.executeAction(item.action, item.args);
        });
        menu.appendChild(row);
      });

      menu.style.left = Math.min(e.clientX, window.innerWidth - 220) + 'px';
      menu.style.top = Math.min(e.clientY, window.innerHeight - 300) + 'px';
      menu.classList.remove('hidden');
    });
  }

  _handleKeydown(e) {
    if (this.destroyed) return;

    if (e.key === 'Escape') {
      const overlay = document.getElementById('dialog-overlay');
      if (overlay && !overlay.classList.contains('hidden')) {
        this.closeDialogOverlay();
        return;
      }
      const picker = document.getElementById('table-picker');
      if (picker && !picker.classList.contains('hidden')) {
        picker.classList.add('hidden');
        return;
      }
      const findBar = document.getElementById('find-replace-bar');
      if (findBar && !findBar.classList.contains('hidden')) {
        findBar.classList.add('hidden');
        return;
      }
      const ctxMenu = document.getElementById('context-menu');
      if (ctxMenu && !ctxMenu.classList.contains('hidden')) {
        ctxMenu.classList.add('hidden');
        return;
      }
      this.closeMenus();
      return;
    }

    const ctrl = e.ctrlKey || e.metaKey;
    if (!ctrl && e.key !== 'F11') return;

    const key = e.key.toLowerCase();
    const keyMap = {
      'n': () => { e.preventDefault(); if (window.LW) window.LW.newDoc(); },
      'o': () => { e.preventDefault(); if (window.LW) window.LW.importDoc(); },
      'h': () => { e.preventDefault(); this.executeAction('findReplace'); },
      'k': () => { e.preventDefault(); this.executeAction('insertLink'); },
      '=': () => { e.preventDefault(); this.setZoom(this.currentZoom + 10); },
      '+': () => { e.preventDefault(); this.setZoom(this.currentZoom + 10); },
      '-': () => { e.preventDefault(); this.setZoom(this.currentZoom - 10); },
      '0': () => { e.preventDefault(); this.setZoom(100); },
      '/': () => { e.preventDefault(); this.executeAction('showShortcuts'); },
    };

    if (ctrl && key === 'enter') {
      e.preventDefault();
      this.executeAction('pageBreak');
    } else if (e.key === 'F11') {
      e.preventDefault();
      this.executeAction('fullScreen');
    } else if (keyMap[key]) {
      keyMap[key]();
    }
  }

  _handleDocClick() {
    if (this.destroyed) return;
    this.closeMenus();
    const menu = document.getElementById('context-menu');
    if (menu) menu.classList.add('hidden');
  }

  _handleSelectionChange() {
    if (!this.destroyed) this.updateCursorPosition();
  }

  setZoom(val) {
    this.currentZoom = Math.max(50, Math.min(200, val));
    const editor = document.querySelector('.ql-editor');
    const zoomText = document.getElementById('zoom-level');
    if (editor) {
      editor.style.transform = `scale(${this.currentZoom / 100})`;
      editor.style.transformOrigin = 'top center';
    }
    if (zoomText) zoomText.innerText = `${this.currentZoom}%`;
    this.drawRuler();
    this.updatePageInfo();
  }

  setupZoomAndOrientation() {
    const btnZoomIn = document.getElementById('btn-zoom-in');
    const btnZoomOut = document.getElementById('btn-zoom-out');
    const orientSelect = document.getElementById('page-orientation');

    if (btnZoomIn) btnZoomIn.onclick = () => this.setZoom(this.currentZoom + 10);
    if (btnZoomOut) btnZoomOut.onclick = () => this.setZoom(this.currentZoom - 10);

    if (orientSelect) {
      orientSelect.onchange = (e) => {
        const editor = document.querySelector('.ql-editor');
        if (editor) {
          editor.classList.toggle('landscape', e.target.value === 'landscape');
          this.drawRuler();
          this.updatePageInfo();
        }
      };
    }
  }

  setupViewModes() {
    const btnPrint = document.getElementById('btn-view-print');
    const btnWeb = document.getElementById('btn-view-web');

    if (btnPrint) {
      btnPrint.onclick = () => {
        const editor = document.querySelector('.ql-editor');
        if (editor) editor.classList.remove('web-layout');
        btnPrint.classList.add('active');
        btnWeb.classList.remove('active');
        this.updatePageInfo();
      };
    }

    if (btnWeb) {
      btnWeb.onclick = () => {
        const editor = document.querySelector('.ql-editor');
        if (editor) editor.classList.add('web-layout');
        btnWeb.classList.add('active');
        btnPrint.classList.remove('active');
        this.updatePageInfo();
      };
    }
  }

  drawRuler() {
    const canvas = document.getElementById('ruler-canvas');
    if (!canvas || !this.rulerVisible) return;
    const ctx = canvas.getContext('2d');

    const isLandscape = document.querySelector('.ql-editor')?.classList.contains('landscape');
    const pageWidthCm = isLandscape ? 29.7 : 21;
    const scale = this.currentZoom / 100;
    const pxPerCm = 37.8 * scale;
    const width = Math.ceil(pageWidthCm * pxPerCm);
    const height = 24;

    canvas.width = width;
    canvas.height = height;

    ctx.fillStyle = '#141c2b';
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = '#475569';
    ctx.fillStyle = '#64748b';
    ctx.font = '9px Inter, sans-serif';
    ctx.textAlign = 'center';

    for (let mm = 0; mm <= pageWidthCm * 10; mm++) {
      const x = (mm / 10) * pxPerCm;
      if (mm % 10 === 0) {
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, 14);
        ctx.lineTo(x, height);
        ctx.stroke();
        if (mm > 0) {
          ctx.fillText(String(mm / 10), x, 11);
        }
      } else if (mm % 5 === 0) {
        ctx.lineWidth = 0.7;
        ctx.beginPath();
        ctx.moveTo(x, 17);
        ctx.lineTo(x, height);
        ctx.stroke();
      } else {
        ctx.lineWidth = 0.4;
        ctx.beginPath();
        ctx.moveTo(x, 20);
        ctx.lineTo(x, height);
        ctx.stroke();
      }
    }

    const container = document.getElementById('ruler-container');
    if (container) {
      container.scrollLeft = Math.max(0, (container.scrollWidth - container.clientWidth) / 2);
    }
  }

  setupHandlers() {
    const btnPrint = document.getElementById('btn-print');
    const selectExport = document.getElementById('export-format');

    if (btnPrint) {
      btnPrint.onclick = () => window.print();
    }

    if (selectExport) {
      selectExport.onchange = async (e) => {
        const format = e.target.value;
        if (!format) return;

        try {
          selectExport.disabled = true;
          this.setExportStatus('Exporting...', '#38bdf8');

          const { title, content } = await this.flushDocumentState();
          const fileName = safeFileName(title);
          const escapedTitle = escapeHtml(title);
          const safeHtml = sanitizeDocumentHtml(content);
          let exportedLabel = 'file';

          if (format === 'pdf') {
            exportedLabel = 'PDF';
            const element = document.querySelector('.ql-editor');
            if (!element) throw new Error('Editor content is not available for PDF export.');
            const orientation = document.getElementById('page-orientation')?.value || 'portrait';
            const opt = {
              margin: [0.5, 0.5],
              filename: `${fileName}.pdf`,
              image: { type: 'jpeg', quality: 0.98 },
              html2canvas: { scale: 2, useCORS: true },
              jsPDF: { unit: 'in', format: 'letter', orientation }
            };
            await html2pdf().set(opt).from(element).save();
          } else if (format === 'txt') {
            exportedLabel = 'text';
            const text = this.quill.getText();
            const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
            saveAs(blob, `${fileName}.txt`);
          } else if (format === 'html') {
            exportedLabel = 'HTML';
            const style = '<style>body{font-family:sans-serif;padding:2cm;line-height:1.6;max-width:21cm;margin:auto;}</style>';
            const blob = new Blob([`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapedTitle}</title>${style}</head><body>${safeHtml}</body></html>`], { type: 'text/html;charset=utf-8' });
            saveAs(blob, `${fileName}.html`);
          } else if (format === 'doc' || format === 'docx') {
            exportedLabel = 'Word';
            const docHtml = `<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
            <head><meta charset='utf-8'><title>${escapedTitle}</title></head>
            <body>${safeHtml}</body></html>`;
            const blob = new Blob(['\ufeff', docHtml], { type: 'application/msword;charset=utf-8' });
            saveAs(blob, `${fileName}.doc`);
          } else {
            throw new Error(`Unsupported export format: ${format}`);
          }

          this.setExportStatus(`Exported ${exportedLabel}`, '#10b981', 2500);
        } catch (err) {
          console.error('Export error:', err);
          this.setExportStatus('Export failed', '#ef4444', 6000);
        } finally {
          selectExport.disabled = false;
          e.target.value = '';
        }
      };
    }
  }

  setupFindReplace() {
    const btnFR = document.getElementById('btn-find-replace');
    const frBar = document.getElementById('find-replace-bar');
    const btnClose = document.getElementById('btn-close-find');
    const findInput = document.getElementById('find-input');
    const replaceInput = document.getElementById('replace-input');
    const btnNext = document.getElementById('btn-find-next');
    const btnPrev = document.getElementById('btn-find-prev');
    const btnReplace = document.getElementById('btn-replace');
    const btnReplaceAll = document.getElementById('btn-replace-all');
    const findCount = document.getElementById('find-count');

    let matches = [];
    let currentIndex = -1;

    const updateFind = () => {
      const query = findInput.value;
      if (!query) {
        matches = [];
        currentIndex = -1;
        findCount.innerText = '0/0';
        return;
      }

      const text = this.quill.getText();
      matches = [];
      let index = text.toLowerCase().indexOf(query.toLowerCase());
      while (index !== -1) {
        matches.push(index);
        index = text.toLowerCase().indexOf(query.toLowerCase(), index + 1);
      }

      if (matches.length > 0) {
        if (currentIndex === -1) currentIndex = 0;
        else if (currentIndex >= matches.length) currentIndex = matches.length - 1;
        findCount.innerText = `${currentIndex + 1}/${matches.length}`;
        this.highlightMatch(matches[currentIndex], query.length);
      } else {
        currentIndex = -1;
        findCount.innerText = '0/0';
      }
    };

    btnFR.onclick = () => {
      frBar.classList.toggle('hidden');
      if (!frBar.classList.contains('hidden')) findInput.focus();
    };

    btnClose.onclick = () => frBar.classList.add('hidden');
    findInput.oninput = updateFind;

    btnNext.onclick = () => {
      if (matches.length === 0) return;
      currentIndex = (currentIndex + 1) % matches.length;
      findCount.innerText = `${currentIndex + 1}/${matches.length}`;
      this.highlightMatch(matches[currentIndex], findInput.value.length);
    };

    btnPrev.onclick = () => {
      if (matches.length === 0) return;
      currentIndex = (currentIndex - 1 + matches.length) % matches.length;
      findCount.innerText = `${currentIndex + 1}/${matches.length}`;
      this.highlightMatch(matches[currentIndex], findInput.value.length);
    };

    btnReplace.onclick = () => {
      if (currentIndex === -1) return;
      const query = findInput.value;
      const replacement = replaceInput.value;
      this.quill.deleteText(matches[currentIndex], query.length);
      this.quill.insertText(matches[currentIndex], replacement);
      updateFind();
    };

    btnReplaceAll.onclick = () => {
      const query = findInput.value;
      const replacement = replaceInput.value;
      if (!query) return;

      const text = this.quill.getText();
      let offset = 0;
      const lowerQuery = query.toLowerCase();
      const lowerText = text.toLowerCase();
      let searchStart = 0;

      for (let i = 0; ; i++) {
        const idx = lowerText.indexOf(lowerQuery, searchStart);
        if (idx === -1) break;
        const adjustedIdx = idx + offset;
        this.quill.deleteText(adjustedIdx, query.length);
        this.quill.insertText(adjustedIdx, replacement);
        offset += (replacement.length - query.length);
        searchStart = idx + query.length;
      }
      updateFind();
    };
  }

  highlightMatch(index, length) {
    this.quill.setSelection(index, length);
    const bounds = this.quill.getBounds(index);
    const container = document.querySelector('.editor-main-container');
    if (bounds && container) {
      container.scrollTop = bounds.top + container.scrollTop - 200;
    }
  }
}
