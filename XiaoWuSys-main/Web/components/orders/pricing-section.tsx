'use client';

// PB 11 / PB 12 / PB 15 sections of the order detail sheet.
//
// QuoteSection: the quote as the server shows it (subtotal, discount and reason, total), and for
// the Owner (allowed_actions.generate_quote / apply_discount) a panel that asks the server to work
// out the volume price:
//   POST /api/orders/:id/quote { dry_run: true, discount_amount | discount_percent, discount_reason }  preview
//   POST /api/orders/:id/quote { ...same }                                                            save
// Every peso on screen comes from the server; the panel only collects the discount and reason.
// Migration 015 (adviser consultation): a quote is materials + labor / services + incidental
// charges (an amount, or a % for changes nobody can see yet) - discount. After approval the Owner
// may cut the price with a reason (late delivery, production error): PriceCutPanel below. If
// more was paid than the new bill, the order shows Overpaid and the difference is refunded.
//
// ConsumablesUsed: what the order's status changes took from stock (consumables_deducted), with
// a warning when the stock ran out (shortfall).
import { useState } from 'react';
import { BadgePercent, Calculator, FlaskConical, Printer, TriangleAlert } from 'lucide-react';
import { formatDateTime, peso } from '@xiaowu/client-core/format';
import type { OrderActions } from '@xiaowu/client-core/permissions';
import { bannerText, Field, fieldErrorsMap, FormProblem } from '@/components/forms/form-bits';
import type { ResultMessage } from '@/components/feedback/result-dialog';
import { Badge } from '@/components/ui/badge';
import { ORDER_SECTION } from '@/components/orders/jump-to-section';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useApi } from '@/hooks/use-api';
import { DISCOUNT_LIMITS, MONEY_INPUT_MAX, TWO_DECIMALS } from '@/lib/input-limits';
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

type TotalsShape = Pick<QuoteBreakdown, 'subtotal_amount' | 'discount_amount' | 'discount_reason' | 'total_quote_amount'
  | 'labor_amount' | 'incidental_amount' | 'adjustment_amount' | 'adjustment_reason'>;

function Totals({ quote }: { quote: TotalsShape }) {
  return (
    <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
      <dt className="text-muted-foreground">Materials</dt>
      <dd className="text-right tabular-nums">{peso(quote.subtotal_amount)}</dd>
      {quote.labor_amount ? (
        <>
          <dt className="text-muted-foreground">Labor and services</dt>
          <dd className="text-right tabular-nums">{peso(quote.labor_amount)}</dd>
        </>
      ) : null}
      {quote.incidental_amount ? (
        <>
          <dt className="text-muted-foreground">Incidental charges</dt>
          <dd className="text-right tabular-nums">{peso(quote.incidental_amount)}</dd>
        </>
      ) : null}
      {quote.discount_amount ? (
        <>
          <dt className="min-w-0 text-muted-foreground wrap-anywhere">Discount{quote.discount_reason ? ` (${quote.discount_reason})` : ''}</dt>
          <dd className="text-right tabular-nums">−{peso(quote.discount_amount)}</dd>
        </>
      ) : null}
      {quote.adjustment_amount ? (
        <>
          <dt className="min-w-0 text-muted-foreground wrap-anywhere">Price cut after approval{quote.adjustment_reason ? ` (${quote.adjustment_reason})` : ''}</dt>
          <dd className="text-right tabular-nums">−{peso(quote.adjustment_amount)}</dd>
        </>
      ) : null}
      <dt className="font-semibold">Total quote</dt>
      <dd className="text-right font-semibold tabular-nums">{peso(quote.total_quote_amount)}</dd>
    </dl>
  );
}

/**
 * What is wrong with the discount the Owner typed, in plain words ('' when it is fine). The
 * server checks everything again (and that the discount is not bigger than the subtotal).
 */
