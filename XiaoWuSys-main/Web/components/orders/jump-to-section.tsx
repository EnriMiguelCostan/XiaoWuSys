'use client';

// HCI (Norman, gulf of execution): when an action is blocked, the explanation is paired with a
// direct way to the section that resolves it ("Set the quote" -> the Quote section). It only
// moves the view and the keyboard focus; whether the action is allowed is still the server's
// decision (allowed_actions), and nothing here reads or interprets message text.
//
// Migration 015: the order profile is split into tabs, so a jump first asks the profile to open
// the section's tab (the 'xiaowu:order-section' event), then scrolls to it once it is shown.
import { ArrowDown } from 'lucide-react';
import { Button } from '@/components/ui/button';

/** Stable ids of the order profile's sections (set on each <section>) */
export const ORDER_SECTION = {
  quote: 'order-pricing',
  materials: 'order-materials',
  payments: 'order-payments',
  deliveries: 'order-deliveries',
} as const;
export type OrderSectionKey = keyof typeof ORDER_SECTION;

/** Which tab of the order profile holds each section */
export const SECTION_TAB: Record<OrderSectionKey, string> = {
  quote: 'quote',
  materials: 'materials',
  payments: 'payments',
  deliveries: 'deliveries',
};
export const ORDER_SECTION_EVENT = 'xiaowu:order-section';

const LABEL: Record<OrderSectionKey, string> = {
  quote: 'Go to the quote',
  materials: 'Go to materials',
  payments: 'Go to payments',
  deliveries: 'Go to deliveries',
};

/** Opens the section's tab, scrolls to the section and focuses its heading (screen readers announce it) */
export const jumpTo = (key: OrderSectionKey) => {
  window.dispatchEvent(new CustomEvent(ORDER_SECTION_EVENT, { detail: SECTION_TAB[key] }));
  // After the tab has rendered
  setTimeout(() => {
    const section = document.getElementById(ORDER_SECTION[key]);
    if (!section) return;
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const heading = section.querySelector<HTMLElement>('h2, h3');
    if (heading) {
      heading.setAttribute('tabindex', '-1');
      heading.focus({ preventScroll: true });
    }
  }, 60);
};

export function JumpToSection({ to, label }: { to: OrderSectionKey; label?: string }) {
  return (
    <Button type="button" variant="link" size="sm" className="h-auto min-h-0 px-0 text-xs" onClick={() => jumpTo(to)}>
      {label ?? LABEL[to]} <ArrowDown aria-hidden />
    </Button>
  );
}
