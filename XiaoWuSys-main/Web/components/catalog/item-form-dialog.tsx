'use client';

// Add a new catalog item (POST /api/inventory) or edit an item's details
// (PATCH /api/inventory/:id). Ported from InventoryCatalog.jsx.
//
// Rule split (steering §3.1): this form only checks that numbers are numbers. Duplicate names
// (case/space-insensitive), whole-number and 2-decimal limits and the edit-conflict check are
// the server's; its 400/409 message is shown in the form. Quantities are never edited here:
// stock changes go through Stock in / Stock out / Stock count so every movement has a record.
// Migration 015: the usual supplier is chosen from the supplier profiles, and "Garment" marks
// items whose print details have sizes (shirts, jerseys) and that go through the Pressing step.
import { useEffect, useMemo, useState } from 'react';
import { Pencil, Plus } from 'lucide-react';
import { CreatableCombobox } from '@/components/forms/creatable-combobox';
import { Field, FormProblem, RequiredNote, fieldError } from '@/components/forms/form-bits';
import type { ResultMessage } from '@/components/feedback/result-dialog';
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
import { Select, SelectValue } from '@/components/ui/select';
import { BoundedSelectContent, BoundedSelectItem, BoundedSelectTrigger } from '@/components/forms/bounded-select';
import { useApi } from '@/hooks/use-api';
import type { Supplier } from '@/lib/stock';
import { errorMessage } from '@/lib/api';
import { COMMON_UNITS, offlineNote, toNumberInput, type InventoryItem } from '@/lib/inventory';
import { MONEY_INPUT_MAX, TEXT_MAX, WHOLE_NUMBER_MAX } from '@/lib/input-limits';

interface ItemResponse {
  message?: string;
  source?: string;
  error?: string;
  item?: InventoryItem;
}

