'use client';

// Sections of the order detail sheet (ported from OrdersPage.jsx). Which editors appear comes
// from allowed_actions; each save goes to Express and its message is shown as is.
//
// PB 5: each edit form tells the sheet while it is open (onEditing), so the sheet can hold the
// order's edit lock. When a save answers 409 EDIT_CONFLICT with can_override: true, the server
// has decided this account may replace the other person's change: the form asks first, then
// sends the same body again with override: true.
import { useEffect, useState } from 'react';
import { FileText, History, Link2, ListPlus, Pencil, Shirt, ShieldCheck } from 'lucide-react';
import { formatDateTime, formatMobile, peso, todayInManila } from '@xiaowu/client-core/format';
import { hasOrderNumber, NUMBER_AFTER_SYNC, shortfallLines } from '@xiaowu/client-core/orders';
import type { OrderActions } from '@xiaowu/client-core/permissions';
import { DateInput } from '@/components/forms/date-input';
import { Field, FormProblem } from '@/components/forms/form-bits';
import { ConfirmDialog } from '@/components/feedback/confirm-dialog';
import type { ResultMessage } from '@/components/feedback/result-dialog';
import { JumpToSection, ORDER_SECTION, type OrderSectionKey } from '@/components/orders/jump-to-section';
import { DeadlineBadge, OrderStatusBadge } from '@/components/orders/status-badges';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useInventorySnapshot } from '@/hooks/use-inventory-snapshot';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useApi } from '@/hooks/use-api';
import { errorMessage } from '@/lib/api';
import { toNumberInput } from '@/lib/inventory';
import type { Customer, OrderDetail } from '@/lib/orders';
import { TONE_CLASSES } from '@/lib/ui-tokens';
import { cn } from '@/lib/utils';
import { MONEY_INPUT_MAX, TEXT_MAX } from '@/lib/input-limits';

type OnResult = (result: ResultMessage, reload: boolean) => void;
/** Tells the sheet whether this section's edit form is open (it holds the edit lock meanwhile). */
type OnEditing = (open: boolean) => void;

function useReportEditing(open: boolean, onEditing: OnEditing | undefined) {
  useEffect(() => {
    if (!open || !onEditing) return undefined;
    onEditing(true);
    return () => onEditing(false);
  }, [open, onEditing]);
}

// PB 5: save an edit; if the order was changed meanwhile and the server says this account may
// replace that change (can_override), ask, then send the same body with override: true.
type SaveBody = Record<string, unknown>;
interface SaveReply {
  message?: string;
  error?: string;
  can_override?: boolean;
  overridden?: boolean;
}

