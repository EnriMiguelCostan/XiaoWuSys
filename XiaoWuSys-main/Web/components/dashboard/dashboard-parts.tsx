'use client';

// Pat's dashboard components (from the stress-tested mock), wired to live data.
// Kept from the mock: the layout, Card structure, table-fixed tables, and truncation with the
// full value on hover. Changed: colours come from lib/ui-tokens.ts (steering §3.2) instead of
// hard-coded amber/emerald/yellow; money and dates use the shared client-core formatters.
// Every number is a server figure; nothing here adds, subtracts or compares money or stock.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { LucideIcon } from 'lucide-react';
import { TriangleAlert } from 'lucide-react';
import { formatDateTime, peso } from '@xiaowu/client-core/format';
import { orderNumber } from '@xiaowu/client-core/orders';
import { DeadlineBadge, OrderStatusBadge, PaymentStatusBadge } from '@/components/orders/status-badges';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { DashboardOrder, RestockItem } from '@/lib/reports';
import { TONE_CLASSES, type Tone } from '@/lib/ui-tokens';
import { cn } from '@/lib/utils';

/** Materials named in the low-stock warning before "and N more" (same as the MVP) */
const PIN_NAMES = 4;

/** The M3 orders screen opens its detail sheet from ?order=<order_id> */
const orderHref =(orderId: string) => `/orders?order=${encodeURIComponent(orderId)}`;

/** Truncating table-cell content; full value stays available on hover. */
export function Cell({ value, className }: { value: string; className?: string }) {
  return (
    <div className={cn('min-w-0 truncate', className)} title={value}>
      {value}
    </div>
  );
}

// PB 17: pinned at the top of the Dashboard while any material needs restocking. It sticks just
// below the shell's header block (--shell-offset, published by AppShell), updates live (the
// screen reloads on 'inventory_updated') and disappears once stock is added.
export function LowStockBanner({ items, outOfStock }: { items: RestockItem[]; outOfStock: number }) {
  if (items.length === 0) return null;
  const named = items.slice(0, PIN_NAMES).map((i) => `${i.item_name} (${i.free.toLocaleString()} ${i.unit} free)`);
  const more = items.length > PIN_NAMES ? `, and ${(items.length - PIN_NAMES).toLocaleString()} more` : '';
  const names = `${named.join(', ')}${more}`;
  return (
    // Opaque layer under the translucent warning tint, so the page never shows through while pinned
    <div className="sticky top-(--shell-offset,0px) z-30 -mx-1 rounded-lg bg-background px-1 pt-1 pb-1">
      <div role="status" aria-live="polite" className={cn('rounded-lg border border-l-4 border-l-warning shadow-xs', TONE_CLASSES.warning.banner)}>
        <div className="flex w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
          <TriangleAlert className="size-5 shrink-0" aria-hidden />
          <div className="min-w-0 flex-1 text-sm text-foreground">
            <p className="font-semibold">
              Low stock: {items.length.toLocaleString()} {items.length === 1 ? 'material needs' : 'materials need'} restocking
              {outOfStock > 0 && ` (${outOfStock.toLocaleString()} out of stock)`}
            </p>
            <p className="truncate text-xs" title={names}>
              {names}
            </p>
          </div>
          <a href="#restock-list" className="shrink-0 text-sm font-semibold whitespace-nowrap text-foreground underline underline-offset-4">
            See restock list
          </a>
        </div>
      </div>
    </div>
  );
}

export function SummaryCard({
  title,
  icon: Icon,
  value,
  footnote,
  tone = 'muted',
}: {
  title: string;
  icon: LucideIcon;
  value: string;
  footnote?: string;
  tone?: Tone;
}) {
  return (
    <Card className="min-w-0">
      <CardHeader className="min-w-0">
        <CardDescription className="min-w-0 truncate" title={title}>
          {title}
        </CardDescription>
        <CardAction>
          <span className={cn('flex size-8 items-center justify-center rounded-lg border', TONE_CLASSES[tone].badge)}>
            <Icon className="size-4" aria-hidden />
          </span>
        </CardAction>
        <CardTitle className={cn('min-w-0 truncate text-2xl font-semibold tabular-nums', TONE_CLASSES[tone].text)} title={value}>
          {value}
        </CardTitle>
      </CardHeader>
      {footnote && (
        <CardContent className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className="min-w-0 truncate" title={footnote}>
            {footnote}
          </span>
        </CardContent>
      )}
    </Card>
  );
}

