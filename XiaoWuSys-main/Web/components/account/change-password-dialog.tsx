'use client';

// "Change my password" (any signed-in account). Ported from ChangePasswordDialog in
// Frontend/src/UsersPage.jsx. The password rules live on the server: its 400 message is shown
// as is. The only client check is that both new passwords match (input UX, not a rule).
// On success the server returns a fresh token so this device stays signed in; other devices
// are signed out by the server.
import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { errorText } from '@xiaowu/client-core/api';
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
import { Label } from '@/components/ui/label';
import { useApi } from '@/hooks/use-api';
import { useSession } from '@/hooks/use-session';
import { TONE_CLASSES } from '@/lib/ui-tokens';
import { cn } from '@/lib/utils';

const EMPTY_FORM = { current: '', next: '', confirm: '' };

export function ChangePasswordDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const api = useApi();
  const { replaceToken } = useSession();
  const [form, setForm] = useState(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  const close = (next: boolean) => {
    if (busy) return;
    onOpenChange(next);
    if (!next) {
      setForm(EMPTY_FORM);
      setError('');
      setDone('');
    }
  };

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError('');
    if (form.next !== form.confirm) {
      setError('The two new passwords do not match.');
      return;
    }
    setBusy(true);
    const { ok, data } = await api<{ message?: string; token?: string }>('POST', '/auth/change-password', {
      current_password: form.current,
      new_password: form.next,
    });
    setBusy(false);
    if (!ok) {
      setError(errorText(data, 'Your password was not changed.'));
      return;
    }
    if (data.token) replaceToken(data.token);
    setDone(data.message || 'Your password was changed.');
  };

  const field = (key: keyof typeof EMPTY_FORM) => ({
    value: form[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [key]: e.target.value })),
  });

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="size-5" aria-hidden /> Change my password
          </DialogTitle>
          <DialogDescription>
            {done ? 'This device stays signed in.' : 'Other devices signed in to your account will be signed out.'}
          </DialogDescription>
        </DialogHeader>

        {done ? (
          <>
            <p role="status" className={cn('rounded-md border p-3 text-sm', TONE_CLASSES.success.banner)}>
              {done}
            </p>
            <DialogFooter>
              <Button onClick={() => close(false)} autoFocus>
                OK
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            {error && (
              <p role="alert" className={cn('rounded-md border p-3 text-sm', TONE_CLASSES.danger.banner)}>
                {error}
              </p>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="pw-current">Current password</Label>
              <Input id="pw-current" type="password" autoComplete="current-password" required autoFocus {...field('current')} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pw-new">New password</Label>
              <Input id="pw-new" type="password" autoComplete="new-password" required maxLength={72} {...field('next')} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pw-confirm">New password again</Label>
              <Input id="pw-confirm" type="password" autoComplete="new-password" required maxLength={72} {...field('confirm')} />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => close(false)} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? 'Saving…' : 'Change password'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
