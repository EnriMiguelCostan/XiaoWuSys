'use client';

// Orders list (ported from OrdersPage.jsx). Sorting, filtering and paging all run on the
// server (GET /api/orders), so they are correct across pages. The detail opens as a side
// sheet addressed by ?order=<order_id>, so an order can be linked and the Back button closes it.
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, ClipboardList, CloudOff, PlusCircle, RefreshCw, Search, X } from 'lucide-react';
import { formatDateTime, peso } from '@xiaowu/client-core/format';
import { normalizeOrderNumber, orderNumber } from '@xiaowu/client-core/orders';
import { can } from '@xiaowu/client-core/permissions';
import { useConnection } from '@/components/connection/connection-provider';
import { OrderDetailSheet } from '@/components/orders/order-detail-sheet';
import { OrderStatusBadge } from '@/components/orders/status-badges';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { BoundedSelectContent, BoundedSelectItem, BoundedSelectTrigger } from '@/components/forms/bounded-select';
import { useCustomers } from '@/hooks/use-customers';
import { useSession } from '@/hooks/use-session';
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
          'inline-flex items-center gap-1 text-xs font-semibold tracking-wide uppercase hover:text-foreground',
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
  const [page, setPage] = useState(0);
  const [tick, setTick] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  const qs = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE), sort: sort.key, dir: sort.dir });
  if (status !== ALL) qs.set('status', status);
  if (customerId !== ALL) qs.set('customer_id', customerId);
  if (numberFilter) qs.set('tracking_no', numberFilter);
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

  const reload = useCallback(() => setTick((t) => t + 1), []);

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

  const findNumber = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (numberDraft.trim() === '') {
      setNumberError('');
      changed(setNumberFilter)('');
      return;
    }
    const value = normalizeOrderNumber(numberDraft);
    if (!value) {
      setNumberError('An order number looks like XM-2026-0123.');
      return;
    }
    setNumberError('');
    setNumberDraft(value);
    changed(setNumberFilter)(value);
  };

  const isDefaultSort = sort.key === DEFAULT_ORDER_SORT.key && sort.dir === DEFAULT_ORDER_SORT.dir;
  const filtersActive = status !== ALL || customerId !== ALL || Boolean(numberFilter) || !isDefaultSort;
  const clearFilters = () => {
    setStatus(ALL);
    setCustomerId(ALL);
    setNumberFilter('');
    setNumberDraft('');
    setNumberError('');
    setSort(DEFAULT_ORDER_SORT);
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
        <div className="min-w-0 space-y-1.5">
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
        <div className="min-w-0 space-y-1.5">
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
        <div className="min-w-0 space-y-1.5">
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
        <form onSubmit={findNumber} className="min-w-0 space-y-1.5" role="search" aria-label="Find an order by its number">
          <Label htmlFor="orders-number">Order number</Label>
          <div className="flex gap-2">
            <Input
              id="orders-number"
              maxLength={TEXT_MAX.orderNumber}
              value={numberDraft}
              onChange={(e) => setNumberDraft(e.target.value)}
              placeholder="XM-2026-0123"
              aria-invalid={Boolean(numberError)}
              className="min-w-0 bg-card"
            />
            <Button type="submit" variant="outline" size="icon" aria-label="Find order">
              <Search aria-hidden />
            </Button>
          </div>
          {numberError && <p className="text-xs text-danger">{numberError}</p>}
        </form>
      </div>
      {filtersActive && (
        <Button variant="ghost" size="sm" onClick={clearFilters}>
          <X aria-hidden /> Clear filters
        </Button>
      )}

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

      {/* Orders table */}
      {!list && loading ? (
        <div className="space-y-2 rounded-lg border bg-card p-4" role="status" aria-label="Loading orders">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
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
                <SortHead label="Quote" k="total_quote_amount" sort={sort} onSort={sortByColumn} className="hidden text-right md:table-cell" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.length === 0 && !loading && !loaded?.error && (
                <TableRow>
                  <TableCell colSpan={6} className="py-10 text-center whitespace-normal text-muted-foreground">
                    {numberFilter
                      ? `No order has the number ${numberFilter}.`
                      : status !== ALL || customerId !== ALL
                        ? 'No orders match these filters.'
                        : 'No orders yet.'}
                  </TableCell>
                </TableRow>
              )}
              {orders.map((o) => (
                <TableRow
                  key={o.order_id}
                  onClick={() => openOrder(o.order_id)}
                  className={cn('cursor-pointer', openId === o.order_id && 'bg-muted')}
                >
                  <TableCell>
                    {/* The real control for keyboard and screen-reader users */}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        openOrder(o.order_id);
                      }}
                      className="font-mono text-sm font-medium underline-offset-4 hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                    >
                      {orderNumber(o)}
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
                    <span className="block text-xs text-muted-foreground sm:hidden">
                      Due {formatDateTime(o.production_deadline, { withTime: false })}
                    </span>
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">{formatDateTime(o.date_created, { utc: true })}</TableCell>
                  <TableCell className="hidden sm:table-cell">{formatDateTime(o.production_deadline, { withTime: false })}</TableCell>
                  <TableCell>
                    <OrderStatusBadge status={o.production_status} />
                  </TableCell>
                  <TableCell className="hidden text-right tabular-nums md:table-cell">{peso(o.total_quote_amount)}</TableCell>
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
