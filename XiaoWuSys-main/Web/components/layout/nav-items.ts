// The app's sections, grouped the way an inventory system is used (adviser consultation,
// November 2026): selling, the stock itself, the money, and the accounts.
//
// A section with a `capability` is shown only when the server lists that capability for the
// account (can(user, cap)). Never filter on the role name (rules guard: no-role-checks).
// Hiding a link is cosmetic: Express still answers 403 to anyone without the right.
import type { LucideIcon } from 'lucide-react';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  BookUser,
  ClipboardCheck,
  ClipboardList,
  FileSpreadsheet,
  History,
  LayoutDashboard,
  Package,
  PlusCircle,
  Receipt,
  Recycle,
  Scale,
  Truck,
  Users,
  Wallet,
} from 'lucide-react';
import { can, type Capability, type SessionUser } from '@xiaowu/client-core/permissions';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  capability?: Capability;
  /** one line under the label in the menu (what the page is for) */
  hint?: string;
}

export interface NavGroup {
  label: string;
  items: readonly NavItem[];
}

export const NAV_GROUPS: readonly NavGroup[] = [
  {
    label: 'Overview',
    items: [{ href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, hint: 'What needs attention today' }],
  },
  {
    label: 'Sales',
    items: [
      { href: '/orders/new', label: 'Create order', icon: PlusCircle, capability: 'create_order' },
      { href: '/orders', label: 'Orders', icon: ClipboardList, capability: 'view_orders' },
      { href: '/clients', label: 'Clients', icon: BookUser, capability: 'view_orders', hint: 'Profiles and order history' },
    ],
  },
  {
    label: 'Inventory',
    items: [
      { href: '/catalog', label: 'Items', icon: Package, hint: 'The catalog: on hand, held, free' },
      { href: '/inventory/stock-in', label: 'Stock in', icon: ArrowDownToLine, capability: 'view_stock', hint: 'Deliveries and purchases received' },
      { href: '/inventory/stock-out', label: 'Stock out', icon: ArrowUpFromLine, capability: 'view_stock', hint: 'Returns, shop use, samples' },
      { href: '/inventory/stock-count', label: 'Stock count', icon: ClipboardCheck, capability: 'view_stock', hint: 'Physical counts' },
      { href: '/inventory/movements', label: 'Stock card', icon: History, capability: 'view_stock', hint: 'Every movement, with its balance' },
      { href: '/suppliers', label: 'Suppliers', icon: Truck, capability: 'view_stock' },
    ],
  },
  {
    label: 'Finance',
    items: [
      { href: '/finance/payments', label: 'Payments', icon: Wallet, capability: 'view_finance', hint: 'Received per month' },
      { href: '/finance/transactions', label: 'Monthly transactions', icon: FileSpreadsheet, capability: 'view_finance' },
      { href: '/finance/expenses', label: 'Expenses', icon: Receipt, capability: 'view_finance', hint: 'Rent, electricity, wages…' },
      { href: '/finance/profit-and-loss', label: 'Profit & loss', icon: Scale, capability: 'set_quote' },
      { href: '/finance/waste', label: 'Waste', icon: Recycle, capability: 'view_orders', hint: 'This week, this month' },
    ],
  },
  {
    label: 'Administration',
    items: [{ href: '/accounts', label: 'Accounts', icon: Users, capability: 'manage_accounts' }],
  },
];

/** Every section in one flat list (kept for callers that do not group) */
export const NAV_ITEMS: readonly NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

// Where "/" and a fresh login land (the Dashboard: what needs attention today)
export const HOME_PATH = '/dashboard';

const allowed = (user: SessionUser | null) => (item: NavItem) => !item.capability || can(user, item.capability);

export const visibleNavItems = (user: SessionUser | null): NavItem[] => NAV_ITEMS.filter(allowed(user));

/** The groups this account may see, empty groups left out */
export const visibleNavGroups = (user: SessionUser | null): NavGroup[] =>
  NAV_GROUPS.map((g) => ({ ...g, items: g.items.filter(allowed(user)) })).filter((g) => g.items.length > 0);

// The most specific match wins, so /orders/new highlights "Create order", not "Orders".
export const activeHref = (pathname: string, items: readonly NavItem[]): string | null =>
  items
    .filter((item) => pathname === item.href || pathname.startsWith(`${item.href}/`))
    .reduce<string | null>((best, item) => (!best || item.href.length > best.length ? item.href : best), null);
