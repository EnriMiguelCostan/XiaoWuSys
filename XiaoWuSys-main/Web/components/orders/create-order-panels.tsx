'use client';

// Side panels of the Create order screen. Everything shown here comes from the server; these
// components only lay it out.
//   ClientSnapshot   GET /api/customers/:id         contact details, orders so far, balance due,
//                                                   recent orders with "Repeat" (copies materials)
//   StockCheckPanel  POST /api/inventory/check-capacity   live "is there enough stock?" (works offline)
//   QuotePreview     POST /api/orders/quote-preview       Owner: catalog prices + bulk tier + labor +
//                                                          incidental, before the order exists
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { CircleCheck, Loader, PackageX, Repeat2, TriangleAlert, UserRound } from 'lucide-react';
import { formatDateTime, formatMobile, peso } from '@xiaowu/client-core/format';
import { orderNumber } from '@xiaowu/client-core/orders';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/hooks/use-api';
import { errorMessage } from '@/lib/api';
import type { Customer, Order, Shortage } from '@/lib/orders';
import { lookFor, ORDER_STATUS, TONE_CLASSES } from '@/lib/ui-tokens';
import { cn } from '@/lib/utils';

export interface RequiredItem {
  inventory_id: string;
  quantity_needed: number;
  /** migration 017: print areas of a per-area item */
  print_areas?: { placement: string; size: string }[];
}

const DEBOUNCE_MS = 450;

