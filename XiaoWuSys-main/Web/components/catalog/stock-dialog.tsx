'use client';

// Adjust Stock (the MVP's "Add / Subtract Stock" tab), one dialog for both directions:
//   Add Stock, any reason            POST /api/inventory/:id/adjust { action: 'add', reason }
//   Subtract Stock, other adjustment POST /api/inventory/:id/adjust { action: 'subtract', reason }
//                                    (count corrections etc. are not production waste)
//   Subtract Stock, material loss    POST /api/inventory/:id/loss { reason_code, loss_reason? }
//                                    (records the loss and its cost: waste report, P&L, warnings)
// Reason labels are shared: ADD_STOCK_REASONS / SUBTRACT_STOCK_REASONS (lib/inventory.ts) and
// LOSS_REASONS (lib/orders.ts, also used by Order details > Log Loss).
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
import { Select, SelectGroup, SelectLabel, SelectSeparator, SelectValue } from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { BoundedSelectContent, BoundedSelectItem, BoundedSelectTrigger } from '@/components/forms/bounded-select';
import { useApi } from '@/hooks/use-api';
import { ADD_STOCK_REASONS, SUBTRACT_STOCK_REASONS, offlineNote, toNumberInput, type InventoryItem } from '@/lib/inventory';
import { LOSS_REASONS, type LossResponse } from '@/lib/orders';
import { TONE_CLASSES } from '@/lib/ui-tokens';
import { cn } from '@/lib/utils';
import { TEXT_MAX, WHOLE_NUMBER_MAX } from '@/lib/input-limits';

export type StockAction = 'add' | 'subtract';

// Select values for the Reason list: "loss:<reason_code>" (material loss) or "adjust:<label>"
const LOSS_PREFIX = 'loss:';
const ADJUST_PREFIX = 'adjust:';
const DEFAULT_REASON: Record<StockAction, string> = { add: `${ADJUST_PREFIX}${ADD_STOCK_REASONS[0]}`, subtract: '' };

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
  const [reason, setReason] = useState(DEFAULT_REASON[initialAction]);
  const [quantity, setQuantity] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  // Nielsen H9: the server's VALIDATION_FAILED details, shown next to their fields
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const item = items.find((i) => i.inventory_id === itemId) ?? null;
  const recordsLoss = action === 'subtract' && reason.startsWith(LOSS_PREFIX);
  const reasonCode = recordsLoss ? reason.slice(LOSS_PREFIX.length) : '';
  const adjustLabel = reason.startsWith(ADJUST_PREFIX) ? reason.slice(ADJUST_PREFIX.length) : '';

  const switchAction = (next: StockAction) => {
    setAction(next);
    setReason(DEFAULT_REASON[next]); // the two directions have different reasons
    setFieldErrors({});
  };

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
    if (!reason) {
      setProblem('Choose a reason for the stock change.');
      return;
    }
    const typedNote = note.trim();

    setBusy(true);
    const id = encodeURIComponent(item.inventory_id);
    const { ok, data } = recordsLoss
      ? await api<StockResponse>('POST', `/inventory/${id}/loss`, {
          quantity_lost: qty,
          reason_code: reasonCode,
          loss_reason: typedNote || undefined,
        })
      : await api<StockResponse>('POST', `/inventory/${id}/adjust`, {
          action,
          quantity: qty,
          reason: typedNote ? `${adjustLabel}: ${typedNote}` : adjustLabel,
        });
    setBusy(false);

    if (!ok) {
      setFieldErrors(fieldErrorsMap(data));
      setProblem(bannerText(data, ['quantity', 'quantity_lost', 'reason_code', 'loss_reason', 'reason'], 'Could not update the stock.'));
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
          <DialogTitle>Adjust Stock</DialogTitle>
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
              onValueChange={(v) => v && switchAction(v as StockAction)}
              className="w-full"
            >
              <ToggleGroupItem value="add" className="flex-1 data-[state=on]:border-success/40 data-[state=on]:bg-success/10 data-[state=on]:text-success">
                <Plus aria-hidden /> Add Stock
              </ToggleGroupItem>
              <ToggleGroupItem value="subtract" className="flex-1 data-[state=on]:border-danger/40 data-[state=on]:bg-danger/10 data-[state=on]:text-danger">
                <Minus aria-hidden /> Subtract Stock
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
            <Field id="stock-reason" label="Reason *" error={recordsLoss ? fieldErrors.reason_code : fieldErrors.reason}>
              <Select value={reason} onValueChange={setReason}>
                <BoundedSelectTrigger id="stock-reason">
                  <SelectValue placeholder="Choose a reason…" />
                </BoundedSelectTrigger>
                <BoundedSelectContent>
                  {action === 'add' ? (
                    ADD_STOCK_REASONS.map((label) => (
                      <BoundedSelectItem key={label} value={`${ADJUST_PREFIX}${label}`} label={label}>
                        {label}
                      </BoundedSelectItem>
                    ))
                  ) : (
                    <>
                      <SelectGroup>
                        <SelectLabel>Material Loss / Waste</SelectLabel>
                        {LOSS_REASONS.map((r) => (
                          <BoundedSelectItem key={r.code} value={`${LOSS_PREFIX}${r.code}`} label={r.label}>
                            {r.label}
                          </BoundedSelectItem>
                        ))}
                      </SelectGroup>
                      <SelectSeparator />
                      <SelectGroup>
                        <SelectLabel>Other Adjustments</SelectLabel>
                        {SUBTRACT_STOCK_REASONS.map((label) => (
                          <BoundedSelectItem key={label} value={`${ADJUST_PREFIX}${label}`} label={label}>
                            {label}
                          </BoundedSelectItem>
                        ))}
                      </SelectGroup>
                    </>
                  )}
                </BoundedSelectContent>
              </Select>
            </Field>
          </div>

          {recordsLoss && (
            <p className={cn('rounded-md border p-3 text-sm', TONE_CLASSES.warning.banner)}>
              Saved as material loss: it appears in the waste report, and its cost counts as waste.
            </p>
          )}

          <Field id="stock-note" label="Notes (optional)" error={recordsLoss ? fieldErrors.loss_reason : undefined}>
            <Input
              id="stock-note"
              maxLength={TEXT_MAX.note}
              placeholder={action === 'add' ? 'e.g. delivery receipt no. 1042' : 'e.g. found during the stock count'}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>

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
              {busy ? 'Saving…' : action === 'add' ? 'Add Stock' : recordsLoss ? 'Record Loss' : 'Subtract Stock'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
