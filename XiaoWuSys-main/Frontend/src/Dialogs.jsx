import { useEffect } from 'react';
import { CircleCheck, TriangleAlert, CircleX, X } from 'lucide-react';

// Shared pop-up dialogs (inline styles only, like the rest of the frontend).
//   <ResultDialog result={{ type: 'success' | 'error' | 'warning', title, message }} onClose />
//   <ConfirmDialog open title message confirmLabel danger busy onConfirm onCancel />

const TYPE_META = {
  success: { Icon: CircleCheck, color: '#166534', bg: '#dcfce7', bar: '#10b981', title: 'Success' },
  error: { Icon: CircleX, color: '#991b1b', bg: '#fee2e2', bar: '#ef4444', title: 'Not saved' },
  warning: { Icon: TriangleAlert, color: '#92400e', bg: '#fef3c7', bar: '#f59e0b', title: 'Please check' }
};

// Closes on Escape
const useEscape = (active, onClose) => {
  useEffect(() => {
    if (!active) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, onClose]);
};

export function ResultDialog({ result, onClose, actionLabel, onAction }) {
  useEscape(Boolean(result), onClose);
  if (!result) return null;
  const meta = TYPE_META[result.type] || TYPE_META.success;
  const { Icon } = meta;
  return (
    <div style={d.overlay} onClick={onClose}>
      <div
        role="alertdialog" aria-modal="true" aria-labelledby="result-dialog-title"
        style={{ ...d.card, borderTop: `4px solid ${meta.bar}` }}
        onClick={(e) => e.stopPropagation()}
      >
        <button type="button" onClick={onClose} style={d.close} aria-label="Close"><X size={18} /></button>
        <div style={d.head}>
          <span style={{ ...d.iconWrap, background: meta.bg }}><Icon size={26} color={meta.color} /></span>
          <h2 id="result-dialog-title" style={{ ...d.title, color: meta.color }}>{result.title || meta.title}</h2>
        </div>
        <p style={d.message}>{result.message}</p>
        <div style={d.actions}>
          {actionLabel && onAction && (
            <button type="button" onClick={onAction} style={d.secondary}>{actionLabel}</button>
          )}
          <button type="button" onClick={onClose} style={{ ...d.primary, background: meta.bar }} autoFocus>OK</button>
        </div>
      </div>
    </div>
  );
}

export function ConfirmDialog({ open, title, message, confirmLabel = 'Confirm', danger = false, busy = false, onConfirm, onCancel }) {
  useEscape(open && !busy, onCancel);
  if (!open) return null;
  return (
    <div style={d.overlay} onClick={busy ? undefined : onCancel}>
      <div
        role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title"
        style={{ ...d.card, borderTop: `4px solid ${danger ? '#ef4444' : '#4f46e5'}` }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={d.head}>
          <span style={{ ...d.iconWrap, background: danger ? '#fee2e2' : '#e0e7ff' }}>
            <TriangleAlert size={26} color={danger ? '#991b1b' : '#4f46e5'} />
          </span>
          <h2 id="confirm-dialog-title" style={{ ...d.title, color: '#0f172a' }}>{title}</h2>
        </div>
        <p style={d.message}>{message}</p>
        <div style={d.actions}>
          <button type="button" onClick={onCancel} style={d.secondary} disabled={busy}>Cancel</button>
          <button
            type="button" onClick={onConfirm} disabled={busy} autoFocus
            style={{ ...d.primary, background: danger ? '#ef4444' : '#4f46e5' }}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

const d = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(15, 23, 42, 0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem', zIndex: 100 },
  card: { position: 'relative', background: '#fff', padding: '1.5rem', borderRadius: '0.5rem', width: '100%', maxWidth: '440px', boxShadow: '0 10px 25px -5px rgba(0,0,0,0.25)', textAlign: 'left' },
  close: { position: 'absolute', top: '0.75rem', right: '0.75rem', background: 'none', border: 'none', cursor: 'pointer', color: '#64748b' },
  head: { display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem', paddingRight: '1.5rem' },
  iconWrap: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: '44px', height: '44px', borderRadius: '50%', flexShrink: 0 },
  title: { fontSize: '1.15rem', margin: 0 },
  message: { fontSize: '0.9rem', color: '#334155', lineHeight: 1.5, margin: '0 0 1.25rem', whiteSpace: 'pre-line' },
  actions: { display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' },
  primary: { padding: '0.6rem 1.25rem', color: '#fff', border: 'none', borderRadius: '0.375rem', cursor: 'pointer', fontWeight: 'bold', fontSize: '0.875rem' },
  secondary: { padding: '0.6rem 1.25rem', background: '#fff', color: '#334155', border: '1px solid #cbd5e1', borderRadius: '0.375rem', cursor: 'pointer', fontWeight: 'bold', fontSize: '0.875rem' }
};
