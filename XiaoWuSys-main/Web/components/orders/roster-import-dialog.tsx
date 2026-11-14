'use client';

// PB 7: a jersey roster (handwritten list typed into Excel / Google Sheets) added to an order in
// one go. The sheet is read in the browser with parseCsv (client-core), shown as a preview, then
// sent in ONE request:
//   POST /api/orders/:id/items/bulk   { items: [{ product_type, quantity, size, custom_name, custom_number, inventory_id }] }
// The server adds every row or none, reserves stock when the order already holds its stock, and
// answers in plain words (e.g. "Row 4: Quantity must be at least 1."). This screen only reads the
// sheet, checks that quantities are numbers, and shows the server's answer.
import { useEffect, useMemo, useState } from 'react';
import { FileDown, ListPlus, Upload } from 'lucide-react';
import { parseCsv } from '@xiaowu/client-core/csv';
import { Field, FormProblem } from '@/components/forms/form-bits';
import { BoundedSelectContent, BoundedSelectItem, BoundedSelectTrigger } from '@/components/forms/bounded-select';
import type { ResultMessage } from '@/components/feedback/result-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useApi } from '@/hooks/use-api';
import { errorMessage, saveBlob } from '@/lib/api';
import { toNumberInput, type InventorySnapshot } from '@/lib/inventory';
import { TEXT_MAX } from '@/lib/input-limits';
import { cn } from '@/lib/utils';

const NO_LINK = '__none__';
const TEMPLATE = 'Name,Number,Size,Quantity\nDELA CRUZ,7,M,1\nSANTOS,23,L,1\n';
const PREVIEW_ROWS = 50;

interface RosterRow {
  custom_name: string;
  custom_number: string;
  size: string;
  quantity: string;
}

// Column order when the sheet has no header row: Name, Number, Size, Quantity
const HEADER_WORDS: Record<keyof RosterRow, RegExp> = {
  custom_name: /^(name|player|pangalan)/i,
  custom_number: /^(no\.?|num|number|jersey ?no)/i,
  size: /^size/i,
  quantity: /^(qty|quantity|pcs|count)/i,
};
const DEFAULT_ORDER: (keyof RosterRow)[] = ['custom_name', 'custom_number', 'size', 'quantity'];

/** Spreadsheet text -> roster rows (presentation: maps columns, nothing is decided here) */
const readRoster = (text: string): RosterRow[] => {
  const table = parseCsv(text);
  if (table.length === 0) return [];
  const first = table[0].map((c) => c.trim());
  const mapped = first.map((cell) => (Object.keys(HEADER_WORDS) as (keyof RosterRow)[]).find((k) => HEADER_WORDS[k].test(cell)));
  const hasHeader = mapped.some(Boolean);
  const columns = hasHeader ? mapped : DEFAULT_ORDER;
  return (hasHeader ? table.slice(1) : table).map((cells) => {
    const row: RosterRow = { custom_name: '', custom_number: '', size: '', quantity: '' };
    cells.forEach((cell, i) => {
      const key = columns[i];
      if (key) row[key] = cell.trim();
    });
    return row;
  });
};

