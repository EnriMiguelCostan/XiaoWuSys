'use client';

// Create Order (ported from the App.jsx "Create Order" tab).
//   1. Customer: a saved one, or a new one (POST /api/customers; a 409 duplicate reuses it)
//   2. POST /api/orders { customer_id, production_deadline, required_items, total_quote_amount? }
//      The server checks stock and reserves it in the same transaction.
//   3. 409 INSUFFICIENT_INVENTORY (PB 9) -> the halt dialog (PB 10): Delay with a new deadline,
//      or Cancel (recorded as a lost sale), sent as POST /api/orders again with "resolution".
//
// The quote is one amount for the whole order, set only by accounts with set_quote (the Owner).
// No deposit is taken here: payments are recorded in the order's details, where the server's
// max_payment applies. Materials come from the live catalog (useInventorySnapshot).
import { useState } from 'react';
import Link from 'next/link';
import { Clock, Plus, PlusCircle, Trash2, TriangleAlert, XCircle } from 'lucide-react';
import { MOBILE_PATTERN, todayInManila } from '@xiaowu/client-core/format';
import { NUMBER_AFTER_SYNC, orderNumber } from '@xiaowu/client-core/orders';
import { can } from '@xiaowu/client-core/permissions';
import { Field, FormProblem } from '@/components/forms/form-bits';
import { ResultDialog, type ResultMessage } from '@/components/feedback/result-dialog';
import { ShortageTable } from '@/components/orders/shortage-table';
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
import { Select, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { BoundedSelectContent, BoundedSelectItem, BoundedSelectTrigger } from '@/components/forms/bounded-select';
import { useApi } from '@/hooks/use-api';
import { useCustomers } from '@/hooks/use-customers';
import { useInventorySnapshot } from '@/hooks/use-inventory-snapshot';
import { useSession } from '@/hooks/use-session';
import { errorMessage } from '@/lib/api';
import { toNumberInput } from '@/lib/inventory';
import type { Order, Shortage } from '@/lib/orders';
import { TONE_CLASSES } from '@/lib/ui-tokens';
import { cn } from '@/lib/utils';
import { MONEY_INPUT_MAX, TEXT_MAX, WHOLE_NUMBER_MAX } from '@/lib/input-limits';

interface Line {
  key: number;
  inventory_id: string;
  quantity: string;
}

interface OrderPayload {
  customer_id: string;
  production_deadline: string;
  required_items: { inventory_id: string; quantity_needed: number }[];
  total_quote_amount?: number;
}

interface CreateResponse {
  message?: string;
  error?: string;
  order?: Order;
  items?: unknown[];
  shortages?: Shortage[];
  missing_inventory_ids?: string[];
}

const EMPTY_CUSTOMER = { full_name: '', contact_number: '', platform_source: '' };

let lineKey = 0;
const newLine = (): Line => ({ key: ++lineKey, inventory_id: '', quantity: '' });

export function CreateOrderScreen() {
  const api = useApi();
  const { user } = useSession();
  const canSetQuote = can(user, 'set_quote');
  const { customers, loaded: customersLoaded, reload: reloadCustomers } = useCustomers();
  const { snapshot, refresh: refreshInventory } = useInventorySnapshot();
  const materials = snapshot?.items ?? [];

  const [customerId, setCustomerId] = useState('');
  const [newCustomerMode, setNewCustomerMode] = useState(false);
  const [newCustomer, setNewCustomer] = useState(EMPTY_CUSTOMER);
  const [deadline, setDeadline] = useState('');
  const [quote, setQuote] = useState('');
  const [lines, setLines] = useState<Line[]>(() => [newLine()]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [result, setResult] = useState<ResultMessage | null>(null);
  const [halt, setHalt] = useState<{ message: string; shortages: Shortage[]; payload: OrderPayload } | null>(null);
  const [haltMode, setHaltMode] = useState<'choose' | 'delay'>('choose');
  const [delayedDeadline, setDelayedDeadline] = useState('');
  const [haltProblem, setHaltProblem] = useState('');

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

  const setLine = (key: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const resetForm = () => {
    setCustomerId('');
    setNewCustomer(EMPTY_CUSTOMER);
    setNewCustomerMode(false);
    setDeadline('');
    setQuote('');
    setLines([newLine()]);
    setProblem('');
  };

  const closeHalt = () => {
    setHalt(null);
    setHaltMode('choose');
    setDelayedDeadline('');
    setHaltProblem('');
  };

  const created = (data: CreateResponse, title: string) => {
    setResult({
      type: 'success',
      title,
      message:
        (data.order?.tracking_no ? `Order ${data.order.tracking_no} was saved.\n` : `The order was saved offline. ${NUMBER_AFTER_SYNC}\n`) +
        `${(data.items ?? []).length} material(s) reserved in the Catalog. You can follow it on the Orders page.` +
        (canSetQuote ? '' : '\nThe Owner will set the price.'),
    });
    resetForm();
    refreshInventory();
  };

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setProblem('');

    // Input checks only (format, not business rules)
    const required_items = lines.map((l) => ({ inventory_id: l.inventory_id, quantity_needed: Number(l.quantity) }));
    if (required_items.some((i) => !i.inventory_id)) {
      setProblem('Choose a material on every line, or remove the empty line.');
      return;
    }
    if (required_items.some((i) => Number.isNaN(i.quantity_needed))) {
      setProblem('Every quantity must be a number.');
      return;
    }
    const quoteValue = canSetQuote ? toNumberInput(quote) : undefined;
    if (quoteValue !== undefined && Number.isNaN(quoteValue)) {
      setProblem('The quote must be a peso amount, like 1500 or 1500.50.');
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
        });
        if (res.ok && res.data.customer) resolvedCustomerId = res.data.customer.customer_id;
        else if (res.status === 409 && res.data.existing) resolvedCustomerId = res.data.existing.customer_id; // same customer already saved
        else {
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
      };
      const { ok, status, data } = await api<CreateResponse>('POST', '/orders', payload);
      if (ok) {
        created(data, 'Order created');
        return;
      }
      if (status === 409 && data.error === 'INSUFFICIENT_INVENTORY') {
        setHalt({ message: errorMessage(data, 'There is not enough stock for this order right now.'), shortages: data.shortages ?? [], payload });
        return;
      }
      // Name the missing materials instead of showing their internal IDs
      const missing = (data.missing_inventory_ids ?? [])
        .map((id) => materials.find((m) => m.inventory_id === id)?.item_name)
        .filter(Boolean);
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

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <PlusCircle className="size-6" aria-hidden /> Create order
          </h1>
          <p className="text-sm text-muted-foreground">Stock is checked and reserved the moment the order is saved.</p>
        </div>
        <Button variant="outline" asChild>
          <Link href="/orders">View orders</Link>
        </Button>
      </div>

      <form onSubmit={submit} className="space-y-6">
        <FormProblem message={problem} />

        {/* Customer */}
        <Card>
          <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <CardTitle>Customer</CardTitle>
              <CardDescription>Who is this order for?</CardDescription>
            </div>
            {customers.length > 0 && (
              <Button type="button" variant="link" className="h-auto p-0" onClick={() => setNewCustomerMode((m) => !m)}>
                {addingCustomer ? 'Pick a saved customer' : '+ New customer'}
              </Button>
            )}
          </CardHeader>
          <CardContent>
            {!customersLoaded ? (
              <Skeleton className="h-9 w-full" />
            ) : addingCustomer ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field id="cust-name" label="Full name *" className="sm:col-span-2">
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
                  hint={
                    <span className={cn(mobile && (MOBILE_PATTERN.test(mobile) ? 'text-success' : 'text-warning'))}>{mobileHint}</span>
                  }
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
              </div>
            ) : (
              <Select value={customerId} onValueChange={setCustomerId}>
                <BoundedSelectTrigger aria-label="Customer">
                  <SelectValue placeholder="Select customer…" />
                </BoundedSelectTrigger>
                <BoundedSelectContent>
                  {customers.map((c) => (
                    <BoundedSelectItem
                      key={c.customer_id}
                      value={c.customer_id}
                      label={c.full_name}
                      suffix={c.contact_number ? `· ${c.contact_number}` : undefined}
                    >
                      {c.full_name}
                    </BoundedSelectItem>
                  ))}
                </BoundedSelectContent>
              </Select>
            )}
          </CardContent>
        </Card>

        {/* Deadline and quote */}
        <Card>
          <CardHeader>
            <CardTitle>Schedule and price</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <Field id="order-deadline" label="Production deadline *">
              <Input id="order-deadline" type="date" min={today} required value={deadline} onChange={(e) => setDeadline(e.target.value)} />
            </Field>
            {canSetQuote ? (
              <Field id="order-price" label="Quote (₱, optional)" hint="One price for the whole order. You can set it later too.">
                <Input id="order-price" type="number" min={0} max={MONEY_INPUT_MAX} step="0.01" inputMode="decimal" placeholder="0.00" value={quote} onChange={(e) => setQuote(e.target.value)} />
              </Field>
            ) : (
              <p className="self-end text-sm text-muted-foreground">The Owner sets the price of the order after it is created.</p>
            )}
          </CardContent>
        </Card>

        {/* Materials */}
        <Card>
          <CardHeader>
            <CardTitle>Required materials</CardTitle>
            <CardDescription>Choose the stock this order uses. “Free to use” is the catalog’s live figure.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {!snapshot ? (
              <Skeleton className="h-9 w-full" />
            ) : materials.length === 0 ? (
              <p className="text-sm text-muted-foreground">No materials in the catalog yet. Add inventory before creating orders.</p>
            ) : (
              lines.map((line, index) => (
                <div key={line.key} className="flex flex-wrap items-end gap-2">
                  <div className="min-w-0 flex-[3_1_14rem] space-y-1.5">
                    <Label htmlFor={`line-material-${line.key}`} className={cn(index > 0 && 'sr-only')}>
                      Material
                    </Label>
                    <Select value={line.inventory_id} onValueChange={(v) => setLine(line.key, { inventory_id: v })}>
                      <BoundedSelectTrigger id={`line-material-${line.key}`} aria-label={`Material ${index + 1}`}>
                        <SelectValue placeholder="Select material…" />
                      </BoundedSelectTrigger>
                      <BoundedSelectContent>
                        {materials.map((m) => (
                          <BoundedSelectItem
                            key={m.inventory_id}
                            value={m.inventory_id}
                            label={m.item_name}
                            suffix={`(${m.quantity_available_net.toLocaleString()} free to use)`}
                          >
                            {m.item_name}
                          </BoundedSelectItem>
                        ))}
                      </BoundedSelectContent>
                    </Select>
                  </div>
                  <div className="w-24 space-y-1.5">
                    <Label htmlFor={`line-qty-${line.key}`} className={cn(index > 0 && 'sr-only')}>
                      Qty
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
              ))
            )}
            {materials.length > 0 && (
              <Button type="button" variant="outline" size="sm" onClick={() => setLines((ls) => [...ls, newLine()])}>
                <Plus aria-hidden /> Add material
              </Button>
            )}
          </CardContent>
        </Card>

        <div className="flex justify-end">
          <Button type="submit" size="lg" disabled={busy || materials.length === 0}>
            {busy ? 'Checking stock…' : 'Create order'}
          </Button>
        </div>
      </form>

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
              <Input
                id="delayed-deadline"
                type="date"
                min={today}
                autoFocus
                value={delayedDeadline}
                onChange={(e) => setDelayedDeadline(e.target.value)}
              />
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
              <Button onClick={() => resolveHalt('Delayed')} disabled={busy}>
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
