'use client';

// Login (ported from the App.jsx login form). Lockout, offline-login and wrong-password texts
// all come from the server. Public sign-up does not exist: an Admin creates accounts.
import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { LogIn, Printer } from 'lucide-react';
import { HOME_PATH } from '@/components/layout/nav-items';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useSession } from '@/hooks/use-session';
import { getEndedNotice } from '@/lib/session';
import { TONE_CLASSES } from '@/lib/ui-tokens';
import { cn } from '@/lib/utils';

// Only same-site paths, so ?next= can't send someone to another website after login
const safeNext = (value: string | null): string =>
  value && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\') && !value.startsWith('/login')
    ? value
    : HOME_PATH;

export function LoginForm() {
  const { status, login } = useSession();
  const router = useRouter();
  const next = safeNext(useSearchParams().get('next'));

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice] = useState(getEndedNotice); // e.g. "Your session has expired…"

  // Already signed in (or just signed in): go to the app
  useEffect(() => {
    if (status === 'signed_in') router.replace(next);
  }, [status, router, next]);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    const result = await login(username, password);
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setPassword('');
  };

  return (
    <main className="flex min-h-dvh items-center justify-center bg-muted/30 px-4 py-10">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-xl">
            <Printer className="size-5 text-primary" aria-hidden />
            XiaoMei ERP
          </CardTitle>
          <CardDescription>Log in to continue.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            {(error || notice) && (
              <p
                role="alert"
                className={cn('rounded-md border p-3 text-sm', TONE_CLASSES[error ? 'danger' : 'warning'].banner)}
              >
                {error || notice}
              </p>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="login-username">Username or email</Label>
              <Input
                id="login-username"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="login-password">Password</Label>
              <Input
                id="login-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            <Button type="submit" className="w-full" size="lg" disabled={busy || status === 'loading'}>
              <LogIn aria-hidden />
              {busy ? 'Logging in…' : 'Log in'}
            </Button>
          </form>
        </CardContent>
        <CardFooter className="justify-center text-sm text-muted-foreground">
          Need an account? Ask an Admin to create one for you.
        </CardFooter>
      </Card>
    </main>
  );
}
