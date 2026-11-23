'use client';

// Deliveries / pick-ups in batches (migration 015). The server decides how many pieces are left
// (fulfillment, allowed_actions.max_delivery), refuses more than that, and keeps the batch
// numbers. "Completed" needs every piece handed over once batches are recorded; with no batch,
// completing the order records the single hand-over itself.
import { useState } from 'react';
import { PackageCheck, Pencil, Trash2, Truck } from 'lucide-react';
import { formatDateTime } from '@xiaowu/client-core/format';
import type { OrderActions } from '@xiaowu/client-core/permissions';
import { ConfirmDialog } from '@/components/feedback/confirm-dialog';
import type { ResultMessage } from '@/components/feedback/result-dialog';
import { bannerText, Field, fieldErrorsMap, FormProblem } from '@/components/forms/form-bits';
import { ORDER_SECTION } from '@/components/orders/jump-to-section';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useApi } from '@/hooks/use-api';
import { useOrderOptions } from '@/hooks/use-order-options';
import type { Delivery, OrderDetail } from '@/lib/orders';
import { nowForInput, utcToInput } from '@/lib/stock';
import { TONE_CLASSES } from '@/lib/ui-tokens';
import { cn } from '@/lib/utils';

type OnResult = (result: ResultMessage, reload: boolean) => void;

