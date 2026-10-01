import './styles/app.css';
import { createDoc } from './storage/db.js';
import { importFile } from './io/import.js';
import { renderStartScreen, pickFile } from './ui/start.js';
import { toast, h } from './ui/dom.js';

const root = document.getElementById('app');
let screen = null; // current EditorScreen
let routing = Promise.resolve();

const toggleTheme = () => {
  const el = document.documentElement;
  const dark = el.dataset.theme === 'dark' || (!el.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  el.dataset.theme = dark ? 'light' : 'dark';
  try {
    localStorage.setItem('lw:theme', el.dataset.theme);
  } catch { /* ignore */ }
};

const go = (hash) => {
  if (location.hash === hash) route();
  else location.hash = hash;
};

async function newFromTemplate(t) {
  const id = await createDoc({ title: t.title, html: t.html(), settings: t.settings || {} });
  go(`#/doc/${id}`);
}

async function importAndOpen(file) {
  try {
    const { title, html } = await importFile(file);
    const id = await createDoc({ title, html });
    go(`#/doc/${id}`);
    toast(`Opened “${file.name}”`, { type: 'success' });
  } catch (err) {
    console.error(err);
    toast(err.message || 'Could not open that file.', { type: 'error', timeout: 6000 });
  }
}

async function showStart() {
  document.title = 'LibreWord';
  renderStartScreen(root, {
    onOpen: (id) => go(`#/doc/${id}`),
    onTemplate: newFromTemplate,
    onImport: async () => {
      const f = await pickFile();
      if (f) importAndOpen(f);
    },
    onToggleTheme: toggleTheme,
  });
}

async function showEditor(id) {
  const { EditorScreen } = await import('./ui/editor-screen.js');
  const s = new EditorScreen(root, {
    docId: id,
    onHome: () => go('#/'),
    onOpenDoc: (docId, { force } = {}) => {
      if (force && docId === screen?.docId) {
        // Reload from storage without saving the stale copy over it.
        screen.destroyed = true;
        screen.editor?.destroy();
        screen = null;
        route();
      } else go(`#/doc/${docId}`);
    },
    onNewDoc: newFromTemplate,
    onImport: importAndOpen,
  });
  const ok = await s.mount();
  if (!ok) {
    toast('That document no longer exists.', { type: 'error' });
    go('#/');
    return;
  }
  screen = s;
  // Handy for automation and power users poking around in devtools.
  window.libreword = { screen: s, editor: s.editor };
}

function route() {
  routing = routing.then(async () => {
    const m = /^#\/doc\/(.+)$/.exec(location.hash);
    const id = m ? decodeURIComponent(m[1]) : null;
    if (screen && screen.docId === id) return;
    if (screen) {
      await screen.destroy();
      screen = null;
    }
    root.removeAttribute('aria-busy');
    if (id) await showEditor(id);
    else await showStart();
  }).catch((err) => {
    console.error(err);
    toast(`Something went wrong: ${err.message || err}`, { type: 'error', timeout: 8000 });
  });
  return routing;
}

window.addEventListener('hashchange', route);
route();

// Opening files via drag & drop anywhere on the start screen.
let dragDepth = 0;
let overlay = null;
window.addEventListener('dragenter', (e) => {
  if (screen || !e.dataTransfer?.types?.includes('Files')) return;
  dragDepth++;
  if (!overlay) {
    overlay = h('div', { class: 'drop-overlay' }, 'Drop to open in LibreWord');
    document.body.append(overlay);
  }
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    overlay?.remove();
    overlay = null;
  }
});
window.addEventListener('dragover', (e) => {
  if (!screen) e.preventDefault();
});
window.addEventListener('drop', (e) => {
  dragDepth = 0;
  overlay?.remove();
  overlay = null;
  if (screen) return;
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (file) importAndOpen(file);
});

// Files opened through the installed PWA's file handler ("Open with LibreWord").
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async (params) => {
    for (const handle of params.files || []) {
      importAndOpen(await handle.getFile());
    }
  });
}

// Service worker: offline support once installed. Registered after load so it
// never competes with the first paint.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    import('virtual:pwa-register').then(({ registerSW }) => registerSW({ immediate: true })).catch(() => {});
  });
}

// Ask the browser to keep our IndexedDB data even under storage pressure.
navigator.storage?.persist?.().catch(() => {});
