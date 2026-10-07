/**
 * "Install app" support. Chrome and Edge (including on Chromebooks) fire
 * `beforeinstallprompt` when LibreWord can be installed; we keep the event so
 * a button on the start screen can show the browser's install dialog. Once
 * installed, LibreWord gets its own window and launcher icon, and appears in
 * the Files app's "Open with" menu for .docx, .md, .txt and .html files.
 */
let deferred = null;
const listeners = new Set();
const notify = () => listeners.forEach((fn) => fn(!!deferred));

export const isInstalledWindow = () =>
  typeof matchMedia === 'function' && ['standalone', 'window-controls-overlay', 'minimal-ui'].some((m) => matchMedia(`(display-mode: ${m})`).matches);

export const isChromeOS = () => typeof navigator !== 'undefined' && /\bCrOS\b/.test(navigator.userAgent);

export function initInstall({ onInstalled } = {}) {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    notify();
    onInstalled?.();
  });
}

/** Call `fn(canInstall)` now and whenever installability changes. Returns an unsubscribe function. */
export function onInstallable(fn) {
  listeners.add(fn);
  fn(!!deferred);
  return () => listeners.delete(fn);
}

/** Show the browser's install dialog. Resolves true if the user accepted. */
export async function promptInstall() {
  const e = deferred;
  if (!e) return false;
  // The event can only be used once.
  deferred = null;
  notify();
  e.prompt();
  const { outcome } = await e.userChoice.catch(() => ({ outcome: 'dismissed' }));
  return outcome === 'accepted';
}
