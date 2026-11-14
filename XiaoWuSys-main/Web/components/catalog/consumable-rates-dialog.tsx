'use client';

// PB 15: the usage rates of one catalog item ("blank"): how much of each consumable (ink,
// transfer paper, thread…) one piece uses, and at which step it is taken from stock.
//   GET /api/inventory/:id/consumable-rates   -> { product, rates, consumable_options, triggers, can_edit }
//   PUT /api/inventory/:id/consumable-rates   { rates: [{ consumable_inventory_id, quantity_per_piece, trigger_status }] }
// Rule split (steering §3.1): this screen collects the list and checks that amounts are numbers.
// The server checks everything else (above 0, 3 decimals, no duplicates, items still in the
// catalog), does the deduction maths when an order moves on, and needs the cloud to save.
import { useEffect, useState } from 'react';
import { FlaskConical, Plus, Trash2 } from 'lucide-react';
import { Field, FormProblem } from '@/components/forms/form-bits';
import { BoundedSelectContent, BoundedSelectItem, BoundedSelectTrigger } from '@/components/forms/bounded-select';
import type { ResultMessage } from '@/components/feedback/result-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/hooks/use-api';
import { errorMessage } from '@/lib/api';
import { toNumberInput, TRIGGER_LABEL, type ConsumableRatesView, type InventoryItem } from '@/lib/inventory';

interface Row {
  key: number;
  consumable_inventory_id: string;
  quantity: string;
  trigger_status: string;
}

let nextKey = 1;
const blankRow = (trigger: string): Row => ({ key: nextKey++, consumable_inventory_id: '', quantity: '', trigger_status: trigger });

