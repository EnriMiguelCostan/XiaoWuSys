'use client';

// Record loss: damaged, misprinted or lost stock (POST /api/inventory/:id/loss). Its cost goes to
// the waste report and the P&L, and the server diagnoses the cause.
//
// Migration 015 (adviser consultation): the old "Adjust Stock" (Add / Subtract by hand) is gone.
// Stock arrives through Stock in, leaves through Stock out, and a shelf count goes through Stock
// count, each with its own numbered record (Inventory menu). Only waste is recorded here.
// "Not enough stock" is decided by the server (409 INSUFFICIENT_STOCK) and shown in the form.
import { useState } from 'react';
import { Minus } from 'lucide-react';
import { bannerText, Field, fieldErrorsMap, FormProblem, RequiredNote } from '@/components/forms/form-bits';
import type { ResultMessage } from '@/components/feedback/result-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectValue } from '@/components/ui/select';
import { BoundedSelectContent, BoundedSelectItem, BoundedSelectTrigger } from '@/components/forms/bounded-select';
import { useApi } from '@/hooks/use-api';
import { offlineNote, toNumberInput, type InventoryItem } from '@/lib/inventory';
import { LOSS_REASONS, type LossResponse } from '@/lib/orders';
import { TONE_CLASSES } from '@/lib/ui-tokens';
import { cn } from '@/lib/utils';
import { TEXT_MAX, WHOLE_NUMBER_MAX } from '@/lib/input-limits';

interface LossReply extends Omit<LossResponse, 'item'> {
  message?: string;
  source?: string;
  item?: InventoryItem;
}

export function LossDialog({
  items,
  initialItemId,
  onClose,
  onDone,
}: {
  items: InventoryItem[];
  initialItemId: string | null;
  onClose: () => void;
  onDone: (result: ResultMessage) => void;
}) {
  const api = useApi();
  const [itemId, setItemId] = useState(initialItemId ?? '');
  const [reasonCode, setReasonCode] = useState('');
  const [quantity, setQuantity] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const item = items.find((i) => i.inventory_id === itemId) ?? null;

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setProblem('');
    setFieldErrors({});
    if (!item) {
      setProblem('Choose the item that was lost or damaged.');
      return;
    }
    const qty = toNumberInput(quantity);
    if (qty === undefined || Number.isNaN(qty)) {
      setProblem('Enter how many, as a number.');
      return;
    }
    if (!reasonCode) {
      setProblem('Choose what happened.');
      return;
    }
    setBusy(true);
    const { ok, data } = await api<LossReply>('POST', `/inventory/${encodeURIComponent(item.inventory_id)}/loss`, {
      quantity_lost: qty,
      reason_code: reasonCode,
      loss_reason: note.trim() || undefined,
    });
    setBusy(false);
    if (!ok) {
      setFieldErrors(fieldErrorsMap(data));
      setProblem(bannerText(data, ['quantity_lost', 'reason_code', 'loss_reason'], 'The loss was not recorded.'));
      return;
    }
    const now = data.item?.quantity_available;
    onDone({
      type: data.replacement_warning ? 'warning' : 'success',
      title: 'Loss recorded',
      message:
        `${qty} of "${item.item_name}" recorded as waste, with its cost.` +
        (now !== undefined ? ` Now ${now.toLocaleString()} on hand.` : '') +
        (data.loss ? `\nCause: ${data.loss.category_label}. ${data.diagnosis?.note ?? ''}` : '') +
        (data.replacement_warning ? `\n${data.replacement_warning.message}` : '') +
        offlineNote(data),
    });
  };

  return (
    <Dialog page open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="min-w-0 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Record loss</DialogTitle>
          <DialogDescription>Damaged, misprinted or lost stock. It leaves the stock and its cost counts as waste.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="max-w-full min-w-0 space-y-4">
          <FormProblem message={problem} />
          <RequiredNote />
          <Field id="loss-item" label="Item *">
            <Select value={itemId} onValueChange={setItemId}>
              <BoundedSelectTrigger id="loss-item">
                <SelectValue placeholder="Select an item…" />
              </BoundedSelectTrigger>
              <BoundedSelectContent>
                {items.map((i) => (
                  <BoundedSelectItem key={i.inventory_id} value={i.inventory_id} label={i.item_name} suffix={`(${i.quantity_available.toLocaleString()} on hand)`}>
                    {i.item_name}
                  </BoundedSelectItem>
                ))}
              </BoundedSelectContent>
            </Select>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="loss-quantity" label="Quantity *" error={fieldErrors.quantity_lost}>
              <Input
                id="loss-quantity"
                type="number"
                min={1}
                max={WHOLE_NUMBER_MAX}
                step={1}
                inputMode="numeric"
                required
                autoFocus={Boolean(initialItemId)}
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
              />
            </Field>
            <Field id="loss-reason" label="What happened *" error={fieldErrors.reason_code}>
              <Select value={reasonCode} onValueChange={setReasonCode}>
                <BoundedSelectTrigger id="loss-reason">
                  <SelectValue placeholder="Choose…" />
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
          </div>
          <Field id="loss-note" label="Notes (optional)" error={fieldErrors.loss_reason}>
            <Input id="loss-note" maxLength={TEXT_MAX.note} placeholder="e.g. found wet after the rain" value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          {item && (
            <p className={cn('rounded-md border p-3 text-sm', TONE_CLASSES.muted.banner)}>
              Currently <strong className="text-foreground">{item.quantity_available.toLocaleString()}</strong> {item.unit || 'pcs'} on hand
              {Boolean(item.quantity_reserved) && ` (${item.quantity_reserved.toLocaleString()} held for orders)`}.
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button busy={busy} type="submit" variant="destructive" disabled={busy || items.length === 0}>
              <Minus aria-hidden /> {busy ? 'Saving…' : 'Record loss'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
