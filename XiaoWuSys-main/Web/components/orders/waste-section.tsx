'use client';

// PB 18 / PB 19: misprints and material losses recorded against this order.
//   POST /api/inventory/:id/loss   { quantity_lost, reason_code, loss_reason?, order_id }
// The server does everything that matters: takes the pieces from general stock (the order's
// reservation stays), stores the order's step, diagnoses the cause (machine failure, human
// error, product defect, or a statistical anomaly), and warns when no free stock is left to
// replace the ruined pieces. This screen picks the material, the reason and the number, and
// shows what the server answered. The button comes from allowed_actions.log_loss.
import { useMemo, useState } from 'react';
import { ChartNoAxesColumnIncreasing, TriangleAlert } from 'lucide-react';
import { formatDateTime } from '@xiaowu/client-core/format';
import type { OrderActions } from '@xiaowu/client-core/permissions';
import { Field, FormProblem, RequiredNote } from '@/components/forms/form-bits';
import { BoundedSelectContent, BoundedSelectItem, BoundedSelectTrigger } from '@/components/forms/bounded-select';
import type { ResultMessage } from '@/components/feedback/result-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectValue } from '@/components/ui/select';
import { useApi } from '@/hooks/use-api';
import { errorMessage } from '@/lib/api';
import { LOSS_NOTE_MAX, WHOLE_NUMBER_MAX } from '@/lib/input-limits';
import { LOSS_REASONS, type LossResponse, type MaterialLoss, type OrderDetail } from '@/lib/orders';
import { LOSS_CATEGORY, lookFor, TONE_CLASSES } from '@/lib/ui-tokens';
import { cn } from '@/lib/utils';

/** The cause the server diagnosed, with its colour from the token file */
export function LossCauseBadge({ label }: { label: string }) {
  const look = lookFor(LOSS_CATEGORY, label);
  const Icon = look.icon;
  return (
    <Badge variant="outline" className={cn('gap-1', TONE_CLASSES[look.tone].badge)}>
      <Icon className="size-3" aria-hidden /> {label}
    </Badge>
  );
}

export function AnomalyBadge() {
  return (
    <Badge variant="outline" className={cn('gap-1', TONE_CLASSES.danger.badge)} title="This item's losses are far above the other items' (more than 2 standard deviations)">
      <ChartNoAxesColumnIncreasing className="size-3" aria-hidden /> Unusually high
    </Badge>
  );
}

export function MaterialLossesSection({
  detail,
  actions,
  onResult,
}: {
  detail: OrderDetail;
  actions: OrderActions;
  onResult: (result: ResultMessage, reload: boolean) => void;
}) {
  const losses = detail.material_losses ?? [];
  const [open, setOpen] = useState(false);
  if (losses.length === 0 && !actions.log_loss) return null;

  return (
    <section className="space-y-2" aria-labelledby="losses-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="losses-title" className="font-semibold">
          Misprints and material losses
        </h3>
        {actions.log_loss && (
          <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
            <TriangleAlert aria-hidden /> Log misprint / material loss
          </Button>
        )}
      </div>
      {losses.length === 0 ? (
        <p className="text-sm text-muted-foreground">No misprints or losses recorded for this order.</p>
      ) : (
        <ul className="space-y-2 text-sm">
          {losses.map((l) => (
            <LossRow key={l.loss_id} loss={l} />
          ))}
        </ul>
      )}
      {open && (
        <LogLossDialog
          detail={detail}
          onClose={() => setOpen(false)}
          onDone={(r) => {
            setOpen(false);
            onResult(r, true);
          }}
        />
      )}
    </section>
  );
}

function LossRow({ loss }: { loss: MaterialLoss }) {
  return (
    <li className="flex min-w-0 flex-col gap-1 rounded-md border p-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 wrap-anywhere">
          <strong className="tabular-nums">{loss.quantity_lost.toLocaleString()}</strong> {loss.unit ?? ''} {loss.item_name}
        </span>
        <LossCauseBadge label={loss.category_label} />
        {loss.is_statistical_anomaly && <AnomalyBadge />}
        {loss.sync_status !== 'synced' && (
          <Badge title="Saved on this computer; it goes to the cloud when the connection is back" variant="outline" className={TONE_CLASSES.info.badge}>
            Pending sync
          </Badge>
        )}
      </div>
      <p className="text-xs text-muted-foreground wrap-anywhere">
        {loss.reason_label ?? loss.loss_reason}
        {loss.reason_label && loss.loss_reason !== loss.reason_label ? ` · ${loss.loss_reason}` : ''}
        {loss.production_stage ? ` · during ${loss.production_stage}` : ''} · {formatDateTime(loss.date_recorded, { utc: true })}
      </p>
    </li>
  );
}

