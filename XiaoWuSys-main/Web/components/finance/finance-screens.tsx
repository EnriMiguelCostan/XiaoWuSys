'use client';

// The Finance and Waste pages (adviser consultation: each in its own place instead of one long
// dashboard). Every peso and count is the server's (routes/reports.js); these screens only pick
// the month or period and show what comes back.
//   PaymentsReportScreen    GET /api/reports/payments?month=   money received per month (click a month)
//   TransactionsScreen      GET /api/reports/transactions?month=   money in and out, one month
//   ExpensesScreen          the overheads card (GET / POST / DELETE /api/reports/overheads)
//   ProfitLossScreen        the Owner's P&L card (GET /api/reports/pnl)
//   WasteScreen             GET /api/reports/waste?from=&to=  + record several losses at once
//                           (migration 016: month by month, like Monthly transactions, plus this week
//                           and any dates)
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ChevronLeft, ChevronRight, FileSpreadsheet, Plus, Receipt, Recycle, Scale, Trash2, Wallet } from 'lucide-react';
import { formatDateTime, peso } from '@xiaowu/client-core/format';
import { can } from '@xiaowu/client-core/permissions';
import { OverheadsCard, PnlCard } from '@/components/dashboard/finance-sections';
import { DateInput } from '@/components/forms/date-input';
import { ResultDialog, type ResultMessage } from '@/components/feedback/result-dialog';
import { bannerText, Field, fieldErrorsMap, FormProblem } from '@/components/forms/form-bits';
import { BoundedSelectContent, BoundedSelectItem, BoundedSelectTrigger } from '@/components/forms/bounded-select';
import { LoadProblem, PageHeader } from '@/components/layout/page-header';
import { LossCauseBadge } from '@/components/orders/waste-section';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useApi } from '@/hooks/use-api';
import { useInventorySnapshot } from '@/hooks/use-inventory-snapshot';
import { useSession } from '@/hooks/use-session';
import { errorMessage } from '@/lib/api';
import { toNumberInput } from '@/lib/inventory';
import { LOSS_REASONS, type Payment } from '@/lib/orders';
import { monthLabel } from '@/lib/reports';
import { TONE_CLASSES } from '@/lib/ui-tokens';
import { cn } from '@/lib/utils';
import { useSubPath } from '@/lib/sub-route';

// ---------------------------------------------------------------------------------------------
// Payments received per month
// ---------------------------------------------------------------------------------------------
interface PaymentsReport {
  source: string;
  month: string;
  until?: string;
  current_month?: string;
  months: { month: string; received: number; refunded: number; voided: number; net: number; count: number }[];
  detail: {
    month: string;
    payments: (Payment & { kind: string; order_id: string; order_label: string; customer_name: string; received_by_name?: string; needs_verification: boolean })[];
    by_method: { payment_type: string; count: number; amount: number }[];
    received: number;
    refunded: number;
    voided: number;
    net: number;
    unverified: number;
    billed: number;
    collected_on_those: number;
    progress_percent: number | null;
    orders_created: number;
    received_breakdown?: { for_this_months_orders: number; for_cancelled_orders: number; for_earlier_orders: number };
  };
}

const KIND_TONE: Record<string, keyof typeof TONE_CLASSES> = { Payment: 'success', Refund: 'warning', Void: 'danger' };


// The Payments page: the months of one year as cards (or the years, as cards), the totals for the
// whole set or for the card picked, and two bar charts under the cards (money in, orders made).
// Every figure, bar height included, comes from GET /reports/payments/overview; the page draws.
interface OverviewRow {
  received: number;
  refunded: number;
  voided: number;
  net: number;
  payments: number;
  orders: number;
  billed: number;
  net_bar?: number;
  orders_bar?: number;
}
interface PaymentsOverview {
  source: string;
  current_month: string;
  current_year: string;
  year: string;
  months: (OverviewRow & { month: string })[];
  year_totals: OverviewRow & { year: string };
  years: (OverviewRow & { year: string })[];
  all_totals: OverviewRow;
}
type PeriodCard = OverviewRow & { key: string; name: string; future: boolean; current: boolean };

const monthName = (ym: string) => new Date(`${ym}-01T00:00:00`).toLocaleDateString('en-PH', { month: 'long' });
const compactPeso = (n: number) => new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP', notation: 'compact', maximumFractionDigits: 1 }).format(n);

