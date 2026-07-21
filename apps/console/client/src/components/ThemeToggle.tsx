import { useState } from 'react';
import { initTheme, setTheme, type Theme } from '../theme';

export function ThemeToggle({ className = '' }: { className?: string }) {
  const [theme, setThemeState] = useState<Theme>(() => initTheme());
  const next: Theme = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      className={`icon-btn theme-toggle ${className}`}
      onClick={() => {
        setTheme(next);
        setThemeState(next);
      }}
      aria-label={`switch to ${next} theme`}
      title={`switch to ${next} theme`}
    >
      {theme === 'dark' ? '☀' : '☾'}
    </button>
  );
}
