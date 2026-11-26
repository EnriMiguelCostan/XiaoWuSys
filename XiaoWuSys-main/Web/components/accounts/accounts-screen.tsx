'use client';

// Accounts (ported from UsersPage.jsx): create accounts, change roles, reset forgotten
// passwords, deactivate people who left. Owner / Admin only (manage_accounts; the page is
// wrapped in RequireCapability and Express answers 403 to anyone else).
//   GET   /api/auth/users?status=active|inactive -> { source, status, users, counts, assignable_roles }
//   POST  /api/auth/register                     create
//   PATCH /api/auth/users/:id                    { role } or { is_active }
//   POST  /api/auth/users/:id/reset-password     { new_password }
//
// One soft-delete workflow, two views: Active and Deactivated. is_active is the only thing that
// decides which view an account is in. Deactivate (Active view) signs the person out everywhere
// and moves the account to Deactivated; Reactivate (Deactivated view) moves it back. Accounts
// are never deleted, so a person's name stays on the orders, payments and changes they made.
// Accounts deactivated by the old "Remove" button are ordinary deactivated accounts here.
//
// The server enforces every rule (password strength, who may manage whom, not changing
// yourself) and its message is shown as is. Which rows offer actions is read from the server's
// answer, never from role names: "assignable_roles" lists the roles this account may manage
// (it includes Owner only for an Owner), and your own row is matched by user_id.
// Account changes are online only (503 otherwise), so writes are switched off while the list
// came from this computer's copy or the connection bar says the cloud or server is unreachable.
// Every server answer goes to ResultDialog: a success becomes a pop-up notice, a refusal a dialog.
import { useCallback, useEffect, useState } from 'react';
import { CloudOff, KeyRound, RefreshCw, UserCheck, UserPlus, Users, UserX } from 'lucide-react';
import { formatDateTime } from '@xiaowu/client-core/format';
import { roleHelp } from '@xiaowu/client-core/permissions';
import { LogoSpinner } from '@/components/brand/brand-logo';
import { useConnection } from '@/components/connection/connection-provider';
import { ConfirmDialog } from '@/components/feedback/confirm-dialog';
import { ResultDialog, type ResultMessage } from '@/components/feedback/result-dialog';
import { bannerText, Field, fieldErrorsMap, FormProblem, RequiredNote } from '@/components/forms/form-bits';
import { PasswordInput } from '@/components/forms/password-input';
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useApi } from '@/hooks/use-api';
import { useSession } from '@/hooks/use-session';
import { errorMessage } from '@/lib/api';
import { TEXT_MAX } from '@/lib/input-limits';
import { TONE_CLASSES } from '@/lib/ui-tokens';
import { cn } from '@/lib/utils';
import { useSubPath } from '@/lib/sub-route';

interface Account {
  user_id: string;
  username: string;
  role: string;
  is_active: boolean;
  created_at: string | null;
}

type AccountView = 'active' | 'inactive';

interface AccountList {
  source: 'cloud' | 'local';
  status: AccountView | 'all';
  users: Account[];
  /** both views, so the switcher can show how many each holds */
  counts?: { active: number; inactive: number; total: number };
  assignable_roles: string[];
}

const PASSWORD_HINT = 'At least 8 characters, with a letter and a number.';

// The actions column stays visible when the table scrolls sideways (same as the Catalog).
// w-px + whitespace-nowrap: the column is exactly as wide as its buttons, never narrower, so the
// buttons can never spill left over its border into the Created column. Opaque backgrounds
// (bg-muted header, bg-card body) keep scrolled cells from showing through it.
const STICKY_ACTIONS = 'sticky right-0 z-10 w-px whitespace-nowrap border-l px-3';
// Buttons in that column keep their one-line width (Button allows wrapping elsewhere)
const ACTION_BUTTON = 'max-w-none whitespace-nowrap';

const VIEW_COPY: Record<AccountView, { note: string; empty: string }> = {
  active: {
    note: 'People who can log in now. Deactivate someone who left: they are signed out everywhere and their account moves to Deactivated.',
    empty: 'No active accounts.',
  },
  inactive: {
    note: 'Deactivated accounts cannot log in. They are kept in the records, so past orders, payments and changes keep their names. Reactivate one anytime.',
    empty: 'No deactivated accounts. When someone leaves, deactivate their account from the Active view; it is kept here.',
  },
};

type Loaded = { key: string; list: AccountList | null; error: string };

