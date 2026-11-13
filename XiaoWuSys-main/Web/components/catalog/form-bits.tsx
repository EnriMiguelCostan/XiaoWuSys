// Small layout pieces shared by the catalog dialogs.
import { TriangleAlert } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { TONE_CLASSES } from '@/lib/ui-tokens';
import { cn } from '@/lib/utils';

export function Field({
  id,
  label,
  hint,
  className,
  children,
}: {
  id: string;
  label: string;
  hint?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** The server's plain-language reason, shown next to the form (steering §3.1). */
export function FormProblem({ message, tone = 'danger' }: { message: string; tone?: 'danger' | 'warning' }) {
  if (!message) return null;
  return (
    <p role="alert" className={cn('flex gap-2 rounded-md border p-3 text-sm whitespace-pre-line wrap-anywhere', TONE_CLASSES[tone].banner)}>
      <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      {message}
    </p>
  );
}

/** Suggestions for free-text inputs (<Input list="…">). */
export function Suggestions({ id, values }: { id: string; values: readonly string[] }) {
  return (
    <datalist id={id}>
      {values.map((v) => (
        <option key={v} value={v} />
      ))}
    </datalist>
  );
}
