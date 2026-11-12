// Minimal CSV reader for imports (moved from Frontend/src/api.js in Batch M0).
// Handles quotes, commas and line breaks inside quotes, and the BOM Excel adds.
// -> array of rows (arrays of strings)
export const parseCsv = (text) => {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const src = String(text).replace(/^﻿/, '');
  // Excel uses ";" instead of "," in some regional settings; Google Sheets "TSV" uses tabs.
  // Pick whichever appears most in the header line.
  const header = src.split(/\r?\n/, 1)[0] || '';
  const count = (c) => header.split(c).length - 1;
  const delim = [',', ';', '\t'].reduce((best, c) => (count(c) > count(best) ? c : best), ',');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
};
