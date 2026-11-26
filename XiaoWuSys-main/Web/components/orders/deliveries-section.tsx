'use client';

// Deliveries / pick-ups in batches (migration 015). The server decides how many pieces are left
// (fulfillment, allowed_actions.max_delivery), refuses more than that, and keeps the batch
// numbers. "Completed" needs every piece handed over once batches are recorded; with no batch,
// completing the order records the single hand-over itself.
//
// Migration 016 (adviser consultation, second round): batches can be PLANNED ahead, with how many
// pieces go in each and when (POST / PATCH / DELETE /api/orders/:id/delivery-plans). Each batch
// shows whether it can be delivered (In production → Ready → Partly delivered → Delivered), is
// marked ready when its pieces are done, and its hand-overs (date and time) can be corrected
// before the order is completed. With batches planned, every hand-over names its batch and the
// order is completed only when every batch is delivered. The server decides all of it
// (detail.delivery_plans, allowed_actions.plan_deliveries).
import { useState } from 'react';
import { CalendarClock, CircleCheck, ListPlus, PackageCheck, Pencil, Trash2, Truck, Undo2 } from 'lucide-react';
import { formatDateTime } from '@xiaowu/client-core/format';
import type { OrderActions } from '@xiaowu/client-core/permissions';
import { ConfirmDialog } from '@/components/feedback/confirm-dialog';
import type { ResultMessage } from '@/components/feedback/result-dialog';
import { DateInput, DateTimeInput } from '@/components/forms/date-input';
import { bannerText, Field, fieldErrorsMap, FormProblem } from '@/components/forms/form-bits';
import { ORDER_SECTION } from '@/components/orders/jump-to-section';
import { DeliveryStatusBadge } from '@/components/orders/status-badges';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useApi } from '@/hooks/use-api';
import { useOrderOptions } from '@/hooks/use-order-options';
import type { Delivery, DeliveryPlan, OrderDetail } from '@/lib/orders';
import { nowForInput, utcToInput } from '@/lib/stock';
import { TONE_CLASSES } from '@/lib/ui-tokens';
import { cn } from '@/lib/utils';

type OnResult = (result: ResultMessage, reload: boolean) => void;

interface HandoverForm {
  editing: Delivery | null;
  plan_id: string;
  quantity: string;
  delivered_at: string;
  method: string;
  received_by_name: string;
  notes: string;
}
interface PlanForm {
  editing: DeliveryPlan | null;
  planned_quantity: string;
  planned_date: string;
  notes: string;
}

