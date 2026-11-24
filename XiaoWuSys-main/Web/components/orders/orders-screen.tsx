'use client';

// Orders list (ported from OrdersPage.jsx). Sorting, filtering and paging all run on the
// server (GET /api/orders), so they are correct across pages. The detail opens as a side
// sheet addressed by ?order=<order_id>, so an order can be linked and the Back button closes it.
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, ClipboardList, CloudOff, PlusCircle, RefreshCw, Search, X } from 'lucide-react';
import { formatDateTime, formatMobile, peso } from '@xiaowu/client-core/format';
import { orderNumber } from '@xiaowu/client-core/orders';
import { can } from '@xiaowu/client-core/permissions';
import { LogoSpinner } from '@/components/brand/brand-logo';
import { useConnection } from '@/components/connection/connection-provider';
import { ResultDialog, type ResultMessage } from '@/components/feedback/result-dialog';
import { OrderDetailSheet } from '@/components/orders/order-detail-sheet';
import { DeadlineBadge, DeliveryStatusBadge, OrderStatusBadge, PaymentStatusBadge } from '@/components/orders/status-badges';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Toggle } from '@/components/ui/toggle';
import { BoundedSelectContent, BoundedSelectItem, BoundedSelectTrigger } from '@/components/forms/bounded-select';
import { useCustomers } from '@/hooks/use-customers';
import { useSession } from '@/hooks/use-session';
import { useSocketEvent } from '@/hooks/use-socket-event';
import { api, errorMessage } from '@/lib/api';
import {
  DEFAULT_ORDER_SORT,
  ORDER_SORT_OPTIONS,
  ORDER_STATUSES,
  SORT_FIRST_DIR,
  type OrderList,
  type OrderSort,
  type OrderSortKey,
} from '@/lib/orders';
import { TONE_CLASSES } from '@/lib/ui-tokens';
import { cn } from '@/lib/utils';
import { TEXT_MAX } from '@/lib/input-limits';

const PAGE_SIZE = 20;
const ALL = 'all';

type Loaded = { key: string; list: OrderList | null; error: string };

// Order-number keyword search: what GET /api/orders?number_search= accepts
const NUMBER_SEARCH_CHARS = /^[A-Za-z0-9-]*$/;
const SEARCH_DELAY_MS = 300; // wait for a short pause in typing before asking the server

/**
 * Where the search text sits inside an order number, to highlight it. Mirrors the server:
 * digits only -> inside the running number (after "XM-2026-"); anything else -> anywhere.
 */
function matchRange(number: string, query: string): [number, number] | null {
  const q = query.trim().toUpperCase();
  if (!q) return null;
  const text = number.toUpperCase();
  const from = /^\d+$/.test(q) && /^XM-\d{4}-/.test(text) ? 8 : 0;
  const at = text.indexOf(q, from);
  return at < 0 ? null : [at, at + q.length];
}

function HighlightedNumber({ number, query }: { number: string; query: string }) {
  const range = matchRange(number, query);
  if (!range) return <>{number}</>;
  const [start, end] = range;
  return (
    <>
      {number.slice(0, start)}
      <mark className="rounded-sm bg-warning/30 px-0.5 text-foreground">{number.slice(start, end)}</mark>
      {number.slice(end)}
    </>
  );
}

