'use client';

// Clients (migration 015): every customer's profile (contact person, phone, email, address,
// social media, notes), their order history and what they still owe. The list is
// GET /api/customers; a profile is GET /api/customers/:id, which also sends the totals and the
// buttons this account may use. Saving goes to POST / PATCH /api/customers (works offline too).
//
// Migration 016 (adviser consultation, second round): the client's own contacts and the contact
// person's own phone / email / social media are kept apart, social media may list several
// accounts, the client's address is its MAIN branch and other branches can be added
// (POST / PATCH /api/customers/:id/branches, online only), and the order history is split into
// pending (waiting for approval), current and past orders, each with the branch it was for.
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Archive, ArchiveRestore, ArrowLeft, BookUser, Building2, Mail, MapPin, MessageCircle, Pencil, Phone, Plus, PlusCircle, Search, UserRound } from 'lucide-react';
import { formatDateTime, formatMobile, peso } from '@xiaowu/client-core/format';
import { orderNumber } from '@xiaowu/client-core/orders';
import { ConfirmDialog } from '@/components/feedback/confirm-dialog';
import { ResultDialog, type ResultMessage } from '@/components/feedback/result-dialog';
import { bannerText, Field, fieldErrorsMap, FormProblem, RequiredNote } from '@/components/forms/form-bits';
import { LoadProblem, PageHeader } from '@/components/layout/page-header';
import { DeadlineBadge, OrderStatusBadge, PaymentStatusBadge } from '@/components/orders/status-badges';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SHEET_SCROLL_BODY } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { Toggle } from '@/components/ui/toggle';
import { useApi } from '@/hooks/use-api';
import { useSession } from '@/hooks/use-session';
import { can } from '@xiaowu/client-core/permissions';
import { errorMessage } from '@/lib/api';
import type { Customer, CustomerBranch, Order } from '@/lib/orders';
import { TONE_CLASSES } from '@/lib/ui-tokens';
import { cn } from '@/lib/utils';

type ProfileOrder = Order & {
  total_paid: number;
  remaining: number;
  payment_status: string;
  /** migration 016: 'pending' (waiting for approval), 'current' (approved, in production), 'past' (completed / cancelled) */
  group?: 'pending' | 'current' | 'past' | string;
  branch_name?: string | null;
  branch_address?: string | null;
};
interface Profile {
  source: string;
  customer: Customer;
  orders: ProfileOrder[];
  branches?: CustomerBranch[];
  totals: {
    order_count: number; open_orders: number; total_billed: number; total_paid: number; balance_due: number; last_order_at: string | null;
    pending_orders?: number; current_orders?: number; past_orders?: number;
  };
  allowed_actions: { edit: boolean; create_order: boolean; archive: boolean; restore: boolean; manage_branches?: boolean };
}

