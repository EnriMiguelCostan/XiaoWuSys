'use client';

// Keeps the light / dark theme the same on every page.

import { useApplyTheme } from '@/hooks/use-theme';

/** Decision N8: applies the device's theme on every page, the login screen included. */
export function ThemeSync() {
  useApplyTheme();
  return null;
}
