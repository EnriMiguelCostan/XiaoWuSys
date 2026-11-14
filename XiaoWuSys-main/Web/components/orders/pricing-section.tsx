'use client';

// PB 11 / PB 12 / PB 15 sections of the order detail sheet.
//
// QuoteSection: the quote as the server shows it (subtotal, discount and reason, total), and for
// the Owner (allowed_actions.generate_quote / apply_discount) a panel that asks the server to work
// out the volume price:
//   POST /api/orders/:id/quote { dry_run: true, discount_amount | discount_percent, discount_reason }  preview
//   POST /api/orders/:id/quote { ...same }                                                            save
// Every peso on screen comes from the server; the panel only collects the discount and reason.
//
// ConsumablesUsed: what the order's status changes took from stock (consumables_deducted), with
// a warning when the stock ran out (shortfall).
import { useState } from 'react';
import { Calculator, FlaskConical, Printer, TriangleAlert } from 'lucide-react';
import { formatDateTime, peso } from '@xiaowu/client-core/format';
import type { OrderActions } from '@xiaowu/client-core/permissions';
import { Field, FormProblem } from '@/components/forms/form-bits';
import type { ResultMessage } from '@/components/feedback/result-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useApi } from '@/hooks/use-api';
import { errorMessage } from '@/lib/api';
import { toNumberInput } from '@/lib/inventory';
import { MONEY_INPUT_MAX } from '@/lib/input-limits';
import type { OrderDetail, QuoteBreakdown, QuoteCalculation } from '@/lib/orders';
import { TONE_CLASSES } from '@/lib/ui-tokens';
import { cn } from '@/lib/utils';

type OnResult = (result: ResultMessage, reload: boolean) => void;
type DiscountMode = 'none' | 'amount' | 'percent';

interface QuoteReply {
  message?: string;
  calculation?: QuoteCalculation;
  quote?: QuoteBreakdown;
}

function Totals({ quote }: { quote: Pick<QuoteBreakdown, 'subtotal_amount' | 'discount_amount' | 'discount_reason' | 'total_quote_amount'> }) {
  return (
    <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
      <dt className="text-muted-foreground">Subtotal</dt>
      <dd className="text-right tabular-nums">{peso(quote.subtotal_amount)}</dd>
      {quote.discount_amount ? (
        <>
          <dt className="min-w-0 text-muted-foreground wrap-anywhere">Discount{quote.discount_reason ? ` (${quote.discount_reason})` : ''}</dt>
          <dd className="text-right tabular-nums">−{peso(quote.discount_amount)}</dd>
        </>
      ) : null}
      <dt className="font-semibold">Total quote</dt>
      <dd className="text-right font-semibold tabular-nums">{peso(quote.total_quote_amount)}</dd>
    </dl>
  );
}

