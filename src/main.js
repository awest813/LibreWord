import './styles/app.css';
import { createDoc, findDocByFile, saveDoc, getDoc, addVersion } from './storage/db.js';
import { importFile, extOf } from './io/import.js';
import { pickFileToOpen, formatOfName, handleFromDataTransfer } from './io/file-access.js';
import { renderStartScreen } from './ui/start.js';
import { toast, h } from './ui/dom.js';
import { toggleTheme, syncThemeColor } from './ui/theme.js';
import { initInstall, isChromeOS } from './ui/install.js';
import { watchErrors, noteError } from './diagnostics.js';

watchErrors();
const root = document.getElementById('app');
let screen = null; // current EditorScreen
let routing = Promise.resolve();


const go = (hash) => {
  if (location.hash === hash) route();
  else location.hash = hash;
};

async function newFromTemplate(t) {
  const id = await createDoc({ title: t.title, html: t.html(), settings: t.settings || {} });
  go(`#/doc/${encodeURIComponent(id)}`);
}

/**
 * Open a file from the device. With a file handle (Chromium), the document
 * stays linked to the file so Save writes back to it. With `show: false` the
 * file is added to the document list without switching to it. Resolves to the
 * document id, or null if the file couldn't be read.
 */
async function importAndOpen(file, handle = null, { show = true } = {}) {
  const open = (id) => {
    if (show) go(`#/doc/${encodeURIComponent(id)}`);
    return id;
  };
  try {
    const format = handle ? formatOfName(file.name) : null;
    const existing = handle && format ? await findDocByFile(handle) : null;
    if (existing && Math.abs((existing.file.lastModified || 0) - file.lastModified) < 1000) {
      // Re-opening a file we already have, unchanged on disk: reuse that
      // document (it keeps comments, history and anything the file format
      // can't store, plus any edits not yet saved to the file).
      return open(existing.id);
    }
    const { title, html, settings, comments } = await importFile(file);
    const link = handle && format ? { handle, name: file.name, format, lastModified: file.lastModified, unsaved: false } : null;
    if (existing && !existing.file.unsaved) {
      // The file changed on disk and we have nothing newer: refresh the same
      // document from it (the previous state goes to version history).
      const old = await getDoc(existing.id);
      await addVersion(existing.id, { title: old.title, json: old.json, html: old.html, settings: old.settings, comments: old.comments, words: old.words, reason: 'before-reload' });
      await saveDoc(existing.id, { html, settings: { ...old.settings, ...settings }, comments: comments || {}, file: link });
      toast(`Reloaded “${file.name}”, which changed on disk`, { type: 'success' });
      return open(existing.id);
    }
    if (existing) {
      // Both changed: keep our unsaved version as its own document, and link the file to a fresh import.
      await saveDoc(existing.id, { file: null, title: `${existing.title} (unsaved changes)` });
      toast(`“${file.name}” changed on disk. Your unsaved version was kept as “${existing.title} (unsaved changes)”.`, { timeout: 7000 });
    }
    const id = await createDoc({ title, html, settings: settings || {}, comments: comments || {}, file: link });
    if (show) toast(openedMessage(file.name, link, handle), { type: 'success', timeout: link ? 4000 : 7000 });
    return open(id);
  } catch (err) {
    // Readers mark the problems they explain (wrong or damaged file) with a code; anything else is a bug.
    if (err?.code) console.warn(err);
    else console.error(err);
    noteError(err, `opening ${extOf(file.name) || 'file'}`);
    toast(`${file.name}: ${err.message || 'Could not open that file.'}`, { type: 'error', timeout: 6000 });
    return null;
  }
}

/** What opening a file did: linked to it, or opened as a copy (and why). */
function openedMessage(name, link, handle) {
  if (link) return `Opened “${name}” — Save writes your changes back to it`;
  const ext = extOf(name);
  if (/^(dotx|dotm|ott|dot)$/.test(ext)) return `New document from the template “${name}”`;
  if (handle && /^(doc|docm|fodt)$/.test(ext)) {
    return `Opened “${name}”. LibreWord can’t save .${ext} files, so Save As saves it as a Word document (.docx) or OpenDocument (.odt).`;
  }
  return `Opened a copy of “${name}”`;
}

async function openFromDevice() {
  const picked = await pickFileToOpen();
  if (picked) importAndOpen(picked.file, picked.handle);
}

const prefetchEditor = () => import('./ui/editor-screen.js').catch(() => {});

