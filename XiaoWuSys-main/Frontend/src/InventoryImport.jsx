import { useMemo, useState } from 'react';
import { Upload, FileDown, CircleCheck, TriangleAlert } from 'lucide-react';
import { createApi, errorText, parseCsv } from './api';

// "Import from Excel / Google Sheets" tab of Manage Stock.
// Reads a .csv file in the browser, shows a preview with problems marked, then adds the new
// items one by one through POST /api/inventory, so every server rule (duplicates, plain-
// language validation, offline saving, audit trail) still applies.

const MAX_ROWS = 500;
// Header names people actually use, mapped to our fields (compared lower-case, spaces removed)
const HEADER_ALIASES = {
  item_name: ['item', 'itemname', 'name', 'material', 'product', 'description'],
  item_category: ['category', 'type', 'group'],
  unit: ['unit', 'uom', 'unitofmeasure'],
  supplier: ['supplier', 'vendor', 'source'],
  quantity_available: ['quantity', 'qty', 'onhand', 'stock', 'quantityinstock', 'count'],
  minimum_threshold: ['lowstockalert', 'minimum', 'min', 'threshold', 'reorderlevel', 'minimumthreshold', 'alertat'],
  unit_cost: ['unitcost', 'cost', 'price', 'unitcostphp', 'unitprice']
};
const key = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
const nameKey = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');
const TEMPLATE = 'Item,Category,Unit,Supplier,Quantity,Low-stock alert,Unit cost\r\n'
  + 'Custom Shirt,Apparel,pcs,Davao Garments Supply,381,50,150\r\n'
  + 'Deli A4 Paper,Paper,ream,,1,2,245\r\n';

const toNumber = (text, { money = false } = {}) => {
  const t = String(text ?? '').replace(/[₱,\s]/g, '').replace(/^PHP/i, '');
  if (t === '') return 0;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return NaN;
  if (!money && !Number.isInteger(n)) return NaN;
  return money ? Math.round(n * 100) / 100 : n;
};

const readRows = (text, existing) => {
  const rows = parseCsv(text);
  if (rows.length < 2) return { error: 'The file has no data rows. The first row must be the column names.' };
  const header = rows[0].map(key);
  const col = {};
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    const idx = header.findIndex((h) => aliases.includes(h));
    if (idx >= 0) col[field] = idx;
  }
  if (col.item_name === undefined || col.item_category === undefined) {
    return { error: 'The file needs at least an "Item" column and a "Category" column. Download the template to see the layout.' };
  }
  const body = rows.slice(1, MAX_ROWS + 1);
  const seen = new Set();
  const existingKeys = new Set(existing.map((i) => nameKey(i.item_name)));
  const parsed = body.map((r, i) => {
    const get = (f) => (col[f] === undefined ? '' : String(r[col[f]] ?? '').trim());
    const item = {
      item_name: get('item_name').replace(/\s+/g, ' '),
      item_category: get('item_category'),
      unit: get('unit') || 'pcs',
      supplier: get('supplier') || undefined,
      quantity_available: toNumber(get('quantity_available')),
      minimum_threshold: toNumber(get('minimum_threshold')),
      unit_cost: toNumber(get('unit_cost'), { money: true })
    };
    let problem = null;
    let status = 'new';
    if (!item.item_name) problem = 'No item name';
    else if (!item.item_category) problem = 'No category';
    else if (Number.isNaN(item.quantity_available)) problem = 'Quantity must be a whole number';
    else if (Number.isNaN(item.minimum_threshold)) problem = 'Low-stock alert must be a whole number';
    else if (Number.isNaN(item.unit_cost)) problem = 'Unit cost must be a peso amount';
    else if (existingKeys.has(nameKey(item.item_name))) status = 'exists';
    else if (seen.has(nameKey(item.item_name))) status = 'repeated';
    if (!problem && status === 'new') seen.add(nameKey(item.item_name));
    return { line: i + 2, item, problem, status: problem ? 'error' : status };
  });
  return { rows: parsed, truncated: rows.length - 1 > MAX_ROWS };
};

const STATUS_TEXT = {
  new: { text: 'Will be added', color: '#166534' },
  exists: { text: 'Already in catalog (skipped)', color: '#92400e' },
  repeated: { text: 'Repeated in file (skipped)', color: '#92400e' },
  error: { text: '', color: '#b91c1c' },
  added: { text: 'Added ✓', color: '#166534' },
  failed: { text: '', color: '#b91c1c' }
};