export function QuoteSection({
  detail,
  actions,
  onResult,
  onPrintQuote,
}: {
  detail: OrderDetail;
  actions: OrderActions;
  onResult: OnResult;
  onPrintQuote: () => void;
}) {
  const api = useApi();
  const quote = detail.quote;
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<DiscountMode>(quote?.discount_amount ? 'amount' : 'none');
  const [value, setValue] = useState(quote?.discount_amount ? String(quote.discount_amount) : '');
  const [reason, setReason] = useState(quote?.discount_reason ?? '');
  const [preview, setPreview] = useState<QuoteCalculation | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');

  if (!quote && !actions.generate_quote) return null;

  // Builds the request from the form; null (with a message) when a number is not a number
  const requestBody = (): Record<string, unknown> | null => {
    const body: Record<string, unknown> = { expected_version: detail.order.version || undefined };
    if (!actions.apply_discount || mode === 'none') {
      if (actions.apply_discount) body.discount_amount = 0; // "no discount" removes an old one
      return body;
    }
    const n = toNumberInput(value);
    if (n === undefined || Number.isNaN(n)) {
      setProblem(mode === 'percent' ? 'The discount must be a percentage, like 5 or 12.5.' : 'The discount must be a peso amount, like 150 or 150.50.');
      return null;
    }
    if (mode === 'percent') body.discount_percent = n;
    else body.discount_amount = n;
    body.discount_reason = reason.trim() || undefined;
    return body;
  };

  const send = async (dryRun: boolean) => {
    setProblem('');
    const body = requestBody();
    if (!body) return;
    setBusy(true);
    const { ok, data } = await api<QuoteReply>('POST', `/orders/${encodeURIComponent(detail.order.order_id)}/quote`, { ...body, dry_run: dryRun });
    setBusy(false);
    if (!ok) {
      setPreview(null);
      setProblem(errorMessage(data, 'The quote could not be calculated.'));
      return;
    }
    if (dryRun) {
      setPreview(data.calculation ?? null);
      return;
    }
    setOpen(false);
    setPreview(null);
    onResult({ type: 'success', title: 'Quote saved', message: data.message ?? 'The quote was saved.' }, true);
  };

  return (
    <section className="space-y-3" aria-labelledby="pricing-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="pricing-title" className="font-semibold">
          Quote
        </h3>
        <div className="flex flex-wrap gap-2">
          {actions.print_quote && (
            <Button variant="outline" size="sm" onClick={onPrintQuote}>
              <Printer aria-hidden /> Print official quote
            </Button>
          )}
          {actions.generate_quote && !open && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setProblem('');
                setPreview(null);
                setOpen(true);
              }}
            >
              <Calculator aria-hidden /> {actions.apply_discount ? 'Calculate quote & discount' : 'Calculate quote'}
            </Button>
          )}
        </div>
      </div>

      {quote?.has_quote ? (
        <div className="rounded-md border bg-card p-3">
          <Totals quote={quote} />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No quote yet.</p>
      )}

      {open && (
        <div className="space-y-3 rounded-md border bg-muted/30 p-3">
          <p className="text-xs text-muted-foreground">
            The price of each item comes from its selling price in the Catalog, with the bulk price for the order’s total number of pieces.
          </p>
          <FormProblem message={problem} />
          {actions.apply_discount && (
            <div className="space-y-3">
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                value={mode}
                onValueChange={(v) => {
                  if (!v) return;
                  setMode(v as DiscountMode);
                  setPreview(null);
                }}
                aria-label="Discount"
              >
                <ToggleGroupItem value="none">No discount</ToggleGroupItem>
                <ToggleGroupItem value="amount">Discount in ₱</ToggleGroupItem>
                <ToggleGroupItem value="percent">Discount in %</ToggleGroupItem>
              </ToggleGroup>
              {mode !== 'none' && (
                <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
                  <Field id="discount-input" label={mode === 'percent' ? 'Discount (%)' : 'Discount (₱)'}>
                    <Input
                      id="discount-input"
                      type="number"
                      min={0}
                      max={mode === 'percent' ? 100 : MONEY_INPUT_MAX}
                      step="0.01"
                      inputMode="decimal"
                      value={value}
                      onChange={(e) => {
                        setValue(e.target.value);
                        setPreview(null);
                      }}
                    />
                  </Field>
                  <Field id="discount-reason" label="Reason (required)">
                    <Input
                      id="discount-reason"
                      maxLength={500}
                      placeholder="e.g. Loyal school customer"
                      value={reason}
                      onChange={(e) => {
                        setReason(e.target.value);
                        setPreview(null);
                      }}
                    />
                  </Field>
                </div>
              )}
            </div>
          )}

          {preview && (
            <div className="space-y-2">
              <p className="text-sm">
                <Badge variant="outline" className={TONE_CLASSES.info.badge}>
                  {preview.tier.label}
                </Badge>{' '}
                <span className="text-muted-foreground">{preview.total_quantity.toLocaleString()} pieces in all</span>
              </p>
              <div className="max-w-full min-w-0 overflow-x-auto rounded-md border">
                <Table aria-label="Quote preview">
                  <TableHeader className="bg-muted/50">
                    <TableRow>
                      <TableHead>Item</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead className="text-right">Price each</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {preview.lines.map((l) => (
                      <TableRow key={l.line_item_id}>
                        <TableCell className="min-w-32 whitespace-normal wrap-anywhere">
                          {l.product_type}
                          {l.size ? <span className="text-muted-foreground"> · {l.size}</span> : null}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{l.quantity.toLocaleString()}</TableCell>
                        <TableCell className="text-right tabular-nums">{peso(l.unit_price)}</TableCell>
                        <TableCell className="text-right tabular-nums">{peso(l.line_total)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <Totals quote={preview} />
              <p className="text-xs text-muted-foreground">Nothing is saved until you press Save quote.</p>
            </div>
          )}

          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => void send(true)} disabled={busy}>
              {busy ? 'Working…' : 'Preview'}
            </Button>
            <Button type="button" size="sm" onClick={() => void send(false)} disabled={busy || !preview}>
              Save quote
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

export function ConsumablesUsed({ detail }: { detail: OrderDetail }) {
  const used = detail.consumables_deducted ?? [];
  if (used.length === 0) return null;
  return (
    <section className="space-y-2" aria-labelledby="consumables-title">
      <h3 id="consumables-title" className="flex items-center gap-2 font-semibold">
        <FlaskConical className="size-4 text-muted-foreground" aria-hidden /> Consumables used
      </h3>
      <ul className="space-y-1.5 text-sm">
        {used.map((c) => (
          <li key={c.log_id ?? `${c.trigger_status}:${c.consumable_inventory_id}`} className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 wrap-anywhere">
              <strong className="tabular-nums">{c.quantity_deducted.toLocaleString()}</strong> {c.unit ?? ''} {c.item_name}
            </span>
            <span className="text-xs text-muted-foreground">
              {c.trigger_status === 'Completed' ? 'on completion' : 'when printing ended'}
              {c.deducted_at ? ` · ${formatDateTime(c.deducted_at, { utc: true })}` : ''}
            </span>
            {c.shortfall ? (
              <Badge variant="outline" className={cn('gap-1', TONE_CLASSES.warning.badge)}>
                <TriangleAlert className="size-3" aria-hidden /> Short by {c.shortfall.toLocaleString()}: stock ran out
              </Badge>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