export function PanelBox({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn('rounded-lg border bg-card p-4', className)}>
      <h2 className="mb-3 text-sm font-semibold tracking-tight">{title}</h2>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Client snapshot
// ---------------------------------------------------------------------------------------------
interface Profile {
  customer: Customer;
  orders: (Order & { remaining?: number; payment_status?: string })[];
  totals: { order_count: number; open_orders: number; total_billed: number; total_paid: number; balance_due: number; last_order_at: string | null };
}

export function ClientSnapshot({
  customerId,
  newName,
  onRepeat,
}: {
  customerId: string;
  /** the name typed for a new client (no profile yet) */
  newName?: string;
  onRepeat: (orderId: string) => void;
}) {
  const api = useApi();
  // The answer for one client; an answer for another client shows as loading
  const [answer, setAnswer] = useState<{ id: string; profile: Profile | null; problem: string } | null>(null);

  useEffect(() => {
    if (!customerId) return;
    let cancelled = false;
    api<Profile>('GET', `/customers/${encodeURIComponent(customerId)}`).then(({ ok, data }) => {
      if (cancelled) return;
      setAnswer(ok ? { id: customerId, profile: data, problem: '' } : { id: customerId, profile: null, problem: errorMessage(data, 'The client profile could not be loaded.') });
    });
    return () => {
      cancelled = true;
    };
  }, [api, customerId]);
  const current = answer && answer.id === customerId ? answer : null;
  const profile = current?.profile ?? null;
  const problem = current?.problem ?? '';

  if (!customerId) {
    return (
      <PanelBox title="Client">
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <UserRound className="size-4" aria-hidden />
          {newName?.trim() ? <>New client: <strong className="text-foreground">{newName.trim()}</strong></> : 'No client chosen yet.'}
        </p>
      </PanelBox>
    );
  }
  if (problem) {
    return (
      <PanelBox title="Client">
        <p className="text-sm text-muted-foreground">{problem}</p>
      </PanelBox>
    );
  }
  if (!profile) {
    return (
      <PanelBox title="Client">
        <Skeleton className="h-24 w-full" />
      </PanelBox>
    );
  }

  const c = profile.customer;
  const t = profile.totals;
  const recent = profile.orders.slice(0, 4);
  const facts = [
    c.customer_type,
    c.contact_number ? formatMobile(c.contact_number) : null,
    c.contact_person ? `Contact: ${c.contact_person}` : null,
    c.email,
    c.address,
    c.platform_source ? `From ${c.platform_source}` : null,
  ].filter(Boolean);

  return (
    <PanelBox title="Client">
      <p className="font-medium wrap-anywhere">{c.full_name}</p>
      {facts.length > 0 && <p className="mt-1 text-xs text-muted-foreground wrap-anywhere">{facts.join(' · ')}</p>}
      {c.notes && <p className="mt-2 rounded-md bg-muted px-2 py-1 text-xs whitespace-pre-line wrap-anywhere">{c.notes}</p>}

      <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
        <div className="rounded-md bg-muted/60 p-2">
          <dt className="text-[11px] text-muted-foreground">Orders</dt>
          <dd className="font-semibold">{t.order_count}</dd>
        </div>
        <div className="rounded-md bg-muted/60 p-2">
          <dt className="text-[11px] text-muted-foreground">Open</dt>
          <dd className="font-semibold">{t.open_orders}</dd>
        </div>
        <div className={cn('rounded-md p-2', t.balance_due ? TONE_CLASSES.warning.badge : 'bg-muted/60')}>
          <dt className="text-[11px] text-muted-foreground">Balance due</dt>
          <dd className="font-semibold">{peso(t.balance_due)}</dd>
        </div>
      </dl>

      {recent.length > 0 && (
        <div className="mt-3 space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">Recent orders · Repeat copies the materials and description</p>
          <ul className="space-y-1">
            {recent.map((o) => {
              const tone = lookFor(ORDER_STATUS, o.production_status).tone;
              return (
                <li key={o.order_id} className="flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs">
                  <div className="min-w-0 flex-1">
                    <Link href={`/orders?order=${encodeURIComponent(o.order_id)}`} className="font-mono text-primary underline-offset-4 hover:underline">
                      {orderNumber(o)}
                    </Link>
                    <span className="ml-1 text-muted-foreground">{formatDateTime(o.date_created, { withTime: false, utc: true })}</span>
                    <Badge variant="outline" className={cn('ml-1 px-1 py-0 text-[10px]', TONE_CLASSES[tone].badge)}>
                      {o.production_status}
                    </Badge>
                  </div>
                  <Button type="button" size="sm" variant="ghost" className="h-7 px-2" onClick={() => onRepeat(o.order_id)} title="Copy this order's materials and description into the form">
                    <Repeat2 aria-hidden /> Repeat
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <Link href="/clients" className="mt-3 inline-block text-xs text-primary underline-offset-4 hover:underline">
        Full profile in Clients →
      </Link>
    </PanelBox>
  );
}

// ---------------------------------------------------------------------------------------------
// Live stock check (the server's answer; the order is checked again when it is saved)
// ---------------------------------------------------------------------------------------------
export type StockCheck =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'ok'; source?: string }
  | { state: 'short'; message: string; shortages: Shortage[]; source?: string }
  | { state: 'problem'; message: string; missing?: string[] };

export function useStockCheck(items: RequiredItem[]): StockCheck {
  const api = useApi();
  // The server's answer, tagged with the request it answers; anything older shows as "checking"
  const [answer, setAnswer] = useState<{ key: string; check: StockCheck } | null>(null);
  const key = items.length ? JSON.stringify(items) : '';

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const { ok, status, data } = await api<{ source?: string; message?: string; shortages?: Shortage[]; missing_inventory_ids?: string[] }>(
        'POST',
        '/inventory/check-capacity',
        { required_items: JSON.parse(key) as RequiredItem[] }
      );
      if (cancelled) return;
      let check: StockCheck;
      if (ok) check = { state: 'ok', source: data.source };
      else if (status === 409) check = { state: 'short', message: errorMessage(data, 'Not enough stock.'), shortages: data.shortages ?? [], source: data.source };
      else check = { state: 'problem', message: errorMessage(data, 'Stock could not be checked right now.'), missing: data.missing_inventory_ids };
      setAnswer({ key, check });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, key]);

  if (!key) return { state: 'idle' };
  return answer && answer.key === key ? answer.check : { state: 'checking' };
}

export function StockCheckPanel({ check, nameOf }: { check: StockCheck; nameOf: (id: string) => string }) {
  return (
    <PanelBox title="Stock check">
      {check.state === 'idle' && <p className="text-sm text-muted-foreground">Choose materials and quantities to check the stock.</p>}
      {check.state === 'checking' && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader className="size-4 animate-spin" aria-hidden /> Checking stock…
        </p>
      )}
      {check.state === 'ok' && (
        <p className={cn('flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm', TONE_CLASSES.success.banner)}>
          <CircleCheck className="size-4 shrink-0" aria-hidden /> Enough free stock for every material.
          {check.source === 'local' && <span className="text-xs">(this computer’s copy)</span>}
        </p>
      )}
      {check.state === 'short' && (
        <div className="space-y-2">
          <p className={cn('flex items-start gap-2 rounded-md border px-2 py-1.5 text-sm', TONE_CLASSES.warning.banner)}>
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>{check.message} You can still save: you will be asked to delay or cancel the order.</span>
          </p>
          <ul className="space-y-1 text-xs">
            {check.shortages.map((s) => (
              <li key={s.inventory_id} className="flex justify-between gap-2">
                <span className="min-w-0 truncate" title={s.item_name ?? nameOf(s.inventory_id)}>
                  {s.item_name ?? nameOf(s.inventory_id)}
                </span>
                <span className="shrink-0 text-warning">
                  short {(s.shortfall ?? 0).toLocaleString()} · {s.available.toLocaleString()} free
                </span>
              </li>
            ))}
          </ul>
          <Link href="/inventory/stock-in" className="inline-block text-xs text-primary underline-offset-4 hover:underline">
            Receive stock (Stock in) →
          </Link>
        </div>
      )}
      {check.state === 'problem' && (
        <p className={cn('flex items-start gap-2 rounded-md border px-2 py-1.5 text-sm', TONE_CLASSES.danger.banner)}>
          <PackageX className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            {check.message}
            {check.missing?.length ? ` (${check.missing.map(nameOf).join(', ')})` : ''}
          </span>
        </p>
      )}
    </PanelBox>
  );
}

// ---------------------------------------------------------------------------------------------
// Quote preview (Owner)
// ---------------------------------------------------------------------------------------------
export interface PreviewQuote {
  total_quantity: number;
  tier: { percent_off: number; label: string };
  lines: { inventory_id: string; product_type: string; quantity: number; selling_price: number; unit_price: number; line_total: number }[];
  subtotal_amount: number;
  labor_amount: number;
  incidental_amount: number;
  incidental_percent: number | null;
  gross_amount: number;
  total_quote_amount: number;
}

export interface Charges {
  labor_amount?: number;
  incidental_amount?: number;
  incidental_percent?: number;
}

export type QuotePreviewState =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'ok'; quote: PreviewQuote }
  | { state: 'problem'; message: string; unpriced?: string[] };

export function useQuotePreview(enabled: boolean, items: RequiredItem[], charges: Charges): QuotePreviewState {
  const api = useApi();
  const [answer, setAnswer] = useState<{ key: string; preview: QuotePreviewState } | null>(null);
  const key = enabled && items.length ? JSON.stringify({ items, charges }) : '';

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const body = JSON.parse(key) as { items: RequiredItem[]; charges: Charges };
      // rules-guard: allow no-rule-math the URL path, not a division
      const { ok, data } = await api<{ quote?: PreviewQuote; message?: string; inventory_ids?: string[] }>('POST', '/orders/quote-preview', {
        required_items: body.items,
        ...body.charges,
      });
      if (cancelled) return;
      setAnswer({
        key,
        preview: ok && data.quote
          ? { state: 'ok', quote: data.quote }
          : { state: 'problem', message: errorMessage(data, 'The price could not be worked out right now.'), unpriced: data.inventory_ids },
      });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, key]);

  if (!key) return { state: 'idle' };
  return answer && answer.key === key ? answer.preview : { state: 'checking' };
}

