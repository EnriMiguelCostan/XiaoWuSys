// ONE place that maps server states to how they look (steering §3.2).
// Replaces CONNECTION_STYLE[state], PAYMENT_STATUS_META and the per-file style objects of the
// Vite MVP. Components never pick colours for states themselves: they look the state up here.
//
// Wording stays in @xiaowu/client-core (connectionText, pendingText, …) so web and mobile say
// the same thing. This file only adds tone and icon.
import type { LucideIcon } from 'lucide-react';
import { CircleCheck, CircleDashed, CircleDot, HardDrive, Loader, ServerCrash, TriangleAlert, Wifi } from 'lucide-react';
import type { ConnectionState } from '@xiaowu/client-core/connection';

export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'muted';

// Semantic colours come from app/state-tokens.css, so dark mode later (N8) needs no changes here.
export const TONE_CLASSES: Record<Tone, { badge: string; banner: string; text: string }> = {
  success: { badge: 'border-success/30 bg-success/10 text-success', banner: 'border-success/30 bg-success/10 text-success', text: 'text-success' },
  warning: { badge: 'border-warning/30 bg-warning/10 text-warning', banner: 'border-warning/30 bg-warning/10 text-warning', text: 'text-warning' },
  danger: { badge: 'border-danger/30 bg-danger/10 text-danger', banner: 'border-danger/30 bg-danger/10 text-danger', text: 'text-danger' },
  info: { badge: 'border-info/30 bg-info/10 text-info', banner: 'border-info/30 bg-info/10 text-info', text: 'text-info' },
  muted: { badge: 'border-border bg-muted text-muted-foreground', banner: 'border-border bg-muted text-muted-foreground', text: 'text-muted-foreground' },
};

interface StateLook {
  tone: Tone;
  icon: LucideIcon;
}

// sync bar (labels: connectionText() in client-core)
export const CONNECTION: Record<ConnectionState, StateLook> = {
  online: { tone: 'success', icon: Wifi },
  offline_local: { tone: 'warning', icon: HardDrive },
  server_down: { tone: 'danger', icon: ServerCrash },
  checking: { tone: 'muted', icon: Loader },
};

// payment_status from the server (D4: separate from production status). The label is the
// server's value itself.
export const PAYMENT_STATUS: Record<string, StateLook> = {
  Unpaid: { tone: 'muted', icon: CircleDashed },
  Partial: { tone: 'info', icon: CircleDot },
  'Fully Paid': { tone: 'success', icon: CircleCheck },
  Overpaid: { tone: 'danger', icon: TriangleAlert },
};

// Unknown values (e.g. a status added on the server later) still render, in a neutral look.
export const UNKNOWN_STATE: StateLook = { tone: 'muted', icon: CircleDashed };

export const lookFor = (table: Record<string, StateLook>, value: string | null | undefined): StateLook =>
  (value && table[value]) || UNKNOWN_STATE;

// ORDER_STATUS, STOCK_STATUS and SYNC_STATUS are added with the screens that show them (M2, M3).
