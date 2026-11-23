'use client';

// Payments of one order (PB 21): history, totals and the "record a payment" form.
// The server decides everything: whether payments are allowed (allowed_actions.record_payment
// and payment_blocked_reason), the most the order can take (max_payment), the receipt number,
// and the totals after each payment. This form only checks that the amount is a number.
// PB 23: the Owner voids a payment with a reason (allowed_actions.void_payment and the payment's
// own can_void). The server adds a negative reversing entry, never edits or deletes the payment,
// and refuses a void that breaks the downpayment of an order in production unless confirmed.
// Migration 015: every method (Cash, GCash, Maya, PayPal, bank transfer, cheque, card, other)
// shows the details the server says it needs (GET /api/orders/options), who paid, and the date
// it was paid (it may be earlier than today). Owner / Admin verify non-cash payments and correct
// a payment's details (allowed_actions.verify_payment / edit_payment); the Owner refunds
// (allowed_actions.refund_payment, up to max_refund).
import { useState } from 'react';
import { Ban, BadgeCheck, Pencil, Printer, Undo2, TriangleAlert, Wallet } from 'lucide-react';
import { formatDateTime, peso } from '@xiaowu/client-core/format';
import type { ResultMessage } from '@/components/feedback/result-dialog';
import { JumpToSection, ORDER_SECTION } from '@/components/orders/jump-to-section';
import { PaymentStatusBadge } from '@/components/orders/status-badges';
import { bannerText, Field, fieldErrorsMap, FormProblem, RequiredNote } from '@/components/forms/form-bits';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useApi } from '@/hooks/use-api';
import { useOrderOptions } from '@/hooks/use-order-options';
import { errorMessage } from '@/lib/api';
import { PAYMENT_TYPES, RECEIPT_AFTER_SYNC, type OrderDetail, type OrderTotals, type Payment, type PaymentMethodForm } from '@/lib/orders';
import { nowForInput, utcToInput } from '@/lib/stock';
import { lookFor, PAYMENT_STATUS, TONE_CLASSES } from '@/lib/ui-tokens';
import { cn } from '@/lib/utils';
import { MONEY_INPUT_MAX, TEXT_MAX } from '@/lib/input-limits';
import type { OrderActions } from '@xiaowu/client-core/permissions';

interface PaymentResponse {
  message?: string;
  error?: string;
  source?: string;
  payment?: Payment;
  totals?: OrderTotals;
  warnings?: { code?: string; message: string }[];
}

const FALLBACK_METHODS: PaymentMethodForm[] = PAYMENT_TYPES.map((value) => ({ value, verify: value !== 'Cash', fields: [] }));

/** The method's detail fields as inputs (labels, required and limits come from the server) */
function MethodFields({
  method,
  values,
  onChange,
  errors,
  idPrefix,
  forceOptional = false,
}: {
  method: PaymentMethodForm | undefined;
  values: Record<string, string>;
  onChange: (name: string, value: string) => void;
  errors: Record<string, string>;
  idPrefix: string;
  forceOptional?: boolean;
}) {
  if (!method || method.fields.length === 0) return null;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {method.fields.map((f) => (
        <Field key={f.name} id={`${idPrefix}-${f.name}`} label={`${f.label}${f.required && !forceOptional ? ' *' : ''}`} error={errors[f.name]} hint={f.hint ?? undefined}>
          <Input
            id={`${idPrefix}-${f.name}`}
            type={f.type === 'date' ? 'date' : 'text'}
            maxLength={f.max ?? undefined}
            value={values[f.name] ?? ''}
            onChange={(e) => onChange(f.name, e.target.value)}
          />
        </Field>
      ))}
    </div>
  );
}

/** "BDO · FT-2026-01 · from Mrs. Lopez" (display only) */
const detailsText = (p: Payment) =>
  [p.bank_name, p.cheque_no && `Cheque ${p.cheque_no}${p.cheque_date ? ` dated ${p.cheque_date}` : ''}`, p.reference_no, p.account_name, p.payer_name && `paid by ${p.payer_name}`]
    .filter(Boolean)
    .join(' · ');