export function RosterImportDialog({
  orderId,
  onClose,
  onDone,
}: {
  orderId: string;
  onClose: () => void;
  onDone: (result: ResultMessage) => void;
}) {
  const api = useApi();
  const [catalog, setCatalog] = useState<InventorySnapshot['items']>([]);
  const [linkTo, setLinkTo] = useState(NO_LINK);
  const [productType, setProductType] = useState('Jersey print');
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState('');
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api<InventorySnapshot>('GET', '/inventory').then(({ ok, data }) => {
      if (!cancelled && ok && Array.isArray(data.items)) setCatalog(data.items);
    });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const rows = useMemo(() => readRoster(text), [text]);
  const linked = catalog.find((i) => i.inventory_id === linkTo);

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setProblem('');
    if (!/\.(csv|txt|tsv)$/i.test(file.name)) {
      setProblem('Please choose a .csv file. In Excel or Google Sheets use File → Save as / Download → CSV.');
      return;
    }
    setFileName(file.name);
    setText(await file.text());
  };

  const submit = async () => {
    setProblem('');
    const items = rows.map((r) => ({
      product_type: (linked?.item_name ?? productType).trim(),
      quantity: r.quantity === '' ? 1 : toNumberInput(r.quantity),
      size: r.size || undefined,
      custom_name: r.custom_name || undefined,
      custom_number: r.custom_number || undefined,
      inventory_id: linked?.inventory_id,
    }));
    const notNumber = items.findIndex((i) => i.quantity === undefined || Number.isNaN(i.quantity));
    if (notNumber !== -1) {
      setProblem(`Row ${notNumber + 1}: the quantity must be a number (or left empty for 1).`);
      return;
    }
    setBusy(true);
    const { ok, data } = await api<{ message?: string }>('POST', `/orders/${encodeURIComponent(orderId)}/items/bulk`, { items });
    setBusy(false);
    if (!ok) {
      setProblem(errorMessage(data, 'The roster was not added. Nothing was changed.'));
      return;
    }
    onDone({ type: 'success', title: 'Roster added', message: data.message ?? 'The roster was added to this order.' });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="flex max-h-[90dvh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ListPlus className="size-5" aria-hidden /> Bulk import roster (CSV / Excel)
          </DialogTitle>
          <DialogDescription>
            Paste the jersey list or choose a CSV file with the columns <em>Name, Number, Size, Quantity</em>. An empty quantity counts as 1.
            Every row is added, or none if something is wrong.
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-w-0 gap-3 overflow-y-auto sm:grid-cols-2">
          <Field id="roster-link" label="Catalog item (blank) for every row">
            <Select value={linkTo} onValueChange={setLinkTo} disabled={busy}>
              <BoundedSelectTrigger id="roster-link">
                <SelectValue placeholder="Choose the blank…" />
              </BoundedSelectTrigger>
              <BoundedSelectContent>
                <BoundedSelectItem value={NO_LINK} label="Not linked to stock (print details only)">
                  Not linked to stock (print details only)
                </BoundedSelectItem>
                {catalog.map((i) => (
                  <BoundedSelectItem key={i.inventory_id} value={i.inventory_id} label={i.item_name} suffix={`(${i.quantity_available_net.toLocaleString()} free)`}>
                    {i.item_name}
                  </BoundedSelectItem>
                ))}
              </BoundedSelectContent>
            </Select>
          </Field>
          {!linked && (
            <Field id="roster-what" label="What is printed">
              <Input id="roster-what" maxLength={TEXT_MAX.productType} value={productType} onChange={(e) => setProductType(e.target.value)} disabled={busy} />
            </Field>
          )}
          <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
            <Button asChild variant="outline" size="sm" disabled={busy}>
              <label className={cn('cursor-pointer', busy && 'pointer-events-none opacity-50')}>
                <Upload aria-hidden /> Choose CSV file
                <input type="file" accept=".csv,.tsv,.txt,text/csv" onChange={onFile} disabled={busy} className="sr-only" />
              </label>
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => saveBlob(new Blob([`﻿${TEMPLATE}`], { type: 'text/csv;charset=utf-8' }), 'xiaomei-roster-template.csv')}
            >
              <FileDown aria-hidden /> Download template
            </Button>
            {fileName && <span className="truncate text-sm text-muted-foreground">{fileName}</span>}
          </div>
          <Field id="roster-paste" label="Or paste the rows here" className="sm:col-span-2">
            <textarea
              id="roster-paste"
              rows={5}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setFileName('');
              }}
              disabled={busy}
              placeholder={'Name,Number,Size,Quantity\nDELA CRUZ,7,M,1'}
              className="w-full min-w-0 rounded-md border bg-background px-3 py-2 font-mono text-sm shadow-xs focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
            />
          </Field>
          {problem && (
            <div className="sm:col-span-2">
              <FormProblem message={problem} />
            </div>
          )}
          {rows.length > 0 && (
            <div className="space-y-1 sm:col-span-2">
              <p className="text-sm text-muted-foreground">
                <strong className="text-foreground">{rows.length.toLocaleString()}</strong> row(s) read
                {rows.length > PREVIEW_ROWS && ` · the first ${PREVIEW_ROWS} are shown`}
              </p>
              <div className="max-h-64 min-w-0 overflow-auto rounded-md border">
                <Table aria-label="Roster preview">
                  <TableHeader className="sticky top-0 bg-muted">
                    <TableRow>
                      <TableHead>Row</TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead>No.</TableHead>
                      <TableHead>Size</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.slice(0, PREVIEW_ROWS).map((r, i) => (
                      <TableRow key={i}>
                        <TableCell className="text-muted-foreground tabular-nums">{i + 1}</TableCell>
                        <TableCell className="whitespace-normal wrap-anywhere">{r.custom_name || '—'}</TableCell>
                        <TableCell>{r.custom_number || '—'}</TableCell>
                        <TableCell>{r.size || '—'}</TableCell>
                        <TableCell className="text-right tabular-nums">{r.quantity || '1'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" onClick={submit} disabled={busy || rows.length === 0}>
            {busy ? 'Adding…' : `Add ${rows.length.toLocaleString()} row(s)`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
