// Production and payment status badges. The label is the server's value; the look comes from
// lib/ui-tokens.ts. An unknown value still renders, in a neutral look.
// DeadlineBadge (PB 16) shows the server's deadline_flag; 'normal', closed orders (null) and
// values this version does not know show nothing.
import { Badge } from '@/components/ui/badge';
import { DEADLINE_FLAG, DELIVERY_STATUS, lookFor, ORDER_STATUS, PAYMENT_STATUS, TONE_CLASSES } from '@/lib/ui-tokens';
import { cn } from '@/lib/utils';

function StateBadge({ value, look, count }: { value: string; look: ReturnType<typeof lookFor>; count?: number }) {
  const Icon = look.icon;
  return (
    <Badge variant="outline" className={cn('gap-1', count !== undefined && 'h-6 px-2.5', TONE_CLASSES[look.tone].badge)}>
      <Icon className="size-3" aria-hidden />
      {value}
      {/* Dashboard "Orders by status": the count sits inside the pill, on its right */}
      {count !== undefined && <strong className="ml-1.5 font-semibold tabular-nums">{count.toLocaleString()}</strong>}
    </Badge>
  );
}

export function OrderStatusBadge({ status, count }: { status: string; count?: number }) {
  return <StateBadge value={status} look={lookFor(ORDER_STATUS, status)} count={count} />;
}

export function DeadlineBadge({ flag, className }: { flag: string | null | undefined; className?: string }) {
  const look = flag ? DEADLINE_FLAG[flag] : undefined;
  if (!look) return null;
  const Icon = look.icon;
  return (
    <Badge variant="outline" className={cn('gap-1', TONE_CLASSES[look.tone].badge, className)}>
      <Icon className="size-3" aria-hidden />
      {look.label}
    </Badge>
  );
}

export function PaymentStatusBadge({ status }: { status: string | null | undefined }) {
  if (!status) return null;
  return <StateBadge value={status} look={lookFor(PAYMENT_STATUS, status)} />;
}

/** Migration 016: the server's delivery_status (Orders list) or a planned batch's state */
export function DeliveryStatusBadge({ status }: { status: string | null | undefined }) {
  if (!status) return null;
  return <StateBadge value={status} look={lookFor(DELIVERY_STATUS, status)} />;
}
