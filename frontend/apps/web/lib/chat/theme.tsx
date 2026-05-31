'use client';

import { useEffect } from 'react';

import { useSettingsStore, type Theme } from './settings';

function applyTheme(theme: Theme) {
  if (typeof document === 'undefined') return;
  const prefersDark =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches;
  const dark = theme === 'dark' || (theme === 'system' && prefersDark);
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
}

export function ThemeApplier() {
  const theme = useSettingsStore((s) => s.theme);
  const hasHydrated = useSettingsStore((s) => s.hasHydrated);

  useEffect(() => {
    applyTheme(theme);
  }, [theme, hasHydrated]);

  useEffect(() => {
    if (theme !== 'system' || typeof window === 'undefined') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [theme]);

  return null;
}

/**
 * Inline script that runs before React hydrates, reading the persisted theme
 * from localStorage and setting the `dark` class on <html>. This prevents a
 * light-mode flash on first paint for users whose theme is dark.
 */
export const THEME_INIT_SCRIPT = `
(function(){try{
  var raw = localStorage.getItem('petrobrain-settings');
  var theme = 'system';
  if (raw) { try { var parsed = JSON.parse(raw); theme = (parsed && parsed.state && parsed.state.theme) || 'system'; } catch(_){} }
  var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  var dark = theme === 'dark' || (theme === 'system' && prefersDark);
  if (dark) document.documentElement.classList.add('dark');
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
}catch(_){}}
)();
`.trim();