function discountProblem(mode: DiscountMode, value: string, reason: string): string {
  if (mode === 'none') return '';
  const text = value.trim();
  const D = DISCOUNT_LIMITS;
  if (mode === 'percent') {
    if (!text) return 'Enter the discount percentage, like 5 or 12.5.';
    if (!TWO_DECIMALS.test(text)) return 'The discount (%) must be a number with at most 2 decimals, like 5 or 12.5.';
    const n = Number(text);
    if (n === 0) return 'A 0% discount is no discount: choose “No discount” instead.';
    if (n < D.percentMin || n > D.percentMax) return `The discount (%) must be from ${D.percentMin} to ${D.percentMax}.`;
  } else {
    if (!text) return 'Enter the discount in pesos, like 150 or 150.50.';
    if (!TWO_DECIMALS.test(text)) return 'The discount (₱) must be a peso amount with at most 2 decimals, like 150 or 150.50.';
    const n = Number(text);
    if (n === 0) return 'A ₱0 discount is no discount: choose “No discount” instead.';
    if (n > MONEY_INPUT_MAX) return 'That discount is too large.';
  }
  const why = reason.trim();
  if (!why) return 'Write the reason for the discount (for example “Loyal school customer”).';
  if (why.length < D.reasonMin) return `The reason is too short. Write at least ${D.reasonMin} characters.`;
  if (why.length > D.reasonMax) return `Keep the reason to ${D.reasonMax} characters or fewer.`;
  if (!/[A-Za-z]/.test(why)) return 'The reason must be written in words, not only numbers or symbols.';
  return '';
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
  const [labor, setLabor] = useState(quote?.labor_amount ? String(quote.labor_amount) : '');
  const [incidentalMode, setIncidentalMode] = useState<'amount' | 'percent'>('amount');
  const [incidental, setIncidental] = useState(quote?.incidental_amount ? String(quote.incidental_amount) : '');
  const [preview, setPreview] = useState<QuoteCalculation | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  // Nielsen H9: the server's VALIDATION_FAILED details, shown next to their fields
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  if (!quote && !actions.generate_quote) return null;

  // Builds the request from the form; null (with a message) when a number is not a number
  const requestBody = (): Record<string, unknown> | null => {
    const body: Record<string, unknown> = { expected_version: detail.order.version || undefined };
    // Labor / services and incidental charges: empty = ₱0
    const laborValue = labor.trim() === '' ? 0 : Number(labor.trim());
    const incidentalValue = incidental.trim() === '' ? 0 : Number(incidental.trim());
    if (Number.isNaN(laborValue) || Number.isNaN(incidentalValue)) {
      setProblem('Labor and incidental charges must be numbers.');
      return null;
    }
    body.labor_amount = laborValue;
    if (incidentalMode === 'percent') body.incidental_percent = incidentalValue;
    else body.incidental_amount = incidentalValue;
    if (!actions.apply_discount || mode === 'none') {
      if (actions.apply_discount) body.discount_amount = 0; // "no discount" removes an old one
      return body;
    }
    const problem = discountProblem(mode, value, reason);
    if (problem) {
      setProblem(problem);
      return null;
    }
    const n = Number(value.trim());
    if (mode === 'percent') body.discount_percent = n;
    else body.discount_amount = n;
    body.discount_reason = reason.trim().replace(/\s+/g, ' ');
    return body;
  };

  const send = async (dryRun: boolean) => {
    setProblem('');
    setFieldErrors({});
    const body = requestBody();
    if (!body) return;
    setBusy(true);
    const { ok, data } = await api<QuoteReply>('POST', `/orders/${encodeURIComponent(detail.order.order_id)}/quote`, { ...body, dry_run: dryRun });
    setBusy(false);
    if (!ok) {
      setPreview(null);
      setFieldErrors(fieldErrorsMap(data));
      setProblem(bannerText(data, ['discount_amount', 'discount_percent', 'discount_reason', 'labor_amount', 'incidental_amount', 'incidental_percent'], 'The quote could not be calculated.'));
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
    <section id={ORDER_SECTION.quote} className="scroll-mt-4 space-y-3" aria-labelledby="pricing-title">
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
            Add labor and services, and incidental charges for changes nobody can see yet (for example a ₱60,000 job quoted at ₱65,000).
          </p>
          <FormProblem message={problem} />
          <div className="grid gap-3 sm:grid-cols-[10rem_auto_10rem]">
            <Field id="labor-input" label="Labor and services (₱)" error={fieldErrors.labor_amount}>
              <Input id="labor-input" type="number" min={0} max={MONEY_INPUT_MAX} step="0.01" inputMode="decimal" placeholder="0.00" value={labor}
                onChange={(e) => { setLabor(e.target.value); setPreview(null); }} />
            </Field>
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Incidental charges in</span>
              <ToggleGroup type="single" variant="outline" size="sm" value={incidentalMode}
                onValueChange={(v) => { if (v) { setIncidentalMode(v as 'amount' | 'percent'); setPreview(null); } }} aria-label="Incidental charges in">
                <ToggleGroupItem value="amount">₱</ToggleGroupItem>
                <ToggleGroupItem value="percent">%</ToggleGroupItem>
              </ToggleGroup>
            </div>
            <Field id="incidental-input" label={incidentalMode === 'percent' ? 'Incidental (%)' : 'Incidental (₱)'}
              error={fieldErrors.incidental_amount || fieldErrors.incidental_percent} hint={incidentalMode === 'percent' ? 'Of materials + labor' : undefined}>
              <Input id="incidental-input" type="number" min={0} step="0.01" inputMode="decimal" placeholder="0" value={incidental}
                onChange={(e) => { setIncidental(e.target.value); setPreview(null); }} />
            </Field>
          </div>
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
                  <Field
                    id="discount-input"
                    label={mode === 'percent' ? 'Discount (%)' : 'Discount (₱)'}
                    error={fieldErrors.discount_percent || fieldErrors.discount_amount}
                  >
                    <Input
                      id="discount-input"
                      type="number"
                      min={0}
                      max={mode === 'percent' ? DISCOUNT_LIMITS.percentMax : MONEY_INPUT_MAX}
                      step="0.01"
                      placeholder={mode === 'percent' ? 'e.g. 10' : 'e.g. 150'}
                      inputMode="decimal"
                      value={value}
                      onChange={(e) => {
                        setValue(e.target.value);
                        setPreview(null);
                      }}
                    />
                  </Field>
                  <Field
                    id="discount-reason"
                    label="Reason (required)"
                    error={fieldErrors.discount_reason}
                    hint={`${reason.length}/${DISCOUNT_LIMITS.reasonMax} characters · printed on the quote`}
                  >
                    <Input
                      id="discount-reason"
                      maxLength={DISCOUNT_LIMITS.reasonMax}
                      autoComplete="off"
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
            <Button busy={busy} type="button" variant="outline" size="sm" onClick={() => void send(true)} disabled={busy}>
              {busy ? 'Calculating…' : 'Preview'}
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

// ---------------------------------------------------------------------------------------------
// The Owner's price cut after approval (allowed_actions.adjust_price): a late delivery or a
// production error. The server lowers the bill and keeps the reason; if more was paid than the
// new bill, the order shows Overpaid and the Owner refunds the difference (Payments).
export function PriceCutPanel({ detail, actions, onResult }: { detail: OrderDetail; actions: OrderActions; onResult: OnResult }) {
  const api = useApi();
  const current = detail.quote?.adjustment_amount ?? 0;
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(current ? String(current) : '');
  const [reason, setReason] = useState(detail.quote?.adjustment_reason ?? '');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  if (!actions.adjust_price) return null;

  const save = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setProblem('');
    setFieldErrors({});
    const value = amount.trim() === '' ? 0 : Number(amount.trim());
    if (Number.isNaN(value)) {
      setProblem('The price cut must be a peso amount.');
      return;
    }
    setBusy(true);
    const { ok, data } = await api<{ message?: string }>('POST', `/orders/${encodeURIComponent(detail.order.order_id)}/price-adjustment`, {
      adjustment_amount: value,
      adjustment_reason: reason.trim() || undefined,
    });
    setBusy(false);
    if (!ok) {
      setFieldErrors(fieldErrorsMap(data));
      setProblem(bannerText(data, ['adjustment_amount', 'adjustment_reason'], 'The price was not changed.'));
      return;
    }
    setOpen(false);
    onResult({ type: 'success', title: 'Price changed', message: data.message ?? 'Saved.' }, true);
  };

  return (
    <div className="space-y-2">
      {!open ? (
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          <BadgePercent aria-hidden /> {current ? 'Change the price cut' : 'Cut the price (late delivery, error)'}
        </Button>
      ) : (
        <form onSubmit={save} className="space-y-3 rounded-md border bg-muted/30 p-3">
          <p className="text-xs text-muted-foreground">
            The whole price cut so far (₱0 removes it). The downpayment already checked stays valid. If the customer paid more than the new bill, refund the difference under Payments.
          </p>
          <FormProblem message={problem} />
          <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
            <Field id="cut-value" label="Price cut (₱)" error={fieldErrors.adjustment_amount}>
              <Input id="cut-value" type="number" min={0} max={MONEY_INPUT_MAX} step="0.01" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </Field>
            <Field id="cut-reason" label="Reason *" error={fieldErrors.adjustment_reason}>
              <Input id="cut-reason" maxLength={500} placeholder="e.g. Delivered 3 days late" value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" size="sm" busy={busy} disabled={busy}>
              {busy ? 'Saving…' : 'Save price cut'}
            </Button>
          </div>
        </form>
      )}
    </div>
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
