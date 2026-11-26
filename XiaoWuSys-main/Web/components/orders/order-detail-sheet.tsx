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
// Migration 016 (adviser consultation, second round): the order opens in the CENTRE of the
// screen as a large dialog (not full screen) over a blurred background, instead of a panel on the
// right. "Waste" has its own tab, design files can be uploaded from the computer, a job order can
// be approved without a quote (Owner or Admin), and Ready sits between production and the hand-over.
// Migration 015 (adviser consultation): the order profile is full screen. The left column keeps
// who / when / money and what the order still needs (approval, or completion); the right side
// splits the order into tabs (Details, Materials & print, Quote, Payments, Deliveries, History)
// instead of one long scroll. "Mark completed" follows the server's completion check
// (allowed_actions.complete_blocked_reason / complete_with_balance, detail.completion).
import { useCallback, useEffect, useRef, useState } from 'react';
import { Archive, ArchiveRestore, CircleCheck, CircleDashed, CircleX, Copy, Flame, Lock, PackageCheck, Printer, RotateCcw, ShieldCheck, TriangleAlert } from 'lucide-react';
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
import { JumpToSection, ORDER_SECTION_EVENT, type OrderSectionKey } from '@/components/orders/jump-to-section';
import { DeliveriesSection } from '@/components/orders/deliveries-section';
import { PaymentsSection } from '@/components/orders/payments-section';
import { PrintDetailsSection } from '@/components/orders/print-details-section';
import { ConsumablesUsed, PriceCutPanel, QuoteSection } from '@/components/orders/pricing-section';
import { MaterialLossesSection } from '@/components/orders/waste-section';
import { ProductionSection } from '@/components/orders/production-section';
import { ShortageTable } from '@/components/orders/shortage-table';
import { OrderStatusBadge, PaymentStatusBadge } from '@/components/orders/status-badges';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { SHEET_SCROLL_BODY } from '@/components/ui/sheet';
import { DesignFilesSection } from '@/components/orders/design-files-section';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
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
  Printing: { label: 'Start production (printing / pressing)', icon: Printer },
  Pressing: { label: 'Start pressing', icon: Flame },
  Ready: { label: 'Mark ready (every piece done)', icon: PackageCheck },
  Completed: { label: 'Mark completed (handed over and paid)', icon: CircleCheck },
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
  const [tab, setTab] = useState('details');
  const [completing, setCompleting] = useState<{ unpaid: boolean } | null>(null);
  // migration 017: a step that first marks every piece printed / ready (the server asks for complete_counts)
  const [confirmCounts, setConfirmCounts] = useState<string | null>(null);
  const [printedOnCancel, setPrintedOnCancel] = useState<Record<string, string>>({});
  const [shopFault, setShopFault] = useState(false);
  const [handoverName, setHandoverName] = useState('');
  const [handoverMethod, setHandoverMethod] = useState('Pick-up');
  const { lockedByOther } = useOrderLocks();

  const requestKey = `${orderId}|${tick}|${syncGeneration}`;
  const reloadDetail = useCallback(() => setTick((t) => t + 1), []);

  const editing = Object.values(openForms).some(Boolean);
  const reportDetails = useCallback((open: boolean) => setOpenForms((f) => ({ ...f, details: open })), []);
  const reportDesign = useCallback((open: boolean) => setOpenForms((f) => ({ ...f, design: open })), []);
  const reportMaterials = useCallback((open: boolean) => setOpenForms((f) => ({ ...f, materials: open })), []);
  const reportPrints = useCallback((open: boolean) => setOpenForms((f) => ({ ...f, prints: open })), []);

  // "Go to the quote" etc. (jump-to-section.tsx) opens the section's tab first
  useEffect(() => {
    const onJump = (e: Event) => {
      const next = (e as CustomEvent<string>).detail;
      if (typeof next === 'string') setTab(next);
    };
    window.addEventListener(ORDER_SECTION_EVENT, onJump);
    return () => window.removeEventListener(ORDER_SECTION_EVENT, onJump);
  }, []);
  // A different order opens on its first tab (state adjusted while rendering, as React recommends)
  const [tabOrder, setTabOrder] = useState(orderId);
  if (tabOrder !== orderId) {
    setTabOrder(orderId);
    setTab('details');
  }
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
  const changeStatus = async (to: string, cancellation_reason?: string, extra: Record<string, unknown> = {}) => {
    if (!order) return;
    setBusy(true);
    setPendingStatus(to);
    const { ok, data } = await api<{ message?: string; shortages?: Shortage[]; error?: string }>(
      'PATCH',
      `/orders/${encodeURIComponent(order.order_id)}/status`,
      { status: to, expected_version: order.version || undefined, ...(cancellation_reason ? { cancellation_reason } : {}), ...extra }
    );
    setBusy(false);
    setPendingStatus(null);
    setConfirmCancel(false);
    setConfirmCounts(null);
    setCancelReason('');
    setShopFault(false);
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
                to === 'Cancelled' ? 'Refund the suggested amount under Payments if money goes back to the customer.' : 'The next step’s buttons are at the bottom of this order.',
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

  // ---- Approve (Owner or Admin, PB 13): the server re-checks everything in one transaction ----
  const approve = async () => {
    if (!order) return;
    setBusy(true);
    const { ok, status, data } = await api<ApproveError & { reserved?: { item_name?: string; inventory_id: string; quantity: number }[]; newly_reserved?: boolean }>(
      'POST',
      `/orders/${encodeURIComponent(order.order_id)}/approve`,
      // Migration 016: the quote is optional; with none, the approver confirmed going ahead without one
      { expected_version: order.version || '', ...(actions.approve_without_quote ? { without_quote: true } : {}) }
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
          (actions.approve_without_quote ? '\nNo quote was set: the Owner can still set the price before the order is completed.' : '') +
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
  const completion = detail?.completion;
  const fulfillment = detail?.fulfillment;
  const closed = order ? ['Completed', 'Cancelled'].includes(order.production_status) : false;

  // Mark completed: when no batch was recorded, ask who took the pieces (the server records the
  // hand-over); the Owner may complete with a balance due after confirming it.
  const askComplete = () => {
    if (!detail || !order) return;
    setHandoverName(customer?.full_name ?? '');
    setHandoverMethod('Pick-up');
    setCompleting({ unpaid: false });
  };
  const sendComplete = async (unpaid: boolean) => {
    if (!order) return;
    setBusy(true);
    setPendingStatus('Completed');
    const { ok, data } = await api<{ message?: string; error?: string; missing?: { message: string }[] }>(
      'PATCH',
      `/orders/${encodeURIComponent(order.order_id)}/status`,
      {
        status: 'Completed',
        expected_version: order.version || undefined,
        ...(unpaid ? { allow_unpaid: true } : {}),
        ...(completion?.auto_handover ? { handover: { received_by_name: handoverName.trim() || undefined, method: handoverMethod } } : {}),
      }
    );
    setBusy(false);
    setPendingStatus(null);
    setCompleting(null);
    setResult(
      ok
        ? { type: 'success', title: `${orderNumber(order)} is completed`, message: data.message ?? 'The order is completed.' }
        : { type: 'warning', title: 'Not completed yet', message: errorMessage(data, 'The order could not be completed.') }
    );
    reloadDetail();
    onChanged();
  };

  return (
    <>
      <Dialog page
        open={open}
        onOpenChange={(next) => {
          if (next || busy) return;
          closeForms(); // gives the edit lock back
          onClose();
        }}
      >
        <DialogContent
          // Adviser consultation (second round): centred, large but not full screen, with the
          // page behind it blurred. While an edit form is open, a stray click outside or Escape
          // must not close it and lose what was typed (dismissible only when nothing is open).
          dismissible={!editing}
          overlayClassName="bg-black/30 supports-backdrop-filter:backdrop-blur-sm"
          className="flex h-[min(92dvh,64rem)] w-[min(96vw,84rem)] max-w-[96vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(96vw,84rem)]"
        >
          <DialogHeader className="border-b p-4 pr-12">
            <DialogTitle className="flex flex-wrap items-center gap-2">
              <span>Order</span>
              <code className="font-mono wrap-anywhere">{order ? orderNumber(order) : '…'}</code>
              {order && <OrderStatusBadge status={order.production_status} />}
              {detail && <PaymentStatusBadge status={detail.totals.payment_status} />}
            </DialogTitle>
            <DialogDescription className="min-w-0 truncate" title={customer?.full_name}>
              {customer?.full_name ?? (order ? 'Unknown customer' : 'Loading the order…')}
              {detail?.branch && ` · ${detail.branch.branch_name}`}
              {fulfillment && fulfillment.pieces_ordered > 0 && ` · ${fulfillment.label}`}
            </DialogDescription>
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
          </DialogHeader>

          <div className={cn('min-h-0 flex-1 overflow-y-auto', SHEET_SCROLL_BODY)} aria-busy={!detail}>
            {loadError && (
              <p role="alert" className={cn('m-4 rounded-md border p-3 text-sm', TONE_CLASSES.danger.banner)}>
                {loadError}
              </p>
            )}
            {!detail && !loadError && <LogoSpinner label="Loading the order…" className="min-h-64" />}

            {detail && order && (
              <div className="mx-auto grid max-w-[110rem] gap-5 p-4 lg:grid-cols-[minmax(18rem,24rem)_minmax(0,1fr)]">
                {/* Left: who, when, money, and what is still needed */}
                <aside className="min-w-0 space-y-4 lg:sticky lg:top-0 lg:self-start">
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
                  {awaitingApproval && <ApprovalPanel detail={detail} canApprove={actions.approve} />}
                  {!closed && completion && !awaitingApproval && <CompletionChecklist detail={detail} />}
                  {order.sync_status !== 'synced' && (
                    <p className="text-sm text-muted-foreground">This order was saved offline. Status changes are available once it syncs.</p>
                  )}
                </aside>

                {/* Right: the order's parts, one tab at a time (no long scroll) */}
                <Tabs value={tab} onValueChange={setTab} className="min-w-0">
                  <TabsList aria-label="Parts of this order">
                    <TabsTrigger value="details">Details</TabsTrigger>
                    <TabsTrigger value="materials">
                      Materials &amp; print
                      {(detail.print_details?.length ?? 0) > 0 && <CountBadge n={detail.print_details?.length ?? 0} />}
                    </TabsTrigger>
                    <TabsTrigger value="quote">Quote</TabsTrigger>
                    <TabsTrigger value="payments">
                      Payments
                      {detail.payments.length > 0 && <CountBadge n={detail.payments.length} />}
                    </TabsTrigger>
                    <TabsTrigger value="deliveries">
                      Deliveries
                      {(detail.delivery_plans?.length || detail.deliveries?.length || 0) > 0 && (
                        <CountBadge n={detail.delivery_plans?.length || detail.deliveries?.length || 0} />
                      )}
                    </TabsTrigger>
                    <TabsTrigger value="waste">
                      Waste
                      {(detail.material_losses?.length ?? 0) > 0 && <CountBadge n={detail.material_losses?.length ?? 0} />}
                    </TabsTrigger>
                    <TabsTrigger value="history">History</TabsTrigger>
                  </TabsList>

                  <TabsContent value="details">
                    <div className="flex flex-col gap-3">
                      <DetailsEditor key={`details-${order.version}-${formsEpoch}`} detail={detail} actions={actions} onResult={sectionResult} onEditing={reportDetails} />
                      <DesignLink key={`design-${order.version}-${formsEpoch}`} detail={detail} actions={actions} onResult={sectionResult} onEditing={reportDesign} />
                      <DesignFilesSection detail={detail} actions={actions} onResult={sectionResult} />
                    </div>
                    {!order.order_description && actions.edit_description && (
                      <p className="text-sm text-muted-foreground">No description yet. Use “Edit” to write what the customer wants (design, colours, placement).</p>
                    )}
                  </TabsContent>

                  <TabsContent value="materials">
                    <MaterialsSection key={`materials-${formsEpoch}`} detail={detail} actions={actions} onResult={sectionResult} onEditing={reportMaterials} />
                    <Separator />
                    <PrintDetailsSection key={`prints-${formsEpoch}`} detail={detail} actions={actions} onResult={sectionResult} onEditing={reportPrints} />
                    <ConsumablesUsed detail={detail} />
                    <Separator />
                    <ProductionSection key={`production-${order.version}`} detail={detail} actions={actions} onResult={sectionResult} />
                  </TabsContent>

                  {/* Adviser consultation (second round): the order's wastage in its own tab */}
                  <TabsContent value="waste">
                    <MaterialLossesSection detail={detail} actions={actions} onResult={sectionResult} />
                  </TabsContent>

                  <TabsContent value="quote">
                    <QuoteSection key={`pricing-${order.version}`} detail={detail} actions={actions} onResult={sectionResult} onPrintQuote={printQuote} />
                    <PriceCutPanel key={`cut-${order.version}`} detail={detail} actions={actions} onResult={sectionResult} />
                  </TabsContent>

                  <TabsContent value="payments">
                    <PaymentsSection detail={detail} actions={actions} onPrintReceipt={printPayment} onResult={sectionResult} />
                  </TabsContent>

                  <TabsContent value="deliveries">
                    <DeliveriesSection detail={detail} actions={actions} onResult={sectionResult} />
                  </TabsContent>

                  <TabsContent value="history">
                    <StatusTimeline detail={detail} />
                  </TabsContent>
                </Tabs>
              </div>
            )}
          </div>

          {/* Actions stay visible while the details scroll */}
          {order && ((awaitingApproval && actions.approve) || footerActions.length > 0) && (
            <div className="flex flex-wrap items-center gap-2 border-t bg-muted/30 p-4">
              {awaitingApproval && actions.approve && (
                <div className="flex min-w-0 flex-[1_1_16rem] flex-col gap-1">
                  <Button className="w-fit" disabled={busy || Boolean(approval?.blocking.length)} onClick={() => setConfirmApprove(true)}>
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
              {actions.complete_blocked_reason && footerActions.some((a) => a.to === 'Completed') && (
                <p className="min-w-0 flex-[1_1_16rem] text-xs leading-relaxed text-muted-foreground wrap-anywhere">
                  <strong className="text-foreground">Not ready to complete:</strong> {actions.complete_blocked_reason}
                </p>
              )}
              {footerActions.length > 0 && (
                // HCI (Fitts): destructive actions (Cancel order) come first, then a divider and 16px of
                // space, then the constructive steps with the main one at the far right, so a quick tap on
                // "Mark completed" can never land on "Cancel order".
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  {[...footerActions.filter((a) => a.danger), ...footerActions.filter((a) => !a.danger)].map((a, i, all) => {
                    // PB 9: Resume reserves stock, so it is held back while the server says stock is short
                    const stockBlocked = a.to === 'Pending' && stockShort;
                    // Migration 015: Completed waits for the server's requirements (paid, delivered)
                    const completeBlocked = a.to === 'Completed' && Boolean(actions.complete_blocked_reason) && !actions.complete_with_balance;
                    const Icon = a.icon;
                    const afterDanger = i > 0 && all[i - 1].danger && !a.danger;
                    const onClick = a.danger
                      ? () => {
                          setPrintedOnCancel(Object.fromEntries((detail?.progress?.lines ?? []).map((l) => [l.line_item_id, String(l.printed)])));
                          setShopFault(false);
                          setConfirmCancel(true);
                        }
                      : a.to === 'Completed'
                        ? askComplete
                        : actions.status_needs_confirm?.[a.to]
                          ? () => setConfirmCounts(a.to)
                          : () => changeStatus(a.to);
                    return (
                      <span key={a.to} className="contents">
                        {afterDanger && <span aria-hidden className="mx-2 h-8 w-px bg-border" />}
                        <Button
                          variant={a.danger ? 'destructive' : 'default'}
                          disabled={busy || stockBlocked || completeBlocked}
                          busy={pendingStatus === a.to && !a.danger}
                          title={
                            stockBlocked
                              ? `Not enough stock to resume: ${shortfallLines(detail?.stock_check)[0] ?? ''}`
                              : completeBlocked
                                ? actions.complete_blocked_reason ?? undefined
                                : a.to === 'Pressing'
                                  ? 'Pressing: the heat press, for T-shirts'
                                  : a.to === 'Ready'
                                    ? 'Production is done: the order waits to be picked up or delivered'
                                    : undefined
                          }
                          onClick={onClick}
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
        </DialogContent>
      </Dialog>

      {/* Migration 015: completing records who took the pieces when no batch was recorded */}
      <Dialog open={Boolean(completing)} onOpenChange={(next) => !next && !busy && setCompleting(null)}>
        <DialogContent className="min-w-0 sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Complete this order?</DialogTitle>
            <DialogDescription>
              {completion?.auto_handover
                ? `No batch was recorded, so all ${fulfillment?.pieces_ordered ?? ''} pieces are handed over now.`
                : 'Every piece was handed over.'}{' '}
              The reserved materials are used up from stock.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {completion?.auto_handover && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="handover-name">Received by</Label>
                  <input
                    id="handover-name"
                    maxLength={255}
                    value={handoverName}
                    onChange={(e) => setHandoverName(e.target.value)}
                    className="h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="handover-method">How</Label>
                  <select
                    id="handover-method"
                    value={handoverMethod}
                    onChange={(e) => setHandoverMethod(e.target.value)}
                    className="h-9 w-full rounded-lg border border-input bg-background px-2.5 text-sm"
                  >
                    {['Pick-up', 'Delivery', 'Courier'].map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}
            {actions.complete_with_balance && (
              <p className={cn('flex gap-2 rounded-md border p-3 text-sm', TONE_CLASSES.warning.banner)}>
                <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>
                  {peso(completion?.balance_due ?? 0)} is still unpaid. As the Owner you may hand it over now; the balance stays on the order and
                  in Unpaid balances.
                </span>
              </p>
            )}
            {(completion?.warnings ?? []).map((w) => (
              <p key={w.code} className="text-sm text-muted-foreground">
                {w.message}
              </p>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCompleting(null)} disabled={busy}>
              Not yet
            </Button>
            <Button busy={busy} onClick={() => void sendComplete(Boolean(actions.complete_with_balance))} disabled={busy}>
              <CircleCheck aria-hidden /> {actions.complete_with_balance ? 'Complete with balance due' : 'Mark completed'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* PB 23: cancelling is a void, so the Owner gives a reason; the server saves it with an audit row */}
      <Dialog open={confirmCancel} onOpenChange={(next) => !next && !busy && setConfirmCancel(false)}>
        <DialogContent className="min-w-0 sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Cancel this order?</DialogTitle>
            <DialogDescription>
              {order?.stock_reserved
                ? 'The order will be marked Cancelled. Materials not yet printed go back to stock; pieces already made are recorded as waste.'
                : 'The order will be marked Cancelled.'}
            </DialogDescription>
          </DialogHeader>
          <form
            className="max-w-full min-w-0 space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!cancelReason.trim()) return;
              const printed = order?.production_status === 'Printing'
                ? (detail?.progress?.lines ?? []).map((l) => ({ line_item_id: l.line_item_id, quantity: Number(printedOnCancel[l.line_item_id] ?? l.printed) }))
                : undefined;
              void changeStatus('Cancelled', cancelReason.trim(), { ...(printed ? { printed } : {}), ...(shopFault ? { shop_fault: true } : {}) });
            }}
          >
            <RequiredNote />
            {detail?.cancel_terms && (
              <div className="space-y-1 rounded-md border bg-muted/30 p-3 text-sm">
                <p>{shopFault ? "The shop's fault: nothing is kept, everything paid is refunded." : detail.cancel_terms.rule}</p>
                <p className="tabular-nums">
                  Paid {peso(detail.cancel_terms.paid)} · the shop keeps {peso(shopFault ? 0 : detail.cancel_terms.kept)} ·{' '}
                  <strong>suggested refund {peso(shopFault ? detail.cancel_terms.paid : detail.cancel_terms.suggested_refund)}</strong>
                </p>
              </div>
            )}
            {order?.production_status === 'Printing' && (detail?.progress?.lines.length ?? 0) > 0 && (
              <fieldset className="min-w-0 space-y-2">
                <legend className="text-sm font-medium">Pieces already printed (recorded as waste; at least what is recorded)</legend>
                {detail?.progress?.lines.map((l) => (
                  <div key={l.line_item_id} className="flex items-center justify-between gap-3 text-sm">
                    <Label htmlFor={`printed-${l.line_item_id}`} className="min-w-0 font-normal wrap-anywhere">
                      {l.product_type} <span className="text-muted-foreground">(of {l.quantity})</span>
                    </Label>
                    <Input
                      id={`printed-${l.line_item_id}`}
                      type="number"
                      min={l.printed}
                      max={l.quantity}
                      step={1}
                      inputMode="numeric"
                      className="h-8 w-24 text-right"
                      value={printedOnCancel[l.line_item_id] ?? ''}
                      onChange={(e) => setPrintedOnCancel((c) => ({ ...c, [l.line_item_id]: e.target.value }))}
                      disabled={busy}
                    />
                  </div>
                ))}
              </fieldset>
            )}
            {order && !['Pending', 'Delayed'].includes(order.production_status) && (
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-1" checked={shopFault} onChange={(e) => setShopFault(e.target.checked)} disabled={busy} />
                <span>It was the shop&apos;s fault (late beyond 7 days, cannot deliver, wrong job): refund everything paid.</span>
              </label>
            )}
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
        open={Boolean(confirmCounts)}
        title={confirmCounts === 'Pressing' ? 'Is every piece printed?' : 'Is every piece done?'}
        message={
          confirmCounts === 'Pressing'
            ? `${detail?.progress?.printed ?? 0} of ${detail?.progress?.pieces ?? 0} pieces are recorded as printed. Starting pressing marks all of them printed.`
            : `${detail?.progress?.ready ?? 0} of ${detail?.progress?.pieces ?? 0} pieces are recorded as ready. Marking the order ready marks every piece printed${detail?.progress?.needs_pressing ? ' and pressed' : ''}.`
        }
        confirmLabel={confirmCounts === 'Pressing' ? 'Yes, all printed: start pressing' : 'Yes, all done: mark ready'}
        busy={busy}
        busyLabel="Updating…"
        onConfirm={() => confirmCounts && changeStatus(confirmCounts, undefined, { complete_counts: true })}
        onCancel={() => setConfirmCounts(null)}
      />
      <ConfirmDialog
        open={confirmApprove}
        title={actions.approve_without_quote ? 'Approve this job order without a quote?' : 'Approve this job order?'}
        message={
          (order?.stock_reserved
            ? 'The order moves to Approved and printing can start. Its materials are already reserved.'
            : 'The order moves to Approved and its materials are reserved from stock now.') +
          (actions.approve_without_quote
            ? ' It has no quote, so no downpayment is checked yet. The Owner sets the price, and half of it is paid, before printing starts.'
            : '')
        }
        confirmLabel={actions.approve_without_quote ? 'Approve without a quote' : 'Approve job order'}
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

function CheckRow({ ok, text }: { ok: boolean; text: string }) {
  return (
    <li className="flex items-start gap-2">
      {ok ? <CircleCheck className={cn('mt-0.5 size-4 shrink-0', TONE_CLASSES.success.text)} aria-hidden /> : <CircleDashed className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />}
      <span className={cn(!ok && 'text-muted-foreground')}>
        <span className="sr-only">{ok ? 'Done: ' : 'Still to do: '}</span>
        {text}
      </span>
    </li>
  );
}

function CountBadge({ n }: { n: number }) {
  return <span className="rounded-full bg-muted px-1.5 text-xs font-medium tabular-nums text-muted-foreground">{n}</span>;
}

/** Migration 015: what the server says this order still needs before it is Completed */
function CompletionChecklist({ detail }: { detail: OrderDetail }) {
  const c = detail.completion;
  const f = detail.fulfillment;
  if (!c) return null;
  const paidOk = !c.missing.some((m) => m.code === 'BALANCE_DUE');
  const deliveredOk = !c.missing.some((m) => m.code === 'PIECES_NOT_DELIVERED');
  const producedOk = !c.missing.some((m) => m.code === 'NOT_IN_PRODUCTION');
  return (
    <section className="space-y-2 rounded-md border bg-card p-3" aria-labelledby="completion-title">
      <h3 id="completion-title" className="text-sm font-semibold">Before it can be completed</h3>
      <ul className="space-y-1.5 text-sm">
        <CheckRow ok={producedOk} text="Every piece is done (the order is Ready)" />
        <CheckRow ok={paidOk} text={paidOk ? 'Nothing left to pay' : `${peso(c.balance_due)} still to pay`} />
        <CheckRow
          ok={deliveredOk}
          text={
            c.auto_handover
              ? 'All pieces handed over at once when completed'
              : f
                ? `${f.pieces_delivered.toLocaleString()} of ${f.pieces_ordered.toLocaleString()} pieces handed over`
                : 'Pieces handed over'
          }
        />
      </ul>
      {c.warnings.map((w) => (
        <p key={w.code} className={cn('rounded-md border p-2 text-xs', TONE_CLASSES.warning.banner)}>{w.message}</p>
      ))}
    </section>
  );
}
