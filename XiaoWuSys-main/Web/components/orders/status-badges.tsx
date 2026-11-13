// Production and payment status badges. The label is the server's value; the look comes from
// lib/ui-tokens.ts. An unknown value still renders, in a neutral look.
import { Badge } from '@/components/ui/badge';
import { lookFor, ORDER_STATUS, PAYMENT_STATUS, TONE_CLASSES } from '@/lib/ui-tokens';
import { cn } from '@/lib/utils';

function StateBadge({ value, look }: { value: string; look: ReturnType<typeof lookFor> }) {
  const Icon = look.icon;
  return (
    <Badge variant="outline" className={cn('gap-1', TONE_CLASSES[look.tone].badge)}>
      <Icon className="size-3" aria-hidden />
      {value}
    </Badge>
  );
}

export function OrderStatusBadge({ status }: { status: string }) {
  return <StateBadge value={status} look={lookFor(ORDER_STATUS, status)} />;
}

export function PaymentStatusBadge({ status }: { status: string | null | undefined }) {
  if (!status) return null;
  return <StateBadge value={status} look={lookFor(PAYMENT_STATUS, status)} />;
}
