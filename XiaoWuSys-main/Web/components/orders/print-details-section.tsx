'use client';

// Print details of an order (migration 015), apart from its materials:
//   on a garment (a material marked "has sizes"): size, name and number per piece or per size
//   on anything else (mugs, tarpaulins, stickers): the text or name to print, and notes
// The server decides everything: which material a line belongs to, that sizes go on garments
// only, and that the pieces listed never exceed the material's quantity (409). Which buttons
// show comes from allowed_actions.add_print_details. Adding works offline too.
import { useMemo, useState } from 'react';
import { ListPlus, Pencil, Plus, Shirt, Trash2, Type } from 'lucide-react';
import type { OrderActions } from '@xiaowu/client-core/permissions';
import { ConfirmDialog } from '@/components/feedback/confirm-dialog';
import type { ResultMessage } from '@/components/feedback/result-dialog';
import { bannerText, Field, fieldErrorsMap, FormProblem } from '@/components/forms/form-bits';
import { RosterImportDialog } from '@/components/orders/roster-import-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useApi } from '@/hooks/use-api';
import { useOrderOptions } from '@/hooks/use-order-options';
import { GARMENT_SIZES } from '@/lib/input-limits';
import type { OrderDetail, PrintDetail } from '@/lib/orders';
import { TONE_CLASSES } from '@/lib/ui-tokens';
import { cn } from '@/lib/utils';

type OnResult = (result: ResultMessage, reload: boolean) => void;
const WHOLE_ORDER = '__order__';
const NO_SIZE = '__none__';

interface LineForm {
  line_item_id: string;
  print_type: string;
  quantity: string;
  size: string;
  custom_name: string;
  custom_number: string;
  notes: string;
}

