'use client';

// Catalog / inventory screen (ported from InventoryCatalog.jsx).
//
// Who sees what (capabilities from the server, never role names; see lib/inventory.ts):
//   everyone          table, search, filters, export, refresh
//   canEditInventory  add, edit, adjust stock / record loss, import, move to Recycle Bin, restore
//   canPurgeInventory delete forever, empty the Recycle Bin
// Search, filters, sorting and "Show more" work on the loaded snapshot, as in the MVP.
import { useMemo, useState } from 'react';
import { CloudOff, Download, FileUp, PackagePlus, RefreshCw, Search, SlidersHorizontal, Trash2, X } from 'lucide-react';
import { formatDateTime, peso } from '@xiaowu/client-core/format';
import { ConsumableRatesDialog } from '@/components/catalog/consumable-rates-dialog';
import { ImportDialog } from '@/components/catalog/import-dialog';
import { InventoryTable, nextSort, sortItems, type SortKey, type SortState } from '@/components/catalog/inventory-table';
import { ItemFormDialog } from '@/components/catalog/item-form-dialog';
import { RecycleBinSheet } from '@/components/catalog/recycle-bin-sheet';
import { StockDialog, type StockAction } from '@/components/catalog/stock-dialog';
import { ConfirmDialog } from '@/components/feedback/confirm-dialog';
import { ResultDialog, type ResultMessage } from '@/components/feedback/result-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { BoundedSelectContent, BoundedSelectItem, BoundedSelectTrigger } from '@/components/forms/bounded-select';
import { useInventorySnapshot } from '@/hooks/use-inventory-snapshot';
import { useApi } from '@/hooks/use-api';
import { useSession } from '@/hooks/use-session';
import { downloadFile, errorMessage } from '@/lib/api';
import { canEditInventory, canPurgeInventory, type InventoryItem } from '@/lib/inventory';
import { STOCK_STATUS, TONE_CLASSES, type Tone } from '@/lib/ui-tokens';
import { cn } from '@/lib/utils';
import { TEXT_MAX } from '@/lib/input-limits';

const LIST_PAGE = 50;
const ALL = 'all';

// Summary figures: wrap anywhere (a ₱90-trillion value breaks onto two lines instead of
// spilling out of its card), a size that steps down on narrow cards, tight line height.
const SUMMARY_NUMBER =
  'w-full text-xl leading-tight font-semibold tabular-nums wrap-anywhere sm:text-2xl lg:text-xl xl:text-2xl';
type DialogState =
  | { kind: 'item'; item: InventoryItem | null }
  | { kind: 'stock'; itemId: string | null; action: StockAction }
  | { kind: 'import' }
  | { kind: 'rates'; item: InventoryItem }
  | null;

const LIVE = {
  live: { dot: 'bg-success', text: 'Live' },
  connecting: { dot: 'bg-warning', text: 'Connecting…' },
  disconnected: { dot: 'bg-muted-foreground', text: 'Not live · refreshing every 30 s' },
} as const;

