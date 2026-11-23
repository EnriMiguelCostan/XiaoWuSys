'use client';

// Top bar of the signed-in app: the brand and the account menu. The sections are in the grouped
// sidebar on wide screens (side-nav.tsx); below that a menu button opens the same list in a sheet.
import { useState } from 'react';
import Link from 'next/link';
import { ChevronDown, KeyRound, LogOut, Menu, UserRound } from 'lucide-react';
import type { SessionUser } from '@xiaowu/client-core/permissions';
import { ChangePasswordDialog } from '@/components/account/change-password-dialog';
import { APP_NAME, BrandLogo } from '@/components/brand/brand-logo';
import { ConfirmDialog } from '@/components/feedback/confirm-dialog';
import { HOME_PATH } from '@/components/layout/nav-items';
import { GroupedNav } from '@/components/layout/side-nav';
import { ThemeToggle } from '@/components/layout/theme-toggle';
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
  const [menuOpen, setMenuOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  // Logging out is confirmed first, so a mis-click on the menu item costs nothing
  const [confirmLogout, setConfirmLogout] = useState(false);

  const signOut = async () => {
    setSigningOut(true);
    await logout(); // the auth gate takes the user to /login
  };

  const askLogout = () => {
    setMenuOpen(false);
    setConfirmLogout(true);
  };

  const openPassword = () => {
    setMenuOpen(false);
    setPasswordOpen(true);
  };

  return (
    // Sticky positioning lives on the shell's wrapper (header + connection bar as one block)
    <header className="border-b bg-background">
      <div className="flex h-14 items-center gap-3 px-4">
        {/* Phone / portrait tablet: sections in a sheet */}
        <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
          <SheetTrigger asChild>
            <Button title="Open the menu" variant="ghost" size="icon" className="lg:hidden" aria-label="Open the menu">
              <Menu aria-hidden />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-72 gap-0 p-0">
            <SheetHeader className="border-b">
              <SheetTitle className="flex items-center gap-2">
                <BrandLogo alt="" className="h-7" />
                {APP_NAME}
              </SheetTitle>
              <SheetDescription asChild>
                <div className="text-sm">
                  <WhoAmI user={user} />
                </div>
              </SheetDescription>
            </SheetHeader>
            <nav aria-label="Sections" className="overflow-y-auto p-3">
              <GroupedNav onNavigate={() => setMenuOpen(false)} />
            </nav>
            <Separator />
            <div className="flex flex-col gap-1 p-3">
              <Button variant="ghost" className="justify-start" onClick={openPassword}>
                <KeyRound aria-hidden /> Change my password
              </Button>
              <Button variant="ghost" className="justify-start" onClick={askLogout} disabled={signingOut}>
                <LogOut aria-hidden /> {signingOut ? 'Logging out…' : 'Log out on this device'}
              </Button>
            </div>
          </SheetContent>
        </Sheet>

        <Link
          href={HOME_PATH}
          className="flex items-center gap-2 rounded-md font-semibold tracking-tight focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <BrandLogo alt="" className="h-8" />
          <span>{APP_NAME}</span>
        </Link>


        <div className="ml-auto flex items-center gap-1">
          <ThemeToggle />
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
              <DropdownMenuItem onSelect={askLogout} disabled={signingOut}>
                <LogOut aria-hidden /> Log out on this device
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <ChangePasswordDialog open={passwordOpen} onOpenChange={setPasswordOpen} />
      <ConfirmDialog
        open={confirmLogout}
        title="Log out?"
        message="You will need to log in again to keep working on this device."
        confirmLabel="Log out"
        danger
        busy={signingOut}
        onConfirm={signOut}
        onCancel={() => setConfirmLogout(false)}
      />
    </header>
  );
}
