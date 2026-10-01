import { h, formatDate, toast, debounce, showPopover, menu, downloadBlob } from './dom.js';
import { icon } from './icons.js';
import { listDocs, deleteDoc, duplicateDoc, renameDoc, exportBackup, importBackup } from '../storage/db.js';
import { TEMPLATES } from '../templates.js';
import { sanitizeHtml, IMPORT_ACCEPT } from '../io/import.js';
import { confirmDialog, promptDialog } from './dialog.js';

export function templateCards({ onTemplate, onImport }) {
  const row = h('div', { class: 'template-row' });
  for (const t of TEMPLATES) {
    const thumb = h('div', { class: 'template-thumb' });
    const docEl = h('div', { class: 'thumb-doc lw-document', html: sanitizeHtml(t.html()) });
    thumb.append(docEl);
    // Scale the 816px-wide page down to the thumbnail width once it is laid out.
    requestAnimationFrame(() => {
      const w = thumb.clientWidth || 148;
      docEl.style.transform = `scale(${w / 816})`;
    });
    row.append(
      h('button', { type: 'button', class: 'template-card', onclick: () => onTemplate(t), 'aria-label': `New ${t.name}` }, thumb, h('span', { class: 'label' }, t.name)),
    );
  }
  if (onImport) {
    row.append(
      h(
        'button',
        { type: 'button', class: 'template-card is-import', onclick: onImport, 'aria-label': 'Open a file from your device' },
        h('div', { class: 'template-thumb', html: `<div style="display:grid;justify-items:center;gap:8px">${icon('upload', 'icon icon-lg')}<span style="font-size:13px">.docx · .md · .txt · .html</span></div>` }),
        h('span', { class: 'label' }, 'Open from device…'),
      ),
    );
  }
  return row;
}

export function pickFile(accept = IMPORT_ACCEPT) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, style: { display: 'none' } });
    input.addEventListener('change', () => {
      resolve(input.files?.[0] || null);
      input.remove();
    });
    document.body.append(input);
    input.click();
  });
}

/**
 * The document list. Returns an element plus a refresh() function.
 */