export function CatalogScreen() {
  const api = useApi();
  const { user } = useSession();
  const canEdit = canEditInventory(user);
  const canPurge = canPurgeInventory(user);
  const { snapshot, loading, error, refresh, liveStatus, cloudListening, recentlyChanged } = useInventorySnapshot();

  const [search, setSearch] = useState('');
  const [category, setCategory] = useState(ALL);
  const [status, setStatus] = useState(ALL);
  const [sort, setSort] = useState<SortState>({ key: 'name', dir: 1 });
  const [paging, setPaging] = useState({ key: '', shown: LIST_PAGE });

  const [dialog, setDialog] = useState<DialogState>(null);
  const [toDelete, setToDelete] = useState<InventoryItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [binOpen, setBinOpen] = useState(false);
  const [result, setResult] = useState<ResultMessage | null>(null);

  const items = useMemo(() => snapshot?.items ?? [], [snapshot]);
  const summary = snapshot?.summary;
  const categories = snapshot?.categories ?? [];

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const filtered = items.filter(
      (item) =>
        (!needle || item.item_name.toLowerCase().includes(needle)) &&
        (category === ALL || item.item_category === category) &&
        (status === ALL || item.stock_status === status)
    );
    return sortItems(filtered, sort);
  }, [items, search, category, status, sort]);

  // "Show more" starts over whenever the filters or the sort change
  const filterKey = `${search}|${category}|${status}|${sort.key}|${sort.dir}`;
  const shown = paging.key === filterKey ? paging.shown : LIST_PAGE;
  const showMore = () => setPaging({ key: filterKey, shown: shown + LIST_PAGE });

  const filtersActive = Boolean(search) || category !== ALL || status !== ALL;
  const clearFilters = () => {
    setSearch('');
    setCategory(ALL);
    setStatus(ALL);
  };

  // A finished dialog: show the outcome and reload (the socket usually beats us to it)
  const finish = (r: ResultMessage) => {
    setDialog(null);
    setResult(r);
    if (r.type !== 'error') refresh();
  };

  const moveToBin = async () => {
    if (!toDelete) return;
    setDeleting(true);
    const { ok, data } = await api<{ message?: string }>('DELETE', `/inventory/${encodeURIComponent(toDelete.inventory_id)}`);
    setDeleting(false);
    setToDelete(null);
    setResult(
      ok
        ? { type: 'success', title: 'Moved to Recycle Bin', message: data.message ?? 'The item was moved to the Recycle Bin.' }
        : { type: 'error', title: 'Not deleted', message: errorMessage(data, 'Could not delete the item.') }
    );
    if (ok) refresh();
  };

  const exportCsv = async () => {
    const r = await downloadFile('/reports/export/inventory.csv');
    setResult(
      r.ok
        ? {
            type: 'success',
            title: 'Download ready',
            message:
              `${r.name} was downloaded. Open it with Excel or Google Sheets.` +
              (r.offline ? '\nThe system is offline: the file shows the copy saved on this computer.' : ''),
          }
        : { type: 'error', title: 'Download failed', message: r.message }
    );
  };

  const live = LIVE[liveStatus];
  const binCount = summary?.recycle_bin ?? 0;

  // "N units on hand" is summary.total_units from the server (nothing is added up here)
  const unitsOnHand = summary?.total_units === undefined ? undefined : `${summary.total_units.toLocaleString()} units on hand`;
  const cards: { key: string; label: string; value: number | undefined; tone: Tone; sub?: string }[] = [
    { key: ALL, label: 'Total items', value: summary?.total_items, tone: 'info', sub: unitsOnHand },
    { key: 'in_stock', label: 'In stock', value: summary?.in_stock, tone: 'success' },
    { key: 'low_stock', label: 'Low stock', value: summary?.low_stock, tone: 'warning' },
    { key: 'out_of_stock', label: 'Out of stock', value: summary?.out_of_stock, tone: 'danger' },
  ];

  return (
    <div className="space-y-6">
      {/* Title, freshness, actions */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Catalog</h1>
          <p className="flex flex-wrap items-center gap-x-1.5 text-sm text-muted-foreground">
            <span className={cn('inline-block size-2 rounded-full', live.dot)} aria-hidden />
            <span className="font-medium text-foreground">{live.text}</span>
            {liveStatus === 'live' && !cloudListening && <span>(this server only)</span>}
            {snapshot?.fetched_at && <span>· Last updated {formatDateTime(snapshot.fetched_at)}</span>}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canEdit && (
            <>
              <Button onClick={() => setDialog({ kind: 'item', item: null })}>
                <PackagePlus aria-hidden /> Add item
              </Button>
              <Button variant="outline" onClick={() => setDialog({ kind: 'stock', itemId: null, action: 'add' })} disabled={items.length === 0}>
                <SlidersHorizontal aria-hidden /> Adjust stock
              </Button>
              <Button variant="outline" onClick={() => setDialog({ kind: 'import' })}>
                <FileUp aria-hidden /> Import
              </Button>
              <Button variant="outline" onClick={() => setBinOpen(true)} aria-label={`Recycle Bin, ${binCount} items`}>
                <Trash2 aria-hidden /> Recycle Bin
                {binCount > 0 && <Badge variant="secondary">{binCount}</Badge>}
              </Button>
            </>
          )}
          <Button variant="outline" onClick={exportCsv}>
            <Download aria-hidden /> Export to Excel
          </Button>
          <Button variant="outline" onClick={refresh} disabled={loading} aria-label="Refresh the catalog">
            <RefreshCw className={cn(loading && 'animate-spin')} aria-hidden /> {loading ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>
      </div>

      {snapshot?.source === 'local' && (
        <p className={cn('flex items-center gap-2 rounded-md border p-3 text-sm', TONE_CLASSES.warning.banner)}>
          <CloudOff className="size-4 shrink-0" aria-hidden />
          Offline mode: showing the copy saved on this computer. Numbers may lag behind other branches until the next sync.
        </p>
      )}
      {error && (
        <p role="alert" className={cn('rounded-md border p-3 text-sm', TONE_CLASSES.danger.banner)}>
          {error}
        </p>
      )}

      {/* Summary: the counts double as status filters */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {cards.map((card) => (
          <button
            key={card.key}
            type="button"
            onClick={() => setStatus(card.key)}
            aria-pressed={status === card.key}
            className={cn(
              // min-w-0: a grid item may shrink below its content, so a huge number can't widen the row
              'flex min-w-0 flex-col items-start gap-1 rounded-lg border bg-card p-4 text-left transition-colors hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
              status === card.key && 'border-primary ring-1 ring-primary'
            )}
          >
            <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{card.label}</span>
            {card.value === undefined ? (
              <Skeleton className="h-8 w-12" />
            ) : (
              <span
                title={card.value.toLocaleString()}
                className={cn(SUMMARY_NUMBER, TONE_CLASSES[card.tone].text)}
              >
                {card.value.toLocaleString()}
              </span>
            )}
            {card.sub && <span className="max-w-full truncate text-xs text-muted-foreground" title={card.sub}>{card.sub}</span>}
          </button>
        ))}
        <div className="col-span-2 flex min-w-0 flex-col items-start gap-1 rounded-lg border bg-card p-4 sm:col-span-1">
          <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Stock value</span>
          {summary ? (
            <span title={peso(summary.stock_value)} className={SUMMARY_NUMBER}>
              {peso(summary.stock_value)}
            </span>
          ) : (
            <Skeleton className="h-8 w-28" />
          )}
          <span className="text-xs text-muted-foreground">whole catalog, at unit cost</span>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-[2_1_14rem]">
          <Search className="pointer-events-none absolute inset-y-0 left-2.5 my-auto size-4 text-muted-foreground" aria-hidden />
          <Input
            type="search"
            maxLength={TEXT_MAX.search}
            placeholder="Search materials…"
            aria-label="Search materials"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="bg-card pl-8"
          />
        </div>
        <Select value={category} onValueChange={setCategory}>
          <BoundedSelectTrigger className="flex-[1_1_10rem] bg-card" aria-label="Filter by category">
            <SelectValue />
          </BoundedSelectTrigger>
          <BoundedSelectContent>
            <SelectItem value={ALL}>All categories</SelectItem>
            {categories.map((c) => (
              <BoundedSelectItem key={c} value={c} label={c}>
                {c}
              </BoundedSelectItem>
            ))}
          </BoundedSelectContent>
        </Select>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="flex-[1_1_10rem] bg-card" aria-label="Filter by stock status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All statuses</SelectItem>
            {Object.entries(STOCK_STATUS).map(([key, look]) => (
              <SelectItem key={key} value={key}>
                {look.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {filtersActive && (
          <Button variant="ghost" onClick={clearFilters}>
            <X aria-hidden /> Clear filters
          </Button>
        )}
      </div>

      {/* Items */}
      <section className="space-y-3" aria-busy={loading}>
        <h2 className="text-base font-semibold">
          Stock items{' '}
          {snapshot && (
            <span className="font-normal text-muted-foreground">
              ({visible.length.toLocaleString()}
              {visible.length !== items.length && ` of ${items.length.toLocaleString()}`})
            </span>
          )}
        </h2>

        {!snapshot && loading && (
          <div className="space-y-2 rounded-lg border bg-card p-4" role="status" aria-label="Loading the catalog">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        )}

        {snapshot && items.length === 0 && (
          <p className="rounded-lg border border-dashed bg-card p-8 text-center text-sm text-muted-foreground">
            No items in the catalog yet.{' '}
            {canEdit ? 'Click "Add item" or "Import" to add the first ones.' : 'Items added by the people who manage the catalog will appear here.'}
          </p>
        )}
        {items.length > 0 && visible.length === 0 && (
          <p className="rounded-lg border border-dashed bg-card p-8 text-center text-sm text-muted-foreground">No items match these filters.</p>
        )}

        {visible.length > 0 && (
          <>
            <InventoryTable
              rows={visible.slice(0, shown)}
              sort={sort}
              onSort={(key: SortKey) => setSort((prev) => nextSort(prev, key))}
              canEdit={canEdit}
              recentlyChanged={recentlyChanged}
              onEdit={(item) => setDialog({ kind: 'item', item })}
              onAdjust={(item, action) => setDialog({ kind: 'stock', itemId: item.inventory_id, action })}
              onDelete={setToDelete}
              onRates={(item) => setDialog({ kind: 'rates', item })}
            />
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
              <span>
                Showing {Math.min(shown, visible.length).toLocaleString()} of {visible.length.toLocaleString()}
              </span>
              {shown < visible.length && (
                <Button variant="outline" size="sm" onClick={showMore}>
                  Show {Math.min(LIST_PAGE, visible.length - shown)} more
                </Button>
              )}
            </div>
          </>
        )}
      </section>

      {/* Dialogs (mounted only while open, so each one starts with a fresh form) */}
      {canEdit && dialog?.kind === 'item' && (
        <ItemFormDialog item={dialog.item} categories={categories} onClose={() => setDialog(null)} onDone={finish} />
      )}
      {canEdit && dialog?.kind === 'stock' && (
        <StockDialog
          items={items}
          initialItemId={dialog.itemId}
          initialAction={dialog.action}
          onClose={() => setDialog(null)}
          onDone={finish}
        />
      )}
      {canEdit && dialog?.kind === 'import' && <ImportDialog onClose={() => setDialog(null)} onDone={finish} />}
      {canEdit && dialog?.kind === 'rates' && <ConsumableRatesDialog item={dialog.item} onClose={() => setDialog(null)} onDone={finish} />}

      <ConfirmDialog
        open={Boolean(toDelete)}
        title="Move to Recycle Bin?"
        message={
          toDelete
            ? `"${toDelete.item_name}" will be removed from the catalog and kept in the Recycle Bin, where you can restore it at any time.`
            : ''
        }
        confirmLabel="Move to Recycle Bin"
        danger
        busy={deleting}
        onConfirm={moveToBin}
        onCancel={() => setToDelete(null)}
      />

      {canEdit && (
        <RecycleBinSheet
          open={binOpen}
          onOpenChange={setBinOpen}
          canPurge={canPurge}
          refreshKey={`${binCount}:${snapshot?.fetched_at ?? ''}`}
          onResult={(r) => {
            setResult(r);
            refresh();
          }}
        />
      )}

      <ResultDialog result={result} onClose={() => setResult(null)} />
    </div>
  );
}
