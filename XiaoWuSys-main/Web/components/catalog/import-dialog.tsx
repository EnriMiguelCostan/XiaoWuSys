'use client';

// "Import from Excel / Google Sheets" (ported from InventoryImport.jsx).
// Reads a .csv in the browser, shows a preview, then adds the rows one by one through
// POST /api/inventory, so every server rule (duplicates, validation, offline saving, audit
// trail) still applies.
//
// Unlike the MVP, the preview does not guess duplicates with its own copy of the server's
// name rule: the server decides, and a row it refuses as a duplicate (409) is shown as
// "Already in the catalog (skipped)".
import { useState } from 'react';
import { CircleCheck, FileDown, Upload } from 'lucide-react';
import { parseCsv } from '@xiaowu/client-core/csv';
import { FormProblem } from '@/components/catalog/form-bits';
import type { ResultMessage } from '@/components/feedback/result-dialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useApi } from '@/hooks/use-api';
import { saveBlob, errorMessage } from '@/lib/api';
import { TONE_CLASSES, type Tone } from '@/lib/ui-tokens';
import { cn } from '@/lib/utils';

const MAX_ROWS = 500;
const MAX_BYTES = 2 * 1024 * 1024;

// Header names people actually use, mapped to our fields (compared lower-case, letters only)
const HEADER_ALIASES: Record<string, string[]> = {
  item_name: ['item', 'itemname', 'name', 'material', 'product', 'description'],
  item_category: ['category', 'type', 'group'],
  unit: ['unit', 'uom', 'unitofmeasure'],
  supplier: ['supplier', 'vendor', 'source'],
  quantity_available: ['quantity', 'qty', 'onhand', 'stock', 'quantityinstock', 'count'],
  minimum_threshold: ['lowstockalert', 'minimum', 'min', 'threshold', 'reorderlevel', 'minimumthreshold', 'alertat'],
  unit_cost: ['unitcost', 'cost', 'price', 'unitcostphp', 'unitprice'],
};
const headerKey = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');

const TEMPLATE =
  'Item,Category,Unit,Supplier,Quantity,Low-stock alert,Unit cost\r\n' +
  'Custom Shirt,Apparel,pcs,Davao Garments Supply,381,50,150\r\n' +
  'Deli A4 Paper,Paper,ream,,1,2,245\r\n';

// Spreadsheet text -> number: strips peso signs and thousands commas. '' -> undefined (server
// default). Only "is it a number" is checked here; ranges and decimals are the server's call.
const cellNumber = (text: string): number | undefined => {
  const t = text.replace(/[₱,\s]/g, '').replace(/^PHP/i, '');
  return t === '' ? undefined : Number(t);
};

type RowState = 'ready' | 'error' | 'added' | 'skipped' | 'failed';

interface ImportRow {
  line: number;
  item: {
    item_name: string;
    item_category: string;
    unit: string;
    supplier?: string;
    quantity_available?: number;
    minimum_threshold?: number;
    unit_cost?: number;
  };
  state: RowState;
  note: string;
}

const STATE_LOOK: Record<RowState, { text: string; tone: Tone }> = {
  ready: { text: 'Will be added', tone: 'muted' },
  error: { text: '', tone: 'danger' },
  added: { text: 'Added', tone: 'success' },
  skipped: { text: '', tone: 'warning' },
  failed: { text: '', tone: 'danger' },
};

type Preview = { rows: ImportRow[]; truncated: boolean } | { error: string };

const readRows = (text: string): Preview => {
  const rows = parseCsv(text);
  if (rows.length < 2) return { error: 'The file has no data rows. The first row must be the column names.' };
  const header = rows[0].map(headerKey);
  const col: Record<string, number> = {};
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    const idx = header.findIndex((h) => aliases.includes(h));
    if (idx >= 0) col[field] = idx;
  }
  if (col.item_name === undefined || col.item_category === undefined) {
    return { error: 'The file needs at least an "Item" column and a "Category" column. Download the template to see the layout.' };
  }

  const parsed = rows.slice(1, MAX_ROWS + 1).map((r, i): ImportRow => {
    const get = (field: string) => (col[field] === undefined ? '' : String(r[col[field]] ?? '').trim());
    const item = {
      item_name: get('item_name').replace(/\s+/g, ' '),
      item_category: get('item_category'),
      unit: get('unit') || 'pcs',
      supplier: get('supplier') || undefined,
      quantity_available: cellNumber(get('quantity_available')),
      minimum_threshold: cellNumber(get('minimum_threshold')),
      unit_cost: cellNumber(get('unit_cost')),
    };
    let note = '';
    if (!item.item_name) note = 'No item name';
    else if (!item.item_category) note = 'No category';
    else if (Number.isNaN(item.quantity_available)) note = 'Quantity is not a number';
    else if (Number.isNaN(item.minimum_threshold)) note = 'Low-stock alert is not a number';
    else if (Number.isNaN(item.unit_cost)) note = 'Unit cost is not a number';
    return { line: i + 2, item, state: note ? 'error' : 'ready', note };
  });
  return { rows: parsed, truncated: rows.length - 1 > MAX_ROWS };
};

const show = (n: number | undefined) => (n === undefined ? '—' : Number.isNaN(n) ? '?' : n.toLocaleString());

