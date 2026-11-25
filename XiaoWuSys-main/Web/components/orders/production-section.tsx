'use client';

// Production progress per item (migration 017). How many pieces of each item are printed, and
// pressed for the items that need the heat press (T-shirts). A piece is READY when it is printed
// (and pressed where needed); only ready pieces can be handed over, the order moves to Pressing
// once everything is printed and to Ready once everything is ready. The server keeps the rules
// (POST /api/orders/:id/progress, detail.progress, allowed_actions.update_progress).
import { useState } from 'react';
import { Flame, Printer, Save } from 'lucide-react';
import type { OrderActions } from '@xiaowu/client-core/permissions';
import type { ResultMessage } from '@/components/feedback/result-dialog';
import { bannerText, FormProblem } from '@/components/forms/form-bits';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useApi } from '@/hooks/use-api';
import type { OrderDetail, ProgressLine } from '@/lib/orders';
import { TONE_CLASSES } from '@/lib/ui-tokens';
import { cn } from '@/lib/utils';

type OnResult = (result: ResultMessage, reload: boolean) => void;
type Counts = Record<string, { printed: string; pressed: string }>;

const countsOf = (lines: ProgressLine[]): Counts =>
  Object.fromEntries(lines.map((l) => [l.line_item_id, { printed: String(l.printed), pressed: String(l.pressed) }]));

export function ProductionSection({ detail, actions, onResult }: { detail: OrderDetail; actions: OrderActions; onResult: OnResult }) {
  const api = useApi();
  const progress = detail.progress;
  const [editing, setEditing] = useState(false);
  const [counts, setCounts] = useState<Counts>(() => countsOf(progress?.lines ?? []));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  if (!progress || progress.lines.length === 0) return null;
  const started = ['Printing', 'Pressing', 'Ready', 'Completed'].includes(detail.order.production_status);
  if (!started && !actions.update_progress) return null;

  const set = (id: string, key: 'printed' | 'pressed', value: string) =>
    setCounts((c) => ({ ...c, [id]: { ...c[id], [key]: value } }));
  const fill = (key: 'printed' | 'pressed') =>
    setCounts((c) => Object.fromEntries(progress.lines.map((l) => [
      l.line_item_id,
      { ...c[l.line_item_id], [key]: key === 'pressed' && !l.needs_pressing ? '0' : String(l.quantity), ...(key === 'pressed' ? { printed: String(l.quantity) } : {}) },
    ])));

  const save = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setProblem('');
    const lines = [];
    for (const l of progress.lines) {
      const printed = Number(counts[l.line_item_id]?.printed ?? l.printed);
      const pressed = Number(counts[l.line_item_id]?.pressed ?? l.pressed);
      if (!Number.isInteger(printed) || printed < 0 || (l.needs_pressing && (!Number.isInteger(pressed) || pressed < 0))) {
        setProblem(`${l.product_type}: the counts must be whole numbers, 0 or more.`);
        return;
      }
      lines.push({ line_item_id: l.line_item_id, printed, ...(l.needs_pressing ? { pressed } : {}) });
    }
    setBusy(true);
    const { ok, data } = await api<{ message?: string }>('POST', `/orders/${encodeURIComponent(detail.order.order_id)}/progress`, { lines });
    setBusy(false);
    if (!ok) {
      setProblem(bannerText(data, [], 'The counts were not saved.'));
      return;
    }
    setEditing(false);
    onResult({ type: 'success', title: 'Production progress saved', message: data.message ?? 'Saved.' }, true);
  };

  return (
    <section className="space-y-3" aria-labelledby="production-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="production-title" className="flex items-center gap-2 font-semibold">
          <Printer className="size-4 text-muted-foreground" aria-hidden /> Production progress
        </h3>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge variant="outline">{progress.printed} of {progress.pieces} printed</Badge>
          {progress.needs_pressing && <Badge variant="outline">{progress.pressed} of {progress.press_pieces} pressed</Badge>}
          <Badge variant="outline" className={cn(progress.all_ready && TONE_CLASSES.success.badge)}>{progress.ready} ready</Badge>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        A piece is ready once it is printed{progress.needs_pressing ? ', and pressed for the items marked “Pressed”' : ''}. Only ready pieces can be handed over.
        {progress.needs_pressing
          ? ' The order goes to Pressing once everything is printed, and to Ready once everything is pressed.'
          : ' The order goes to Ready once everything is printed.'}
      </p>
      <form onSubmit={save} className="space-y-3">
        <FormProblem message={problem} />
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead className="text-right">Ordered</TableHead>
                <TableHead className="text-right">Printed</TableHead>
                <TableHead className="text-right">Pressed</TableHead>
                <TableHead className="text-right">Ready</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {progress.lines.map((l) => (
                <TableRow key={l.line_item_id}>
                  <TableCell className="min-w-0 wrap-anywhere">
                    {l.product_type}
                    {l.needs_pressing && (
                      <span className="ml-2 inline-flex items-center gap-1 text-xs text-muted-foreground">
                        <Flame className="size-3" aria-hidden /> pressed
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{l.quantity}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {editing ? (
                      <Input
                        aria-label={`${l.product_type}: printed`}
                        type="number"
                        min={0}
                        max={l.quantity}
                        step={1}
                        inputMode="numeric"
                        className="ml-auto h-8 w-24 text-right"
                        value={counts[l.line_item_id]?.printed ?? ''}
                        onChange={(e) => set(l.line_item_id, 'printed', e.target.value)}
                      />
                    ) : (
                      l.printed
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {!l.needs_pressing ? (
                      <span className="text-muted-foreground">not pressed</span>
                    ) : editing ? (
                      <Input
                        aria-label={`${l.product_type}: pressed`}
                        type="number"
                        min={0}
                        max={l.quantity}
                        step={1}
                        inputMode="numeric"
                        className="ml-auto h-8 w-24 text-right"
                        value={counts[l.line_item_id]?.pressed ?? ''}
                        onChange={(e) => set(l.line_item_id, 'pressed', e.target.value)}
                      />
                    ) : (
                      l.pressed
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{l.ready}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        {actions.update_progress && (
          <div className="flex flex-wrap justify-end gap-2">
            {!editing ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setCounts(countsOf(progress.lines));
                  setEditing(true);
                }}
              >
                <Printer aria-hidden /> Record printed / pressed pieces
              </Button>
            ) : (
              <>
                <Button type="button" variant="ghost" size="sm" onClick={() => fill('printed')} disabled={busy}>
                  All printed
                </Button>
                {progress.needs_pressing && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => fill('pressed')} disabled={busy}>
                    All pressed
                  </Button>
                )}
                <Button type="button" variant="outline" size="sm" onClick={() => setEditing(false)} disabled={busy}>
                  Cancel
                </Button>
                <Button type="submit" size="sm" busy={busy} disabled={busy}>
                  <Save aria-hidden /> {busy ? 'Saving…' : 'Save counts'}
                </Button>
              </>
            )}
          </div>
        )}
      </form>
    </section>
  );
}
