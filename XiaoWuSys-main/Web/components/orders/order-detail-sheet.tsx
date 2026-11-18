'use client';

// Order detail (ported from the OrdersPage.jsx pop-up) as a side sheet: info, deadline/quote,
// design link, materials, payments, approval and the status buttons.
//
// Every button comes from the server: orderActions(detail) reads GET /api/orders/:id
// "allowed_actions" (approve, statuses, edit_*, record_payment, max_payment, …), so this screen
// keeps no copy of the role or status rules. Cancelling is a void: the server only lists it for
// accounts with void_order.
//
// PB 5 (edit locks): while one of this sheet's edit forms is open, the tab holds the order's
// edit lock on the server (useOrderEditLock). Someone else's lock is shown as a banner; the
// server decides who gets, keeps or loses a lock, and this sheet shows the outcome.
// PB 14: the order reloads when the server says it changed ("order_updated"), and the status
// timeline shows what the server recorded.
// M6 part 2: the quote panel and the official quotation (PB 11 / PB 12), the consumables the
// status changes took from stock (PB 15) and the roster import (PB 7, in the materials section).
// M6 part 3: misprints logged against the order (PB 18 / PB 19), payment voids (PB 23, in the
// payments section) and the reason the Owner gives when cancelling (PB 23, saved and audited).
// M6 part 4: Archive / Restore (PB 23, D2) from allowed_actions.archive_order / restore_order.
// An archived order is read-only: the server sends no edit actions until it is restored.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Archive, ArchiveRestore, CircleCheck, CircleX, Copy, Flame, Lock, Printer, RotateCcw, ShieldCheck, TriangleAlert } from 'lucide-react';
import { formatDateTime, peso } from '@xiaowu/client-core/format';
import { orderNumber, shortfallLines } from '@xiaowu/client-core/orders';
import { orderActions } from '@xiaowu/client-core/permissions';
import { LogoSpinner } from '@/components/brand/brand-logo';
import { useConnection } from '@/components/connection/connection-provider';
import { ConfirmDialog } from '@/components/feedback/confirm-dialog';
import { ResultDialog, type ResultMessage } from '@/components/feedback/result-dialog';
import {
  approvalNotes,
  ApprovalPanel,
  DesignLink,
  DetailsEditor,
  MaterialsSection,
  OrderInfo,
  StatusTimeline,
} from '@/components/orders/order-sections';
import { useOrderLocks } from '@/components/providers/order-locks-provider';
import { JumpToSection, type OrderSectionKey } from '@/components/orders/jump-to-section';
import { PaymentsSection } from '@/components/orders/payments-section';
import { ConsumablesUsed, QuoteSection } from '@/components/orders/pricing-section';
import { MaterialLossesSection } from '@/components/orders/waste-section';
import { ShortageTable } from '@/components/orders/shortage-table';
import { OrderStatusBadge } from '@/components/orders/status-badges';
import { RequiredNote } from '@/components/forms/form-bits';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SHEET_SCROLL_BODY } from '@/components/ui/sheet';
import { useApi } from '@/hooks/use-api';
import { useOrderEditLock } from '@/hooks/use-order-edit-lock';
import { useSocketEvent } from '@/hooks/use-socket-event';
import { errorMessage } from '@/lib/api';
import { AWAITING_APPROVAL, type Customer, type OrderDetail, type OrderUpdated, type Payment, type Shortage } from '@/lib/orders';
import { TEXT_MAX } from '@/lib/input-limits';
import { copyText, messengerSummary, printJobOrder, printOfficialQuote, printReceipt } from '@/lib/print';
import { TONE_CLASSES } from '@/lib/ui-tokens';
import { cn } from '@/lib/utils';

