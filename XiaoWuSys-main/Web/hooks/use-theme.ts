'use client';

// Decision N8: the device's light / dark choice (stored by lib/session.ts). Applying it only
// switches the .dark class on <html>; every colour comes from the tokens in app/globals.css and
// app/state-tokens.css, so no component changes its logic for dark mode.
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { getServerTheme, getTheme, setTheme, subscribeTheme, type Theme } from '@/lib/session';

export function useTheme(): { theme: Theme; toggle: () => void } {
  const theme = useSyncExternalStore(subscribeTheme, getTheme, getServerTheme);
  const toggle = useCallback(() => setTheme(getTheme() === 'dark' ? 'light' : 'dark'), []);
  return { theme, toggle };
}

/** Keeps <html class="dark"> in step with the stored choice (mounted once, in the root layout). */
export function useApplyTheme() {
  const { theme } = useTheme();
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', theme === 'dark');
    root.style.colorScheme = theme;
  }, [theme]);
}
