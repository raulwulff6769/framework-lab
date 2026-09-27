import { useEffect, useState } from 'react';
import { savePreferences } from './preferences';

export type Theme = 'dark' | 'light';
const KEY = 'itles_theme';

export function getTheme(): Theme {
  try {
    return (localStorage.getItem(KEY) as Theme) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function setTheme(t: Theme, persist = true) {
  try {
    localStorage.setItem(KEY, t);
  } catch {
    // private mode: keep in memory only
  }
  document.documentElement.classList.toggle('dark', t === 'dark');
  const bg = t === 'dark' ? '#0a0907' : '#f2ebdd';
  // keep the pre-paint inline <html> background in sync on every toggle — otherwise it
  // stays frozen at the value set on first load and bleeds the other theme in overscroll
  document.documentElement.style.background = bg;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg);
  window.dispatchEvent(new CustomEvent('itles-theme', { detail: t }));
  if (persist) savePreferences({ theme: t });
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const [t, setT] = useState<Theme>(getTheme);
  useEffect(() => {
    const f = (e: Event) => setT((e as CustomEvent<Theme>).detail);
    window.addEventListener('itles-theme', f);
    return () => window.removeEventListener('itles-theme', f);
  }, []);
  return [t, setTheme];
}