export default function InventoryImport({ apiBase, token, onUnauthorized, items, onDone, styles: s }) {
  const api = useMemo(() => createApi({ apiBase, token, onUnauthorized }), [apiBase, token, onUnauthorized]);
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState(null); // { rows, truncated } | { error }
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setFileName(file.name);
    setProgress(null);
    if (!/\.(csv|txt|tsv)$/i.test(file.name)) {
      setPreview({ error: 'Please choose a .csv file. In Excel or Google Sheets use File → Save as / Download → CSV.' });
      return;
    }
    if (file.size > 2 * 1024 * 1024) { setPreview({ error: 'The file is too big (over 2 MB). Split it into smaller files.' }); return; }
    setPreview(readRows(await file.text(), items));
  };

  const downloadTemplate = () => {
    const url = URL.createObjectURL(new Blob([`\uFEFF${TEMPLATE}`], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'xiaomei-inventory-template.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const toAdd = preview?.rows?.filter((r) => r.status === 'new') || [];

  const runImport = async () => {
    setBusy(true);
    const rows = preview.rows.map((r) => ({ ...r }));
    let added = 0;
    let failed = 0;
    for (const r of rows) {
      if (r.status !== 'new') continue;
      const { ok, data } = await api('POST', '/inventory', r.item);
      if (ok) { r.status = 'added'; added++; } else { r.status = 'failed'; r.problem = errorText(data, 'Not added'); failed++; }
      setProgress({ done: added + failed, total: toAdd.length });
      setPreview({ ...preview, rows: [...rows] });
    }
    setBusy(false);
    onDone({
      type: failed ? 'warning' : 'success',
      title: failed ? 'Import finished with problems' : 'Import finished',
      message: `${added} item(s) added.${failed ? ` ${failed} could not be added (see the list).` : ''}`
        + `${rows.length - toAdd.length > 0 ? `\n${rows.length - toAdd.length} row(s) were skipped (duplicates or errors).` : ''}`
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <p style={s.hint}>
        Move the item list from Excel, Google Sheets or the whiteboard in one go. Save the sheet as <strong>CSV</strong>
        {' '}with the columns <em>Item, Category, Unit, Supplier, Quantity, Low-stock alert, Unit cost</em>
        {' '}(only Item and Category are required). Items that already exist are skipped, never doubled.
      </p>
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <label style={{ ...s.submitBtn, cursor: busy ? 'not-allowed' : 'pointer' }}>
          <Upload size={16} /> Choose CSV file
          <input type="file" accept=".csv,.tsv,.txt,text/csv" onChange={onFile} disabled={busy} style={{ display: 'none' }} />
        </label>
        <button type="button" onClick={downloadTemplate} style={s.refreshBtn}><FileDown size={16} /> Download template</button>
        {fileName && <span style={s.hint}>{fileName}</span>}
      </div>

      {preview?.error && <p style={{ ...s.banner, background: '#fee2e2', color: '#991b1b', margin: 0 }}><TriangleAlert size={16} /> {preview.error}</p>}

      {preview?.rows && (
        <>
          <p style={s.hint}>
            <strong>{toAdd.length}</strong> new item(s) to add · {preview.rows.filter((r) => r.status === 'exists' || r.status === 'repeated').length} duplicate(s)
            {' '}· {preview.rows.filter((r) => r.status === 'error').length} row(s) with problems
            {preview.truncated && ` · only the first ${MAX_ROWS} rows are read`}
          </p>
          <div style={{ ...s.tableWrap, maxHeight: '320px', overflowY: 'auto' }}>
            <table style={s.table}>
              <thead>
                <tr>
                  <th style={s.th}>Row</th><th style={s.th}>Item</th><th style={s.th}>Category</th><th style={s.thNum}>Qty</th>
                  <th style={s.th}>Unit</th><th style={s.thNum}>Alert at</th><th style={s.thNum}>Cost</th><th style={s.th}>Result</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r) => (
                  <tr key={r.line}>
                    <td style={s.td}>{r.line}</td>
                    <td style={s.td}>{r.item.item_name || '—'}</td>
                    <td style={s.td}>{r.item.item_category || '—'}</td>
                    <td style={s.tdNum}>{Number.isNaN(r.item.quantity_available) ? '?' : r.item.quantity_available}</td>
                    <td style={s.td}>{r.item.unit}</td>
                    <td style={s.tdNum}>{Number.isNaN(r.item.minimum_threshold) ? '?' : r.item.minimum_threshold}</td>
                    <td style={s.tdNum}>{Number.isNaN(r.item.unit_cost) ? '?' : r.item.unit_cost}</td>
                    <td style={{ ...s.td, color: STATUS_TEXT[r.status].color, fontWeight: 'bold' }}>
                      {r.problem || STATUS_TEXT[r.status].text}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button type="button" onClick={runImport} style={s.submitBtn} disabled={busy || toAdd.length === 0}>
            <CircleCheck size={16} />
            {busy ? `Adding… ${progress ? `${progress.done} of ${progress.total}` : ''}` : `Add ${toAdd.length} new item(s) to the inventory`}
          </button>
        </>
      )}
    </div>
  );
}
