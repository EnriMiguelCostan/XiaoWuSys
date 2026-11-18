'use client';

// Adjust stock (the MVP's "Add / Subtract Stock" tab):
//   add                    POST /api/inventory/:id/adjust { action: 'add' }       stock received
//   subtract, taken/used   POST /api/inventory/:id/adjust { action: 'subtract' }
//   subtract, lost         POST /api/inventory/:id/loss   (records the material loss and its cost)
// "Not enough stock" is decided by the server (409 INSUFFICIENT_STOCK) and shown in the form.
// PB 18: a loss needs one of the server's standard reasons (LOSS_REASONS); the server diagnoses
// the cause and may warn that no free stock is left (replacement_warning). Both are shown as sent.
import { useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { bannerText, Field, fieldErrorsMap, FormProblem, RequiredNote } from '@/components/forms/form-bits';
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
import { BoundedSelectContent, BoundedSelectItem, BoundedSelectTrigger } from '@/components/forms/bounded-select';
import { useApi } from '@/hooks/use-api';
import { offlineNote, toNumberInput, type InventoryItem } from '@/lib/inventory';
import { LOSS_REASONS, type LossResponse } from '@/lib/orders';
import { TONE_CLASSES } from '@/lib/ui-tokens';
import { cn } from '@/lib/utils';
import { TEXT_MAX, WHOLE_NUMBER_MAX } from '@/lib/input-limits';

export type StockAction = 'add' | 'subtract';
type SubtractReason = 'taken' | 'lost';

const REASONS: Record<SubtractReason, string> = {
  taken: 'Taken / used',
  lost: 'Lost / damaged (records material loss)',
};

interface StockResponse extends Omit<LossResponse, 'item'> {
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
  const [reasonCode, setReasonCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  // Nielsen H9: the server's VALIDATION_FAILED details, shown next to their fields
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const item = items.find((i) => i.inventory_id === itemId) ?? null;
  const recordsLoss = action === 'subtract' && reason === 'lost';

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setProblem('');
    setFieldErrors({});
    if (!item) {
      setProblem('Choose the item whose stock you want to change.');
      return;
    }
    const qty = toNumberInput(quantity);
    if (qty === undefined || Number.isNaN(qty)) {
      setProblem('Enter how many, as a number.');
      return;
    }
    if (recordsLoss && !reasonCode) {
      setProblem('Choose what happened to the lost or damaged stock.');
      return;
    }

    setBusy(true);
    const id = encodeURIComponent(item.inventory_id);
    const { ok, data } = recordsLoss
      ? await api<StockResponse>('POST', `/inventory/${id}/loss`, {
          quantity_lost: qty,
          reason_code: reasonCode,
          loss_reason: note.trim() || undefined,
        })
      : await api<StockResponse>('POST', `/inventory/${id}/adjust`, {
          action,
          quantity: qty,
          reason: action === 'add' ? 'Stock received' : 'Taken / used (manual adjustment)',
        });
    setBusy(false);

    if (!ok) {
      setFieldErrors(fieldErrorsMap(data));
      setProblem(bannerText(data, ['quantity', 'quantity_lost', 'reason_code', 'loss_reason'], 'Could not update the stock.'));
      return;
    }
    const now = data.item?.quantity_available;
    const cause = recordsLoss && data.loss ? `\nCause: ${data.loss.category_label}. ${data.diagnosis?.note ?? ''}` : '';
    onDone({
      type: data.replacement_warning ? 'warning' : 'success',
      title: action === 'add' ? 'Stock added' : recordsLoss ? 'Loss recorded' : 'Stock subtracted',
      message:
        `${action === 'add' ? 'Added' : 'Subtracted'} ${qty} ${action === 'add' ? 'to' : 'from'} "${item.item_name}".` +
        (now !== undefined ? ` Now ${now.toLocaleString()} in stock.` : '') +
        (recordsLoss ? '\nThe loss and its cost were recorded.' : '') +
        cause +
        (data.replacement_warning ? `\n${data.replacement_warning.message}` : '') +
        offlineNote(data),
    });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="min-w-0 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Adjust stock</DialogTitle>
          <DialogDescription>Every stock change is recorded with who made it and why.</DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="max-w-full min-w-0 space-y-4">
          <FormProblem message={problem} />
          <RequiredNote />

          <Field id="stock-item" label="Item *">
            <Select value={itemId} onValueChange={setItemId}>
              <BoundedSelectTrigger id="stock-item">
                <SelectValue placeholder="Select an item…" />
              </BoundedSelectTrigger>
              <BoundedSelectContent>
                {items.map((i) => (
                  <BoundedSelectItem
                    key={i.inventory_id}
                    value={i.inventory_id}
                    label={i.item_name}
                    suffix={`(${i.quantity_available.toLocaleString()} in stock)`}
                  >
                    {i.item_name}
                  </BoundedSelectItem>
                ))}
              </BoundedSelectContent>
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
            <Field id="stock-quantity" label="Quantity *" error={fieldErrors.quantity || fieldErrors.quantity_lost}>
              <Input
                id="stock-quantity"
                type="number"
                min={1}
                max={WHOLE_NUMBER_MAX}
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
            <>
              <Field id="stock-loss-code" label="What happened? *" error={fieldErrors.reason_code}>
                <Select value={reasonCode} onValueChange={setReasonCode}>
                  <BoundedSelectTrigger id="stock-loss-code">
                    <SelectValue placeholder="Choose a reason…" />
                  </BoundedSelectTrigger>
                  <BoundedSelectContent>
                    {LOSS_REASONS.map((r) => (
                      <BoundedSelectItem key={r.code} value={r.code} label={r.label}>
                        {r.label}
                      </BoundedSelectItem>
                    ))}
                  </BoundedSelectContent>
                </Select>
              </Field>
              <Field id="stock-note" label="Notes (optional)" error={fieldErrors.loss_reason}>
                <Input id="stock-note" maxLength={TEXT_MAX.note} placeholder="e.g. found during the stock count" value={note} onChange={(e) => setNote(e.target.value)} />
              </Field>
            </>
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
            <Button busy={busy} type="submit" variant={action === 'subtract' ? 'destructive' : 'default'} disabled={busy || items.length === 0}>
              {action === 'add' ? <Plus aria-hidden /> : <Minus aria-hidden />}
              {busy ? 'Saving…' : action === 'add' ? 'Add to stock' : recordsLoss ? 'Record loss' : 'Subtract from stock'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
