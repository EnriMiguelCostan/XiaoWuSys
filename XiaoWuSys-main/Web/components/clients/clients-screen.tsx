'use client';

// Clients (migration 015): every customer's profile (contact person, phone, email, address,
// social media, notes), their order history and what they still owe. The list is
// GET /api/customers; a profile is GET /api/customers/:id, which also sends the totals and the
// buttons this account may use. Saving goes to POST / PATCH /api/customers (works offline too).
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { BookUser, Mail, MapPin, MessageCircle, Pencil, Phone, Plus, PlusCircle, Search, UserRound } from 'lucide-react';
import { formatDateTime, formatMobile, peso } from '@xiaowu/client-core/format';
import { orderNumber } from '@xiaowu/client-core/orders';
import { ResultDialog, type ResultMessage } from '@/components/feedback/result-dialog';
import { bannerText, Field, fieldErrorsMap, FormProblem, RequiredNote } from '@/components/forms/form-bits';
import { LoadProblem, PageHeader } from '@/components/layout/page-header';
import { OrderStatusBadge, PaymentStatusBadge } from '@/components/orders/status-badges';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SHEET_SCROLL_BODY } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { useApi } from '@/hooks/use-api';
import { useSession } from '@/hooks/use-session';
import { can } from '@xiaowu/client-core/permissions';
import { errorMessage } from '@/lib/api';
import type { Customer, Order } from '@/lib/orders';
import { TONE_CLASSES } from '@/lib/ui-tokens';
import { cn } from '@/lib/utils';

interface Profile {
  source: string;
  customer: Customer;
  orders: (Order & { total_paid: number; remaining: number; payment_status: string })[];
  totals: { order_count: number; open_orders: number; total_billed: number; total_paid: number; balance_due: number; last_order_at: string | null };
  allowed_actions: { edit: boolean; create_order: boolean; archive: boolean; restore: boolean };
}

