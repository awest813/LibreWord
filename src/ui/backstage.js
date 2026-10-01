import { h, formatDate, closePopover } from './dom.js';
import { icon } from './icons.js';
import { EXPORT_FORMATS } from '../io/export.js';
import { templateCards, documentList, pickFile } from './start.js';
import { PAGE_SIZES, formatLength } from '../editor/page-setup.js';

const EXPORT_HINTS = {
  docx: 'Opens in Microsoft Word, Google Docs, LibreOffice and Pages',
  pdf: 'Print to PDF — keeps layout, fonts and page numbers',
  html: 'A single self-contained web page',
  md: 'Plain-text formatting for notes, wikis and GitHub',
  txt: 'Just the words, no formatting',
};

export function openBackstage(app, section = 'info') {
  closePopover();
  const close = () => {
    el.remove();
    document.removeEventListener('keydown', onKey, true);
    app.editor?.commands.focus();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  const main = h('main', { class: 'backstage-main' });
  const sections = {
    home: { label: 'Home', icon: 'home', render: () => [h('h1', {}, 'Good to see you'), templateCards({ onTemplate: (t) => { close(); app.nav_.onNewDoc(t); }, onImport: importFile }), documentList({ onOpen: openDoc, compact: true }).el] },
    new: { label: 'New', icon: 'newDoc', render: () => [h('h1', {}, 'New'), templateCards({ onTemplate: (t) => { close(); app.nav_.onNewDoc(t); } })] },
    open: { label: 'Open', icon: 'open', render: () => [h('h1', {}, 'Open'), h('button', { type: 'button', class: 'btn btn-primary', onclick: importFile, html: `${icon('upload')} Browse this device…` }), documentList({ onOpen: openDoc }).el] },
    info: { label: 'Info', icon: 'info', render: info },
    export: { label: 'Save a Copy', icon: 'download', render: exportSection },
    print: { label: 'Print', icon: 'print', render: () => { close(); app.print(); return []; } },
  };

  function openDoc(id) {
    close();
    if (id !== app.docId) app.nav_.onOpenDoc(id);
  }

  async function importFile() {
    const file = await pickFile();
    if (file) {
      close();
      app.nav_.onImport(file);
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
    add('Created', app.createdAt ? `${formatDate(app.createdAt)} (${new Date(app.createdAt).toLocaleString()})` : '—');
    add('Paper', `${size.label}, ${s.orientation}`);
    add('Margins', `${formatLength(s.margins.top)} top · ${formatLength(s.margins.bottom)} bottom · ${formatLength(s.margins.left)} left · ${formatLength(s.margins.right)} right`);
    add('Stored', 'On this device only (browser storage). Save a copy to back it up.');
    return [
      h('h1', {}, 'Info'),
      dl,
      h('p', {}),
      h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
        h('button', { type: 'button', class: 'btn', onclick: () => { close(); app.pageSetupDialog(); } }, 'Page Setup…'),
        h('button', { type: 'button', class: 'btn', onclick: () => { close(); app.headerFooterDialog(); } }, 'Header & Footer…'),
        h('button', { type: 'button', class: 'btn', onclick: () => { close(); app.wordCountDialog(); } }, 'Word Count…'),
        h('button', { type: 'button', class: 'btn', onclick: () => { close(); app.shortcutsDialog(); } }, 'Keyboard Shortcuts'),
      ),
    ];
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
    h('button', { type: 'button', html: `${icon('close')}<span>Close document</span>`, onclick: () => { close(); app.nav_.onHome(); } }),
  );
  const el = h('div', { class: 'backstage', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'File' }, nav, main);
  document.body.append(el);
  document.addEventListener('keydown', onKey, true);
  select(sections[section] ? section : 'info');
  navButtons[section]?.focus();
}
