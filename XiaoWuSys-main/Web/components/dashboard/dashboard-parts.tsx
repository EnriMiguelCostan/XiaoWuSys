// Pat's dashboard components (from the stress-tested mock), wired to live data.
// Kept from the mock: the layout, Card structure, table-fixed tables, and truncation with the
// full value on hover. Changed: colours come from lib/ui-tokens.ts (steering §3.2) instead of
// hard-coded amber/emerald/yellow; money and dates use the shared client-core formatters; the
// low-stock banner is the first block of the page instead of sticky (the shell's header block
// is already sticky, and two sticky layers overlapped). Every number is a server figure.
import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import { TriangleAlert } from 'lucide-react';
import { formatDateTime, peso } from '@xiaowu/client-core/format';
import { orderNumber } from '@xiaowu/client-core/orders';
import { OrderStatusBadge, PaymentStatusBadge } from '@/components/orders/status-badges';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { DashboardOrder, RestockItem } from '@/lib/reports';
import { TONE_CLASSES, type Tone } from '@/lib/ui-tokens';
import { cn } from '@/lib/utils';

/** Truncating table-cell content; full value stays available on hover. */
export function Cell({ value, className }: { value: string; className?: string }) {
  return (
    <div className={cn('min-w-0 truncate', className)} title={value}>
      {value}
    </div>
  );
}

// PB 17: pinned at the top of the Dashboard while any material needs restocking; it updates
// live (the screen reloads on 'inventory_updated') and disappears once stock is added.
export function LowStockBanner({ items, outOfStock }: { items: RestockItem[]; outOfStock: number }) {
  if (items.length === 0) return null;
  const names = items.map((i) => `${i.item_name} (${i.free.toLocaleString()} ${i.unit} free)`).join(', ');
  return (
    <div role="status" aria-live="polite" className={cn('rounded-lg border border-l-4 border-l-warning', TONE_CLASSES.warning.banner)}>
      <div className="flex w-full min-w-0 items-center gap-3 px-4 py-2.5">
        <TriangleAlert className="size-5 shrink-0" aria-hidden />
        <p className="min-w-0 flex-1 truncate text-sm text-foreground" title={names}>
          <span className="font-semibold">Low-stock warning:</span> {items.length} {items.length === 1 ? 'material needs' : 'materials need'} restocking
          {outOfStock > 0 && ` (${outOfStock} out of stock)`} — {names}
        </p>
        <a href="#restock-list" className="shrink-0 text-sm font-semibold whitespace-nowrap text-foreground underline-offset-4 hover:underline">
          See restock list
        </a>
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
  footnote: string;
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
        <CardTitle className="min-w-0 truncate text-2xl font-semibold tabular-nums" title={value}>
          {value}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <span className="min-w-0 truncate" title={footnote}>
          {footnote}
        </span>
      </CardContent>
    </Card>
  );
}

/**
 * Pat's "Recent Orders" table, reused for each order list the endpoint returns.
 * money: which server figure to show (finance accounts only), or none.
 */
export function OrdersTableCard({
  id,
  title,
  description,
  empty,
  orders,
  money,
  tone,
}: {
  id?: string;
  title: string;
  description: string;
  empty: string;
  orders: DashboardOrder[];
  money: 'balance' | 'overpaid' | null;
  tone?: Tone;
}) {
  return (
    <Card id={id} className="min-w-0">
      <CardHeader className="min-w-0">
        <CardTitle className={cn('truncate', tone && TONE_CLASSES[tone].text)}>{title}</CardTitle>
        <CardDescription className="truncate">{description}</CardDescription>
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
                {money && <TableHead className="w-28 text-right sm:w-36">{money === 'overpaid' ? 'Paid too much' : 'Balance'}</TableHead>}
                {money && <TableHead className="hidden w-28 lg:table-cell">Payment</TableHead>}
                <TableHead className="w-28 pr-4 xl:pr-2">Status</TableHead>
                <TableHead className="hidden w-32 pr-4 md:table-cell">Deadline</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.map((order) => (
                <TableRow key={order.order_id}>
                  <TableCell className="pl-4">
                    <Link
                      href={`/orders?order=${encodeURIComponent(order.order_id)}`}
                      className="block min-w-0 truncate font-mono text-xs underline-offset-4 hover:underline"
                      title={orderNumber(order)}
                    >
                      {orderNumber(order)}
                    </Link>
                    {/* Phones: customer stacks under the order number. */}
                    <Cell className="text-xs text-muted-foreground sm:hidden" value={order.customer_name} />
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <Cell className="font-medium" value={order.customer_name} />
                  </TableCell>
                  {money && (
                    <TableCell className="text-right">
                      <Cell
                        className={cn('tabular-nums', money === 'overpaid' && 'font-semibold text-danger')}
                        value={peso(money === 'overpaid' ? order.overpaid_by : order.balance)}
                      />
                    </TableCell>
                  )}
                  {money && (
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
                  <TableCell className="hidden pr-4 text-muted-foreground md:table-cell">
                    <Cell value={formatDateTime(order.production_deadline, { withTime: false })} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
