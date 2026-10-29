import { useEffect, useMemo, useState } from 'react';
import { UserPlus, RefreshCw, KeyRound, UserX, UserCheck, X, Users, CloudOff } from 'lucide-react';
import { createApi, errorText, formatDateTime } from './api';
import { ResultDialog, ConfirmDialog } from './Dialogs';

// Accounts screen (Owner / Admin). The server enforces every rule; the UI only explains them.
//   GET   /api/auth/users                          list
//   POST  /api/auth/register                       create
//   PATCH /api/auth/users/:id                      role / activate / deactivate
//   POST  /api/auth/users/:id/reset-password       set a new password for someone who forgot it
const ROLE_HELP = {
  Owner: 'Everything, including approving job orders and managing Owners',
  Admin: 'Everything except approving job orders; manages non-Owner accounts',
  Production: 'Catalog, stock and orders (no account management)',
  Staff: 'View the catalog and orders only'
};
const EMPTY_NEW = { username: '', password: '', role: 'Staff' };

// Same rule as the server: 8+ characters with a letter and a number
const passwordHint = (pw) => {
  if (!pw) return '';
  if (pw.length < 8) return `${pw.length} of 8 characters`;
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Add at least one letter and one number';
  return '✓ Strong enough';
};
const passwordOk = (pw) => passwordHint(pw) === '✓ Strong enough';

