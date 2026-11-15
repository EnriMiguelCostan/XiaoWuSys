'use client';

// Payments of one order (PB 21): history, totals and the "record a payment" form.
// The server decides everything: whether payments are allowed (allowed_actions.record_payment
// and payment_blocked_reason), the most the order can take (max_payment), the receipt number,
// and the totals after each payment. This form only checks that the amount is a number.
// PB 23: the Owner voids a payment with a reason (allowed_actions.void_payment and the payment's
// own can_void). The server adds a negative reversing entry, never edits or deletes the payment,
// and refuses a void that breaks the downpayment of an order in production unless confirmed.
import { useState } from 'react';
import { Ban, Printer, TriangleAlert, Wallet } from 'lucide-react';
import { formatDateTime, peso } from '@xiaowu/client-core/format';
import type { ResultMessage } from '@/components/feedback/result-dialog';
import { PaymentStatusBadge } from '@/components/orders/status-badges';
import { FormProblem } from '@/components/forms/form-bits';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useApi } from '@/hooks/use-api';
import { errorMessage } from '@/lib/api';
import { PAYMENT_TYPES, RECEIPT_AFTER_SYNC, type OrderDetail, type OrderTotals, type Payment } from '@/lib/orders';
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
  const { order, payments, totals } = detail;
  const [amount, setAmount] = useState('');
  const [type, setType] = useState<string>(PAYMENT_TYPES[0]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [voiding, setVoiding] = useState<Payment | null>(null);
  const balanceTone = lookFor(PAYMENT_STATUS, totals.payment_status).tone;
  const showVoid = Boolean(actions.void_payment);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setProblem('');
    const value = Number(amount.trim());
    if (amount.trim() === '' || Number.isNaN(value)) {
      setProblem('Enter the amount received, as a number.');
      return;
    }
    setBusy(true);
    const { ok, data } = await api<PaymentResponse>('POST', `/orders/${encodeURIComponent(order.order_id)}/payments`, {
      amount: value,
      payment_type: type,
    });
    setBusy(false);
    if (!ok) {
      setProblem(errorMessage(data, 'Could not record the payment.'));
      // Someone else may have just paid: show the current balance
      if (data.error === 'PAYMENT_EXCEEDS_BALANCE') onResult({ type: 'warning', title: 'Amount is more than the balance', message: errorMessage(data, '') }, true);
      return;
    }
    const warnings = (data.warnings ?? []).map((w) => w.message);
    const receipt = data.payment?.receipt_no ? `Receipt no. ${data.payment.receipt_no}.` : `Receipt number: ${RECEIPT_AFTER_SYNC.toLowerCase()}.`;
    setAmount('');
    onResult(
      {
        type: warnings.length ? 'warning' : 'success',
        title: 'Payment recorded',
        message: [
          `${peso(data.payment?.amount ?? value)} (${type}) recorded. ${receipt}`,
          data.totals ? `Payment status: ${data.totals.payment_status}. Remaining balance: ${peso(data.totals.remaining)}.` : null,
          data.source === 'local' ? 'Saved on this computer (offline). It will be sent to the cloud when the connection is back.' : null,
          ...warnings,
        ]
          .filter(Boolean)
          .join('\n'),
      },
      true
    );
  };

  return (
    <section className="space-y-3" aria-labelledby="payments-title">
      <h3 id="payments-title" className="flex items-center gap-2 font-semibold">
        Payments <PaymentStatusBadge status={totals.payment_status} />
      </h3>

      {totals.payment_status === 'Overpaid' && (
        <p className={cn('flex gap-2 rounded-md border p-3 text-sm', TONE_CLASSES.danger.banner)}>
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            This order was paid {peso(totals.overpaid_by)} more than its price (payments taken at different branches while
            offline). The Owner should review it and refund the customer.
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
                <TableHead>Date</TableHead>
                <TableHead>Receipt no.</TableHead>
                <TableHead className="hidden sm:table-cell">Type</TableHead>
                <TableHead className="hidden md:table-cell">Received by</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                {(actions.print_receipt || showVoid) && (
                  <TableHead>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {payments.map((p) => (
                <TableRow key={p.payment_id}>
                  <TableCell className="whitespace-normal">
                    {formatDateTime(p.payment_date, { utc: true })}
                    {p.sync_status !== 'synced' && (
                      <Badge variant="outline" className={cn('ml-1', TONE_CLASSES.info.badge)}>
                        offline
                      </Badge>
                    )}
                    {p.voided && (
                      <Badge variant="outline" className={cn('ml-1', TONE_CLASSES.danger.badge)} title={p.voided_by_receipt_no ? `Reversed by ${p.voided_by_receipt_no}` : undefined}>
                        Voided
                      </Badge>
                    )}
                    {p.is_void && (
                      <span className="block text-xs text-muted-foreground wrap-anywhere">
                        Void of {p.voids_receipt_no ?? 'a payment'}
                        {p.void_reason ? `: ${p.void_reason}` : ''}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    {p.receipt_no ? <code className="font-mono text-xs">{p.receipt_no}</code> : <span className="text-muted-foreground">{RECEIPT_AFTER_SYNC}</span>}
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">{p.payment_type}</TableCell>
                  <TableCell className="hidden max-w-40 whitespace-normal wrap-anywhere md:table-cell">{p.received_by_name || 'Not recorded'}</TableCell>
                  <TableCell className="text-right tabular-nums">{peso(p.amount)}</TableCell>
                  {(actions.print_receipt || showVoid) && (
                    <TableCell className="text-right whitespace-nowrap">
                      {showVoid && p.can_void && (
                        <Button variant="ghost" size="icon-sm" onClick={() => setVoiding(p)} aria-label={`Void the payment of ${peso(p.amount)}`} title="Void this payment">
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
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Server totals (services/domain/payments.js) */}
      <dl className="grid gap-1 text-sm">
        <div className="flex flex-wrap items-baseline justify-between gap-x-2">
          <dt className="text-muted-foreground">Total paid</dt>
          <dd className="min-w-0 font-medium tabular-nums wrap-anywhere">{peso(totals.total_paid)}</dd>
        </div>
        <div className="flex flex-wrap items-baseline justify-between gap-x-2">
          <dt className="text-muted-foreground">Remaining balance</dt>
          <dd className={cn('min-w-0 font-semibold tabular-nums wrap-anywhere', TONE_CLASSES[balanceTone].text)}>{peso(totals.remaining)}</dd>
        </div>
      </dl>

      {actions.record_payment ? (
        <form onSubmit={submit} className="space-y-3 rounded-md border bg-muted/30 p-3">
          <FormProblem message={problem} />
          <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor="payment-value">Amount (₱)</Label>
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
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor="pay-type">Type</Label>
              <Select value={type} onValueChange={setType}>
                <SelectTrigger id="pay-type" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAYMENT_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" disabled={busy} onClick={() => setAmount(String(actions.max_payment))}>
              Pay full balance
            </Button>
            <Button type="submit" disabled={busy}>
              <Wallet aria-hidden /> {busy ? 'Saving…' : 'Add payment'}
            </Button>
          </div>
        </form>
      ) : (
        actions.payment_blocked_reason && <p className="text-sm text-muted-foreground">{actions.payment_blocked_reason}</p>
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
    </section>
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
  const [busy, setBusy] = useState(false);

  const send = async (confirmBreak: boolean) => {
    setProblem('');
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
      setProblem(errorMessage(data, 'The payment was not voided.'));
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
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor="void-reason">Reason for voiding *</Label>
            <textarea
              id="void-reason"
              rows={3}
              maxLength={TEXT_MAX.reason}
              required
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={busy}
              placeholder="e.g. refunded to the customer, wrong GCash account"
              className="w-full min-w-0 rounded-md border bg-background px-3 py-2 text-sm shadow-xs focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
            />
          </div>
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
              <Button type="button" variant="destructive" onClick={() => void send(true)} disabled={busy}>
                <Ban aria-hidden /> {busy ? 'Voiding…' : 'Void anyway'}
              </Button>
            ) : (
              <Button type="submit" variant="destructive" disabled={busy}>
                <Ban aria-hidden /> {busy ? 'Voiding…' : 'Void payment'}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
