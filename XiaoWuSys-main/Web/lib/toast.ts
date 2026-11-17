// Small pop-up notices ("toasts") in the corner of the screen. No dependency: a tiny store that
// any code can call (also lib/api.ts, outside React), drawn by <Toaster /> in the root layout.
//
// When to use what (HCI):
//   - success         -> toast. The action went through; the person keeps working, no extra click.
//   - in progress     -> "Saving…" toast, shown by lib/api.ts only when a save takes a moment.
//   - warning / error -> ResultDialog (stays until read). The person has to know or do something.
//
//   toast.success('Order updated', 'The deadline was changed.')
//   const id = toast.loading('Saving…');  …  toast.dismiss(id)

export type ToastKind = 'success' | 'info' | 'warning' | 'error' | 'loading';

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  message?: string;
  /** ms before it closes by itself; null = stays until dismissed (loading) */
  duration: number | null;
}

const MAX_VISIBLE = 4;
type Listener = () => void;

let toasts: readonly Toast[] = [];
let nextId = 1;
const listeners = new Set<Listener>();

const emit = () => listeners.forEach((l) => l());

/** Long messages stay longer: 4 s plus reading time, at most 10 s. Hover / focus pauses it. */
const readingTime = (title: string, message?: string) =>
  Math.min(10_000, 4_000 + 40 * (title.length + (message?.length ?? 0)));

function show(kind: ToastKind, title: string, message?: string, duration?: number | null): number {
  const id = nextId++;
  const item: Toast = {
    id,
    kind,
    title,
    message: message && message !== title ? message : undefined,
    duration: duration === undefined ? (kind === 'loading' ? null : readingTime(title, message)) : duration,
  };
  toasts = [...toasts, item].slice(-MAX_VISIBLE);
  emit();
  return id;
}

function dismiss(id: number) {
  if (!toasts.some((t) => t.id === id)) return;
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

export const toast = {
  success: (title: string, message?: string) => show('success', title, message),
  info: (title: string, message?: string) => show('info', title, message),
  warning: (title: string, message?: string) => show('warning', title, message),
  error: (title: string, message?: string) => show('error', title, message),
  loading: (title: string, message?: string) => show('loading', title, message),
  dismiss,
};

/**
 * True when a click landed on a notice. Open dialogs and panels use it so that closing a notice
 * (its ✕) never counts as "clicking outside" them.
 */
export const isToastTarget = (target: EventTarget | null) =>
  typeof Element !== 'undefined' && target instanceof Element && Boolean(target.closest('[data-toaster]'));

// For <Toaster /> (useSyncExternalStore)
export const subscribeToasts = (listener: Listener) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const getToasts = () => toasts;
const NO_TOASTS: readonly Toast[] = [];
export const getServerToasts = () => NO_TOASTS;
