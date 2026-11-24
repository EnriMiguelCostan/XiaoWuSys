// ==========================================
// DESIGN FILES (migration 016, adviser consultation)
// Design files uploaded from the computer, so a design no longer has to be put on Google Drive
// first. The files are kept in the cloud database (order_design_files), so every branch sees
// the same files; uploading, opening and removing need the cloud connection. Nothing here is
// mirrored to the offline copy (files can be large).
//
// Only design formats are accepted, chosen by the file's extension. Images whose first bytes
// really are PNG / JPEG / GIF / WebP may be shown in the page (preview); every other file is
// always sent as a download, so a file can never run as a web page.
// ==========================================
const { isConnectionError } = require('../utils/dbErrors');

const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB per file
const MAX_FILES_PER_ORDER = 20;
const FILE_NOTES_MAX = 500;

// extension -> the content type it is stored and sent with
const ALLOWED_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  bmp: 'image/bmp',
  pdf: 'application/pdf',
  ai: 'application/postscript',
  eps: 'application/postscript',
  psd: 'image/vnd.adobe.photoshop',
  cdr: 'application/vnd.corel-draw',
  zip: 'application/zip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain'
};
const ALLOWED_EXTENSIONS = Object.keys(ALLOWED_TYPES);

// Image formats a browser may show inline, with the bytes each must start with
const PREVIEW_SIGNATURES = {
  'image/png': [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  'image/jpeg': [[0xff, 0xd8, 0xff]],
  'image/gif': [[0x47, 0x49, 0x46, 0x38]],
  'image/webp': [[0x52, 0x49, 0x46, 0x46]] // "RIFF" (+ "WEBP" at offset 8, checked below)
};

const extensionOf = (name) => {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(name || '');
  return m ? m[1].toLowerCase() : '';
};

// A file name safe to store and show: no folders, no control characters, at most 200 characters
// (the extension is kept). -> the clean name, or null when nothing usable is left
const cleanFileName = (raw) => {
  if (typeof raw !== 'string') return null;
  const base = raw.split(/[\\/]/).pop().replace(/[\u0000-\u001F\u007F"<>|*?:]/g, '').replace(/\s+/g, ' ').trim();
  if (!base || base === '.' || base === '..') return null;
  if (base.length <= 200) return base;
  const ext = extensionOf(base);
  return ext ? `${base.slice(0, 199 - ext.length)}.${ext}` : base.slice(0, 200);
};

// Does the content really start like the image type it claims? (only these are shown inline)
const isPreviewable = (mime, buffer) => {
  const signatures = PREVIEW_SIGNATURES[mime];
  if (!signatures || !buffer || buffer.length < 12) return false;
  const starts = signatures.some((sig) => sig.every((byte, i) => buffer[i] === byte));
  if (!starts) return false;
  if (mime === 'image/webp') return buffer.slice(8, 12).toString('ascii') === 'WEBP';
  return true;
};

// Checks an upload -> { error } | { file_name, mime_type, size_bytes, previewable }
const checkUpload = ({ name, buffer }) => {
  const file_name = cleanFileName(name);
  if (!file_name) return { error: 'The file needs a name, like front-design.png.' };
  const ext = extensionOf(file_name);
  if (!ALLOWED_TYPES[ext]) {
    return { error: `This kind of file cannot be attached. Use one of these: ${ALLOWED_EXTENSIONS.join(', ')}.` };
  }
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) return { error: 'The file is empty.' };
  if (buffer.length > MAX_FILE_BYTES) return { error: `The file is too large. The limit is ${MAX_FILE_BYTES / 1024 / 1024} MB per file.` };
  const mime_type = ALLOWED_TYPES[ext];
  return { file_name, mime_type, size_bytes: buffer.length, previewable: isPreviewable(mime_type, buffer) };
};

// The header value that makes the browser save the file under its own name
const contentDisposition = (kind, fileName) => {
  const ascii = fileName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
};

const FILE_COLUMNS = `file_id, order_id, file_name, mime_type, size_bytes, notes, uploaded_by,
  to_char(uploaded_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS uploaded_at,
  substring(content from 1 for 12) AS head`;

const shownFile = (row, names) => ({
  file_id: row.file_id,
  order_id: row.order_id,
  file_name: row.file_name,
  mime_type: row.mime_type,
  size_bytes: Number(row.size_bytes),
  notes: row.notes,
  uploaded_by: row.uploaded_by,
  uploaded_by_name: (row.uploaded_by && names.get(row.uploaded_by)) || null,
  uploaded_at: row.uploaded_at,
  previewable: isPreviewable(row.mime_type, row.head)
});

// The files of one order, without their content -> { available, files }
//   available false: the cloud cannot be reached (the files are kept there only)
const listDesignFiles = async (req, order_id) => {
  try {
    const { rows } = await req.pgPool.query(
      `SELECT ${FILE_COLUMNS} FROM order_design_files WHERE order_id = $1 ORDER BY uploaded_at, file_id`, [order_id]);
    const { userNames } = require('./records'); // loaded here so the pure checks above need no database driver
    const names = await userNames(req, rows.map((r) => r.uploaded_by));
    return { available: true, files: rows.map((r) => shownFile(r, names)) };
  } catch (err) {
    if (!isConnectionError(err)) throw err;
    return { available: false, files: [] };
  }
};

module.exports = {
  MAX_FILE_BYTES, MAX_FILES_PER_ORDER, FILE_NOTES_MAX, ALLOWED_TYPES, ALLOWED_EXTENSIONS, FILE_COLUMNS,
  extensionOf, cleanFileName, isPreviewable, checkUpload, contentDisposition, shownFile, listDesignFiles
};