export function AccountsScreen() {
  const api = useApi();
  const { user: me } = useSession();
  const { state: connection } = useConnection();
  const [tick, setTick] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ResultMessage | null>(null);
  // New account is its own page at /accounts/new (lib/sub-route.ts)
  const [sub, go] = useSubPath('/accounts');
  const creating = sub?.[0] === 'new';
  const [resetFor, setResetFor] = useState<Account | null>(null);
  const [confirm, setConfirm] = useState<{ account: Account; is_active: boolean } | null>(null);
  const [view, setView] = useState<AccountView>('active');

  const requestKey = `${tick}|${view}`;
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    api<AccountList>('GET', `/auth/users?status=${view}`).then(({ ok, data }) => {
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
  }, [api, requestKey, view]);

  const loading = !loaded || loaded.key !== requestKey;
  const list = loaded?.list ?? null;
  const error = loaded && loaded.key === requestKey ? loaded.error : '';
  const offline = list?.source === 'local' || connection === 'offline_local' || connection === 'server_down';
  const assignable = list?.assignable_roles ?? [];
  const counts = list?.counts;
  // While a switch is loading, the previous view's rows stay on screen (dimmed), never mixed:
  // the rows shown always belong to the view the server answered for.
  const shownView: AccountView = list && list.status !== 'all' ? list.status : view;

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

  // Deactivate (Active view) or Reactivate (Deactivated view). The reload moves the account to
  // the other view and updates both counts.
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

  const viewLabel = (label: string, count: number | undefined) => (
    <>
      {label}
      {count !== undefined && (
        <Badge variant="secondary" className="ml-1 tabular-nums">
          {count}
        </Badge>
      )}
    </>
  );

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Users className="size-6" aria-hidden /> Accounts
          </h1>
          <p className="text-sm text-muted-foreground">
            Create staff accounts, change roles and reset forgotten passwords. Deactivate people who left: their accounts are kept for the records
            and can be reactivated anytime.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => go(['new'])} disabled={offline || !list}>
            <UserPlus aria-hidden /> New account
          </Button>
          <Button variant="outline" onClick={reload} disabled={loading}>
            <RefreshCw className={cn(loading && 'animate-spin')} aria-hidden /> {loading ? 'Loading…' : 'Refresh'}
          </Button>
        </div>
      </div>

      <div className="flex min-w-0 flex-col gap-2">
        <ToggleGroup
          type="single"
          variant="outline"
          value={view}
          onValueChange={(v) => v && setView(v as AccountView)}
          aria-label="Which accounts to show"
          className="flex-wrap"
        >
          <ToggleGroupItem value="active" aria-label={`Active accounts${counts ? `: ${counts.active}` : ''}`}>
            <UserCheck aria-hidden /> {viewLabel('Active', counts?.active)}
          </ToggleGroupItem>
          <ToggleGroupItem value="inactive" aria-label={`Deactivated accounts${counts ? `: ${counts.inactive}` : ''}`}>
            <UserX aria-hidden /> {viewLabel('Deactivated', counts?.inactive)}
          </ToggleGroupItem>
        </ToggleGroup>
        <p className="text-xs text-muted-foreground">{VIEW_COPY[view].note}</p>
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
        <div className="rounded-lg border bg-card">
          <LogoSpinner label="Loading accounts…" />
        </div>
      ) : (
        list && (
          <div className={cn('max-w-full min-w-0 overflow-hidden rounded-lg border bg-card transition-opacity', loading && 'opacity-60')} aria-busy={loading}>
            {/* The Table primitive is the horizontal scroll container; the sticky column sticks to its right edge */}
            <Table aria-label={shownView === 'active' ? 'Active accounts' : 'Deactivated accounts'}>
              <TableHeader className="bg-muted">
                <TableRow>
                  <TableHead>Username</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead className="hidden sm:table-cell">Status</TableHead>
                  <TableHead className="hidden md:table-cell">Created</TableHead>
                  <TableHead className={cn(STICKY_ACTIONS, 'bg-muted text-right')}>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.users.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="py-10 text-left leading-relaxed whitespace-normal text-muted-foreground">
                      {VIEW_COPY[shownView].empty}
                    </TableCell>
                  </TableRow>
                )}
                {list.users.map((a) => {
                  const isMe = a.user_id === me?.user_id;
                  const canAct = manageable(a);
                  const statusBadge = (
                    <Badge variant="outline" className={a.is_active ? TONE_CLASSES.success.badge : TONE_CLASSES.muted.badge}>
                      {a.is_active ? 'Active' : 'Deactivated'}
                    </Badge>
                  );
                  return (
                    <TableRow key={a.user_id} className={cn(!a.is_active && 'text-muted-foreground')}>
                      <TableCell>
                        {/* Width limits sit on this block (a td ignores max-width): long names
                            without spaces wrap here instead of squeezing Created or the actions */}
                        <div className="max-w-64 min-w-36 whitespace-normal wrap-anywhere">
                          <span className="font-medium">{a.username}</span>
                          {isMe && (
                            <Badge variant="secondary" className="ml-2">
                              you
                            </Badge>
                          )}
                          <div className="mt-1 sm:hidden">{statusBadge}</div>
                        </div>
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
                          <span title={!a.is_active && canAct ? 'Reactivate the account to change its role' : undefined}>
                            {a.role}
                            {!a.is_active && canAct && <span className="sr-only"> (reactivate the account to change its role)</span>}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">{statusBadge}</TableCell>
                      <TableCell className="hidden md:table-cell">{formatDateTime(a.created_at, { withTime: false, utc: true })}</TableCell>
                      <TableCell className={cn(STICKY_ACTIONS, 'bg-card text-right')}>
                        {canAct ? (
                          <div className="ml-auto flex w-max flex-nowrap items-center justify-end gap-1.5">
                            <Button
                              variant="outline"
                              size="sm"
                              className={ACTION_BUTTON}
                              disabled={busy}
                              onClick={() => setResetFor(a)}
                              aria-label={`Reset the password of ${a.username}`}
                            >
                              <KeyRound aria-hidden /> <span className="hidden lg:inline">Reset password</span>
                            </Button>
                            {a.is_active ? (
                              <Button
                                variant="destructive"
                                size="sm"
                                className={ACTION_BUTTON}
                                disabled={busy}
                                onClick={() => setConfirm({ account: a, is_active: false })}
                                aria-label={`Deactivate ${a.username}`}
                              >
                                <UserX aria-hidden /> <span className="hidden lg:inline">Deactivate</span>
                              </Button>
                            ) : (
                              <Button
                                variant="outline"
                                size="sm"
                                className={ACTION_BUTTON}
                                disabled={busy}
                                onClick={() => setConfirm({ account: a, is_active: true })}
                                aria-label={`Reactivate ${a.username}`}
                              >
                                <UserCheck aria-hidden /> <span className="hidden lg:inline">Reactivate</span>
                              </Button>
                            )}
                          </div>
                        ) : (
                          <span className="ml-auto block w-44 text-xs whitespace-normal text-muted-foreground">
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

      {/* list: a direct visit to /accounts/new waits for the roles this account may give */}
      {creating && list && !offline && (
        <CreateAccountDialog
          roles={assignable}
          onClose={() => go(null)}
          onResult={setResult}
          onDone={(r) => {
            go(null);
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
              ? `${confirm.account.username} will be able to log in again and moves back to the Active accounts.`
              : `${confirm.account.username} will be signed out right away and cannot log in. The account moves to Deactivated and ` +
                'stays in the records (their name stays on the orders, payments and changes they made). You can reactivate it anytime.'
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
  // Nielsen H9: the server's VALIDATION_FAILED details, shown next to their fields
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setProblem('');
    setFieldErrors({});
    if (!role) {
      setProblem('Choose a role for the new account.');
      return;
    }
    setBusy(true);
    const { ok, data } = await api<{ message?: string }>('POST', '/auth/register', { username: username.trim(), password, role });
    setBusy(false);
    if (!ok) {
      // A field the server named stays in the form, next to that field; anything else is a result message
      const fields = fieldErrorsMap(data);
      if (Object.keys(fields).length > 0) {
        setFieldErrors(fields);
        setProblem(bannerText(data, ['username', 'password', 'role'], 'The account was not created.'));
        return;
      }
      onResult({ type: 'error', title: 'Account not created', message: errorMessage(data, 'The account was not created.') });
      return;
    }
    onDone({ type: 'success', title: 'Account created', message: data.message ?? 'The account was created.' });
  };

  return (
    <Dialog page open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="size-5" aria-hidden /> New account
          </DialogTitle>
          <DialogDescription>Give the person their username and temporary password in person or by private message.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="max-w-full min-w-0 space-y-4">
          <FormProblem message={problem} />
          <RequiredNote />
          <Field id="new-username" label="Username *" error={fieldErrors.username} hint="No spaces, e.g. rin.staff">
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
          <Field id="new-password" label="Temporary password *" error={fieldErrors.password} hint={PASSWORD_HINT}>
            <PasswordInput
              id="new-password"
              required
              autoComplete="new-password"
              spellCheck={false}
              maxLength={TEXT_MAX.password}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <Field id="new-role" label="Role *" error={fieldErrors.role} hint={roleHelp(role) || 'What this person may do.'}>
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
            <Button busy={busy} type="submit" disabled={busy}>
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
  // Nielsen H9: the server's VALIDATION_FAILED details, shown next to their fields
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setFieldErrors({});
    setBusy(true);
    const { ok, data } = await api<{ message?: string }>('POST', `/auth/users/${encodeURIComponent(account.user_id)}/reset-password`, {
      new_password: password,
    });
    setBusy(false);
    if (!ok) {
      const fields = fieldErrorsMap(data);
      if (fields.new_password) {
        setFieldErrors(fields);
        return;
      }
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
          <RequiredNote />
          <Field id="reset-password" label="Enter new password *" error={fieldErrors.new_password} hint={PASSWORD_HINT}>
            <PasswordInput
              id="reset-password"
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
            <Button busy={busy} type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Set new password'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
