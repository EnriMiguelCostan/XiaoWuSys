'use client';

// Decision N8: the device's light / dark choice (stored by lib/session.ts). Applying it only
// switches the .dark class on <html>; every colour comes from the tokens in app/globals.css and
// app/state-tokens.css, so no component changes its logic for dark mode.
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { getServerTheme, getTheme, setTheme, subscribeTheme, type Theme } from '@/lib/session';

/** Puts the theme on <html> (class + native control colours). */
const applyThemeClass = (theme: Theme) => {
  const root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
  root.style.colorScheme = theme;
};

const THEME_FADE_MS = 450; // keep in step with the durations in app/globals.css

/**
 * Switches the theme with a soft cross-fade instead of a hard flash:
 *   - View Transitions API (Chrome, Edge, Safari 18+): the old and new page fade into each
 *     other, logos and images included
 *   - otherwise: colours ease over the same time (the .theme-fading class in globals.css)
 *   - "reduce motion" in the device settings: instant, no animation
 */
const switchThemeSmoothly = (next: Theme) => {
  const apply = () => {
    applyThemeClass(next);
    setTheme(next);
  };
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduceMotion) return apply();

  const doc = document as Document & { startViewTransition?: (update: () => void) => unknown };
  if (typeof doc.startViewTransition === 'function') {
    doc.startViewTransition(apply);
    return;
  }

  const root = document.documentElement;
  root.classList.add('theme-fading');
  apply();
  window.setTimeout(() => root.classList.remove('theme-fading'), THEME_FADE_MS);
};

export function useTheme(): { theme: Theme; toggle: () => void } {
  const theme = useSyncExternalStore(subscribeTheme, getTheme, getServerTheme);
  const toggle = useCallback(() => switchThemeSmoothly(getTheme() === 'dark' ? 'light' : 'dark'), []);
  return { theme, toggle };
}

/** Keeps <html class="dark"> in step with the stored choice (mounted once, in the root layout). */
export function useApplyTheme() {
  const { theme } = useTheme();
  useEffect(() => {
    applyThemeClass(theme);
  }, [theme]);
}
