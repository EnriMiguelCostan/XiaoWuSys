'use client';

// Order detail (ported from the OrdersPage.jsx pop-up) as a side sheet: info, deadline/quote,
// design link, materials, payments, approval and the status buttons.
//
// Every button comes from the server: orderActions(detail) reads GET /api/orders/:id
// "allowed_actions" (approve, statuses, edit_*, record_payment, max_payment, …), so this screen
// keeps no copy of the role or status rules. Cancelling is a void: the server only lists it for
// accounts with void_order.
import { useCallback, useEffect, useState } from 'react';
import { CircleCheck, CircleX, Copy, Printer, RotateCcw, ShieldCheck, TriangleAlert } from 'lucide-react';
import { formatDateTime, peso } from '@xiaowu/client-core/format';
import { orderNumber, shortfallLines } from '@xiaowu/client-core/orders';
import { orderActions } from '@xiaowu/client-core/permissions';
import { useConnection } from '@/components/connection/connection-provider';
import { ConfirmDialog } from '@/components/feedback/confirm-dialog';
import { ResultDialog, type ResultMessage } from '@/components/feedback/result-dialog';
import { approvalNotes, ApprovalPanel, DesignLink, DetailsEditor, MaterialsSection, OrderInfo } from '@/components/orders/order-sections';
import { PaymentsSection } from '@/components/orders/payments-section';
import { ShortageTable } from '@/components/orders/shortage-table';
import { OrderStatusBadge } from '@/components/orders/status-badges';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Separator } from '@/components/ui/separator';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/hooks/use-api';
import { useSocketEvent } from '@/hooks/use-socket-event';
import { errorMessage } from '@/lib/api';
import { AWAITING_APPROVAL, type Customer, type OrderDetail, type Payment, type Shortage } from '@/lib/orders';
import { copyText, messengerSummary, printJobOrder, printReceipt } from '@/lib/print';
import { TONE_CLASSES } from '@/lib/ui-tokens';
import { cn } from '@/lib/utils';

// Label and icon per status button. WHICH buttons appear: allowed_actions.statuses.
const STATUS_ACTION: Record<string, { label: string; icon: typeof Printer; danger?: boolean }> = {
  Printing: { label: 'Start printing', icon: Printer },
  Completed: { label: 'Mark completed', icon: CircleCheck },
  Pending: { label: 'Resume (reserve stock)', icon: RotateCcw },
  Cancelled: { label: 'Cancel order', icon: CircleX, danger: true },
};
const statusAction = (to: string) => ({ to, ...(STATUS_ACTION[to] ?? { label: to, icon: CircleCheck }) });

type Loaded = { key: string; detail: OrderDetail | null; error: string };

interface ApproveError {
  error?: string;
  message?: string;
  shortages?: Shortage[];
  remaining?: number;
  total_paid?: number;
  required_downpayment?: number;
  total_quote_amount?: number;
  unsynced_payments?: number;
  unlinked_line_item_ids?: string[];
  lock?: { role?: string; expiresAt?: string };
}