// Label and icon per status button. WHICH buttons appear: allowed_actions.statuses.
const STATUS_ACTION: Record<string, { label: string; icon: typeof Printer; danger?: boolean }> = {
  Printing: { label: 'Start printing', icon: Printer },
  Pressing: { label: 'Start pressing', icon: Flame },
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
  // HCI 4-state feedback: which status button is in flight (spinner + "Updating…" on that button)
  const [pendingStatus, setPendingStatus] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [confirmApprove, setConfirmApprove] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState<'archive' | 'restore' | null>(null);
  const [shortage, setShortage] = useState<{ title: string; message: string; shortages: Shortage[] } | null>(null);
  // PB 5: which edit forms are open (the lock is held while any is), and a counter that
  // closes them all when the lock is refused or taken over
  const [openForms, setOpenForms] = useState<Record<string, boolean>>({});
  const [formsEpoch, setFormsEpoch] = useState(0);
  const reloadAfterEditing = useRef(false);
  const { lockedByOther } = useOrderLocks();

  const requestKey = `${orderId}|${tick}|${syncGeneration}`;
  const reloadDetail = useCallback(() => setTick((t) => t + 1), []);

  const editing = Object.values(openForms).some(Boolean);
  const reportDetails = useCallback((open: boolean) => setOpenForms((f) => ({ ...f, details: open })), []);
  const reportDesign = useCallback((open: boolean) => setOpenForms((f) => ({ ...f, design: open })), []);
  const reportMaterials = useCallback((open: boolean) => setOpenForms((f) => ({ ...f, materials: open })), []);
  const closeForms = useCallback(() => {
    setFormsEpoch((n) => n + 1);
    setOpenForms({});
  }, []);

  // The server refused the lock: someone of the same or a higher role is editing
  useOrderEditLock(orderId, editing, (heldByRole) => {
    closeForms();
    setResult({
      type: 'warning',
      title: 'Order is being edited',
      message: `${heldByRole ? `A ${heldByRole} user` : 'Someone else'} is editing this order right now. Try again when they finish.`,
    });
  });

  // The server handed this order's lock to someone with a higher role
  useSocketEvent<{ orderId?: string; by?: { role?: string } }>('order_lock_revoked', (payload) => {
    if (!orderId || payload?.orderId !== orderId) return;
    closeForms();
    setResult({
      type: 'warning',
      title: 'Someone took over this order',
      message: `${payload.by?.role ? `The ${payload.by.role}` : 'Someone with a higher role'} took over this order. Your unsaved changes were not saved.`,
    });
    reloadDetail();
  });

  // PB 14: this order changed somewhere (any branch). Never reload under an open form: the
  // typed values would be lost. The save then meets the server's version check instead.
  useSocketEvent<OrderUpdated>('order_updated', (payload) => {
    if (!orderId || payload?.order_id !== orderId) return;
    if (editing) reloadAfterEditing.current = true;
    else reloadDetail();
  });
  useEffect(() => {
    if (editing || !reloadAfterEditing.current) return;
    reloadAfterEditing.current = false;
    reloadDetail();
  }, [editing, reloadDetail]);

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
  const otherLock = lockedByOther(orderId);

  const sectionResult = (r: ResultMessage, reload: boolean) => {
    setResult(r);
    if (reload) {
      reloadDetail();
      onChanged();
    }
  };

  // ---- Status change (PATCH /status): stock moves on the server in the same transaction ----
  const changeStatus = async (to: string, cancellation_reason?: string) => {
    if (!order) return;
    setBusy(true);
    setPendingStatus(to);
    const { ok, data } = await api<{ message?: string; shortages?: Shortage[]; error?: string }>(
      'PATCH',
      `/orders/${encodeURIComponent(order.order_id)}/status`,
      { status: to, expected_version: order.version || undefined, ...(cancellation_reason ? { cancellation_reason } : {}) }
    );
    setBusy(false);
    setPendingStatus(null);
    setConfirmCancel(false);
    setCancelReason('');
    if (!ok && data.shortages?.length) {
      setShortage({ title: 'Not enough stock to resume', message: errorMessage(data, 'There is not enough free stock.'), shortages: data.shortages });
    } else {
      setResult(
        ok
          ? {
              type: 'success',
              title: `${orderNumber(order)} is now ${to}`,
              // The server's sentence (stock released / used, consumables taken), then where to go next
              message: [
                data.message ?? `The order is now ${to}.`,
                customer?.full_name ? `Customer: ${customer.full_name}.` : null,
                to === 'Cancelled' ? 'Payments stay on record: void them in the Payments section if money is returned.' : 'The next step’s buttons are at the bottom of this order.',
              ]
                .filter(Boolean)
                .join('\n'),
            }
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
        title: `Job order ${orderNumber(order)} approved`,
        message:
          (customer?.full_name ? `Customer: ${customer.full_name}.\n` : '') +
          (data.newly_reserved ? 'Materials reserved:\n' : 'Materials were already reserved when the order was created:\n') +
          held +
          '\nNext: production can start printing (Start printing, at the bottom of this order).',
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

  // ---- Archive / Restore (PB 23, D2; Owner / Admin, online only) ----
  const archive = async (kind: 'archive' | 'restore') => {
    if (!order) return;
    setBusy(true);
    const { ok, data } = await api<{ message?: string }>('POST', `/orders/${encodeURIComponent(order.order_id)}/${kind}`);
    setBusy(false);
    setConfirmArchive(null);
    setResult(
      ok
        ? { type: 'success', title: kind === 'archive' ? 'Order archived' : 'Order unarchived', message: data.message ?? '' }
        : { type: 'error', title: kind === 'archive' ? 'Not archived' : 'Not unarchived', message: errorMessage(data, 'Nothing was changed.') }
    );
    reloadDetail();
    onChanged();
  };

  const popupBlocked: ResultMessage = { type: 'error', title: 'Could not open the print window', message: 'Allow pop-ups for this site, then try again.' };
  const printPayment = (p: Payment) => {
    if (detail && !printReceipt(detail, p, customer)) setResult(popupBlocked);
  };
  const printOrder = () => {
    if (detail && !printJobOrder(detail, customer)) setResult(popupBlocked);
  };
  const printQuote = () => {
    if (detail && !printOfficialQuote(detail, customer)) setResult(popupBlocked);
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
      <Sheet
        open={open}
        onOpenChange={(next) => {
          if (next || busy) return;
          closeForms(); // gives the edit lock back
          onClose();
        }}
      >
        <SheetContent
          side="right"
          className="w-full gap-0 p-0 sm:max-w-2xl"
          // While an edit form is open, a stray click outside must not close the panel and lose it
          onInteractOutside={(e) => editing && e.preventDefault()}
          onEscapeKeyDown={(e) => editing && e.preventDefault()}
        >
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
                {actions.archive_order && (
                  <Button variant="outline" size="sm" onClick={() => setConfirmArchive('archive')} disabled={busy}>
                    <Archive aria-hidden /> Archive
                  </Button>
                )}
                {actions.restore_order && (
                  <Button variant="outline" size="sm" onClick={() => setConfirmArchive('restore')} disabled={busy}>
                    <ArchiveRestore aria-hidden /> Unarchive
                  </Button>
                )}
              </div>
            )}
          </SheetHeader>

          <div className={cn("min-h-0 flex-1 space-y-5 overflow-y-auto p-4", SHEET_SCROLL_BODY)} aria-busy={!detail}>
            {loadError && (
              <p role="alert" className={cn('rounded-md border p-3 text-sm', TONE_CLASSES.danger.banner)}>
                {loadError}
              </p>
            )}
            {!detail && !loadError && (
              <LogoSpinner label="Loading the order…" className="min-h-64" />
            )}

            {detail && order && (
              <>
                {otherLock && (
                  <p role="status" className={cn('flex items-start gap-2 rounded-md border p-3 text-sm', TONE_CLASSES.warning.banner)}>
                    <Lock className="mt-0.5 size-4 shrink-0" aria-hidden />
                    <span className="wrap-anywhere">
                      A {otherLock.role} user is editing this order right now. You can look, but your changes may be refused until they finish.
                    </span>
                  </p>
                )}
                {order.archived_at && (
                  <p role="status" className={cn('flex items-start gap-2 rounded-md border p-3 text-sm', TONE_CLASSES.muted.banner)}>
                    <Archive className="mt-0.5 size-4 shrink-0" aria-hidden />
                    <span>Archived on {formatDateTime(order.archived_at, { utc: true })}. It is kept for the records and cannot be changed until it is restored.</span>
                  </p>
                )}
                <OrderInfo detail={detail} customer={customer} />
                {order.production_status === 'Cancelled' && order.cancellation_reason && (
                  <p className={cn('rounded-md border p-3 text-sm wrap-anywhere', TONE_CLASSES.danger.banner)}>
                    <strong>Reason for cancelling:</strong> {order.cancellation_reason}
                  </p>
                )}
                <div className="flex flex-col gap-3">
                  <DetailsEditor
                    key={`details-${order.version}-${formsEpoch}`}
                    detail={detail}
                    actions={actions}
                    onResult={sectionResult}
                    onEditing={reportDetails}
                  />
                  <DesignLink
                    key={`design-${order.version}-${formsEpoch}`}
                    detail={detail}
                    actions={actions}
                    onResult={sectionResult}
                    onEditing={reportDesign}
                  />
                </div>
                <Separator />
                <QuoteSection key={`pricing-${order.version}`} detail={detail} actions={actions} onResult={sectionResult} onPrintQuote={printQuote} />
                <Separator />
                <MaterialsSection key={`materials-${formsEpoch}`} detail={detail} actions={actions} onResult={sectionResult} onEditing={reportMaterials} />
                <MaterialLossesSection detail={detail} actions={actions} onResult={sectionResult} />
                <Separator />
                <PaymentsSection detail={detail} actions={actions} onPrintReceipt={printPayment} onResult={sectionResult} />
                <Separator />
                <StatusTimeline detail={detail} />
                <ConsumablesUsed detail={detail} />
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
                  {approval?.blocking[0] && (
                    <span className="w-full text-xs leading-relaxed text-muted-foreground wrap-anywhere">
                      {approval.blocking[0]}
                      {approval.fixes.get(approval.blocking[0]) && (
                        <>
                          {' '}
                          <JumpToSection to={approval.fixes.get(approval.blocking[0]) as OrderSectionKey} />
                        </>
                      )}
                    </span>
                  )}
                </div>
              )}
              {footerActions.length > 0 && (
                // HCI (Fitts): destructive actions (Cancel order) come first, then a divider and 16px of
                // space, then the constructive steps with the main one at the far right, so a quick tap on
                // "Mark completed" can never land on "Cancel order".
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  {[...footerActions.filter((a) => a.danger), ...footerActions.filter((a) => !a.danger)].map((a, i, all) => {
                    // PB 9: Resume reserves stock, so it is held back while the server says stock is short
                    const blocked = a.to === 'Pending' && stockShort;
                    const Icon = a.icon;
                    const afterDanger = i > 0 && all[i - 1].danger && !a.danger;
                    return (
                      <span key={a.to} className="contents">
                        {afterDanger && <span aria-hidden className="mx-2 h-8 w-px bg-border" />}
                        <Button
                          variant={a.danger ? 'destructive' : 'default'}
                          disabled={busy || blocked}
                          busy={pendingStatus === a.to && !a.danger}
                          title={blocked ? `Not enough stock to resume: ${shortfallLines(detail?.stock_check)[0] ?? ''}` : undefined}
                          onClick={() => (a.danger ? setConfirmCancel(true) : changeStatus(a.to))}
                        >
                          <Icon aria-hidden /> {pendingStatus === a.to && !a.danger ? 'Updating…' : a.label}
                        </Button>
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>

      {/* PB 23: cancelling is a void, so the Owner gives a reason; the server saves it with an audit row */}
      <Dialog open={confirmCancel} onOpenChange={(next) => !next && !busy && setConfirmCancel(false)}>
        <DialogContent className="min-w-0 sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Cancel this order?</DialogTitle>
            <DialogDescription>
              {order?.stock_reserved
                ? 'The order will be marked Cancelled and its reserved materials returned to stock.'
                : 'The order will be marked Cancelled.'}{' '}
              Payments stay on record; void them one by one if money is returned.
            </DialogDescription>
          </DialogHeader>
          <form
            className="max-w-full min-w-0 space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (cancelReason.trim()) void changeStatus('Cancelled', cancelReason.trim());
            }}
          >
            <RequiredNote />
            <div className="min-w-0 space-y-1.5">
              <Label htmlFor="cancel-reason">Reason for cancelling <span aria-hidden className="text-danger">*</span>
                <span className="sr-only">(required)</span>
              </Label>
              <textarea
                id="cancel-reason"
                rows={3}
                required
                maxLength={TEXT_MAX.reason}
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                disabled={busy}
                placeholder="e.g. customer backed out, design was not approved"
                className="w-full min-w-0 rounded-md border bg-background px-3 py-2 text-sm shadow-xs focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setConfirmCancel(false)} disabled={busy}>
                Keep order
              </Button>
              <Button busy={busy} type="submit" variant="destructive" disabled={busy || !cancelReason.trim()}>
                <CircleX aria-hidden /> {busy ? 'Cancelling…' : 'Cancel order'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={Boolean(confirmArchive)}
        title={confirmArchive === 'restore' ? 'Unarchive this order?' : 'Archive this order?'}
        message={
          confirmArchive === 'restore'
            ? 'The order comes back to the Orders list and can be changed again.'
            : 'The order is hidden from the Orders list and can no longer be changed. It is never deleted, and it can be unarchived later.'
        }
        confirmLabel={confirmArchive === 'restore' ? 'Unarchive order' : 'Archive order'}
        busy={busy}
        busyLabel={confirmArchive === 'restore' ? 'Unarchiving…' : 'Archiving…'}
        onConfirm={() => confirmArchive && archive(confirmArchive)}
        onCancel={() => setConfirmArchive(null)}
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
        busyLabel="Approving…"
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