function LogLossDialog({
  detail,
  onClose,
  onDone,
}: {
  detail: OrderDetail;
  onClose: () => void;
  onDone: (result: ResultMessage) => void;
}) {
  const api = useApi();
  // The order's materials that are linked to stock, once each
  const materials = useMemo(() => {
    const seen = new Map<string, string>();
    for (const it of detail.items) if (it.inventory_id && !seen.has(it.inventory_id)) seen.set(it.inventory_id, it.product_type);
    return [...seen].map(([inventory_id, name]) => ({ inventory_id, name }));
  }, [detail.items]);
  const [itemId, setItemId] = useState(materials.length === 1 ? materials[0].inventory_id : '');
  const [reasonCode, setReasonCode] = useState('');
  const [quantity, setQuantity] = useState('');
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setProblem('');
    const qtyText = quantity.trim();
    const qty = Number(qtyText);
    const cleanNote = note.trim().replace(/\s+/g, ' ');
    if (!itemId || !materials.some((m) => m.inventory_id === itemId)) return setProblem('Choose the material that was ruined.');
    if (!reasonCode || !LOSS_REASONS.some((r) => r.code === reasonCode)) return setProblem('Choose what happened from the list.');
    if (!qtyText) return setProblem('Enter how many pieces were ruined.');
    if (!/^\d+$/.test(qtyText)) return setProblem('Pieces ruined must be a whole number, like 1 or 12 (no decimals or minus signs).');
    if (qty < 1) return setProblem('Pieces ruined must be at least 1.');
    if (qty > WHOLE_NUMBER_MAX) return setProblem('That number is too large.');
    if (cleanNote.length > LOSS_NOTE_MAX) return setProblem(`Keep the note to ${LOSS_NOTE_MAX} characters or fewer.`);
    if (cleanNote && !/[A-Za-z0-9]/.test(cleanNote)) return setProblem('The note must contain words, not only symbols. Or leave it empty.');
    setBusy(true);
    const { ok, data } = await api<LossResponse>('POST', `/inventory/${encodeURIComponent(itemId)}/loss`, {
      quantity_lost: qty,
      reason_code: reasonCode,
      loss_reason: cleanNote || undefined,
      order_id: detail.order.order_id,
    });
    setBusy(false);
    if (!ok) {
      setProblem(errorMessage(data, 'The loss was not recorded.'));
      return;
    }
    const warning = data.replacement_warning?.message;
    onDone({
      type: warning ? 'warning' : 'success',
      title: 'Misprint recorded',
      message: [
        `${qty} ${data.item?.item_name ?? 'piece(s)'} taken from stock as ${data.loss?.reason_label ?? 'a loss'}.`,
        data.loss ? `Cause: ${data.loss.category_label}. ${data.diagnosis?.note ?? ''}` : null,
        data.diagnosis?.escalated?.length ? `${data.diagnosis.escalated.length} earlier loss(es) were also marked as a machine failure.` : null,
        warning ?? null,
        data.source === 'local' ? 'Saved on this computer (offline). It will be sent to the cloud when the connection is back.' : null,
      ]
        .filter(Boolean)
        .join('\n'),
    });
  };

  return (
    <Dialog open onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent className="min-w-0 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Log misprint / material loss</DialogTitle>
          <DialogDescription>
            The pieces come out of general stock (this order keeps its reserved materials). The system names the likely cause.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} noValidate className="max-w-full min-w-0 space-y-4">
          <FormProblem message={problem} />
          <RequiredNote />
          {materials.length === 0 ? (
            <p className="text-sm text-muted-foreground">This order has no materials linked to stock. Record the loss from the Catalog instead.</p>
          ) : (
            <Field id="loss-item" label="Material *">
              <Select value={itemId} onValueChange={setItemId} disabled={busy}>
                <BoundedSelectTrigger id="loss-item">
                  <SelectValue placeholder="Choose the material…" />
                </BoundedSelectTrigger>
                <BoundedSelectContent>
                  {materials.map((m) => (
                    <BoundedSelectItem key={m.inventory_id} value={m.inventory_id} label={m.name}>
                      {m.name}
                    </BoundedSelectItem>
                  ))}
                </BoundedSelectContent>
              </Select>
            </Field>
          )}
          <Field id="loss-code" label="What happened? *">
            <Select value={reasonCode} onValueChange={setReasonCode} disabled={busy}>
              <BoundedSelectTrigger id="loss-code">
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
          <Field id="loss-qty" label="Pieces ruined *">
            <Input
              id="loss-qty"
              type="number"
              min={1}
              max={WHOLE_NUMBER_MAX}
              step={1}
              inputMode="numeric"
              required
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              disabled={busy}
            />
          </Field>
          <Field id="loss-note" label="Notes (optional)" hint={`${note.length}/${LOSS_NOTE_MAX} characters`}>
            <Input id="loss-note" maxLength={LOSS_NOTE_MAX} autoComplete="off" placeholder="e.g. logo shifted on the left sleeve" value={note} onChange={(e) => setNote(e.target.value)} disabled={busy} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button busy={busy} type="submit" variant="destructive" disabled={busy || materials.length === 0}>
              {busy ? 'Saving…' : 'Record loss'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