export function PaymentsSection({
  detail,
  actions,
  onPrintReceipt,
  onResult,
}: {
  detail: OrderDetail;
  actions: OrderActions;
  onPrintReceipt: (payment: Payment) => void;
  /** reload: the order changed (or may have), fetch it again */
  onResult: (result: ResultMessage, reload: boolean) => void;
}) {
  const api = useApi();
  const options = useOrderOptions();
  const methods = options?.payment_methods ?? FALLBACK_METHODS;
  const { order, payments, totals } = detail;
  const [amount, setAmount] = useState('');
  const [type, setType] = useState<string>('Cash');
  const [paidAt, setPaidAt] = useState('');
  const [details, setDetails] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  // Nielsen H9: the server's VALIDATION_FAILED details, shown next to their fields
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [voiding, setVoiding] = useState<Payment | null>(null);
  const [editing, setEditing] = useState<Payment | null>(null);
  const [refunding, setRefunding] = useState(false);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const balanceTone = lookFor(PAYMENT_STATUS, totals.payment_status).tone;
  const showVoid = Boolean(actions.void_payment);
  const method = methods.find((m) => m.value === type);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setProblem('');
    setFieldErrors({});
    const value = Number(amount.trim());
    if (amount.trim() === '' || Number.isNaN(value)) {
      setProblem('Enter the amount received, as a number.');
      return;
    }
    const sent = Object.fromEntries((method?.fields ?? []).map((f) => [f.name, details[f.name]?.trim() || undefined]));
    setBusy(true);
    const { ok, data } = await api<PaymentResponse>('POST', `/orders/${encodeURIComponent(order.order_id)}/payments`, {
      amount: value,
      payment_type: type,
      ...(paidAt ? { payment_date: paidAt } : {}),
      ...sent,
    });
    setBusy(false);
    if (!ok) {
      setFieldErrors(fieldErrorsMap(data));
      setProblem(bannerText(data, ['amount', 'payment_type', 'payment_date', ...(method?.fields ?? []).map((f) => f.name)], 'Could not record the payment.'));
      // Someone else may have just paid: show the current balance
      if (data.error === 'PAYMENT_EXCEEDS_BALANCE') onResult({ type: 'warning', title: 'Amount is more than the balance', message: errorMessage(data, '') }, true);
      return;
    }
    const warnings = (data.warnings ?? []).map((w) => w.message);
    const receipt = data.payment?.receipt_no ? `Receipt no. ${data.payment.receipt_no}.` : `Receipt number: ${RECEIPT_AFTER_SYNC.toLowerCase()}.`;
    setAmount('');
    setDetails({});
    setPaidAt('');
    onResult(
      {
        type: warnings.length ? 'warning' : 'success',
        title: 'Payment recorded',
        message: [
          `${peso(data.payment?.amount ?? value)} (${type}) recorded. ${receipt}`,
          data.totals ? `Payment status: ${data.totals.payment_status}. Remaining balance: ${peso(data.totals.remaining)}.` : null,
          method?.verify ? 'An Owner or Admin should verify it once the money is seen in the account.' : null,
          data.source === 'local' ? 'Saved on this computer (offline). It will be sent to the cloud when the connection is back.' : null,
          ...warnings,
        ]
          .filter(Boolean)
          .join('\n'),
      },
      true
    );
  };

  const verify = async (p: Payment) => {
    setVerifyingId(p.payment_id);
    const { ok, data } = await api<{ message?: string }>(
      'POST',
      `/orders/${encodeURIComponent(order.order_id)}/payments/${encodeURIComponent(p.payment_id)}/verify`
    );
    setVerifyingId(null);
    onResult(ok ? { type: 'success', title: 'Payment verified', message: data.message ?? 'Verified.' }
      : { type: 'error', title: 'Not verified', message: errorMessage(data, 'The payment was not verified.') }, true);
  };

  return (
    <section id={ORDER_SECTION.payments} className="scroll-mt-4 space-y-3" aria-labelledby="payments-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="payments-title" className="flex items-center gap-2 font-semibold">
          Payments <PaymentStatusBadge status={totals.payment_status} />
        </h3>
        {actions.refund_payment && (
          <Button variant="outline" size="sm" onClick={() => setRefunding(true)}>
            <Undo2 aria-hidden /> Refund (up to {peso(actions.max_refund)})
          </Button>
        )}
      </div>

      {totals.payment_status === 'Overpaid' && (
        <p className={cn('flex gap-2 rounded-md border p-3 text-sm', TONE_CLASSES.danger.banner)}>
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            {peso(totals.overpaid_by)} was paid above the bill (payments taken at different branches while offline, or a price cut after
            payment). The Owner should refund it to the customer.
          </span>
        </p>
      )}

      {payments.length === 0 ? (
        <p className="text-sm text-muted-foreground">No payments yet.</p>
      ) : (
        <div className="max-w-full min-w-0 overflow-x-auto rounded-md border">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead>Date paid</TableHead>
                <TableHead>Receipt no.</TableHead>
                <TableHead>Method and details</TableHead>
                <TableHead className="hidden md:table-cell">Received by</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {payments.map((p) => (
                <TableRow key={p.payment_id}>
                  <TableCell className="whitespace-normal">
                    {formatDateTime(p.payment_date, { utc: true })}
                    {p.recorded_at && p.recorded_at.slice(0, 10) !== p.payment_date.slice(0, 10) && (
                      <span className="block text-xs text-muted-foreground">recorded {formatDateTime(p.recorded_at, { utc: true, withTime: false })}</span>
                    )}
                    {p.sync_status !== 'synced' && (
                      <Badge title="Saved on this computer; it goes to the cloud when the connection is back" variant="outline" className={cn('ml-1', TONE_CLASSES.info.badge)}>
                        Pending sync
                      </Badge>
                    )}
                    {p.voided && (
                      <Badge variant="outline" className={cn('ml-1', TONE_CLASSES.danger.badge)} title={p.voided_by_receipt_no ? `Reversed by ${p.voided_by_receipt_no}` : undefined}>
                        Voided
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {p.receipt_no ? <code className="font-mono text-xs">{p.receipt_no}</code> : <span className="text-muted-foreground">{RECEIPT_AFTER_SYNC}</span>}
                  </TableCell>
                  <TableCell className="max-w-64 whitespace-normal wrap-anywhere">
                    <span className="flex flex-wrap items-center gap-1">
                      {p.payment_type}
                      {p.is_refund && <Badge variant="outline" className={TONE_CLASSES.warning.badge}>Refund</Badge>}
                      {p.needs_verification && <Badge variant="outline" className={TONE_CLASSES.warning.badge}>Not verified</Badge>}
                      {p.verified_at && <Badge variant="outline" className={TONE_CLASSES.success.badge}>Verified</Badge>}
                    </span>
                    {detailsText(p) && <span className="block text-xs text-muted-foreground">{detailsText(p)}</span>}
                    {p.is_void && (
                      <span className="block text-xs text-muted-foreground">
                        Void of {p.voids_receipt_no ?? 'a payment'}
                        {p.void_reason ? `: ${p.void_reason}` : ''}
                      </span>
                    )}
                    {p.is_refund && p.refund_reason && <span className="block text-xs text-muted-foreground">{p.refund_reason}</span>}
                    {p.payment_notes && <span className="block text-xs text-muted-foreground">{p.payment_notes}</span>}
                  </TableCell>
                  <TableCell className="hidden max-w-40 whitespace-normal wrap-anywhere md:table-cell">{p.received_by_name || 'Not recorded'}</TableCell>
                  <TableCell className="text-right tabular-nums">{peso(p.amount)}</TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    {actions.verify_payment && p.needs_verification && p.sync_status === 'synced' && (
                      <Button variant="ghost" size="icon-sm" busy={verifyingId === p.payment_id} onClick={() => void verify(p)}
                        aria-label={`Mark the payment of ${peso(p.amount)} as received`} title="Verify: the money arrived">
                        <BadgeCheck aria-hidden />
                      </Button>
                    )}
                    {actions.edit_payment && !p.is_void && p.sync_status === 'synced' && (
                      <Button variant="ghost" size="icon-sm" onClick={() => setEditing(p)} aria-label={`Correct the details of the payment of ${peso(p.amount)}`} title="Correct date or details">
                        <Pencil aria-hidden />
                      </Button>
                    )}
                    {showVoid && p.can_void && (
                      <Button variant="ghost" size="icon-sm" onClick={() => setVoiding(p)} aria-label={`Void the payment of ${peso(p.amount)}`} title="Void this payment (recorded by mistake)">
                        <Ban aria-hidden />
                      </Button>
                    )}
                    {actions.print_receipt && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => onPrintReceipt(p)}
                        aria-label={`Print the payment acknowledgement for ${peso(p.amount)}`}
                        title={p.receipt_no ? 'Print a payment acknowledgement' : 'Print a provisional acknowledgement (the receipt number comes after sync)'}
                      >
                        <Printer aria-hidden />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Server totals (services/domain/payments.js) */}
      <dl className="grid gap-1 text-sm">
        <div className="flex flex-wrap items-baseline justify-between gap-x-2">
          <dt className="text-muted-foreground">Bill</dt>
          <dd className="min-w-0 font-medium tabular-nums wrap-anywhere">{peso(order.total_quote_amount)}</dd>
        </div>
        <div className="flex flex-wrap items-baseline justify-between gap-x-2">
          <dt className="text-muted-foreground">Total paid</dt>
          <dd className="min-w-0 font-medium tabular-nums wrap-anywhere">{peso(totals.total_paid)}</dd>
        </div>
        {Boolean(totals.total_refunded) && (
          <div className="flex flex-wrap items-baseline justify-between gap-x-2">
            <dt className="text-muted-foreground">Refunded</dt>
            <dd className="min-w-0 font-medium tabular-nums wrap-anywhere">{peso(totals.total_refunded)}</dd>
          </div>
        )}
        <div className="flex flex-wrap items-baseline justify-between gap-x-2">
          <dt className="text-muted-foreground">Remaining balance</dt>
          <dd className={cn('min-w-0 font-semibold tabular-nums wrap-anywhere', TONE_CLASSES[balanceTone].text)}>{peso(totals.remaining)}</dd>
        </div>
        {totals.downpayment && totals.downpayment.required > 0 && (
          <div className="flex flex-wrap items-baseline justify-between gap-x-2">
            <dt className="text-muted-foreground">Downpayment needed for approval (50%)</dt>
            <dd className="min-w-0 tabular-nums wrap-anywhere">
              {peso(totals.downpayment.required)} {totals.downpayment.met && <span className={TONE_CLASSES.success.text}>· met</span>}
            </dd>
          </div>
        )}
      </dl>

      {actions.record_payment ? (
        <form onSubmit={submit} className="space-y-4 rounded-md border bg-muted/30 p-3">
          <FormProblem message={problem} />
          <div className="grid gap-4 sm:grid-cols-3">
            <Field id="payment-value" label="Amount (₱) *" error={fieldErrors.amount}>
              <Input
                id="payment-value"
                type="number"
                min="0.01"
                step="0.01"
                max={actions.max_payment || MONEY_INPUT_MAX}
                inputMode="decimal"
                required
                placeholder={`Up to ${peso(actions.max_payment)}`}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </Field>
            <Field id="pay-type" label="Method *" error={fieldErrors.payment_type}>
              <Select value={type} onValueChange={(v) => { setType(v); setFieldErrors({}); }}>
                <SelectTrigger id="pay-type" className="w-full" aria-invalid={fieldErrors.payment_type ? true : undefined}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {methods.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      {m.value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field id="pay-when" label="Date and time paid" error={fieldErrors.payment_date} hint="Leave empty for now. Earlier is fine, later is not.">
              <Input id="pay-when" type="datetime-local" max={nowForInput()} value={paidAt} onChange={(e) => setPaidAt(e.target.value)} />
            </Field>
          </div>
          <MethodFields method={method} values={details} errors={fieldErrors} idPrefix="pay" onChange={(name, value) => setDetails((d) => ({ ...d, [name]: value }))} />
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" disabled={busy} onClick={() => setAmount(String(actions.max_payment))}>
              Pay full balance
            </Button>
            <Button busy={busy} type="submit" disabled={busy}>
              <Wallet aria-hidden /> {busy ? 'Saving…' : 'Add payment'}
            </Button>
          </div>
        </form>
      ) : (
        actions.payment_blocked_reason && (
          <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
            {actions.payment_blocked_reason}
            {/* HCI: the server says there is no quote yet: offer the way to the section that sets it */}
            {detail.quote && !detail.quote.has_quote && (
              <>
                {' '}
                <JumpToSection to="quote" />
              </>
            )}
          </p>
        )
      )}
      {voiding && (
        <VoidPaymentDialog
          orderId={order.order_id}
          payment={voiding}
          onClose={() => setVoiding(null)}
          onDone={(r) => {
            setVoiding(null);
            onResult(r, true);
          }}
        />
      )}
      {editing && (
        <CorrectPaymentDialog
          orderId={order.order_id}
          payment={editing}
          methods={methods}
          onClose={() => setEditing(null)}
          onDone={(r) => {
            setEditing(null);
            onResult(r, true);
          }}
        />
      )}
      {refunding && (
        <RefundDialog
          orderId={order.order_id}
          max={actions.max_refund}
          methods={methods}
          reasons={options?.refund_reasons ?? ['Order cancelled', 'Paid more than the bill', 'Other']}
          onClose={() => setRefunding(false)}
          onDone={(r) => {
            setRefunding(false);
            onResult(r, true);
          }}
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Correct a payment's date, method or details (Owner / Admin). The amount never changes: a wrong
// amount is voided and recorded again. Changing the money details clears the verification.
function CorrectPaymentDialog({
  orderId,
  payment,
  methods,
  onClose,
  onDone,
}: {
  orderId: string;
  payment: Payment;
  methods: PaymentMethodForm[];
  onClose: () => void;
  onDone: (result: ResultMessage) => void;
}) {
  const api = useApi();
  const [type, setType] = useState(payment.payment_type);
  const [paidAt, setPaidAt] = useState(utcToInput(payment.payment_date));
  const [values, setValues] = useState<Record<string, string>>(() => {
    const p = payment as unknown as Record<string, string | null | undefined>;
    return Object.fromEntries(['payer_name', 'reference_no', 'bank_name', 'account_name', 'cheque_no', 'cheque_date', 'payment_notes'].map((k) => [k, p[k] ?? '']));
  });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const method = methods.find((m) => m.value === type);

  const save = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setProblem('');
    setErrors({});
    const body: Record<string, unknown> = { payment_type: type, payment_date: paidAt };
    for (const f of method?.fields ?? []) body[f.name] = values[f.name]?.trim() || null;
    setBusy(true);
    const { ok, data } = await api<{ message?: string }>('PATCH', `/orders/${encodeURIComponent(orderId)}/payments/${encodeURIComponent(payment.payment_id)}`, body);
    setBusy(false);
    if (!ok) {
      setErrors(fieldErrorsMap(data));
      setProblem(bannerText(data, Object.keys(body), 'The payment was not changed.'));
      return;
    }
    onDone({ type: 'success', title: 'Payment corrected', message: data.message ?? 'Saved.' });
  };

  return (
    <Dialog open onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Correct payment {payment.receipt_no ?? ''}</DialogTitle>
          <DialogDescription>{peso(payment.amount)}. The amount stays: if it is wrong, void this payment and record it again.</DialogDescription>
        </DialogHeader>
        <form onSubmit={save} className="space-y-4">
          <FormProblem message={problem} />
          <RequiredNote />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id="fix-type" label="Method *" error={errors.payment_type}>
              <Select value={type} onValueChange={setType}>
                <SelectTrigger id="fix-type" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {methods.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      {m.value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field id="fix-when" label="Date and time paid *" error={errors.payment_date}>
              <Input id="fix-when" type="datetime-local" max={nowForInput()} value={paidAt} onChange={(e) => setPaidAt(e.target.value)} />
            </Field>
          </div>
          <MethodFields method={method} values={values} errors={errors} idPrefix="fix" forceOptional={Boolean(payment.is_refund)}
            onChange={(name, value) => setValues((v) => ({ ...v, [name]: value }))} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button type="submit" busy={busy} disabled={busy}>{busy ? 'Saving…' : 'Save correction'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------
// Refund (Owner): money given back. The server allows it for a cancelled order (up to what was
// paid) or for what was paid above the bill (after a price cut, or an offline overpayment).
function RefundDialog({
  orderId,
  max,
  methods,
  reasons,
  onClose,
  onDone,
}: {
  orderId: string;
  max: number;
  methods: PaymentMethodForm[];
  reasons: string[];
  onClose: () => void;
  onDone: (result: ResultMessage) => void;
}) {
  const api = useApi();
  const [amount, setAmount] = useState(String(max));
  const [reason, setReason] = useState(reasons[0]);
  const [notes, setNotes] = useState('');
  const [type, setType] = useState('Cash');
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const method = methods.find((m) => m.value === type);

  const save = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setProblem('');
    setErrors({});
    const value = Number(amount.trim());
    if (!amount.trim() || Number.isNaN(value)) {
      setProblem('Enter the amount given back, as a number.');
      return;
    }
    const body: Record<string, unknown> = { amount: value, refund_reason: reason, notes: notes.trim() || undefined, payment_type: type };
    for (const f of method?.fields ?? []) if (values[f.name]?.trim()) body[f.name] = values[f.name].trim();
    setBusy(true);
    const { ok, data } = await api<{ message?: string }>('POST', `/orders/${encodeURIComponent(orderId)}/refunds`, body);
    setBusy(false);
    if (!ok) {
      setErrors(fieldErrorsMap(data));
      setProblem(bannerText(data, Object.keys(body), 'Nothing was refunded.'));
      return;
    }
    onDone({ type: 'success', title: 'Refund recorded', message: data.message ?? 'Saved.' });
  };

  return (
    <Dialog open onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Refund the customer</DialogTitle>
          <DialogDescription>Up to {peso(max)} can be given back now. It is recorded with its own receipt number.</DialogDescription>
        </DialogHeader>
        <form onSubmit={save} className="space-y-4">
          <FormProblem message={problem} />
          <RequiredNote />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id="rf-value" label="Amount (₱) *" error={errors.amount}>
              <Input id="rf-value" type="number" min="0.01" step="0.01" max={max} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </Field>
            <Field id="rf-reason" label="Why *" error={errors.refund_reason}>
              <Select value={reason} onValueChange={setReason}>
                <SelectTrigger id="rf-reason" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {reasons.map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field id="rf-type" label="Given back by *" error={errors.payment_type}>
              <Select value={type} onValueChange={setType}>
                <SelectTrigger id="rf-type" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {methods.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      {m.value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field id="rf-notes" label={reason === 'Other' ? 'Notes *' : 'Notes'} error={errors.notes}>
              <Input id="rf-notes" maxLength={TEXT_MAX.reason} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
          </div>
          <MethodFields method={method} values={values} errors={errors} idPrefix="rf" forceOptional onChange={(name, value) => setValues((v) => ({ ...v, [name]: value }))} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button type="submit" variant="destructive" busy={busy} disabled={busy}>
              <Undo2 aria-hidden /> {busy ? 'Saving…' : 'Record refund'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface VoidResponse {
  message?: string;
  error?: string;
  totals?: OrderTotals;
}

function VoidPaymentDialog({
  orderId,
  payment,
  onClose,
  onDone,
}: {
  orderId: string;
  payment: Payment;
  onClose: () => void;
  onDone: (result: ResultMessage) => void;
}) {
  const api = useApi();
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState('');
  // The server said this void breaks the downpayment: the Owner may confirm and send again
  const [needsConfirm, setNeedsConfirm] = useState('');
  // Nielsen H9: the server's VALIDATION_FAILED details, shown next to their fields
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const send = async (confirmBreak: boolean) => {
    setProblem('');
    setFieldErrors({});
    if (!reason.trim()) {
      setProblem('Write why this payment is being voided.');
      return;
    }
    setBusy(true);
    const { ok, data } = await api<VoidResponse>(
      'POST',
      `/orders/${encodeURIComponent(orderId)}/payments/${encodeURIComponent(payment.payment_id)}/void`,
      { reason: reason.trim(), ...(confirmBreak ? { confirm_break_downpayment: true } : {}) }
    );
    setBusy(false);
    if (!ok) {
      if (data.error === 'VOID_BREAKS_DOWNPAYMENT') {
        setNeedsConfirm(errorMessage(data, 'This void breaks the downpayment.'));
        return;
      }
      setFieldErrors(fieldErrorsMap(data));
      setProblem(bannerText(data, ['reason'], 'The payment was not voided.'));
      return;
    }
    onDone({
      type: 'success',
      title: 'Payment voided',
      message: [data.message, data.totals ? `Payment status: ${data.totals.payment_status}. Remaining balance: ${peso(data.totals.remaining)}.` : null]
        .filter(Boolean)
        .join('\n'),
    });
  };

  return (
    <Dialog open onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent className="min-w-0 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Void payment {payment.receipt_no ?? ''}</DialogTitle>
          <DialogDescription>
            {peso(payment.amount)} ({payment.payment_type}). The payment stays on record; a reversing entry with its own receipt number is added.
          </DialogDescription>
        </DialogHeader>
        <form
          className="max-w-full min-w-0 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void send(false);
          }}
        >
          <FormProblem message={problem} />
          <RequiredNote />
          <Field id="void-reason" label="Reason for voiding *" error={fieldErrors.reason}>
            <textarea
              id="void-reason"
              rows={3}
              maxLength={TEXT_MAX.reason}
              required
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={busy}
              placeholder="e.g. refunded to the customer, wrong GCash account"
              className="w-full min-w-0 rounded-md border bg-background px-3 py-2 text-sm shadow-xs focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none aria-invalid:border-destructive"
            />
          </Field>
          {needsConfirm && (
            <p role="alert" className={cn('flex gap-2 rounded-md border p-3 text-sm', TONE_CLASSES.warning.banner)}>
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span className="wrap-anywhere">{needsConfirm}</span>
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Keep payment
            </Button>
            {needsConfirm ? (
              <Button busy={busy} type="button" variant="destructive" onClick={() => void send(true)} disabled={busy}>
                <Ban aria-hidden /> {busy ? 'Voiding…' : 'Void anyway'}
              </Button>
            ) : (
              <Button busy={busy} type="submit" variant="destructive" disabled={busy}>
                <Ban aria-hidden /> {busy ? 'Voiding…' : 'Void payment'}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
