'use client';

// Add a new catalog item (POST /api/inventory) or edit an item's details
// (PATCH /api/inventory/:id). Ported from InventoryCatalog.jsx.
//
// Rule split (steering §3.1): this form only checks that numbers are numbers. Duplicate names
// (case/space-insensitive), whole-number and 2-decimal limits and the edit-conflict check are
// the server's; its 400/409 message is shown in the form. Quantities are never edited here:
// stock changes go through Adjust stock so every movement is recorded.
import { useState } from 'react';
import { Pencil, Plus } from 'lucide-react';
import { Field, FormProblem, Suggestions } from '@/components/catalog/form-bits';
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
import { useApi } from '@/hooks/use-api';
import { errorMessage } from '@/lib/api';
import { COMMON_UNITS, offlineNote, toNumberInput, type InventoryItem } from '@/lib/inventory';

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
  onClose,
  onDone,
}: {
  item: InventoryItem | null;
  categories: string[];
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
    quantity_available: '',
    minimum_threshold: item ? String(item.minimum_threshold) : '',
    unit_cost: item ? String(item.unit_cost) : '',
  });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ message: string; tone: 'danger' | 'warning' } | null>(null);

  const bind = (key: keyof typeof form) => ({
    value: form[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [key]: e.target.value })),
  });

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setProblem(null);

    const name = form.item_name.trim();
    const category = form.item_category.trim();
    const unit = form.unit.trim() || 'pcs';
    const supplier = form.supplier.trim();
    const quantity = toNumberInput(form.quantity_available);
    const threshold = toNumberInput(form.minimum_threshold);
    const cost = toNumberInput(form.unit_cost);
    if ([quantity, threshold, cost].some((n) => Number.isNaN(n))) {
      setProblem({ tone: 'danger', message: 'Quantity, low-stock alert and unit cost must be numbers.' });
      return;
    }

    let body: Record<string, unknown>;
    if (!editing) {
      body = {
        item_name: name,
        item_category: category,
        unit,
        supplier: supplier || undefined,
        quantity_available: quantity,
        minimum_threshold: threshold,
        unit_cost: cost,
      };
    } else {
      // Send only what changed (as the MVP did), plus the version this form was opened with
      body = {};
      if (name !== item.item_name) body.item_name = name;
      if (category !== item.item_category) body.item_category = category;
      if (unit !== (item.unit || 'pcs')) body.unit = unit;
      if (supplier !== (item.supplier ?? '')) body.supplier = supplier || null;
      if (form.minimum_threshold.trim() !== String(item.minimum_threshold)) body.minimum_threshold = threshold;
      if (form.unit_cost.trim() !== String(item.unit_cost)) body.unit_cost = cost;
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
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {editing ? <Pencil className="size-5" aria-hidden /> : <Plus className="size-5" aria-hidden />}
            {editing ? 'Edit item' : 'Add new item'}
          </DialogTitle>
          <DialogDescription>
            {editing
              ? 'Change the details of this item. Stock quantities are changed with Adjust stock.'
              : 'Add a material to the catalog. Fields marked * are required.'}
          </DialogDescription>
        </DialogHeader>

        <Suggestions id="catalog-category-options" values={categories} />
        <Suggestions id="catalog-unit-options" values={COMMON_UNITS} />

        <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
          {problem && (
            <div className="sm:col-span-2">
              <FormProblem message={problem.message} tone={problem.tone} />
            </div>
          )}
          <Field id="item-name" label="Item name *" className="sm:col-span-2">
            <Input id="item-name" required maxLength={255} placeholder="e.g. Valiant Columnar Notebook" autoFocus {...bind('item_name')} />
          </Field>
          <Field id="item-category" label="Category *">
            <Input id="item-category" required maxLength={100} list="catalog-category-options" placeholder="e.g. Notebooks" {...bind('item_category')} />
          </Field>
          <Field id="item-unit" label="Unit (what 1 means)">
            <Input id="item-unit" maxLength={30} list="catalog-unit-options" placeholder="pcs, pack, ream…" {...bind('unit')} />
          </Field>
          <Field id="item-supplier" label="Supplier (optional)" className="sm:col-span-2">
            <Input id="item-supplier" maxLength={255} placeholder="e.g. Quaff PH" {...bind('supplier')} />
          </Field>
          {!editing && (
            <Field id="item-quantity" label="Quantity in stock">
              <Input id="item-quantity" type="number" min={0} step={1} inputMode="numeric" placeholder="0" {...bind('quantity_available')} />
            </Field>
          )}
          <Field id="item-threshold" label="Low-stock alert at">
            <Input id="item-threshold" type="number" min={0} step={1} inputMode="numeric" placeholder="0" required={editing} {...bind('minimum_threshold')} />
          </Field>
          <Field id="item-cost" label="Unit cost (₱)">
            <Input id="item-cost" type="number" min={0} step="0.01" inputMode="decimal" placeholder="0.00" {...bind('unit_cost')} />
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
            <Button type="submit" disabled={busy}>
              {busy ? 'Saving…' : editing ? 'Save changes' : 'Add item'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