export function PaymentsReportScreen() {
  const api = useApi();
  const [view, setView] = useState<'months' | 'years'>('months');
  const [year, setYear] = useState(''); // '' = the server's current year
  const [picked, setPicked] = useState<string | null>(null);
  const [report, setReport] = useState<PaymentsOverview | null>(null);
  const [problem, setProblem] = useState('');
  // A month's payments are their own page at /finance/payments/<YYYY-MM> (lib/sub-route.ts)
  const [sub, go] = useSubPath('/finance/payments');
  const openMonth = sub?.[0] ?? null;

  useEffect(() => {
    let cancelled = false;
    api<PaymentsOverview>('GET', `/reports/payments/overview${year ? `?year=${year}` : ''}`).then(({ ok, data }) => {
      if (cancelled) return;
      if (ok) {
        setReport(data);
        setProblem('');
      } else setProblem(errorMessage(data, 'The payments could not be loaded.'));
    });
    return () => {
      cancelled = true;
    };
  }, [api, year]);

  const shownYear = report?.year ?? '';
  const currentYear = report?.current_year ?? '';
  const cards: PeriodCard[] = !report
    ? []
    : view === 'months'
      ? report.months.map((m) => ({ ...m, key: m.month, name: monthName(m.month), future: m.month > report.current_month, current: m.month === report.current_month }))
      : report.years.map((y) => ({ ...y, key: y.year, name: y.year, future: false, current: y.year === report.current_year }));
  const pickedCard = cards.find((c) => c.key === picked) ?? null;
  const totals: OverviewRow | null = pickedCard ?? (report ? (view === 'months' ? report.year_totals : report.all_totals) : null);
  const allYears = report && view === 'years' ? report.years : [];
  const totalsLabel = pickedCard
    ? view === 'months'
      ? monthLabel(pickedCard.key)
      : pickedCard.key
    : view === 'months'
      ? `All of ${shownYear}`
      : allYears.length
        ? `${allYears[0].year} – ${allYears[allYears.length - 1].year}`
        : '';

  const changeView = (next: string) => {
    if (next !== 'months' && next !== 'years') return;
    setView(next);
    setPicked(null);
  };
  const changeYear = (next: string) => {
    setYear(next === currentYear ? '' : next);
    setPicked(null);
  };
  const pick = (key: string) => setPicked((p) => (p === key ? null : key));

  return (
    <div className="space-y-5">
      <PageHeader
        icon={Wallet}
        title="Payments"
        description="Money received, refunded and voided. Pick a month (or a year) to see its totals; open a month to see every payment in it."
      />
      <LoadProblem message={problem} />
      {!report ? (
        <Skeleton className="h-96 w-full" />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <ToggleGroup type="single" variant="outline" value={view} onValueChange={changeView} aria-label="Show by">
              <ToggleGroupItem value="months" className="px-3">
                Months
              </ToggleGroupItem>
              <ToggleGroupItem value="years" className="px-3">
                Years
              </ToggleGroupItem>
            </ToggleGroup>
            {view === 'months' && (
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => changeYear(String(Number(shownYear) - 1))} disabled={shownYear <= '2018'}>
                  <ChevronLeft aria-hidden /> {String(Number(shownYear) - 1)}
                </Button>
                <span className="min-w-16 text-center text-lg font-semibold tabular-nums">{shownYear}</span>
                <Button size="sm" variant="outline" onClick={() => changeYear(String(Number(shownYear) + 1))} disabled={shownYear >= currentYear}>
                  {String(Number(shownYear) + 1)} <ChevronRight aria-hidden />
                </Button>
                {shownYear !== currentYear && (
                  <Button size="sm" variant="ghost" onClick={() => changeYear(currentYear)}>
                    This year
                  </Button>
                )}
              </div>
            )}
          </div>

          {/* The totals: of the card picked, otherwise of the whole year (or of every year) */}
          {totals && (
            <section aria-live="polite" className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-semibold">{totalsLabel}</h2>
                {pickedCard && (
                  <div className="flex flex-wrap gap-2">
                    {view === 'months' ? (
                      <Button size="sm" onClick={() => go([pickedCard.key])}>
                        See every payment in {pickedCard.name} <ChevronRight aria-hidden />
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        onClick={() => {
                          setView('months');
                          changeYear(pickedCard.key);
                        }}
                      >
                        Show {pickedCard.key} by month <ChevronRight aria-hidden />
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => setPicked(null)}>
                      {view === 'months' ? `Back to all of ${shownYear}` : 'Back to every year'}
                    </Button>
                  </div>
                )}
              </div>
              <dl className="grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
                <Tile label="Received" value={peso(totals.received)} />
                <Tile label="Refunded" value={peso(totals.refunded)} />
                <Tile label="Voided" value={peso(totals.voided)} />
                <Tile label="Net" value={peso(totals.net)} strong />
              </dl>
              <p className="text-xs text-muted-foreground">
                {totals.payments} payment(s) received · {totals.orders} order(s) made, billed {peso(totals.billed)}. Received counts money paid in
                this period for any order, including orders made earlier; billed counts only the orders made in it, so the two differ.
              </p>
            </section>
          )}

          <section aria-label={view === 'months' ? `The months of ${shownYear}` : 'The years'}>
            <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
              {cards.map((c) => (
                <li key={c.key}>
                  <button
                    type="button"
                    onClick={() => pick(c.key)}
                    disabled={c.future}
                    aria-pressed={picked === c.key}
                    className={cn(
                      'flex h-full min-h-20 w-full flex-col justify-between gap-1 rounded-lg border bg-card p-3 text-left transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-card',
                      picked === c.key && 'border-primary bg-primary/5 ring-1 ring-primary'
                    )}
                  >
                    <span className="text-base font-semibold">{c.name}</span>
                    {c.current && <span className="text-xs text-muted-foreground">{view === 'months' ? 'This month' : 'This year'}</span>}
                    {c.future && <span className="text-xs text-muted-foreground">Not yet</span>}
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <div className="grid min-w-0 gap-4 lg:grid-cols-2">
            <BarChart
              title="Money received (net)"
              description="After refunds and voids"
              cards={cards}
              picked={picked}
              onPick={pick}
              bar={(c) => c.net_bar ?? 0}
              value={(c) => peso(c.net)}
              short={(c) => compactPeso(c.net)}
              shortLabel={view === 'months'}
            />
            <BarChart
              title="Orders made"
              description="Orders created, not counting cancelled ones"
              cards={cards}
              picked={picked}
              onPick={pick}
              bar={(c) => c.orders_bar ?? 0}
              value={(c) => `${c.orders} order(s)`}
              short={(c) => String(c.orders)}
              shortLabel={view === 'months'}
            />
          </div>
        </>
      )}
      <PaymentsMonthDialog month={openMonth} onClose={() => go(null)} />
    </div>
  );
}

// A vertical bar per card. The heights are the server's (0-100); a bar can be clicked to pick it.
function BarChart({
  title,
  description,
  cards,
  picked,
  onPick,
  bar,
  value,
  short,
  shortLabel,
}: {
  title: string;
  description: string;
  cards: PeriodCard[];
  picked: string | null;
  onPick: (key: string) => void;
  bar: (c: PeriodCard) => number;
  value: (c: PeriodCard) => string;
  short: (c: PeriodCard) => string;
  /** Months: the bar is labelled with the month's first three letters */
  shortLabel: boolean;
}) {
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="flex h-56 items-stretch gap-1 border-b" aria-label={title}>
          {cards.map((c) => (
            <li key={c.key} className="flex min-w-0 flex-1 flex-col">
              <button
                type="button"
                onClick={() => onPick(c.key)}
                disabled={c.future}
                aria-label={`${c.name}: ${value(c)}`}
                title={`${c.name}: ${value(c)}`}
                className="group flex h-full w-full flex-col items-center justify-end gap-1 rounded-t-sm focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-default"
              >
                {!c.future && <span className="max-w-full truncate text-[10px] text-muted-foreground tabular-nums">{short(c)}</span>}
                <span
                  aria-hidden
                  className={cn(
                    'w-full max-w-10 rounded-t-sm bg-primary transition-[height,opacity] group-hover:opacity-80',
                    picked !== null && picked !== c.key && 'opacity-35'
                  )}
                  style={{ height: `${bar(c)}%` }}
                />
              </button>
            </li>
          ))}
        </ul>
        <ul aria-hidden className="mt-1 flex gap-1">
          {cards.map((c) => (
            <li key={c.key} className={cn('min-w-0 flex-1 truncate text-center text-[11px] text-muted-foreground', picked === c.key && 'font-semibold text-foreground')}>
              {shortLabel ? c.name.slice(0, 3) : c.name}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

// One month in a pop-up: totals, collection progress, methods and every payment / refund / void
function PaymentsMonthDialog({ month, onClose }: { month: string | null; onClose: () => void }) {
  const api = useApi();
  const [answer, setAnswer] = useState<{ month: string; detail: PaymentsReport['detail'] | null; problem: string } | null>(null);

  useEffect(() => {
    if (!month) return;
    let cancelled = false;
    api<PaymentsReport>('GET', `/reports/payments?month=${month}`).then(({ ok, data }) => {
      if (cancelled) return;
      setAnswer(ok ? { month, detail: data.detail, problem: '' } : { month, detail: null, problem: errorMessage(data, 'This month could not be loaded.') });
    });
    return () => {
      cancelled = true;
    };
  }, [api, month]);

  const shown = answer && answer.month === month ? answer : null;
  const d = shown?.detail;
  return (
    <Dialog page open={Boolean(month)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>Payments · {month ? monthLabel(month) : ''}</DialogTitle>
          <DialogDescription>Every payment, refund and void dated in this month.</DialogDescription>
        </DialogHeader>
        {!shown ? (
          <Skeleton className="h-48 w-full" />
        ) : !d ? (
          <LoadProblem message={shown.problem} />
        ) : (
          <div className="min-w-0 space-y-4">
            <dl className="grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
              <Tile label="Received" value={peso(d.received)} />
              <Tile label="Refunded" value={peso(d.refunded)} />
              <Tile label="Voided" value={peso(d.voided)} />
              <Tile label="Net" value={peso(d.net)} strong />
            </dl>
            <div className="rounded-md border p-3">
              <p className="text-sm font-medium">Collection progress</p>
              <p className="text-xs text-muted-foreground">
                Orders created in {monthLabel(d.month)} ({d.orders_created}): billed {peso(d.billed)}, paid so far {peso(d.collected_on_those)}.
              </p>
              {d.received_breakdown && (
                <p className="mt-1 text-xs text-muted-foreground">
                  The {peso(d.received)} received was for: orders made this month {peso(d.received_breakdown.for_this_months_orders)}, orders made
                  this month and later cancelled {peso(d.received_breakdown.for_cancelled_orders)}, and orders made in earlier months{' '}
                  {peso(d.received_breakdown.for_earlier_orders)}.
                </p>
              )}
              {d.progress_percent === null ? (
                <p className="mt-2 text-sm text-muted-foreground">No orders with a price were created this month.</p>
              ) : (
                <div className="mt-2 space-y-1">
                  <progress value={d.progress_percent} max={100} aria-label="Collected" className="h-2.5 w-full overflow-hidden rounded-full [&::-moz-progress-bar]:bg-success [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:bg-success" />
                  <p className="text-sm tabular-nums">{d.progress_percent}% collected</p>
                </div>
              )}
              {d.unverified > 0 && (
                <p className={cn('mt-3 rounded-md border p-2 text-sm', TONE_CLASSES.warning.banner)}>
                  {d.unverified} non-cash payment(s) this month are not verified yet. Open the order to check and verify them.
                </p>
              )}
            </div>
            {d.by_method.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {d.by_method.map((m) => (
                  <Badge key={m.payment_type} variant="outline" className="gap-1.5 py-1 text-sm">
                    {m.payment_type}: <strong className="tabular-nums">{peso(m.amount)}</strong>
                    <span className="text-muted-foreground">({m.count})</span>
                  </Badge>
                ))}
              </div>
            )}
            {d.payments.length === 0 ? (
              <p className="rounded-md border bg-card p-6 text-center text-sm text-muted-foreground">No payments in this month.</p>
            ) : (
              <div className="max-w-full min-w-0 overflow-x-auto rounded-md border bg-card">
                <Table>
                  <TableHeader className="bg-muted/50">
                    <TableRow>
                      <TableHead>Date paid</TableHead>
                      <TableHead>Order</TableHead>
                      <TableHead className="hidden md:table-cell">Client</TableHead>
                      <TableHead className="hidden xl:table-cell" title="The name written on the payment: who paid (for a refund, who received it back)">
                        Paid by
                      </TableHead>
                      <TableHead>Method</TableHead>
                      <TableHead className="hidden lg:table-cell">Reference</TableHead>
                      <TableHead className="hidden sm:table-cell">Receipt</TableHead>
                      <TableHead className="hidden lg:table-cell" title="The shop account that was signed in when the payment was recorded">
                        Received by
                      </TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {d.payments.map((p) => (
                      <TableRow key={p.payment_id}>
                        <TableCell className="whitespace-nowrap">{formatDateTime(p.payment_date, { utc: true })}</TableCell>
                        <TableCell>
                          <Link className="font-mono text-sm text-primary underline-offset-4 hover:underline" href={`/orders/${encodeURIComponent(p.order_id)}`}>
                            {p.order_label}
                          </Link>
                        </TableCell>
                        <TableCell className="hidden max-w-40 whitespace-normal wrap-anywhere md:table-cell">{p.customer_name}</TableCell>
                        <TableCell className="hidden max-w-40 whitespace-normal wrap-anywhere xl:table-cell">{p.payer_name || '—'}</TableCell>
                        <TableCell className="whitespace-normal">
                          {p.payment_type}
                          {p.kind !== 'Payment' && (
                            <Badge variant="outline" className={cn('ml-1', TONE_CLASSES[KIND_TONE[p.kind] ?? 'muted'].badge)}>
                              {p.kind}
                            </Badge>
                          )}
                          {p.needs_verification && (
                            <Badge variant="outline" className={cn('ml-1', TONE_CLASSES.warning.badge)}>
                              Not verified
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="hidden max-w-40 whitespace-normal wrap-anywhere lg:table-cell">
                          {[p.bank_name, p.reference_no, p.cheque_no && `Cheque ${p.cheque_no}`].filter(Boolean).join(' · ') || '—'}
                        </TableCell>
                        <TableCell className="hidden font-mono text-xs sm:table-cell">{p.receipt_no ?? '—'}</TableCell>
                        <TableCell className="hidden lg:table-cell">{p.received_by_name ?? '—'}</TableCell>
                        <TableCell className="text-right tabular-nums">{peso(p.amount)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        )}
        <DialogFooter>
          <Button onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Tile({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="rounded-md border bg-card p-3">
      <dt className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{label}</dt>
      <dd className={cn('text-lg tabular-nums', strong && 'font-semibold')}>{value}</dd>
    </div>
  );
}

// A month picker: the current month and the eleven before it
const recentMonths = () => {
  const now = new Date();
  return Array.from({ length: 12 }, (_, i) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    return d.toISOString().slice(0, 7);
  });
};

// ---------------------------------------------------------------------------------------------
// Monthly transactions: money in and out
// ---------------------------------------------------------------------------------------------
interface Transactions {
  source: string;
  month: string;
  purchases_available: boolean;
  entries: { date: string; kind: string; label: string; reference: string | null; method: string | null; amount: number; direction: 'in' | 'out' }[];
  totals: { money_in: number; refunds: number; expenses: number; purchases: number; net: number };
}

export function TransactionsScreen() {
  const api = useApi();
  const months = useMemo(() => recentMonths(), []);
  const [month, setMonth] = useState(months[0]);
  const [data, setData] = useState<Transactions | null>(null);
  const [problem, setProblem] = useState('');
  useEffect(() => {
    let cancelled = false;
    api<Transactions>('GET', `/reports/transactions?month=${month}`).then(({ ok, data: body }) => {
      if (cancelled) return;
      if (ok) {
        setData(body);
        setProblem('');
      } else setProblem(errorMessage(body, 'The transactions could not be loaded.'));
    });
    return () => {
      cancelled = true;
    };
  }, [api, month]);

  return (
    <div className="space-y-5">
      <PageHeader
        icon={FileSpreadsheet}
        title="Monthly transactions"
        description="Every peso in and out in one month: payments, refunds, expenses and supplier purchases (stock in)."
        actions={
          <Select value={month} onValueChange={setMonth}>
            <SelectTrigger className="w-40" aria-label="Month">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {months.map((m) => (
                <SelectItem key={m} value={m}>
                  {monthLabel(m)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      <LoadProblem message={problem} />
      {!data ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-2 text-sm md:grid-cols-5">
            <Tile label="Money in" value={peso(data.totals.money_in)} />
            <Tile label="Refunds / voids" value={peso(data.totals.refunds)} />
            <Tile label="Expenses" value={peso(data.totals.expenses)} />
            <Tile label="Purchases" value={peso(data.totals.purchases)} />
            <Tile label="Net cash" value={peso(data.totals.net)} strong />
          </dl>
          {!data.purchases_available && (
            <p className={cn('rounded-md border p-3 text-sm', TONE_CLASSES.info.banner)}>Offline: supplier purchases need the internet, so they are left out.</p>
          )}
          {data.entries.length === 0 ? (
            <p className="rounded-md border bg-card p-6 text-center text-sm text-muted-foreground">Nothing in this month.</p>
          ) : (
            <div className="max-w-full min-w-0 overflow-x-auto rounded-md border bg-card">
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>What</TableHead>
                    <TableHead className="hidden md:table-cell">Reference</TableHead>
                    <TableHead className="text-right">In</TableHead>
                    <TableHead className="text-right">Out</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.entries.map((e, i) => (
                    <TableRow key={`${e.kind}-${e.reference}-${i}`}>
                      <TableCell className="whitespace-nowrap">{formatDateTime(e.date, { withTime: e.kind !== 'Expense' })}</TableCell>
                      <TableCell className="max-w-80 whitespace-normal wrap-anywhere">
                        <Badge variant="outline" className="mr-1">{e.kind}</Badge>
                        {e.label}
                        {e.method && <span className="text-xs text-muted-foreground"> · {e.method}</span>}
                      </TableCell>
                      <TableCell className="hidden font-mono text-xs md:table-cell">{e.reference ?? '—'}</TableCell>
                      <TableCell className={cn('text-right tabular-nums', TONE_CLASSES.success.text)}>{e.direction === 'in' ? peso(e.amount) : ''}</TableCell>
                      <TableCell className={cn('text-right tabular-nums', TONE_CLASSES.danger.text)}>{e.direction === 'out' ? peso(e.amount) : ''}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Expenses and P&L (the existing cards, each on its own page)
// ---------------------------------------------------------------------------------------------
export function ExpensesScreen() {
  const [result, setResult] = useState<ResultMessage | null>(null);
  return (
    <div className="space-y-5">
      <PageHeader icon={Receipt} title="Expenses" description="Rent, electricity, wages and other running costs. They count in the profit and loss." />
      <OverheadsCard onResult={setResult} />
      <ResultDialog result={result} onClose={() => setResult(null)} />
    </div>
  );
}

export function ProfitLossScreen() {
  const [result, setResult] = useState<ResultMessage | null>(null);
  return (
    <div className="space-y-5">
      <PageHeader icon={Scale} title="Profit & loss" description="Income less the cost of materials, consumables, waste and expenses, for the period you choose." />
      <PnlCard onResult={setResult} />
      <ResultDialog result={result} onClose={() => setResult(null)} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Waste: this week / this month / a chosen period, and several losses recorded at once
// ---------------------------------------------------------------------------------------------
interface WasteReport {
  source: string;
  period: { from: string; to: string };
  costs_visible: boolean;
  totals: { count: number; quantity: number; cost: number | null };
  by_category: WasteGroup[];
  by_item: WasteGroup[];
  by_order: WasteGroup[];
  by_day: WasteGroup[];
  losses: {
    loss_id: string; date_recorded: string; item_name: string; unit: string | null; quantity_lost: number; reason_label: string | null;
    loss_reason: string; category_label: string; order_label: string | null; order_id: string | null; financial_cost: number | null;
  }[];
}
interface WasteGroup {
  key: string;
  label: string;
  count: number;
  quantity: number;
  cost: number | null;
}

// The period presets, on the shop's calendar (display only: the server filters by shop day)
const shopToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
const presetPeriod = (preset: string) => {
  const today = shopToday();
  const d = new Date(`${today}T00:00:00Z`);
  if (preset === 'week') {
    const day = (d.getUTCDay() + 6) % 7; // Monday = 0
    d.setUTCDate(d.getUTCDate() - day);
    return { from: d.toISOString().slice(0, 10), to: today };
  }
  return { from: `${today.slice(0, 7)}-01`, to: today };
};

// Migration 016: one whole month ('YYYY-MM'): its first day to its last (today for this month)
const monthPeriod = (ym: string) => {
  const today = shopToday();
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return { from: `${ym}-01`, to: last > today ? today : last };
};

export function WasteScreen() {
  const api = useApi();
  const { user } = useSession();
  const months = useMemo(() => recentMonths(), []);
  const [preset, setPreset] = useState('monthly');
  const [month, setMonth] = useState(months[0]);
  const [period, setPeriod] = useState(() => monthPeriod(months[0]));
  const pickMonth = (ym: string) => {
    setMonth(ym);
    setPeriod(monthPeriod(ym));
  };
  const monthIndex = months.indexOf(month);
  const [report, setReport] = useState<WasteReport | null>(null);
  const [problem, setProblem] = useState('');
  const [tick, setTick] = useState(0);
  // Recording waste is its own page at /finance/waste/new (lib/sub-route.ts)
  const [sub, go] = useSubPath('/finance/waste');
  const recording = sub?.[0] === 'new';
  const setRecording = (open: boolean) => go(open ? ['new'] : null);
  const [result, setResult] = useState<ResultMessage | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<WasteReport>('GET', `/reports/waste?from=${period.from}&to=${period.to}`).then(({ ok, data }) => {
      if (cancelled) return;
      if (ok) {
        setReport(data);
        setProblem('');
      } else setProblem(errorMessage(data, 'The waste report could not be loaded.'));
    });
    return () => {
      cancelled = true;
    };
  }, [api, period, tick]);

  return (
    <div className="space-y-5">
      <PageHeader
        icon={Recycle}
        title="Monthly waste"
        description="Misprints, damaged and lost materials, month by month: what, how much, why, which order, and what it cost."
        actions={
          can(user, 'edit_inventory') && (
            <Button onClick={() => setRecording(true)}>
              <Plus aria-hidden /> Record waste
            </Button>
          )
        }
      />
      <div className="flex flex-wrap items-end gap-3">
        <ToggleGroup
          type="single"
          variant="outline"
          value={preset}
          onValueChange={(v) => {
            if (!v) return;
            setPreset(v);
            if (v === 'monthly') setPeriod(monthPeriod(month));
            else if (v !== 'custom') setPeriod(presetPeriod(v));
          }}
          aria-label="Period"
        >
          <ToggleGroupItem value="monthly">By month</ToggleGroupItem>
          <ToggleGroupItem value="week">This week</ToggleGroupItem>
          <ToggleGroupItem value="custom">Choose dates</ToggleGroupItem>
        </ToggleGroup>
        {preset === 'monthly' && (
          <div className="flex items-center gap-1">
            <Button variant="outline" size="icon" aria-label="Previous month" disabled={monthIndex >= months.length - 1} onClick={() => pickMonth(months[monthIndex + 1])}>
              <ChevronLeft aria-hidden />
            </Button>
            <Select value={month} onValueChange={pickMonth}>
              <SelectTrigger className="w-40" aria-label="Month">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {months.map((m) => (
                  <SelectItem key={m} value={m}>
                    {monthLabel(m)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" size="icon" aria-label="Next month" disabled={monthIndex <= 0} onClick={() => pickMonth(months[monthIndex - 1])}>
              <ChevronRight aria-hidden />
            </Button>
          </div>
        )}
        {preset === 'custom' && (
          <>
            <Field id="waste-from" label="From" className="w-40">
              <DateInput id="waste-from" value={period.from} max={period.to} onChange={(e) => e.target.value && setPeriod((p) => ({ ...p, from: e.target.value }))} />
            </Field>
            <Field id="waste-to" label="To" className="w-40">
              <DateInput id="waste-to" value={period.to} min={period.from} onChange={(e) => e.target.value && setPeriod((p) => ({ ...p, to: e.target.value }))} />
            </Field>
          </>
        )}
      </div>
      <LoadProblem message={problem} />
      {!report ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <>
          <dl className="grid grid-cols-3 gap-2 text-sm">
            <Tile label="Losses recorded" value={String(report.totals.count)} />
            <Tile label="Pieces / units lost" value={report.totals.quantity.toLocaleString()} />
            <Tile label="Cost of the waste" value={report.totals.cost === null ? 'Owner / Admin only' : peso(report.totals.cost)} strong />
          </dl>
          <div className="grid gap-4 lg:grid-cols-3">
            <GroupCard title="By cause" rows={report.by_category} costs={report.costs_visible} />
            <GroupCard title="By material" rows={report.by_item} costs={report.costs_visible} />
            <GroupCard title="By order" rows={report.by_order} costs={report.costs_visible} />
          </div>
          {report.losses.length > 0 && (
            <div className="max-w-full min-w-0 overflow-x-auto rounded-md border bg-card">
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Material</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead>Why</TableHead>
                    <TableHead className="hidden md:table-cell">Order</TableHead>
                    {report.costs_visible && <TableHead className="text-right">Cost</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.losses.map((l) => (
                    <TableRow key={l.loss_id}>
                      <TableCell className="whitespace-nowrap">{formatDateTime(l.date_recorded, { utc: true })}</TableCell>
                      <TableCell className="max-w-48 whitespace-normal wrap-anywhere">{l.item_name}</TableCell>
                      <TableCell className="text-right tabular-nums">{l.quantity_lost.toLocaleString()}</TableCell>
                      <TableCell className="whitespace-normal">
                        {l.reason_label || l.loss_reason} <LossCauseBadge label={l.category_label} />
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        {l.order_id ? (
                          <Link className="font-mono text-xs text-primary hover:underline" href={`/orders/${encodeURIComponent(l.order_id)}`}>
                            {l.order_label}
                          </Link>
                        ) : '—'}
                      </TableCell>
                      {report.costs_visible && <TableCell className="text-right tabular-nums">{peso(l.financial_cost ?? 0)}</TableCell>}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </>
      )}
      {recording && (
        <BulkWasteDialog
          onClose={() => setRecording(false)}
          onDone={(r) => {
            setRecording(false);
            setResult(r);
            setTick((t) => t + 1);
          }}
        />
      )}
      <ResultDialog result={result} onClose={() => setResult(null)} />
    </div>
  );
}

function GroupCard({ title, rows, costs }: { title: string; rows: WasteGroup[]; costs: boolean }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing in this period.</p>
        ) : (
          <ul className="divide-y text-sm">
            {rows.slice(0, 8).map((r) => (
              <li key={r.key} className="flex items-center justify-between gap-2 py-1.5">
                <span className="min-w-0 wrap-anywhere">{r.label}</span>
                <span className="shrink-0 text-right tabular-nums">
                  {r.quantity.toLocaleString()}
                  {costs && r.cost !== null && <span className="block text-xs text-muted-foreground">{peso(r.cost)}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

interface WasteLine {
  key: number;
  inventory_id: string;
  quantity: string;
}
let wasteKey = 0;

function BulkWasteDialog({ onClose, onDone }: { onClose: () => void; onDone: (r: ResultMessage) => void }) {
  const api = useApi();
  const { snapshot } = useInventorySnapshot();
  const items = snapshot?.items ?? [];
  const [lines, setLines] = useState<WasteLine[]>(() => [{ key: ++wasteKey, inventory_id: '', quantity: '' }]);
  const [reasonCode, setReasonCode] = useState(LOSS_REASONS[0].code);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const setLine = (key: number, patch: Partial<WasteLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setProblem('');
    setErrors({});
    if (lines.some((l) => !l.inventory_id)) {
      setProblem('Choose a material on every line, or remove the empty line.');
      return;
    }
    setBusy(true);
    const { ok, data } = await api<{ message?: string; total_cost?: number }>('POST', '/inventory/losses', {
      reason_code: reasonCode,
      loss_reason: note.trim() || undefined,
      lines: lines.map((l) => ({ inventory_id: l.inventory_id, quantity_lost: toNumberInput(l.quantity) })),
    });
    setBusy(false);
    if (!ok) {
      setErrors(fieldErrorsMap(data));
      setProblem(bannerText(data, [], 'Nothing was recorded.'));
      return;
    }
    onDone({ type: 'success', title: 'Waste recorded', message: data.message ?? 'Recorded.' });
  };

  return (
    <Dialog page open onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Record waste</DialogTitle>
          <DialogDescription>Several materials wasted at once (for example a misprinted batch). Each is taken from stock and costed. For one order, use Record loss in the order instead.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <FormProblem message={problem} />
          <Field id="waste-reason" label="What happened *">
            <Select value={reasonCode} onValueChange={setReasonCode}>
              <SelectTrigger id="waste-reason" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LOSS_REASONS.map((r) => (
                  <SelectItem key={r.code} value={r.code}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <div className="space-y-2">
            {lines.map((line, i) => (
              <div key={line.key} className="flex flex-wrap items-end gap-2">
                <div className="flex min-w-0 flex-[3_1_14rem] flex-col gap-1">
                  <label htmlFor={`waste-item-${line.key}`} className={cn('text-xs font-medium', i > 0 && 'sr-only')}>Material</label>
                  <Select value={line.inventory_id} onValueChange={(v) => setLine(line.key, { inventory_id: v })}>
                    <BoundedSelectTrigger id={`waste-item-${line.key}`} aria-label={`Material ${i + 1}`}>
                      <SelectValue placeholder="Choose a material…" />
                    </BoundedSelectTrigger>
                    <BoundedSelectContent>
                      {items.map((it) => (
                        <BoundedSelectItem key={it.inventory_id} value={it.inventory_id} label={it.item_name} suffix={`(${it.quantity_available.toLocaleString()} on hand)`}>
                          {it.item_name}
                        </BoundedSelectItem>
                      ))}
                    </BoundedSelectContent>
                  </Select>
                </div>
                <div className="flex w-28 flex-col gap-1">
                  <label htmlFor={`waste-qty-${line.key}`} className={cn('text-xs font-medium', i > 0 && 'sr-only')}>Quantity</label>
                  <Input id={`waste-qty-${line.key}`} type="number" min={1} step={1} required inputMode="numeric" value={line.quantity} onChange={(e) => setLine(line.key, { quantity: e.target.value })} />
                </div>
                <Button type="button" variant="ghost" size="icon" disabled={lines.length === 1} onClick={() => setLines((ls) => ls.filter((l) => l.key !== line.key))} aria-label={`Remove material ${i + 1}`} title={`Remove material ${i + 1}`}>
                  <Trash2 aria-hidden />
                </Button>
                {Object.entries(errors).filter(([k]) => k.startsWith(`lines[${i}].`)).map(([k, m]) => (
                  <p key={k} className={cn('w-full text-xs', TONE_CLASSES.danger.text)}>{m}</p>
                ))}
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" onClick={() => setLines((ls) => [...ls, { key: ++wasteKey, inventory_id: '', quantity: '' }])}>
              <Plus aria-hidden /> Add material
            </Button>
          </div>
          <Field id="waste-note" label="Notes" hint="Optional: what exactly happened">
            <Input id="waste-note" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button type="submit" busy={busy} disabled={busy}>{busy ? 'Saving…' : 'Record waste'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
