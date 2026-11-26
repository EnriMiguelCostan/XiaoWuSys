'use client';

// Batch M6 part 3 dashboard cards. Every figure is the server's; nothing here adds up money.
//   WasteCard      PB 20: this month's material waste by diagnosed cause (GET /api/reports/dashboard
//                  "waste"), the statistical anomalies and the latest losses. Costs only when the
//                  server sends them (costs_visible).
//   OverheadsCard  PB 22: rent, electricity, wages... (GET / POST / DELETE /api/reports/overheads),
//                  for view_finance accounts. Removing one is the Owner's (each row's can_delete).
//   PnlCard        PB 22: the Owner's true-cost Profit & Loss "Magic Button" (GET /api/reports/pnl),
//                  with the Excel download and a printable statement.
import { useCallback, useEffect, useState } from 'react';
import { Download, Eye, Printer, ReceiptText, Sparkles, Trash2, TrendingDown, TrendingUp } from 'lucide-react';
import { formatDateTime, peso } from '@xiaowu/client-core/format';
import { Cell } from '@/components/dashboard/dashboard-parts';
import { ConfirmDialog } from '@/components/feedback/confirm-dialog';
import type { ResultMessage } from '@/components/feedback/result-dialog';
import { DateInput } from '@/components/forms/date-input';
import { bannerText, Field, fieldErrorsMap, FormProblem, RequiredNote } from '@/components/forms/form-bits';
import { AnomalyBadge, LossCauseBadge } from '@/components/orders/waste-section';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useApi } from '@/hooks/use-api';
import { downloadFile, errorMessage } from '@/lib/api';
import { EXPENSE_DESCRIPTION_MAX, MONEY_INPUT_MAX, TWO_DECIMALS } from '@/lib/input-limits';
import { printPnlReport } from '@/lib/print';
import { monthLabel, type OverheadExpense, type OverheadList, type ProfitAndLoss, type WasteSummary } from '@/lib/reports';
import { TONE_CLASSES } from '@/lib/ui-tokens';
import { cn } from '@/lib/utils';

type OnResult = (result: ResultMessage) => void;

const periodQuery = (from: string, to: string) => {
  const q = new URLSearchParams();
  if (from) q.set('from', from);
  if (to) q.set('to', to);
  const text = q.toString();
  return text ? `?${text}` : '';
};