export function ConsumableRatesDialog({
  item,
  onClose,
  onDone,
}: {
  item: InventoryItem;
  onClose: () => void;
  onDone: (result: ResultMessage) => void;
}) {
  const api = useApi();
  const [view, setView] = useState<ConsumableRatesView | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [loadError, setLoadError] = useState('');
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api<ConsumableRatesView>('GET', `/inventory/${encodeURIComponent(item.inventory_id)}/consumable-rates`).then(({ ok, data }) => {
      if (cancelled) return;
      if (!ok) {
        setLoadError(errorMessage(data, 'Could not load the usage rates.'));
        return;
      }
      setView(data);
      setRows(
        data.rates.map((r) => ({
          key: nextKey++,
          consumable_inventory_id: r.consumable_inventory_id,
          quantity: String(r.quantity_per_piece),
          trigger_status: r.trigger_status,
        }))
      );
    });
    return () => {
      cancelled = true;
    };
  }, [api, item.inventory_id]);

  const editable = Boolean(view?.can_edit);
  const firstTrigger = view?.triggers[0] ?? 'Pressing';
  const change = (key: number, patch: Partial<Row>) => setRows((list) => list.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  // A consumable that has left the catalog is still listed so the row can be read and removed
  const nameOf = (id: string) =>
    view?.consumable_options.find((o) => o.inventory_id === id)?.item_name ??
    view?.rates.find((r) => r.consumable_inventory_id === id)?.consumable_name ??
    'Removed item';
  const unitOf = (id: string) =>
    view?.consumable_options.find((o) => o.inventory_id === id)?.unit ?? view?.rates.find((r) => r.consumable_inventory_id === id)?.consumable_unit ?? '';

  const save = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setProblem('');
    const rates = rows.map((r) => ({
      consumable_inventory_id: r.consumable_inventory_id,
      quantity_per_piece: toNumberInput(r.quantity),
      trigger_status: r.trigger_status,
    }));
    if (rates.some((r) => !r.consumable_inventory_id)) {
      setProblem('Choose a consumable on every row, or remove the empty row.');
      return;
    }
    if (rates.some((r) => r.quantity_per_piece === undefined || Number.isNaN(r.quantity_per_piece))) {
      setProblem('The amount per piece must be a number on every row, like 1 or 0.25.');
      return;
    }
    setBusy(true);
    const { ok, data } = await api<{ message?: string }>('PUT', `/inventory/${encodeURIComponent(item.inventory_id)}/consumable-rates`, { rates });
    setBusy(false);
    if (!ok) {
      setProblem(errorMessage(data, 'Could not save the usage rates.'));
      return;
    }
    onDone({ type: 'success', title: 'Usage rates saved', message: data.message ?? 'The usage rates were saved.' });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FlaskConical className="size-5" aria-hidden />
            Usage rates: <span className="min-w-0 wrap-anywhere">{item.item_name}</span>
          </DialogTitle>
          <DialogDescription>
            How much of each consumable one piece of this item uses. When an order with this item moves on, the system takes it from
            stock by itself. If there is not enough, the stock stops at 0 and the order still moves on.
          </DialogDescription>
        </DialogHeader>

        {loadError && <FormProblem message={loadError} />}
        {!view && !loadError && (
          <div className="space-y-2" role="status" aria-label="Loading">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        )}

        {view && (
          <form onSubmit={save} className="min-w-0 space-y-3">
            {problem && <FormProblem message={problem} />}
            {rows.length === 0 && (
              <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
                This item uses no consumables yet.
              </p>
            )}
            <ul className="max-h-[50vh] space-y-3 overflow-y-auto" aria-label="Usage rates">
              {rows.map((r, i) => (
                <li key={r.key} className="grid min-w-0 gap-2 rounded-md border bg-card p-3 sm:grid-cols-[1fr_8rem]">
                  <Field id={`rate-item-${r.key}`} label={`Consumable ${i + 1}`}>
                    <Select
                      value={r.consumable_inventory_id}
                      onValueChange={(value) => change(r.key, { consumable_inventory_id: value })}
                      disabled={!editable || busy}
                    >
                      <BoundedSelectTrigger id={`rate-item-${r.key}`}>
                        <SelectValue placeholder="Choose a consumable…">{r.consumable_inventory_id ? nameOf(r.consumable_inventory_id) : undefined}</SelectValue>
                      </BoundedSelectTrigger>
                      <BoundedSelectContent>
                        {view.consumable_options.map((o) => (
                          <BoundedSelectItem key={o.inventory_id} value={o.inventory_id} label={o.item_name} suffix={`(${o.item_category})`}>
                            {o.item_name}
                          </BoundedSelectItem>
                        ))}
                      </BoundedSelectContent>
                    </Select>
                  </Field>
                  <Field id={`rate-qty-${r.key}`} label={`Per piece${unitOf(r.consumable_inventory_id) ? ` (${unitOf(r.consumable_inventory_id)})` : ''}`}>
                    <Input
                      id={`rate-qty-${r.key}`}
                      type="number"
                      min={0}
                      step="0.001"
                      inputMode="decimal"
                      placeholder="e.g. 0.25"
                      value={r.quantity}
                      onChange={(e) => change(r.key, { quantity: e.target.value })}
                      disabled={!editable || busy}
                      required
                    />
                  </Field>
                  <div className="flex min-w-0 items-end gap-2 sm:col-span-2">
                    <Field id={`rate-step-${r.key}`} label="Taken from stock" className="flex-1">
                      <Select value={r.trigger_status} onValueChange={(value) => change(r.key, { trigger_status: value })} disabled={!editable || busy}>
                        <SelectTrigger id={`rate-step-${r.key}`} className="w-full max-w-full min-w-0 overflow-hidden">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {view.triggers.map((t) => (
                            <SelectItem key={t} value={t}>
                              {TRIGGER_LABEL[t] ?? t}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                    {editable && (
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        aria-label={`Remove consumable ${i + 1}`}
                        onClick={() => setRows((list) => list.filter((x) => x.key !== r.key))}
                        disabled={busy}
                      >
                        <Trash2 aria-hidden />
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            {editable ? (
              <Button type="button" variant="outline" size="sm" onClick={() => setRows((list) => [...list, blankRow(firstTrigger)])} disabled={busy}>
                <Plus aria-hidden /> Add a consumable
              </Button>
            ) : (
              <p className="text-sm text-muted-foreground">Only accounts that manage the catalog can change these.</p>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
                {editable ? 'Cancel' : 'Close'}
              </Button>
              {editable && (
                <Button type="submit" disabled={busy}>
                  {busy ? 'Saving…' : 'Save usage rates'}
                </Button>
              )}
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
