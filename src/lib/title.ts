import { useEffect } from 'react';

// The page's name in the tab ("Shiori — Library"). The desktop app's title bar reads it from there.
export function useTitle(name?: string) {
  useEffect(() => {
    document.title = name ? `Shiori — ${name}` : 'Shiori';
  }, [name]);
}