export function ClientsScreen() {
  const api = useApi();
  const { user } = useSession();
  const [customers, setCustomers] = useState<Customer[] | null>(null);
  const [problem, setProblem] = useState('');
  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [tick, setTick] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Customer | 'new' | null>(null);
  const [types, setTypes] = useState<string[]>(['Individual']);
  const [result, setResult] = useState<ResultMessage | null>(null);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    api<{ customer_types: string[] }>('GET', '/customers/options').then(({ ok, data }) => ok && setTypes(data.customer_types));
  }, [api]);
  useEffect(() => {
    let cancelled = false;
    api<{ customers: Customer[] }>('GET', `/customers${showArchived ? '?include_archived=true' : ''}`).then(({ ok, data }) => {
      if (cancelled) return;
      if (ok) {
        setCustomers(data.customers);
        setProblem('');
      } else setProblem(errorMessage(data, 'The clients could not be loaded.'));
    });
    return () => {
      cancelled = true;
    };
  }, [api, showArchived, tick]);

  // Presentation only: narrows the rows the person is looking at
  const shown = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!customers || !term) return customers ?? [];
    return customers.filter((c) =>
      [c.full_name, c.contact_person, c.contact_number, c.email, c.social_media].some((v) => v && v.toLowerCase().includes(term))
    );
  }, [customers, search]);

  return (
    <div className="space-y-5">
      <PageHeader
        icon={BookUser}
        title="Clients"
        description="Each client’s contacts, their orders, and what they still owe."
        actions={
          can(user, 'create_order') && (
            <Button onClick={() => setEditing('new')}>
              <Plus aria-hidden /> Add client
            </Button>
          )
        }
      />
      <div className="flex flex-wrap items-end gap-3">
        <Field id="client-search" label="Search" className="min-w-56 flex-1">
          <div className="relative flex items-center">
            <Search className="pointer-events-none absolute left-2.5 size-4 text-muted-foreground" aria-hidden />
            <Input id="client-search" className="pl-8" placeholder="Name, contact person, number, email" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </Field>
        <label className="flex min-h-10 items-center gap-2 text-sm">
          <input type="checkbox" className="size-4" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          Show archived
        </label>
      </div>
      <LoadProblem message={problem} />
      {!customers && !problem ? (
        <Skeleton className="h-48 w-full" />
      ) : shown.length === 0 ? (
        <p className="rounded-md border bg-card p-6 text-center text-sm text-muted-foreground">{search ? 'No client matches.' : 'No clients yet.'}</p>
      ) : (
        <div className="max-w-full min-w-0 overflow-x-auto rounded-md border bg-card">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead>Client</TableHead>
                <TableHead className="hidden sm:table-cell">Type</TableHead>
                <TableHead className="hidden md:table-cell">Contact person</TableHead>
                <TableHead>Mobile</TableHead>
                <TableHead className="hidden lg:table-cell">Email</TableHead>
                <TableHead className="hidden lg:table-cell">Came from</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((c) => (
                <TableRow key={c.customer_id} className="cursor-pointer" onClick={() => setOpenId(c.customer_id)}>
                  <TableCell className="whitespace-normal">
                    <button type="button" className="font-medium text-primary underline-offset-4 hover:underline" onClick={() => setOpenId(c.customer_id)}>
                      {c.full_name}
                    </button>
                    {c.archived_at && <Badge variant="outline" className={cn('ml-2', TONE_CLASSES.muted.badge)}>Archived</Badge>}
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">{c.customer_type || 'Individual'}</TableCell>
                  <TableCell className="hidden md:table-cell">{c.contact_person || '—'}</TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums">{c.contact_number ? formatMobile(c.contact_number) : '—'}</TableCell>
                  <TableCell className="hidden lg:table-cell">{c.email || '—'}</TableCell>
                  <TableCell className="hidden lg:table-cell">{c.platform_source || '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <ClientProfileSheet customerId={openId} tick={tick} onClose={() => setOpenId(null)} onEdit={(c) => setEditing(c)} />
      {editing && (
        <ClientFormDialog
          customer={editing === 'new' ? null : editing}
          types={types}
          onClose={() => setEditing(null)}
          onSaved={(message) => {
            setEditing(null);
            setResult({ type: 'success', title: 'Client saved', message });
            reload();
          }}
        />
      )}
      <ResultDialog result={result} onClose={() => setResult(null)} />
    </div>
  );
}

function ClientProfileSheet({
  customerId,
  tick,
  onClose,
  onEdit,
}: {
  customerId: string | null;
  tick: number;
  onClose: () => void;
  onEdit: (c: Customer) => void;
}) {
  const api = useApi();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [problem, setProblem] = useState('');
  useEffect(() => {
    if (!customerId) return undefined;
    let cancelled = false;
    api<Profile>('GET', `/customers/${encodeURIComponent(customerId)}`).then(({ ok, data }) => {
      if (cancelled) return;
      if (ok) {
        setProfile(data);
        setProblem('');
      } else {
        setProfile(null);
        setProblem(errorMessage(data, 'This client could not be loaded.'));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [api, customerId, tick]);
  const shown = profile && profile.customer.customer_id === customerId ? profile : null;
  const c = shown?.customer;

  return (
    <Sheet open={Boolean(customerId)} onOpenChange={(next) => !next && onClose()}>
      <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-3xl">
        <SheetHeader className="border-b pr-12">
          <SheetTitle>{c?.full_name ?? 'Client'}</SheetTitle>
          <SheetDescription>{c ? `${c.customer_type || 'Individual'}${c.platform_source ? ` · came from ${c.platform_source}` : ''}` : 'Loading…'}</SheetDescription>
          {shown && (
            <div className="flex flex-wrap gap-2 pt-1">
              {shown.allowed_actions.create_order && (
                <Button size="sm" asChild>
                  <Link href={`/orders/new?customer=${encodeURIComponent(shown.customer.customer_id)}`}>
                    <PlusCircle aria-hidden /> New order for this client
                  </Link>
                </Button>
              )}
              {shown.allowed_actions.edit && (
                <Button size="sm" variant="outline" onClick={() => onEdit(shown.customer)}>
                  <Pencil aria-hidden /> Edit profile
                </Button>
              )}
            </div>
          )}
        </SheetHeader>
        <div className={cn('min-h-0 flex-1 space-y-5 overflow-y-auto p-4', SHEET_SCROLL_BODY)}>
          <LoadProblem message={problem} />
          {!shown && !problem && <Skeleton className="h-64 w-full" />}
          {shown && c && (
            <>
              <ul className="grid gap-2 text-sm sm:grid-cols-2">
                <Contact icon={UserRound} label="Contact person" value={c.contact_person} />
                <Contact icon={Phone} label="Mobile" value={c.contact_number ? formatMobile(c.contact_number) : null} />
                <Contact icon={Mail} label="Email" value={c.email} />
                <Contact icon={MessageCircle} label="Social media" value={c.social_media} />
                <Contact icon={MapPin} label="Address" value={c.address} />
              </ul>
              {c.notes && <p className="rounded-md border bg-muted/30 p-3 text-sm whitespace-pre-wrap">{c.notes}</p>}
              <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                <Stat label="Orders" value={`${shown.totals.order_count} (${shown.totals.open_orders} open)`} />
                <Stat label="Billed" value={peso(shown.totals.total_billed)} />
                <Stat label="Paid" value={peso(shown.totals.total_paid)} />
                <Stat label="Still owes" value={peso(shown.totals.balance_due)} tone={shown.totals.balance_due > 0 ? 'warning' : undefined} />
              </dl>
              <section className="space-y-2">
                <h3 className="font-semibold">Order history</h3>
                {shown.orders.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No orders yet.</p>
                ) : (
                  <div className="max-w-full min-w-0 overflow-x-auto rounded-md border">
                    <Table>
                      <TableHeader className="bg-muted/50">
                        <TableRow>
                          <TableHead>Order</TableHead>
                          <TableHead className="hidden sm:table-cell">Created</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead className="text-right">Bill</TableHead>
                          <TableHead className="text-right">Balance</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {shown.orders.map((o) => (
                          <TableRow key={o.order_id}>
                            <TableCell>
                              <Link className="font-mono text-sm text-primary underline-offset-4 hover:underline" href={`/orders?order=${encodeURIComponent(o.order_id)}`}>
                                {orderNumber(o)}
                              </Link>
                            </TableCell>
                            <TableCell className="hidden whitespace-nowrap sm:table-cell">{formatDateTime(o.date_created, { utc: true, withTime: false })}</TableCell>
                            <TableCell className="space-x-1 whitespace-normal">
                              <OrderStatusBadge status={o.production_status} />
                              <PaymentStatusBadge status={o.payment_status} />
                            </TableCell>
                            <TableCell className="text-right tabular-nums">{peso(o.total_quote_amount)}</TableCell>
                            <TableCell className="text-right tabular-nums">{peso(o.remaining)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Contact({ icon: Icon, label, value }: { icon: typeof Phone; label: string; value: string | null | undefined }) {
  return (
    <li className="flex min-w-0 items-start gap-2" title={label}>
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="sr-only">{label}: </span>
      <span className={cn('min-w-0 whitespace-pre-wrap wrap-anywhere', !value && 'text-muted-foreground')}>{value || 'Not given'}</span>
    </li>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'warning' }) {
  return (
    <div className="rounded-md border bg-card p-2">
      <dt className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{label}</dt>
      <dd className={cn('font-medium tabular-nums', tone && TONE_CLASSES[tone].text)}>{value}</dd>
    </div>
  );
}

const EMPTY = { full_name: '', contact_number: '', platform_source: '', customer_type: 'Individual', contact_person: '', email: '', address: '', social_media: '', notes: '' };
type Form = typeof EMPTY;

export function ClientFormDialog({
  customer,
  types,
  onClose,
  onSaved,
}: {
  customer: Customer | null;
  types: string[];
  onClose: () => void;
  onSaved: (message: string, customer?: Customer) => void;
}) {
  const api = useApi();
  const [form, setForm] = useState<Form>(() =>
    customer ? (Object.fromEntries(Object.keys(EMPTY).map((k) => [k, (customer as unknown as Record<string, string | null>)[k] ?? (k === 'customer_type' ? 'Individual' : '')])) as Form) : EMPTY
  );
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (key: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setProblem('');
    setErrors({});
    const body = Object.fromEntries(
      Object.entries(form).map(([k, v]) => [k, v.trim() === '' ? (customer && k !== 'full_name' ? null : undefined) : v.trim()])
    );
    setBusy(true);
    const { ok, data } = customer
      ? await api<{ message?: string; customer?: Customer }>('PATCH', `/customers/${encodeURIComponent(customer.customer_id)}`, body)
      : await api<{ message?: string; customer?: Customer }>('POST', '/customers', body);
    setBusy(false);
    if (!ok) {
      setErrors(fieldErrorsMap(data));
      setProblem(bannerText(data, Object.keys(EMPTY), 'The client was not saved.'));
      return;
    }
    onSaved(data.message ?? 'Client saved.', data.customer);
  };

  return (
    <Dialog open onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{customer ? `Edit ${customer.full_name}` : 'Add a client'}</DialogTitle>
          <DialogDescription>Only the name is required. The rest helps when the order is ready for pick-up.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <FormProblem message={problem} />
          <RequiredNote />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="cl-name" label="Client name *" error={errors.full_name} className="sm:col-span-2">
              <Input id="cl-name" required maxLength={255} value={form.full_name} onChange={set('full_name')} autoFocus />
            </Field>
            <Field id="cl-type" label="Type of client" error={errors.customer_type}>
              <Select value={form.customer_type} onValueChange={(v) => setForm((f) => ({ ...f, customer_type: v }))}>
                <SelectTrigger id="cl-type" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {types.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field id="cl-person" label="Contact person" error={errors.contact_person} hint="For a school or company: who to talk to">
              <Input id="cl-person" maxLength={255} value={form.contact_person} onChange={set('contact_person')} />
            </Field>
            <Field id="cl-mobile" label="Mobile number" error={errors.contact_number} hint="11 digits, starts with 0">
              <Input
                id="cl-mobile"
                type="tel"
                inputMode="numeric"
                maxLength={11}
                placeholder="09XXXXXXXXX"
                value={form.contact_number}
                onChange={(e) => setForm((f) => ({ ...f, contact_number: e.target.value.replace(/\D/g, '').slice(0, 11) }))}
              />
            </Field>
            <Field id="cl-email" label="Email" error={errors.email}>
              <Input id="cl-email" type="email" maxLength={255} value={form.email} onChange={set('email')} />
            </Field>
            <Field id="cl-social" label="Social media" error={errors.social_media} hint="e.g. facebook.com/agdaonhs">
              <Input id="cl-social" maxLength={255} value={form.social_media} onChange={set('social_media')} />
            </Field>
            <Field id="cl-source" label="Came from" error={errors.platform_source}>
              <Input id="cl-source" maxLength={100} placeholder="Facebook, walk-in…" value={form.platform_source} onChange={set('platform_source')} />
            </Field>
            <Field id="cl-address" label="Address" error={errors.address} className="sm:col-span-2">
              <Textarea id="cl-address" rows={2} maxLength={1000} value={form.address} onChange={set('address')} />
            </Field>
            <Field id="cl-notes" label="Notes" error={errors.notes} className="sm:col-span-2">
              <Textarea id="cl-notes" rows={2} maxLength={1000} value={form.notes} onChange={set('notes')} />
            </Field>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" busy={busy} disabled={busy}>
              {busy ? 'Saving…' : 'Save client'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
