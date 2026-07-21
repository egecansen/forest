export type Theme = 'dark' | 'light';
export const THEME_KEY = 'hektor-console.theme';

/** In-session source of truth. Storage is only the initial fallback, so a
 *  failed persist (private mode) can't revert the theme on view changes. */
let current: Theme | null = null;

/** Anything that isn't exactly 'light' is the dark default. */
export function normalizeTheme(raw: unknown): Theme {
  return raw === 'light' ? 'light' : 'dark';
}

export function initTheme(): Theme {
  if (current === null) {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(THEME_KEY);
    } catch {
      // private mode / storage disabled — theme just won't persist
    }
    current = normalizeTheme(stored);
  }
  document.documentElement.dataset.theme = current;
  return current;
}

export function setTheme(theme: Theme): void {
  current = theme;
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // non-persistent — the in-page theme still switches
  }
}
