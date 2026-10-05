/** Light/dark theme: explicit choice in localStorage, otherwise the OS setting. */
export function isDark() {
  const t = document.documentElement.dataset.theme;
  return t === 'dark' || (!t && matchMedia('(prefers-color-scheme: dark)').matches);
}

/** Match the browser/PWA window bar to the title bar (see --chrome-bar in app.css). */
export function syncThemeColor() {
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', isDark() ? '#1b2b45' : '#185abd');
}

export function toggleTheme() {
  const next = isDark() ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  syncThemeColor();
  try {
    localStorage.setItem('lw:theme', next);
  } catch {
    /* private mode */
  }
  return next;
}