async function showStart() {
  document.title = 'LibreWord';
  // Warm the editor chunk while the user browses, so opening a document is instant.
  (window.requestIdleCallback || ((fn) => setTimeout(fn, 1500)))(prefetchEditor);
  renderStartScreen(root, {
    onOpen: (id) => go(`#/doc/${encodeURIComponent(id)}`),
    onTemplate: newFromTemplate,
    onImport: openFromDevice,
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
      } else go(`#/doc/${encodeURIComponent(docId)}`);
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
    let id = null;
    try {
      id = m ? decodeURIComponent(m[1]) : null;
    } catch {
      id = ''; // malformed: not a document we have
    }
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
    if (m && !id) {
      history.replaceState(null, '', '#/');
      toast('That document link isn’t valid.', { type: 'error' });
    }
    if (id) await showEditor(id);
    else await showStart();
  }).catch((err) => {
    console.error(err);
    noteError(err, 'route');
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
// In the editor, the document handles drops on itself; a file dropped anywhere
// else (the grey canvas, the ribbon) would make the browser navigate away to it.
const outsideDocument = (e) => screen && !screen.editorEl?.contains(e.target) && e.dataTransfer?.types?.includes('Files');
window.addEventListener('dragover', (e) => {
  if (!screen || outsideDocument(e)) e.preventDefault();
});
window.addEventListener('drop', (e) => {
  dragDepth = 0;
  overlay?.remove();
  overlay = null;
  if (screen) {
    if (!outsideDocument(e)) return;
    e.preventDefault();
    // As if dropped at the cursor: pictures are inserted there, documents opened.
    if (!screen.handleFiles(e.dataTransfer.files, screen.editor.state.selection.head, e.dataTransfer)) {
      toast('LibreWord opens Word, OpenDocument, RTF, Markdown, HTML and text files, and inserts pictures.', { type: 'error' });
    }
    return;
  }
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  // The handle must be requested synchronously, during the drop event.
  const handlePromise = handleFromDataTransfer(e.dataTransfer, file);
  if (file) handlePromise.then((handle) => importAndOpen(file, handle?.kind === 'file' ? handle : null));
});

// Files opened through the installed app's file handler: "Open with LibreWord"
// in the Chromebook Files app, or double-clicking a file once LibreWord is the
// default app for it. Several files at once open the first and add the rest to
// the document list.
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async (params) => {
    const handles = (params.files || []).filter((f) => f.kind === 'file');
    let shown = false;
    let added = 0;
    for (const handle of handles) {
      let file;
      try {
        file = await handle.getFile();
      } catch (err) {
        toast(`Couldn't read “${handle.name}”: ${err.message || err}`, { type: 'error', timeout: 6000 });
        continue;
      }
      const id = await importAndOpen(file, handle, { show: !shown });
      if (id && shown) added++;
      if (id) shown = true;
    }
    if (added) toast(`${added} more file${added === 1 ? ' was' : 's were'} added to your Recent documents.`, { timeout: 6000 });
  });
}

// Ctrl+O on the start screen (the editor handles its own shortcuts). Without
// this, an installed app window would hand Ctrl+O to the browser instead.
window.addEventListener('keydown', (e) => {
  if (screen || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'o') return;
  if (document.querySelector('dialog[open]')) return;
  e.preventDefault();
  openFromDevice();
});

initInstall({
  onInstalled: () => toast(
    isChromeOS()
      ? 'LibreWord is installed. Open it from the Launcher, or right-click a document in the Files app and choose Open with → LibreWord.'
      : 'LibreWord is installed. You can open it from your apps, and open documents with it from your file manager.',
    { type: 'success', timeout: 9000 },
  ),
});

// Service worker: offline support once installed. Registered after load so it
// never competes with the first paint.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    import('virtual:pwa-register').then(({ registerSW }) => {
      const updateSW = registerSW({
        immediate: true,
        onNeedRefresh: () => toast('A new version of LibreWord is ready.', {
          timeout: 60000, action: { label: 'Update', run: () => updateSW() },
        }),
        // The new version has taken over: save, then reload onto it.
        onNeedReload: () => (screen ? screen.flush() : Promise.resolve()).catch(() => {}).finally(() => location.reload()),
      });
    }).catch(() => {});
  });
}

// Ask the browser to keep our IndexedDB data even under storage pressure.
navigator.storage?.persist?.().catch(() => {});
