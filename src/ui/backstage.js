import { h, closePopover, toast } from './dom.js';
import { VERSION, BUILD, diagnostics } from '../diagnostics.js';
import { icon } from './icons.js';
import { EXPORT_FORMATS } from '../io/export.js';
import { templateCards, documentList } from './start.js';
import { pickFileToOpen, canSaveToFiles, FILE_FORMATS } from '../io/file-access.js';
import { PAGE_SIZES, formatLength } from '../editor/page-setup.js';
import { listVersions } from '../storage/db.js';
import { confirmDialog, openDialog } from './dialog.js';

const EXPORT_HINTS = {
  docx: 'Opens in Microsoft Word, Google Docs, LibreOffice and Pages',
  odt: 'The open standard: LibreOffice, Collabora, Google Docs and Word',
  rtf: 'Opens almost anywhere, including WordPad and TextEdit',
  pdf: 'Print to PDF — keeps layout, fonts and page numbers',
  html: 'A single self-contained web page',
  md: 'Plain-text formatting for notes, wikis and GitHub',
  txt: 'Just the words, no formatting',
};

export function openBackstage(app, section = 'info') {
  closePopover();
  app.closeBackstage?.();
  const close = () => {
    if (app.closeBackstage !== close) return;
    app.closeBackstage = null;
    el.remove();
    document.getElementById('app')?.removeAttribute('inert');
    document.removeEventListener('keydown', onKey, true);
    if (!app.destroyed) app.editor?.commands.focus();
  };
  const onKey = (e) => {
    // A dialog opened from the backstage handles its own Escape.
    if (e.key === 'Escape' && !document.querySelector('dialog[open]')) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  const listOptions = { currentId: app.docId, onRenameCurrent: (title) => app.rename(title) };
  const main = h('section', { class: 'backstage-main' });
  const sections = {
    home: { label: 'Home', icon: 'home', render: () => [h('h1', {}, 'Good to see you'), templateCards({ onTemplate: (t) => { close(); app.leaveDocument(() => app.nav_.onNewDoc(t)); }, onImport: importFile }), documentList({ onOpen: openDoc, compact: true, ...listOptions }).el] },
    new: { label: 'New', icon: 'newDoc', render: () => [h('h1', {}, 'New'), templateCards({ onTemplate: (t) => { close(); app.leaveDocument(() => app.nav_.onNewDoc(t)); } })] },
    open: { label: 'Open', icon: 'open', render: () => [h('h1', {}, 'Open'), h('button', { type: 'button', class: 'btn btn-primary', onclick: importFile, html: `${icon('upload')} Browse this device…` }), documentList({ onOpen: openDoc, ...listOptions }).el] },
    info: { label: 'Info', icon: 'info', render: info },
    save: { label: 'Save', icon: 'save', render: () => { close(); app.save(); return []; } },
    saveAs: { label: 'Save As', icon: 'fileDown', render: () => { close(); app.saveAs(); return []; } },
    history: { label: 'Version History', icon: 'clock', render: history },
    export: { label: 'Save a Copy', icon: 'download', render: exportSection },
    print: { label: 'Print', icon: 'print', render: () => { close(); app.print(); return []; } },
  };

  function openDoc(id) {
    close();
    if (id !== app.docId) app.leaveDocument(() => app.nav_.onOpenDoc(id));
  }

  async function importFile() {
    const picked = await pickFileToOpen();
    if (picked) {
      close();
      app.leaveDocument(() => app.nav_.onImport(picked.file, picked.handle));
    }
  }

  function info() {
    const s = app.settings;
    const size = PAGE_SIZES[s.pageSize] || PAGE_SIZES.letter;
    const dl = h('dl', { class: 'info-grid' });
    const add = (k, v) => dl.append(h('dt', {}, k), h('dd', {}, v));
    add('Title', app.title);
    add('Pages', app.view.layout === 'print' ? String(app.pageCount) : '—');
    add('Words', (app.words ?? 0).toLocaleString());
    const when = (ts) => (ts ? new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
    add('Modified', when(app.savedAt));
    add('Created', when(app.createdAt));
    add('Paper', `${size.label}, ${s.orientation}`);
    add('Margins', `${formatLength(s.margins.top)} top · ${formatLength(s.margins.bottom)} bottom · ${formatLength(s.margins.left)} left · ${formatLength(s.margins.right)} right`);
    if (app.file) {
      const state = app.fileDirty ? 'Unsaved changes' : 'Up to date';
      add('File', `${app.file.name} (${FILE_FORMATS[app.file.format]?.label || app.file.format}) — ${state}`);
      add('Stored', 'In this browser, and saved to the file above whenever you press Save.');
    } else {
      add('Stored', canSaveToFiles()
        ? 'In this browser only. Use Save As to save it as a file you can keep or share.'
        : 'In this browser only. Use Save a Copy to download a file you can keep or share.');
    }
    const fileActions = app.file
      ? [
        h('button', { type: 'button', class: 'btn btn-primary', disabled: !app.fileDirty || null, onclick: () => { close(); app.saveToFile(); } }, `Save to ${app.file.name}`),
        h('button', { type: 'button', class: 'btn', onclick: () => { close(); app.saveAs(); } }, 'Save As…'),
        h('button', { type: 'button', class: 'btn', onclick: async () => { await app.unlinkFile(); select('info'); } }, 'Stop Saving to This File'),
      ]
      : canSaveToFiles() ? [h('button', { type: 'button', class: 'btn btn-primary', onclick: () => { close(); app.saveAs(); } }, 'Save As…')] : [];
    return [
      h('h1', {}, 'Info'),
      dl,
      fileActions.length ? h('div', { class: 'backstage-actions' }, ...fileActions) : null,
      h('p', {}),
      h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
        h('button', { type: 'button', class: 'btn', onclick: () => { close(); app.pageSetupDialog(); } }, 'Page Setup…'),
        h('button', { type: 'button', class: 'btn', onclick: () => { close(); app.headerFooterDialog(); } }, 'Header & Footer…'),
        h('button', { type: 'button', class: 'btn', onclick: () => { close(); app.wordCountDialog(); } }, 'Word Count…'),
        h('button', { type: 'button', class: 'btn', onclick: () => { close(); app.shortcutsDialog(); } }, 'Keyboard Shortcuts'),
      ),
      h('p', { class: 'about-line' },
        `LibreWord ${VERSION} · build ${BUILD} · `,
        h('button', {
          type: 'button',
          class: 'link-btn',
          onclick: async () => {
            const text = await diagnostics(app);
            try {
              await navigator.clipboard.writeText(text);
              toast('Copied. Paste it into your bug report; it contains no document text.', { type: 'success', timeout: 5000 });
            } catch {
              openDialog({ title: 'Details for a bug report', body: h('pre', { class: 'diagnostics' }, text) });
            }
          },
        }, 'Copy details for a bug report'),
      ),
    ];
  }

  function history() {
    const body = h('div', { class: 'version-list' }, h('p', { class: 'muted' }, 'Loading…'));
    const REASONS = { opened: 'Before editing session', auto: 'Autosaved', 'before-restore': 'Before restoring a version', 'before-reload': 'Before reloading the file from disk' };
    listVersions(app.docId).then((versions) => {
      body.replaceChildren();
      if (!versions.length) {
        body.append(h('p', { class: 'muted' }, 'No earlier versions yet. LibreWord keeps the state of the document from before each editing session, plus a snapshot every 10 minutes while you work.'));
        return;
      }
      for (const v of versions) {
        body.append(h(
          'div',
          { class: 'version-row' },
          h('div', {}, h('b', {}, new Date(v.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })), h('small', {}, `${REASONS[v.reason] || 'Snapshot'} · ${v.title || 'Untitled'} · ${(v.words || 0).toLocaleString()} words`)),
          h('div', { class: 'version-actions' },
            h('button', { type: 'button', class: 'btn', onclick: () => { close(); app.openVersionAsCopy(v.vid); } }, 'Open copy'),
            h('button', {
              type: 'button',
              class: 'btn btn-primary',
              onclick: async () => {
                if (!(await confirmDialog('Replace the current document with this version? The current state is kept in version history.', { title: 'Restore version', confirmLabel: 'Restore' }))) return;
                close();
                app.restoreVersion(v.vid);
              },
            }, 'Restore')),
        ));
      }
    });
    return [h('h1', {}, 'Version History'), body];
  }

  function exportSection() {
    const list = h('div', { class: 'export-list' });
    for (const f of EXPORT_FORMATS) {
      list.append(
        h('button', {
          type: 'button',
          class: 'export-option',
          'data-format': f.id,
          onclick: () => {
            close();
            app.exportAs(f.id);
          },
          html: `${icon(f.icon, 'icon icon-lg')}<span><b>${f.label} (${f.ext})</b><small>${EXPORT_HINTS[f.id]}</small></span>`,
        }),
      );
    }
    return [h('h1', {}, 'Save a Copy'), h('p', { style: { color: 'var(--text-muted)', marginTop: '-8px' } }, 'Your document is saved automatically in this browser. Download a copy to share it or keep a backup.'), list];
  }

  const navButtons = {};
  const select = (key) => {
    const out = sections[key].render();
    if (!el.isConnected) return;
    main.replaceChildren(...out);
    for (const [k, b] of Object.entries(navButtons)) b.setAttribute('aria-current', String(k === key));
  };
  const nav = h('nav', { class: 'backstage-nav', 'aria-label': 'File' });
  nav.append(h('button', { type: 'button', class: 'back', onclick: close, html: `${icon('back')}<span>Back</span>`, 'aria-label': 'Back to document' }));
  for (const [key, s] of Object.entries(sections)) {
    const b = h('button', { type: 'button', html: `${icon(s.icon)}<span>${s.label}</span>`, onclick: () => select(key) });
    navButtons[key] = b;
    nav.append(b);
  }
  nav.append(
    h('div', { class: 'spacer' }),
    h('button', { type: 'button', html: `${icon('close')}<span>Close document</span>`, onclick: () => { close(); app.leaveDocument(() => app.nav_.onHome()); } }),
  );
  const el = h('div', { class: 'backstage', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'File' }, nav, main);
  document.body.append(el);
  app.closeBackstage = close;
  // Keep keyboard and screen-reader focus inside the backstage while it's open.
  document.getElementById('app')?.setAttribute('inert', '');
  document.addEventListener('keydown', onKey, true);
  select(sections[section] ? section : 'info');
  navButtons[section]?.focus();
}