export function OrderDetailSheet({
  orderId,
  customerById,
  onClose,
  onChanged,
}: {
  orderId: string | null;
  customerById: Map<string, Customer>;
  onClose: () => void;
  /** something on the order changed: the list should reload */
  onChanged: () => void;
}) {
  const api = useApi();
  const { syncGeneration } = useConnection();
  const [tick, setTick] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ResultMessage | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [confirmApprove, setConfirmApprove] = useState(false);
  const [shortage, setShortage] = useState<{ title: string; message: string; shortages: Shortage[] } | null>(null);

  const requestKey = `${orderId}|${tick}|${syncGeneration}`;
  const reloadDetail = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!orderId) return undefined;
    let cancelled = false;
    api<OrderDetail>('GET', `/orders/${encodeURIComponent(orderId)}`).then(({ ok, data }) => {
      if (cancelled) return;
      setLoaded(
        ok && data.order
          ? { key: requestKey, detail: data, error: '' }
          : { key: requestKey, detail: null, error: errorMessage(data, 'Could not load this order.') }
      );
    });
    return () => {
      cancelled = true;
    };
  }, [api, orderId, requestKey]);

  // Stock moved somewhere: the stock check of an unapproved order may have changed
  useSocketEvent('inventory_updated', () => {
    if (orderId) reloadDetail();
  });

  // Keep showing this order while it reloads; never show another order's data
  const detail = loaded?.detail && loaded.detail.order.order_id === orderId ? loaded.detail : null;
  const loadError = loaded && loaded.key === requestKey ? loaded.error : '';
  const order = detail?.order;
  const actions = orderActions(detail);
  const customer = order ? customerById.get(order.customer_id) : undefined;
  const awaitingApproval = Boolean(order && AWAITING_APPROVAL.includes(order.production_status) && detail?.totals.downpayment);
  const approval = detail && awaitingApproval ? approvalNotes(detail) : null;
  const stockShort = Boolean(detail?.stock_check && !detail.stock_check.sufficient);
  const footerActions = order ? actions.statuses.map(statusAction) : [];

  const sectionResult = (r: ResultMessage, reload: boolean) => {
    setResult(r);
    if (reload) {
      reloadDetail();
      onChanged();
    }
  };

  // ---- Status change (PATCH /status): stock moves on the server in the same transaction ----
  const changeStatus = async (to: string) => {
    if (!order) return;
    setBusy(true);
    const { ok, data } = await api<{ message?: string; shortages?: Shortage[]; error?: string }>(
      'PATCH',
      `/orders/${encodeURIComponent(order.order_id)}/status`,
      { status: to, expected_version: order.version || undefined }
    );
    setBusy(false);
    setConfirmCancel(false);
    if (!ok && data.shortages?.length) {
      setShortage({ title: 'Not enough stock to resume', message: errorMessage(data, 'There is not enough free stock.'), shortages: data.shortages });
    } else {
      setResult(
        ok
          ? { type: 'success', title: `Order ${to}`, message: data.message ?? `The order is now ${to}.` }
          : { type: 'error', title: 'Status not changed', message: errorMessage(data, 'Could not change the status.') }
      );
    }
    reloadDetail();
    onChanged();
  };

  // ---- Approve (Owner, PB 13): the server re-checks everything in one transaction ----
  const approve = async () => {
    if (!order) return;
    setBusy(true);
    const { ok, status, data } = await api<ApproveError & { reserved?: { item_name?: string; inventory_id: string; quantity: number }[]; newly_reserved?: boolean }>(
      'POST',
      `/orders/${encodeURIComponent(order.order_id)}/approve`,
      { expected_version: order.version || '' }
    );
    setBusy(false);
    setConfirmApprove(false);

    if (ok) {
      const held = (data.reserved ?? []).map((x) => `• ${x.item_name || 'Material'}: ${x.quantity}`).join('\n');
      setResult({
        type: 'success',
        title: 'Job order approved',
        message: (data.newly_reserved ? 'Materials reserved:\n' : 'Materials were already reserved when the order was created:\n') + held,
      });
      reloadDetail();
      onChanged();
      return;
    }

    const err = data.error;
    if (status === 409 && err === 'INSUFFICIENT_INVENTORY') {
      setShortage({
        title: 'Not enough stock to approve',
        message: data.message || 'Not enough free stock to approve this job order. Nothing was reserved.',
        shortages: data.shortages ?? [],
      });
      return;
    }
    if (status === 402) {
      setResult({
        type: 'warning',
        title: 'Downpayment required',
        message:
          `${peso(data.remaining)} more is needed before this job order can be approved.\n` +
          `Paid ${peso(data.total_paid)} of the ${peso(data.required_downpayment)} required (50% of ${peso(data.total_quote_amount)}).` +
          (data.unsynced_payments ? `\n${data.unsynced_payments} payment(s) saved offline do not count yet. Sync, then try again.` : ''),
      });
      return;
    }
    if (status === 409 && (err === 'EDIT_CONFLICT' || err === 'ALREADY_APPROVED')) {
      setResult({
        type: 'warning',
        title: err === 'ALREADY_APPROVED' ? 'Already approved' : 'Order changed',
        message:
          err === 'ALREADY_APPROVED'
            ? 'Someone already approved this job order. It has been reloaded.'
            : 'This order was changed by someone else after you opened it. It has been reloaded: check it again, then approve.',
      });
      reloadDetail();
      return;
    }
    if (status === 409 && err === 'ORDER_LOCKED') {
      const until = data.lock?.expiresAt ? ` until ${formatDateTime(data.lock.expiresAt.replace('Z', ''), { utc: true })} at the latest` : '';
      setResult({
        type: 'warning',
        title: 'Order is being edited',
        message: `A ${data.lock?.role || 'another'} user is editing this order right now${until}. Try again when they finish.`,
      });
      return;
    }
    if (status === 503 || status === 0) {
      setResult({ type: 'error', title: 'Approval needs an internet connection', message: errorMessage(data, 'Nothing was changed. Try again when the connection is back.') });
      return;
    }
    if (status === 422 && err === 'ITEMS_NOT_LINKED_TO_STOCK') {
      const n = data.unlinked_line_item_ids?.length ?? 0;
      setResult({
        type: 'warning',
        title: 'Materials not linked to stock',
        message: n ? `${n} item(s) on this order are not linked to a stock item, so their stock cannot be reserved.` : errorMessage(data, 'Add materials first.'),
      });
      return;
    }
    setResult({ type: 'error', title: 'Not approved', message: errorMessage(data, 'Could not approve this job order.') });
  };

  const popupBlocked: ResultMessage = { type: 'error', title: 'Could not open the print window', message: 'Allow pop-ups for this site, then try again.' };
  const printPayment = (p: Payment) => {
    if (detail && !printReceipt(detail, p, customer)) setResult(popupBlocked);
  };
  const printOrder = () => {
    if (detail && !printJobOrder(detail, customer)) setResult(popupBlocked);
  };
  const copySummary = async () => {
    if (!detail) return;
    const ok = await copyText(messengerSummary(detail, customer));
    setResult(
      ok
        ? { type: 'success', title: 'Copied for Messenger', message: 'The order summary was copied. Paste it into the customer’s Messenger chat.' }
        : { type: 'error', title: 'Could not copy', message: 'Your browser blocked copying.' }
    );
  };

  const open = Boolean(orderId);

  return (
    <>
      <Sheet open={open} onOpenChange={(next) => !next && !busy && onClose()}>
        <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-2xl">
          <SheetHeader className="border-b pr-12">
            <SheetTitle className="flex flex-wrap items-center gap-2">
              <span>Order</span>
              <code className="font-mono wrap-anywhere">{order ? orderNumber(order) : '…'}</code>
              {order && <OrderStatusBadge status={order.production_status} />}
            </SheetTitle>
            <SheetDescription className="min-w-0 truncate" title={customer?.full_name}>
              {customer?.full_name ?? (order ? 'Unknown customer' : 'Loading the order…')}
            </SheetDescription>
            {order && (
              <div className="flex flex-wrap gap-2 pt-1">
                <Button variant="outline" size="sm" onClick={copySummary}>
                  <Copy aria-hidden /> Copy for Messenger
                </Button>
                <Button variant="outline" size="sm" onClick={printOrder}>
                  <Printer aria-hidden /> Print job order
                </Button>
              </div>
            )}
          </SheetHeader>

          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4" aria-busy={!detail}>
            {loadError && (
              <p role="alert" className={cn('rounded-md border p-3 text-sm', TONE_CLASSES.danger.banner)}>
                {loadError}
              </p>
            )}
            {!detail && !loadError && (
              <div className="space-y-3" role="status" aria-label="Loading the order">
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-32 w-full" />
                <Skeleton className="h-24 w-full" />
              </div>
            )}

            {detail && order && (
              <>
                <OrderInfo detail={detail} customer={customer} />
                <div className="flex flex-col gap-3">
                  <DetailsEditor key={`details-${order.version}`} detail={detail} actions={actions} onResult={sectionResult} />
                  <DesignLink key={`design-${order.version}`} detail={detail} actions={actions} onResult={sectionResult} />
                </div>
                <Separator />
                <MaterialsSection detail={detail} actions={actions} onResult={sectionResult} />
                <Separator />
                <PaymentsSection detail={detail} actions={actions} onPrintReceipt={printPayment} onResult={sectionResult} />
                {awaitingApproval && <ApprovalPanel detail={detail} canApprove={actions.approve} />}
                {order.sync_status !== 'synced' && (
                  <p className="text-sm text-muted-foreground">This order was saved offline. Status changes are available once it syncs.</p>
                )}
              </>
            )}
          </div>

          {/* Actions stay visible while the details scroll */}
          {order && ((awaitingApproval && actions.approve) || footerActions.length > 0) && (
            <div className="flex flex-wrap items-center gap-2 border-t bg-muted/30 p-4">
              {awaitingApproval && actions.approve && (
                <div className="flex min-w-0 flex-[1_1_16rem] flex-col gap-1">
                  <Button
                    className="w-fit"
                    disabled={busy || Boolean(approval?.blocking.length)}
                    onClick={() => setConfirmApprove(true)}
                  >
                    <ShieldCheck aria-hidden /> Approve job order
                  </Button>
                  {approval?.blocking[0] && <span className="w-full text-xs text-muted-foreground wrap-anywhere">{approval.blocking[0]}</span>}
                </div>
              )}
              {footerActions.length > 0 && (
                <div className="ml-auto flex flex-wrap gap-2">
                  {footerActions.map((a) => {
                    // PB 9: Resume reserves stock, so it is held back while the server says stock is short
                    const blocked = a.to === 'Pending' && stockShort;
                    const Icon = a.icon;
                    return (
                      <Button
                        key={a.to}
                        variant={a.danger ? 'destructive' : 'default'}
                        disabled={busy || blocked}
                        title={blocked ? `Not enough stock to resume: ${shortfallLines(detail?.stock_check)[0] ?? ''}` : undefined}
                        onClick={() => (a.danger ? setConfirmCancel(true) : changeStatus(a.to))}
                      >
                        <Icon aria-hidden /> {a.label}
                      </Button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>

      <ConfirmDialog
        open={confirmCancel}
        title="Cancel this order?"
        message={
          order?.stock_reserved
            ? 'The order will be marked Cancelled and its reserved materials returned to stock.'
            : 'The order will be marked Cancelled.'
        }
        confirmLabel="Cancel order"
        danger
        busy={busy}
        onConfirm={() => changeStatus('Cancelled')}
        onCancel={() => setConfirmCancel(false)}
      />
      <ConfirmDialog
        open={confirmApprove}
        title="Approve this job order?"
        message={
          order?.stock_reserved
            ? 'The order moves to Approved and printing can start. Its materials are already reserved.'
            : 'The order moves to Approved and its materials are reserved from stock now.'
        }
        confirmLabel="Approve job order"
        busy={busy}
        onConfirm={approve}
        onCancel={() => setConfirmApprove(false)}
      />

      <Dialog open={Boolean(shortage)} onOpenChange={(next) => !next && setShortage(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-warning">
              <TriangleAlert className="size-5" aria-hidden /> {shortage?.title}
            </DialogTitle>
            <DialogDescription className="wrap-anywhere">{shortage?.message}</DialogDescription>
          </DialogHeader>
          {shortage && <ShortageTable shortages={shortage.shortages} />}
          <DialogFooter>
            <Button onClick={() => setShortage(null)} autoFocus>
              OK
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ResultDialog result={result} onClose={() => setResult(null)} />
    </>
  );
}
