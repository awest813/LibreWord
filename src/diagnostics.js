/**
 * Details for bug reports: version, browser, storage and the last errors,
 * copied from File › Info. Nothing from the document's text is included.
 */
/* global __APP_VERSION__, __BUILD_COMMIT__, __BUILD_DATE__ */
export const VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';
export const BUILD = typeof __BUILD_COMMIT__ !== 'undefined' ? `${__BUILD_COMMIT__} (${__BUILD_DATE__})` : 'dev';

const recent = [];
const MAX = 20;

/** Remember an error for the report (the browser console still gets it). */
export function noteError(err, where = '') {
  const message = err?.stack || err?.message || String(err);
  recent.push(`${new Date().toISOString()} ${where ? `[${where}] ` : ''}${message.split('\n').slice(0, 4).join(' ⏎ ')}`);
  if (recent.length > MAX) recent.shift();
}

/** Collect uncaught errors and rejections from LibreWord's own code. */
export function watchErrors() {
  window.addEventListener('error', (e) => {
    // Extensions and cross-origin scripts report as "Script error." with no file: not ours.
    if (e.filename && !e.filename.startsWith(location.origin)) return;
    noteError(e.error || e.message, 'uncaught');
  });
  window.addEventListener('unhandledrejection', (e) => noteError(e.reason, 'unhandled promise'));
}

/** Plain-text report about the app, the browser and (optionally) the open document. */
export async function diagnostics(app = null) {
  const lines = [`LibreWord ${VERSION}, build ${BUILD}`];
  lines.push(`Browser: ${navigator.userAgent}`);
  const installed = ['standalone', 'window-controls-overlay', 'minimal-ui'].some((m) => matchMedia(`(display-mode: ${m})`).matches);
  lines.push(`Window: ${installed ? 'installed app' : 'browser tab'}, ${innerWidth}×${innerHeight} at ${devicePixelRatio}x, ${navigator.onLine ? 'online' : 'offline'}`);
  lines.push(`Saving to files: ${typeof window.showSaveFilePicker === 'function' ? 'available' : 'not available (downloads instead)'}`);
  try {
    const est = await navigator.storage?.estimate?.();
    const persisted = await navigator.storage?.persisted?.();
    if (est) lines.push(`Storage: ${(est.usage / 1048576).toFixed(1)} MB used of ${(est.quota / 1048576).toFixed(0)} MB${persisted ? ', persistent' : ''}`);
  } catch { /* not available */ }
  lines.push(`Service worker: ${navigator.serviceWorker?.controller ? 'active (works offline)' : 'not active'}`);
  if (app?.editor) {
    const counts = {};
    app.editor.state.doc.descendants((n) => { if (!n.isText) counts[n.type.name] = (counts[n.type.name] || 0) + 1; });
    lines.push(`Document: ${app.words ?? '?'} words, ${app.pageCount} pages (${app.view.layout} layout), ${app.settings.pageSize} ${app.settings.orientation}, zoom ${Math.round(app.view.zoom * 100)}%`);
    lines.push(`Content: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    lines.push(`Linked file: ${app.file ? `${app.file.format}${app.fileDirty ? ', unsaved changes' : ''}` : 'none'}; autosave: ${app.saveState}`);
    const pg = app.editor.storage.pagination;
    if (pg?.lastLayoutMs != null) lines.push(`Last layout pass: ${pg.lastLayoutMs.toFixed(1)} ms`);
  }
  lines.push(recent.length ? `Recent errors:\n  ${recent.join('\n  ')}` : 'Recent errors: none');
  return lines.join('\n');
}
