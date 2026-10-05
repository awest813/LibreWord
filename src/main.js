import './styles/app.css';
import { createDoc, findDocByFile, saveDoc, getDoc, addVersion } from './storage/db.js';
import { importFile } from './io/import.js';
import { pickFileToOpen, formatOfName, handleFromDataTransfer } from './io/file-access.js';
import { renderStartScreen } from './ui/start.js';
import { toast, h } from './ui/dom.js';
import { toggleTheme, syncThemeColor } from './ui/theme.js';

const root = document.getElementById('app');
let screen = null; // current EditorScreen
let routing = Promise.resolve();


const go = (hash) => {
  if (location.hash === hash) route();
  else location.hash = hash;
};

async function newFromTemplate(t) {
  const id = await createDoc({ title: t.title, html: t.html(), settings: t.settings || {} });
  go(`#/doc/${id}`);
}

/**
 * Open a file from the device. With a file handle (Chromium), the document
 * stays linked to the file so Save writes back to it.
 */
async function importAndOpen(file, handle = null) {
  try {
    const format = handle ? formatOfName(file.name) : null;
    const existing = handle && format ? await findDocByFile(handle) : null;
    if (existing && Math.abs((existing.file.lastModified || 0) - file.lastModified) < 1000) {
      // Re-opening a file we already have, unchanged on disk: reuse that
      // document (it keeps comments, history and anything the file format
      // can't store, plus any edits not yet saved to the file).
      go(`#/doc/${existing.id}`);
      return;
    }
    const { title, html, settings, comments } = await importFile(file);
    const link = handle && format ? { handle, name: file.name, format, lastModified: file.lastModified, unsaved: false } : null;
    if (existing && !existing.file.unsaved) {
      // The file changed on disk and we have nothing newer: refresh the same
      // document from it (the previous state goes to version history).
      const old = await getDoc(existing.id);
      await addVersion(existing.id, { title: old.title, json: old.json, html: old.html, settings: old.settings, comments: old.comments, words: old.words, reason: 'before-reload' });
      await saveDoc(existing.id, { html, settings: { ...old.settings, ...settings }, comments: comments || {}, file: link });
      go(`#/doc/${existing.id}`);
      toast(`Reloaded “${file.name}”, which changed on disk`, { type: 'success' });
      return;
    }
    if (existing) {
      // Both changed: keep our unsaved version as its own document, and link the file to a fresh import.
      await saveDoc(existing.id, { file: null, title: `${existing.title} (unsaved changes)` });
      toast(`“${file.name}” changed on disk. Your unsaved version was kept as “${existing.title} (unsaved changes)”.`, { timeout: 7000 });
    }
    const id = await createDoc({ title, html, settings: settings || {}, comments: comments || {}, file: link });
    go(`#/doc/${id}`);
    toast(link ? `Opened “${file.name}” — Save writes your changes back to it` : `Opened a copy of “${file.name}”`, { type: 'success', timeout: 4000 });
  } catch (err) {
    console.error(err);
    toast(err.message || 'Could not open that file.', { type: 'error', timeout: 6000 });
  }
}

const prefetchEditor = () => import('./ui/editor-screen.js').catch(() => {});

async function showStart() {
  document.title = 'LibreWord';
  // Warm the editor chunk while the user browses, so opening a document is instant.
  (window.requestIdleCallback || ((fn) => setTimeout(fn, 1500)))(prefetchEditor);
  renderStartScreen(root, {
    onOpen: (id) => go(`#/doc/${id}`),
    onTemplate: newFromTemplate,
    onImport: async () => {
      const picked = await pickFileToOpen();
      if (picked) importAndOpen(picked.file, picked.handle);
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
        const stale = screen;
        screen = null;
        stale.destroy({ save: false }).then(route);
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
    // Back button, links, launch handlers…: offer to save to the linked file first.
    if (screen && !(await screen.confirmLeave())) {
      location.hash = `#/doc/${encodeURIComponent(screen.docId)}`;
      return;
    }
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

// Storage events from db.js: a newer LibreWord in another tab upgraded the database,
// or this tab's upgrade is waiting for older tabs to close.
window.addEventListener('libreword:db-outdated', () => {
  toast('LibreWord was updated in another tab. Reload this tab to keep saving.', {
    type: 'error', timeout: 60000, action: { label: 'Reload', run: () => location.reload() },
  });
});
window.addEventListener('libreword:db-blocked', () => {
  toast('Close other LibreWord tabs to finish updating.', { timeout: 10000 });
});

syncThemeColor();
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', syncThemeColor);

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
  // The handle must be requested synchronously, during the drop event.
  const handlePromise = handleFromDataTransfer(e.dataTransfer, file);
  if (file) handlePromise.then((handle) => importAndOpen(file, handle?.kind === 'file' ? handle : null));
});

// Files opened through the installed PWA's file handler ("Open with LibreWord").
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async (params) => {
    for (const handle of params.files || []) {
      importAndOpen(await handle.getFile(), handle);
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
