'use client';

// Sub page addresses (components/ui/sub-page.tsx). A screen at `base` (e.g. /catalog) opens its
// sub pages at base/<path> (/catalog/new, /catalog/<item id>, /orders/<order id>…).
//
// Opening one uses the browser's own history (history.pushState, which Next.js follows through
// usePathname) instead of a router navigation, so the screen stays mounted: the list keeps its
// filters, its loaded rows and its place. The browser's Back button closes the sub page. Each
// screen also has a catch-all route (app/(app)/<screen>/[...sub]/page.tsx) rendering the same
// screen, so a link to a sub page or a reload on one opens it directly.
import { useCallback } from 'react';
import { usePathname } from 'next/navigation';

// Marks a history entry this app pushed for a sub page, so closing it can step Back instead of
// adding yet another entry (which would make the browser's Back button reopen it)
const MARK = 'xwSubPage';

/** The segments of `pathname` after `base`, decoded; null on `base` itself */
export function subPathOf(pathname: string, base: string): string[] | null {
  if (!pathname.startsWith(`${base}/`)) return null;
  const parts = pathname
    .slice(base.length + 1)
    .split('/')
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
  return parts.length ? parts : null;
}

/** A link to a sub page from another screen, e.g. subHref('/orders', id) */
export const subHref = (base: string, ...path: string[]) => `${base}/${path.map(encodeURIComponent).join('/')}`;

/**
 * [sub, go]: sub is the open sub page's path under `base` as segments (['new'], ['<id>'],
 * ['<id>', 'edit']…) or null. go(['<id>', 'edit']) opens base/<id>/edit (each segment encoded);
 * go(null) closes the open sub page and returns to the page before.
 */
export function useSubPath(base: string): [string[] | null, (path: string[] | null) => void] {
  const pathname = usePathname();
  const sub = subPathOf(pathname, base);

  const go = useCallback(
    (path: string[] | null) => {
      if (path === null) {
        if (window.history.state?.[MARK]) window.history.back();
        else window.history.replaceState(null, '', base);
        return;
      }
      const url = `${base}/${path.map(encodeURIComponent).join('/')}`;
      // Already there (e.g. a row's click and its name link's click both asked): no second entry
      if (window.location.pathname === url) return;
      window.history.pushState({ [MARK]: true }, '', url);
    },
    [base]
  );

  return [sub, go];
}