export default function UsersPage({ apiBase, token, currentUser, onUnauthorized }) {
  const api = useMemo(() => createApi({ apiBase, token, onUnauthorized }), [apiBase, token, onUnauthorized]);
  const [data, setData] = useState({ users: [], assignable_roles: [], source: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const [form, setForm] = useState(EMPTY_NEW);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [confirm, setConfirm] = useState(null); // { user, is_active }
  const [resetFor, setResetFor] = useState(null); // { user, password }

  useEffect(() => {
    let cancelled = false;
    api('GET', '/auth/users').then(({ ok, data: body }) => {
      if (cancelled) return;
      setLoading(false);
      if (!ok) return setError(errorText(body, 'The accounts could not be loaded.'));
      setError('');
      setData(body);
    });
    return () => { cancelled = true; };
  }, [api, tick]);
  const reload = () => { setLoading(true); setTick((t) => t + 1); };

  const report = (ok, body, title, fallback) => {
    setResult(ok ? { type: 'success', title, message: body.message } : { type: 'error', title: 'Not saved', message: errorText(body, fallback) });
    if (ok) reload();
  };

  const createUser = async (e) => {
    e.preventDefault();
    if (!passwordOk(form.password)) {
      return setResult({ type: 'error', title: 'Check the password', message: 'The password must be at least 8 characters and contain a letter and a number.' });
    }
    setBusy(true);
    const { ok, data: body } = await api('POST', '/auth/register', { username: form.username.trim(), password: form.password, role: form.role });
    setBusy(false);
    report(ok, body, 'Account created', 'The account was not created.');
    if (ok) setForm(EMPTY_NEW);
  };

  const changeRole = async (user, role) => {
    setBusy(true);
    const { ok, data: body } = await api('PATCH', `/auth/users/${encodeURIComponent(user.user_id)}`, { role });
    setBusy(false);
    report(ok, body, 'Role changed', 'The role was not changed.');
  };

  const setActive = async () => {
    const { user, is_active } = confirm;
    setBusy(true);
    const { ok, data: body } = await api('PATCH', `/auth/users/${encodeURIComponent(user.user_id)}`, { is_active });
    setBusy(false);
    setConfirm(null);
    report(ok, body, is_active ? 'Account reactivated' : 'Account deactivated', 'The account was not changed.');
  };

  const resetPassword = async (e) => {
    e.preventDefault();
    if (!passwordOk(resetFor.password)) {
      return setResult({ type: 'error', title: 'Check the password', message: 'The password must be at least 8 characters and contain a letter and a number.' });
    }
    setBusy(true);
    const { ok, data: body } = await api('POST', `/auth/users/${encodeURIComponent(resetFor.user.user_id)}/reset-password`, { new_password: resetFor.password });
    setBusy(false);
    report(ok, body, 'Password reset', 'The password was not reset.');
    if (ok) setResetFor(null);
  };

  const offline = data.source === 'local';
  const canManage = (u) => u.user_id !== currentUser?.user_id && (u.role !== 'Owner' || currentUser?.role === 'Owner');

  return (
    <div style={u.root}>
      <div style={u.topBar}>
        <div>
          <h2 style={u.title}><Users size={20} /> Accounts</h2>
          <p style={u.meta}>Create staff accounts, change roles, reset forgotten passwords, and deactivate people who left.</p>
        </div>
        <button type="button" onClick={reload} style={u.btn} disabled={loading}><RefreshCw size={16} /> {loading ? 'Loading…' : 'Refresh'}</button>
      </div>

      {offline && <p style={{ ...u.banner, ...u.warn }}><CloudOff size={16} /> Offline: you can see the accounts, but changes need the internet.</p>}
      {error && <p style={{ ...u.banner, ...u.errorBanner }}>{error}</p>}

      <form onSubmit={createUser} style={u.panel}>
        <h3 style={u.h3}><UserPlus size={18} /> New account</h3>
        <div style={u.formRow}>
          <label style={u.field}>
            <span style={u.label}>Username *</span>
            <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value.replace(/\s/g, '') })}
              required maxLength={100} autoComplete="off" placeholder="e.g. rin.staff" style={u.input} />
          </label>
          <label style={u.field}>
            <span style={u.label}>Temporary password *</span>
            <input type="text" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })}
              required maxLength={72} autoComplete="new-password" placeholder="8+ characters, letter + number" style={u.input} />
            <span style={{ ...u.hint, color: passwordOk(form.password) ? '#166534' : '#92400e' }}>{passwordHint(form.password)}</span>
          </label>
          <label style={u.field}>
            <span style={u.label}>Role *</span>
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} style={u.input}>
              {(data.assignable_roles.length ? data.assignable_roles : ['Admin', 'Production', 'Staff']).map((r) => <option key={r} value={r} style={u.option}>{r}</option>)}
            </select>
            <span style={u.hint}>{ROLE_HELP[form.role]}</span>
          </label>
        </div>
        <button type="submit" style={u.btnPrimary} disabled={busy || offline}><UserPlus size={16} /> Create account</button>
      </form>

      <div style={u.tableWrap}>
        <table style={u.table}>
          <thead>
            <tr><th style={u.th}>Username</th><th style={u.th}>Role</th><th style={u.th}>Status</th><th style={u.th}>Created</th><th style={u.th}>Actions</th></tr>
          </thead>
          <tbody>
            {data.users.map((x) => {
              const manageable = canManage(x) && !offline;
              return (
                <tr key={x.user_id} style={x.is_active ? undefined : { opacity: 0.65 }}>
                  <td style={u.td}><strong>{x.username}</strong>{x.user_id === currentUser?.user_id && <span style={u.you}>you</span>}</td>
                  <td style={u.td}>
                    {manageable && x.is_active ? (
                      <select value={x.role} onChange={(e) => changeRole(x, e.target.value)} style={{ ...u.input, padding: '0.3rem' }} disabled={busy}
                        aria-label={`Role of ${x.username}`}>
                        {[...new Set([...data.assignable_roles, x.role])].map((r) => <option key={r} value={r} style={u.option}>{r}</option>)}
                      </select>
                    ) : x.role}
                  </td>
                  <td style={u.td}><span style={{ ...u.pill, ...(x.is_active ? u.pillOn : u.pillOff) }}>{x.is_active ? 'Active' : 'Deactivated'}</span></td>
                  <td style={u.td}>{formatDateTime(x.created_at, { withTime: false, utc: true })}</td>
                  <td style={u.td}>
                    {manageable ? (
                      <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                        <button type="button" style={u.small} disabled={busy} onClick={() => setResetFor({ user: x, password: '' })}><KeyRound size={14} /> Reset password</button>
                        {x.is_active
                          ? <button type="button" style={{ ...u.small, color: '#b91c1c', borderColor: '#fecaca' }} disabled={busy} onClick={() => setConfirm({ user: x, is_active: false })}><UserX size={14} /> Deactivate</button>
                          : <button type="button" style={u.small} disabled={busy} onClick={() => setConfirm({ user: x, is_active: true })}><UserCheck size={14} /> Reactivate</button>}
                      </div>
                    ) : <span style={u.meta}>{x.user_id === currentUser?.user_id ? 'Use "Change password" at the top' : '—'}</span>}
                  </td>
                </tr>
              );
            })}
            {!loading && data.users.length === 0 && <tr><td style={u.td} colSpan={5}>No accounts found.</td></tr>}
          </tbody>
        </table>
      </div>

      {resetFor && (
        <div style={u.overlay} onClick={busy ? undefined : () => setResetFor(null)}>
          <form role="dialog" aria-modal="true" aria-labelledby="reset-title" style={u.modal} onSubmit={resetPassword} onClick={(e) => e.stopPropagation()}>
            <div style={u.modalHead}>
              <h3 id="reset-title" style={u.h3}><KeyRound size={18} /> Reset password for {resetFor.user.username}</h3>
              <button type="button" onClick={() => setResetFor(null)} style={u.close} aria-label="Close"><X size={18} /></button>
            </div>
            <p style={u.meta}>Tell the person their new password in person or by private message. They will be signed out everywhere.</p>
            <input type="text" value={resetFor.password} onChange={(e) => setResetFor({ ...resetFor, password: e.target.value })}
              autoFocus maxLength={72} placeholder="New password" style={{ ...u.input, marginTop: '0.75rem' }} autoComplete="new-password" />
            <span style={{ ...u.hint, color: passwordOk(resetFor.password) ? '#166534' : '#92400e' }}>{passwordHint(resetFor.password)}</span>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1rem' }}>
              <button type="button" style={u.btn} onClick={() => setResetFor(null)} disabled={busy}>Cancel</button>
              <button type="submit" style={u.btnPrimary} disabled={busy}>{busy ? 'Saving…' : 'Set new password'}</button>
            </div>
          </form>
        </div>
      )}

      <ConfirmDialog
        open={Boolean(confirm)}
        title={confirm?.is_active ? 'Reactivate this account?' : 'Deactivate this account?'}
        message={confirm ? (confirm.is_active
          ? `${confirm.user.username} will be able to log in again.`
          : `${confirm.user.username} will be signed out right away and cannot log in. Their past work stays in the records.`) : ''}
        confirmLabel={confirm?.is_active ? 'Reactivate' : 'Deactivate'}
        danger={!confirm?.is_active}
        busy={busy}
        onConfirm={setActive}
        onCancel={() => setConfirm(null)}
      />
      <ResultDialog result={result} onClose={() => setResult(null)} />
    </div>
  );
}

