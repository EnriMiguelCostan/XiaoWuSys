'use client';

// Whether the side menu is collapsed to icons. Kept on this computer (lib/session.ts
// preferences), so each person's choice stays after a reload; shared by the menu and the page
// beside it.
import { useCallback, useSyncExternalStore } from 'react';
import { readPreference, writePreference } from '@/lib/session';

const NAME = 'sidebarCollapsed';
const listeners = new Set<() => void>();

const read = () => readPreference(NAME) === '1';

function subscribe(listener: () => void) {
  listeners.add(listener);
  // Another tab changed it
  window.addEventListener('storage', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}

/** [collapsed, setCollapsed] */
export function useSidebarCollapsed(): [boolean, (collapsed: boolean) => void] {
  const collapsed = useSyncExternalStore(subscribe, read, () => false);
  const set = useCallback((next: boolean) => {
    writePreference(NAME, next ? '1' : '0');
    listeners.forEach((l) => l());
  }, []);
  return [collapsed, set];
}