export function documentList({ onOpen, compact = false }) {
  const wrap = h('div', {});
  const filter = h('input', { type: 'search', placeholder: 'Search documents', 'aria-label': 'Search documents' });
  const more = h('button', { type: 'button', class: 'icon-btn', title: 'Backup & restore', 'aria-label': 'Backup and restore', html: icon('more') });
  more.addEventListener('click', () => showPopover(more, menu([
    { label: 'Back Up All Documents', icon: 'download', run: backup },
    { label: 'Restore From Backup…', icon: 'upload', run: restore },
  ], { iconFn: (n) => icon(n) }), { placement: 'bottom-end' }));
  const header = h(
    'div',
    { class: 'start-section-title' },
    h('h2', {}, 'Recent'),
    h('div', { class: 'doc-toolbar' }, h('label', { class: 'doc-filter', html: icon('search') }, filter), compact ? null : more),
  );
  const body = h('div', {});
  wrap.append(header, body);
  let docs = [];

  const render = () => {
    const q = filter.value.trim().toLowerCase();
    const shown = q ? docs.filter((d) => d.title.toLowerCase().includes(q) || (d.preview || '').toLowerCase().includes(q)) : docs;
    body.replaceChildren();
    if (!docs.length) {
      body.append(h('div', { class: 'empty-state', html: `${icon('file', 'icon')}<p>No documents yet. Pick a template above to get started.</p>` }));
      return;
    }
    if (!shown.length) {
      body.append(h('div', { class: 'empty-state' }, h('p', {}, `No documents match “${filter.value}”.`)));
      return;
    }
    const table = h('table', { class: 'doc-table' });
    table.append(h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', { class: 'col-date' }, 'Modified'), h('th', { class: 'col-date' }, 'Words'), h('th', {}, h('span', { class: 'visually-hidden' }, 'Actions')))));
    const tbody = h('tbody', {});
    for (const d of shown) {
      const more = h('button', { type: 'button', class: 'icon-btn', 'aria-label': `More actions for ${d.title}`, html: icon('more') });
      more.addEventListener('click', (e) => {
        e.stopPropagation();
        showPopover(
          more,
          menu(
            [
              { label: 'Open', icon: 'open', run: () => onOpen(d.id) },
              { label: 'Rename…', icon: 'rename', run: () => rename(d) },
              { label: 'Make a copy', icon: 'copy', run: () => duplicate(d) },
              'separator',
              { label: 'Delete', icon: 'trash', run: () => remove(d) },
            ],
            { iconFn: (n) => icon(n) },
          ),
          { placement: 'bottom-end' },
        );
      });
      const row = h(
        'tr',
        {
          class: 'doc-row',
          tabindex: '0',
          onclick: () => onOpen(d.id),
          onkeydown: (e) => {
            if (e.key === 'Enter') onOpen(d.id);
            if (e.key === 'Delete') remove(d);
          },
        },
        h('td', {}, h('div', { class: 'doc-name', html: icon('file') }, h('div', { style: { minWidth: 0 } }, h('strong', {}, d.title || 'Untitled document'), compact ? null : h('small', {}, d.preview || 'Empty document')))),
        h('td', { class: 'col-date' }, formatDate(d.updatedAt)),
        h('td', { class: 'col-date' }, String(d.words ?? 0)),
        h('td', { class: 'doc-actions' }, more),
      );
      tbody.append(row);
    }
    table.append(tbody);
    body.append(table);
  };

  const refresh = async () => {
    docs = await listDocs();
    render();
  };

  const rename = async (d) => {
    const r = await promptDialog({ title: 'Rename document', fields: [{ name: 'title', label: 'Name', value: d.title }], confirmLabel: 'Rename' });
    if (r && r.title.trim()) {
      await renameDoc(d.id, r.title.trim());
      refresh();
    }
  };
  const duplicate = async (d) => {
    await duplicateDoc(d.id);
    toast(`Copied “${d.title}”`);
    refresh();
  };
  const remove = async (d) => {
    if (!(await confirmDialog(`Delete “${d.title}”? This can't be undone.`, { title: 'Delete document', confirmLabel: 'Delete', danger: true }))) return;
    await deleteDoc(d.id);
    toast(`Deleted “${d.title}”`);
    refresh();
  };

  async function backup() {
    const data = await exportBackup();
    const stamp = new Date().toISOString().slice(0, 10);
    downloadBlob(new Blob([JSON.stringify(data)], { type: 'application/json' }), `libreword-backup-${stamp}.json`);
    toast(`Backed up ${data.documents.length} document${data.documents.length === 1 ? '' : 's'}.`, { type: 'success' });
  }

  async function restore() {
    const file = await pickFile('.json,application/json');
    if (!file) return;
    try {
      const r = await importBackup(JSON.parse(await file.text()));
      toast(`Restored ${r.added} new and ${r.updated} updated document${r.added + r.updated === 1 ? '' : 's'}${r.skipped ? ` (${r.skipped} already up to date)` : ''}.`, { type: 'success', timeout: 5000 });
      refresh();
    } catch (err) {
      toast(err instanceof SyntaxError ? 'That file is not valid JSON.' : err.message, { type: 'error', timeout: 6000 });
    }
  }

  filter.addEventListener('input', debounce(render, 80));
  refresh();
  return { el: wrap, refresh };
}

export function renderStartScreen(root, { onOpen, onTemplate, onImport, onToggleTheme }) {
  const list = documentList({ onOpen });
  const screen = h(
    'div',
    { class: 'start-screen' },
    h(
      'header',
      { class: 'titlebar' },
      h('span', { class: 'app-logo', html: '<svg width="26" height="26" viewBox="0 0 48 48" aria-hidden="true"><rect width="48" height="48" rx="10" fill="#fff"/><path d="M12 14h4.2l3.3 14.4L23.2 14h3.6l3.7 14.4L33.8 14H38l-5.6 20h-3.9L25 20.6 21.5 34h-3.9z" fill="#185abd"/></svg>' }),
      h('strong', { style: { fontSize: '15px' } }, 'LibreWord'),
      h('div', { style: { flex: 1 } }),
      h('div', { class: 'titlebar-right' }, h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Toggle dark mode', title: 'Toggle dark mode', html: icon('moon'), onclick: onToggleTheme })),
    ),
    h(
      'div',
      { class: 'start-scroll' },
      h(
        'main',
        { class: 'start-inner' },
        h('div', { class: 'start-section-title' }, h('h2', {}, 'Start a new document')),
        templateCards({ onTemplate, onImport }),
        list.el,
      ),
    ),
  );
  root.replaceChildren(screen);
  return { refresh: list.refresh };
}
