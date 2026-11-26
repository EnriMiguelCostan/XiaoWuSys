'use client';

// The stock card (migration 015): every change of the quantity on hand, newest first, with the
// balance right after it, what it was (stock in, used for an order, waste, a count…), its paper
// or order number and who made it. The database writes a row for EVERY change, whatever made it,
// so the card always adds up. Read only, from GET /api/stock/movements (needs the internet).
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ArrowDownToLine, ArrowUpFromLine, History } from 'lucide-react';
import { formatDateTime, peso } from '@xiaowu/client-core/format';
import { DateInput } from '@/components/forms/date-input';
import { Field } from '@/components/forms/form-bits';
import { BoundedSelectContent, BoundedSelectItem, BoundedSelectTrigger } from '@/components/forms/bounded-select';
import { LoadProblem, PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useApi } from '@/hooks/use-api';
import { useInventorySnapshot } from '@/hooks/use-inventory-snapshot';
import { errorMessage } from '@/lib/api';
import type { InventoryItem } from '@/lib/inventory';
import type { StockMovement, StockOptions } from '@/lib/stock';
import { TONE_CLASSES } from '@/lib/ui-tokens';
import { cn } from '@/lib/utils';

interface MovementPage {
  movements: StockMovement[];
  total: number;
  totals: { total_in: number; total_out: number };
  item: InventoryItem | null;
}
const ALL = '__all__';

