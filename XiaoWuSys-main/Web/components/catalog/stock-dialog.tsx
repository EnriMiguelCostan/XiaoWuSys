'use client';

// Adjust stock (the MVP's "Add / Subtract Stock" tab):
//   add                    POST /api/inventory/:id/adjust { action: 'add' }       stock received
//   subtract, taken/used   POST /api/inventory/:id/adjust { action: 'subtract' }
//   subtract, lost         POST /api/inventory/:id/loss   (records the material loss and its cost)
// "Not enough stock" is decided by the server (409 INSUFFICIENT_STOCK) and shown in the form.
import { useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { Field, FormProblem } from '@/components/catalog/form-bits';
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
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useApi } from '@/hooks/use-api';
import { errorMessage } from '@/lib/api';
import { offlineNote, toNumberInput, type InventoryItem } from '@/lib/inventory';
import { POPOVER_MAX_WIDTH, TONE_CLASSES } from '@/lib/ui-tokens';
import { cn } from '@/lib/utils';

export type StockAction = 'add' | 'subtract';
type SubtractReason = 'taken' | 'lost';

const REASONS: Record<SubtractReason, string> = {
  taken: 'Taken / used',
  lost: 'Lost / damaged (records material loss)',
};

interface StockResponse {
  message?: string;
  source?: string;
  item?: InventoryItem;
}

export function StockDialog({
  items,
  initialItemId,
  initialAction,
  onClose,
  onDone,
}: {
  items: InventoryItem[];
  initialItemId: string | null;
  initialAction: StockAction;
  onClose: () => void;
  onDone: (result: ResultMessage) => void;
}) {
  const api = useApi();
  const [itemId, setItemId] = useState(initialItemId ?? '');
  const [action, setAction] = useState<StockAction>(initialAction);
  const [reason, setReason] = useState<SubtractReason>('taken');
  const [quantity, setQuantity] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');

  const item = items.find((i) => i.inventory_id === itemId) ?? null;
  const recordsLoss = action === 'subtract' && reason === 'lost';

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setProblem('');
    if (!item) {
      setProblem('Choose the item whose stock you want to change.');
      return;
    }
    const qty = toNumberInput(quantity);
    if (qty === undefined || Number.isNaN(qty)) {
      setProblem('Enter how many, as a number.');
      return;
    }

    setBusy(true);
    const id = encodeURIComponent(item.inventory_id);
    const { ok, data } = recordsLoss
      ? await api<StockResponse>('POST', `/inventory/${id}/loss`, {
          quantity_lost: qty,
          loss_reason: note.trim() ? `Lost / damaged: ${note.trim()}` : 'Lost / damaged (manual stock count)',
        })
      : await api<StockResponse>('POST', `/inventory/${id}/adjust`, {
          action,
          quantity: qty,
          reason: action === 'add' ? 'Stock received' : 'Taken / used (manual adjustment)',
        });
    setBusy(false);

    if (!ok) {
      setProblem(errorMessage(data, 'Could not update the stock.'));
      return;
    }
    const now = data.item?.quantity_available;
    onDone({
      type: 'success',
      title: action === 'add' ? 'Stock added' : recordsLoss ? 'Loss recorded' : 'Stock subtracted',
      message:
        `${action === 'add' ? 'Added' : 'Subtracted'} ${qty} ${action === 'add' ? 'to' : 'from'} "${item.item_name}".` +
        (now !== undefined ? ` Now ${now.toLocaleString()} in stock.` : '') +
        (recordsLoss ? '\nThe loss and its cost were recorded.' : '') +
        offlineNote(data),
    });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Adjust stock</DialogTitle>
          <DialogDescription>Every stock change is recorded with who made it and why.</DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4">
          <FormProblem message={problem} />

          <Field id="stock-item" label="Item *">
            <Select value={itemId} onValueChange={setItemId}>
              <SelectTrigger id="stock-item" className="w-full">
                <SelectValue placeholder="Select an item…" />
              </SelectTrigger>
              <SelectContent className={POPOVER_MAX_WIDTH}>
                {items.map((i) => (
                  <SelectItem key={i.inventory_id} value={i.inventory_id} className="wrap-anywhere whitespace-normal">
                    {i.item_name} ({i.quantity_available.toLocaleString()} in stock)
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <div className="space-y-1.5">
            <Label>Action</Label>
            <ToggleGroup
              type="single"
              variant="outline"
              value={action}
              onValueChange={(v) => v && setAction(v as StockAction)}
              className="w-full"
            >
              <ToggleGroupItem value="add" className="flex-1 data-[state=on]:border-success/40 data-[state=on]:bg-success/10 data-[state=on]:text-success">
                <Plus aria-hidden /> Add stock
              </ToggleGroupItem>
              <ToggleGroupItem value="subtract" className="flex-1 data-[state=on]:border-danger/40 data-[state=on]:bg-danger/10 data-[state=on]:text-danger">
                <Minus aria-hidden /> Subtract stock
              </ToggleGroupItem>
            </ToggleGroup>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="stock-quantity" label="Quantity *">
              <Input
                id="stock-quantity"
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                placeholder="1"
                required
                autoFocus={Boolean(initialItemId)}
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
              />
            </Field>
            {action === 'subtract' && (
              <Field id="stock-reason" label="Reason">
                <Select value={reason} onValueChange={(v) => setReason(v as SubtractReason)}>
                  <SelectTrigger id="stock-reason" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(REASONS) as SubtractReason[]).map((key) => (
                      <SelectItem key={key} value={key}>
                        {REASONS[key]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}
          </div>

          {recordsLoss && (
            <Field id="stock-note" label="What happened? (optional)">
              <Input id="stock-note" maxLength={200} placeholder="e.g. misprint, water damage" value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
          )}

          {item && (
            <p className={cn('rounded-md border p-3 text-sm', TONE_CLASSES.muted.banner)}>
              Currently <strong className="text-foreground">{item.quantity_available.toLocaleString()}</strong> {item.unit || 'pcs'} on hand
              {Boolean(item.quantity_reserved) && ` (${item.quantity_reserved.toLocaleString()} held for orders)`}. Low-stock alert at{' '}
              {item.minimum_threshold.toLocaleString()}.
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" variant={action === 'subtract' ? 'destructive' : 'default'} disabled={busy || items.length === 0}>
              {action === 'add' ? <Plus aria-hidden /> : <Minus aria-hidden />}
              {busy ? 'Saving…' : action === 'add' ? 'Add to stock' : recordsLoss ? 'Record loss' : 'Subtract from stock'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
