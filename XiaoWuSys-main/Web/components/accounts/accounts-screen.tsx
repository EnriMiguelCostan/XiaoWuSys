'use client';

// Accounts (ported from UsersPage.jsx): create accounts, change roles, reset forgotten
// passwords, deactivate people who left. Owner / Admin only (manage_accounts; the page is
// wrapped in RequireCapability and Express answers 403 to anyone else).
//   GET   /api/auth/users                       -> { source, users, assignable_roles }
//   POST  /api/auth/register                    create
//   PATCH /api/auth/users/:id                   { role } or { is_active }
//   POST  /api/auth/users/:id/reset-password    { new_password }
//
// The server enforces every rule (password strength, who may manage whom, not changing
// yourself) and its message is shown as is. Which rows offer actions is read from the server's
// answer, never from role names: "assignable_roles" lists the roles this account may manage
// (it includes Owner only for an Owner), and your own row is matched by user_id.
// Account changes are online only (503 otherwise), so writes are switched off while the list
// came from this computer's copy or the connection bar says the cloud or server is unreachable.
// Every server answer (success or refusal) ends in a ResultDialog.
import { useCallback, useEffect, useState } from 'react';
import { CloudOff, KeyRound, RefreshCw, UserCheck, UserPlus, Users, UserX } from 'lucide-react';
import { formatDateTime } from '@xiaowu/client-core/format';
import { roleHelp } from '@xiaowu/client-core/permissions';
import { useConnection } from '@/components/connection/connection-provider';
import { ConfirmDialog } from '@/components/feedback/confirm-dialog';
import { ResultDialog, type ResultMessage } from '@/components/feedback/result-dialog';
import { Field, FormProblem } from '@/components/forms/form-bits';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useApi } from '@/hooks/use-api';
import { useSession } from '@/hooks/use-session';
import { errorMessage } from '@/lib/api';
import { TEXT_MAX } from '@/lib/input-limits';
import { TONE_CLASSES } from '@/lib/ui-tokens';
import { cn } from '@/lib/utils';

interface Account {
  user_id: string;
  username: string;
  role: string;
  is_active: boolean;
  created_at: string | null;
}

interface AccountList {
  source: 'cloud' | 'local';
  users: Account[];
  assignable_roles: string[];
}

const PASSWORD_HINT = 'At least 8 characters, with a letter and a number.';

// The ⋯ column stays visible when the table scrolls sideways (same as the Catalog)
const STICKY_ACTIONS = 'sticky right-0 z-10 border-l';

type Loaded = { key: string; list: AccountList | null; error: string };

