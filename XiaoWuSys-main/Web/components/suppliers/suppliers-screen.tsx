'use client';

// Suppliers (migration 015): who the shop buys from, what they supply, and every delivery.
// The list and the profile come from GET /api/suppliers (cloud; offline: this computer's copy
// without the delivery figures). Which buttons appear comes from the server (can_add,
// allowed_actions). "Record stock in" opens the Stock in form with this supplier chosen.
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Archive, ArchiveRestore, ArrowLeft, ArrowDownToLine, Mail, MapPin, Pencil, Phone, Plus, Search, Truck, UserRound } from 'lucide-react';
import { formatDateTime, peso } from '@xiaowu/client-core/format';
import { ConfirmDialog } from '@/components/feedback/confirm-dialog';
import { ResultDialog, type ResultMessage } from '@/components/feedback/result-dialog';
import { Field } from '@/components/forms/form-bits';
import { LoadProblem, PageHeader } from '@/components/layout/page-header';
import { SupplierFormDialog } from '@/components/suppliers/supplier-form-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SHEET_SCROLL_BODY } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Toggle } from '@/components/ui/toggle';
import { useApi } from '@/hooks/use-api';
import { errorMessage } from '@/lib/api';
import type { InventoryItem } from '@/lib/inventory';
import type { StockDocument, Supplier, SupplierActions } from '@/lib/stock';
import { STOCK_STATUS, TONE_CLASSES, lookFor } from '@/lib/ui-tokens';
import { cn } from '@/lib/utils';

interface SupplierList {
  source: string;
  suppliers: Supplier[];
  can_add: boolean;
}
interface SupplierProfile {
  supplier: Supplier;
  items: InventoryItem[];
  deliveries: (StockDocument & { item_names: string | null })[];
  totals: { delivery_count: number; total_purchased: number; last_delivery_at: string | null; returns: number };
  allowed_actions: SupplierActions;
}