export function QuotePreviewTable({ preview }: { preview: QuotePreviewState }) {
  if (preview.state === 'idle') return <p className="text-sm text-muted-foreground">Add materials to see the price.</p>;
  if (preview.state === 'checking') {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader className="size-4 animate-spin" aria-hidden /> Working out the price…
      </p>
    );
  }
  if (preview.state === 'problem') {
    return (
      <div className={cn('space-y-1 rounded-md border px-2 py-1.5 text-sm', TONE_CLASSES.warning.banner)}>
        <p>{preview.message}</p>
        {preview.unpriced?.length ? (
          <Link href="/catalog" className="text-xs underline underline-offset-4">
            Set selling prices in the Catalog →
          </Link>
        ) : null}
      </div>
    );
  }
  const q = preview.quote;
  const row = (label: React.ReactNode, value: React.ReactNode, strong = false) => (
    <div className={cn('flex justify-between gap-2', strong && 'border-t pt-1.5 text-base font-semibold')}>
      <dt className={cn(!strong && 'text-muted-foreground')}>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
  return (
    <div className="space-y-2 text-sm">
      <ul className="space-y-0.5 text-xs">
        {q.lines.map((l) => (
          <li key={l.inventory_id} className="flex justify-between gap-2">
            <span className="min-w-0 truncate" title={l.product_type}>
              {l.quantity.toLocaleString()} × {l.product_type} @ {peso(l.unit_price)}
            </span>
            <span className="shrink-0 tabular-nums">{peso(l.line_total)}</span>
          </li>
        ))}
      </ul>
      {q.tier.percent_off > 0 && <Badge variant="outline" className={TONE_CLASSES.success.badge}>{q.tier.label}</Badge>}
      <dl className="space-y-1">
        {row('Materials', peso(q.subtotal_amount))}
        {row('Labor / services', peso(q.labor_amount))}
        {row(q.incidental_percent != null ? `Incidental (${q.incidental_percent}%)` : 'Incidental', peso(q.incidental_amount))}
        {row('Quote', peso(q.total_quote_amount), true)}
      </dl>
    </div>
  );
}
