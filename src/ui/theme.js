/** Light/dark theme: explicit choice in localStorage, otherwise the OS setting. */
export function isDark() {
  const t = document.documentElement.dataset.theme;
  return t === 'dark' || (!t && matchMedia('(prefers-color-scheme: dark)').matches);
}

export function toggleTheme() {
  const next = isDark() ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem('lw:theme', next);
  } catch {
    /* private mode */
  }
  return next;
}
