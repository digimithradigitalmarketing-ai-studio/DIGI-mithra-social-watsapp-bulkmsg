import { useEffect, useState } from 'react';

export function useTheme() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    try { localStorage.setItem('sp_theme', dark ? 'dark' : 'light'); } catch { /* ignore */ }
  }, [dark]);
  return { dark, toggle: () => setDark((d) => !d) };
}