export function AccountsScreen() {
  const api = useApi();
  const { user: me } = useSession();
  const { state: connection } = useConnection();
  const [tick, setTick] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ResultMessage | null>(null);
  const [creating, setCreating] = useState(false);
  const [resetFor, setResetFor] = useState<Account | null>(null);
  const [confirm, setConfirm] = useState<{ account: Account; is_active: boolean } | null>(null);

  const requestKey = String(tick);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    api<AccountList>('GET', '/auth/users').then(({ ok, data }) => {
      if (cancelled) return;
      setLoaded((prev) =>
        ok && Array.isArray(data.users)
          ? { key: requestKey, list: data, error: '' }
          : { key: requestKey, list: prev?.list ?? null, error: errorMessage(data, 'The accounts could not be loaded.') }
      );
    });
    return () => {
      cancelled = true;
    };
  }, [api, requestKey]);

  const loading = !loaded || loaded.key !== requestKey;
  const list = loaded?.list ?? null;
  const error = loaded && loaded.key === requestKey ? loaded.error : '';
  const offline = list?.source === 'local' || connection === 'offline_local' || connection === 'server_down';
  const assignable = list?.assignable_roles ?? [];

  /** Rows this account may act on (the server checks again on every request) */
  const manageable = (a: Account) => !offline && a.user_id !== me?.user_id && assignable.includes(a.role);

  const report = (ok: boolean, data: { message?: string }, title: string, fallback: string) => {
    setResult(ok ? { type: 'success', title, message: data.message ?? title } : { type: 'error', title: 'Not saved', message: errorMessage(data, fallback) });
    if (ok) reload();
  };

  // Radix only calls onValueChange for a different value, so every call is a real change
  const changeRole = async (account: Account, role: string) => {
    setBusy(true);
    const { ok, data } = await api<{ message?: string }>('PATCH', `/auth/users/${encodeURIComponent(account.user_id)}`, { role });
    setBusy(false);
    report(ok, data, 'Role changed', 'The role was not changed.');
  };

  const setActive = async () => {
    if (!confirm) return;
    setBusy(true);
    const { ok, data } = await api<{ message?: string }>('PATCH', `/auth/users/${encodeURIComponent(confirm.account.user_id)}`, {
      is_active: confirm.is_active,
    });
    setBusy(false);
    setConfirm(null);
    report(ok, data, confirm.is_active ? 'Account reactivated' : 'Account deactivated', 'The account was not changed.');
  };

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Users className="size-6" aria-hidden /> Accounts
          </h1>
          <p className="text-sm text-muted-foreground">
            Create staff accounts, change roles, reset forgotten passwords, and deactivate people who left.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setCreating(true)} disabled={offline || !list}>
            <UserPlus aria-hidden /> New account
          </Button>
          <Button variant="outline" onClick={reload} disabled={loading}>
            <RefreshCw className={cn(loading && 'animate-spin')} aria-hidden /> {loading ? 'Loading…' : 'Refresh'}
          </Button>
        </div>
      </div>

      {offline && (
        <p className={cn('flex items-center gap-2 rounded-md border p-3 text-sm', TONE_CLASSES.warning.banner)}>
          <CloudOff className="size-4 shrink-0" aria-hidden /> Offline: you can see the accounts, but changes need the internet.
        </p>
      )}
      {error && (
        <p role="alert" className={cn('rounded-md border p-3 text-sm', TONE_CLASSES.danger.banner)}>
          {error}
        </p>
      )}

      {!list && loading ? (
        <div className="space-y-2 rounded-lg border bg-card p-4" role="status" aria-label="Loading accounts">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : (
        list && (
          <div className={cn('max-w-full min-w-0 overflow-x-auto rounded-lg border bg-card transition-opacity', loading && 'opacity-60')} aria-busy={loading}>
            <Table aria-label="Accounts">
              <TableHeader className="bg-muted">
                <TableRow>
                  <TableHead>Username</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead className="hidden sm:table-cell">Status</TableHead>
                  <TableHead className="hidden md:table-cell">Created</TableHead>
                  <TableHead className={cn(STICKY_ACTIONS, 'w-px bg-muted text-right')}>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.users.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                      No accounts found.
                    </TableCell>
                  </TableRow>
                )}
                {list.users.map((a) => {
                  const isMe = a.user_id === me?.user_id;
                  const canAct = manageable(a);
                  return (
                    <TableRow key={a.user_id} className={cn(!a.is_active && 'text-muted-foreground')}>
                      <TableCell className="max-w-64 min-w-36 whitespace-normal wrap-anywhere">
                        <span className="font-medium">{a.username}</span>
                        {isMe && (
                          <Badge variant="secondary" className="ml-2">
                            you
                          </Badge>
                        )}
                        <Badge variant="outline" className={cn('mt-1 sm:hidden', a.is_active ? TONE_CLASSES.success.badge : TONE_CLASSES.muted.badge)}>
                          {a.is_active ? 'Active' : 'Deactivated'}
                        </Badge>
                      </TableCell>
                      <TableCell className="min-w-32">
                        {canAct && a.is_active ? (
                          <Select value={a.role} onValueChange={(role) => changeRole(a, role)} disabled={busy}>
                            <SelectTrigger size="sm" className="w-36" aria-label={`Role of ${a.username}`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {[...new Set([...assignable, a.role])].map((r) => (
                                <SelectItem key={r} value={r}>
                                  {r}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          a.role
                        )}
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        <Badge variant="outline" className={a.is_active ? TONE_CLASSES.success.badge : TONE_CLASSES.muted.badge}>
                          {a.is_active ? 'Active' : 'Deactivated'}
                        </Badge>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">{formatDateTime(a.created_at, { withTime: false, utc: true })}</TableCell>
                      <TableCell className={cn(STICKY_ACTIONS, 'bg-card text-right')}>
                        {canAct ? (
                          <div className="flex justify-end gap-1.5">
                            <Button variant="outline" size="sm" disabled={busy} onClick={() => setResetFor(a)} aria-label={`Reset the password of ${a.username}`}>
                              <KeyRound aria-hidden /> <span className="hidden lg:inline">Reset password</span>
                            </Button>
                            {a.is_active ? (
                              <Button variant="destructive" size="sm" disabled={busy} onClick={() => setConfirm({ account: a, is_active: false })} aria-label={`Deactivate ${a.username}`}>
                                <UserX aria-hidden /> <span className="hidden lg:inline">Deactivate</span>
                              </Button>
                            ) : (
                              <Button variant="outline" size="sm" disabled={busy} onClick={() => setConfirm({ account: a, is_active: true })} aria-label={`Reactivate ${a.username}`}>
                                <UserCheck aria-hidden /> <span className="hidden lg:inline">Reactivate</span>
                              </Button>
                            )}
                          </div>
                        ) : (
                          <span className="text-xs whitespace-normal text-muted-foreground">
                            {isMe ? 'Use "Change my password" in your account menu' : '—'}
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )
      )}

      {creating && (
        <CreateAccountDialog
          roles={assignable}
          onClose={() => setCreating(false)}
          onResult={setResult}
          onDone={(r) => {
            setCreating(false);
            setResult(r);
            reload();
          }}
        />
      )}
      {resetFor && (
        <ResetPasswordDialog
          account={resetFor}
          onClose={() => setResetFor(null)}
          onResult={setResult}
          onDone={(r) => {
            setResetFor(null);
            setResult(r);
            reload();
          }}
        />
      )}

      <ConfirmDialog
        open={Boolean(confirm)}
        title={confirm?.is_active ? 'Reactivate this account?' : 'Deactivate this account?'}
        message={
          confirm
            ? confirm.is_active
              ? `${confirm.account.username} will be able to log in again.`
              : `${confirm.account.username} will be signed out right away and cannot log in. Their past work stays in the records.`
            : ''
        }
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

// ---------------------------------------------------------------------------------------------
interface AccountDialogProps {
  onClose: () => void;
  /** a refusal: shown in the screen's ResultDialog while this form stays open with its input */
  onResult: (r: ResultMessage) => void;
  /** success: close this form, show the result and reload the list */
  onDone: (r: ResultMessage) => void;
}

function CreateAccountDialog({ roles, onClose, onResult, onDone }: AccountDialogProps & { roles: string[] }) {
  const api = useApi();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setProblem('');
    if (!role) {
      setProblem('Choose a role for the new account.');
      return;
    }
    setBusy(true);
    const { ok, data } = await api<{ message?: string }>('POST', '/auth/register', { username: username.trim(), password, role });
    setBusy(false);
    if (!ok) {
      onResult({ type: 'error', title: 'Account not created', message: errorMessage(data, 'The account was not created.') });
      return;
    }
    onDone({ type: 'success', title: 'Account created', message: data.message ?? 'The account was created.' });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="size-5" aria-hidden /> New account
          </DialogTitle>
          <DialogDescription>Give the person their username and temporary password in person or by private message.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="max-w-full min-w-0 space-y-4">
          <FormProblem message={problem} />
          <Field id="new-username" label="Username *" hint="No spaces, e.g. rin.staff">
            <Input
              id="new-username"
              required
              autoFocus
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={TEXT_MAX.username}
              placeholder="e.g. rin.staff"
              value={username}
              // usernames cannot contain spaces (input format, the server checks too)
              onChange={(e) => setUsername(e.target.value.replace(/\s/g, ''))}
            />
          </Field>
          <Field id="new-password" label="Temporary password *" hint={PASSWORD_HINT}>
            <Input
              id="new-password"
              type="text"
              required
              autoComplete="new-password"
              spellCheck={false}
              maxLength={TEXT_MAX.password}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <Field id="new-role" label="Role *" hint={roleHelp(role) || 'What this person may do.'}>
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger id="new-role" className="w-full">
                <SelectValue placeholder="Choose a role…" />
              </SelectTrigger>
              <SelectContent>
                {roles.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? 'Creating…' : 'Create account'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------
function ResetPasswordDialog({ account, onClose, onResult, onDone }: AccountDialogProps & { account: Account }) {
  const api = useApi();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    const { ok, data } = await api<{ message?: string }>('POST', `/auth/users/${encodeURIComponent(account.user_id)}/reset-password`, {
      new_password: password,
    });
    setBusy(false);
    if (!ok) {
      onResult({ type: 'error', title: 'Password not reset', message: errorMessage(data, 'The password was not reset.') });
      return;
    }
    onDone({ type: 'success', title: 'Password reset', message: data.message ?? 'The password was reset.' });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex min-w-0 items-center gap-2">
            <KeyRound className="size-5 shrink-0" aria-hidden />
            <span className="min-w-0 wrap-anywhere">Reset password for {account.username}</span>
          </DialogTitle>
          <DialogDescription>Tell the person their new password in person or by private message. They will be signed out everywhere.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="max-w-full min-w-0 space-y-4">
          <Field id="reset-password" label="New password *" hint={PASSWORD_HINT}>
            <Input
              id="reset-password"
              type="text"
              required
              autoFocus
              autoComplete="new-password"
              spellCheck={false}
              maxLength={TEXT_MAX.password}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Set new password'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
