'use client';

// Everything behind login: auth gate, the tab's socket, the connection bar and the header.
//
// The gate is cosmetic: no token -> /login. Every real check is Express's
// 401/403, and a 401 on any request wipes the session (lib/api.ts), which lands here too.
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { LogoSpinner } from '@/components/brand/brand-logo';
import { ConnectionBar } from '@/components/connection/connection-bar';
import { ConnectionProvider } from '@/components/connection/connection-provider';
import { AppHeader } from '@/components/layout/app-header';
import { SideNav } from '@/components/layout/side-nav';
import { OrderLocksProvider } from '@/components/providers/order-locks-provider';
import { SocketProvider } from '@/components/providers/socket-provider';
import { SubPageSlotContext } from '@/components/ui/sub-page';
import { useSidebarCollapsed } from '@/lib/sidebar';
import { cn } from '@/lib/utils';
import { useSession } from '@/hooks/use-session';

function FullPageWait({ text }: { text: string }) {
  return (
    <div className="flex min-h-dvh items-center justify-center">
      <LogoSpinner label={text} size="lg" />
    </div>
  );
}

/**
 * Publishes the sticky header block's height as the CSS variable --shell-offset, so a page-level
 * pin (the Dashboard's low-stock warning, PB 17) can stick just below it instead of under it.
 * Layout measurement only; it follows the header as it wraps on narrow screens.
 */
function useShellOffset() {
  return useCallback((node: HTMLDivElement | null) => {
    if (!node) return undefined;
    const root = document.documentElement;
    const publish = () => root.style.setProperty('--shell-offset', `${node.offsetHeight}px`);
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(node);
    return () => {
      observer.disconnect();
      root.style.removeProperty('--shell-offset');
    };
  }, []);
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { status } = useSession();
  const shellRef = useShellOffset();
  const router = useRouter();
  const [subPageSlot, setSubPageSlot] = useState<HTMLDivElement | null>(null);
  const [sidebarCollapsed] = useSidebarCollapsed();

  // Every login lands on the Dashboard (HOME_PATH), so no ?next= is carried to /login
  useEffect(() => {
    if (status === 'signed_out') router.replace('/login');
  }, [status, router]);

  if (status === 'loading') return <FullPageWait text="Loading…" />;
  if (status === 'signed_out') return <FullPageWait text="Going to the login page…" />;

  return (
    <SocketProvider>
      <ConnectionProvider>
        {/* PB 5: who is editing which order, and "your changes were replaced" notices */}
        <OrderLocksProvider>
        <div className="flex min-h-dvh flex-col bg-muted/30">
          {/* Header and connection bar stick together as ONE opaque block, stacked with flex-col.
              The bar's tint is translucent (e.g. bg-success at 10%), so without the opaque bg-background here the
              page scrolled underneath (search, filters) showed through it; and one block needs no
              hard-coded offset for the header's height. */}
          <div ref={shellRef} className="sticky top-0 z-40 flex flex-col bg-background shadow-xs">
            <AppHeader />
            <ConnectionBar />
          </div>
          {/* Sections at the left on wide screens (the phone menu shows the same list).
              min-w-0: wide content (tables) scrolls inside its own box, never widens the page */}
          <div className="flex min-h-0 flex-1">
            <SideNav />
            {/* data-sub-page-slot: where a sub page renders. While it holds one, the page is hidden and
                the sub page takes its place (components/ui/sub-page.tsx, globals.css "Sub pages") */}
            {/* The page widens by the space the menu gives up when it is collapsed (15rem to 4rem) */}
            <main
              data-page-area
              className={cn('mx-auto w-full min-w-0 flex-1 px-4 py-6 transition-[max-width] duration-200 motion-reduce:transition-none', sidebarCollapsed ? 'lg:max-w-[91rem] max-w-7xl' : 'max-w-7xl')}
            >
              <SubPageSlotContext.Provider value={subPageSlot}>
                <div data-page-main>{children}</div>
              </SubPageSlotContext.Provider>
              <div ref={setSubPageSlot} data-sub-page-slot />
            </main>
          </div>
        </div>
        </OrderLocksProvider>
      </ConnectionProvider>
    </SocketProvider>
  );
}
