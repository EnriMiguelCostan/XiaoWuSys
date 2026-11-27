'use client';

// The grouped section menu: a fixed sidebar on wide screens, the same list in the phone menu.
// HCI: sections are grouped by what the person is doing (Sales, Inventory, Finance), so a page is
// found by its purpose; the current page is marked by a bar, bold text and aria-current, not by
// colour alone (WCAG 1.4.1). Each link is at least 40px tall for the shop's tablets.
// The wide-screen menu can be collapsed to its icons (lib/sidebar.ts); the page beside it then
// widens into the space (app-shell.tsx).
import Link from 'next/link';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { activeHref, visibleNavGroups, visibleNavItems } from '@/components/layout/nav-items';
import { useSession } from '@/hooks/use-session';
import { cn } from '@/lib/utils';
import { useSidebarCollapsed } from '@/lib/sidebar';

export function GroupedNav({ onNavigate, compact = false, iconsOnly = false }: { onNavigate?: () => void; compact?: boolean; iconsOnly?: boolean }) {
  const { user } = useSession();
  const pathname = usePathname();
  const groups = visibleNavGroups(user);
  const current = activeHref(pathname, visibleNavItems(user));
  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <div key={group.label} className="space-y-1">
          {iconsOnly ? (
            // The group names do not fit beside icons: a thin line separates the groups instead
            <hr aria-hidden className="mx-3 border-border" />
          ) : (
            <p className="px-3 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">{group.label}</p>
          )}
          <ul className="space-y-0.5">
            {group.items.map(({ href, label, icon: Icon, hint }) => {
              const active = href === current;
              return (
                <li key={href}>
                  <Link
                    href={href}
                    onClick={onNavigate}
                    aria-current={active ? 'page' : undefined}
                    aria-label={iconsOnly ? label : undefined}
                    title={iconsOnly ? (hint ? `${label}: ${hint}` : label) : hint}
                    className={cn(
                      'flex min-h-10 items-center gap-2.5 rounded-r-md border-l-2 border-transparent px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
                      active && 'border-primary bg-muted font-semibold text-foreground',
                      iconsOnly && 'justify-center px-0'
                    )}
                  >
                    <Icon className="size-4 shrink-0" aria-hidden />
                    {!iconsOnly && (
                      <span className="min-w-0">
                        <span className="block truncate">{label}</span>
                        {!compact && hint && <span className="block truncate text-xs font-normal text-muted-foreground">{hint}</span>}
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** Wide screens: the menu stays at the left while the page scrolls; it collapses to its icons */
export function SideNav() {
  const [collapsed, setCollapsed] = useSidebarCollapsed();
  const Toggle = collapsed ? PanelLeftOpen : PanelLeftClose;
  return (
    <aside
      className={cn(
        'sticky top-[var(--shell-offset,0px)] hidden h-[calc(100dvh-var(--shell-offset,0px))] shrink-0 overflow-x-hidden overflow-y-auto border-r bg-background pt-2 pb-4 transition-[width] duration-200 motion-reduce:transition-none lg:block',
        collapsed ? 'w-16 pr-1' : 'w-60 pr-2'
      )}
    >
      <div className={cn('mb-2 flex', collapsed ? 'justify-center pl-1' : 'justify-end')}>
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand the menu' : 'Collapse the menu'}
          title={collapsed ? 'Expand the menu' : 'Collapse the menu to icons'}
          className="inline-flex size-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <Toggle className="size-4" aria-hidden />
        </button>
      </div>
      <nav aria-label="Sections">
        <GroupedNav compact iconsOnly={collapsed} />
      </nav>
    </aside>
  );
}
