'use client';

// The stock table. Every number and status in it comes from the server
// (quantity_available_net and stock_status are computed in services/inventorySnapshot.js);
// this component only sorts, formats and shows them.
//
// Not ported from the MVP on purpose (rules guard: no-rule-math): the per-row "Stock value"
// column (on hand x unit cost) and the totals footer. They need fields from the API first;
// the whole-catalog stock value comes from summary.stock_value instead.
import { ArrowDown, ArrowUp, ArrowUpDown, Minus, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { peso } from '@xiaowu/client-core/format';
import type { StockAction } from '@/components/catalog/stock-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { InventoryItem } from '@/lib/inventory';
import { lookFor, STOCK_STATUS, TONE_CLASSES, TONE_EDGE } from '@/lib/ui-tokens';
import { cn } from '@/lib/utils';

export type SortKey = 'name' | 'category' | 'status' | 'on_hand' | 'held' | 'free' | 'threshold' | 'unit_cost';
export interface SortState {
  key: SortKey;
  dir: 1 | -1;
}

// Presentation only: orders rows the user is looking at.
const cmpNum = (x: number, y: number) => (x < y ? -1 : x > y ? 1 : 0);
const byName = (a: InventoryItem, b: InventoryItem) => a.item_name.localeCompare(b.item_name);
const STATUS_ORDER: Record<string, number> = { out_of_stock: 0, low_stock: 1, in_stock: 2 };
const SORTERS: Record<SortKey, (a: InventoryItem, b: InventoryItem) => number> = {
  name: byName,
  category: (a, b) => a.item_category.localeCompare(b.item_category) || byName(a, b),
  status: (a, b) => cmpNum(STATUS_ORDER[a.stock_status] ?? 3, STATUS_ORDER[b.stock_status] ?? 3) || byName(a, b),
  on_hand: (a, b) => cmpNum(a.quantity_available, b.quantity_available) || byName(a, b),
  held: (a, b) => cmpNum(a.quantity_reserved, b.quantity_reserved) || byName(a, b),
  free: (a, b) => cmpNum(a.quantity_available_net, b.quantity_available_net) || byName(a, b),
  threshold: (a, b) => cmpNum(a.minimum_threshold, b.minimum_threshold) || byName(a, b),
  unit_cost: (a, b) => cmpNum(a.unit_cost, b.unit_cost) || byName(a, b),
};
export const sortItems = (items: InventoryItem[], sort: SortState) =>
  [...items].sort((a, b) => (sort.dir === 1 ? SORTERS[sort.key](a, b) : SORTERS[sort.key](b, a)));

// Numbers read best largest-first; text A to Z
const FIRST_DIR: Partial<Record<SortKey, -1>> = { on_hand: -1, held: -1, free: -1, threshold: -1, unit_cost: -1 };
export const nextSort = (prev: SortState, key: SortKey): SortState =>
  prev.key === key ? { key, dir: prev.dir === 1 ? -1 : 1 } : { key, dir: FIRST_DIR[key] ?? 1 };

// wide: hidden on phones; num: right-aligned
const COLUMNS: { key: SortKey; label: string; num?: boolean; wide?: 'sm' | 'md' | 'lg' }[] = [
  { key: 'name', label: 'Item' },
  { key: 'category', label: 'Category', wide: 'md' },
  { key: 'status', label: 'Status' },
  { key: 'on_hand', label: 'On hand', num: true, wide: 'sm' },
  { key: 'held', label: 'Reserved', num: true, wide: 'md' },
  { key: 'free', label: 'Free to use', num: true },
  { key: 'threshold', label: 'Low-stock alert', num: true, wide: 'lg' },
  { key: 'unit_cost', label: 'Unit cost', num: true, wide: 'lg' },
];
const WIDE_CLASS = { sm: 'hidden sm:table-cell', md: 'hidden md:table-cell', lg: 'hidden lg:table-cell' } as const;

function SortHead({ col, sort, onSort }: { col: (typeof COLUMNS)[number]; sort: SortState; onSort: (key: SortKey) => void }) {
  const active = sort.key === col.key;
  const Arrow = active ? (sort.dir === 1 ? ArrowUp : ArrowDown) : ArrowUpDown;
  return (
    <TableHead
      aria-sort={active ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
      className={cn(col.num && 'text-right', col.wide && WIDE_CLASS[col.wide])}
    >
      <button
        type="button"
        onClick={() => onSort(col.key)}
        className={cn(
          'inline-flex items-center gap-1 text-xs font-semibold tracking-wide uppercase hover:text-foreground',
          active ? 'text-foreground' : 'text-muted-foreground'
        )}
      >
        {col.label}
        <Arrow className={cn('size-3', !active && 'opacity-40')} aria-hidden />
      </button>
    </TableHead>
  );
}

export function InventoryTable({
  rows,
  sort,
  onSort,
  canEdit,
  recentlyChanged,
  onEdit,
  onAdjust,
  onDelete,
}: {
  rows: InventoryItem[];
  sort: SortState;
  onSort: (key: SortKey) => void;
  canEdit: boolean;
  recentlyChanged: string[];
  onEdit: (item: InventoryItem) => void;
  onAdjust: (item: InventoryItem, action: StockAction) => void;
  onDelete: (item: InventoryItem) => void;
}) {
  return (
    // min-w-0 + max-w-full: very large numbers can still make the table wider than the screen;
    // then it scrolls sideways inside this box instead of stretching the page.
    <div className="max-w-full min-w-0 overflow-x-auto rounded-lg border bg-card">
      <Table aria-label="Stock items">
        <TableHeader className="bg-muted/50">
          <TableRow>
            {COLUMNS.map((col) => (
              <SortHead key={col.key} col={col} sort={sort} onSort={onSort} />
            ))}
            {canEdit && (
              <TableHead className="w-px text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((item) => {
            const look = lookFor(STOCK_STATUS, item.stock_status);
            const label = STOCK_STATUS[item.stock_status]?.label ?? item.stock_status;
            const unit = item.unit || 'pcs';
            const changed = recentlyChanged.includes(item.inventory_id);
            return (
              <TableRow
                key={item.inventory_id}
                data-inventory-id={item.inventory_id}
                className={cn('transition-colors duration-700', changed && 'bg-info/10')}
              >
                {/* wrap-anywhere (overflow-wrap: anywhere) also lowers the column's minimum width,
                    so one giant unbroken word wraps inside the cell instead of widening the table;
                    break-words alone does not, in an auto-layout table. */}
                <TableCell className={cn('min-w-40 border-l-4 whitespace-normal wrap-anywhere', TONE_EDGE[look.tone])}>
                  <span className="block font-medium">{item.item_name}</span>
                  <span className="block text-xs text-muted-foreground md:hidden">{item.item_category}</span>
                  {item.sync_status !== 'synced' && (
                    <Badge variant="outline" className={cn('mt-1', TONE_CLASSES.info.badge)}>
                      Pending sync
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="hidden max-w-56 min-w-28 whitespace-normal wrap-anywhere md:table-cell">
                  <span className="block">{item.item_category}</span>
                  {item.supplier && <span className="block text-xs text-muted-foreground">{item.supplier}</span>}
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className={cn('gap-1', TONE_CLASSES[look.tone].badge)}>
                    <look.icon className="size-3" aria-hidden />
                    {label}
                  </Badge>
                </TableCell>
                <TableCell className="hidden text-right tabular-nums sm:table-cell">
                  {item.quantity_available.toLocaleString()} <span className="text-xs text-muted-foreground">{unit}</span>
                </TableCell>
                <TableCell className="hidden text-right tabular-nums md:table-cell">{item.quantity_reserved.toLocaleString()}</TableCell>
                <TableCell className="text-right tabular-nums">
                  <strong className={TONE_CLASSES[look.tone].text}>{item.quantity_available_net.toLocaleString()}</strong>
                  <span className="text-xs text-muted-foreground sm:hidden"> {unit}</span>
                  <span className="block text-xs text-muted-foreground sm:hidden">
                    of {item.quantity_available.toLocaleString()} on hand
                  </span>
                </TableCell>
                <TableCell className="hidden text-right tabular-nums lg:table-cell">{item.minimum_threshold.toLocaleString()}</TableCell>
                <TableCell className="hidden text-right tabular-nums lg:table-cell">{peso(item.unit_cost)}</TableCell>
                {canEdit && (
                  <TableCell className="text-right">
                    {/* modal={false}: these items open dialogs; a modal menu can leave the page unclickable */}
                    <DropdownMenu modal={false}>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${item.item_name}`}>
                          <MoreHorizontal aria-hidden />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-52">
                        <DropdownMenuLabel className="truncate">{item.item_name}</DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onSelect={() => onAdjust(item, 'add')}>
                          <Plus aria-hidden /> Add stock
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => onAdjust(item, 'subtract')}>
                          <Minus aria-hidden /> Subtract / record loss
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => onEdit(item)}>
                          <Pencil aria-hidden /> Edit details
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" onSelect={() => onDelete(item)}>
                          <Trash2 aria-hidden /> Move to Recycle Bin
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                )}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