export function PrintDetailsSection({
  detail,
  actions,
  onResult,
  onEditing,
}: {
  detail: OrderDetail;
  actions: OrderActions;
  onResult: OnResult;
  onEditing?: (open: boolean) => void;
}) {
  const api = useApi();
  const options = useOrderOptions();
  const sizes = options?.garment_sizes ?? [...GARMENT_SIZES];
  const prints = detail.print_details ?? [];
  // Materials that get printed on (consumables such as ink are left out)
  const printable = useMemo(() => detail.items.filter((i) => !i.is_consumable), [detail.items]);
  const garments = printable.filter((i) => i.has_sizes);
  const [form, setForm] = useState<{ editing: PrintDetail | null; values: LineForm } | null>(null);
  const [removing, setRemoving] = useState<PrintDetail | null>(null);
  const [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const open = (editing: PrintDetail | null) => {
    const defaultMaterial = garments.length === 1 ? garments[0] : printable.length === 1 ? printable[0] : null;
    const material = editing ? printable.find((m) => m.line_item_id === editing.line_item_id) : defaultMaterial;
    setProblem('');
    setErrors({});
    setForm({
      editing,
      values: {
        line_item_id: editing?.line_item_id ?? defaultMaterial?.line_item_id ?? WHOLE_ORDER,
        print_type: editing?.print_type ?? (material?.has_sizes ? 'Jersey print' : 'Text print'),
        quantity: editing ? String(editing.quantity) : '1',
        size: editing?.size ?? '',
        custom_name: editing?.custom_name ?? '',
        custom_number: editing?.custom_number ?? '',
        notes: editing?.notes ?? '',
      },
    });
    onEditing?.(true);
  };
  const close = () => {
    setForm(null);
    onEditing?.(false);
  };
  const selected = form ? printable.find((m) => m.line_item_id === form.values.line_item_id) : undefined;
  const onGarment = Boolean(selected?.has_sizes);
  const set = (key: keyof LineForm, value: string) => setForm((f) => (f ? { ...f, values: { ...f.values, [key]: value } } : f));

  const save = async (e: React.FormEvent<HTMLFormElement>, again: boolean) => {
    e.preventDefault();
    if (!form) return;
    setProblem('');
    setErrors({});
    const v = form.values;
    const quantity = Number(v.quantity.trim());
    if (!v.quantity.trim() || Number.isNaN(quantity)) {
      setProblem('Enter how many pieces, as a number.');
      return;
    }
    const body = {
      line_item_id: v.line_item_id === WHOLE_ORDER ? null : v.line_item_id,
      print_type: v.print_type.trim(),
      quantity,
      size: onGarment ? v.size || null : null,
      custom_name: v.custom_name.trim() || null,
      custom_number: onGarment ? v.custom_number.trim() || null : null,
      notes: v.notes.trim() || null,
    };
    setBusy(true);
    const path = `/orders/${encodeURIComponent(detail.order.order_id)}/print-details`;
    const { ok, data } = form.editing
      ? await api<{ message?: string }>('PATCH', `${path}/${encodeURIComponent(form.editing.print_detail_id)}`, body)
      : await api<{ message?: string }>('POST', path, body);
    setBusy(false);
    if (!ok) {
      setErrors(fieldErrorsMap(data));
      setProblem(bannerText(data, Object.keys(body), 'The print detail was not saved.'));
      return;
    }
    if (again && !form.editing) {
      // Ready for the next piece: same material, type and size
      setForm({ editing: null, values: { ...v, custom_name: '', custom_number: '', notes: '' } });
      onResult({ type: 'success', title: 'Added', message: data.message ?? 'Print detail added.' }, true);
      return;
    }
    close();
    onResult({ type: 'success', title: form.editing ? 'Print detail updated' : 'Print detail added', message: data.message ?? 'Saved.' }, true);
  };

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    const { ok, data } = await api<{ message?: string }>(
      'DELETE',
      `/orders/${encodeURIComponent(detail.order.order_id)}/print-details/${encodeURIComponent(removing.print_detail_id)}`
    );
    setBusy(false);
    setRemoving(null);
    onResult(ok ? { type: 'success', title: 'Removed', message: data.message ?? 'Print detail removed.' }
      : { type: 'error', title: 'Not removed', message: bannerText(data, [], 'The print detail was not removed.') }, true);
  };

  return (
    <section className="space-y-3" aria-labelledby="prints-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="prints-title" className="flex items-center gap-2 font-semibold">
          {detail.has_garments ? <Shirt className="size-4 text-muted-foreground" aria-hidden /> : <Type className="size-4 text-muted-foreground" aria-hidden />}
          Print details <span className="font-normal text-muted-foreground">({prints.length})</span>
        </h3>
        {actions.add_print_details && !form && (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => open(null)} disabled={printable.length === 0}>
              <Plus aria-hidden /> {detail.has_garments ? 'Add size / name / number' : 'Add text to print'}
            </Button>
            {garments.length > 0 && (
              <Button variant="outline" size="sm" onClick={() => setImporting(true)}>
                <ListPlus aria-hidden /> Import roster (CSV / Excel)
              </Button>
            )}
          </div>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {detail.has_garments
          ? 'Sizes, names and numbers are for the garments. Other items get a text line. Print details never use stock.'
          : 'This order has no garments, so there are no sizes: write the text or name to print on each item.'}
      </p>

      {prints.length === 0 ? (
        <p className="text-sm text-muted-foreground">No print details yet.</p>
      ) : (
        <div className="max-w-full min-w-0 overflow-x-auto rounded-md border">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead>Print</TableHead>
                <TableHead className="hidden sm:table-cell">On</TableHead>
                <TableHead>Size</TableHead>
                <TableHead>Name / text</TableHead>
                <TableHead>No.</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                {actions.add_print_details && <TableHead><span className="sr-only">Actions</span></TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {prints.map((p) => (
                <TableRow key={p.print_detail_id}>
                  <TableCell className="max-w-40 whitespace-normal wrap-anywhere">
                    {p.print_type}
                    {p.sync_status !== 'synced' && <Badge variant="outline" className={cn('ml-1', TONE_CLASSES.info.badge)}>Pending sync</Badge>}
                    {p.notes && <span className="block text-xs text-muted-foreground">{p.notes}</span>}
                  </TableCell>
                  <TableCell className="hidden max-w-40 whitespace-normal wrap-anywhere sm:table-cell">{p.material_name ?? 'Whole order'}</TableCell>
                  <TableCell>{p.size ?? '—'}</TableCell>
                  <TableCell className="max-w-48 whitespace-normal wrap-anywhere">{p.custom_name ?? '—'}</TableCell>
                  <TableCell className="tabular-nums">{p.custom_number ?? '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">{p.quantity.toLocaleString()}</TableCell>
                  {actions.add_print_details && (
                    <TableCell className="text-right whitespace-nowrap">
                      <Button variant="ghost" size="icon-sm" onClick={() => open(p)} aria-label={`Edit ${p.print_type}`} title="Edit">
                        <Pencil aria-hidden />
                      </Button>
                      <Button variant="ghost" size="icon-sm" onClick={() => setRemoving(p)} aria-label={`Remove ${p.print_type}`} title="Remove">
                        <Trash2 aria-hidden />
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {form && (
        <form onSubmit={(e) => void save(e, false)} noValidate className="space-y-3 rounded-md border bg-muted/30 p-3">
          <FormProblem message={problem} />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-6">
            <Field id="pd-material" label="Printed on" error={errors.line_item_id} className="col-span-2 sm:col-span-3">
              <Select value={form.values.line_item_id} onValueChange={(v) => set('line_item_id', v)}>
                <SelectTrigger id="pd-material" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {printable.map((m) => (
                    <SelectItem key={m.line_item_id} value={m.line_item_id}>
                      {m.product_type} ({m.quantity.toLocaleString()} pcs){m.has_sizes ? ' · garment' : ''}
                    </SelectItem>
                  ))}
                  {printable.length > 1 && <SelectItem value={WHOLE_ORDER}>The whole order</SelectItem>}
                </SelectContent>
              </Select>
            </Field>
            <Field id="pd-type" label="What is printed *" error={errors.print_type} className="col-span-2 sm:col-span-2">
              <Input id="pd-type" maxLength={options?.print_limits.print_type ?? 60} value={form.values.print_type} onChange={(e) => set('print_type', e.target.value)} />
            </Field>
            <Field id="pd-qty" label="Qty *" error={errors.quantity}>
              <Input id="pd-qty" type="number" min={1} step={1} inputMode="numeric" value={form.values.quantity} onChange={(e) => set('quantity', e.target.value)} />
            </Field>
            {onGarment && (
              <>
                <Field id="pd-size" label="Size" error={errors.size} className="col-span-1 sm:col-span-2">
                  <Select value={form.values.size || NO_SIZE} onValueChange={(v) => set('size', v === NO_SIZE ? '' : v)}>
                    <SelectTrigger id="pd-size" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="max-h-72">
                      <SelectItem value={NO_SIZE}>No size</SelectItem>
                      {/* A line saved with a size no longer offered (e.g. "Kids 10") keeps showing it */}
                      {(form.values.size && !sizes.includes(form.values.size) ? [form.values.size, ...sizes] : sizes).map((s) => (
                        <SelectItem key={s} value={s}>
                          {s}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field id="pd-number" label="No." error={errors.custom_number}>
                  <Input id="pd-number" inputMode="numeric" maxLength={options?.print_limits.number_digits ?? 3} placeholder="7" value={form.values.custom_number} onChange={(e) => set('custom_number', e.target.value)} />
                </Field>
              </>
            )}
            <Field
              id="pd-name"
              label={onGarment ? 'Name' : 'Text / name to print'}
              error={errors.custom_name}
              className={cn('col-span-2', onGarment ? 'sm:col-span-3' : 'sm:col-span-6')}
            >
              <Input id="pd-name" maxLength={options?.print_limits.name ?? 50} placeholder={onGarment ? 'DELA CRUZ' : 'e.g. Happy 50th, Lola!'} value={form.values.custom_name} onChange={(e) => set('custom_name', e.target.value)} />
            </Field>
            <Field id="pd-notes" label="Notes" error={errors.notes} className="col-span-2 sm:col-span-6">
              <Input id="pd-notes" maxLength={options?.print_limits.notes ?? 500} placeholder="e.g. font, colour, placement" value={form.values.notes} onChange={(e) => set('notes', e.target.value)} />
            </Field>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={close} disabled={busy}>
              {form.editing ? 'Cancel' : 'Done'}
            </Button>
            {!form.editing && (
              <Button type="button" variant="outline" size="sm" busy={busy} disabled={busy} onClick={(e) => void save(e as unknown as React.FormEvent<HTMLFormElement>, true)}>
                Add and next
              </Button>
            )}
            <Button type="submit" size="sm" busy={busy} disabled={busy}>
              {busy ? 'Saving…' : form.editing ? 'Save' : 'Add'}
            </Button>
          </div>
        </form>
      )}

      {importing && (
        <RosterImportDialog
          orderId={detail.order.order_id}
          garments={garments}
          onClose={() => setImporting(false)}
          onDone={(r) => {
            setImporting(false);
            onResult(r, true);
          }}
        />
      )}
      <ConfirmDialog
        open={Boolean(removing)}
        title="Remove this print detail?"
        message={removing ? `${removing.quantity} × ${removing.print_type}${removing.custom_name ? ` (${removing.custom_name})` : ''} will be removed from the order.` : ''}
        confirmLabel="Remove"
        danger
        busy={busy}
        onConfirm={() => void remove()}
        onCancel={() => setRemoving(null)}
      />
    </section>
  );
}
