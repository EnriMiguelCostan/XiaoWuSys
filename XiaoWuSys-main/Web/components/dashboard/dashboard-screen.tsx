'use client';

// Dashboard (ported from Dashboard.jsx, in Pat's layout): what needs attention today.
//   GET /api/reports/dashboard          orders due / overdue, unpaid, overpaid, income, restock list
//   GET /api/reports/export/*.csv       Excel / Google Sheets downloads
// Money panels and the orders / payments exports are for accounts with view_finance (the
// server also refuses the exports for everyone else). The Overpaid panel appears only when the
// server returns rows (it leaves the list empty for accounts without view_finance).
// Refreshes: when stock changes anywhere ('inventory_updated'), after a sync, and every 30 s
// ONLY while the live socket is down (useFallbackPolling).
import { useCallback, useEffect, useState } from 'react';
import { AlarmClock, CalendarClock, CloudOff, Copy, Download, PackageX, RefreshCw, ShoppingCart, TriangleAlert, Wallet } from 'lucide-react';
import { formatDateTime, peso } from '@xiaowu/client-core/format';
import { can } from '@xiaowu/client-core/permissions';
import { useConnection } from '@/components/connection/connection-provider';
import { Cell, LowStockBanner, OrdersTableCard, SummaryCard } from '@/components/dashboard/dashboard-parts';
import { ResultDialog, type ResultMessage } from '@/components/feedback/result-dialog';
import { OrderStatusBadge } from '@/components/orders/status-badges';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useApi } from '@/hooks/use-api';
import { useFallbackPolling } from '@/hooks/use-fallback-polling';
import { useSession } from '@/hooks/use-session';
import { useSocketEvent } from '@/hooks/use-socket-event';
import { downloadFile, errorMessage } from '@/lib/api';
import { copyText } from '@/lib/print';
import { monthLabel, type Dashboard, type RestockItem } from '@/lib/reports';
import { lookFor, STOCK_STATUS, TONE_CLASSES } from '@/lib/ui-tokens';
import { cn } from '@/lib/utils';

type Loaded = { key: string; data: Dashboard | null; error: string };

const DASHBOARD_POLL_MS = 30_000;

