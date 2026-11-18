'use client';

// HCI (Norman, gulf of execution): when an action is blocked, the explanation is paired with a
// direct way to the section that resolves it ("Set the quote" -> the Quote section). It only
// moves the view and the keyboard focus; whether the action is allowed is still the server's
// decision (allowed_actions), and nothing here reads or interprets message text.
import { ArrowDown } from 'lucide-react';
import { Button } from '@/components/ui/button';

/** Stable ids of the order sheet's sections (set on each <section>) */
export const ORDER_SECTION = {
  quote: 'order-pricing',
  materials: 'order-materials',
  payments: 'order-payments',
} as const;
export type OrderSectionKey = keyof typeof ORDER_SECTION;

const LABEL: Record<OrderSectionKey, string> = {
  quote: 'Go to the quote',
  materials: 'Go to materials',
  payments: 'Go to payments',
};

/** Scrolls the sheet to the section and focuses its heading, so screen readers announce it */
export const jumpTo = (key: OrderSectionKey) => {
  const section = document.getElementById(ORDER_SECTION[key]);
  if (!section) return;
  section.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const heading = section.querySelector<HTMLElement>('h2, h3');
  if (heading) {
    heading.setAttribute('tabindex', '-1');
    heading.focus({ preventScroll: true });
  }
};

export function JumpToSection({ to, label }: { to: OrderSectionKey; label?: string }) {
  return (
    <Button type="button" variant="link" size="sm" className="h-auto min-h-0 px-0 text-xs" onClick={() => jumpTo(to)}>
      {label ?? LABEL[to]} <ArrowDown aria-hidden />
    </Button>
  );
}
