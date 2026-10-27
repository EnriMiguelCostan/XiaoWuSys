import { useCallback, useEffect, useMemo, useState } from 'react';
import { Trash2, RotateCcw, X, ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import { createApi, errorText, formatDateTime } from './api';
import { ConfirmDialog } from './Dialogs';

// Recycle Bin window. Items deleted from the Catalog wait here and can be restored.
// Permanent delete (Owner/Admin) is the only way out; the backend keeps a hidden trace.
// Paginated (PAGE_SIZE per request) and "Empty" runs in server-side batches, so a full bin
// never slows the page or the server down.
const PAGE_SIZE = 20;
const PURGE_ROLES = ['Owner', 'Admin'];

export default function RecycleBin({ apiBase, token, userRole, onUnauthorized, onClose, onResult, refreshKey }) {
  const api = useMemo(() => createApi({ apiBase, token, onUnauthorized }), [apiBase, token, onUnauthorized]);
  const canPurge = PURGE_ROLES.includes(userRole);

  const [page, setPage] = useState(0);
  const [data, setData] = useState({ items: [], total: 0, retention_days: 30, source: null });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [confirm, setConfirm] = useState(null); // { kind: 'purge' | 'empty', item? }
  const [emptyProgress, setEmptyProgress] = useState(null); // { done, remaining }
  const [reloadTick, setReloadTick] = useState(0);
  const reload = useCallback(() => setReloadTick((t) => t + 1), []);

  // Load the current page (and again whenever the catalog changes anywhere)
  useEffect(() => {
    let cancelled = false;
    api('GET', `/inventory/recycle-bin?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`).then(({ ok, data: body }) => {
      if (cancelled) return;
      setLoading(false);
      if (!ok) { setLoadError(errorText(body, 'Could not load the Recycle Bin.')); return; }
      setLoadError('');
      setData({ items: body.items || [], total: body.total || 0, retention_days: body.retention_days || 30, source: body.source });
      // Page emptied by a restore/delete: step back
      if ((body.items || []).length === 0 && page > 0 && (body.total || 0) > 0) setPage((p) => Math.max(0, p - 1));
    });
    return () => { cancelled = true; };
  }, [api, page, refreshKey, reloadTick]);

  const pages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));

  const restore = async (item) => {
    setBusyId(item.inventory_id);
    const { ok, data: body } = await api('POST', `/inventory/${encodeURIComponent(item.inventory_id)}/restore`);
    setBusyId(null);
    onResult(ok
      ? { type: 'success', title: 'Item restored', message: body.message }
      : { type: 'error', title: 'Could not restore', message: errorText(body, 'Restore failed.') });
    reload();
  };

  const purge = async (item) => {
    setBusyId(item.inventory_id);
    const { ok, data: body } = await api('DELETE', `/inventory/${encodeURIComponent(item.inventory_id)}/permanent`);
    setBusyId(null);
    setConfirm(null);
    onResult(ok
      ? { type: 'success', title: 'Permanently deleted', message: body.message }
      : { type: 'error', title: 'Could not delete', message: errorText(body, 'Permanent delete failed.') });
    reload();
  };

  // Calls the bounded server batch repeatedly until the bin is empty
  const emptyBin = async () => {
    setConfirm(null);
    let done = 0;
    setEmptyProgress({ done: 0, remaining: data.total });
    for (let round = 0; round < 1000; round++) {
      const { ok, data: body } = await api('POST', '/inventory/recycle-bin/empty');
      if (!ok) {
        setEmptyProgress(null);
        onResult({ type: 'error', title: 'Could not empty the Recycle Bin', message: errorText(body, 'Empty failed.') + (done ? `\n${done} item(s) were deleted before the error.` : '') });
        reload();
        return;
      }
      done += body.purged_count || 0;
      setEmptyProgress({ done, remaining: body.remaining || 0 });
      if (!body.remaining || !body.purged_count) break;
    }
    setEmptyProgress(null);
    setPage(0);
    onResult({ type: 'success', title: 'Recycle Bin emptied', message: `${done} item(s) permanently deleted. A record of each one is kept in the backend.` });
    reload();
  };

  return (
    <div style={r.overlay} onClick={emptyProgress ? undefined : onClose}>
      <section role="dialog" aria-modal="true" aria-labelledby="recycle-bin-title" style={r.card} onClick={(e) => e.stopPropagation()}>
        <div style={r.head}>
          <div>
            <h2 id="recycle-bin-title" style={r.title}><Trash2 size={20} /> Recycle Bin</h2>
            <p style={r.sub}>
              {data.total} item{data.total === 1 ? '' : 's'} · restore anything deleted by mistake.
              {' '}Items are permanently removed automatically after {data.retention_days} days.
            </p>
          </div>
          <button type="button" onClick={onClose} style={r.close} aria-label="Close Recycle Bin" disabled={Boolean(emptyProgress)}>
            <X size={20} />
          </button>
        </div>

        <div style={r.toolbar}>
          <button type="button" onClick={reload} style={r.toolBtn} disabled={loading || Boolean(emptyProgress)}>
            <RefreshCw size={14} /> Refresh
          </button>
          {canPurge && (
            <button
              type="button" onClick={() => setConfirm({ kind: 'empty' })}
              style={{ ...r.toolBtn, color: '#b91c1c', borderColor: '#fecaca' }}
              disabled={data.total === 0 || Boolean(emptyProgress) || data.source === 'local'}
            >
              <Trash2 size={14} /> Empty Recycle Bin
            </button>
          )}
        </div>

        {data.source === 'local' && (
          <p style={r.notice}>Offline: you can restore items, but permanent delete needs an internet connection.</p>
        )}
        {emptyProgress && (
          <p style={r.notice}>Deleting permanently… {emptyProgress.done} done, {emptyProgress.remaining} left.</p>
        )}
        {loadError && <p style={{ ...r.notice, background: '#fee2e2', color: '#991b1b' }}>{loadError}</p>}

        <div style={r.list}>
          {loading && data.items.length === 0 && <p style={r.empty}>Loading…</p>}
          {!loading && !loadError && data.items.length === 0 && <p style={r.empty}>The Recycle Bin is empty.</p>}
          {data.items.map((item) => (
            <div key={item.inventory_id} style={r.row}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={r.name}>{item.item_name}</div>
                <div style={r.meta}>
                  {item.item_category} · {item.quantity_available} in stock · deleted {formatDateTime(item.deleted_at, { utc: true })}
                  {item.sync_status !== 'synced' && ' · pending sync'}
                </div>
              </div>
              <div style={r.rowActions}>
                <button type="button" onClick={() => restore(item)} style={r.restoreBtn} disabled={busyId !== null || Boolean(emptyProgress)}>
                  <RotateCcw size={14} /> {busyId === item.inventory_id ? '…' : 'Restore'}
                </button>
                {canPurge && (
                  <button
                    type="button" onClick={() => setConfirm({ kind: 'purge', item })} style={r.purgeBtn}
                    disabled={busyId !== null || Boolean(emptyProgress) || data.source === 'local'}
                    title="Delete permanently"
                  >
                    <Trash2 size={14} /> Delete forever
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>

        {pages > 1 && (
          <div style={r.pager}>
            <button type="button" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0} style={r.toolBtn}>
              <ChevronLeft size={14} /> Prev
            </button>
            <span style={r.meta}>Page {page + 1} of {pages}</span>
            <button type="button" onClick={() => setPage((p) => Math.min(pages - 1, p + 1))} disabled={page >= pages - 1} style={r.toolBtn}>
              Next <ChevronRight size={14} />
            </button>
          </div>
        )}
      </section>

      <ConfirmDialog
        open={confirm?.kind === 'purge'}
        title="Delete permanently?"
        message={confirm?.item ? `"${confirm.item.item_name}" will be removed from the Recycle Bin for good and cannot be restored from the website.` : ''}
        confirmLabel="Delete forever"
        danger
        busy={busyId !== null}
        onConfirm={() => purge(confirm.item)}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm?.kind === 'empty'}
        title="Empty the Recycle Bin?"
        message={`All ${data.total} item(s) in the Recycle Bin will be permanently deleted. This cannot be undone from the website.`}
        confirmLabel="Empty Recycle Bin"
        danger
        onConfirm={emptyBin}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}

const r = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(15, 23, 42, 0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem', zIndex: 60 },
  card: { background: '#fff', borderRadius: '0.5rem', borderTop: '4px solid #64748b', width: '100%', maxWidth: '680px', maxHeight: '85vh', display: 'flex', flexDirection: 'column', padding: '1.25rem', boxShadow: '0 10px 25px -5px rgba(0,0,0,0.25)', textAlign: 'left' },
  head: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem', marginBottom: '0.75rem' },
  title: { display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '1.2rem', margin: 0, color: '#0f172a' },
  sub: { margin: '0.25rem 0 0', fontSize: '0.8rem', color: '#64748b' },
  close: { background: 'none', border: 'none', cursor: 'pointer', color: '#64748b' },
  toolbar: { display: 'flex', gap: '0.5rem', marginBottom: '0.75rem', flexWrap: 'wrap' },
  toolBtn: { display: 'flex', alignItems: 'center', gap: '0.25rem', padding: '0.4rem 0.75rem', background: '#fff', border: '1px solid #cbd5e1', borderRadius: '0.375rem', cursor: 'pointer', color: '#334155', fontWeight: 'bold', fontSize: '0.8rem' },
  notice: { padding: '0.5rem 0.75rem', borderRadius: '0.375rem', background: '#fef3c7', color: '#92400e', fontSize: '0.8rem', margin: '0 0 0.75rem' },
  list: { overflowY: 'auto', flex: 1, border: '1px solid #e2e8f0', borderRadius: '0.375rem' },
  empty: { textAlign: 'center', color: '#64748b', padding: '2rem', margin: 0 },
  row: { display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.75rem', borderBottom: '1px solid #f1f5f9' },
  name: { fontWeight: 'bold', color: '#0f172a', fontSize: '0.95rem', overflowWrap: 'anywhere' },
  meta: { fontSize: '0.75rem', color: '#64748b' },
  rowActions: { display: 'flex', gap: '0.35rem', flexShrink: 0 },
  restoreBtn: { display: 'flex', alignItems: 'center', gap: '0.25rem', padding: '0.4rem 0.7rem', background: '#e0e7ff', border: '1px solid #c7d2fe', borderRadius: '0.375rem', cursor: 'pointer', color: '#4338ca', fontWeight: 'bold', fontSize: '0.8rem' },
  purgeBtn: { display: 'flex', alignItems: 'center', gap: '0.25rem', padding: '0.4rem 0.7rem', background: '#fff', border: '1px solid #fecaca', borderRadius: '0.375rem', cursor: 'pointer', color: '#b91c1c', fontWeight: 'bold', fontSize: '0.8rem' },
  pager: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '0.75rem' }
};
