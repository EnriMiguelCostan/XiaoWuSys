// One heading block per page: the title (with its icon), one sentence on what the page is for,
// and the page's main actions at the right. The same shape on every page (Nielsen H4: consistency).
import type { LucideIcon } from 'lucide-react';
import { TONE_CLASSES } from '@/lib/ui-tokens';
import { cn } from '@/lib/utils';

export function PageHeader({
  icon: Icon,
  title,
  description,
  actions,
}: {
  icon: LucideIcon;
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0 space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Icon className="size-6 shrink-0" aria-hidden /> {title}
        </h1>
        {description && <p className="max-w-prose text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** A plain message box for a page that could not load (e.g. the stock records need the internet) */
export function LoadProblem({ message }: { message: string }) {
  if (!message) return null;
  return (
    <p role="alert" className={cn('rounded-md border p-3 text-sm', TONE_CLASSES.warning.banner)}>
      {message}
    </p>
  );
}
