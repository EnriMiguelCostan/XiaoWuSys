'use client';

// Stock in / Stock out / Stock count (migration 015). One screen, three kinds of record:
//   stock_in     a delivery or purchase received: supplier, its paper and number, items and costs
//   stock_out    stock that left without an order using it: why, items
//   stock_count  a physical count: what was counted (the server records the difference)
// Everything is decided by the server (routes/stock.js): the number (SI- / SO- / SC-), the new
// stock, the average cost, whether free stock allows it, and which buttons this account gets
// (document.allowed_actions, options.can_record). The forms only collect what was received,
// taken out or counted, and show the server's message when it says no.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  ArrowDownToLine, ArrowUpFromLine, Ban, ClipboardCheck, Pencil, Plus, Printer, Search, Trash2, Truck,
} from 'lucide-react';
import { formatDateTime, peso } from '@xiaowu/client-core/format';
import { ResultDialog, type ResultMessage } from '@/components/feedback/result-dialog';
import { bannerText, Field, fieldErrorsMap, FormProblem, RequiredNote } from '@/components/forms/form-bits';
import { BoundedSelectContent, BoundedSelectItem, BoundedSelectTrigger } from '@/components/forms/bounded-select';
import { LoadProblem, PageHeader } from '@/components/layout/page-header';
import { SupplierFormDialog } from '@/components/suppliers/supplier-form-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { useApi } from '@/hooks/use-api';
import { useInventorySnapshot } from '@/hooks/use-inventory-snapshot';
import { errorMessage } from '@/lib/api';
import { toNumberInput } from '@/lib/inventory';
import { MONEY_INPUT_MAX, WHOLE_NUMBER_MAX } from '@/lib/input-limits';
import { printStockDocument } from '@/lib/print';
import {
  nowForInput,
  utcToInput,
  type StockDocument,
  type StockDocumentDetail,
  type StockDocumentList,
  type StockDocumentType,
  type StockOptions,
  type Supplier,
} from '@/lib/stock';
import { toast } from '@/lib/toast';
import { TONE_CLASSES } from '@/lib/ui-tokens';
import { cn } from '@/lib/utils';

const PAGE = {
  stock_in: {
    icon: ArrowDownToLine,
    title: 'Stock in',
    record: 'Record stock in',
    description: 'Deliveries and purchases received. Each one raises the stock and updates the item’s average cost.',
    empty: 'No deliveries recorded yet.',
  },
  stock_out: {
    icon: ArrowUpFromLine,
    title: 'Stock out',
    record: 'Record stock out',
    description: 'Stock that leaves without an order using it: returned to a supplier, used in the shop, samples, expired. Damaged or misprinted stock goes to Waste.',
    empty: 'No stock out recorded yet.',
  },
  stock_count: {
    icon: ClipboardCheck,
    title: 'Stock count',
    record: 'Record a count',
    description: 'A physical count of the shelves. The counted quantity becomes the system quantity, and the difference is kept on the stock card.',
    empty: 'No counts recorded yet.',
  },
} as const;

const STATUS_TONE: Record<string, keyof typeof TONE_CLASSES> = { Recorded: 'success', Corrected: 'info', Voided: 'danger' };
const NO_SUPPLIER = '__none__';

interface Line {
  key: number;
  inventory_id: string;
  quantity: string;
  unit_cost: string;
}
let lineKey = 0;
const newLine = (inventory_id = '', unit_cost = ''): Line => ({ key: ++lineKey, inventory_id, quantity: '', unit_cost });