// ---------------------------------------------------------------------------------------------
// PB 20: waste and defect diagnostics
// ---------------------------------------------------------------------------------------------
export function WasteCard({ waste, onDownload }: { waste: WasteSummary; onDownload?: () => void }) {
  return (
    <Card className="min-w-0">
      <CardHeader className="min-w-0">
        <CardTitle className="truncate">Waste and defect diagnostics</CardTitle>
        <CardDescription className="truncate">{monthLabel(waste.month)}: misprints and material losses by likely cause.</CardDescription>
        {onDownload && (
          <CardAction>
            <Button variant="outline" size="sm" onClick={onDownload}>
              <Download aria-hidden /> Waste (Excel)
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-4">
        <dl className="grid min-w-0 grid-cols-2 gap-3 sm:grid-cols-3">
          {waste.costs_visible && (
            <div className="min-w-0">
              <dt className="text-xs text-muted-foreground">Cost this month</dt>
              <dd className="text-lg font-semibold tabular-nums wrap-anywhere">{peso(waste.total_cost_this_month)}</dd>
            </div>
          )}
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">Pieces lost</dt>
            <dd className="text-lg font-semibold tabular-nums">{waste.total_items_this_month.toLocaleString()}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">Losses recorded</dt>
            <dd className="text-lg font-semibold tabular-nums">{waste.count_this_month.toLocaleString()}</dd>
          </div>
        </dl>

        <ul className="flex min-w-0 flex-col gap-1.5 text-sm" aria-label="Losses by cause">
          {waste.by_category.map((c) => (
            <li key={c.category} className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <LossCauseBadge label={c.category} />
              <span className="tabular-nums text-muted-foreground">
                {c.count.toLocaleString()} loss(es) · {c.quantity.toLocaleString()} pc(s)
                {waste.costs_visible && c.cost !== null ? ` · ${peso(c.cost)}` : ''}
              </span>
            </li>
          ))}
        </ul>

        {waste.anomalies.length > 0 && (
          <div className={cn('rounded-md border p-3 text-sm', TONE_CLASSES.danger.banner)}>
            <p className="font-semibold">Unusually high losses: check these batches</p>
            <ul className="mt-1 list-inside list-disc">
              {waste.anomalies.map((a) => (
                <li key={a.loss_id} className="wrap-anywhere">
                  {a.item_name}: {a.quantity_lost.toLocaleString()} lost on {formatDateTime(a.date_recorded, { utc: true, withTime: false })} ({a.reason_label})
                </li>
              ))}
            </ul>
          </div>
        )}

        {waste.recent.length === 0 ? (
          <p className="text-sm text-muted-foreground">No losses recorded yet.</p>
        ) : (
          <div className="max-w-full min-w-0 overflow-x-auto rounded-md border">
            <Table className="table-fixed">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="pl-3">Latest losses</TableHead>
                  <TableHead className="w-20 text-right">Qty</TableHead>
                  <TableHead className="hidden w-40 sm:table-cell">Cause</TableHead>
                  {waste.costs_visible && <TableHead className="hidden w-28 pr-3 text-right md:table-cell">Cost</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {waste.recent.map((l) => (
                  <TableRow key={l.loss_id}>
                    <TableCell className="pl-3">
                      <Cell className="font-medium" value={l.item_name} />
                      <Cell
                        className="text-xs text-muted-foreground"
                        value={[l.reason_label, l.order_label, formatDateTime(l.date_recorded, { utc: true })].filter(Boolean).join(' · ')}
                      />
                      {l.is_statistical_anomaly && <AnomalyBadge />}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{l.quantity_lost.toLocaleString()}</TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <LossCauseBadge label={l.category_label} />
                    </TableCell>
                    {waste.costs_visible && (
                      <TableCell className="hidden pr-3 text-right tabular-nums md:table-cell">{peso(l.financial_cost)}</TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// PB 22: overhead expenses
// ---------------------------------------------------------------------------------------------
type OverheadsLoaded = { key: string; data: OverheadList | null; error: string };

export function OverheadsCard({ onResult }: { onResult: OnResult }) {
  const api = useApi();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [tick, setTick] = useState(0);
  const [loaded, setLoaded] = useState<OverheadsLoaded | null>(null);
  const [removing, setRemoving] = useState<OverheadExpense | null>(null);
  const [viewing, setViewing] = useState<OverheadExpense | null>(null);
  const [busy, setBusy] = useState(false);
  // New expense form (opens as its own sub page)
  const [recording, setRecording] = useState(false);
  const [day, setDay] = useState('');
  const [category, setCategory] = useState('');
  const [description, setDescription] = useState('');
  const [pesos, setPesos] = useState('');
  const [problem, setProblem] = useState('');
  // Nielsen H9: the server's VALIDATION_FAILED details, shown next to their fields
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const query = periodQuery(from, to);
  const requestKey = `${query}|${tick}`;
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    api<OverheadList>('GET', `/reports/overheads${query}`).then(({ ok, data }) => {
      if (cancelled) return;
      if (ok && data.period) {
        setLoaded({ key: requestKey, data, error: '' });
        // The first answer fills the date pickers with the server's default period
        setFrom((f) => f || data.period.from);
        setTo((t) => t || data.period.to);
      } else {
        setLoaded((prev) => ({ key: requestKey, data: prev?.data ?? null, error: errorMessage(data, 'The expenses could not be loaded.') }));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [api, query, requestKey]);

  const data = loaded?.data ?? null;
  const error = loaded && loaded.key === requestKey ? loaded.error : '';

  const add = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setProblem('');
    setFieldErrors({});
    const value = Number(pesos.trim());
    const text = description.trim().replace(/\s+/g, ' ');
    if (!day) return setProblem('Choose the date of the expense.');
    if (!category) return setProblem('Choose a category.');
    if (!text) return setProblem('Write a short description, like “November rent”.');
    if (text.length < 3) return setProblem('The description is too short. Write at least 3 characters.');
    if (text.length > EXPENSE_DESCRIPTION_MAX) return setProblem(`Keep the description to ${EXPENSE_DESCRIPTION_MAX} characters or fewer.`);
    if (!/[A-Za-z]/.test(text)) return setProblem('The description must be written in words, not only numbers or symbols.');
    if (/\S{41,}/.test(text)) return setProblem('The description has a very long word with no spaces. Please write it in normal words.');
    if (pesos.trim() === '' || Number.isNaN(value)) return setProblem('Enter the cost in pesos, as a number.');
    if (!TWO_DECIMALS.test(pesos.trim())) return setProblem('The cost must be a peso amount with at most 2 decimals, like 1500 or 1500.50.');
    if (value <= 0) return setProblem('The cost must be more than ₱0.');
    if (value > MONEY_INPUT_MAX) return setProblem('That cost is too large.');
    setBusy(true);
    const { ok, data: res } = await api<{ message?: string; source?: string }>('POST', '/reports/overheads', {
      expense_date: day,
      category,
      description: text,
      amount: value,
    });
    setBusy(false);
    if (!ok) {
      setFieldErrors(fieldErrorsMap(res));
      return setProblem(bannerText(res, ['expense_date', 'category', 'description', 'amount'], 'The expense was not saved.'));
    }
    setFieldErrors({});
    setDescription('');
    setPesos('');
    setRecording(false);
    onResult({ type: 'success', title: 'Expense recorded', message: res.message ?? 'Expense recorded.' });
    reload();
  };

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    const { ok, data: res } = await api<{ message?: string }>('DELETE', `/reports/overheads/${encodeURIComponent(removing.expense_id)}`);
    setBusy(false);
    setRemoving(null);
    onResult(
      ok
        ? { type: 'success', title: 'Expense removed', message: res.message ?? 'Expense removed.' }
        : { type: 'error', title: 'Not removed', message: errorMessage(res, 'The expense was not removed.') }
    );
    reload();
  };

  return (
    <Card className="min-w-0">
      <CardHeader className="min-w-0">
        <CardTitle className="flex items-center gap-2 truncate">
          <ReceiptText className="size-4 shrink-0" aria-hidden /> Overhead expenses
        </CardTitle>
        <CardDescription className="truncate">Rent, electricity, wages and other running costs, for the profit and loss report.</CardDescription>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-4">
        <div className="grid min-w-0 grid-cols-2 gap-3">
          <Field id="overheads-from" label="From">
            <DateInput id="overheads-from" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field id="overheads-to" label="To">
            <DateInput id="overheads-to" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
        {error && <FormProblem message={error} />}
        {!data && !error && <Skeleton className="h-24 w-full" />}
        {data && (
          <>
            {data.source === 'local' && <p className="text-xs text-muted-foreground">Offline: showing the copy on this computer.</p>}
            {data.expenses.length === 0 ? (
              <p className="text-sm text-muted-foreground">No expenses recorded for these dates.</p>
            ) : (
              <div className="max-w-full min-w-0 overflow-x-auto rounded-md border">
                <Table className="table-fixed">
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="w-28 pl-3">Date</TableHead>
                      <TableHead>Expense</TableHead>
                      <TableHead className="w-32 text-right">Cost</TableHead>
                      <TableHead className={cn('pr-3', data.can_delete ? 'w-20' : 'w-12')}>
                        <span className="sr-only">Actions</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.expenses.map((x) => (
                      <TableRow key={x.expense_id}>
                        <TableCell className="pl-3">{formatDateTime(x.expense_date, { withTime: false })}</TableCell>
                        <TableCell>
                          <Cell className="font-medium" value={x.category} />
                          <Cell className="text-xs text-muted-foreground" value={`${x.description} · ${x.recorded_by_name}`} />
                          {x.sync_status !== 'synced' && (
                            <Badge title="Saved on this computer; it goes to the cloud when the connection is back" variant="outline" className={TONE_CLASSES.info.badge}>
                              Pending sync
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{peso(x.amount)}</TableCell>
                        <TableCell className="pr-3 text-right">
                          <div className="flex justify-end gap-0.5">
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => setViewing(x)}
                              aria-label={`View ${x.category}: ${x.description}`}
                              title="View the whole expense"
                            >
                              <Eye aria-hidden />
                            </Button>
                            {data.can_delete && x.can_delete && (
                              <Button title={`Remove ${x.category}: ${x.description}`} variant="ghost" size="icon-sm" onClick={() => setRemoving(x)} aria-label={`Remove ${x.category}: ${x.description}`}>
                                <Trash2 aria-hidden />
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
            <p className="flex flex-wrap justify-between gap-2 text-sm">
              <span className="text-muted-foreground">Total for these dates</span>
              <strong className="tabular-nums">{peso(data.total)}</strong>
            </p>

            <div className="flex justify-end">
              <Button onClick={() => setRecording(true)}>Record expense</Button>
            </div>
            <Dialog page open={recording} onOpenChange={(open) => !open && !busy && setRecording(false)}>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Record an expense</DialogTitle>
                  <DialogDescription>Rent, electricity, water, internet, wages and other running costs, for the profit and loss report.</DialogDescription>
                </DialogHeader>
            <form onSubmit={add} noValidate className="space-y-4" aria-label="Record an expense">
              <FormProblem message={problem} />
              <RequiredNote />
              <div className="grid min-w-0 gap-4 sm:grid-cols-2">
                <Field id="overhead-day" label="Date *" error={fieldErrors.expense_date}>
                  <DateInput id="overhead-day" required value={day} onChange={(e) => setDay(e.target.value)} disabled={busy} />
                </Field>
                <Field id="overhead-category" label="Category *" error={fieldErrors.category}>
                  <Select value={category} onValueChange={setCategory} disabled={busy}>
                    <SelectTrigger id="overhead-category" className="w-full max-w-full min-w-0 overflow-hidden">
                      <SelectValue placeholder="Choose…" />
                    </SelectTrigger>
                    <SelectContent>
                      {data.categories.map((c) => (
                        <SelectItem key={c} value={c}>
                          {c}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field id="overhead-description" label="Description *" error={fieldErrors.description} hint={`${description.length}/${EXPENSE_DESCRIPTION_MAX} characters`}>
                  <Input
                    id="overhead-description"
                    required
                    autoComplete="off"
                    maxLength={EXPENSE_DESCRIPTION_MAX}
                    placeholder="e.g. November rent"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    disabled={busy}
                  />
                </Field>
                <Field id="overhead-peso" label="Cost (₱) *" error={fieldErrors.amount}>
                  <Input
                    id="overhead-peso"
                    type="number"
                    min="0.01"
                    step="any"
                    max={MONEY_INPUT_MAX}
                    inputMode="decimal"
                    required
                    value={pesos}
                    onChange={(e) => setPesos(e.target.value)}
                    disabled={busy}
                  />
                </Field>
              </div>
              <div className="flex justify-end">
                <Button busy={busy} type="submit" disabled={busy}>
                  {busy ? 'Saving…' : 'Record expense'}
                </Button>
              </div>
            </form>
              </DialogContent>
            </Dialog>
          </>
        )}
      </CardContent>
      <Dialog page open={Boolean(viewing)} onOpenChange={(open) => !open && setViewing(null)}>
        <DialogContent className="min-w-0 sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Expense details</DialogTitle>
            <DialogDescription>Recorded for the profit and loss report.</DialogDescription>
          </DialogHeader>
          {viewing && (
            <dl className="grid min-w-0 grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">Date</dt>
              <dd>{formatDateTime(viewing.expense_date, { withTime: false })}</dd>
              <dt className="text-muted-foreground">Category</dt>
              <dd className="font-medium">{viewing.category}</dd>
              <dt className="text-muted-foreground">Description</dt>
              <dd className="min-w-0 whitespace-pre-wrap wrap-anywhere">{viewing.description}</dd>
              <dt className="text-muted-foreground">Cost</dt>
              <dd className="font-semibold tabular-nums">{peso(viewing.amount)}</dd>
              <dt className="text-muted-foreground">Recorded by</dt>
              <dd className="wrap-anywhere">{viewing.recorded_by_name}</dd>
            </dl>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setViewing(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={Boolean(removing)}
        title="Remove this expense?"
        message={removing ? `${removing.category}: ${removing.description} (${peso(removing.amount)}). The removal is kept in the audit trail.` : ''}
        confirmLabel="Remove expense"
        danger
        busy={busy}
        onConfirm={remove}
        onCancel={() => setRemoving(null)}
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// PB 22: the Owner's Profit & Loss "Magic Button"
// ---------------------------------------------------------------------------------------------
function Line({ label, value, strong, tone }: { label: string; value: number; strong?: boolean; tone?: 'success' | 'danger' }) {
  return (
    <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-2">
      <dt className={cn('min-w-0 wrap-anywhere', strong ? 'font-semibold' : 'text-muted-foreground')}>{label}</dt>
      <dd className={cn('tabular-nums', strong && 'font-semibold', tone && TONE_CLASSES[tone].text)}>{peso(value)}</dd>
    </div>
  );
}

export function PnlCard({ onResult }: { onResult: OnResult }) {
  const api = useApi();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [report, setReport] = useState<ProfitAndLoss | null>(null);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);

  const generate = async () => {
    setProblem('');
    setBusy(true);
    const { ok, data } = await api<ProfitAndLoss>('GET', `/reports/pnl${periodQuery(from, to)}`);
    setBusy(false);
    if (!ok || !data.period) {
      setProblem(errorMessage(data, 'The report could not be made.'));
      return;
    }
    setReport(data);
    setFrom(data.period.from);
    setTo(data.period.to);
  };

  const download = async () => {
    const r = await downloadFile(`/reports/export/pnl.csv${periodQuery(from, to)}`);
    onResult(
      r.ok
        ? { type: 'success', title: 'Download ready', message: `${r.name} was downloaded. Open it with Excel or Google Sheets.${r.offline ? '\nNote: made from the offline copy on this computer.' : ''}` }
        : { type: 'error', title: 'Download failed', message: r.message }
    );
  };

  const print = () => {
    if (report && !printPnlReport(report)) {
      onResult({ type: 'error', title: 'Could not open the print window', message: 'Allow pop-ups for this site, then try again.' });
    }
  };

  return (
    <Card className="min-w-0">
      <CardHeader className="min-w-0">
        <CardTitle className="flex items-center gap-2 truncate">
          <Sparkles className="size-4 shrink-0" aria-hidden /> Profit and loss
        </CardTitle>
        <CardDescription className="truncate">Income minus blanks, consumables, waste and overheads. Leave the dates empty for this month so far.</CardDescription>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-4">
        <div className="grid min-w-0 grid-cols-2 gap-3">
          <Field id="pnl-from" label="From">
            <DateInput id="pnl-from" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field id="pnl-to" label="To">
            <DateInput id="pnl-to" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button busy={busy} onClick={() => void generate()} disabled={busy}>
            <Sparkles aria-hidden /> {busy ? 'Calculating…' : 'Generate P&L'}
          </Button>
          <Button variant="outline" onClick={() => void download()} disabled={busy}>
            <Download aria-hidden /> Download P&amp;L (Excel)
          </Button>
          <Button variant="outline" onClick={print} disabled={!report}>
            <Printer aria-hidden /> Print P&amp;L statement
          </Button>
        </div>
        {problem && <FormProblem message={problem} />}

        {report && (
          <div className="flex min-w-0 flex-col gap-3" aria-live="polite">
            <p className="text-sm text-muted-foreground">
              {formatDateTime(report.period.from, { withTime: false })} to {formatDateTime(report.period.to, { withTime: false })} ·{' '}
              {report.counts.payments.toLocaleString()} payment(s), {report.counts.orders_completed.toLocaleString()} completed order(s),{' '}
              {report.counts.losses.toLocaleString()} loss(es)
            </p>
            <dl className="grid min-w-0 gap-1 text-sm">
              <Line label="Payments received (after voids)" value={report.gross_income} strong />
              {report.voids_in_period ? <Line label="Voided payments taken off" value={report.voids_in_period} /> : null}
              {report.discounts_given ? <Line label="Discounts given (already in the quotes)" value={report.discounts_given} /> : null}
            </dl>
            <dl className="grid min-w-0 gap-1 border-t pt-2 text-sm">
              <Line label="Blanks used (completed orders)" value={report.cogs_blanks} />
              <Line label="Consumables used" value={report.cogs_consumables} />
              <Line label="Cost of goods" value={report.total_cogs} strong />
            </dl>
            <dl className="grid min-w-0 gap-1 border-t pt-2 text-sm">
              {report.waste_by_category.map((w) => (
                <Line key={w.category} label={`Waste: ${w.category}`} value={w.amount} />
              ))}
              <Line label="Material waste" value={report.waste_cost} strong />
            </dl>
            <dl className="grid min-w-0 gap-1 border-t pt-2 text-sm">
              {report.overhead_by_category.map((o) => (
                <Line key={o.category} label={o.category} value={o.amount} />
              ))}
              <Line label="Overheads" value={report.overhead_cost} strong />
            </dl>
            <dl className="grid min-w-0 gap-1 border-t pt-2 text-sm">
              <Line label="Total expenses" value={report.total_expenses} strong />
            </dl>
            <p
              className={cn(
                'flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 font-semibold',
                TONE_CLASSES[report.profitable ? 'success' : 'danger'].banner
              )}
            >
              <span className="flex items-center gap-2">
                {report.profitable ? <TrendingUp className="size-4" aria-hidden /> : <TrendingDown className="size-4" aria-hidden />}
                {report.profitable ? 'Net profit' : 'Net loss'}
              </span>
              <span className="tabular-nums">{peso(report.net_profit)}</span>
            </p>
            {report.notes.map((n) => (
              <p key={n} className="text-xs text-muted-foreground">
                {n}
              </p>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