// "Change my password" (any logged-in user). onChanged(newToken) keeps this device logged in.
export function ChangePasswordDialog({ apiBase, token, onUnauthorized, onClose, onChanged }) {
  const api = useMemo(() => createApi({ apiBase, token, onUnauthorized }), [apiBase, token, onUnauthorized]);
  const [form, setForm] = useState({ current: '', next: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (!passwordOk(form.next)) return setError('The new password must be at least 8 characters and contain a letter and a number.');
    if (form.next !== form.confirm) return setError('The two new passwords do not match.');
    setBusy(true);
    const { ok, data } = await api('POST', '/auth/change-password', { current_password: form.current, new_password: form.next });
    setBusy(false);
    if (!ok) return setError(errorText(data, 'Your password was not changed.'));
    setDone(data.message);
    onChanged(data.token);
  };

  return (
    <div style={u.overlay} onClick={busy ? undefined : onClose}>
      <form role="dialog" aria-modal="true" aria-labelledby="pw-title" style={u.modal} onSubmit={submit} onClick={(e) => e.stopPropagation()}>
        <div style={u.modalHead}>
          <h3 id="pw-title" style={u.h3}><KeyRound size={18} /> Change my password</h3>
          <button type="button" onClick={onClose} style={u.close} aria-label="Close"><X size={18} /></button>
        </div>
        {done ? (
          <>
            <p style={{ ...u.banner, background: '#dcfce7', color: '#166534' }}>{done}</p>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}><button type="button" style={u.btnPrimary} onClick={onClose}>OK</button></div>
          </>
        ) : (
          <>
            {error && <p style={{ ...u.banner, ...u.errorBanner }}>{error}</p>}
            <label style={u.field}><span style={u.label}>Current password</span>
              <input type="password" value={form.current} onChange={(e) => setForm({ ...form, current: e.target.value })} required autoComplete="current-password" style={u.input} autoFocus />
            </label>
            <label style={{ ...u.field, marginTop: '0.5rem' }}><span style={u.label}>New password</span>
              <input type="password" value={form.next} onChange={(e) => setForm({ ...form, next: e.target.value })} required maxLength={72} autoComplete="new-password" style={u.input} />
              <span style={{ ...u.hint, color: passwordOk(form.next) ? '#166534' : '#92400e' }}>{passwordHint(form.next)}</span>
            </label>
            <label style={{ ...u.field, marginTop: '0.5rem' }}><span style={u.label}>New password again</span>
              <input type="password" value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} required maxLength={72} autoComplete="new-password" style={u.input} />
            </label>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1rem' }}>
              <button type="button" style={u.btn} onClick={onClose} disabled={busy}>Cancel</button>
              <button type="submit" style={u.btnPrimary} disabled={busy}>{busy ? 'Saving…' : 'Change password'}</button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}

const control = { color: '#0f172a', backgroundColor: '#fff', colorScheme: 'light' };
const u = {
  root: { textAlign: 'left' },
  topBar: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: '1rem', flexWrap: 'wrap', marginBottom: '1rem' },
  title: { display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '1.25rem', margin: 0, color: '#08060d' },
  meta: { fontSize: '0.8rem', color: '#64748b', margin: '0.25rem 0 0' },
  banner: { display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.7rem', borderRadius: '0.375rem', margin: '0 0 1rem', fontSize: '0.875rem' },
  warn: { background: '#fef3c7', color: '#92400e' },
  errorBanner: { background: '#fee2e2', color: '#991b1b' },
  panel: { background: '#fff', border: '1px solid #e2e8f0', borderRadius: '0.5rem', padding: '1rem', marginBottom: '1rem' },
  h3: { display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '1rem', margin: '0 0 0.6rem', color: '#0f172a' },
  formRow: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0.75rem', marginBottom: '0.75rem' },
  field: { display: 'flex', flexDirection: 'column', gap: '0.25rem' },
  label: { fontSize: '0.8rem', fontWeight: 'bold', color: '#334155' },
  hint: { fontSize: '0.75rem', color: '#64748b', minHeight: '1em' },
  input: { ...control, width: '100%', padding: '0.55rem 0.7rem', border: '1px solid #cbd5e1', borderRadius: '0.375rem', fontSize: '0.875rem', boxSizing: 'border-box' },
  option: { color: '#0f172a', backgroundColor: '#fff' },
  btn: { display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.5rem 0.9rem', background: '#fff', border: '1px solid #cbd5e1', borderRadius: '0.375rem', cursor: 'pointer', color: '#4f46e5', fontWeight: 'bold', fontSize: '0.85rem' },
  btnPrimary: { display: 'flex', alignItems: 'center', gap: '0.35rem', padding: '0.55rem 1rem', background: '#4f46e5', border: 'none', borderRadius: '0.375rem', cursor: 'pointer', color: '#fff', fontWeight: 'bold', fontSize: '0.85rem' },
  small: { display: 'flex', alignItems: 'center', gap: '0.25rem', padding: '0.3rem 0.6rem', background: '#fff', border: '1px solid #c7d2fe', borderRadius: '0.375rem', cursor: 'pointer', color: '#4338ca', fontWeight: 'bold', fontSize: '0.75rem' },
  tableWrap: { background: '#fff', border: '1px solid #e2e8f0', borderRadius: '0.5rem', overflowX: 'auto' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' },
  th: { textAlign: 'left', padding: '0.6rem', borderBottom: '1px solid #e2e8f0', color: '#334155', whiteSpace: 'nowrap' },
  td: { padding: '0.6rem', borderBottom: '1px solid #f1f5f9', color: '#0f172a', verticalAlign: 'middle' },
  you: { marginLeft: '0.4rem', padding: '0.05rem 0.4rem', background: '#e0e7ff', color: '#4f46e5', borderRadius: '999px', fontSize: '0.65rem', fontWeight: 'bold' },
  pill: { padding: '0.15rem 0.5rem', borderRadius: '999px', fontSize: '0.7rem', fontWeight: 'bold' },
  pillOn: { background: '#dcfce7', color: '#166534' },
  pillOff: { background: '#f1f5f9', color: '#64748b' },
  overlay: { position: 'fixed', inset: 0, background: 'rgba(15, 23, 42, 0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem', zIndex: 80 },
  modal: { background: '#fff', borderRadius: '0.5rem', borderTop: '4px solid #4f46e5', padding: '1.25rem', width: '100%', maxWidth: '440px', boxShadow: '0 10px 25px -5px rgba(0,0,0,0.25)', textAlign: 'left' },
  modalHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  close: { background: 'none', border: 'none', cursor: 'pointer', color: '#64748b' }
};
