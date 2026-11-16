'use client';

// Draws the pop-up notices from lib/toast.ts. Mounted once, in the root layout.
//   - bottom-centre on phones (above the thumb area), bottom-right on wider screens
//   - screen readers hear them: successes politely (role="status"), errors at once (role="alert")
//   - hovering or focusing a notice pauses its timer; ✕ closes it; motion is skipped for people
//     who ask their system for reduced motion
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { CircleCheck, CircleX, Info, LoaderCircle, TriangleAlert, X } from 'lucide-react';
import { getServerToasts, getToasts, subscribeToasts, toast as toastStore, type Toast, type ToastKind } from '@/lib/toast';
import { cn } from '@/lib/utils';

const LOOK: Record<ToastKind, { icon: typeof CircleCheck; iconClass: string; bar: string }> = {
  success: { icon: CircleCheck, iconClass: 'text-success', bar: 'bg-success' },
  info: { icon: Info, iconClass: 'text-info', bar: 'bg-info' },
  warning: { icon: TriangleAlert, iconClass: 'text-warning', bar: 'bg-warning' },
  error: { icon: CircleX, iconClass: 'text-danger', bar: 'bg-danger' },
  loading: { icon: LoaderCircle, iconClass: 'text-muted-foreground animate-spin motion-reduce:animate-none', bar: 'bg-muted-foreground' },
};

function ToastItem({ item }: { item: Toast }) {
  const look = LOOK[item.kind];
  const Icon = look.icon;
  // Remaining time survives pauses (hover / focus)
  const remaining = useRef(item.duration);
  const startedAt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const start = () => {
    if (remaining.current === null) return;
    startedAt.current = Date.now();
    timer.current = setTimeout(() => toastStore.dismiss(item.id), remaining.current);
  };
  const pause = () => {
    if (!timer.current || remaining.current === null) return;
    clearTimeout(timer.current);
    timer.current = null;
    remaining.current = Math.max(800, remaining.current - (Date.now() - startedAt.current));
  };

  useEffect(() => {
    start();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- start once per notice
  }, []);

  return (
    <li
      role={item.kind === 'error' ? 'alert' : 'status'}
      onMouseEnter={pause}
      onMouseLeave={start}
      onFocus={pause}
      onBlur={start}
      className={cn(
        'pointer-events-auto relative flex w-full items-start gap-3 overflow-hidden rounded-lg border bg-popover p-3 pr-9 text-sm text-popover-foreground shadow-lg',
        'animate-in fade-in-0 slide-in-from-bottom-2 duration-200 motion-reduce:animate-none'
      )}
    >
      <span className={cn('absolute inset-y-0 left-0 w-1', look.bar)} aria-hidden />
      <Icon className={cn('mt-0.5 size-4 shrink-0', look.iconClass)} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-medium wrap-anywhere">{item.title}</p>
        {item.message && <p className="mt-0.5 text-xs whitespace-pre-line text-muted-foreground wrap-anywhere">{item.message}</p>}
      </div>
      {item.kind !== 'loading' && (
        <button
          type="button"
          onClick={() => toastStore.dismiss(item.id)}
          className="absolute top-2 right-2 rounded-sm p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          aria-label="Close notice"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      )}
    </li>
  );
}

export function Toaster() {
  const toasts = useSyncExternalStore(subscribeToasts, getToasts, getServerToasts);
  return (
    <section data-toaster aria-label="Notifications" className="pointer-events-none fixed inset-x-0 bottom-0 z-[100] flex justify-center p-4 sm:justify-end">
      <ol className="flex w-full max-w-sm flex-col gap-2">
        {toasts.map((t) => (
          <ToastItem key={t.id} item={t} />
        ))}
      </ol>
    </section>
  );
}
