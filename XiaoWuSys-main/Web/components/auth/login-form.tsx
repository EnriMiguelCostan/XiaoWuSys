'use client';

// Login (ported from the App.jsx login form). Lockout, offline-login and wrong-password texts
// all come from the server. Public sign-up does not exist: an Admin creates accounts.
import { useEffect, useState } from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { Eye, EyeOff, LogIn } from 'lucide-react';
import { APP_NAME, BrandLogo } from '@/components/brand/brand-logo';
import { HOME_PATH } from '@/components/layout/nav-items';
import { ThemeToggle } from '@/components/layout/theme-toggle';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useSession } from '@/hooks/use-session';
import { TEXT_MAX } from '@/lib/input-limits';
import { getEndedNotice } from '@/lib/session';
import { TONE_CLASSES } from '@/lib/ui-tokens';
import { cn } from '@/lib/utils';

export function LoginForm() {
  const { status, login } = useSession();
  const router = useRouter();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice] = useState(getEndedNotice); // e.g. "Your session has expired…"

  // Already signed in (or just signed in): every login lands on the Dashboard
  useEffect(() => {
    if (status === 'signed_in') router.replace(HOME_PATH);
  }, [status, router]);

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
    setShowPassword(false);
  };

  // Warn about Caps Lock while typing the password (a common cause of "wrong password")
  const trackCapsLock = (e: React.KeyboardEvent<HTMLInputElement>) => setCapsLock(e.getModifierState('CapsLock'));

  return (
    <main className="relative isolate flex min-h-dvh items-center justify-center overflow-hidden px-4 py-10">
      {/* Shop photo, slightly blurred so it reads as atmosphere, not content. scale-105 hides the
          soft edges the blur leaves at the borders of the screen. */}
      <Image
        src="/brand/login-background.webp"
        alt=""
        fill
        preload
        sizes="100vw"
        className="-z-20 scale-105 object-cover blur-[3px]"
      />
      {/* Theme-tinted veil: keeps text contrast readable on top of the photo in both themes */}
      <div className="absolute inset-0 -z-10 bg-background/35 dark:bg-background/55" aria-hidden />

      {/* Light / dark switch, same as in the app header. A frosted pill keeps it readable on the photo. */}
      <div className="absolute top-4 right-4 rounded-full bg-card/80 shadow-md ring-1 ring-foreground/10 backdrop-blur-md">
        <ThemeToggle className="rounded-full" />
      </div>

      <Card className="w-full max-w-md gap-6 bg-card/80 shadow-2xl ring-foreground/10 backdrop-blur-md [--card-spacing:--spacing(6)] supports-[backdrop-filter]:bg-card/75 sm:[--card-spacing:--spacing(8)]">
        <CardHeader className="justify-items-center gap-2 text-center">
          <BrandLogo className="mb-2 h-20" />
          <CardTitle as="h1" className="text-2xl font-semibold tracking-tight">{APP_NAME}</CardTitle>
          <CardDescription>Log in to continue.</CardDescription>
        </CardHeader>

        <CardContent>
          <form onSubmit={submit} className="space-y-5">
            {(error || notice) && (
              <p
                role="alert"
                className={cn('rounded-md border p-3 text-sm', TONE_CLASSES[error ? 'danger' : 'warning'].banner)}
              >
                {error || notice}
              </p>
            )}

            <div className="space-y-2">
              {/* Accounts have a username only (the server matches it exactly; there is no email) */}
              <Label htmlFor="login-username">Username</Label>
              <Input
                id="login-username"
                className="h-10 bg-background/70 dark:bg-input/40"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={TEXT_MAX.username}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                autoFocus
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="login-password">Password</Label>
              <div className="relative">
                <Input
                  id="login-password"
                  className="h-10 bg-background/70 pr-11 dark:bg-input/40"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  maxLength={TEXT_MAX.password}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={trackCapsLock}
                  onKeyUp={trackCapsLock}
                  onBlur={() => setCapsLock(false)}
                  aria-describedby={capsLock ? 'login-capslock' : undefined}
                  required
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute inset-y-0 right-1 my-auto text-muted-foreground hover:text-foreground"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  aria-pressed={showPassword}
                  aria-controls="login-password"
                  title={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
                </Button>
              </div>
              {capsLock && (
                <p id="login-capslock" className="text-xs text-muted-foreground" role="status">
                  Caps Lock is on.
                </p>
              )}
            </div>

            <Button type="submit" className="h-10 w-full text-sm" disabled={busy || status === 'loading'}>
              <LogIn aria-hidden />
              {busy ? 'Logging in…' : 'Log in'}
            </Button>
          </form>
        </CardContent>

        <CardFooter className="justify-center bg-muted/40 text-center text-sm text-muted-foreground">
          Need an account? Ask an Admin to create one for you.
        </CardFooter>
      </Card>
    </main>
  );
}