function useOverridableSave(path: string, fallback: string, onSaved: (data: SaveReply) => void) {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [waiting, setWaiting] = useState<SaveBody | null>(null);

  const send = async (body: SaveBody, override = false) => {
    setProblem('');
    setBusy(true);
    const { ok, data } = await api<SaveReply>('PATCH', path, override ? { ...body, override: true } : body);
    setBusy(false);
    if (ok) {
      setWaiting(null);
      onSaved(data);
      return;
    }
    if (!override && data.error === 'EDIT_CONFLICT' && data.can_override === true) {
      setWaiting(body);
      return;
    }
    setWaiting(null);
    setProblem(errorMessage(data, fallback));
  };

  const confirm = (
    <ConfirmDialog
      open={Boolean(waiting)}
      title="Replace their changes with mine?"
      message={
        'Someone else changed this order after you opened it.\n' +
        'Your account may replace their change with yours. They will be told, and a record is kept.'
      }
      confirmLabel="Replace with mine"
      busy={busy}
      onConfirm={() => waiting && void send(waiting, true)}
      onCancel={() => {
        setWaiting(null);
        setProblem('Not saved: this order was changed by someone else. Close this form to see their change.');
      }}
    />
  );

  return { busy, problem, setProblem, send, confirm };
}

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
        <Info label="Customer" value={customer?.full_name || 'Unknown customer'} />
        <Info
          label="Contact number"
          value={
            customer?.contact_number ? (
              // Plain text on purpose: a tel: link made the browser ask which app to open
              <span className="tabular-nums select-all">{formatMobile(customer.contact_number)}</span>
            ) : (
              <span className="font-normal text-muted-foreground">Not given</span>
            )
          }
        />
        <Info
          label="Stock"
          value={order.stock_reserved ? 'Reserved' : 'Not reserved'}
          sub={order.stock_reserved ? 'Materials are held for this order' : 'Reserved on approval / resume'}
        />
        <Info label="Created" value={formatDateTime(order.date_created, { utc: true })} />
        <Info
          label="Deadline"
          value={
            <span className="flex flex-wrap items-center gap-2">
              {formatDateTime(order.production_deadline, { withTime: false })}
              <DeadlineBadge flag={order.deadline_flag} />
            </span>
          }
        />
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
      {order.order_description && (
        <div className="rounded-md border bg-card p-3">
          <p className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            <FileText className="size-3.5" aria-hidden /> Description / instructions
          </p>
          <p className="mt-1 text-sm whitespace-pre-wrap wrap-anywhere">{order.order_description}</p>
        </div>
      )}
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
export function DetailsEditor({
  detail,
  actions,
  onResult,
  onEditing,
}: {
  detail: OrderDetail;
  actions: OrderActions;
  onResult: OnResult;
  onEditing?: OnEditing;
}) {
  const [form, setForm] = useState<{ deadline: string; quote: string; description: string } | null>(null);
  const { busy, problem, setProblem, send, confirm } = useOverridableSave(orderPath(detail, 'details'), 'The order details were not saved.', (data) => {
    setForm(null);
    onResult({ type: 'success', title: 'Order updated', message: data.message ?? 'The order was updated.' }, true);
  });
  useReportEditing(form !== null, onEditing);
  if (!actions.edit_deadline && !actions.edit_quote && !actions.edit_description) return null;

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
          setForm({ deadline: current < today ? today : current, quote: String(order.total_quote_amount ?? 0), description: order.order_description ?? '' });
        }}
      >
        <Pencil aria-hidden /> {actions.edit_quote ? 'Edit deadline, description or quote' : 'Edit deadline or description'}
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
    if (actions.edit_description && form.description.trim() !== (order.order_description ?? '')) {
      body.order_description = form.description.trim() || null;
    }
    if (Object.keys(body).length === 0) {
      setForm(null);
      onResult({ type: 'warning', title: 'No changes', message: 'Nothing was changed, so nothing was saved.' }, false);
      return;
    }
    await send({ ...body, expected_version: versionOf(detail) });
  };

  return (
    <>
    <form onSubmit={save} className="space-y-4 rounded-md border bg-muted/30 p-3">
      <FormProblem message={problem} />
      <div className="grid gap-4 sm:grid-cols-2">
        {actions.edit_deadline && (
          <Field id="edit-deadline" label="Deadline">
            <DateInput id="edit-deadline" min={today} required value={form.deadline} onChange={(e) => setForm({ ...form, deadline: e.target.value })} />
          </Field>
        )}
        {actions.edit_quote && (
          <Field id="edit-price" label="Quote (₱)">
            <Input id="edit-price" type="number" min={0} max={MONEY_INPUT_MAX} step="0.01" inputMode="decimal" value={form.quote} onChange={(e) => setForm({ ...form, quote: e.target.value })} />
          </Field>
        )}
      </div>
      {actions.edit_description && (
        <Field id="edit-description" label="Description / instructions" hint="What to make, colours, placement, anything the team must know">
          <Textarea id="edit-description" rows={4} maxLength={2000} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </Field>
      )}
      {!actions.edit_quote && <p className="text-xs text-muted-foreground">Only the Owner can change the quote, and only before approval.</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => setForm(null)} disabled={busy}>
          Cancel
        </Button>
        <Button busy={busy} type="submit" size="sm" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </form>
    {confirm}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Google Drive design link (link_design)
export function DesignLink({
  detail,
  actions,
  onResult,
  onEditing,
}: {
  detail: OrderDetail;
  actions: OrderActions;
  onResult: OnResult;
  onEditing?: OnEditing;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const { busy, problem, send, confirm } = useOverridableSave(orderPath(detail, 'design'), 'The design link was not saved.', (data) => {
    setDraft(null);
    onResult({ type: 'success', title: 'Design linked', message: data.message ?? 'The design file was linked.' }, true);
  });
  useReportEditing(draft !== null, onEditing);
  const link = detail.order.design_drive_link;

  const save = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (draft === null) return;
    await send({ design_drive_link: draft.trim(), expected_version: versionOf(detail) });
  };

  if (draft !== null) {
    return (
      <>
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
          <Button busy={busy} type="submit" size="sm" disabled={busy}>
            {busy ? 'Saving…' : 'Save link'}
          </Button>
        </div>
      </form>
      {confirm}
      </>
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
// Materials (migration 015): the stock this order uses, catalog items only. Sizes, names and
// numbers are print details (print-details-section.tsx), so they never block the quote or the
// approval. Adding a material to an order that already holds its stock reserves it too (the
// server checks the free stock and answers 409 when short).
export function MaterialsSection({
  detail,
  actions,
  onResult,
  onEditing,
}: {
  detail: OrderDetail;
  actions: OrderActions;
  onResult: OnResult;
  onEditing?: OnEditing;
}) {
  const api = useApi();
  const { items, totals } = detail;
  const [adding, setAdding] = useState(false);
  useReportEditing(adding, onEditing);
  const { snapshot } = useInventorySnapshot();
  const [itemId, setItemId] = useState('');
  const [qty, setQty] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');

  const add = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setProblem('');
    const item = snapshot?.items.find((i) => i.inventory_id === itemId);
    const quantity = Number(qty.trim());
    if (!item) {
      setProblem('Choose the material from the catalog.');
      return;
    }
    if (!qty.trim() || Number.isNaN(quantity)) {
      setProblem('Enter the quantity, as a number.');
      return;
    }
    setBusy(true);
    const { ok, data } = await api<{ message?: string }>('POST', orderPath(detail, 'items'), {
      inventory_id: item.inventory_id,
      product_type: item.item_name.slice(0, 100),
      quantity,
    });
    setBusy(false);
    if (!ok) {
      setProblem(errorMessage(data, 'The material was not added.'));
      return;
    }
    setAdding(false);
    setItemId('');
    setQty('');
    onResult({ type: 'success', title: 'Material added', message: data.message ?? 'The material was added to this order.' }, true);
  };

  return (
    <section id={ORDER_SECTION.materials} className="scroll-mt-4 space-y-3" aria-labelledby="materials-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="materials-title" className="font-semibold">
          Materials{' '}
          <span className="font-normal text-muted-foreground">
            ({totals.item_count} line{totals.item_count === 1 ? '' : 's'}, {totals.total_quantity.toLocaleString()} total)
          </span>
        </h3>
        {actions.add_items && !adding && (
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
            <ListPlus aria-hidden /> Add material
          </Button>
        )}
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No materials on this order.</p>
      ) : (
        <div className="max-w-full min-w-0 overflow-x-auto rounded-md border">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead>Material</TableHead>
                <TableHead className="hidden sm:table-cell">Category</TableHead>
                <TableHead className="text-right">Qty</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((it) => (
                <TableRow key={it.line_item_id}>
                  <TableCell className="min-w-32 whitespace-normal wrap-anywhere">
                    <span className="flex flex-wrap items-center gap-1">
                      {it.product_type}
                      {it.has_sizes && (
                        <Badge variant="outline" className={TONE_CLASSES.info.badge}>
                          <Shirt className="size-3" aria-hidden /> garment
                        </Badge>
                      )}
                      {it.is_consumable && (
                        <Badge variant="outline" className={TONE_CLASSES.muted.badge}>
                          consumable
                        </Badge>
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">{it.item_category ?? '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {it.quantity.toLocaleString()} <span className="text-xs text-muted-foreground">{it.unit ?? ''}</span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {adding && (
        <form onSubmit={add} className="space-y-3 rounded-md border bg-muted/30 p-3">
          <FormProblem message={problem} />
          <div className="flex flex-wrap items-end gap-2">
            <Field id="add-material" label="Material *" className="min-w-0 flex-[3_1_14rem]">
              <Select value={itemId} onValueChange={setItemId}>
                <SelectTrigger id="add-material" className="w-full">
                  <SelectValue placeholder="Choose from the catalog…" />
                </SelectTrigger>
                <SelectContent>
                  {(snapshot?.items ?? []).map((i) => (
                    <SelectItem key={i.inventory_id} value={i.inventory_id}>
                      {i.item_name} ({i.quantity_available_net.toLocaleString()} free)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field id="add-material-qty" label="Qty *" className="w-28">
              <Input id="add-material-qty" type="number" min={1} step={1} inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} />
            </Field>
          </div>
          <p className="text-xs text-muted-foreground">
            {detail.order.stock_reserved ? 'This order holds its stock, so the new material is reserved now.' : 'It is reserved when the order is approved.'}
          </p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setAdding(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" size="sm" busy={busy} disabled={busy}>
              {busy ? 'Adding…' : 'Add material'}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Status timeline (PB 14): every approval and status change, as recorded by the server in the
// same transaction as the change. Oldest first; times are shown on the shop's clock.
export function StatusTimeline({ detail }: { detail: OrderDetail }) {
  const { order } = detail;
  const history = detail.status_history ?? [];
  return (
    <section className="space-y-3" aria-labelledby="timeline-title">
      <h3 id="timeline-title" className="flex items-center gap-2 font-semibold">
        <History className="size-4 text-muted-foreground" aria-hidden /> Status history
      </h3>
      <ol className="space-y-2 border-l pl-4 text-sm">
        <li>
          <span className="font-medium">Order created</span>
          <span className="block text-xs text-muted-foreground">{formatDateTime(order.date_created, { utc: true })}</span>
        </li>
        {history.map((h) => (
          <li key={h.history_id}>
            <span className="flex flex-wrap items-center gap-2">
              <OrderStatusBadge status={h.to_status} />
              {h.from_status && <span className="text-xs text-muted-foreground">from {h.from_status}</span>}
            </span>
            <span className="block text-xs text-muted-foreground wrap-anywhere">
              {formatDateTime(h.changed_at, { utc: true })} · {h.changed_by_name}
              {h.changed_role ? ` (${h.changed_role})` : ''}
            </span>
          </li>
        ))}
      </ol>
      {history.length === 0 && <p className="text-xs text-muted-foreground">No status changes yet.</p>}
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
  // HCI: which section of this sheet resolves each blocker (shown as a "Go to …" link)
  const fixes = new Map<string, OrderSectionKey>();
  const block = (text: string, fix?: OrderSectionKey) => {
    blocking.push(text);
    if (fix) fixes.set(text, fix);
  };
  if (order.sync_status !== 'synced' || detail.source === 'local') {
    blocking.push('Approval needs an internet connection, and the order must be synced to the cloud.');
  }
  if (dp && !dp.required) block('Set a quote amount for this order first.', 'quote');
  else if (dp && !dp.met) block('The downpayment (half of the quote) is not complete yet.', 'payments');
  const offlinePayments = payments.filter((p) => p.sync_status !== 'synced').length;
  if (offlinePayments) notes.push(`${offlinePayments} payment(s) saved offline do not count until they sync.`);
  if (items.length === 0) block('Add at least one material to this order.', 'materials');
  if (detail.stock_check && !detail.stock_check.sufficient) {
    blocking.push(...shortfallLines(detail.stock_check).map((l) => `Not enough stock: ${l}`));
  }
  return { blocking, notes: [...blocking, ...notes], fixes };
}

export function ApprovalPanel({ detail, canApprove }: { detail: OrderDetail; canApprove: boolean }) {
  const dp = detail.totals.downpayment;
  const { notes, fixes } = approvalNotes(detail);
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
        <ul className="list-disc space-y-1 pl-5 text-xs leading-relaxed text-foreground/80 wrap-anywhere">
          {notes.map((n) => (
            <li key={n}>
              {n}
              {fixes.get(n) && (
                <>
                  {' '}
                  <JumpToSection to={fixes.get(n) as OrderSectionKey} />
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {!canApprove && <p className="text-xs text-foreground/80">Waiting for the Owner to approve this job order before printing can start.</p>}
    </section>
  );
}
