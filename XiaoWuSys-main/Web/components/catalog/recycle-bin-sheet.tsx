'use client';

// Recycle Bin (ported from RecycleBin.jsx), opened from the Catalog as a side sheet.
// Items deleted from the catalog wait here and can be restored. Permanent delete is the only
// way out (Owner/Admin: canPurgeInventory); the backend keeps a hidden trace. Paged on the
// server, and "Empty" runs in bounded server batches.
import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import { formatDateTime } from '@xiaowu/client-core/format';
import { FormProblem } from '@/components/forms/form-bits';
import { ConfirmDialog } from '@/components/feedback/confirm-dialog';
import type { ResultMessage } from '@/components/feedback/result-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/hooks/use-api';
import { errorMessage } from '@/lib/api';
import type { RecycleBinPage } from '@/lib/inventory';
import { TONE_CLASSES } from '@/lib/ui-tokens';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 20;

type Loaded = { key: string; page: RecycleBinPage | null; error: string };

export function RecycleBinSheet({
  open,
  onOpenChange,
  canPurge,
  refreshKey,
  onResult,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canPurge: boolean;
  /** changes whenever the catalog changes anywhere, so the bin reloads too */
  refreshKey: string;
  onResult: (result: ResultMessage) => void;
}) {
  const api = useApi();
  const [pageNo, setPageNo] = useState(0);
  const [tick, setTick] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ kind: 'purge'; id: string; name: string } | { kind: 'empty' } | null>(null);
  const [emptying, setEmptying] = useState<{ done: number; remaining: number } | null>(null);

  const requestKey = `${pageNo}:${tick}:${refreshKey}`;
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    api<RecycleBinPage>('GET', `/inventory/recycle-bin?limit=${PAGE_SIZE}&offset=${pageNo * PAGE_SIZE}`).then(({ ok, data }) => {
      if (cancelled) return;
      if (!ok) {
        setLoaded({ key: requestKey, page: null, error: errorMessage(data, 'Could not load the Recycle Bin.') });
        return;
      }
      const items = Array.isArray(data.items) ? data.items : [];
      // This page was emptied by a restore or delete: step back one
      if (items.length === 0 && pageNo > 0 && data.total > 0) setPageNo((p) => Math.max(0, p - 1));
      setLoaded({ key: requestKey, page: { ...data, items }, error: '' });
    });
    return () => {
      cancelled = true;
    };
  }, [api, open, pageNo, requestKey]);

  const loading = !loaded || loaded.key !== requestKey;
  const page = loaded?.page ?? null;
  const total = page?.total ?? 0;
  const offline = page?.source === 'local';
  const working = busyId !== null || emptying !== null;
  const hasNext = (pageNo + 1) * PAGE_SIZE < total;

  const restore = async (id: string) => {
    setBusyId(id);
    const { ok, data } = await api<{ message?: string }>('POST', `/inventory/${encodeURIComponent(id)}/restore`);
    setBusyId(null);
    onResult(
      ok
        ? { type: 'success', title: 'Item restored', message: data.message ?? 'The item is back in the catalog.' }
        : { type: 'error', title: 'Could not restore', message: errorMessage(data, 'Restore failed.') }
    );
    reload();
  };

  const purge = async (id: string) => {
    setBusyId(id);
    const { ok, data } = await api<{ message?: string }>('DELETE', `/inventory/${encodeURIComponent(id)}/permanent`);
    setBusyId(null);
    setConfirm(null);
    onResult(
      ok
        ? { type: 'success', title: 'Permanently deleted', message: data.message ?? 'The item was deleted.' }
        : { type: 'error', title: 'Could not delete', message: errorMessage(data, 'Permanent delete failed.') }
    );
    reload();
  };

  // Calls the bounded server batch until the bin is empty
  const emptyBin = async () => {
    setConfirm(null);
    let done = 0;
    setEmptying({ done: 0, remaining: total });
    for (let round = 0; round < 1000; round++) {
      const { ok, data } = await api<{ purged_count?: number; remaining?: number }>('POST', '/inventory/recycle-bin/empty');
      if (!ok) {
        setEmptying(null);
        onResult({
          type: 'error',
          title: 'Could not empty the Recycle Bin',
          message: errorMessage(data, 'Empty failed.') + (done ? `\n${done} item(s) were deleted before the error.` : ''),
        });
        reload();
        return;
      }
      done += data.purged_count ?? 0;
      setEmptying({ done, remaining: data.remaining ?? 0 });
      if (!data.remaining || !data.purged_count) break;
    }
    setEmptying(null);
    setPageNo(0);
    onResult({
      type: 'success',
      title: 'Recycle Bin emptied',
      message: `${done} item(s) permanently deleted. A record of each one is kept in the backend.`,
    });
    reload();
  };

  return (
    <Sheet open={open} onOpenChange={(next) => !emptying && onOpenChange(next)}>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-xl">
        <SheetHeader className="border-b">
          <SheetTitle className="flex items-center gap-2">
            <Trash2 className="size-5" aria-hidden /> Recycle Bin
          </SheetTitle>
          <SheetDescription>
            {total} item{total === 1 ? '' : 's'} · restore anything deleted by mistake. Items are permanently removed
            automatically after {page?.retention_days ?? 30} days.
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-wrap gap-2 border-b px-4 py-3">
          <Button variant="outline" size="sm" onClick={reload} disabled={loading || working}>
            <RefreshCw aria-hidden /> Refresh
          </Button>
          {canPurge && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setConfirm({ kind: 'empty' })}
              disabled={total === 0 || working || offline}
            >
              <Trash2 aria-hidden /> Empty Recycle Bin
            </Button>
          )}
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4" aria-busy={loading}>
          {offline && (
            <p className={cn('rounded-md border p-3 text-sm', TONE_CLASSES.warning.banner)}>
              Offline: you can restore items, but permanent delete needs an internet connection.
            </p>
          )}
          {emptying && (
            <p className={cn('rounded-md border p-3 text-sm', TONE_CLASSES.info.banner)} role="status">
              Deleting permanently… {emptying.done} done, {emptying.remaining} left.
            </p>
          )}
          {loaded?.error && <FormProblem message={loaded.error} />}

          {loading && !page &&
            Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-16 w-full" />)}

          {!loading && page && page.items.length === 0 && (
            <p className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">The Recycle Bin is empty.</p>
          )}

          {page?.items.map((item) => (
            <div key={item.inventory_id} className="flex flex-wrap items-center gap-3 rounded-md border bg-card p-3">
              <div className="min-w-0 flex-1">
                <p className="font-medium wrap-anywhere">{item.item_name}</p>
                <p className="text-xs text-muted-foreground">
                  {item.item_category} · {item.quantity_available.toLocaleString()} in stock · deleted{' '}
                  {formatDateTime(item.deleted_at, { utc: true })}
                  {item.sync_status !== 'synced' && (
                    <Badge variant="outline" className={cn('ml-2', TONE_CLASSES.info.badge)}>
                      Pending sync
                    </Badge>
                  )}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button size="sm" variant="secondary" onClick={() => restore(item.inventory_id)} disabled={working}>
                  <RotateCcw aria-hidden /> {busyId === item.inventory_id ? 'Restoring…' : 'Restore'}
                </Button>
                {canPurge && (
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => setConfirm({ kind: 'purge', id: item.inventory_id, name: item.item_name })}
                    disabled={working || offline}
                  >
                    <Trash2 aria-hidden /> Delete forever
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>

        {(pageNo > 0 || hasNext) && page && (
          <div className="flex items-center justify-between gap-2 border-t px-4 py-3 text-sm text-muted-foreground">
            <Button variant="outline" size="sm" onClick={() => setPageNo((p) => Math.max(0, p - 1))} disabled={pageNo === 0 || loading}>
              <ChevronLeft aria-hidden /> Prev
            </Button>
            <span>
              {page.offset + 1}–{page.offset + page.items.length} of {total}
            </span>
            <Button variant="outline" size="sm" onClick={() => setPageNo((p) => p + 1)} disabled={!hasNext || loading}>
              Next <ChevronRight aria-hidden />
            </Button>
          </div>
        )}
      </SheetContent>

      <ConfirmDialog
        open={confirm?.kind === 'purge'}
        title="Delete permanently?"
        message={
          confirm?.kind === 'purge'
            ? `"${confirm.name}" will be removed from the Recycle Bin for good and cannot be restored from the website.`
            : ''
        }
        confirmLabel="Delete forever"
        danger
        busy={busyId !== null}
        onConfirm={() => confirm?.kind === 'purge' && purge(confirm.id)}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm?.kind === 'empty'}
        title="Empty the Recycle Bin?"
        message={`All ${total} item(s) in the Recycle Bin will be permanently deleted. This cannot be undone from the website.`}
        confirmLabel="Empty Recycle Bin"
        danger
        onConfirm={emptyBin}
        onCancel={() => setConfirm(null)}
      />
    </Sheet>
  );
}
