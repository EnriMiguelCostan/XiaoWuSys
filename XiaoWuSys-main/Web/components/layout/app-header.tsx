'use client';

// Top bar of the signed-in app. Wide screens: inline section links + account menu.
// Phones and tablets in portrait: a menu button opens the same links in a side sheet.
import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronDown, KeyRound, LogOut, Menu, Printer, UserRound } from 'lucide-react';
import type { SessionUser } from '@xiaowu/client-core/permissions';
import { ChangePasswordDialog } from '@/components/account/change-password-dialog';
import { activeHref, visibleNavItems, type NavItem } from '@/components/layout/nav-items';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Separator } from '@/components/ui/separator';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { useSession } from '@/hooks/use-session';
import { cn } from '@/lib/utils';

function NavLinks({
  items,
  current,
  orientation,
  onNavigate,
}: {
  items: NavItem[];
  current: string | null;
  orientation: 'horizontal' | 'vertical';
  onNavigate?: () => void;
}) {
  return (
    <ul className={cn('flex gap-1', orientation === 'vertical' && 'flex-col')}>
      {items.map(({ href, label, icon: Icon }) => {
        const active = href === current;
        return (
          <li key={href}>
            <Link
              href={href}
              onClick={onNavigate}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
                active && 'bg-muted text-foreground'
              )}
            >
              <Icon className="size-4" aria-hidden />
              {label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

// user.role is shown, never compared
function WhoAmI({ user }: { user: SessionUser | null }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="truncate font-medium">{user?.username || 'Signed in'}</span>
      {user?.role && <Badge variant="secondary">{user.role}</Badge>}
    </span>
  );
}

export function AppHeader() {
  const { user, logout } = useSession();
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const items = visibleNavItems(user);
  const current = activeHref(pathname, items);

  const signOut = async () => {
    setSigningOut(true);
    await logout(); // the auth gate takes the user to /login
  };

  const openPassword = () => {
    setMenuOpen(false);
    setPasswordOpen(true);
  };

  return (
    <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-backdrop-filter:bg-background/80">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4">
        {/* Phone / portrait tablet: sections in a sheet */}
        <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open the menu">
              <Menu aria-hidden />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-72 gap-0 p-0">
            <SheetHeader className="border-b">
              <SheetTitle>XiaoMei ERP</SheetTitle>
              <SheetDescription asChild>
                <div className="text-sm">
                  <WhoAmI user={user} />
                </div>
              </SheetDescription>
            </SheetHeader>
            <nav aria-label="Sections" className="p-3">
              <NavLinks items={items} current={current} orientation="vertical" onNavigate={() => setMenuOpen(false)} />
            </nav>
            <Separator />
            <div className="flex flex-col gap-1 p-3">
              <Button variant="ghost" className="justify-start" onClick={openPassword}>
                <KeyRound aria-hidden /> Change my password
              </Button>
              <Button variant="ghost" className="justify-start" onClick={signOut} disabled={signingOut}>
                <LogOut aria-hidden /> {signingOut ? 'Logging out…' : 'Log out on this device'}
              </Button>
            </div>
          </SheetContent>
        </Sheet>

        <Link href="/catalog" className="flex items-center gap-2 font-semibold tracking-tight">
          <Printer className="size-5 text-primary" aria-hidden />
          <span>XiaoMei ERP</span>
        </Link>

        <nav aria-label="Sections" className="ml-4 hidden md:block">
          <NavLinks items={items} current={current} orientation="horizontal" />
        </nav>

        <div className="ml-auto">
          {/* modal={false}: "Change my password" opens a dialog; a modal menu can leave the page unclickable */}
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="gap-2" aria-label="Account menu">
                <UserRound aria-hidden />
                <span className="hidden max-w-40 truncate sm:inline">{user?.username || 'Account'}</span>
                <ChevronDown className="size-3.5 opacity-60" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuLabel>
                <WhoAmI user={user} />
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={openPassword}>
                <KeyRound aria-hidden /> Change my password
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={signOut} disabled={signingOut}>
                <LogOut aria-hidden /> Log out on this device
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <ChangePasswordDialog open={passwordOpen} onOpenChange={setPasswordOpen} />
    </header>
  );
}