export function DeliveriesSection({ detail, actions, onResult }: { detail: OrderDetail; actions: OrderActions; onResult: OnResult }) {
  const api = useApi();
  const options = useOrderOptions();
  const methods = options?.delivery_methods ?? ['Pick-up', 'Delivery', 'Courier'];
  const deliveries = detail.deliveries ?? [];
  const plans = detail.delivery_plans ?? detail.fulfillment?.plans ?? [];
  const f = detail.fulfillment;
  const closed = ['Completed', 'Cancelled'].includes(detail.order.production_status);
  const unplanned = f?.pieces_unplanned ?? Math.max(0, (f?.pieces_ordered ?? 0) - plans.reduce((s, p) => s + p.planned_quantity, 0));
  const [form, setForm] = useState<HandoverForm | null>(null);
  const [planForm, setPlanForm] = useState<PlanForm | null>(null);
  const [removing, setRemoving] = useState<Delivery | null>(null);
  const [removingPlan, setRemovingPlan] = useState<DeliveryPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const base = `/orders/${encodeURIComponent(detail.order.order_id)}`;

  // ---------- hand-overs ----------
  const open = (editing: Delivery | null, plan: DeliveryPlan | null = null) => {
    setProblem('');
    setErrors({});
    setPlanForm(null);
    setForm({
      editing,
      plan_id: editing?.plan_id ?? plan?.plan_id ?? '',
      quantity: editing ? String(editing.quantity) : String(plan ? Math.min(plan.remaining, actions.max_delivery || plan.remaining) : actions.max_delivery || ''),
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
    if (plans.length > 0 && !form.plan_id) {
      setProblem('Choose which planned batch these pieces belong to.');
      return;
    }
    const body = {
      quantity,
      delivered_at: form.delivered_at,
      method: form.method,
      received_by_name: form.received_by_name.trim() || null,
      notes: form.notes.trim() || null,
      ...(plans.length > 0 ? { plan_id: form.plan_id } : {}),
    };
    setBusy(true);
    const path = `${base}/deliveries`;
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
    onResult({ type: 'success', title: form.editing ? 'Hand-over corrected' : 'Hand-over recorded', message: data.message ?? 'Saved.' }, true);
  };

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    const { ok, data } = await api<{ message?: string }>('DELETE', `${base}/deliveries/${encodeURIComponent(removing.delivery_id)}`);
    setBusy(false);
    setRemoving(null);
    onResult(ok ? { type: 'success', title: 'Hand-over removed', message: data.message ?? 'Removed.' }
      : { type: 'error', title: 'Not removed', message: bannerText(data, [], 'Nothing was changed.') }, true);
  };

  // ---------- planned batches ----------
  const openPlan = (editing: DeliveryPlan | null) => {
    setProblem('');
    setErrors({});
    setForm(null);
    setPlanForm({
      editing,
      planned_quantity: editing ? String(editing.planned_quantity) : unplanned > 0 ? String(unplanned) : '',
      planned_date: editing?.planned_date ?? '',
      notes: editing?.notes ?? '',
    });
  };

  const savePlan = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!planForm) return;
    setProblem('');
    setErrors({});
    const planned_quantity = Number(planForm.planned_quantity.trim());
    if (!planForm.planned_quantity.trim() || Number.isNaN(planned_quantity)) {
      setProblem('Enter how many pieces go in this batch.');
      return;
    }
    const body = { planned_quantity, planned_date: planForm.planned_date || null, notes: planForm.notes.trim() || null };
    setBusy(true);
    const { ok, data } = planForm.editing
      ? await api<{ message?: string }>('PATCH', `${base}/delivery-plans/${encodeURIComponent(planForm.editing.plan_id)}`, body)
      : await api<{ message?: string }>('POST', `${base}/delivery-plans`, body);
    setBusy(false);
    if (!ok) {
      setErrors(fieldErrorsMap(data));
      setProblem(bannerText(data, Object.keys(body), 'Nothing was saved.'));
      return;
    }
    setPlanForm(null);
    onResult({ type: 'success', title: planForm.editing ? 'Batch updated' : 'Batch planned', message: data.message ?? 'Saved.' }, true);
  };

  const setReady = async (plan: DeliveryPlan, ready: boolean) => {
    setBusy(true);
    const { ok, data } = await api<{ message?: string }>('PATCH', `${base}/delivery-plans/${encodeURIComponent(plan.plan_id)}`, { ready });
    setBusy(false);
    onResult(
      ok
        ? { type: 'success', title: ready ? `Batch #${plan.batch_no} is ready` : `Batch #${plan.batch_no} is back in production`, message: data.message ?? 'Saved.' }
        : { type: 'error', title: 'Nothing changed', message: bannerText(data, [], 'The batch was not changed.') },
      true
    );
  };

  const removePlan = async () => {
    if (!removingPlan) return;
    setBusy(true);
    const { ok, data } = await api<{ message?: string }>('DELETE', `${base}/delivery-plans/${encodeURIComponent(removingPlan.plan_id)}`);
    setBusy(false);
    setRemovingPlan(null);
    onResult(ok ? { type: 'success', title: 'Batch removed', message: data.message ?? 'Removed.' }
      : { type: 'error', title: 'Not removed', message: bannerText(data, [], 'Nothing was changed.') }, true);
  };

  const deliverable = plans.filter((p) => p.can_deliver || p.plan_id === form?.plan_id);
  const canHandOver = actions.record_delivery && (plans.length === 0 || plans.some((p) => p.can_deliver));

  return (
    <section id={ORDER_SECTION.deliveries} className="scroll-mt-4 space-y-4" aria-labelledby="deliveries-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="deliveries-title" className="flex items-center gap-2 font-semibold">
          <Truck className="size-4 text-muted-foreground" aria-hidden /> Deliveries and pick-ups
        </h3>
        <div className="flex flex-wrap gap-2">
          {actions.plan_deliveries && !planForm && unplanned > 0 && (
            <Button size="sm" variant="outline" onClick={() => openPlan(null)}>
              <ListPlus aria-hidden /> Plan a batch
            </Button>
          )}
          {canHandOver && !form && plans.length === 0 && (
            <Button size="sm" onClick={() => open(null)}>
              <PackageCheck aria-hidden /> Record a hand-over
            </Button>
          )}
        </div>
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

      {/* ---------- Planned batches ---------- */}
      <div className="space-y-2">
        <h4 className="flex items-center gap-2 text-sm font-semibold">
          <CalendarClock className="size-4 text-muted-foreground" aria-hidden /> Planned batches
        </h4>
        {plans.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {closed
              ? 'No batches were planned.'
              : 'No batches planned. To deliver in parts, plan each batch (how many pieces, and when), then mark it ready when its pieces are done.'}
          </p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              {(f?.pieces_planned ?? 0).toLocaleString()} of {(f?.pieces_ordered ?? 0).toLocaleString()} pieces are in a batch
              {unplanned > 0 ? ` · ${unplanned.toLocaleString()} not planned yet` : ''}. A batch is handed over once it is marked ready;
              the order is completed when every batch is delivered.
            </p>
            <div className="max-w-full min-w-0 overflow-x-auto rounded-md border">
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead>Batch</TableHead>
                    <TableHead className="text-right">Pieces</TableHead>
                    <TableHead>Planned for</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Handed over</TableHead>
                    {!closed && <TableHead><span className="sr-only">Actions</span></TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {plans.map((p) => (
                    <TableRow key={p.plan_id}>
                      <TableCell className="tabular-nums">
                        #{p.batch_no}
                        {p.notes && <span className="block max-w-48 text-xs whitespace-normal text-muted-foreground wrap-anywhere">{p.notes}</span>}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{p.planned_quantity.toLocaleString()}</TableCell>
                      <TableCell className="whitespace-nowrap">
                        {p.planned_date ? formatDateTime(p.planned_date, { withTime: false }) : <span className="text-muted-foreground">No date</span>}
                        {p.overdue && (
                          <Badge variant="outline" className={cn('ml-1', TONE_CLASSES.danger.badge)}>
                            Overdue
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-normal">
                        <DeliveryStatusBadge status={p.state} />
                        {p.ready_at && p.state === 'Ready' && (
                          <span className="block text-xs text-muted-foreground">
                            since {formatDateTime(p.ready_at, { utc: true })}
                            {p.ready_by_name ? ` · ${p.ready_by_name}` : ''}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {p.delivered.toLocaleString()}
                        {p.state === 'Partly delivered' && <span className="block text-xs text-muted-foreground">{p.remaining} left</span>}
                      </TableCell>
                      {!closed && (
                        <TableCell className="text-right whitespace-nowrap">
                          {actions.record_delivery && p.can_deliver && (
                            <Button size="sm" onClick={() => open(null, p)} disabled={busy}>
                              <PackageCheck aria-hidden /> Hand over
                            </Button>
                          )}
                          {actions.plan_deliveries && p.state === 'In production' && (
                            <Button size="sm" variant="outline" onClick={() => void setReady(p, true)} disabled={busy || !actions.record_delivery}
                              title={actions.record_delivery ? 'The pieces of this batch are done' : 'A batch can be marked ready once the job order is approved'}>
                              <CircleCheck aria-hidden /> Mark ready
                            </Button>
                          )}
                          {actions.plan_deliveries && p.state === 'Ready' && (
                            <Button size="icon-sm" variant="ghost" onClick={() => void setReady(p, false)} disabled={busy} aria-label={`Batch ${p.batch_no} is not ready after all`} title="Not ready after all">
                              <Undo2 aria-hidden />
                            </Button>
                          )}
                          {actions.plan_deliveries && (
                            <Button size="icon-sm" variant="ghost" onClick={() => openPlan(p)} disabled={busy} aria-label={`Change batch ${p.batch_no}`} title="Change pieces, date or note">
                              <Pencil aria-hidden />
                            </Button>
                          )}
                          {actions.plan_deliveries && p.delivered === 0 && (
                            <Button size="icon-sm" variant="ghost" onClick={() => setRemovingPlan(p)} disabled={busy} aria-label={`Remove batch ${p.batch_no}`} title="Remove">
                              <Trash2 aria-hidden />
                            </Button>
                          )}
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        )}
        {planForm && (
          <form onSubmit={savePlan} className="space-y-3 rounded-md border bg-muted/30 p-3">
            <FormProblem message={problem} />
            <div className="grid gap-3 sm:grid-cols-4">
              <Field id="plan-qty" label="Pieces in this batch *" error={errors.planned_quantity}
                hint={planForm.editing ? undefined : `${unplanned.toLocaleString()} not in a batch yet`}>
                <Input id="plan-qty" type="number" min={1} step={1} inputMode="numeric" value={planForm.planned_quantity}
                  onChange={(e) => setPlanForm({ ...planForm, planned_quantity: e.target.value })} />
              </Field>
              <Field id="plan-date" label="Deliver / pick up on" error={errors.planned_date}>
                <DateInput id="plan-date" value={planForm.planned_date} onChange={(e) => setPlanForm({ ...planForm, planned_date: e.target.value })} />
              </Field>
              <Field id="plan-notes" label="Note" error={errors.notes} className="sm:col-span-2">
                <Input id="plan-notes" maxLength={500} placeholder="e.g. Grade 7 sections first" value={planForm.notes}
                  onChange={(e) => setPlanForm({ ...planForm, notes: e.target.value })} />
              </Field>
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setPlanForm(null)} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" size="sm" busy={busy} disabled={busy}>
                {busy ? 'Saving…' : planForm.editing ? 'Save batch' : 'Plan batch'}
              </Button>
            </div>
          </form>
        )}
      </div>

      {/* ---------- Hand-overs (what was really delivered / picked up) ---------- */}
      <div className="space-y-2">
        <h4 className="flex items-center gap-2 text-sm font-semibold">
          <PackageCheck className="size-4 text-muted-foreground" aria-hidden /> Hand-overs
        </h4>
        {deliveries.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {closed
              ? 'No hand-over was recorded.'
              : plans.length > 0
                ? 'Nothing handed over yet. Use “Hand over” on a batch once it is ready.'
                : 'Nothing handed over yet. For a single pick-up you can simply mark the order completed: the hand-over of every piece is recorded then.'}
          </p>
        ) : (
          <div className="max-w-full min-w-0 overflow-x-auto rounded-md border">
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead>#</TableHead>
                  {plans.length > 0 && <TableHead>Batch</TableHead>}
                  <TableHead>When</TableHead>
                  <TableHead className="text-right">Pieces</TableHead>
                  <TableHead className="hidden sm:table-cell">How</TableHead>
                  <TableHead className="hidden md:table-cell">Received by</TableHead>
                  {!closed && <TableHead><span className="sr-only">Actions</span></TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {deliveries.map((d) => (
                  <TableRow key={d.delivery_id}>
                    <TableCell className="tabular-nums">{d.batch_no}</TableCell>
                    {plans.length > 0 && <TableCell className="tabular-nums">{d.plan_batch_no ? `#${d.plan_batch_no}` : '—'}</TableCell>}
                    <TableCell className="whitespace-nowrap">
                      {formatDateTime(d.delivered_at, { utc: true })}
                      {d.notes && <span className="block max-w-56 text-xs whitespace-normal text-muted-foreground wrap-anywhere">{d.notes}</span>}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{d.quantity.toLocaleString()}</TableCell>
                    <TableCell className="hidden sm:table-cell">{d.method}</TableCell>
                    <TableCell className="hidden md:table-cell">{d.received_by_name || '—'}</TableCell>
                    {!closed && (
                      <TableCell className="text-right whitespace-nowrap">
                        {actions.record_delivery !== undefined && (
                          <>
                            <Button variant="ghost" size="icon-sm" onClick={() => open(d)} aria-label={`Correct hand-over ${d.batch_no}`} title="Correct the date, pieces or details">
                              <Pencil aria-hidden />
                            </Button>
                            <Button variant="ghost" size="icon-sm" onClick={() => setRemoving(d)} aria-label={`Remove hand-over ${d.batch_no}`} title="Remove">
                              <Trash2 aria-hidden />
                            </Button>
                          </>
                        )}
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
              {plans.length > 0 && (
                <Field id="dl-plan" label="Batch *" error={errors.plan_id}>
                  <Select value={form.plan_id} onValueChange={(v) => setForm({ ...form, plan_id: v })}>
                    <SelectTrigger id="dl-plan" className="w-full">
                      <SelectValue placeholder="Choose the batch…" />
                    </SelectTrigger>
                    <SelectContent>
                      {deliverable.map((p) => (
                        <SelectItem key={p.plan_id} value={p.plan_id}>
                          #{p.batch_no} · {p.remaining} left
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              )}
              <Field id="dl-qty" label="Pieces *" error={errors.quantity} hint={form.editing ? undefined : `${actions.max_delivery} left in the order`}>
                <Input id="dl-qty" type="number" min={1} step={1} inputMode="numeric" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} />
              </Field>
              <Field id="dl-when" label="When *" error={errors.delivered_at} className="sm:col-span-2">
                <DateTimeInput id="dl-when" max={nowForInput()} value={form.delivered_at} onChange={(e) => setForm({ ...form, delivered_at: e.target.value })} />
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
              <Field id="dl-notes" label="Notes" error={errors.notes} className={plans.length > 0 ? 'sm:col-span-1' : 'sm:col-span-2'}>
                <Input id="dl-notes" maxLength={500} placeholder="e.g. courier tracking number" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
              </Field>
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setForm(null)} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" size="sm" busy={busy} disabled={busy}>
                {busy ? 'Saving…' : form.editing ? 'Save' : 'Record hand-over'}
              </Button>
            </div>
          </form>
        )}
      </div>

      {f && f.state === 'complete' && !closed && (
        <p className={cn('rounded-md border p-2 text-sm', TONE_CLASSES.success.banner)}>Every piece is handed over.</p>
      )}
      <ConfirmDialog
        open={Boolean(removing)}
        title="Remove this hand-over?"
        message={removing ? `Hand-over ${removing.batch_no} (${removing.quantity} pieces) will be removed. A record of the removal is kept.` : ''}
        confirmLabel="Remove hand-over"
        danger
        busy={busy}
        onConfirm={() => void remove()}
        onCancel={() => setRemoving(null)}
      />
      <ConfirmDialog
        open={Boolean(removingPlan)}
        title="Remove this planned batch?"
        message={removingPlan ? `Batch #${removingPlan.batch_no} (${removingPlan.planned_quantity} pieces) will be removed from the plan.` : ''}
        confirmLabel="Remove batch"
        danger
        busy={busy}
        onConfirm={() => void removePlan()}
        onCancel={() => setRemovingPlan(null)}
      />
    </section>
  );
}
