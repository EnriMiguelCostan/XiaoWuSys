'use client';

// Sections of the order detail sheet (ported from OrdersPage.jsx). Which editors appear comes
// from allowed_actions; each save goes to Express and its message is shown as is.
import { useState } from 'react';
import { Link2, Pencil, Shirt, ShieldCheck } from 'lucide-react';
import { formatDateTime, peso, todayInManila } from '@xiaowu/client-core/format';
import { hasOrderNumber, NUMBER_AFTER_SYNC, shortfallLines } from '@xiaowu/client-core/orders';
import type { OrderActions } from '@xiaowu/client-core/permissions';
import { Field, FormProblem } from '@/components/forms/form-bits';
import type { ResultMessage } from '@/components/feedback/result-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useApi } from '@/hooks/use-api';
import { errorMessage } from '@/lib/api';
import { toNumberInput } from '@/lib/inventory';
import type { Customer, OrderDetail } from '@/lib/orders';
import { TONE_CLASSES } from '@/lib/ui-tokens';
import { cn } from '@/lib/utils';
import { MONEY_INPUT_MAX, TEXT_MAX, WHOLE_NUMBER_MAX } from '@/lib/input-limits';

type OnResult = (result: ResultMessage, reload: boolean) => void;

const orderPath = (detail: OrderDetail, suffix: string) => `/orders/${encodeURIComponent(detail.order.order_id)}/${suffix}`;
const versionOf = (detail: OrderDetail) => detail.order.version || undefined;
const dateOnly = (value: string) => String(value).slice(0, 10);

// ---------------------------------------------------------------------------------------------
function Info({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-md border bg-card p-3">
      <dt className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{label}</dt>
      <dd className="mt-0.5 font-medium wrap-anywhere">{value}</dd>
      {sub && <dd className="text-xs text-muted-foreground wrap-anywhere">{sub}</dd>}
    </div>
  );
}