/** item = null: add a new item; otherwise edit that item */
export function ItemFormDialog({
  item,
  categories,
  units,
  onClose,
  onDone,
}: {
  item: InventoryItem | null;
  categories: string[];
  /** Units already used in the catalog (may repeat or be empty) */
  units: readonly (string | null)[];
  onClose: () => void;
  onDone: (result: ResultMessage) => void;
}) {
  const api = useApi();
  const editing = item !== null;
  const [form, setForm] = useState({
    item_name: item?.item_name ?? '',
    item_category: item?.item_category ?? '',
    unit: item?.unit || 'pcs',
    supplier: item?.supplier ?? '',
    supplier_id: item?.supplier_id ?? '',
    has_sizes: Boolean(item?.has_sizes),
    requires_pressing: Boolean(item?.requires_pressing),
    print_per_area: item?.print_pricing === 'per_area',
    quantity_available: '',
    minimum_threshold: item ? String(item.minimum_threshold) : '',
    unit_cost: item ? String(item.unit_cost) : '',
    selling_price: item ? String(item.selling_price ?? 0) : '',
  });
  // Units the catalog already uses first, so their spelling wins over a suggestion's
  const unitOptions = useMemo(() => [...units, ...COMMON_UNITS], [units]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  useEffect(() => {
    api<{ suppliers: Supplier[] }>('GET', '/suppliers').then(({ ok, data }) => ok && setSuppliers(data.suppliers));
  }, [api]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ message: string; tone: 'danger' | 'warning' } | null>(null);
  // The server's last 400 answer: its details[] put each message next to the field it names
  const [failed, setFailed] = useState<unknown>(null);
  const errorFor = (field: string) => fieldError(failed, field);
  // Set when the browser's form check finds Category empty (the picker is a button, not an input)
  const [categoryMissing, setCategoryMissing] = useState(false);
  const categoryError =
    errorFor('item_category') || (categoryMissing && !form.item_category ? 'Choose a category, or type a new one and pick Create.' : '');

  const bind = (key: 'item_name' | 'supplier' | 'quantity_available' | 'minimum_threshold' | 'unit_cost' | 'selling_price') => ({
    value: form[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [key]: e.target.value })),
  });

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setProblem(null);
    setFailed(null);

    const name = form.item_name.trim();
    const category = form.item_category.trim();
    const unit = form.unit.trim() || 'pcs';
    const supplier = form.supplier.trim();
    const quantity = toNumberInput(form.quantity_available);
    const threshold = toNumberInput(form.minimum_threshold);
    const cost = toNumberInput(form.unit_cost);
    const price = toNumberInput(form.selling_price);
    if ([quantity, threshold, cost, price].some((n) => Number.isNaN(n))) {
      setProblem({ tone: 'danger', message: 'Quantity, low-stock alert, unit cost and selling price must be numbers.' });
      return;
    }

    let body: Record<string, unknown>;
    if (!editing) {
      body = {
        item_name: name,
        item_category: category,
        unit,
        supplier: form.supplier_id ? undefined : supplier || undefined,
        supplier_id: form.supplier_id || undefined,
        has_sizes: form.has_sizes,
        requires_pressing: form.requires_pressing,
        print_pricing: form.print_per_area ? 'per_area' : 'included',
        quantity_available: quantity,
        minimum_threshold: threshold,
        unit_cost: cost,
        selling_price: price,
      };
    } else {
      // Send only what changed (as the MVP did), plus the version this form was opened with
      body = {};
      if (name !== item.item_name) body.item_name = name;
      if (category !== item.item_category) body.item_category = category;
      if (unit !== (item.unit || 'pcs')) body.unit = unit;
      if (form.supplier_id !== (item.supplier_id ?? '')) body.supplier_id = form.supplier_id || null;
      else if (!form.supplier_id && supplier !== (item.supplier ?? '')) body.supplier = supplier || null;
      if (form.has_sizes !== Boolean(item.has_sizes)) body.has_sizes = form.has_sizes;
      if (form.requires_pressing !== Boolean(item.requires_pressing)) body.requires_pressing = form.requires_pressing;
      if (form.print_per_area !== (item.print_pricing === 'per_area')) body.print_pricing = form.print_per_area ? 'per_area' : 'included';
      if (form.minimum_threshold.trim() !== String(item.minimum_threshold)) body.minimum_threshold = threshold;
      if (form.unit_cost.trim() !== String(item.unit_cost)) body.unit_cost = cost;
      if (form.selling_price.trim() !== String(item.selling_price ?? 0)) body.selling_price = price;
      if (Object.keys(body).length === 0) {
        onDone({ type: 'warning', title: 'No changes', message: 'Nothing was changed, so nothing was saved.' });
        return;
      }
      if (item.version) body.expected_version = item.version;
    }

    setBusy(true);
    const { ok, status, data } = editing
      ? await api<ItemResponse>('PATCH', `/inventory/${encodeURIComponent(item.inventory_id)}`, body)
      : await api<ItemResponse>('POST', '/inventory', body);
    setBusy(false);

    if (!ok) {
      setFailed(data);
      setProblem({
        tone: status === 409 ? 'warning' : 'danger',
        message: errorMessage(data, editing ? 'Could not save the changes.' : 'Could not add the item.'),
      });
      return;
    }

    if (editing) {
      onDone({ type: 'success', title: 'Item updated', message: `${data.message ?? 'The item was updated.'}${offlineNote(data)}` });
    } else {
      const saved = data.item;
      onDone({
        type: 'success',
        title: 'Item added',
        message:
          `"${saved?.item_name ?? name}" was added with ${saved?.quantity_available ?? quantity ?? 0} ${saved?.unit ?? unit} in stock.` +
          offlineNote(data),
      });
    }
  };

  return (
    <Dialog page open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {editing ? <Pencil className="size-5" aria-hidden /> : <Plus className="size-5" aria-hidden />}
            {editing ? 'Edit item' : 'Add new item'}
          </DialogTitle>
          <DialogDescription>
            {editing
              ? 'Change the details of this item. Quantities change only through Stock in, Stock out, a count or a recorded loss.'
              : 'Add a material to the catalog.'}
          </DialogDescription>
        </DialogHeader>


        <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
          <RequiredNote className="sm:col-span-2" />
          {problem && (
            <div className="sm:col-span-2">
              <FormProblem message={problem.message} tone={problem.tone} />
            </div>
          )}
          <Field id="item-name" error={errorFor('item_name')} label="Item name *" className="sm:col-span-2">
            <Input id="item-name" required maxLength={TEXT_MAX.default} placeholder="e.g. Valiant Columnar Notebook" autoFocus {...bind('item_name')} />
          </Field>
          <Field id="item-category" error={categoryError} label="Category *">
            <CreatableCombobox
              id="item-category"
              noun="category"
              required
              maxLength={TEXT_MAX.category}
              value={form.item_category}
              options={categories}
              onChange={(value) => setForm((f) => ({ ...f, item_category: value }))}
              onMissing={() => setCategoryMissing(true)}
            />
          </Field>
          <Field id="item-unit" error={errorFor('unit')} label="Unit (what 1 means)">
            <CreatableCombobox
              id="item-unit"
              noun="unit"
              maxLength={TEXT_MAX.unit}
              value={form.unit}
              options={unitOptions}
              onChange={(value) => setForm((f) => ({ ...f, unit: value }))}
            />
          </Field>
          <Field id="item-supplier" error={errorFor('supplier_id') || errorFor('supplier')} label="Usual supplier" className="sm:col-span-2"
            hint={suppliers.length === 0 ? 'Add suppliers on the Suppliers page to choose one here.' : 'Set automatically on the first stock in if left empty.'}>
            <Select value={form.supplier_id || '__none__'} onValueChange={(v) => setForm((f) => ({ ...f, supplier_id: v === '__none__' ? '' : v }))}>
              <BoundedSelectTrigger id="item-supplier">
                <SelectValue placeholder="No supplier yet" />
              </BoundedSelectTrigger>
              <BoundedSelectContent>
                <BoundedSelectItem value="__none__" label="No supplier yet">{item?.supplier && !item.supplier_id ? `Keep "${item.supplier}"` : 'No supplier yet'}</BoundedSelectItem>
                {suppliers.map((s) => (
                  <BoundedSelectItem key={s.supplier_id} value={s.supplier_id} label={s.supplier_name}>
                    {s.supplier_name}
                  </BoundedSelectItem>
                ))}
              </BoundedSelectContent>
            </Select>
          </Field>
          <label className="flex min-h-10 items-start gap-2 text-sm sm:col-span-2">
            <input type="checkbox" className="mt-0.5 size-4" checked={form.has_sizes} onChange={(e) => setForm((f) => ({ ...f, has_sizes: e.target.checked }))} />
            <span>
              <span className="font-medium">Garment (has sizes)</span>
              <span className="block text-xs text-muted-foreground">Shirts, jerseys, polos… Their print details get a size, name and number.</span>
            </span>
          </label>
          {/* Migration 016 (adviser consultation): only T-shirts go through the heat press */}
          <label className="flex min-h-10 items-start gap-2 text-sm sm:col-span-2">
            <input
              type="checkbox"
              className="mt-0.5 size-4"
              checked={form.requires_pressing}
              onChange={(e) => setForm((f) => ({ ...f, requires_pressing: e.target.checked }))}
            />
            <span>
              <span className="font-medium">T-shirt (heat-pressed)</span>
              <span className="block text-xs text-muted-foreground">Orders with this item get the Pressing step. Jerseys, mugs, tarpaulins… skip it.</span>
            </span>
          </label>
          {/* Migration 017: a blank priced per print area (front A4, back A3...) or a finished piece */}
          <label className="flex min-h-10 items-start gap-2 text-sm sm:col-span-2">
            <input
              type="checkbox"
              className="mt-0.5 size-4"
              checked={form.print_per_area}
              onChange={(e) => setForm((f) => ({ ...f, print_per_area: e.target.checked }))}
            />
            <span>
              <span className="font-medium">Priced per print area (a blank)</span>
              <span className="block text-xs text-muted-foreground">
                The selling price is the plain blank; each print on the order (front A4, back A3, logo, names) adds its charge. Leave it off for
                items sold finished (sublimation jerseys, mugs, tarpaulin, stickers).
              </span>
            </span>
          </label>
          {!editing && (
            <Field id="item-quantity" error={errorFor('quantity_available')} label="Opening stock" hint="What is on the shelf now. Later deliveries go through Stock in.">
              <Input id="item-quantity" type="number" min={0} max={WHOLE_NUMBER_MAX} step={1} inputMode="numeric" placeholder="0" {...bind('quantity_available')} />
            </Field>
          )}
          <Field id="item-threshold" error={errorFor('minimum_threshold')} label="Low-stock alert at">
            <Input id="item-threshold" type="number" min={0} max={WHOLE_NUMBER_MAX} step={1} inputMode="numeric" placeholder="0" required={editing} {...bind('minimum_threshold')} />
          </Field>
          <Field id="item-cost" error={errorFor('unit_cost')} label="Unit cost (₱)">
            <Input id="item-cost" type="number" min={0} max={MONEY_INPUT_MAX} step="any" inputMode="decimal" placeholder="0.00" {...bind('unit_cost')} />
          </Field>
          <Field id="item-price" error={errorFor('selling_price')} label={form.print_per_area ? 'Blank price per piece (₱)' : 'Selling price per piece (₱)'} hint={form.print_per_area ? 'The plain blank, before printing. Print areas are added on the order.' : 'The finished piece, before bulk discounts. Used to calculate quotes.'}>
            <Input id="item-price" type="number" min={0} max={MONEY_INPUT_MAX} step="any" inputMode="decimal" placeholder="0.00" {...bind('selling_price')} />
          </Field>
          {editing && (
            <p className="text-sm text-muted-foreground sm:col-span-2">
              Stock on hand: <strong className="text-foreground">{item.quantity_available.toLocaleString()}</strong>{' '}
              {item.unit || 'pcs'}.
            </p>
          )}
          <DialogFooter className="sm:col-span-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button busy={busy} type="submit" disabled={busy}>
              {busy ? 'Saving…' : editing ? 'Save changes' : 'Add Item'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
