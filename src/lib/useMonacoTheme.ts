import { useEffect, useState } from 'react';

const current = (): 'light' | 'vs-dark' =>
  typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'light'
    ? 'light'
    : 'vs-dark';

// Monaco theme that tracks the app theme reactively. Reading the data-theme
// attribute during render goes stale: the attribute is set in an effect AFTER
// the toggle's render, so an editor that only reads at render lags one render
// behind (or, with a hardcoded theme, never updates at all).
export function useMonacoTheme(): 'light' | 'vs-dark' {
  const [theme, setTheme] = useState(current);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(current()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    setTheme(current()); // catch a flip between first render and observation
    return () => observer.disconnect();
  }, []);
  return theme;
}
