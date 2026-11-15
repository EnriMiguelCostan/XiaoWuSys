'use client';

// A password field with a show / hide (eye) button, same as the login page. Hidden by default;
// the person can reveal it to check what they typed. Hiding again after a save is up to the
// dialog (it unmounts on close, so a reopened dialog always starts hidden).
import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

type PasswordInputProps = Omit<React.ComponentProps<typeof Input>, 'type'>;

export function PasswordInput({ className, id, disabled, ...props }: PasswordInputProps) {
  const [visible, setVisible] = useState(false);
  const label = visible ? 'Hide password' : 'Show password';

  return (
    <div className="relative min-w-0">
      <Input
        id={id}
        type={visible ? 'text' : 'password'}
        spellCheck={false}
        autoCapitalize="none"
        disabled={disabled}
        className={cn('pr-10', className)}
        {...props}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="absolute inset-y-0 right-0.5 my-auto text-muted-foreground hover:text-foreground"
        onClick={() => setVisible((v) => !v)}
        aria-label={label}
        aria-pressed={visible}
        aria-controls={id}
        title={label}
        disabled={disabled}
      >
        {visible ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
      </Button>
    </div>
  );
}
