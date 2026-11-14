'use client';

// PB 5: changes saved on this computer that clash with a newer change in the cloud, and that
// the sync could not settle by rank. An Owner / Admin picks which version to keep.
//   GET  /api/sync/conflicts                        -> { conflicts: [{ table, id, title, changed, keep_local_blocked_reason }] }
//   POST /api/sync/conflicts/:table/:id/resolve     { keep: 'cloud' | 'local' }
// The server names each record and what changed in plain words, says when "this computer's
// version" may not be kept, and records the decision. This screen only shows and sends.
import { useCallback, useEffect, useState } from 'react';
import { Cloud, HardDrive, TriangleAlert } from 'lucide-react';
import { ConfirmDialog } from '@/components/feedback/confirm-dialog';
import { ResultDialog, type ResultMessage } from '@/components/feedback/result-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/hooks/use-api';
import { errorMessage } from '@/lib/api';
import { TONE_CLASSES } from '@/lib/ui-tokens';
import { cn } from '@/lib/utils';

interface Conflict {
  table: string;
  id: string;
  title: string;
  changed: string[];
  keep_local_blocked_reason: string | null;
}

type Keep = 'cloud' | 'local';
type Loaded = { key: number; conflicts: Conflict[] | null; error: string };

const CONFIRM: Record<Keep, { title: string; label: string; message: string }> = {
  cloud: {
    title: 'Keep the cloud version?',
    label: 'Keep cloud version',
    message: 'The change made on this computer will be dropped. This cannot be undone. A record of the dropped change is kept.',
  },
  local: {
    title: 'Keep this computer’s version?',
    label: 'Keep this computer’s version',
    message: 'The change made on this computer will replace what is in the cloud now, for every branch. A record of the replaced values is kept.',
  },
};

export function ConflictsDialog({
  open,
  onClose,
  onResolved,
}: {
  open: boolean;
  onClose: () => void;
  /** a conflict was settled: counts and lists elsewhere should refresh */
  onResolved: () => void;
}) {
  const api = useApi();
  const [tick, setTick] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [choice, setChoice] = useState<{ conflict: Conflict; keep: Keep } | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ResultMessage | null>(null);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    api<{ conflicts?: Conflict[] }>('GET', '/sync/conflicts').then(({ ok, data }) => {
      if (cancelled) return;
      setLoaded(
        ok
          ? { key: tick, conflicts: Array.isArray(data.conflicts) ? data.conflicts : [], error: '' }
          : { key: tick, conflicts: null, error: errorMessage(data, 'Could not load the changes that need a decision.') }
      );
    });
    return () => {
      cancelled = true;
    };
  }, [api, open, tick]);

  const conflicts = loaded?.conflicts ?? null;
  const loading = open && (!loaded || loaded.key !== tick);

  const resolve = async () => {
    if (!choice) return;
    const { conflict, keep } = choice;
    setBusy(true);
    const { ok, data } = await api<{ message?: string }>(
      'POST',
      `/sync/conflicts/${encodeURIComponent(conflict.table)}/${encodeURIComponent(conflict.id)}/resolve`,
      { keep }
    );
    setBusy(false);
    setChoice(null);
    setResult(
      ok
        ? { type: 'success', title: 'Decision saved', message: `${conflict.title}\n${data.message ?? 'The conflict was settled.'}` }
        : { type: 'error', title: 'Not settled', message: errorMessage(data, 'This conflict could not be settled. Please try again.') }
    );
    reload();
    onResolved();
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => !next && !busy && onClose()}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <TriangleAlert className={cn('size-5 shrink-0', TONE_CLASSES.warning.text)} aria-hidden />
              Changes that need a decision
            </DialogTitle>
            <DialogDescription>
              These were changed on this computer while offline, and by someone else online. Choose which version to keep for each one.
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-[60vh] min-w-0 space-y-3 overflow-y-auto" aria-busy={loading}>
            {loaded?.error && (
              <p role="alert" className={cn('rounded-md border p-3 text-sm', TONE_CLASSES.danger.banner)}>
                {loaded.error}
              </p>
            )}
            {!conflicts && !loaded?.error && (
              <div className="space-y-2" role="status" aria-label="Loading">
                <Skeleton className="h-20 w-full" />
                <Skeleton className="h-20 w-full" />
              </div>
            )}
            {conflicts?.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">Nothing is waiting for a decision.</p>}
            {conflicts?.map((c) => (
              <section key={`${c.table}:${c.id}`} className="space-y-2 rounded-md border bg-card p-3" aria-label={c.title}>
                <h3 className="font-semibold wrap-anywhere">{c.title}</h3>
                <p className="text-sm text-muted-foreground wrap-anywhere">
                  {c.changed.length > 0 ? `Changed on this computer: ${c.changed.join(', ')}.` : 'Several details were changed on this computer.'}
                </p>
                {c.keep_local_blocked_reason && <p className="text-xs text-muted-foreground wrap-anywhere">{c.keep_local_blocked_reason}</p>}
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => setChoice({ conflict: c, keep: 'cloud' })}>
                    <Cloud aria-hidden /> Keep cloud version
                  </Button>
                  {!c.keep_local_blocked_reason && (
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => setChoice({ conflict: c, keep: 'local' })}>
                      <HardDrive aria-hidden /> Keep this computer’s version
                    </Button>
                  )}
                </div>
              </section>
            ))}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={busy}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(choice)}
        title={choice ? CONFIRM[choice.keep].title : ''}
        message={choice ? `${choice.conflict.title}\n${CONFIRM[choice.keep].message}` : ''}
        confirmLabel={choice ? CONFIRM[choice.keep].label : ''}
        danger={choice?.keep === 'cloud'}
        busy={busy}
        onConfirm={resolve}
        onCancel={() => setChoice(null)}
      />
      <ResultDialog result={result} onClose={() => setResult(null)} />
    </>
  );
}
