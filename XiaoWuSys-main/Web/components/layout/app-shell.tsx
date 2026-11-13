'use client';

// Everything behind login: auth gate, the tab's socket, the connection bar and the header.
//
// The gate is cosmetic (steering §2.3): no token -> /login. Every real check is Express's
// 401/403, and a 401 on any request wipes the session (lib/api.ts), which lands here too.
import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Loader } from 'lucide-react';
import { ConnectionBar } from '@/components/connection/connection-bar';
import { ConnectionProvider } from '@/components/connection/connection-provider';
import { AppHeader } from '@/components/layout/app-header';
import { SocketProvider } from '@/components/providers/socket-provider';
import { useSession } from '@/hooks/use-session';

function FullPageWait({ text }: { text: string }) {
  return (
    <div className="flex min-h-dvh items-center justify-center gap-2 text-sm text-muted-foreground" role="status">
      <Loader className="size-4 animate-spin" aria-hidden />
      {text}
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { status } = useSession();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (status === 'signed_out') router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [status, router, pathname]);

  if (status === 'loading') return <FullPageWait text="Loading…" />;
  if (status === 'signed_out') return <FullPageWait text="Going to the login page…" />;

  return (
    <SocketProvider>
      <ConnectionProvider>
        <div className="flex min-h-dvh flex-col bg-muted/30">
          <AppHeader />
          <div className="sticky top-14 z-30">
            <ConnectionBar />
          </div>
          <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">{children}</main>
        </div>
      </ConnectionProvider>
    </SocketProvider>
  );
}
