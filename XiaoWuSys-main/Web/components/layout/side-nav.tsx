'use client';

// The grouped section menu: a fixed sidebar on wide screens, the same list in the phone menu.
// HCI: sections are grouped by what the person is doing (Sales, Inventory, Finance), so a page is
// found by its purpose; the current page is marked by a bar, bold text and aria-current, not by
// colour alone (WCAG 1.4.1). Each link is at least 40px tall for the shop's tablets.
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { activeHref, visibleNavGroups, visibleNavItems } from '@/components/layout/nav-items';
import { useSession } from '@/hooks/use-session';
import { cn } from '@/lib/utils';

export function GroupedNav({ onNavigate, compact = false }: { onNavigate?: () => void; compact?: boolean }) {
  const { user } = useSession();
  const pathname = usePathname();
  const groups = visibleNavGroups(user);
  const current = activeHref(pathname, visibleNavItems(user));
  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <div key={group.label} className="space-y-1">
          <p className="px-3 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">{group.label}</p>
          <ul className="space-y-0.5">
            {group.items.map(({ href, label, icon: Icon, hint }) => {
              const active = href === current;
              return (
                <li key={href}>
                  <Link
                    href={href}
                    onClick={onNavigate}
                    aria-current={active ? 'page' : undefined}
                    title={hint}
                    className={cn(
                      'flex min-h-10 items-center gap-2.5 rounded-r-md border-l-2 border-transparent px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
                      active && 'border-primary bg-muted font-semibold text-foreground'
                    )}
                  >
                    <Icon className="size-4 shrink-0" aria-hidden />
                    <span className="min-w-0">
                      <span className="block truncate">{label}</span>
                      {!compact && hint && <span className="block truncate text-xs font-normal text-muted-foreground">{hint}</span>}
                    </span>
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

/** Wide screens: the menu stays at the left while the page scrolls */
export function SideNav() {
  return (
    <aside
      className="sticky top-[var(--shell-offset,0px)] hidden h-[calc(100dvh-var(--shell-offset,0px))] w-60 shrink-0 overflow-y-auto border-r bg-background py-4 pr-2 lg:block"
    >
      <nav aria-label="Sections">
        <GroupedNav compact />
      </nav>
    </aside>
  );
}