const ORDER_GROUPS: { key: string; label: string; empty: string }[] = [
  { key: 'current', label: 'Current', empty: 'No order in production right now.' },
  { key: 'pending', label: 'Pending', empty: 'No order waiting for approval.' },
  { key: 'past', label: 'Past', empty: 'No completed or cancelled orders yet.' },
];

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
    api<{ customers: Customer[] }>('GET', `/customers${showArchived ? '?include_archived=only' : ''}`).then(({ ok, data }) => {
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
      [c.full_name, c.contact_person, c.contact_number, c.email, c.social_media, c.contact_person_number, c.contact_person_email]
        .some((v) => v && v.toLowerCase().includes(term))
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
        <Toggle variant="outline" pressed={showArchived} onPressedChange={setShowArchived} aria-label="Show archived clients">
          <Archive aria-hidden /> Show archived
        </Toggle>
      </div>
      {showArchived && (
        <div className={cn('flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm', TONE_CLASSES.info.banner)}>
          <span>Showing archived clients only. Open one to restore it.</span>
          <Button size="sm" variant="outline" onClick={() => setShowArchived(false)}>
            <ArrowLeft aria-hidden /> Back to active clients
          </Button>
        </div>
      )}
      <LoadProblem message={problem} />
      {!customers && !problem ? (
        <Skeleton className="h-48 w-full" />
      ) : shown.length === 0 ? (
        <p className="rounded-md border bg-card p-6 text-center text-sm text-muted-foreground">{search ? 'No client matches.' : showArchived ? 'No archived clients.' : 'No clients yet.'}</p>
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

      <ClientProfileSheet
        customerId={openId}
        tick={tick}
        onClose={() => setOpenId(null)}
        onEdit={(c) => setEditing(c)}
        onChanged={(r) => {
          setResult(r);
          reload();
        }}
      />
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
  onChanged,
}: {
  customerId: string | null;
  tick: number;
  onClose: () => void;
  onEdit: (c: Customer) => void;
  onChanged: (r: ResultMessage) => void;
}) {
  const api = useApi();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [problem, setProblem] = useState('');
  const [confirm, setConfirm] = useState<'archive' | 'restore' | null>(null);
  const [busy, setBusy] = useState(false);
  const [group, setGroup] = useState('current');
  const [branchForm, setBranchForm] = useState<CustomerBranch | 'new' | null>(null);
  const [localTick, setLocalTick] = useState(0);
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
  }, [api, customerId, tick, localTick]);
  const shown = profile && profile.customer.customer_id === customerId ? profile : null;
  const c = shown?.customer;
  const act = async (kind: 'archive' | 'restore') => {
    if (!c) return;
    setBusy(true);
    const { ok, data } = await api<{ message?: string }>('POST', `/customers/${encodeURIComponent(c.customer_id)}/${kind}`);
    setBusy(false);
    setConfirm(null);
    onChanged(ok ? { type: 'success', title: kind === 'archive' ? 'Client archived' : 'Client restored', message: data.message ?? '' }
      : { type: 'error', title: 'Nothing changed', message: errorMessage(data, 'Nothing was changed.') });
  };

  return (
    <Sheet page open={Boolean(customerId)} onOpenChange={(next) => !next && onClose()}>
      <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-4xl">
        <SheetHeader className="border-b pr-12">
          <SheetTitle>{c?.full_name ?? 'Client'}</SheetTitle>
          <SheetDescription>{c?.archived_at ? 'Archived: kept for the records. Restore to edit or order again.' : c ? `${c.customer_type || 'Individual'}${c.platform_source ? ` · came from ${c.platform_source}` : ''}` : 'Loading…'}</SheetDescription>
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
              {shown.allowed_actions.archive && (
                <Button size="sm" variant="outline" onClick={() => setConfirm('archive')}>
                  <Archive aria-hidden /> Archive
                </Button>
              )}
              {shown.allowed_actions.restore && (
                <Button size="sm" variant="outline" onClick={() => setConfirm('restore')}>
                  <ArchiveRestore aria-hidden /> Restore
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
              <div className="grid gap-3 md:grid-cols-2">
                <section className="space-y-2 rounded-md border p-3" aria-labelledby="client-contacts">
                  <h3 id="client-contacts" className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                    {c.customer_type && c.customer_type !== 'Individual' ? `${c.customer_type}’s contacts` : 'Client’s contacts'}
                  </h3>
                  <ul className="space-y-2 text-sm">
                    <Contact icon={Phone} label="Phone" value={c.contact_number ? formatMobile(c.contact_number) : null} />
                    <Contact icon={Mail} label="Email" value={c.email} />
                    <Contact icon={MessageCircle} label="Social media" value={c.social_media} />
                  </ul>
                </section>
                <section className="space-y-2 rounded-md border p-3" aria-labelledby="client-person">
                  <h3 id="client-person" className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Contact person</h3>
                  <ul className="space-y-2 text-sm">
                    <Contact icon={UserRound} label="Name" value={c.contact_person} />
                    <Contact icon={Phone} label="Phone" value={c.contact_person_number} />
                    <Contact icon={Mail} label="Email" value={c.contact_person_email} />
                    <Contact icon={MessageCircle} label="Social media" value={c.contact_person_social} />
                  </ul>
                </section>
              </div>
              <section className="space-y-2" aria-labelledby="client-branches">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 id="client-branches" className="flex items-center gap-2 font-semibold">
                    <Building2 className="size-4 text-muted-foreground" aria-hidden /> Address and branches
                  </h3>
                  {shown.allowed_actions.manage_branches && (
                    <Button size="sm" variant="outline" onClick={() => setBranchForm('new')}>
                      <Plus aria-hidden /> Add branch
                    </Button>
                  )}
                </div>
                <ul className="grid gap-2 text-sm sm:grid-cols-2">
                  <li className="rounded-md border p-2">
                    <p className="font-medium">
                      Main branch <Badge variant="outline" className="ml-1">Main</Badge>
                    </p>
                    <p className={cn('flex items-start gap-1.5 whitespace-pre-wrap wrap-anywhere', !c.address && 'text-muted-foreground')}>
                      <MapPin className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden /> {c.address || 'No address saved'}
                    </p>
                  </li>
                  {(shown.branches ?? []).map((b) => (
                    <li key={b.branch_id} className={cn('rounded-md border p-2', b.archived_at && 'opacity-60')}>
                      <div className="flex items-start justify-between gap-2">
                        <p className="font-medium wrap-anywhere">
                          {b.branch_name}
                          {b.archived_at && <Badge variant="outline" className={cn('ml-1', TONE_CLASSES.muted.badge)}>Archived</Badge>}
                        </p>
                        {shown.allowed_actions.manage_branches && (
                          <Button size="icon-sm" variant="ghost" onClick={() => setBranchForm(b)} aria-label={`Edit ${b.branch_name}`} title="Edit">
                            <Pencil aria-hidden />
                          </Button>
                        )}
                      </div>
                      <p className={cn('flex items-start gap-1.5 whitespace-pre-wrap wrap-anywhere', !b.address && 'text-muted-foreground')}>
                        <MapPin className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden /> {b.address || 'No address saved'}
                      </p>
                      {(b.contact_person || b.contact_number || b.email) && (
                        <p className="text-xs text-muted-foreground wrap-anywhere">
                          {[b.contact_person, b.contact_number, b.email].filter(Boolean).join(' · ')}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
              {c.notes && <p className="rounded-md border bg-muted/30 p-3 text-sm whitespace-pre-wrap">{c.notes}</p>}
              <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                <Stat label="Orders" value={`${shown.totals.order_count} (${shown.totals.open_orders} open)`} />
                <Stat label="Billed" value={peso(shown.totals.total_billed)} />
                <Stat label="Paid" value={peso(shown.totals.total_paid)} />
                <Stat label="Still owes" value={peso(shown.totals.balance_due)} tone={shown.totals.balance_due > 0 ? 'warning' : undefined} />
              </dl>
              <section className="space-y-2" aria-labelledby="client-orders">
                <h3 id="client-orders" className="font-semibold">Orders</h3>
                {/* Adviser point 1: past, current and pending orders, each with the branch it was for */}
                <div role="tablist" aria-label="Which orders" className="flex flex-wrap gap-1">
                  {ORDER_GROUPS.map((g) => {
                    const n = shown.orders.filter((o) => (o.group ?? 'current') === g.key).length;
                    return (
                      <Button
                        key={g.key}
                        role="tab"
                        aria-selected={group === g.key}
                        size="sm"
                        variant={group === g.key ? 'default' : 'outline'}
                        onClick={() => setGroup(g.key)}
                      >
                        {g.label} <span className="tabular-nums">({n})</span>
                      </Button>
                    );
                  })}
                </div>
                {(() => {
                  const rows = shown.orders.filter((o) => (o.group ?? 'current') === group);
                  const empty = ORDER_GROUPS.find((g) => g.key === group)?.empty ?? 'No orders.';
                  if (rows.length === 0) return <p className="text-sm text-muted-foreground">{shown.orders.length === 0 ? 'No orders yet.' : empty}</p>;
                  return (
                    <div className="max-w-full min-w-0 overflow-x-auto rounded-md border">
                      <Table>
                        <TableHeader className="bg-muted/50">
                          <TableRow>
                            <TableHead>Order</TableHead>
                            <TableHead className="hidden sm:table-cell">Created</TableHead>
                            <TableHead className="hidden md:table-cell">Deadline</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead className="hidden lg:table-cell">Branch</TableHead>
                            <TableHead className="text-right">Bill</TableHead>
                            <TableHead className="text-right">Balance</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {rows.map((o) => (
                            <TableRow key={o.order_id}>
                              <TableCell>
                                <Link className="font-mono text-sm text-primary underline-offset-4 hover:underline" href={`/orders?order=${encodeURIComponent(o.order_id)}`}>
                                  {orderNumber(o)}
                                </Link>
                                {o.order_description && (
                                  <span className="block max-w-48 truncate text-xs text-muted-foreground" title={o.order_description}>
                                    {o.order_description}
                                  </span>
                                )}
                              </TableCell>
                              <TableCell className="hidden whitespace-nowrap sm:table-cell">{formatDateTime(o.date_created, { utc: true, withTime: false })}</TableCell>
                              <TableCell className="hidden whitespace-nowrap md:table-cell">
                                {formatDateTime(o.production_deadline, { withTime: false })}
                                <DeadlineBadge flag={o.deadline_flag} className="ml-1" />
                              </TableCell>
                              <TableCell className="space-x-1 whitespace-normal">
                                <OrderStatusBadge status={o.production_status} />
                                <PaymentStatusBadge status={o.payment_status} />
                              </TableCell>
                              <TableCell className="hidden max-w-48 whitespace-normal lg:table-cell">
                                <span className="block">{o.branch_name || 'Main branch'}</span>
                                {o.branch_address && <span className="block truncate text-xs text-muted-foreground" title={o.branch_address}>{o.branch_address}</span>}
                              </TableCell>
                              <TableCell className="text-right tabular-nums">{peso(o.total_quote_amount)}</TableCell>
                              <TableCell className="text-right tabular-nums">{peso(o.remaining)}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  );
                })()}
              </section>
            </>
          )}
        </div>
      </SheetContent>
      <ConfirmDialog
        open={Boolean(confirm)}
        title={confirm === 'restore' ? 'Restore this client?' : 'Archive this client?'}
        message={confirm === 'restore'
          ? 'The client comes back to the list and can get new orders again.'
          : 'The client is hidden from the list and cannot get new orders. Their past orders and payments are kept. Clients with unfinished orders cannot be archived.'}
        confirmLabel={confirm === 'restore' ? 'Restore' : 'Archive'}
        busy={busy}
        onConfirm={() => confirm && void act(confirm)}
        onCancel={() => setConfirm(null)}
      />
      {branchForm && c && (
        <BranchFormDialog
          customerId={c.customer_id}
          branch={branchForm === 'new' ? null : branchForm}
          onClose={() => setBranchForm(null)}
          onSaved={(message) => {
            setBranchForm(null);
            setLocalTick((n) => n + 1);
            onChanged({ type: 'success', title: 'Branch saved', message });
          }}
        />
      )}
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

const EMPTY = {
  full_name: '', contact_number: '', platform_source: '', customer_type: 'Individual', contact_person: '', email: '', address: '', social_media: '', notes: '',
  // migration 016: the contact person's own details
  contact_person_number: '', contact_person_email: '', contact_person_social: '',
};
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
    <Dialog page open onOpenChange={(next) => !next && !busy && onClose()}>
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
            <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase sm:col-span-2">The client’s own contacts (the company / school)</p>
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
            <Field id="cl-social" label="Social media" error={errors.social_media} hint="One account per line, e.g. facebook.com/agdaonhs" className="sm:col-span-2">
              <Textarea id="cl-social" rows={2} maxLength={1000} value={form.social_media} onChange={set('social_media')} />
            </Field>
            <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase sm:col-span-2">Contact person</p>
            <Field id="cl-person" label="Name" error={errors.contact_person} hint="For a school or company: who to talk to">
              <Input id="cl-person" maxLength={255} value={form.contact_person} onChange={set('contact_person')} />
            </Field>
            <Field id="cl-person-phone" label="Their phone" error={errors.contact_person_number} hint="Mobile or landline">
              <Input id="cl-person-phone" type="tel" maxLength={20} placeholder="09XXXXXXXXX" value={form.contact_person_number} onChange={set('contact_person_number')} />
            </Field>
            <Field id="cl-person-email" label="Their email" error={errors.contact_person_email}>
              <Input id="cl-person-email" type="email" maxLength={255} value={form.contact_person_email} onChange={set('contact_person_email')} />
            </Field>
            <Field id="cl-person-social" label="Their social media" error={errors.contact_person_social} hint="One account per line">
              <Textarea id="cl-person-social" rows={2} maxLength={1000} value={form.contact_person_social} onChange={set('contact_person_social')} />
            </Field>
            <Field id="cl-source" label="Came from" error={errors.platform_source}>
              <Input id="cl-source" maxLength={100} placeholder="Facebook, walk-in…" value={form.platform_source} onChange={set('platform_source')} />
            </Field>
            <Field id="cl-address" label="Address (main branch)" error={errors.address} hint="Other branches are added in the client’s profile" className="sm:col-span-2">
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

// Migration 016: add or edit one of the client's other branches (online only)
const EMPTY_BRANCH = { branch_name: '', address: '', contact_person: '', contact_number: '', email: '', notes: '' };
type BranchForm = typeof EMPTY_BRANCH;

function BranchFormDialog({
  customerId,
  branch,
  onClose,
  onSaved,
}: {
  customerId: string;
  branch: CustomerBranch | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const api = useApi();
  const [form, setForm] = useState<BranchForm>(() =>
    branch
      ? (Object.fromEntries(Object.keys(EMPTY_BRANCH).map((k) => [k, (branch as unknown as Record<string, string | null>)[k] ?? ''])) as BranchForm)
      : EMPTY_BRANCH
  );
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (key: keyof BranchForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const path = `/customers/${encodeURIComponent(customerId)}/branches`;

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setProblem('');
    setErrors({});
    const body = Object.fromEntries(
      Object.entries(form).map(([k, v]) => [k, v.trim() === '' ? (branch && k !== 'branch_name' ? null : undefined) : v.trim()])
    );
    setBusy(true);
    const { ok, data } = branch
      ? await api<{ message?: string }>('PATCH', `${path}/${encodeURIComponent(branch.branch_id)}`, body)
      : await api<{ message?: string }>('POST', path, body);
    setBusy(false);
    if (!ok) {
      setErrors(fieldErrorsMap(data));
      setProblem(bannerText(data, Object.keys(EMPTY_BRANCH), 'The branch was not saved.'));
      return;
    }
    onSaved(data.message ?? 'Branch saved.');
  };

  const archive = async (kind: 'archive' | 'restore') => {
    if (!branch) return;
    setBusy(true);
    const { ok, data } = await api<{ message?: string }>('POST', `${path}/${encodeURIComponent(branch.branch_id)}/${kind}`);
    setBusy(false);
    if (!ok) {
      setProblem(errorMessage(data, 'Nothing was changed.'));
      return;
    }
    onSaved(data.message ?? 'Saved.');
  };

  return (
    <Dialog page open onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{branch ? `Edit ${branch.branch_name}` : 'Add a branch'}</DialogTitle>
          <DialogDescription>An order can name the branch that makes it; its address is shown with the order.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <FormProblem message={problem} />
          <RequiredNote />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="br-name" label="Branch name *" error={errors.branch_name} className="sm:col-span-2">
              <Input id="br-name" required maxLength={255} placeholder="e.g. Toril campus" value={form.branch_name} onChange={set('branch_name')} autoFocus />
            </Field>
            <Field id="br-address" label="Address" error={errors.address} className="sm:col-span-2">
              <Textarea id="br-address" rows={2} maxLength={1000} value={form.address} onChange={set('address')} />
            </Field>
            <Field id="br-person" label="Contact person" error={errors.contact_person}>
              <Input id="br-person" maxLength={255} value={form.contact_person} onChange={set('contact_person')} />
            </Field>
            <Field id="br-phone" label="Phone" error={errors.contact_number} hint="Mobile or landline">
              <Input id="br-phone" type="tel" maxLength={20} value={form.contact_number} onChange={set('contact_number')} />
            </Field>
            <Field id="br-email" label="Email" error={errors.email}>
              <Input id="br-email" type="email" maxLength={255} value={form.email} onChange={set('email')} />
            </Field>
            <Field id="br-notes" label="Notes" error={errors.notes}>
              <Input id="br-notes" maxLength={1000} value={form.notes} onChange={set('notes')} />
            </Field>
          </div>
          <DialogFooter>
            {branch && (
              <Button type="button" variant="outline" className="sm:mr-auto" disabled={busy} onClick={() => void archive(branch.archived_at ? 'restore' : 'archive')}>
                {branch.archived_at ? <ArchiveRestore aria-hidden /> : <Archive aria-hidden />} {branch.archived_at ? 'Restore branch' : 'Archive branch'}
              </Button>
            )}
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" busy={busy} disabled={busy}>
              {busy ? 'Saving…' : 'Save branch'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