export function OrderInfo({ detail, customer }: { detail: OrderDetail; customer: Customer | undefined }) {
  const { order, totals } = detail;
  return (
    <div className="space-y-2">
      <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Info label="Customer" value={customer?.full_name || 'Unknown customer'} sub={customer?.contact_number} />
        <Info
          label="Stock"
          value={order.stock_reserved ? 'Reserved' : 'Not reserved'}
          sub={order.stock_reserved ? 'Materials are held for this order' : 'Reserved on approval / resume'}
        />
        <Info label="Created" value={formatDateTime(order.date_created, { utc: true })} />
        <Info label="Deadline" value={formatDateTime(order.production_deadline, { withTime: false })} />
        <Info label="Quote" value={<span className="tabular-nums">{peso(order.total_quote_amount)}</span>} />
        <Info
          label="Paid / Balance"
          value={
            <span className="tabular-nums">
              {peso(totals.total_paid)} / {peso(totals.remaining)}
            </span>
          }
          sub={totals.payment_status ? `Payment: ${totals.payment_status}` : undefined}
        />
        {order.approved_at && <Info label="Approved" value={formatDateTime(order.approved_at, { utc: true })} sub="by the Owner" />}
      </dl>
      <p className="text-xs text-muted-foreground wrap-anywhere">
        {hasOrderNumber(order) ? (
          <>
            Order number <strong className="text-foreground">{order.tracking_no}</strong>.{' '}
          </>
        ) : (
          `${NUMBER_AFTER_SYNC} `
        )}
        Internal ID: <code className="font-mono">{order.order_id}</code>
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Deadline (edit_deadline) and quote (edit_quote: Owner, before approval)
export function DetailsEditor({ detail, actions, onResult }: { detail: OrderDetail; actions: OrderActions; onResult: OnResult }) {
  const api = useApi();
  const [form, setForm] = useState<{ deadline: string; quote: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  if (!actions.edit_deadline && !actions.edit_quote) return null;

  const { order } = detail;
  const today = todayInManila();

  if (!form) {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          setProblem('');
          const current = dateOnly(order.production_deadline);
          setForm({ deadline: current < today ? today : current, quote: String(order.total_quote_amount ?? 0) });
        }}
      >
        <Pencil aria-hidden /> {actions.edit_quote ? 'Edit deadline or quote' : 'Edit deadline'}
      </Button>
    );
  }

  const save = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setProblem('');
    const body: Record<string, unknown> = {};
    if (actions.edit_deadline && form.deadline && form.deadline !== dateOnly(order.production_deadline)) body.production_deadline = form.deadline;
    if (actions.edit_quote && form.quote.trim() !== String(order.total_quote_amount ?? 0)) {
      const quote = toNumberInput(form.quote) ?? 0;
      if (Number.isNaN(quote)) {
        setProblem('The quote must be a peso amount, like 1500 or 1500.50.');
        return;
      }
      body.total_quote_amount = quote;
    }
    if (Object.keys(body).length === 0) {
      setForm(null);
      onResult({ type: 'warning', title: 'No changes', message: 'Nothing was changed, so nothing was saved.' }, false);
      return;
    }
    setBusy(true);
    const { ok, data } = await api<{ message?: string }>('PATCH', orderPath(detail, 'details'), { ...body, expected_version: versionOf(detail) });
    setBusy(false);
    if (!ok) {
      setProblem(errorMessage(data, 'The order details were not saved.'));
      return;
    }
    setForm(null);
    onResult({ type: 'success', title: 'Order updated', message: data.message ?? 'The order was updated.' }, true);
  };

  return (
    <form onSubmit={save} className="space-y-3 rounded-md border bg-muted/30 p-3">
      <FormProblem message={problem} />
      <div className="grid gap-3 sm:grid-cols-2">
        {actions.edit_deadline && (
          <Field id="edit-deadline" label="Deadline">
            <Input id="edit-deadline" type="date" min={today} required value={form.deadline} onChange={(e) => setForm({ ...form, deadline: e.target.value })} />
          </Field>
        )}
        {actions.edit_quote && (
          <Field id="edit-price" label="Quote (₱)">
            <Input id="edit-price" type="number" min={0} max={MONEY_INPUT_MAX} step="0.01" inputMode="decimal" value={form.quote} onChange={(e) => setForm({ ...form, quote: e.target.value })} />
          </Field>
        )}
      </div>
      {!actions.edit_quote && <p className="text-xs text-muted-foreground">Only the Owner can change the quote, and only before approval.</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => setForm(null)} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------
// Google Drive design link (link_design)
export function DesignLink({ detail, actions, onResult }: { detail: OrderDetail; actions: OrderActions; onResult: OnResult }) {
  const api = useApi();
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const link = detail.order.design_drive_link;

  const save = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (draft === null) return;
    setProblem('');
    setBusy(true);
    const { ok, data } = await api<{ message?: string }>('PATCH', orderPath(detail, 'design'), {
      design_drive_link: draft.trim(),
      expected_version: versionOf(detail),
    });
    setBusy(false);
    if (!ok) {
      setProblem(errorMessage(data, 'The design link was not saved.'));
      return;
    }
    setDraft(null);
    onResult({ type: 'success', title: 'Design linked', message: data.message ?? 'The design file was linked.' }, true);
  };

  if (draft !== null) {
    return (
      <form onSubmit={save} className="space-y-2">
        <FormProblem message={problem} />
        <div className="flex flex-wrap gap-2">
          <Input
            type="url"
            maxLength={TEXT_MAX.designLink}
            required
            autoFocus
            aria-label="Design file link"
            placeholder="https://drive.google.com/…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="min-w-0 flex-[1_1_16rem]"
          />
          <Button type="button" variant="outline" size="sm" onClick={() => setDraft(null)} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={busy}>
            {busy ? 'Saving…' : 'Save link'}
          </Button>
        </div>
      </form>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <Link2 className="size-4 text-muted-foreground" aria-hidden />
      {link ? (
        <a href={link} target="_blank" rel="noopener noreferrer" className="min-w-0 font-medium text-primary underline-offset-4 wrap-anywhere hover:underline">
          Open design file (Google Drive)
        </a>
      ) : (
        <span className="text-muted-foreground">No design file linked yet.</span>
      )}
      {actions.link_design && (
        <Button variant="link" size="sm" className="h-auto p-0" onClick={() => setDraft(link || '')}>
          {link ? 'Change' : 'Link design file'}
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Materials and print details (add_items: size / name / number lines, no stock used)
const EMPTY_PRINT_LINE = { product_type: 'Jersey print', quantity: '1', size: '', custom_name: '', custom_number: '' };

export function MaterialsSection({ detail, actions, onResult }: { detail: OrderDetail; actions: OrderActions; onResult: OnResult }) {
  const api = useApi();
  const { items, totals } = detail;
  const [line, setLine] = useState<typeof EMPTY_PRINT_LINE | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');

  const add = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!line) return;
    setProblem('');
    const quantity = toNumberInput(line.quantity);
    if (quantity === undefined || Number.isNaN(quantity)) {
      setProblem('The quantity must be a number.');
      return;
    }
    setBusy(true);
    const { ok, data } = await api('POST', orderPath(detail, 'items'), {
      product_type: line.product_type.trim(),
      quantity,
      size: line.size.trim() || undefined,
      custom_name: line.custom_name.trim() || undefined,
      custom_number: line.custom_number.trim() || undefined,
    });
    setBusy(false);
    if (!ok) {
      setProblem(errorMessage(data, 'The print detail was not added.'));
      return;
    }
    setLine({ ...EMPTY_PRINT_LINE, product_type: line.product_type }); // ready for the next piece
    onResult({ type: 'success', title: 'Print detail added', message: 'The line was added to this order.' }, true);
  };

  const bind = (key: keyof typeof EMPTY_PRINT_LINE) => ({
    value: line?.[key] ?? '',
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setLine((l) => (l ? { ...l, [key]: e.target.value } : l)),
  });

  return (
    <section className="space-y-3" aria-labelledby="materials-title">
      <h3 id="materials-title" className="font-semibold">
        Materials{' '}
        <span className="font-normal text-muted-foreground">
          ({totals.item_count} line{totals.item_count === 1 ? '' : 's'}, {totals.total_quantity.toLocaleString()} total)
        </span>
      </h3>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No materials on this order.</p>
      ) : (
        <div className="max-w-full min-w-0 overflow-x-auto rounded-md border">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead>Material</TableHead>
                <TableHead>Details</TableHead>
                <TableHead className="text-right">Qty</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((it) => (
                <TableRow key={it.line_item_id}>
                  <TableCell className="min-w-32 whitespace-normal wrap-anywhere">
                    {it.product_type}
                    {!it.inventory_id && (
                      <Badge variant="outline" className={cn('ml-1', TONE_CLASSES.muted.badge)}>
                        not linked to stock
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="min-w-24 whitespace-normal wrap-anywhere">
                    {[it.size, it.custom_name, it.custom_number].filter(Boolean).join(' · ') || '—'}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{it.quantity.toLocaleString()}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {actions.add_items &&
        (line ? (
          <form onSubmit={add} className="space-y-3 rounded-md border bg-muted/30 p-3">
            <FormProblem message={problem} />
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-6">
              <Field id="line-what" label="What" className="col-span-2 sm:col-span-3">
                <Input id="line-what" required maxLength={TEXT_MAX.productType} {...bind('product_type')} />
              </Field>
              <Field id="line-qty" label="Qty">
                <Input id="line-qty" type="number" min={1} max={WHOLE_NUMBER_MAX} step={1} required {...bind('quantity')} />
              </Field>
              <Field id="line-size" label="Size">
                <Input id="line-size" maxLength={TEXT_MAX.shortCode} placeholder="M" {...bind('size')} />
              </Field>
              <Field id="line-number" label="No.">
                <Input id="line-number" maxLength={TEXT_MAX.shortCode} placeholder="7" {...bind('custom_number')} />
              </Field>
              <Field id="line-name" label="Name" className="col-span-2 sm:col-span-6">
                <Input id="line-name" maxLength={TEXT_MAX.default} placeholder="DELA CRUZ" {...bind('custom_name')} />
              </Field>
            </div>
            <p className="text-xs text-muted-foreground">
              Print details (sizes, names, numbers) do not use stock. Add one line per piece, or one line per size with its quantity.
            </p>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setLine(null)} disabled={busy}>
                Done
              </Button>
              <Button type="submit" size="sm" disabled={busy}>
                {busy ? 'Adding…' : 'Add'}
              </Button>
            </div>
          </form>
        ) : (
          <Button variant="outline" size="sm" onClick={() => setLine(EMPTY_PRINT_LINE)}>
            <Shirt aria-hidden /> Add print details (size / name / number)
          </Button>
        ))}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Job order approval (PB 13). Everything shown is a server fact: the downpayment figures and
// "met" (payments.js), the stock check, the sync state. The server re-checks all of it when
// Approve is pressed and answers 402 / 409 / 422 with its own message.
export function approvalNotes(detail: OrderDetail) {
  const { order, items, payments, totals } = detail;
  const dp = totals.downpayment;
  const blocking: string[] = [];
  const notes: string[] = [];
  if (order.sync_status !== 'synced' || detail.source === 'local') {
    blocking.push('Approval needs an internet connection, and the order must be synced to the cloud.');
  }
  if (dp && !dp.required) blocking.push('Set a quote amount for this order first.');
  else if (dp && !dp.met) blocking.push('The downpayment (half of the quote) is not complete yet.');
  const offlinePayments = payments.filter((p) => p.sync_status !== 'synced').length;
  if (offlinePayments) notes.push(`${offlinePayments} payment(s) saved offline do not count until they sync.`);
  if (items.length === 0) blocking.push('Add at least one material to this order.');
  if (detail.stock_check && !detail.stock_check.sufficient) {
    blocking.push(...shortfallLines(detail.stock_check).map((l) => `Not enough stock: ${l}`));
  }
  return { blocking, notes: [...blocking, ...notes] };
}

export function ApprovalPanel({ detail, canApprove }: { detail: OrderDetail; canApprove: boolean }) {
  const dp = detail.totals.downpayment;
  const { notes } = approvalNotes(detail);
  return (
    <section className={cn('space-y-2 rounded-md border p-3', TONE_CLASSES.info.banner)} aria-labelledby="approval-title">
      <h3 id="approval-title" className="flex items-center gap-2 font-semibold">
        <ShieldCheck className="size-4" aria-hidden /> Job order approval
      </h3>
      {dp && dp.required ? (
        <>
          <p className="text-sm text-foreground wrap-anywhere">
            <span className="tabular-nums">{peso(dp.paid_synced)}</span> of <span className="tabular-nums">{peso(dp.required)}</span> required
            downpayment (50%) {dp.met && <strong className="text-success">· complete</strong>}
          </p>
          {/* The browser draws the bar from the server's two figures */}
          <progress
            value={dp.paid_synced}
            max={dp.required}
            aria-label="Downpayment progress"
            className={cn(
              'h-2 w-full overflow-hidden rounded-full [&::-moz-progress-bar]:rounded-full [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:rounded-full',
              dp.met
                ? '[&::-moz-progress-bar]:bg-success [&::-webkit-progress-value]:bg-success'
                : '[&::-moz-progress-bar]:bg-warning [&::-webkit-progress-value]:bg-warning'
            )}
          />
        </>
      ) : (
        <p className="text-sm text-foreground">No quote yet.</p>
      )}
      <p className="text-xs text-foreground/80">
        {detail.order.stock_reserved ? 'Materials are already reserved for this order.' : 'Approving will reserve this order’s materials.'}
      </p>
      {notes.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-foreground/80 wrap-anywhere">
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      {!canApprove && <p className="text-xs text-foreground/80">Waiting for the Owner to approve this job order before printing can start.</p>}
    </section>
  );
}
