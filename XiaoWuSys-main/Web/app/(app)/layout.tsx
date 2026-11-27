// The layout of every signed-in page: the header, the side menu and the page (AppShell).

import { AppShell } from '@/components/layout/app-shell';

// Every page in (app)/ is behind login and talks to Express from the browser.
export default function SignedInLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <AppShell>{children}</AppShell>;
}
