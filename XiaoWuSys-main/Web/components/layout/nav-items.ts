// The app's sections (the Vite MVP tabs, now routes so pages are linkable).
//
// A section with a `capability` is shown only when the server lists that capability for the
// account (can(user, cap)). Never filter on the role name (rules guard: no-role-checks).
// Hiding a link is cosmetic: Express still answers 403 to anyone without the right.
import type { LucideIcon } from 'lucide-react';
import { ClipboardList, LayoutDashboard, Package, PlusCircle, Users } from 'lucide-react';
import { can, type Capability, type SessionUser } from '@xiaowu/client-core/permissions';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  capability?: Capability;
}

// Dashboard first: it is the home page (HOME_PATH below)
export const NAV_ITEMS: readonly NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/catalog', label: 'Catalog', icon: Package },
  { href: '/orders/new', label: 'Create Order', icon: PlusCircle, capability: 'create_order' },
  { href: '/orders', label: 'Orders', icon: ClipboardList, capability: 'view_orders' },
  { href: '/accounts', label: 'Accounts', icon: Users, capability: 'manage_accounts' },
];

// Where "/" and a fresh login land (the Dashboard: what needs attention today)
export const HOME_PATH = '/dashboard';

export const visibleNavItems = (user: SessionUser | null): NavItem[] =>
  NAV_ITEMS.filter((item) => !item.capability || can(user, item.capability));

// The most specific match wins, so /orders/new highlights "Create Order", not "Orders".
export const activeHref = (pathname: string, items: readonly NavItem[]): string | null =>
  items
    .filter((item) => pathname === item.href || pathname.startsWith(`${item.href}/`))
    .reduce<string | null>((best, item) => (!best || item.href.length > best.length ? item.href : best), null);