export function ImportDialog({ onClose, onDone }: { onClose: () => void; onDone: (result: ResultMessage) => void }) {
  const api = useApi();
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setFileName(file.name);
    setProgress(null);
    if (!/\.(csv|txt|tsv)$/i.test(file.name)) {
      setPreview({ error: 'Please choose a .csv file. In Excel or Google Sheets use File → Save as / Download → CSV.' });
      return;
    }
    if (file.size > MAX_BYTES) {
      setPreview({ error: 'The file is too big (over 2 MB). Split it into smaller files.' });
      return;
    }
    setPreview(readRows(await file.text()));
  };

  const downloadTemplate = () =>
    saveBlob(new Blob([`﻿${TEMPLATE}`], { type: 'text/csv;charset=utf-8' }), 'xiaomei-inventory-template.csv');

  const rows = preview && 'rows' in preview ? preview.rows : null;
  const truncated = preview && 'rows' in preview ? preview.truncated : false;
  const ready = rows?.filter((r) => r.state === 'ready') ?? [];
  const problems = rows?.filter((r) => r.state === 'error').length ?? 0;

  const runImport = async () => {
    if (!rows) return;
    setBusy(true);
    const next = rows.map((r) => ({ ...r }));
    const total = ready.length;
    let added = 0;
    let skipped = 0;
    let failed = 0;
    for (const r of next) {
      if (r.state !== 'ready') continue;
      const { ok, status, data } = await api('POST', '/inventory', r.item);
      if (ok) {
        r.state = 'added';
        added++;
      } else if (status === 409) {
        r.state = 'skipped';
        r.note = 'Already in the catalog (skipped)';
        skipped++;
      } else {
        r.state = 'failed';
        r.note = errorMessage(data, 'Not added');
        failed++;
      }
      setProgress({ done: added + skipped + failed, total });
      setPreview({ rows: [...next], truncated });
    }
    setBusy(false);
    onDone({
      type: failed ? 'warning' : 'success',
      title: failed ? 'Import finished with problems' : 'Import finished',
      message:
        `${added} item(s) added.` +
        (skipped ? `\n${skipped} already in the catalog (skipped, never doubled).` : '') +
        (failed ? `\n${failed} could not be added (see the list).` : '') +
        (problems ? `\n${problems} row(s) had problems in the file and were not sent.` : ''),
    });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="flex max-h-[90dvh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Import from Excel / Google Sheets</DialogTitle>
          <DialogDescription>
            Save the sheet as <strong>CSV</strong> with the columns <em>Item, Category, Unit, Supplier, Quantity, Low-stock alert, Unit cost</em>.
            Only Item and Category are required. Items that already exist are skipped, never doubled.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          <Button asChild disabled={busy}>
            <label className={cn('cursor-pointer', busy && 'pointer-events-none opacity-50')}>
              <Upload aria-hidden /> Choose CSV file
              <input type="file" accept=".csv,.tsv,.txt,text/csv" onChange={onFile} disabled={busy} className="sr-only" />
            </label>
          </Button>
          <Button type="button" variant="outline" onClick={downloadTemplate}>
            <FileDown aria-hidden /> Download template
          </Button>
          {fileName && <span className="truncate text-sm text-muted-foreground">{fileName}</span>}
        </div>

        {preview && 'error' in preview && <FormProblem message={preview.error} />}

        {rows && (
          <>
            <p className="text-sm text-muted-foreground">
              <strong className="text-foreground">{ready.length}</strong> row(s) ready · {problems} with problems
              {truncated && ` · only the first ${MAX_ROWS} rows are read`}
            </p>
            <div className="min-h-0 flex-1 overflow-auto rounded-md border">
              <Table>
                <TableHeader className="sticky top-0 bg-muted">
                  <TableRow>
                    <TableHead>Row</TableHead>
                    <TableHead>Item</TableHead>
                    <TableHead className="hidden sm:table-cell">Category</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead className="hidden md:table-cell">Unit</TableHead>
                    <TableHead className="hidden text-right md:table-cell">Alert at</TableHead>
                    <TableHead className="hidden text-right md:table-cell">Cost</TableHead>
                    <TableHead>Result</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.line}>
                      <TableCell className="text-muted-foreground">{r.line}</TableCell>
                      <TableCell className="max-w-48 truncate font-medium">{r.item.item_name || '—'}</TableCell>
                      <TableCell className="hidden sm:table-cell">{r.item.item_category || '—'}</TableCell>
                      <TableCell className="text-right tabular-nums">{show(r.item.quantity_available)}</TableCell>
                      <TableCell className="hidden md:table-cell">{r.item.unit}</TableCell>
                      <TableCell className="hidden text-right tabular-nums md:table-cell">{show(r.item.minimum_threshold)}</TableCell>
                      <TableCell className="hidden text-right tabular-nums md:table-cell">{show(r.item.unit_cost)}</TableCell>
                      <TableCell className={cn('font-medium whitespace-normal', TONE_CLASSES[STATE_LOOK[r.state].tone].text)}>
                        {r.note || STATE_LOOK[r.state].text}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            Close
          </Button>
          {rows && (
            <Button type="button" onClick={runImport} disabled={busy || ready.length === 0}>
              <CircleCheck aria-hidden />
              {busy
                ? `Adding… ${progress ? `${progress.done} of ${progress.total}` : ''}`
                : `Add ${ready.length} item(s) to the catalog`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