export function DashboardScreen() {
  const api = useApi();
  const { user } = useSession();
  const canSeeMoney = can(user, 'view_finance');
  const { syncGeneration } = useConnection();
  const [tick, setTick] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [result, setResult] = useState<ResultMessage | null>(null);

  const requestKey = `${tick}|${syncGeneration}`;
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    api<Dashboard>('GET', '/reports/dashboard').then(({ ok, data }) => {
      if (cancelled) return;
      // A failed refresh keeps the last figures on screen, with the error above them
      setLoaded((prev) =>
        ok && data.orders
          ? { key: requestKey, data, error: '' }
          : { key: requestKey, data: prev?.data ?? null, error: errorMessage(data, 'The dashboard could not be loaded.') }
      );
    });
    return () => {
      cancelled = true;
    };
  }, [api, requestKey]);

  // PB 17: the low-stock banner and restock list follow stock changes live
  useSocketEvent('inventory_updated', reload);
  // PB 14: an order changed on any branch (status, deadline, new order): the lists follow, no polling
  useSocketEvent('order_updated', reload);
  // No pushes while the socket is down: re-read on a timer until it is back (never while live)
  useFallbackPolling(reload, DASHBOARD_POLL_MS);

  const loading = !loaded || loaded.key !== requestKey;
  // The last figures stay on screen while a refresh is on its way
  const data = loaded?.data ?? null;
  const error = loaded && loaded.key === requestKey ? loaded.error : '';

  const download = async (kind: 'inventory' | 'orders' | 'payments') => {
    const r = await downloadFile(`/reports/export/${kind}.csv`);
    setResult(
      r.ok
        ? {
            type: 'success',
            title: 'Download ready',
            message: `${r.name} was downloaded. Open it with Excel or Google Sheets.${r.offline ? '\nNote: made from the offline copy on this computer.' : ''}`,
          }
        : { type: 'error', title: 'Download failed', message: r.message }
    );
  };

  const copyRestock = async (list: RestockItem[], today: string) => {
    const lines = list.map(
      (r) => `• ${r.item_name}: buy ${r.suggested_order} ${r.unit} (free: ${r.free}${r.supplier ? `, supplier: ${r.supplier}` : ''})`
    );
    const ok = await copyText(`XiaoMei restock list (${formatDateTime(today, { withTime: false })})\n${lines.join('\n')}`);
    setResult(
      ok
        ? { type: 'success', title: 'Copied', message: 'The restock list was copied. Paste it in Messenger, a note or an email.' }
        : { type: 'error', title: 'Could not copy', message: 'Your browser blocked copying. Select the list and copy it by hand.' }
    );
  };

  const header = (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <header className="flex min-w-0 flex-col gap-1">
        <h1 className="truncate text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="truncate text-sm text-muted-foreground">
          {data
            ? `Today is ${formatDateTime(data.today, { withTime: false })} · updated ${formatDateTime(data.generated_at.slice(0, 19), { utc: true })}`
            : 'Snapshot of today’s orders, payments and stock.'}
        </p>
      </header>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => download('inventory')}>
          <Download aria-hidden /> Inventory (Excel)
        </Button>
        {canSeeMoney && (
          <>
            <Button variant="outline" onClick={() => download('orders')}>
              <Download aria-hidden /> Orders (Excel)
            </Button>
            <Button variant="outline" onClick={() => download('payments')}>
              <Download aria-hidden /> Payments (Excel)
            </Button>
          </>
        )}
        <Button variant="outline" onClick={reload} disabled={loading}>
          <RefreshCw className={cn(loading && 'animate-spin')} aria-hidden /> {loading ? 'Loading…' : 'Refresh'}
        </Button>
      </div>
    </div>
  );

  if (!data) {
    return (
      <div className="flex min-w-0 flex-col gap-6">
        {header}
        {error ? (
          <p role="alert" className={cn('rounded-md border p-3 text-sm', TONE_CLASSES.danger.banner)}>
            {error}
          </p>
        ) : (
          <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4" role="status" aria-label="Loading the dashboard">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-32 w-full" />
            ))}
            <Skeleton className="h-64 w-full sm:col-span-2 xl:col-span-4" />
          </div>
        )}
        <ResultDialog result={result} onClose={() => setResult(null)} />
      </div>
    );
  }

  const { orders, inventory, income_by_month: income, top_materials: top } = data;
  // Longest bar = the busiest month (a scale for the bars, not a figure shown to anyone)
  const busiestMonth = Math.max(0, ...income.map((m) => m.amount));

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <LowStockBanner items={inventory.restock} outOfStock={inventory.summary.out_of_stock} />
      {header}

      {data.source === 'local' && (
        <p className={cn('flex items-center gap-2 rounded-md border p-3 text-sm', TONE_CLASSES.warning.banner)}>
          <CloudOff className="size-4 shrink-0" aria-hidden /> Offline: these numbers come from the copy on this computer.
        </p>
      )}
      {error && (
        <p role="alert" className={cn('rounded-md border p-3 text-sm', TONE_CLASSES.danger.banner)}>
          {error} Showing the last loaded figures.
        </p>
      )}

      {/* PB 21 / D2: branches that together overpaid while offline. The Owner refunds by hand.
          Shown whenever the server returns rows; it returns none to accounts without view_finance. */}
      {orders.overpaid.length > 0 && (
        <OrdersTableCard
          title={`Overpaid: review and refund (${orders.overpaid.length.toLocaleString()})`}
          description={`These orders received more than their price, usually because two branches took payments while offline. Total to review: ${peso(orders.overpaid_total)}. Refunds are given outside the system.`}
          empty=""
          orders={orders.overpaid}
          money="overpaid"
          tone="danger"
          icon={TriangleAlert}
        />
      )}

      <section aria-label="Summary" className={cn('grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2', canSeeMoney ? 'xl:grid-cols-5' : 'xl:grid-cols-4')}>
        <SummaryCard
          title="Overdue orders"
          icon={AlarmClock}
          value={orders.overdue.length.toLocaleString()}
          footnote="Open orders past their deadline"
          tone={orders.overdue.length ? 'danger' : 'success'}
        />
        <SummaryCard
          title="Due in 7 days"
          icon={CalendarClock}
          value={orders.due_this_week.length.toLocaleString()}
          footnote="Open orders with a deadline this week"
          tone="warning"
        />
        <SummaryCard title="Open orders" icon={ShoppingCart} value={orders.open.toLocaleString()} footnote="Not completed or cancelled" tone="info" />
        {canSeeMoney && (
          <SummaryCard
            title="Unpaid balance"
            icon={Wallet}
            value={peso(orders.outstanding_balance)}
            footnote={`${orders.unpaid_count.toLocaleString()} order(s)`}
            tone="info"
          />
        )}
        <SummaryCard
          title="Needs restocking"
          icon={PackageX}
          value={inventory.restock.length.toLocaleString()}
          footnote={`${inventory.summary.out_of_stock.toLocaleString()} out of stock`}
          tone={inventory.restock.length ? 'danger' : 'success'}
        />
      </section>

      <div className="grid min-w-0 grid-cols-1 gap-6 xl:grid-cols-2">
        <OrdersTableCard
          title="Overdue"
          icon={AlarmClock}
          description="Open orders past their deadline, oldest first."
          empty="Nothing is overdue."
          orders={orders.overdue}
          money={canSeeMoney ? 'balance' : null}
          tone={orders.overdue.length ? 'danger' : undefined}
        />
        <OrdersTableCard
          title="Due in the next 7 days"
          description="Open orders by deadline."
          empty="No deadlines this week."
          orders={orders.due_this_week}
          money={canSeeMoney ? 'balance' : null}
        />
      </div>

      {/* Restock list (suggested amounts are the server's: back to twice the alert level) */}
      <Card id="restock-list" className="min-w-0 scroll-mt-[calc(var(--shell-offset,0px)+6rem)]">
        <CardHeader className="min-w-0">
          <CardTitle className="truncate">Restock list</CardTitle>
          <CardDescription className="truncate">Suggested amount brings free stock back to twice its low-stock alert.</CardDescription>
          {inventory.restock.length > 0 && (
            <CardAction>
              <Button variant="outline" size="sm" onClick={() => copyRestock(inventory.restock, data.today)}>
                <Copy aria-hidden /> Copy list
              </Button>
            </CardAction>
          )}
        </CardHeader>
        <CardContent className="min-w-0 px-0">
          {inventory.restock.length === 0 ? (
            <p className="px-4 text-sm text-muted-foreground">All materials are above their low-stock alert.</p>
          ) : (
            <Table className="table-fixed">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="pl-4">Material</TableHead>
                  <TableHead className="hidden w-40 md:table-cell">Supplier</TableHead>
                  <TableHead className="w-24 text-right sm:w-28">Free</TableHead>
                  <TableHead className="hidden w-24 text-right sm:table-cell">Alert at</TableHead>
                  <TableHead className="w-28 pr-4 text-right sm:w-36">Suggested to buy</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {inventory.restock.map((r) => {
                  const look = lookFor(STOCK_STATUS, r.stock_status);
                  return (
                    <TableRow key={r.inventory_id}>
                      <TableCell className="pl-4">
                        <Cell className="font-medium" value={r.item_name} />
                        <Badge variant="outline" className={cn('mt-1', TONE_CLASSES[look.tone].badge)}>
                          {STOCK_STATUS[r.stock_status]?.label ?? r.stock_status}
                        </Badge>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <Cell className="text-muted-foreground" value={r.supplier || '—'} />
                      </TableCell>
                      <TableCell className="text-right">
                        <Cell className="tabular-nums" value={`${r.free.toLocaleString()} ${r.unit}`} />
                      </TableCell>
                      <TableCell className="hidden text-right sm:table-cell">
                        <Cell className="tabular-nums" value={r.minimum_threshold.toLocaleString()} />
                      </TableCell>
                      <TableCell className="pr-4 text-right">
                        <Cell className="font-semibold tabular-nums" value={`${r.suggested_order.toLocaleString()} ${r.unit}`} />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <div className="grid min-w-0 grid-cols-1 gap-6 xl:grid-cols-2">
        {canSeeMoney && (
          <Card className="min-w-0">
            <CardHeader className="min-w-0">
              <CardTitle className="truncate">Payments received per month</CardTitle>
              <CardDescription className="truncate">Last six months, shop time.</CardDescription>
            </CardHeader>
            <CardContent className="flex min-w-0 flex-col gap-3">
              {income.map((m) => (
                <div key={m.month} className="grid min-w-0 grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-1 sm:grid-cols-[5.5rem_minmax(0,1fr)_9rem]">
                  <span className="text-sm text-muted-foreground">{monthLabel(m.month)}</span>
                  {/* The browser draws each bar from two server figures; nothing is computed here */}
                  <progress
                    value={m.amount}
                    max={busiestMonth || 1}
                    aria-label={`${monthLabel(m.month)}: ${peso(m.amount)}`}
                    className="h-2.5 w-full overflow-hidden rounded-full [&::-moz-progress-bar]:bg-primary [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-primary"
                  />
                  <Cell className="col-start-2 text-sm font-medium tabular-nums sm:col-start-auto sm:text-right" value={peso(m.amount)} />
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        <Card className="min-w-0">
          <CardHeader className="min-w-0">
            <CardTitle className="truncate">Most used materials</CardTitle>
            <CardDescription className="truncate">By orders that were not cancelled.</CardDescription>
          </CardHeader>
          <CardContent className="flex min-w-0 flex-col gap-4 px-0">
            {top.length === 0 ? (
              <p className="px-4 text-sm text-muted-foreground">No orders with materials yet.</p>
            ) : (
              <Table className="table-fixed">
                <TableBody>
                  {top.map((m) => (
                    <TableRow key={m.inventory_id}>
                      <TableCell className="pl-4">
                        <Cell className="font-medium" value={m.item_name} />
                      </TableCell>
                      <TableCell className="w-32 text-right">
                        <Cell className="tabular-nums" value={`${m.quantity.toLocaleString()} ${m.unit}`} />
                      </TableCell>
                      <TableCell className="hidden w-28 pr-4 text-right text-muted-foreground sm:table-cell">
                        <Cell value={`${m.orders.toLocaleString()} order(s)`} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            <div className="flex min-w-0 flex-col gap-2 px-4">
              <h3 className="text-sm font-semibold">Orders by status</h3>
              <div className="flex min-w-0 flex-wrap gap-2">
                {Object.entries(orders.by_status).map(([status, n]) => (
                  <span key={status} className="inline-flex items-center gap-1.5 text-sm">
                    <OrderStatusBadge status={status} />
                    <strong className="tabular-nums">{n.toLocaleString()}</strong>
                  </span>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {canSeeMoney && orders.unpaid.length > 0 && (
        <OrdersTableCard
          title={`Unpaid balances (${orders.unpaid_count.toLocaleString()})`}
          description={
            orders.unpaid_count > orders.unpaid.length
              ? `The ${orders.unpaid.length} largest balances, highest first.`
              : 'Highest balance first.'
          }
          empty=""
          orders={orders.unpaid}
          money="balance"
          tone="info"
        />
      )}

      <ResultDialog result={result} onClose={() => setResult(null)} />
    </div>
  );
}