/**
 * Pat's "Recent Orders" table, reused for each order list the endpoint returns.
 * money: which server figures to show (balance lists: finance accounts only), or none.
 * Every row opens that order's detail sheet on the Orders screen; the order number is also a
 * real link, so keyboard and screen-reader users reach it with Tab.
 */
export function OrdersTableCard({
  id,
  title,
  description,
  empty,
  orders,
  money,
  tone,
  icon: Icon,
}: {
  id?: string;
  title: string;
  description: string;
  empty: string;
  orders: DashboardOrder[];
  money: 'balance' | 'overpaid' | null;
  tone?: Tone;
  icon?: LucideIcon;
}) {
  const router = useRouter();
  const overpaid = money === 'overpaid';
  return (
    <Card id={id} className={cn('min-w-0', overpaid && 'border-danger/40')}>
      <CardHeader className="min-w-0">
        <CardTitle className={cn('flex min-w-0 items-center gap-2', tone && TONE_CLASSES[tone].text)}>
          {Icon && <Icon className="size-5 shrink-0" aria-hidden />}
          <span className="truncate">{title}</span>
        </CardTitle>
        <CardDescription className={cn(overpaid ? 'wrap-anywhere' : 'truncate')}>{description}</CardDescription>
      </CardHeader>
      <CardContent className="min-w-0 px-0">
        {orders.length === 0 ? (
          <p className="px-4 text-sm text-muted-foreground">{empty}</p>
        ) : (
          <Table className="table-fixed">
            {/* table-fixed: widths come from this header row; Customer takes the rest. */}
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-32 pl-4 sm:w-40">Order #</TableHead>
                <TableHead className="hidden sm:table-cell">Customer</TableHead>
                {overpaid && <TableHead className="hidden w-28 text-right md:table-cell">Price</TableHead>}
                {overpaid && <TableHead className="hidden w-28 text-right md:table-cell">Paid</TableHead>}
                {money && <TableHead className="w-28 text-right sm:w-36">{overpaid ? 'Paid too much' : 'Balance'}</TableHead>}
                {money === 'balance' && <TableHead className="hidden w-28 lg:table-cell">Payment</TableHead>}
                <TableHead className="w-28 pr-4 xl:pr-2">Status</TableHead>
                {!overpaid && <TableHead className="hidden w-32 pr-4 md:table-cell">Deadline</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.map((order) => (
                <TableRow key={order.order_id} className="cursor-pointer" onClick={() => router.push(orderHref(order.order_id))}>
                  <TableCell className="pl-4">
                    <Link
                      href={orderHref(order.order_id)}
                      onClick={(e) => e.stopPropagation()}
                      className="block min-w-0 truncate font-mono text-xs underline-offset-4 hover:underline"
                      title={`Open order ${orderNumber(order)}`}
                    >
                      {orderNumber(order)}
                    </Link>
                    {/* Phones: customer stacks under the order number. */}
                    <Cell className="text-xs text-muted-foreground sm:hidden" value={order.customer_name} />
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <Cell className="font-medium" value={order.customer_name} />
                  </TableCell>
                  {overpaid && (
                    <TableCell className="hidden text-right md:table-cell">
                      <Cell className="tabular-nums" value={peso(order.total_quote_amount)} />
                    </TableCell>
                  )}
                  {overpaid && (
                    <TableCell className="hidden text-right md:table-cell">
                      <Cell className="tabular-nums" value={peso(order.total_paid)} />
                    </TableCell>
                  )}
                  {money && (
                    <TableCell className="text-right">
                      <Cell
                        className={cn('tabular-nums', overpaid && cn('font-semibold', TONE_CLASSES.danger.text))}
                        value={peso(overpaid ? order.overpaid_by : order.balance)}
                      />
                    </TableCell>
                  )}
                  {money === 'balance' && (
                    <TableCell className="hidden lg:table-cell">
                      <div className="min-w-0 truncate">
                        <PaymentStatusBadge status={order.payment_status} />
                      </div>
                    </TableCell>
                  )}
                  <TableCell className="pr-4 xl:pr-2">
                    <div className="min-w-0 truncate">
                      <OrderStatusBadge status={order.production_status} />
                    </div>
                  </TableCell>
                  {!overpaid && (
                    <TableCell className="hidden pr-4 text-muted-foreground md:table-cell">
                      <Cell value={formatDateTime(order.production_deadline, { withTime: false })} />
                      <DeadlineBadge flag={order.deadline_flag} className="mt-1" />
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