export function DeliveriesSection({ detail, actions, onResult }: { detail: OrderDetail; actions: OrderActions; onResult: OnResult }) {
  const api = useApi();
  const options = useOrderOptions();
  const methods = options?.delivery_methods ?? ['Pick-up', 'Delivery', 'Courier'];
  const deliveries = detail.deliveries ?? [];
  const f = detail.fulfillment;
  const closed = ['Completed', 'Cancelled'].includes(detail.order.production_status);
  const [form, setForm] = useState<{ editing: Delivery | null; quantity: string; delivered_at: string; method: string; received_by_name: string; notes: string } | null>(null);
  const [removing, setRemoving] = useState<Delivery | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const open = (editing: Delivery | null) => {
    setProblem('');
    setErrors({});
    setForm({
      editing,
      quantity: editing ? String(editing.quantity) : String(actions.max_delivery || ''),
      delivered_at: editing ? utcToInput(editing.delivered_at) : nowForInput(),
      method: editing?.method ?? methods[0],
      received_by_name: editing?.received_by_name ?? '',
      notes: editing?.notes ?? '',
    });
  };

  const save = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!form) return;
    setProblem('');
    setErrors({});
    const quantity = Number(form.quantity.trim());
    if (!form.quantity.trim() || Number.isNaN(quantity)) {
      setProblem('Enter how many pieces were handed over.');
      return;
    }
    const body = {
      quantity,
      delivered_at: form.delivered_at,
      method: form.method,
      received_by_name: form.received_by_name.trim() || null,
      notes: form.notes.trim() || null,
    };
    setBusy(true);
    const path = `/orders/${encodeURIComponent(detail.order.order_id)}/deliveries`;
    const { ok, data } = form.editing
      ? await api<{ message?: string }>('PATCH', `${path}/${encodeURIComponent(form.editing.delivery_id)}`, body)
      : await api<{ message?: string }>('POST', path, body);
    setBusy(false);
    if (!ok) {
      setErrors(fieldErrorsMap(data));
      setProblem(bannerText(data, Object.keys(body), 'Nothing was saved.'));
      return;
    }
    setForm(null);
    onResult({ type: 'success', title: form.editing ? 'Batch corrected' : 'Batch recorded', message: data.message ?? 'Saved.' }, true);
  };

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    const { ok, data } = await api<{ message?: string }>(
      'DELETE',
      `/orders/${encodeURIComponent(detail.order.order_id)}/deliveries/${encodeURIComponent(removing.delivery_id)}`
    );
    setBusy(false);
    setRemoving(null);
    onResult(ok ? { type: 'success', title: 'Batch removed', message: data.message ?? 'Removed.' }
      : { type: 'error', title: 'Not removed', message: bannerText(data, [], 'Nothing was changed.') }, true);
  };

  return (
    <section id={ORDER_SECTION.deliveries} className="scroll-mt-4 space-y-3" aria-labelledby="deliveries-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="deliveries-title" className="flex items-center gap-2 font-semibold">
          <Truck className="size-4 text-muted-foreground" aria-hidden /> Deliveries and pick-ups
        </h3>
        {actions.record_delivery && !form && (
          <Button size="sm" onClick={() => open(null)}>
            <PackageCheck aria-hidden /> Record a batch
          </Button>
        )}
      </div>
      {f && (
        <div className="space-y-1">
          <p className="text-sm">
            <strong className="tabular-nums">{f.pieces_delivered.toLocaleString()}</strong> of{' '}
            <strong className="tabular-nums">{f.pieces_ordered.toLocaleString()}</strong> pieces handed over
            {f.pieces_remaining > 0 && <span className="text-muted-foreground"> · {f.pieces_remaining.toLocaleString()} left</span>}
          </p>
          <progress
            value={f.pieces_delivered}
            max={Math.max(f.pieces_ordered, 1)}
            aria-label="Pieces handed over"
            className="h-2 w-full overflow-hidden rounded-full [&::-moz-progress-bar]:bg-success [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:bg-success"
          />
        </div>
      )}
      {deliveries.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {closed
            ? 'No batches were recorded.'
            : 'No batch recorded yet. For a single pick-up you can simply mark the order completed: the hand-over of every piece is recorded then.'}
        </p>
      ) : (
        <div className="max-w-full min-w-0 overflow-x-auto rounded-md border">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead>Batch</TableHead>
                <TableHead>When</TableHead>
                <TableHead className="text-right">Pieces</TableHead>
                <TableHead className="hidden sm:table-cell">How</TableHead>
                <TableHead className="hidden md:table-cell">Received by</TableHead>
                {!closed && actions.record_delivery !== undefined && <TableHead><span className="sr-only">Actions</span></TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {deliveries.map((d) => (
                <TableRow key={d.delivery_id}>
                  <TableCell className="tabular-nums">#{d.batch_no}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    {formatDateTime(d.delivered_at, { utc: true })}
                    {d.notes && <span className="block max-w-56 text-xs whitespace-normal text-muted-foreground wrap-anywhere">{d.notes}</span>}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{d.quantity.toLocaleString()}</TableCell>
                  <TableCell className="hidden sm:table-cell">{d.method}</TableCell>
                  <TableCell className="hidden md:table-cell">{d.received_by_name || '—'}</TableCell>
                  {!closed && (
                    <TableCell className="text-right whitespace-nowrap">
                      <Button variant="ghost" size="icon-sm" onClick={() => open(d)} aria-label={`Correct batch ${d.batch_no}`} title="Correct">
                        <Pencil aria-hidden />
                      </Button>
                      <Button variant="ghost" size="icon-sm" onClick={() => setRemoving(d)} aria-label={`Remove batch ${d.batch_no}`} title="Remove">
                        <Trash2 aria-hidden />
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {form && (
        <form onSubmit={save} className="space-y-3 rounded-md border bg-muted/30 p-3">
          <FormProblem message={problem} />
          <div className="grid gap-3 sm:grid-cols-4">
            <Field id="dl-qty" label="Pieces *" error={errors.quantity} hint={form.editing ? undefined : `${actions.max_delivery} left`}>
              <Input id="dl-qty" type="number" min={1} step={1} inputMode="numeric" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} />
            </Field>
            <Field id="dl-when" label="When *" error={errors.delivered_at} className="sm:col-span-2">
              <Input id="dl-when" type="datetime-local" max={nowForInput()} value={form.delivered_at} onChange={(e) => setForm({ ...form, delivered_at: e.target.value })} />
            </Field>
            <Field id="dl-how" label="How" error={errors.method}>
              <Select value={form.method} onValueChange={(v) => setForm({ ...form, method: v })}>
                <SelectTrigger id="dl-how" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {methods.map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field id="dl-who" label="Received by" error={errors.received_by_name} className="sm:col-span-2">
              <Input id="dl-who" maxLength={255} placeholder="Who took the pieces" value={form.received_by_name} onChange={(e) => setForm({ ...form, received_by_name: e.target.value })} />
            </Field>
            <Field id="dl-notes" label="Notes" error={errors.notes} className="sm:col-span-2">
              <Input id="dl-notes" maxLength={500} placeholder="e.g. courier tracking number" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setForm(null)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" size="sm" busy={busy} disabled={busy}>
              {busy ? 'Saving…' : form.editing ? 'Save' : 'Record batch'}
            </Button>
          </div>
        </form>
      )}
      {f && f.state === 'complete' && !closed && (
        <p className={cn('rounded-md border p-2 text-sm', TONE_CLASSES.success.banner)}>Every piece is handed over.</p>
      )}
      <ConfirmDialog
        open={Boolean(removing)}
        title="Remove this batch?"
        message={removing ? `Batch #${removing.batch_no} (${removing.quantity} pieces) will be removed. A record of the removal is kept.` : ''}
        confirmLabel="Remove batch"
        danger
        busy={busy}
        onConfirm={() => void remove()}
        onCancel={() => setRemoving(null)}
      />
    </section>
  );
}