function SortHead({
  label,
  k,
  sort,
  onSort,
  className,
}: {
  label: string;
  k: OrderSortKey;
  sort: OrderSort;
  onSort: (key: OrderSortKey) => void;
  className?: string;
}) {
  const active = sort.key === k;
  const Arrow = active ? (sort.dir === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown;
  return (
    <TableHead aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'} className={className}>
      <button
        type="button"
        onClick={() => onSort(k)}
        className={cn(
          'inline-flex cursor-pointer items-center gap-1 text-xs font-semibold tracking-wide uppercase hover:text-foreground',
          active ? 'text-foreground' : 'text-muted-foreground'
        )}
      >
        {label}
        <Arrow className={cn('size-3', !active && 'opacity-40')} aria-hidden />
      </button>
    </TableHead>
  );
}

export function OrdersScreen() {
  const { user } = useSession();
  const { syncGeneration } = useConnection();
  const { customers, byId: customerById, reload: reloadCustomers } = useCustomers();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const openId = searchParams.get('order');

  const [status, setStatus] = useState(ALL);
  const [customerId, setCustomerId] = useState(ALL);
  const [numberFilter, setNumberFilter] = useState('');
  const [numberDraft, setNumberDraft] = useState('');
  const [numberError, setNumberError] = useState('');
  const [sort, setSort] = useState<OrderSort>(DEFAULT_ORDER_SORT);
  // PB 23 / D2: archived orders are hidden; "Show archived" lists ONLY the archived ones
  // (include_archived=only), each with an Unarchive button for the Owner / Admin
  const [showArchived, setShowArchived] = useState(false);
  const [unarchiving, setUnarchiving] = useState<string | null>(null);
  const [result, setResult] = useState<ResultMessage | null>(null);
  const [page, setPage] = useState(0);
  const [tick, setTick] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  const qs = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE), sort: sort.key, dir: sort.dir });
  if (status !== ALL) qs.set('status', status);
  if (customerId !== ALL) qs.set('customer_id', customerId);
  if (numberFilter) qs.set('number_search', numberFilter);
  if (showArchived) qs.set('include_archived', 'only');
  const query = qs.toString();
  const requestKey = `${query}|${tick}|${syncGeneration}`;

  useEffect(() => {
    let cancelled = false;
    api<OrderList>('GET', `/orders?${query}`).then(({ ok, data }) => {
      if (cancelled) return;
      setLoaded(
        ok
          ? { key: requestKey, list: { ...data, orders: Array.isArray(data.orders) ? data.orders : [] }, error: '' }
          : { key: requestKey, list: null, error: errorMessage(data, 'Could not load orders.') }
      );
    });
    return () => {
      cancelled = true;
    };
  }, [query, requestKey]);

  const loading = !loaded || loaded.key !== requestKey;
  // Keep showing the last page while the next one loads
  const list = loaded?.list ?? null;
  const orders = list?.orders ?? [];
  const hasNext = orders.length === PAGE_SIZE;
  // While searching, list ONLY the orders whose number matches (the server already filters;
  // this also hides a stale page still on screen while the search result loads)
  const shownOrders = numberFilter
    ? orders.filter((o) => Boolean(o.tracking_no && matchRange(o.tracking_no, numberFilter)))
    : orders;

  const reload = useCallback(() => setTick((t) => t + 1), []);

  // PB 14: an order was created or changed on any branch: re-read this page (no polling).
  // While an order is open, the list sits under the blurred backdrop: reloading it there would
  // make the browser re-blur the page (scroll lag on low-end computers) for a change nobody can
  // see yet. So it is held, and done once when the order closes. The open order itself still
  // updates live (the detail sheet listens on its own).
  const openIdRef = useRef(openId);
  const heldReload = useRef(false);
  useEffect(() => {
    openIdRef.current = openId;
    if (!openId && heldReload.current) {
      heldReload.current = false;
      reload();
    }
  }, [openId, reload]);
  const onOrderUpdated = useCallback(() => {
    if (openIdRef.current) heldReload.current = true;
    else reload();
  }, [reload]);
  useSocketEvent('order_updated', onOrderUpdated);

  // Any filter or sort change starts again at page 1
  const changed = <T,>(setter: (v: T) => void) => (value: T) => {
    setter(value);
    setPage(0);
  };
  const setStatusTo = changed(setStatus);
  const setCustomerTo = changed(setCustomerId);
  const setSortTo = changed(setSort);
  const sortByColumn = (key: OrderSortKey) =>
    setSortTo(sort.key === key ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: SORT_FIRST_DIR[key] });

  // Order number: searches as you type (after a short pause); Enter or the button searches now.
  // "12" finds XM-2026-0012, XM-2026-0120…; the closest match comes first.
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
  }, []);

  const applyNumberSearch = (text: string) => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const value = text.trim();
    if (!NUMBER_SEARCH_CHARS.test(value)) {
      setNumberError('Use numbers, letters and dashes only, like 12 or XM-2026-0012.');
      return;
    }
    setNumberError('');
    if (value.toUpperCase() !== numberFilter) changed(setNumberFilter)(value.toUpperCase());
  };

  const typeNumber = (text: string) => {
    setNumberDraft(text);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    // Box emptied (backspace, or the search box's own clear button): show every order right away
    if (text.trim() === '') {
      applyNumberSearch('');
      return;
    }
    searchTimer.current = setTimeout(() => applyNumberSearch(text), SEARCH_DELAY_MS);
  };

  const resetNumberSearch = useCallback(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    setNumberDraft('');
    setNumberError('');
    setNumberFilter((current) => {
      if (current) setPage(0);
      return '';
    });
  }, []);

  // A click / tap anywhere outside the search box and its results ends the search and shows
  // every order again. Clicking a result (or inside the order it opens, or a dropdown list)
  // does not count as "outside", so a found order can still be opened.
  const searchFormRef = useRef<HTMLFormElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const searching = Boolean(numberDraft || numberFilter);
  useEffect(() => {
    if (!searching) return undefined;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (!target || !(target instanceof Element)) return;
      if (searchFormRef.current?.contains(target) || resultsRef.current?.contains(target)) return;
      if (target.closest('[role="dialog"], [role="alertdialog"], [data-radix-popper-content-wrapper], [data-slot$="-overlay"]')) return;
      resetNumberSearch();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [searching, resetNumberSearch]);

  const findNumber = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    applyNumberSearch(numberDraft);
  };

  const isDefaultSort = sort.key === DEFAULT_ORDER_SORT.key && sort.dir === DEFAULT_ORDER_SORT.dir;
  const filtersActive = status !== ALL || customerId !== ALL || Boolean(numberFilter) || !isDefaultSort;
  const clearFilters = () => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    setStatus(ALL);
    setCustomerId(ALL);
    setNumberFilter('');
    setNumberDraft('');
    setNumberError('');
    setSort(DEFAULT_ORDER_SORT);
    setShowArchived(false);
    setPage(0);
  };

  const sortValue = `${sort.key}:${sort.dir}`;
  const sortIsPreset = ORDER_SORT_OPTIONS.some((o) => o.key === sort.key && o.dir === sort.dir);

  const openOrder = (id: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('order', id);
    router.push(`${pathname}?${params}`, { scroll: false });
  };
  const closeOrder = () => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete('order');
    const rest = params.toString();
    router.push(rest ? `${pathname}?${rest}` : pathname, { scroll: false });
  };

  // Owner / Admin: bring an archived order back to the everyday list (the server re-checks)
  const canUnarchive = can(user, 'manage_accounts');
  const unarchive = async (orderId: string, label: string) => {
    setUnarchiving(orderId);
    const { ok, data } = await api<{ message?: string }>('POST', `/orders/${encodeURIComponent(orderId)}/restore`);
    setUnarchiving(null);
    setResult(
      ok
        ? { type: 'success', title: 'Order unarchived', message: `${label} is back in the Orders list.` }
        : { type: 'error', title: 'Not unarchived', message: errorMessage(data, 'Nothing was changed.') }
    );
    reload();
  };

  const customerName = (id: string) => customerById.get(id)?.full_name || 'Unknown customer';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <ClipboardList className="size-6" aria-hidden /> Orders
          </h1>
          <p className="text-sm text-muted-foreground">Click an order to open its details, payments and actions.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {can(user, 'create_order') && (
            <Button asChild>
              <Link href="/orders/new">
                <PlusCircle aria-hidden /> New order
              </Link>
            </Button>
          )}
          <Button variant="outline" onClick={reload} disabled={loading}>
            <RefreshCw className={cn(loading && 'animate-spin')} aria-hidden /> {loading ? 'Loading…' : 'Refresh'}
          </Button>
        </div>
      </div>

      {/* Filters and sort (all applied by the server) */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" role="search" aria-label="Filter and sort orders">
        <div className="flex min-w-0 flex-col gap-1.5">
          <Label htmlFor="orders-status">Status</Label>
          <Select value={status} onValueChange={setStatusTo}>
            <SelectTrigger id="orders-status" className="w-full bg-card">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All statuses</SelectItem>
              {ORDER_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <Label htmlFor="orders-customer">Customer</Label>
          <Select value={customerId} onValueChange={setCustomerTo}>
            <BoundedSelectTrigger id="orders-customer" className="bg-card">
              <SelectValue />
            </BoundedSelectTrigger>
            <BoundedSelectContent>
              <SelectItem value={ALL}>All customers</SelectItem>
              {customers.map((c) => (
                <BoundedSelectItem key={c.customer_id} value={c.customer_id} label={c.full_name}>
                  {c.full_name}
                </BoundedSelectItem>
              ))}
            </BoundedSelectContent>
          </Select>
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <Label htmlFor="orders-sort">Sort by</Label>
          <Select
            value={sortValue}
            onValueChange={(v) => {
              const [key, dir] = v.split(':') as [OrderSortKey, 'asc' | 'desc'];
              setSortTo({ key, dir });
            }}
          >
            <SelectTrigger id="orders-sort" className="w-full bg-card">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ORDER_SORT_OPTIONS.map((o) => (
                <SelectItem key={`${o.key}:${o.dir}`} value={`${o.key}:${o.dir}`}>
                  {o.label}
                </SelectItem>
              ))}
              {!sortIsPreset && <SelectItem value={sortValue}>Custom (column header)</SelectItem>}
            </SelectContent>
          </Select>
        </div>
        <form ref={searchFormRef} onSubmit={findNumber} className="flex min-w-0 flex-col gap-1.5" role="search" aria-label="Find an order by its number">
          <Label htmlFor="orders-number">Order number</Label>
          <div className="flex gap-2">
            <Input
              id="orders-number"
              maxLength={TEXT_MAX.orderNumber}
              type="search"
              inputMode="search"
              autoComplete="off"
              value={numberDraft}
              onChange={(e) => typeNumber(e.target.value)}
              placeholder="e.g. 12 or XM-2026-0012"
              aria-invalid={Boolean(numberError)}
              aria-describedby={numberError ? 'orders-number-error' : undefined}
              className="min-w-0 bg-card"
            />
            <Button title="Find order" type="submit" variant="outline" size="icon" aria-label="Find order">
              <Search aria-hidden />
            </Button>
          </div>
          {numberError && <p id="orders-number-error" className="text-xs text-danger">{numberError}</p>}
        </form>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Toggle
          variant="outline"
          size="sm"
          pressed={showArchived}
          onPressedChange={(on) => {
            setShowArchived(on);
            setPage(0);
          }}
          aria-label="Show archived orders"
        >
          <Archive aria-hidden /> Show archived
        </Toggle>
        {showArchived && <span className="text-xs text-muted-foreground">Showing archived orders only.</span>}
        {(filtersActive || showArchived) && (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            <X aria-hidden /> Clear filters
          </Button>
        )}
      </div>

      {list?.source === 'local' && (
        <p className={cn('flex items-center gap-2 rounded-md border p-3 text-sm', TONE_CLASSES.warning.banner)}>
          <CloudOff className="size-4 shrink-0" aria-hidden /> Offline mode: showing orders saved on this computer.
        </p>
      )}
      {loaded?.error && (
        <p role="alert" className={cn('rounded-md border p-3 text-sm', TONE_CLASSES.danger.banner)}>
          {loaded.error}
        </p>
      )}

      {/* Orders table + paging: "the results" (clicking in here keeps an order-number search) */}
      <div ref={resultsRef} className="space-y-6">
      {!list && loading ? (
        <div className="rounded-lg border bg-card">
          <LogoSpinner label="Loading orders…" />
        </div>
      ) : (
        <div className={cn('max-w-full min-w-0 overflow-x-auto rounded-lg border bg-card transition-opacity', loading && 'opacity-60')} aria-busy={loading}>
          <Table aria-label="Orders">
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Order</TableHead>
                <TableHead className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Customer</TableHead>
                <SortHead label="Created" k="date_created" sort={sort} onSort={sortByColumn} className="hidden lg:table-cell" />
                <SortHead label="Deadline" k="production_deadline" sort={sort} onSort={sortByColumn} className="hidden sm:table-cell" />
                <SortHead label="Status" k="production_status" sort={sort} onSort={sortByColumn} />
                {/* migration 016: hand-over progress, from the server */}
                <TableHead className="hidden text-xs font-semibold tracking-wide text-muted-foreground uppercase xl:table-cell">Delivery</TableHead>
                <SortHead label="Bill" k="total_quote_amount" sort={sort} onSort={sortByColumn} className="hidden text-right md:table-cell" />
                {/* migration 015: what is left to pay, from the server */}
                <TableHead className="text-right text-xs font-semibold tracking-wide text-muted-foreground uppercase">Left to pay</TableHead>
                <TableHead className="w-10">
                  <span className="sr-only">Open</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shownOrders.length === 0 && !loading && !loaded?.error && (
                <TableRow>
                  <TableCell colSpan={8} className="py-10 text-left leading-relaxed whitespace-normal text-muted-foreground">
                    {numberFilter
                      ? `No order number contains "${numberFilter}".`
                      : showArchived
                        ? 'No archived orders.'
                        : status !== ALL || customerId !== ALL
                        ? 'No orders match these filters.'
                        : 'No orders yet.'}
                  </TableCell>
                </TableRow>
              )}
              {shownOrders.map((o) => (
                <TableRow
                  key={o.order_id}
                  onClick={() => openOrder(o.order_id)}
                  // HCI signifier: the whole row reacts to the pointer and to keyboard focus on its order button
                  className={cn('group/row cursor-pointer hover:bg-muted/60 focus-within:bg-muted/60 focus-within:ring-2 focus-within:ring-ring/50 focus-within:ring-inset', openId === o.order_id && 'bg-muted')}
                >
                  <TableCell>
                    {/* The real control for keyboard and screen-reader users */}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        openOrder(o.order_id);
                      }}
                      aria-label={`Open order ${orderNumber(o)}, ${customerName(o.customer_id)}`}
                      title="Open the order details"
                      className="min-h-8 font-mono text-sm font-medium underline-offset-4 hover:underline focus-visible:outline-none pointer-coarse:min-h-10"
                    >
                      <HighlightedNumber number={orderNumber(o)} query={numberFilter} />
                    </button>
                    {o.sync_status !== 'synced' && (
                      <Badge variant="outline" className={cn('ml-2', TONE_CLASSES.info.badge)}>
                        Pending sync
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="min-w-0">
                    <span className="block max-w-[150px] truncate sm:max-w-[220px]" title={customerName(o.customer_id)}>
                      {customerName(o.customer_id)}
                    </span>
                    {customerById.get(o.customer_id)?.contact_number && (
                      <span className="block text-xs text-muted-foreground tabular-nums">
                        {formatMobile(customerById.get(o.customer_id)?.contact_number)}
                      </span>
                    )}
                    <span className="block text-xs text-muted-foreground sm:hidden">
                      Due {formatDateTime(o.production_deadline, { withTime: false })}
                    </span>
                    <DeadlineBadge flag={o.deadline_flag} className="mt-1 sm:hidden" />
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">{formatDateTime(o.date_created, { utc: true })}</TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <span className="flex flex-wrap items-center gap-2">
                      {formatDateTime(o.production_deadline, { withTime: false })}
                      <DeadlineBadge flag={o.deadline_flag} />
                    </span>
                  </TableCell>
                  <TableCell>
                    <OrderStatusBadge status={o.production_status} />
                    {o.archived_at && (
                      <Badge variant="outline" className={cn('ml-1', TONE_CLASSES.muted.badge)}>
                        Archived
                      </Badge>
                    )}
                    {o.archived_at && canUnarchive && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="ml-2 px-2 text-xs"
                        disabled={unarchiving !== null}
                        onClick={(e) => {
                          e.stopPropagation(); // do not open the order
                          void unarchive(o.order_id, orderNumber(o));
                        }}
                      >
                        <ArchiveRestore aria-hidden /> {unarchiving === o.order_id ? 'Unarchiving…' : 'Unarchive'}
                      </Button>
                    )}
                  </TableCell>
                  <TableCell className="hidden xl:table-cell">
                    {o.delivery_status ? (
                      <>
                        <DeliveryStatusBadge status={o.delivery_status} />
                        {(o.pieces_ordered ?? 0) > 0 && (
                          <span className="block text-xs text-muted-foreground tabular-nums">
                            {(o.pieces_delivered ?? 0).toLocaleString()} of {(o.pieces_ordered ?? 0).toLocaleString()} pcs
                          </span>
                        )}
                      </>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell className="hidden text-right tabular-nums md:table-cell">{peso(o.total_quote_amount)}</TableCell>
                  <TableCell className="text-right">
                    {o.payment_status ? (
                      <>
                        <span className="block tabular-nums">{peso(o.remaining ?? 0)}</span>
                        <PaymentStatusBadge status={o.payment_status} />
                        {/* adviser point 5: down payment made or fully paid, at a glance */}
                        {(o.total_paid ?? 0) > 0 && (
                          <span className="block text-xs text-muted-foreground tabular-nums">Paid {peso(o.total_paid ?? 0)}</span>
                        )}
                      </>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell className="w-10 text-muted-foreground">
                    <ChevronRight className="size-4 transition-transform group-hover/row:translate-x-0.5" aria-hidden />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {(page > 0 || hasNext) && (
        <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
          <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0 || loading}>
            <ChevronLeft aria-hidden /> Prev
          </Button>
          <span>Page {page + 1}</span>
          <Button variant="outline" size="sm" onClick={() => setPage((p) => p + 1)} disabled={!hasNext || loading}>
            Next <ChevronRight aria-hidden />
          </Button>
        </div>
      )}
      </div>

      <ResultDialog result={result} onClose={() => setResult(null)} />

      <OrderDetailSheet
        orderId={openId}
        customerById={customerById}
        onClose={closeOrder}
        onChanged={() => {
          reload();
          reloadCustomers();
        }}
      />
    </div>
  );
}
