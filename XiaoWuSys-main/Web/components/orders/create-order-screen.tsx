'use client';

// Create Order (ported from the App.jsx "Create Order" tab).
//   1. Customer: a saved one, or a new one (POST /api/customers; a 409 duplicate reuses it)
//   2. POST /api/orders { customer_id, production_deadline, required_items, total_quote_amount?, order_description? }
//      The server checks stock and reserves it in the same transaction.
//   3. 409 INSUFFICIENT_INVENTORY (PB 9) -> the halt dialog (PB 10): Delay with a new deadline,
//      or Cancel (recorded as a lost sale), sent as POST /api/orders again with "resolution".
//
// While the form is filled in, the side panel shows what the server says (create-order-panels.tsx):
//   - the client's profile: contact details, orders so far, balance due, recent orders ("Repeat"
//     copies an old order's materials and description: GET /api/orders/:id)
//   - a live stock check (POST /api/inventory/check-capacity, also offline)
//   - Owner: the quote worked out from catalog prices, bulk tier, labor and incidental charges
//     (POST /api/orders/quote-preview). "Calculate from catalog" saves that quote with the order
//     right after it is created (POST /api/orders/:id/quote, online only), keeping the breakdown;
//     "Type a price" sends one amount as before.
//
// Migration 015: an optional description / instructions for the whole order, and a few
// client-profile fields when a new client is added. /orders/new?customer=CUST-… starts with that
// client chosen. Print details (sizes, names, numbers) are added in the order's profile.
//
// Migration 016 (adviser consultation, second round): the branch of the client making the order
// (main branch by default), and the design: a Google Drive link and/or files picked from this
// computer (no need to upload them to Drive first). The files are sent right after the order is
// saved (POST /api/orders/:id/design-files, online only).
import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { CalendarDays, CircleCheck, Clock, Eraser, Paperclip, PlusCircle, Search, Shirt, Trash2, TriangleAlert, XCircle, Plus } from 'lucide-react';
import { formatDateTime, formatMobile, MOBILE_PATTERN, peso, todayInManila } from '@xiaowu/client-core/format';
import { NUMBER_AFTER_SYNC, orderNumber } from '@xiaowu/client-core/orders';
import { can } from '@xiaowu/client-core/permissions';
import { DateInput } from '@/components/forms/date-input';
import { Field, fieldError, FormProblem, RequiredNote } from '@/components/forms/form-bits';
import { ResultDialog, type ResultMessage } from '@/components/feedback/result-dialog';
import {
  ClientSnapshot,
  PanelBox,
  QuotePreviewTable,
  StockCheckPanel,
  useQuotePreview,
  useStockCheck,
  type Charges,
  type RequiredItem,
} from '@/components/orders/create-order-panels';
import { ShortageTable } from '@/components/orders/shortage-table';
import { PrintAreasEditor } from '@/components/orders/print-areas-editor';
import { DESIGN_FILE_ACCEPT, DESIGN_FILE_MAX_MB, fileSize, uploadDesignFiles } from '@/components/orders/design-files-section';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import { Select, SelectGroup, SelectLabel, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { BoundedSelectContent, BoundedSelectItem, BoundedSelectTrigger } from '@/components/forms/bounded-select';
import { useApi } from '@/hooks/use-api';
import { useCustomers } from '@/hooks/use-customers';
import { useInventorySnapshot } from '@/hooks/use-inventory-snapshot';
import { useSession } from '@/hooks/use-session';
import { errorMessage } from '@/lib/api';
import { toNumberInput, type InventoryItem } from '@/lib/inventory';
import type { CustomerBranch, Order, OrderItem, PrintArea, Shortage } from '@/lib/orders';
import { lookFor, STOCK_STATUS, TONE_CLASSES } from '@/lib/ui-tokens';
import { cn } from '@/lib/utils';
import { MONEY_INPUT_MAX, TEXT_MAX, WHOLE_NUMBER_MAX } from '@/lib/input-limits';

interface Line {
  key: number;
  inventory_id: string;
  quantity: string;
  /** migration 017: print areas of a per-area item (blank + each print) */
  print_areas?: PrintArea[];
}

interface OrderPayload {
  customer_id: string;
  production_deadline: string;
  required_items: { inventory_id: string; quantity_needed: number; print_areas?: PrintArea[] }[];
  total_quote_amount?: number;
  order_description?: string;
  /** migration 016 */
  branch_id?: string;
  design_drive_link?: string;
}

interface CreateResponse {
  message?: string;
  error?: string;
  order?: Order;
  items?: unknown[];
  source?: 'cloud' | 'local';
  shortages?: Shortage[];
  missing_inventory_ids?: string[];
}

interface Created {
  order_id: string | null;
  label: string;
  customerId: string;
  customerName: string;
  offline: boolean;
  quoteNote: string | null;
}

const EMPTY_CUSTOMER = { full_name: '', contact_number: '', platform_source: '', contact_person: '', email: '' };
const DESCRIPTION_MAX = 2000;
const DESCRIPTION_STARTERS = ['Front: ', 'Back: ', 'Sleeve: ', 'Colours: ', 'Font: ', 'Packing: ', 'Deliver in batches: '];
const DEADLINE_SHORTCUTS = [
  { label: 'Tomorrow', days: 1 },
  { label: '3 days', days: 3 },
  { label: '1 week', days: 7 },
  { label: '2 weeks', days: 14 },
];
const DAY_MS = 86_400_000;

// 'YYYY-MM-DD' + n days (calendar arithmetic in UTC, so no time-zone drift)
const addDays = (ymd: string, days: number) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const daysBetween = (from: string, to: string) => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS;
const dueText = (today: string, deadline: string) => {
  const n = daysBetween(today, deadline);
  if (Number.isNaN(n)) return '';
  if (n === 0) return 'due today';
  if (n === 1) return 'due tomorrow';
  return `due in ${n} days`;
};

let lineKey = 0;
const newLine = (inventory_id = '', quantity = ''): Line => ({ key: ++lineKey, inventory_id, quantity });
const focusQty = (key: number) => requestAnimationFrame(() => document.getElementById(`line-qty-${key}`)?.focus());

export function CreateOrderScreen() {
  const api = useApi();
  const { user } = useSession();
  const canSetQuote = can(user, 'set_quote');
  const { customers, loaded: customersLoaded, reload: reloadCustomers } = useCustomers();
  const { snapshot, refresh: refreshInventory } = useInventorySnapshot();
  const materials = useMemo(() => snapshot?.items ?? [], [snapshot]);
  const materialById = useMemo(() => new Map(materials.map((m) => [m.inventory_id, m])), [materials]);
  const byCategory = useMemo(() => {
    const groups = new Map<string, InventoryItem[]>();
    for (const m of [...materials].sort((a, b) => a.item_name.localeCompare(b.item_name))) {
      const cat = m.item_category || 'Other';
      groups.set(cat, [...(groups.get(cat) ?? []), m]);
    }
    return [...groups].sort(([a], [b]) => a.localeCompare(b));
  }, [materials]);

  const params = useSearchParams();
  const formRef = useRef<HTMLFormElement>(null);
  const [customerId, setCustomerId] = useState(() => params.get('customer') ?? '');
  const [description, setDescription] = useState('');
  // Migration 016: the client's branch (''= main branch) and the design (link and / or files)
  const [branchId, setBranchId] = useState('');
  const [branches, setBranches] = useState<CustomerBranch[]>([]);
  const [designLink, setDesignLink] = useState('');
  const [designFiles, setDesignFiles] = useState<File[]>([]);
  const [designNote, setDesignNote] = useState('');
  const designInputRef = useRef<HTMLInputElement>(null);
  const [newCustomerMode, setNewCustomerMode] = useState(false);
  const [newCustomer, setNewCustomer] = useState(EMPTY_CUSTOMER);
  const [deadline, setDeadline] = useState('');
  const [quote, setQuote] = useState('');
  const [priceMode, setPriceMode] = useState<'catalog' | 'manual'>('catalog');
  const [labor, setLabor] = useState('');
  const [incidental, setIncidental] = useState('');
  const [incidentalMode, setIncidentalMode] = useState<'peso' | 'percent'>('peso');
  const [lines, setLines] = useState<Line[]>(() => [newLine()]);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [result, setResult] = useState<ResultMessage | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [halt, setHalt] = useState<{ message: string; shortages: Shortage[]; payload: OrderPayload } | null>(null);
  const [haltMode, setHaltMode] = useState<'choose' | 'delay'>('choose');
  const [delayedDeadline, setDelayedDeadline] = useState('');
  const [haltProblem, setHaltProblem] = useState('');
  // The server's last 400 answer, so each message is shown next to the field it names
  const [failed, setFailed] = useState<unknown>(null);
  const errorFor = (field: string) => fieldError(failed, field);

  // With no saved customers yet, the form starts on "new customer"
  const addingCustomer = newCustomerMode || (customersLoaded && customers.length === 0);
  const today = todayInManila();
  const mobile = newCustomer.contact_number;
  const mobileHint = !mobile
    ? 'Optional · 11 digits, starts with 0'
    : MOBILE_PATTERN.test(mobile)
      ? 'Valid mobile number'
      : !mobile.startsWith('0')
        ? 'Must start with 0'
        : `${mobile.length} of 11 digits`;

  // Lines that are complete enough to ask the server about (format only)
  const readyItems: RequiredItem[] = useMemo(
    () =>
      lines
        .filter((l) => l.inventory_id && /^\d+$/.test(l.quantity) && Number(l.quantity) > 0)
        .map((l) => ({
          inventory_id: l.inventory_id,
          quantity_needed: Number(l.quantity),
          ...(materialById.get(l.inventory_id)?.print_pricing === 'per_area' && l.print_areas?.length ? { print_areas: l.print_areas } : {}),
        })),
    [lines, materialById]
  );
  const stockCheck = useStockCheck(readyItems);
  const shortageById = useMemo(
    () => new Map(stockCheck.state === 'short' ? stockCheck.shortages.map((s) => [s.inventory_id, s]) : []),
    [stockCheck]
  );

  const charges: Charges = useMemo(() => {
    const out: Charges = {};
    const l = toNumberInput(labor);
    const i = toNumberInput(incidental);
    if (l !== undefined && !Number.isNaN(l)) out.labor_amount = l;
    if (i !== undefined && !Number.isNaN(i)) {
      if (incidentalMode === 'percent') out.incidental_percent = i;
      else out.incidental_amount = i;
    }
    return out;
  }, [labor, incidental, incidentalMode]);
  const usePreview = canSetQuote && priceMode === 'catalog';
  const preview = useQuotePreview(usePreview, readyItems, charges);

  const nameOf = (id: string) => materialById.get(id)?.item_name ?? 'Unknown material';
  const searchHits = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return materials
      .filter((m) => `${m.item_name} ${m.item_category} ${m.supplier ?? ''}`.toLowerCase().includes(q))
      .slice(0, 8);
  }, [materials, search]);

  const setLine = (key: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  // Fills the first empty line, or adds one, then puts the cursor in its quantity
  const addMaterial = (inventory_id: string) => {
    const existing = lines.find((l) => l.inventory_id === inventory_id);
    if (existing) {
      focusQty(existing.key);
      return;
    }
    const empty = lines.find((l) => !l.inventory_id);
    if (empty) {
      setLine(empty.key, { inventory_id });
      focusQty(empty.key);
    } else {
      const line = newLine(inventory_id);
      setLines((ls) => [...ls, line]);
      focusQty(line.key);
    }
    setSearch('');
  };

  // Migration 016: the chosen client's branches (from the client profile)
  useEffect(() => {
    if (!customerId || newCustomerMode) return undefined;
    let cancelled = false;
    api<{ branches?: CustomerBranch[] }>('GET', `/customers/${encodeURIComponent(customerId)}`).then(({ ok, data }) => {
      if (cancelled) return;
      const list = ok ? (data.branches ?? []).filter((b) => !b.archived_at) : [];
      setBranches(list);
      setBranchId((current) => (list.some((b) => b.branch_id === current) ? current : '')); // another client: main branch
    });
    return () => {
      cancelled = true;
    };
  }, [api, customerId, newCustomerMode]);
  const shownBranches = customerId && !addingCustomer ? branches : [];
  const chosenBranch = shownBranches.find((b) => b.branch_id === branchId) ?? null;
  const tooBigFiles = designFiles.filter((f) => f.size > DESIGN_FILE_MAX_MB * 1024 * 1024);

  const resetForm = () => {
    setCustomerId('');
    setBranchId('');
    setDesignLink('');
    setDesignFiles([]);
    setDesignNote('');
    if (designInputRef.current) designInputRef.current.value = '';
    setNewCustomer(EMPTY_CUSTOMER);
    setNewCustomerMode(false);
    setDeadline('');
    setQuote('');
    setLabor('');
    setIncidental('');
    setDescription('');
    setLines([newLine()]);
    setProblem('');
    setFailed(null);
  };

  const closeHalt = () => {
    setHalt(null);
    setHaltMode('choose');
    setDelayedDeadline('');
    setHaltProblem('');
  };

  // "Repeat" a past order: its materials and description (the server's copy of the order)
  const repeatOrder = async (orderId: string) => {
    setProblem('');
    const { ok, data } = await api<{ order?: Order; items?: OrderItem[] }>('GET', `/orders/${encodeURIComponent(orderId)}`);
    if (!ok) {
      setProblem(errorMessage(data, 'That order could not be loaded.'));
      return;
    }
    const linked = (data.items ?? []).filter((i) => i.inventory_id && materialById.has(i.inventory_id));
    if (linked.length === 0) {
      setProblem('That order has no materials that are still in the catalog.');
      return;
    }
    setLines(linked.map((i) => newLine(i.inventory_id ?? '', String(i.quantity))));
    if (data.order?.order_description) setDescription(data.order.order_description);
    setResult({
      type: 'success',
      title: 'Materials copied',
      message: `${linked.length} material(s) copied from ${data.order ? orderNumber(data.order) : 'the order'}. Check the quantities and set a new deadline.`,
    });
  };

  // Owner, "Calculate from catalog": save the quote with its breakdown right after the order exists
  const saveCalculatedQuote = async (order: Order | undefined, offline: boolean): Promise<string | null> => {
    if (!usePreview || !order?.order_id) return null;
    if (offline) return 'The quote was not saved because the order is offline. Calculate it in the order’s Quote tab after it syncs.';
    const { ok, data } = await api<{ quote?: { total_quote_amount: number } }>('POST', `/orders/${encodeURIComponent(order.order_id)}/quote`, charges);
    if (ok) return `Quote saved: ${peso(data.quote?.total_quote_amount)}.`;
    return `The order was saved, but its quote was not: ${errorMessage(data, 'please try again')}. Set it in the order’s Quote tab.`;
  };

  // HCI (Norman, gulf of evaluation): say what happened, to which order and customer, where it
  // was saved, and what comes next
  const onCreated = async (data: CreateResponse, title: string, customerName: string, resolvedCustomerId: string) => {
    const offline = data.source === 'local' || !data.order?.tracking_no;
    const quoteNote = await saveCalculatedQuote(data.order, offline);
    // Migration 016: the design files picked from this computer go to the new order now
    let filesNote: string | null = null;
    let filesFailed = false;
    if (designFiles.length > 0 && data.order?.order_id) {
      if (offline) {
        filesNote = 'The design files were not attached because the order is offline. Attach them in the order’s Details tab after it syncs.';
        filesFailed = true;
      } else {
        const sent = await uploadDesignFiles(data.order.order_id, designFiles, designNote);
        filesFailed = sent.some((r) => !r.ok);
        filesNote = sent.map((r) => r.message).join('\n');
      }
    }
    const deadlineText = data.order?.production_deadline ? formatDateTime(data.order.production_deadline, { withTime: false }) : null;
    setResult({
      type: (quoteNote && !quoteNote.startsWith('Quote saved')) || filesFailed ? 'warning' : 'success',
      title,
      message: [
        offline
          ? `The order for ${customerName} was saved on this computer (offline). ${NUMBER_AFTER_SYNC}`
          : `Order ${data.order?.tracking_no} for ${customerName} was saved to the cloud.`,
        deadlineText ? `Deadline: ${deadlineText}.` : null,
        `${(data.items ?? []).length} material(s) reserved in the Catalog.`,
        quoteNote,
        filesNote,
      ]
        .filter(Boolean)
        .join('\n'),
    });
    setCreated({
      order_id: data.order?.order_id ?? null,
      label: data.order ? orderNumber(data.order) : 'The order',
      customerId: resolvedCustomerId,
      customerName,
      offline,
      quoteNote,
    });
    resetForm();
    refreshInventory();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setProblem('');
    setFailed(null);
    // Named in the result message (captured now: the new-customer fields are cleared once it is saved)
    const whoName = addingCustomer ? newCustomer.full_name.trim() : customers.find((c) => c.customer_id === customerId)?.full_name ?? 'the customer';

    // Input checks only (format, not business rules)
    const required_items = lines.map((l) => {
      const perArea = materialById.get(l.inventory_id)?.print_pricing === 'per_area';
      return { inventory_id: l.inventory_id, quantity_needed: Number(l.quantity), ...(perArea && l.print_areas?.length ? { print_areas: l.print_areas } : {}) };
    });
    if (required_items.some((i) => !i.inventory_id)) {
      setProblem('Choose a material on every line, or remove the empty line.');
      return;
    }
    if (required_items.some((i) => Number.isNaN(i.quantity_needed))) {
      setProblem('Every quantity must be a number.');
      return;
    }
    const quoteValue = canSetQuote && priceMode === 'manual' ? toNumberInput(quote) : undefined;
    if (quoteValue !== undefined && Number.isNaN(quoteValue)) {
      setProblem('The quote must be a peso amount, like 1500 or 1500.50.');
      return;
    }
    if (usePreview && (Number.isNaN(toNumberInput(labor) ?? 0) || Number.isNaN(toNumberInput(incidental) ?? 0))) {
      setProblem('Labor and incidental charges must be numbers, like 500 or 5.');
      return;
    }
    if (tooBigFiles.length > 0) {
      setProblem(`These design files are over ${DESIGN_FILE_MAX_MB} MB: ${tooBigFiles.map((f) => f.name).join(', ')}. Remove them or choose smaller files.`);
      return;
    }
    if (addingCustomer && mobile && !MOBILE_PATTERN.test(mobile)) {
      setProblem('A mobile number must be exactly 11 digits and start with 0, like 09171234567. You can also leave it blank.');
      return;
    }

    setBusy(true);
    try {
      // 1) Customer
      let resolvedCustomerId = customerId;
      if (addingCustomer) {
        const res = await api<{ customer?: { customer_id: string }; existing?: { customer_id: string } }>('POST', '/customers', {
          full_name: newCustomer.full_name.trim(),
          contact_number: mobile || undefined,
          platform_source: newCustomer.platform_source.trim() || undefined,
          contact_person: newCustomer.contact_person.trim() || undefined,
          email: newCustomer.email.trim() || undefined,
        });
        if (res.ok && res.data.customer) resolvedCustomerId = res.data.customer.customer_id;
        else if (res.status === 409 && res.data.existing) resolvedCustomerId = res.data.existing.customer_id; // same customer already saved
        else {
          setFailed(res.data);
          setProblem(errorMessage(res.data, 'The customer could not be saved. Please try again.'));
          return;
        }
        reloadCustomers();
        setCustomerId(resolvedCustomerId);
        setNewCustomerMode(false);
        setNewCustomer(EMPTY_CUSTOMER);
      }
      if (!resolvedCustomerId) {
        setProblem('Select who this order is for, or add a new customer.');
        return;
      }

      // 2) Order
      const payload: OrderPayload = {
        customer_id: resolvedCustomerId,
        production_deadline: deadline,
        required_items,
        ...(quoteValue !== undefined ? { total_quote_amount: quoteValue } : {}),
        ...(description.trim() ? { order_description: description.trim() } : {}),
        ...(branchId && !addingCustomer ? { branch_id: branchId } : {}),
        ...(designLink.trim() ? { design_drive_link: designLink.trim() } : {}),
      };
      const { ok, status, data } = await api<CreateResponse>('POST', '/orders', payload);
      if (ok) {
        await onCreated(data, 'Order created', whoName, resolvedCustomerId);
        return;
      }
      if (status === 409 && data.error === 'INSUFFICIENT_INVENTORY') {
        setHalt({ message: errorMessage(data, 'There is not enough stock for this order right now.'), shortages: data.shortages ?? [], payload });
        return;
      }
      setFailed(data);
      // Name the missing materials instead of showing their internal IDs
      const missing = (data.missing_inventory_ids ?? []).map((id) => materialById.get(id)?.item_name).filter(Boolean);
      setProblem(errorMessage(data, 'The order could not be saved. Please try again.') + (missing.length ? `\nMaterials affected: ${missing.join(', ')}.` : ''));
    } finally {
      setBusy(false);
    }
  };

  // PB 10: log the staff member's choice for a halted order
  const resolveHalt = async (resolution: 'Delayed' | 'Cancelled') => {
    if (!halt) return;
    setHaltProblem('');
    if (resolution === 'Delayed' && !delayedDeadline) {
      setHaltProblem('Please pick the new date when this order should be finished.');
      return;
    }
    const production_deadline = resolution === 'Delayed' ? delayedDeadline : halt.payload.production_deadline;
    setBusy(true);
    const { ok, data } = await api<CreateResponse>('POST', '/orders', { ...halt.payload, production_deadline, resolution });
    setBusy(false);
    if (!ok) {
      setHaltProblem(errorMessage(data, 'This choice could not be saved. Please try again.'));
      return;
    }
    const label = data.order ? orderNumber(data.order) : 'The order';
    setResult({
      type: 'warning',
      title: resolution === 'Delayed' ? 'Order delayed' : 'Order cancelled',
      message:
        resolution === 'Delayed'
          ? `${label} was logged as DELAYED with the new deadline. Resume it from the Orders page when stock arrives.`
          : `${label} was logged as CANCELLED (lost sale recorded).`,
    });
    resetForm();
    closeHalt();
  };

  const chosenName = addingCustomer ? newCustomer.full_name : customers.find((c) => c.customer_id === customerId)?.full_name;
  const checklist = [
    { done: Boolean(addingCustomer ? newCustomer.full_name.trim() : customerId), label: 'Client' },
    { done: Boolean(deadline), label: 'Deadline' },
    { done: readyItems.length > 0 && readyItems.length === lines.length, label: 'Materials and quantities' },
  ];

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <PlusCircle className="size-6" aria-hidden /> Create order
          </h1>
          <p className="text-sm text-muted-foreground">
            Stock is checked and reserved the moment the order is saved. Tip: <kbd className="rounded border px-1 text-xs">Ctrl</kbd> +{' '}
            <kbd className="rounded border px-1 text-xs">Enter</kbd> saves.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" type="button" onClick={resetForm} disabled={busy}>
            <Eraser aria-hidden /> Clear form
          </Button>
          <Button variant="outline" asChild>
            <Link href="/orders">View orders</Link>
          </Button>
        </div>
      </div>

      {created && (
        <div className={cn('flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3', TONE_CLASSES.success.banner)}>
          <CircleCheck className="size-5 shrink-0" aria-hidden />
          <p className="min-w-0 flex-1 text-sm">
            <strong>{created.label}</strong> for {created.customerName} was saved{created.offline ? ' on this computer' : ''}. Next: add sizes / print
            text in its <em>Materials &amp; print</em> tab{canSetQuote ? ', then record the downpayment and approve' : ''}.
          </p>
          {created.order_id && (
            <Button size="sm" asChild>
              <Link href={`/orders?order=${encodeURIComponent(created.order_id)}`}>Open order</Link>
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            type="button"
            onClick={() => {
              setCustomerId(created.customerId);
              setCreated(null);
            }}
          >
            New order, same client
          </Button>
          <Button size="sm" variant="ghost" type="button" onClick={() => setCreated(null)} aria-label="Dismiss">
            <XCircle aria-hidden />
          </Button>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] xl:grid-cols-[minmax(0,1fr)_26rem]">
        <form
          id="create-order-form"
          ref={formRef}
          onSubmit={submit}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              formRef.current?.requestSubmit();
            }
          }}
          className="min-w-0 space-y-6"
        >
          <FormProblem message={problem} />
          <RequiredNote />

          {/* Customer */}
          <Card>
            <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <CardTitle>1. Client</CardTitle>
                <CardDescription>Who is this order for? Type a name in the list to jump to it.</CardDescription>
              </div>
              {customers.length > 0 && (
                <Button type="button" variant="link" className="h-auto p-0" onClick={() => setNewCustomerMode((m) => !m)}>
                  {addingCustomer ? 'Pick a saved client' : '+ New client'}
                </Button>
              )}
            </CardHeader>
            <CardContent>
              {!customersLoaded ? (
                <Skeleton className="h-9 w-full" />
              ) : addingCustomer ? (
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field id="cust-name" label="Full name *" error={errorFor('full_name')} className="sm:col-span-2">
                    <Input
                      id="cust-name"
                      required
                      maxLength={TEXT_MAX.default}
                      value={newCustomer.full_name}
                      onChange={(e) => setNewCustomer({ ...newCustomer, full_name: e.target.value })}
                    />
                  </Field>
                  <Field
                    id="cust-mobile"
                    label="Mobile number"
                    error={errorFor('contact_number')}
                    hint={<span className={cn(mobile && (MOBILE_PATTERN.test(mobile) ? 'text-success' : 'text-warning'))}>{mobileHint}</span>}
                  >
                    <Input
                      id="cust-mobile"
                      type="tel"
                      inputMode="numeric"
                      autoComplete="tel"
                      placeholder="09XXXXXXXXX"
                      maxLength={11}
                      value={mobile}
                      // digits only, at most 11 (input format, not a rule)
                      onChange={(e) => setNewCustomer({ ...newCustomer, contact_number: e.target.value.replace(/\D/g, '').slice(0, 11) })}
                      aria-invalid={Boolean(mobile) && !MOBILE_PATTERN.test(mobile)}
                    />
                  </Field>
                  <Field id="cust-source" label="Came from">
                    <Input
                      id="cust-source"
                      maxLength={TEXT_MAX.platformSource}
                      placeholder="Facebook, walk-in…"
                      value={newCustomer.platform_source}
                      onChange={(e) => setNewCustomer({ ...newCustomer, platform_source: e.target.value })}
                    />
                  </Field>
                  <Field id="cust-person" label="Contact person" error={errorFor('contact_person')} hint="For a school or company: who picks up and pays">
                    <Input id="cust-person" maxLength={255} value={newCustomer.contact_person} onChange={(e) => setNewCustomer({ ...newCustomer, contact_person: e.target.value })} />
                  </Field>
                  <Field id="cust-email" label="Email" error={errorFor('email')}>
                    <Input id="cust-email" type="email" maxLength={255} value={newCustomer.email} onChange={(e) => setNewCustomer({ ...newCustomer, email: e.target.value })} />
                  </Field>
                  <p className="text-xs text-muted-foreground sm:col-span-2">More details (address, social media, notes) can be added later in Clients.</p>
                </div>
              ) : (
                <Select value={customerId} onValueChange={setCustomerId}>
                  <BoundedSelectTrigger aria-label="Client">
                    <SelectValue placeholder="Select client…" />
                  </BoundedSelectTrigger>
                  <BoundedSelectContent>
                    {customers.map((c) => (
                      <BoundedSelectItem
                        key={c.customer_id}
                        value={c.customer_id}
                        label={c.full_name}
                        suffix={c.contact_number ? `· ${formatMobile(c.contact_number)}` : undefined}
                      >
                        {c.full_name}
                      </BoundedSelectItem>
                    ))}
                  </BoundedSelectContent>
                </Select>
              )}
              {/* Migration 016: which branch of the client makes this order */}
              {shownBranches.length > 0 && (
                <Field
                  id="order-branch"
                  label="Branch"
                  error={errorFor('branch_id')}
                  hint={chosenBranch ? chosenBranch.address || 'No address saved for this branch' : 'The main branch: the client’s own address'}
                  className="mt-4"
                >
                  <Select value={branchId || 'main'} onValueChange={(v) => setBranchId(v === 'main' ? '' : v)}>
                    <BoundedSelectTrigger id="order-branch">
                      <SelectValue />
                    </BoundedSelectTrigger>
                    <BoundedSelectContent>
                      <BoundedSelectItem value="main" label="Main branch">
                        Main branch
                      </BoundedSelectItem>
                      {shownBranches.map((b) => (
                        <BoundedSelectItem key={b.branch_id} value={b.branch_id} label={b.branch_name}>
                          {b.branch_name}
                        </BoundedSelectItem>
                      ))}
                    </BoundedSelectContent>
                  </Select>
                </Field>
              )}
            </CardContent>
          </Card>

          {/* Materials */}
          <Card>
            <CardHeader>
              <CardTitle>2. Materials</CardTitle>
              <CardDescription>Search to add in one click, or pick from the list. “Free” is the catalog’s live figure; the same material twice is added together.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {!snapshot ? (
                <Skeleton className="h-9 w-full" />
              ) : materials.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No materials in the catalog yet. <Link href="/catalog" className="text-primary underline underline-offset-4">Add items first</Link>.
                </p>
              ) : (
                <>
                  <div className="relative">
                    <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" aria-hidden />
                    <Input
                      type="search"
                      aria-label="Search materials"
                      placeholder="Search materials by name, category or supplier…"
                      className="pl-8"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && searchHits[0]) {
                          e.preventDefault();
                          addMaterial(searchHits[0].inventory_id);
                        }
                      }}
                    />
                    {search.trim() && (
                      <ul className="absolute z-20 mt-1 w-full overflow-hidden rounded-md border bg-popover shadow-md">
                        {searchHits.length === 0 ? (
                          <li className="px-3 py-2 text-sm text-muted-foreground">No material matches “{search.trim()}”.</li>
                        ) : (
                          searchHits.map((m) => {
                            const look = lookFor(STOCK_STATUS, m.stock_status);
                            return (
                              <li key={m.inventory_id}>
                                <button
                                  type="button"
                                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent focus:bg-accent focus:outline-none"
                                  onClick={() => addMaterial(m.inventory_id)}
                                >
                                  <span className="min-w-0 flex-1 truncate">
                                    {m.item_name}
                                    <span className="ml-1 text-xs text-muted-foreground">{m.item_category}</span>
                                  </span>
                                  <span className={cn('shrink-0 text-xs', TONE_CLASSES[look.tone].text)}>
                                    {m.quantity_available_net.toLocaleString()} {m.unit || 'pcs'} free
                                  </span>
                                </button>
                              </li>
                            );
                          })
                        )}
                      </ul>
                    )}
                  </div>

                  <div className="space-y-3">
                    {lines.map((line, index) => {
                      const m = line.inventory_id ? materialById.get(line.inventory_id) : undefined;
                      const short = line.inventory_id ? shortageById.get(line.inventory_id) : undefined;
                      const look = m ? lookFor(STOCK_STATUS, m.stock_status) : null;
                      return (
                        <div key={line.key} className={cn('rounded-md border p-3', short && 'border-warning/50 bg-warning/5')}>
                          <div className="flex flex-wrap items-end gap-2">
                            <div className="flex min-w-0 flex-[3_1_14rem] flex-col gap-1.5">
                              <Label htmlFor={`line-material-${line.key}`} className="self-start text-xs text-muted-foreground">
                                Material {index + 1}
                              </Label>
                              <Select value={line.inventory_id} onValueChange={(v) => setLine(line.key, { inventory_id: v })}>
                                <BoundedSelectTrigger id={`line-material-${line.key}`} aria-label={`Material ${index + 1}`}>
                                  <SelectValue placeholder="Select material…" />
                                </BoundedSelectTrigger>
                                <BoundedSelectContent>
                                  {byCategory.map(([cat, items]) => (
                                    <SelectGroup key={cat}>
                                      <SelectLabel>{cat}</SelectLabel>
                                      {items.map((item) => (
                                        <BoundedSelectItem
                                          key={item.inventory_id}
                                          value={item.inventory_id}
                                          label={item.item_name}
                                          suffix={`(${item.quantity_available_net.toLocaleString()} free)`}
                                        >
                                          {item.item_name}
                                        </BoundedSelectItem>
                                      ))}
                                    </SelectGroup>
                                  ))}
                                </BoundedSelectContent>
                              </Select>
                            </div>
                            <div className="flex w-28 flex-col gap-1.5">
                              <Label htmlFor={`line-qty-${line.key}`} className="self-start text-xs text-muted-foreground">
                                Quantity{m?.unit ? ` (${m.unit})` : ''}
                              </Label>
                              <Input
                                id={`line-qty-${line.key}`}
                                type="number"
                                min={1}
                                max={WHOLE_NUMBER_MAX}
                                step={1}
                                required
                                placeholder="Qty"
                                aria-label={`Quantity ${index + 1}`}
                                value={line.quantity}
                                onChange={(e) => setLine(line.key, { quantity: e.target.value })}
                              />
                            </div>
                            <Button
                              title={`Remove material ${index + 1}`}
                              type="button"
                              variant="ghost"
                              size="icon"
                              disabled={lines.length === 1}
                              onClick={() => setLines((ls) => ls.filter((l) => l.key !== line.key))}
                              aria-label={`Remove material ${index + 1}`}
                            >
                              <Trash2 aria-hidden />
                            </Button>
                          </div>
                          {m?.print_pricing === 'per_area' && (
                            <div className="mt-2">
                              <PrintAreasEditor
                                id={`line-prints-${line.key}`}
                                value={line.print_areas ?? []}
                                onChange={(next) => setLine(line.key, { print_areas: next })}
                              />
                            </div>
                          )}
                          {m && look && (
                            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                              <span>{m.item_category}</span>
                              <span>
                                {m.quantity_available_net.toLocaleString()} {m.unit || 'pcs'} free · {m.quantity_reserved.toLocaleString()} held by other orders
                              </span>
                              <Badge variant="outline" className={cn('px-1.5 py-0 text-[11px]', TONE_CLASSES[look.tone].badge)}>
                                {STOCK_STATUS[m.stock_status]?.label ?? m.stock_status}
                              </Badge>
                              {m.has_sizes && (
                                <span className="flex items-center gap-1">
                                  <Shirt className="size-3.5" aria-hidden /> Garment: sizes and names are added after saving
                                </span>
                              )}
                              {short && (
                                <span className="flex items-center gap-1 font-medium text-warning">
                                  <TriangleAlert className="size-3.5" aria-hidden /> Short by {(short.shortfall ?? 0).toLocaleString()}
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      const line = newLine();
                      setLines((ls) => [...ls, line]);
                    }}
                  >
                    <Plus aria-hidden /> Add material
                  </Button>
                </>
              )}
            </CardContent>
          </Card>

          {/* Deadline */}
          <Card>
            <CardHeader>
              <CardTitle>3. Deadline</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-2">
                {DEADLINE_SHORTCUTS.map((s) => {
                  const date = addDays(today, s.days);
                  return (
                    <Button
                      key={s.label}
                      type="button"
                      size="sm"
                      variant={deadline === date ? 'default' : 'outline'}
                      onClick={() => setDeadline(date)}
                    >
                      <CalendarDays aria-hidden /> {s.label}
                    </Button>
                  );
                })}
              </div>
              <Field
                id="order-deadline"
                label="Production deadline *"
                error={errorFor('production_deadline')}
                hint={deadline ? `${formatDateTime(deadline, { withTime: false })} · ${dueText(today, deadline)}` : 'Pick a shortcut above or choose a date.'}
              >
                <DateInput id="order-deadline" min={today} required value={deadline} onChange={(e) => setDeadline(e.target.value)} />
              </Field>
            </CardContent>
          </Card>

          {/* Price (Owner) */}
          {canSetQuote && (
            <Card>
              <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <CardTitle>4. Price</CardTitle>
                  <CardDescription>Optional now; it can also be set later in the order’s Quote tab.</CardDescription>
                </div>
                <div className="flex rounded-md border p-0.5" role="group" aria-label="How to price">
                  <Button type="button" size="sm" variant={priceMode === 'catalog' ? 'default' : 'ghost'} onClick={() => setPriceMode('catalog')}>
                    Calculate from catalog
                  </Button>
                  <Button type="button" size="sm" variant={priceMode === 'manual' ? 'default' : 'ghost'} onClick={() => setPriceMode('manual')}>
                    Type a price
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-2">
                {priceMode === 'catalog' ? (
                  <>
                    <Field id="order-labor" label="Labor / services (₱)" hint="Printing, pressing, layout work…">
                      <Input id="order-labor" type="number" min={0} max={MONEY_INPUT_MAX} step="any" inputMode="decimal" placeholder="0.00" value={labor} onChange={(e) => setLabor(e.target.value)} />
                    </Field>
                    <Field id="order-incidental" label={incidentalMode === 'percent' ? 'Incidental charges (%)' : 'Incidental charges (₱)'} hint="Delivery, rush, ink, wear and tear…">
                      <div className="flex gap-2">
                        <Input
                          id="order-incidental"
                          type="number"
                          min={0}
                          step="any"
                          inputMode="decimal"
                          placeholder={incidentalMode === 'percent' ? '0' : '0.00'}
                          value={incidental}
                          onChange={(e) => setIncidental(e.target.value)}
                        />
                        <Button type="button" variant="outline" className="w-14 shrink-0" onClick={() => setIncidentalMode((m) => (m === 'peso' ? 'percent' : 'peso'))} title="Switch between pesos and percent">
                          {incidentalMode === 'percent' ? '%' : '₱'}
                        </Button>
                      </div>
                    </Field>
                    <p className="text-xs text-muted-foreground sm:col-span-2">
                      The quote (catalog selling prices, bulk discount, labor and incidental) is shown on the right and saved with the order when you create it. Online only.
                    </p>
                  </>
                ) : (
                  <Field id="order-price" label="Quote (₱)" hint="One price for the whole order." className="sm:col-span-2">
                    <Input id="order-price" type="number" min={0} max={MONEY_INPUT_MAX} step="any" inputMode="decimal" placeholder="0.00" value={quote} onChange={(e) => setQuote(e.target.value)} />
                  </Field>
                )}
              </CardContent>
            </Card>
          )}

          {/* What to make (migration 015) */}
          <Card>
            <CardHeader>
              <CardTitle>{canSetQuote ? '5.' : '4.'} Description / instructions</CardTitle>
              <CardDescription>Optional. What the customer wants: design, colours, print placement, packing, anything the team must know.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex flex-wrap gap-1.5">
                {DESCRIPTION_STARTERS.map((s) => (
                  <Button
                    key={s}
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="h-7 px-2 text-xs"
                    onClick={() => setDescription((d) => `${d}${d && !d.endsWith('\n') ? '\n' : ''}${s}`.slice(0, DESCRIPTION_MAX))}
                  >
                    + {s.trim()}
                  </Button>
                ))}
              </div>
              <Field id="order-description" label="Description" error={errorFor('order_description')} hint={`${description.length}/${DESCRIPTION_MAX} characters`}>
                <Textarea
                  id="order-description"
                  rows={5}
                  maxLength={DESCRIPTION_MAX}
                  placeholder="e.g. Front: school logo, full colour. Back: surname and number in white. Deliver in 2 batches."
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </Field>
            </CardContent>
          </Card>

          {/* Migration 016 (adviser consultation): the design, as a Drive link and / or files from this computer */}
          <Card>
            <CardHeader>
              <CardTitle>{canSetQuote ? '6.' : '5.'} Design</CardTitle>
              <CardDescription>
                Optional. Attach the design files straight from this computer (no need to put them on Google Drive first), or paste a Google
                Drive link. Files are sent when the order is saved online.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Field id="order-design-files" label="Design files from this computer" error={errorFor('file')}
                hint={`Pictures, PDF, AI, PSD, CDR, EPS, ZIP… up to ${DESIGN_FILE_MAX_MB} MB each.`}>
                <Input
                  ref={designInputRef}
                  id="order-design-files"
                  type="file"
                  multiple
                  accept={DESIGN_FILE_ACCEPT}
                  onChange={(e) => setDesignFiles(Array.from(e.target.files ?? []))}
                />
              </Field>
              {designFiles.length > 0 && (
                <ul className="space-y-1 text-sm">
                  {designFiles.map((f) => (
                    <li key={`${f.name}-${f.size}`} className="flex items-center gap-2">
                      <Paperclip className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="min-w-0 truncate">{f.name}</span>
                      <span className={cn('text-xs tabular-nums', f.size > DESIGN_FILE_MAX_MB * 1024 * 1024 ? 'text-danger' : 'text-muted-foreground')}>
                        {fileSize(f.size)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {designFiles.length > 0 && (
                <Field id="order-design-note" label="Note for these files">
                  <Input id="order-design-note" maxLength={500} placeholder="e.g. final front and back design" value={designNote} onChange={(e) => setDesignNote(e.target.value)} />
                </Field>
              )}
              <Field id="order-design-link" label="Google Drive link (optional)" error={errorFor('design_drive_link')}>
                <Input
                  id="order-design-link"
                  type="url"
                  maxLength={TEXT_MAX.designLink}
                  placeholder="https://drive.google.com/…"
                  value={designLink}
                  onChange={(e) => setDesignLink(e.target.value)}
                />
              </Field>
            </CardContent>
          </Card>
        </form>

        {/* Summary: always in view on a wide screen */}
        <aside className="min-w-0 space-y-4 lg:sticky lg:top-4 lg:self-start">
          <PanelBox title="Order summary">
            <ul className="space-y-1.5 text-sm">
              {checklist.map((c) => (
                <li key={c.label} className={cn('flex items-center gap-2', c.done ? 'text-foreground' : 'text-muted-foreground')}>
                  <CircleCheck className={cn('size-4 shrink-0', c.done ? 'text-success' : 'opacity-40')} aria-hidden />
                  {c.label}
                </li>
              ))}
            </ul>
            <dl className="mt-3 space-y-1 text-sm">
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">Client</dt>
                <dd className="min-w-0 truncate text-right">{chosenName?.trim() || '—'}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">Deadline</dt>
                <dd className="text-right">{deadline ? `${formatDateTime(deadline, { withTime: false })} (${dueText(today, deadline)})` : '—'}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">Materials</dt>
                <dd>{readyItems.length} chosen</dd>
              </div>
              {preview.state === 'ok' && (
                <div className="flex justify-between gap-2 font-semibold">
                  <dt>Quote</dt>
                  <dd className="tabular-nums">{peso(preview.quote.total_quote_amount)}</dd>
                </div>
              )}
            </dl>
            <Button type="submit" form="create-order-form" size="lg" className="mt-4 w-full" disabled={busy || materials.length === 0}>
              {busy ? 'Checking stock…' : 'Create order'}
            </Button>
          </PanelBox>

          <StockCheckPanel check={stockCheck} nameOf={nameOf} />

          {usePreview && (
            <PanelBox title="Quote preview">
              <QuotePreviewTable preview={preview} />
            </PanelBox>
          )}

          {!canSetQuote && (
            <p className="rounded-lg border px-4 py-3 text-xs text-muted-foreground">The Owner sets the price of the order after it is created.</p>
          )}

          {!addingCustomer && <ClientSnapshot customerId={customerId} onRepeat={repeatOrder} />}
          {addingCustomer && <ClientSnapshot customerId="" newName={newCustomer.full_name} onRepeat={repeatOrder} />}
        </aside>
      </div>

      {/* PB 9 / PB 10: not enough stock -> delay or cancel */}
      <Dialog open={Boolean(halt)} onOpenChange={(next) => !next && !busy && closeHalt()}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-warning">
              <TriangleAlert className="size-5" aria-hidden /> Not enough stock for this order
            </DialogTitle>
            <DialogDescription className="wrap-anywhere">
              {halt?.message} Choose whether to <strong>delay</strong> the order until stock arrives, or <strong>cancel</strong> it.
            </DialogDescription>
          </DialogHeader>
          {halt && <ShortageTable shortages={halt.shortages} />}
          <FormProblem message={haltProblem} />
          {haltMode === 'delay' && (
            <Field id="delayed-deadline" label="New production deadline *">
              <DateInput id="delayed-deadline" min={today} autoFocus value={delayedDeadline} onChange={(e) => setDelayedDeadline(e.target.value)} />
            </Field>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={closeHalt} disabled={busy}>
              Back to the form
            </Button>
            {haltMode === 'choose' ? (
              <>
                <Button variant="destructive" onClick={() => resolveHalt('Cancelled')} disabled={busy}>
                  <XCircle aria-hidden /> Cancel order
                </Button>
                <Button
                  onClick={() => {
                    setHaltProblem('');
                    setHaltMode('delay');
                  }}
                  disabled={busy}
                  className={cn(TONE_CLASSES.warning.badge, 'border hover:bg-warning/20')}
                >
                  <Clock aria-hidden /> Delay order
                </Button>
              </>
            ) : (
              <Button busy={busy} onClick={() => resolveHalt('Delayed')} disabled={busy}>
                <Clock aria-hidden /> {busy ? 'Saving…' : 'Save as delayed'}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ResultDialog result={result} onClose={() => setResult(null)} />
    </div>
  );
}