export function SuppliersScreen() {
  const api = useApi();
  const [list, setList] = useState<SupplierList | null>(null);
  const [problem, setProblem] = useState('');
  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [tick, setTick] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Supplier | null | 'new'>(null);
  const [result, setResult] = useState<ResultMessage | null>(null);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    const q = new URLSearchParams();
    if (search.trim()) q.set('search', search.trim());
    if (showArchived) q.set('include_archived', 'only');
    api<SupplierList>('GET', `/suppliers?${q}`).then(({ ok, data }) => {
      if (cancelled) return;
      if (ok) {
        setList(data);
        setProblem('');
      } else setProblem(errorMessage(data, 'The suppliers could not be loaded.'));
    });
    return () => {
      cancelled = true;
    };
  }, [api, search, showArchived, tick]);

  return (
    <div className="space-y-5">
      <PageHeader
        icon={Truck}
        title="Suppliers"
        description="Who the shop buys from: contacts, the items they supply, and every delivery received from them."
        actions={
          list?.can_add && (
            <Button onClick={() => setEditing('new')}>
              <Plus aria-hidden /> Add supplier
            </Button>
          )
        }
      />
      <div className="flex flex-wrap items-end gap-3">
        <Field id="sup-search" label="Search" className="min-w-56 flex-1">
          <div className="relative flex items-center">
            <Search className="pointer-events-none absolute left-2.5 size-4 text-muted-foreground" aria-hidden />
            <Input id="sup-search" className="pl-8" placeholder="Supplier or contact person" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </Field>
        <Toggle variant="outline" pressed={showArchived} onPressedChange={setShowArchived} aria-label="Show archived suppliers">
          <Archive aria-hidden /> Show archived
        </Toggle>
      </div>
      {showArchived && (
        <div className={cn('flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm', TONE_CLASSES.info.banner)}>
          <span>Showing archived suppliers only. Open one to restore it.</span>
          <Button size="sm" variant="outline" onClick={() => setShowArchived(false)}>
            <ArrowLeft aria-hidden /> Back to active suppliers
          </Button>
        </div>
      )}
      <LoadProblem message={problem} />
      {list?.source === 'local' && (
        <p className={cn('rounded-md border p-3 text-sm', TONE_CLASSES.info.banner)}>Offline: showing this computer’s copy. Delivery figures need the internet.</p>
      )}
      {!list && !problem ? (
        <Skeleton className="h-48 w-full" />
      ) : list && list.suppliers.length === 0 ? (
        <p className="rounded-md border bg-card p-6 text-center text-sm text-muted-foreground">{search.trim() ? 'No supplier matches.' : showArchived ? 'No archived suppliers.' : 'No suppliers yet. Add the first one.'}</p>
      ) : list ? (
        <div className="max-w-full min-w-0 overflow-x-auto rounded-md border bg-card">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead>Supplier</TableHead>
                <TableHead className="hidden md:table-cell">Contact</TableHead>
                <TableHead className="text-right">Items</TableHead>
                <TableHead className="hidden text-right sm:table-cell">Deliveries</TableHead>
                <TableHead className="hidden lg:table-cell">Last delivery</TableHead>
                <TableHead className="hidden text-right lg:table-cell">Total bought</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.suppliers.map((s) => (
                <TableRow key={s.supplier_id} className="cursor-pointer" onClick={() => setOpenId(s.supplier_id)}>
                  <TableCell className="whitespace-normal">
                    <button type="button" className="font-medium text-primary underline-offset-4 hover:underline" onClick={() => setOpenId(s.supplier_id)}>
                      {s.supplier_name}
                    </button>
                    {s.archived_at && (
                      <Badge variant="outline" className={cn('ml-2', TONE_CLASSES.muted.badge)}>
                        Archived
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="hidden whitespace-normal md:table-cell">
                    {[s.contact_person, s.contact_number].filter(Boolean).join(' · ') || '—'}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{s.item_count ?? '—'}</TableCell>
                  <TableCell className="hidden text-right tabular-nums sm:table-cell">{s.delivery_count ?? '—'}</TableCell>
                  <TableCell className="hidden lg:table-cell">{s.last_delivery_at ? formatDateTime(s.last_delivery_at, { utc: true, withTime: false }) : '—'}</TableCell>
                  <TableCell className="hidden text-right tabular-nums lg:table-cell">{s.total_purchased === null || s.total_purchased === undefined ? '—' : peso(s.total_purchased)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}

      <SupplierProfileSheet
        supplierId={openId}
        tick={tick}
        onClose={() => setOpenId(null)}
        onEdit={(s) => setEditing(s)}
        onChanged={(r) => {
          setResult(r);
          reload();
        }}
      />
      {editing && (
        <SupplierFormDialog
          supplier={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(_, message) => {
            setEditing(null);
            setResult({ type: 'success', title: 'Supplier saved', message });
            reload();
          }}
        />
      )}
      <ResultDialog result={result} onClose={() => setResult(null)} />
    </div>
  );
}

function SupplierProfileSheet({
  supplierId,
  tick,
  onClose,
  onEdit,
  onChanged,
}: {
  supplierId: string | null;
  tick: number;
  onClose: () => void;
  onEdit: (s: Supplier) => void;
  onChanged: (r: ResultMessage) => void;
}) {
  const api = useApi();
  const [profile, setProfile] = useState<SupplierProfile | null>(null);
  const [problem, setProblem] = useState('');
  const [confirm, setConfirm] = useState<'archive' | 'restore' | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!supplierId) return undefined;
    let cancelled = false;
    api<SupplierProfile>('GET', `/suppliers/${encodeURIComponent(supplierId)}`).then(({ ok, data }) => {
      if (cancelled) return;
      if (ok) {
        setProfile(data);
        setProblem('');
      } else {
        setProfile(null);
        setProblem(errorMessage(data, 'This supplier could not be loaded.'));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [api, supplierId, tick]);

  const shown = profile && profile.supplier.supplier_id === supplierId ? profile : null;
  const s = shown?.supplier;
  const act = async (kind: 'archive' | 'restore') => {
    if (!s) return;
    setBusy(true);
    const { ok, data } = await api<{ message?: string }>('POST', `/suppliers/${encodeURIComponent(s.supplier_id)}/${kind}`);
    setBusy(false);
    setConfirm(null);
    onChanged(ok ? { type: 'success', title: kind === 'archive' ? 'Supplier archived' : 'Supplier restored', message: data.message ?? '' }
      : { type: 'error', title: 'Nothing changed', message: errorMessage(data, 'Nothing was changed.') });
  };

  return (
    <Sheet open={Boolean(supplierId)} onOpenChange={(next) => !next && onClose()}>
      <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-2xl">
        <SheetHeader className="border-b pr-12">
          <SheetTitle>{s?.supplier_name ?? 'Supplier'}</SheetTitle>
          <SheetDescription>{s?.archived_at ? 'Archived: kept for the records.' : 'Supplier profile'}</SheetDescription>
          {shown && (
            <div className="flex flex-wrap gap-2 pt-1">
              {shown.allowed_actions.record_stock_in && (
                <Button size="sm" asChild>
                  <Link href={`/inventory/stock-in?new=1&supplier=${encodeURIComponent(shown.supplier.supplier_id)}`}>
                    <ArrowDownToLine aria-hidden /> Record stock in
                  </Link>
                </Button>
              )}
              {shown.allowed_actions.edit && (
                <Button size="sm" variant="outline" onClick={() => onEdit(shown.supplier)}>
                  <Pencil aria-hidden /> Edit
                </Button>
              )}
              {shown.allowed_actions.archive && (
                <Button size="sm" variant="outline" onClick={() => setConfirm('archive')}>
                  <Archive aria-hidden /> Archive
                </Button>
              )}
              {shown.allowed_actions.restore && (
                <Button size="sm" variant="outline" onClick={() => setConfirm('restore')}>
                  <ArchiveRestore aria-hidden /> Restore
                </Button>
              )}
            </div>
          )}
        </SheetHeader>
        <div className={cn('min-h-0 flex-1 space-y-5 overflow-y-auto p-4', SHEET_SCROLL_BODY)}>
          <LoadProblem message={problem} />
          {!shown && !problem && <Skeleton className="h-64 w-full" />}
          {shown && s && (
            <>
              <ul className="grid gap-2 text-sm sm:grid-cols-2">
                <ContactLine icon={UserRound} value={s.contact_person} />
                <ContactLine icon={Phone} value={s.contact_number} />
                <ContactLine icon={Mail} value={s.email} />
                <ContactLine icon={MapPin} value={s.address} />
              </ul>
              {s.notes && <p className="rounded-md border bg-muted/30 p-3 text-sm whitespace-pre-wrap">{s.notes}</p>}
              <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                <Stat label="Deliveries" value={String(shown.totals.delivery_count)} />
                <Stat label="Total bought" value={peso(shown.totals.total_purchased)} />
                <Stat label="Last delivery" value={shown.totals.last_delivery_at ? formatDateTime(shown.totals.last_delivery_at, { utc: true, withTime: false }) : '—'} />
                <Stat label="Stock outs" value={String(shown.totals.returns)} />
              </dl>
              <section className="space-y-2">
                <h3 className="font-semibold">Items they supply ({shown.items.length})</h3>
                {shown.items.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No catalog item names this supplier yet. Choose it in an item’s details, or record a stock in.</p>
                ) : (
                  <ul className="divide-y rounded-md border text-sm">
                    {shown.items.map((i) => {
                      const look = lookFor(STOCK_STATUS, i.stock_status);
                      return (
                        <li key={i.inventory_id} className="flex flex-wrap items-center justify-between gap-2 p-2">
                          <span className="min-w-0 wrap-anywhere">{i.item_name}</span>
                          <span className="flex items-center gap-2 text-xs">
                            <span className="tabular-nums">{i.quantity_available_net.toLocaleString()} free</span>
                            <Badge variant="outline" className={TONE_CLASSES[look.tone].badge}>{STOCK_STATUS[i.stock_status]?.label ?? i.stock_status}</Badge>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
              <section className="space-y-2">
                <h3 className="font-semibold">Deliveries and returns</h3>
                {shown.deliveries.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Nothing recorded yet.</p>
                ) : (
                  <div className="max-w-full min-w-0 overflow-x-auto rounded-md border">
                    <Table>
                      <TableHeader className="bg-muted/50">
                        <TableRow>
                          <TableHead>Number</TableHead>
                          <TableHead>Date</TableHead>
                          <TableHead className="hidden sm:table-cell">Items</TableHead>
                          <TableHead className="text-right">Total</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {shown.deliveries.map((d) => (
                          <TableRow key={d.document_id}>
                            <TableCell className="font-mono text-xs">
                              {d.document_no}
                              {d.voided_at && <Badge variant="outline" className={cn('ml-1', TONE_CLASSES.danger.badge)}>Voided</Badge>}
                            </TableCell>
                            <TableCell className="whitespace-nowrap">{formatDateTime(d.occurred_at, { utc: true, withTime: false })}</TableCell>
                            <TableCell className="hidden max-w-60 whitespace-normal wrap-anywhere sm:table-cell">{d.item_names}</TableCell>
                            <TableCell className="text-right tabular-nums">{peso(d.total_cost)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </SheetContent>
      <ConfirmDialog
        open={Boolean(confirm)}
        title={confirm === 'restore' ? 'Restore this supplier?' : 'Archive this supplier?'}
        message={confirm === 'restore'
          ? 'The supplier comes back to the lists and can be chosen again.'
          : 'The supplier is hidden from the lists and cannot be chosen for new stock ins. Its deliveries are kept.'}
        confirmLabel={confirm === 'restore' ? 'Restore' : 'Archive'}
        busy={busy}
        onConfirm={() => confirm && void act(confirm)}
        onCancel={() => setConfirm(null)}
      />
    </Sheet>
  );
}

function ContactLine({ icon: Icon, value }: { icon: typeof Phone; value: string | null }) {
  return (
    <li className="flex min-w-0 items-start gap-2">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className={cn('min-w-0 whitespace-pre-wrap wrap-anywhere', !value && 'text-muted-foreground')}>{value || 'Not given'}</span>
    </li>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-card p-2">
      <dt className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  );
}