export function StockCardScreen() {
  const api = useApi();
  const params = useSearchParams();
  const { snapshot } = useInventorySnapshot();
  const items = useMemo(() => snapshot?.items ?? [], [snapshot]);
  const [itemId, setItemId] = useState(params.get('item') ?? ALL);
  const [type, setType] = useState(ALL);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [limit, setLimit] = useState(100);
  const [options, setOptions] = useState<StockOptions | null>(null);
  const [page, setPage] = useState<MovementPage | null>(null);
  const [problem, setProblem] = useState('');

  useEffect(() => {
    api<StockOptions>('GET', '/stock/options').then(({ ok, data }) => ok && setOptions(data));
  }, [api]);

  useEffect(() => {
    let cancelled = false;
    const q = new URLSearchParams({ limit: String(limit) });
    if (itemId !== ALL) q.set('inventory_id', itemId);
    if (type !== ALL) q.set('movement_type', type);
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    api<MovementPage>('GET', `/stock/movements?${q}`).then(({ ok, data }) => {
      if (cancelled) return;
      if (ok) {
        setPage(data);
        setProblem('');
      } else setProblem(errorMessage(data, 'The stock card could not be loaded.'));
    });
    return () => {
      cancelled = true;
    };
  }, [api, itemId, type, from, to, limit]);

  const item = page?.item;
  return (
    <div className="space-y-5">
      <PageHeader
        icon={History}
        title="Stock card"
        description="Every change of the stock on hand, with the balance after it. Choose an item to see its own card."
        actions={
          item && (
            <>
              <Button variant="outline" asChild>
                <Link href={`/inventory/stock-in?new=1&item=${encodeURIComponent(item.inventory_id)}`}>
                  <ArrowDownToLine aria-hidden /> Stock in
                </Link>
              </Button>
              <Button variant="outline" asChild>
                <Link href={`/inventory/stock-out?new=1&item=${encodeURIComponent(item.inventory_id)}`}>
                  <ArrowUpFromLine aria-hidden /> Stock out
                </Link>
              </Button>
            </>
          )
        }
      />
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3">
          <Field id="card-item" label="Item" className="min-w-56 flex-[2_1_16rem]">
            <Select value={itemId} onValueChange={setItemId}>
              <BoundedSelectTrigger id="card-item">
                <SelectValue />
              </BoundedSelectTrigger>
              <BoundedSelectContent>
                <BoundedSelectItem value={ALL} label="All items">All items</BoundedSelectItem>
                {items.map((i) => (
                  <BoundedSelectItem key={i.inventory_id} value={i.inventory_id} label={i.item_name}>
                    {i.item_name}
                  </BoundedSelectItem>
                ))}
              </BoundedSelectContent>
            </Select>
          </Field>
          <Field id="card-type" label="Kind of movement" className="w-56">
            <Select value={type} onValueChange={setType}>
              <SelectTrigger id="card-type" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Every kind</SelectItem>
                {(options?.movement_types ?? []).map((m) => (
                  <SelectItem key={m.value} value={m.value}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field id="card-from" label="From" className="w-40">
            <DateInput id="card-from" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field id="card-to" label="To" className="w-40">
            <DateInput id="card-to" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </CardContent>
      </Card>

      {item && (
        <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
          <Box label="On hand now" value={`${item.quantity_available.toLocaleString()} ${item.unit ?? ''}`} />
          <Box label="Held for orders" value={item.quantity_reserved.toLocaleString()} />
          <Box label="Free to use" value={item.quantity_available_net.toLocaleString()} />
          <Box label="Average unit cost" value={peso(item.unit_cost)} />
          <Box label="Stock value" value={peso(item.stock_value ?? 0)} />
        </dl>
      )}
      {page && (
        <p className="text-sm text-muted-foreground">
          {page.total.toLocaleString()} movement{page.total === 1 ? '' : 's'} · in <strong className="text-foreground tabular-nums">+{page.totals.total_in.toLocaleString()}</strong> · out{' '}
          <strong className="text-foreground tabular-nums">−{page.totals.total_out.toLocaleString()}</strong>
        </p>
      )}
      <LoadProblem message={problem} />
      {!page && !problem ? (
        <Skeleton className="h-64 w-full" />
      ) : page && page.movements.length === 0 ? (
        <p className="rounded-md border bg-card p-6 text-center text-sm text-muted-foreground">No movements match these filters.</p>
      ) : page ? (
        <div className="max-w-full min-w-0 overflow-x-auto rounded-md border bg-card">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead>When</TableHead>
                {itemId === ALL && <TableHead>Item</TableHead>}
                <TableHead>Movement</TableHead>
                <TableHead className="hidden md:table-cell">Reference</TableHead>
                <TableHead className="text-right">In</TableHead>
                <TableHead className="text-right">Out</TableHead>
                <TableHead className="text-right">Balance</TableHead>
                <TableHead className="hidden lg:table-cell">By</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {page.movements.map((m) => (
                <TableRow key={m.movement_id}>
                  <TableCell className="whitespace-nowrap">
                    {formatDateTime(m.created_at, { utc: true })}
                    {m.occurred_at && m.occurred_at.slice(0, 10) !== m.created_at.slice(0, 10) && (
                      <span className="block text-xs text-muted-foreground">dated {formatDateTime(m.occurred_at, { utc: true, withTime: false })}</span>
                    )}
                  </TableCell>
                  {itemId === ALL && <TableCell className="max-w-48 whitespace-normal wrap-anywhere">{m.item_name}</TableCell>}
                  <TableCell className="whitespace-normal">
                    <Badge variant="outline" className={m.direction === 'in' ? TONE_CLASSES.success.badge : TONE_CLASSES.warning.badge}>
                      {m.label}
                    </Badge>
                    {m.note && <span className="block max-w-64 text-xs text-muted-foreground wrap-anywhere">{m.note}</span>}
                  </TableCell>
                  <TableCell className="hidden font-mono text-xs md:table-cell">{m.reference_no ?? '—'}</TableCell>
                  <TableCell className={cn('text-right tabular-nums', TONE_CLASSES.success.text)}>{m.quantity_change > 0 ? `+${m.quantity_change.toLocaleString()}` : ''}</TableCell>
                  <TableCell className={cn('text-right tabular-nums', TONE_CLASSES.danger.text)}>{m.quantity_change < 0 ? m.quantity_change.toLocaleString() : ''}</TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">{m.balance_after.toLocaleString()}</TableCell>
                  <TableCell className="hidden lg:table-cell">{m.performed_by_name}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {page.total > page.movements.length && (
            <div className="flex justify-center border-t p-3">
              <Button variant="outline" size="sm" onClick={() => setLimit((n) => Math.min(200, n + 100))} disabled={limit >= 200}>
                Show more ({page.movements.length} of {page.total.toLocaleString()})
              </Button>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function Box({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-card p-2">
      <dt className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  );
}
