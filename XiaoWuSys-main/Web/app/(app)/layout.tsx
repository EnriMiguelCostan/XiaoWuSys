import { AppShell } from '@/components/layout/app-shell';

// Every page in (app)/ is behind login and talks to Express from the browser (steering §2.3).
export default function SignedInLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <AppShell>{children}</AppShell>;
}