export function StockDocumentsScreen({ type }: { type: StockDocumentType }) {
  const api = useApi();
  const page = PAGE[type];
  const params = useSearchParams();
  const [options, setOptions] = useState<StockOptions | null>(null);
  const [list, setList] = useState<StockDocumentList | null>(null);
  const [problem, setProblem] = useState('');
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [limit, setLimit] = useState(50);
  const [tick, setTick] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const [form, setForm] = useState<{ editing: StockDocumentDetail | null } | null>(null);
  const [result, setResult] = useState<ResultMessage | null>(null);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    api<StockOptions>('GET', '/stock/options').then(({ ok, data }) => ok && setOptions(data));
  }, [api]);

  useEffect(() => {
    let cancelled = false;
    const q = new URLSearchParams({ type, limit: String(limit) });
    if (search.trim()) q.set('search', search.trim());
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    api<StockDocumentList>('GET', `/stock/documents?${q}`).then(({ ok, data }) => {
      if (cancelled) return;
      if (ok) {
        setList(data);
        setProblem('');
      } else {
        setProblem(errorMessage(data, 'The records could not be loaded.'));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [api, type, search, from, to, limit, tick]);

  const canRecord = Boolean(options?.can_record[type]);
  // A link such as /inventory/stock-in?new=1&supplier=SUP-… opens the form at once (until closed)
  const [linkFormClosed, setLinkFormClosed] = useState(false);
  const fromLink = params.get('new') === '1' && canRecord && !linkFormClosed;
  const shownForm = form ?? (fromLink ? { editing: null } : null);
  const closeForm = () => {
    setForm(null);
    setLinkFormClosed(true);
  };
  const Icon = page.icon;

  return (
    <div className="space-y-5">
      <PageHeader
        icon={Icon}
        title={page.title}
        description={page.description}
        actions={
          canRecord && (
            <Button onClick={() => setForm({ editing: null })}>
              <Plus aria-hidden /> {page.record}
            </Button>
          )
        }
      />

      <Card>
        <CardContent className="flex flex-wrap items-end gap-3">
          <Field id="doc-search" label="Search" className="min-w-48 flex-[2_1_14rem]">
            <div className="relative flex items-center">
              <Search className="pointer-events-none absolute left-2.5 size-4 text-muted-foreground" aria-hidden />
              <Input
                id="doc-search"
                className="pl-8"
                placeholder={type === 'stock_in' ? 'Number, receipt no. or supplier' : 'Record number or supplier'}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </Field>
          <Field id="doc-from" label="From" className="w-40">
            <Input id="doc-from" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field id="doc-to" label="To" className="w-40">
            <Input id="doc-to" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
          </Field>
          {(search || from || to) && (
            <Button variant="ghost" onClick={() => { setSearch(''); setFrom(''); setTo(''); }}>
              Clear filters
            </Button>
          )}
        </CardContent>
      </Card>

      <LoadProblem message={problem} />

      {!list && !problem ? (
        <Skeleton className="h-48 w-full" />
      ) : list && list.documents.length === 0 ? (
        <p className="rounded-md border bg-card p-6 text-center text-sm text-muted-foreground">
          {search || from || to ? 'No records match these filters.' : page.empty}
        </p>
      ) : list ? (
        <div className="max-w-full min-w-0 overflow-x-auto rounded-md border bg-card">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead>Number</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>{type === 'stock_in' ? 'Supplier' : type === 'stock_out' ? 'Reason' : 'Notes'}</TableHead>
                {type === 'stock_in' && <TableHead className="hidden md:table-cell">Paper</TableHead>}
                <TableHead className="text-right">Items</TableHead>
                {type !== 'stock_count' && <TableHead className="hidden text-right sm:table-cell">Total</TableHead>}
                <TableHead>Status</TableHead>
                <TableHead className="hidden lg:table-cell">Recorded by</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.documents.map((d) => (
                <TableRow key={d.document_id} className="cursor-pointer" onClick={() => setOpenId(d.document_id)}>
                  <TableCell>
                    <button type="button" className="font-mono text-sm font-medium text-primary underline-offset-4 hover:underline" onClick={() => setOpenId(d.document_id)}>
                      {d.document_no}
                    </button>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{formatDateTime(d.occurred_at, { utc: true })}</TableCell>
                  <TableCell className="max-w-56 whitespace-normal wrap-anywhere">
                    {type === 'stock_in' ? d.supplier_name || '—' : type === 'stock_out' ? d.reason : d.notes || '—'}
                  </TableCell>
                  {type === 'stock_in' && (
                    <TableCell className="hidden max-w-48 whitespace-normal wrap-anywhere md:table-cell">
                      {d.reference_no ? `${d.reference_type}: ${d.reference_no}` : d.reference_type}
                    </TableCell>
                  )}
                  <TableCell className="text-right tabular-nums">
                    {d.line_count} <span className="text-xs text-muted-foreground">({(d.total_quantity ?? 0).toLocaleString()} units)</span>
                  </TableCell>
                  {type !== 'stock_count' && <TableCell className="hidden text-right tabular-nums sm:table-cell">{peso(d.total_cost)}</TableCell>}
                  <TableCell>
                    <Badge variant="outline" className={TONE_CLASSES[STATUS_TONE[d.status] ?? 'muted'].badge}>
                      {d.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">{d.recorded_by_name}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {list.total > list.documents.length && (
            <div className="flex justify-center border-t p-3">
              <Button variant="outline" size="sm" onClick={() => setLimit((n) => Math.min(200, n + 50))} disabled={limit >= 200}>
                Show more ({list.documents.length} of {list.total})
              </Button>
            </div>
          )}
        </div>
      ) : null}

      {openId && (
        <DocumentDialog
          documentId={openId}
          options={options}
          onClose={() => setOpenId(null)}
          onEdit={(detail) => {
            setOpenId(null);
            setForm({ editing: detail });
          }}
          onChanged={(r) => {
            setResult(r);
            reload();
          }}
        />
      )}
      {shownForm && options && (
        <DocumentFormDialog
          type={type}
          options={options}
          editing={shownForm.editing}
          presetSupplier={params.get('supplier')}
          presetItem={params.get('item')}
          onClose={closeForm}
          onSaved={(r) => {
            closeForm();
            setResult(r);
            reload();
          }}
        />
      )}
      <ResultDialog result={result} onClose={() => setResult(null)} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// One record: what it says, its lines, who corrected or voided it, and its buttons
function DocumentDialog({
  documentId,
  options,
  onClose,
  onEdit,
  onChanged,
}: {
  documentId: string;
  options: StockOptions | null;
  onClose: () => void;
  onEdit: (detail: StockDocumentDetail) => void;
  onChanged: (result: ResultMessage) => void;
}) {
  const api = useApi();
  const [detail, setDetail] = useState<StockDocumentDetail | null>(null);
  const [problem, setProblem] = useState('');
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<StockDocumentDetail>('GET', `/stock/documents/${encodeURIComponent(documentId)}`).then(({ ok, data }) => {
      if (ok) setDetail(data);
      else setProblem(errorMessage(data, 'This record could not be loaded.'));
    });
  }, [api, documentId]);

  const d = detail?.document;
  const count = d?.document_type === 'stock_count';
  const sendVoid = async () => {
    if (!d || !reason.trim()) return;
    setBusy(true);
    const { ok, data } = await api<{ message?: string }>('POST', `/stock/documents/${encodeURIComponent(d.document_id)}/void`, { reason: reason.trim() });
    setBusy(false);
    if (!ok) {
      setProblem(errorMessage(data, 'The record was not voided.'));
      return;
    }
    onClose();
    onChanged({ type: 'success', title: `${d.document_no} voided`, message: data.message ?? 'The record was voided and its stock reversed.' });
  };

  return (
    <Dialog open onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {d ? `${d.label} ${d.document_no}` : 'Loading…'}
            {d && (
              <Badge variant="outline" className={TONE_CLASSES[STATUS_TONE[d.status] ?? 'muted'].badge}>
                {d.status}
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription>{d ? `${formatDateTime(d.occurred_at, { utc: true })} · recorded by ${d.recorded_by_name}` : 'Please wait.'}</DialogDescription>
        </DialogHeader>
        <FormProblem message={problem} />
        {!detail && !problem && <Skeleton className="h-40 w-full" />}
        {detail && d && (
          <div className="space-y-4">
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              {d.supplier_name && <Meta label="Supplier" value={d.supplier_name} />}
              {d.reference_type && <Meta label="Paper" value={d.reference_no ? `${d.reference_type}: ${d.reference_no}` : d.reference_type} />}
              {d.document_type === 'stock_out' && <Meta label="Reason" value={d.reason} />}
              {d.notes && <Meta label="Notes" value={d.notes} />}
              {!count && <Meta label="Total" value={peso(d.total_cost)} />}
              {d.voided_at && <Meta label="Voided" value={`${formatDateTime(d.voided_at, { utc: true })} by ${d.voided_by_name}: ${d.void_reason}`} />}
            </dl>
            <div className="max-w-full min-w-0 overflow-x-auto rounded-md border">
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead>Item</TableHead>
                    {count ? (
                      <>
                        <TableHead className="text-right">System had</TableHead>
                        <TableHead className="text-right">Counted</TableHead>
                        <TableHead className="text-right">Difference</TableHead>
                      </>
                    ) : (
                      <>
                        <TableHead className="text-right">Qty</TableHead>
                        <TableHead className="text-right">Unit cost</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                      </>
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.lines.map((l) => (
                    <TableRow key={l.line_id}>
                      <TableCell className="whitespace-normal wrap-anywhere">
                        {l.item_name} {l.unit && <span className="text-xs text-muted-foreground">({l.unit})</span>}
                      </TableCell>
                      {count ? (
                        <>
                          <TableCell className="text-right tabular-nums">{l.system_quantity?.toLocaleString()}</TableCell>
                          <TableCell className="text-right tabular-nums">{l.quantity.toLocaleString()}</TableCell>
                          <TableCell className={cn('text-right tabular-nums', (l.difference ?? 0) < 0 && TONE_CLASSES.danger.text)}>
                            {(l.difference ?? 0) > 0 ? `+${l.difference}` : l.difference}
                          </TableCell>
                        </>
                      ) : (
                        <>
                          <TableCell className="text-right tabular-nums">{l.quantity.toLocaleString()}</TableCell>
                          <TableCell className="text-right tabular-nums">{peso(l.unit_cost)}</TableCell>
                          <TableCell className="text-right tabular-nums">{peso(l.line_total ?? 0)}</TableCell>
                        </>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {detail.history.length > 0 && (
              <div className="space-y-1 text-sm">
                <p className="font-semibold">Changes</p>
                <ul className="list-disc pl-5 text-muted-foreground">
                  {detail.history.map((h, i) => (
                    <li key={i}>
                      {h.action} on {formatDateTime(h.at, { utc: true })} by {h.by_name}
                      {h.reason ? `: ${h.reason}` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {voiding && (
              <div className="space-y-2 rounded-md border bg-muted/30 p-3">
                <Field id="void-doc-reason" label="Why is this record voided? *">
                  <Textarea id="void-doc-reason" rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
                </Field>
                <p className="text-xs text-muted-foreground">Its stock is reversed. The record stays, marked Voided.</p>
              </div>
            )}
          </div>
        )}
        <DialogFooter className="flex-wrap gap-2">
          {detail && (
            <Button variant="outline" onClick={() => !printStockDocument(detail) && toast.error('Could not open the print window', 'Allow pop-ups for this site.')}>
              <Printer aria-hidden /> Print
            </Button>
          )}
          {d?.allowed_actions.edit && !voiding && (
            <Button variant="outline" onClick={() => detail && onEdit(detail)}>
              <Pencil aria-hidden /> Correct
            </Button>
          )}
          {d?.allowed_actions.void && options?.can_void && (
            voiding ? (
              <Button variant="destructive" busy={busy} disabled={busy || !reason.trim()} onClick={() => void sendVoid()}>
                <Ban aria-hidden /> {busy ? 'Voiding…' : 'Void record'}
              </Button>
            ) : (
              <Button variant="outline" onClick={() => setVoiding(true)}>
                <Ban aria-hidden /> Void
              </Button>
            )
          )}
          <Button onClick={onClose} disabled={busy}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Meta({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-md border bg-card p-2">
      <dt className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{label}</dt>
      <dd className="wrap-anywhere">{value}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Record (or correct) one stock in / stock out / count
function DocumentFormDialog({
  type,
  options,
  editing,
  presetSupplier,
  presetItem,
  onClose,
  onSaved,
}: {
  type: StockDocumentType;
  options: StockOptions;
  editing: StockDocumentDetail | null;
  presetSupplier: string | null;
  presetItem: string | null;
  onClose: () => void;
  onSaved: (result: ResultMessage) => void;
}) {
  const api = useApi();
  const { snapshot } = useInventorySnapshot();
  const items = useMemo(() => snapshot?.items ?? [], [snapshot]);
  const doc = editing?.document;
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [addingSupplier, setAddingSupplier] = useState(false);
  const [occurredAt, setOccurredAt] = useState(() => (doc ? utcToInput(doc.occurred_at) : nowForInput()));
  const [supplierId, setSupplierId] = useState(doc?.supplier_id ?? presetSupplier ?? '');
  const [referenceType, setReferenceType] = useState(doc?.reference_type ?? (type === 'stock_in' ? options.reference_types[0] : ''));
  const [referenceNo, setReferenceNo] = useState(doc?.reference_no ?? '');
  const [reason, setReason] = useState(doc?.reason ?? (type === 'stock_out' ? options.stock_out_reasons[0] : ''));
  const [notes, setNotes] = useState(doc?.notes ?? '');
  const [correctionReason, setCorrectionReason] = useState('');
  const [lines, setLines] = useState<Line[]>(() =>
    editing
      ? editing.lines.map((l) => ({ key: ++lineKey, inventory_id: l.inventory_id, quantity: String(l.quantity), unit_cost: String(l.unit_cost) }))
      : [newLine(presetItem ?? '')]
  );
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const loadSuppliers = useCallback(
    () => api<{ suppliers: Supplier[] }>('GET', '/suppliers').then(({ ok, data }) => ok && setSuppliers(data.suppliers)),
    [api]
  );
  useEffect(() => {
    void loadSuppliers();
  }, [loadSuppliers]);

  const itemById = useMemo(() => new Map(items.map((i) => [i.inventory_id, i])), [items]);
  const setLine = (key: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const needsSupplier = type === 'stock_in' || reason === 'Returned to supplier';
  const notesRequired = options.note_required_reasons.includes(reason);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setProblem('');
    setFieldErrors({});
    if (lines.some((l) => !l.inventory_id)) {
      setProblem('Choose an item on every line, or remove the empty line.');
      return;
    }
    const body: Record<string, unknown> = {
      document_type: type,
      occurred_at: occurredAt,
      supplier_id: supplierId && supplierId !== NO_SUPPLIER ? supplierId : undefined,
      notes: notes.trim() || undefined,
      lines: lines.map((l) =>
        type === 'stock_count'
          ? { inventory_id: l.inventory_id, counted_quantity: toNumberInput(l.quantity) }
          : type === 'stock_in'
            ? { inventory_id: l.inventory_id, quantity: toNumberInput(l.quantity), unit_cost: toNumberInput(l.unit_cost) }
            : { inventory_id: l.inventory_id, quantity: toNumberInput(l.quantity) }
      ),
    };
    if (type === 'stock_in') {
      body.reference_type = referenceType;
      body.reference_no = referenceNo.trim() || undefined;
    }
    if (type === 'stock_out') body.reason = reason;
    setBusy(true);
    const { ok, data } = editing
      ? await api<{ message?: string }>('PUT', `/stock/documents/${encodeURIComponent(editing.document.document_id)}`, {
          ...body,
          correction_reason: correctionReason.trim() || undefined,
          expected_version: editing.document.version || undefined,
        })
      : await api<{ message?: string }>('POST', '/stock/documents', body);
    setBusy(false);
    if (!ok) {
      setFieldErrors(fieldErrorsMap(data));
      setProblem(bannerText(data, ['occurred_at', 'supplier_id', 'reference_type', 'reference_no', 'reason', 'notes', 'correction_reason'], 'Nothing was saved.'));
      return;
    }
    onSaved({ type: 'success', title: editing ? 'Record corrected' : 'Saved', message: data.message ?? 'The record was saved.' });
  };

  const lineError = (i: number, field: string) => fieldErrors[`lines[${i}].${field}`];

  return (
    <Dialog open onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{editing ? `Correct ${editing.document.document_no}` : PAGE[type].record}</DialogTitle>
          <DialogDescription>
            {type === 'stock_in'
              ? 'Type what came in, exactly as on the supplier’s paper. The stock goes up when you save.'
              : type === 'stock_out'
                ? 'Only free stock can go out (stock held for orders stays).'
                : 'Count each item on the shelf and type what you counted. The system quantity is shown for reference.'}
            {editing && ' Only the difference from the first record is applied to the stock.'}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <FormProblem message={problem} />
          <RequiredNote />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="doc-when" label={type === 'stock_in' ? 'Date and time received *' : type === 'stock_out' ? 'Date and time taken out *' : 'Date and time counted *'} error={fieldErrors.occurred_at} hint="Can be earlier than today, never later.">
              <Input id="doc-when" type="datetime-local" required max={nowForInput()} value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} />
            </Field>
            {type === 'stock_out' && (
              <Field id="doc-reason" label="Why did it leave? *" error={fieldErrors.reason}>
                <Select value={reason} onValueChange={setReason}>
                  <SelectTrigger id="doc-reason" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {options.stock_out_reasons.map((r) => (
                      <SelectItem key={r} value={r}>
                        {r}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}
            {type !== 'stock_count' && (
              <Field id="doc-supplier" label={needsSupplier ? 'Supplier *' : 'Supplier'} error={fieldErrors.supplier_id}>
                <div className="flex gap-2">
                  <Select value={supplierId || NO_SUPPLIER} onValueChange={(v) => setSupplierId(v === NO_SUPPLIER ? '' : v)}>
                    <BoundedSelectTrigger id="doc-supplier" className="min-w-0 flex-1">
                      <SelectValue placeholder="Choose the supplier…" />
                    </BoundedSelectTrigger>
                    <BoundedSelectContent>
                      {!needsSupplier && <BoundedSelectItem value={NO_SUPPLIER} label="No supplier">No supplier</BoundedSelectItem>}
                      {suppliers.map((s) => (
                        <BoundedSelectItem key={s.supplier_id} value={s.supplier_id} label={s.supplier_name}>
                          {s.supplier_name}
                        </BoundedSelectItem>
                      ))}
                    </BoundedSelectContent>
                  </Select>
                  <Button type="button" variant="outline" onClick={() => setAddingSupplier(true)} title="Add a supplier">
                    <Truck aria-hidden /> New
                  </Button>
                </div>
              </Field>
            )}
            {type === 'stock_in' && (
              <>
                <Field id="doc-ref-type" label="Paper received *" error={fieldErrors.reference_type}>
                  <Select value={referenceType} onValueChange={setReferenceType}>
                    <SelectTrigger id="doc-ref-type" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {options.reference_types.map((r) => (
                        <SelectItem key={r} value={r}>
                          {r}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                {referenceType !== 'No paper' && (
                  <Field id="doc-ref-no" label="Number on the paper *" error={fieldErrors.reference_no} hint="e.g. the DR, invoice or receipt number">
                    <Input id="doc-ref-no" maxLength={100} value={referenceNo} onChange={(e) => setReferenceNo(e.target.value)} />
                  </Field>
                )}
              </>
            )}
          </div>

          <div className="space-y-2">
            <p className="text-sm font-semibold">Items</p>
            {!snapshot ? (
              <Skeleton className="h-9 w-full" />
            ) : (
              lines.map((line, i) => {
                const item = itemById.get(line.inventory_id);
                return (
                  <div key={line.key} className="flex flex-wrap items-end gap-2 rounded-md border p-2">
                    <div className="flex min-w-0 flex-[3_1_14rem] flex-col gap-1">
                      <label htmlFor={`doc-item-${line.key}`} className={cn('text-xs font-medium', i > 0 && 'sr-only')}>
                        Item
                      </label>
                      <Select
                        value={line.inventory_id}
                        onValueChange={(v) => setLine(line.key, { inventory_id: v, unit_cost: line.unit_cost || String(itemById.get(v)?.unit_cost ?? '') })}
                      >
                        <BoundedSelectTrigger id={`doc-item-${line.key}`} aria-label={`Item ${i + 1}`} aria-invalid={lineError(i, 'inventory_id') ? true : undefined}>
                          <SelectValue placeholder="Choose an item…" />
                        </BoundedSelectTrigger>
                        <BoundedSelectContent>
                          {items.map((it) => (
                            <BoundedSelectItem
                              key={it.inventory_id}
                              value={it.inventory_id}
                              label={it.item_name}
                              suffix={type === 'stock_out' ? `(${it.quantity_available_net.toLocaleString()} free)` : `(${it.quantity_available.toLocaleString()} ${it.unit ?? ''} on hand)`}
                            >
                              {it.item_name}
                            </BoundedSelectItem>
                          ))}
                        </BoundedSelectContent>
                      </Select>
                    </div>
                    {type === 'stock_count' && item && (
                      <p className="w-28 text-xs text-muted-foreground">
                        System: <strong className="tabular-nums text-foreground">{item.quantity_available.toLocaleString()}</strong>
                        <br />
                        Held: <span className="tabular-nums">{item.quantity_reserved.toLocaleString()}</span>
                      </p>
                    )}
                    <div className="flex w-28 flex-col gap-1">
                      <label htmlFor={`doc-qty-${line.key}`} className={cn('text-xs font-medium', i > 0 && 'sr-only')}>
                        {type === 'stock_count' ? 'Counted' : 'Quantity'}
                      </label>
                      <Input
                        id={`doc-qty-${line.key}`}
                        type="number"
                        min={type === 'stock_count' ? 0 : 1}
                        max={WHOLE_NUMBER_MAX}
                        step={1}
                        required
                        inputMode="numeric"
                        aria-invalid={lineError(i, type === 'stock_count' ? 'counted_quantity' : 'quantity') ? true : undefined}
                        value={line.quantity}
                        onChange={(e) => setLine(line.key, { quantity: e.target.value })}
                      />
                    </div>
                    {type === 'stock_in' && (
                      <div className="flex w-32 flex-col gap-1">
                        <label htmlFor={`doc-cost-${line.key}`} className={cn('text-xs font-medium', i > 0 && 'sr-only')}>
                          Unit cost (₱)
                        </label>
                        <Input
                          id={`doc-cost-${line.key}`}
                          type="number"
                          min={0}
                          max={MONEY_INPUT_MAX}
                          step="any"
                          required
                          inputMode="decimal"
                          aria-invalid={lineError(i, 'unit_cost') ? true : undefined}
                          value={line.unit_cost}
                          onChange={(e) => setLine(line.key, { unit_cost: e.target.value })}
                        />
                      </div>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      disabled={lines.length === 1}
                      onClick={() => setLines((ls) => ls.filter((l) => l.key !== line.key))}
                      aria-label={`Remove item ${i + 1}`}
                      title={`Remove item ${i + 1}`}
                    >
                      <Trash2 aria-hidden />
                    </Button>
                    {Object.entries(fieldErrors)
                      .filter(([k]) => k.startsWith(`lines[${i}].`))
                      .map(([k, m]) => (
                        <p key={k} className={cn('w-full text-xs', TONE_CLASSES.danger.text)}>
                          {m}
                        </p>
                      ))}
                  </div>
                );
              })
            )}
            <Button type="button" variant="outline" size="sm" onClick={() => setLines((ls) => [...ls, newLine()])} disabled={lines.length >= options.lines_max}>
              <Plus aria-hidden /> Add another item
            </Button>
          </div>

          <Field id="doc-notes" label={notesRequired ? 'Notes *' : 'Notes'} error={fieldErrors.notes} hint={notesRequired ? 'Write what happened to the stock.' : undefined}>
            <Textarea id="doc-notes" rows={2} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
          {editing && (
            <Field id="doc-correction-reason" label="Why are you correcting this?" error={fieldErrors.correction_reason} hint="Kept in the record’s history, e.g. “Wrong quantity typed, receipt says 48”.">
              <Input id="doc-correction-reason" maxLength={500} value={correctionReason} onChange={(e) => setCorrectionReason(e.target.value)} />
            </Field>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" busy={busy} disabled={busy}>
              {busy ? 'Saving…' : editing ? 'Save correction' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
      {addingSupplier && (
        <SupplierFormDialog
          supplier={null}
          onClose={() => setAddingSupplier(false)}
          onSaved={(s) => {
            setAddingSupplier(false);
            void loadSuppliers().then(() => s && setSupplierId(s.supplier_id));
          }}
        />
      )}
    </Dialog>
  );
}

export type { StockDocument };
