'use client';

// The one date field used everywhere (order deadlines, create order, delay, profit and loss,
// overhead expenses). Same look as <Input>, limited to EARLIEST_DATE..LATEST_DATE
// (2018-01-01 to 2034-12-31) so nobody can pick or keep a date like 1900 or 2099 by mistake.
//   - min defaults to EARLIEST_DATE; a later min (e.g. "today" for deadlines) still wins
//   - max defaults to LATEST_DATE; an earlier max still wins
//   - the browser's calendar greys out everything outside min..max
//   - a year typed by hand outside the window is moved to the nearest end of it when the field
//     loses focus (it fires a normal change, so the page's state follows)
import { Input } from '@/components/ui/input';
import { EARLIEST_DATE, LATEST_DATE } from '@/lib/input-limits';

type DateInputProps = Omit<React.ComponentProps<typeof Input>, 'type'>;

/** Sets an input's value the way typing does, so React's onChange runs. */
function setValueLikeTyping(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

export function DateInput({ min, max, onBlur, ...props }: DateInputProps) {
  // ISO dates (YYYY-MM-DD) compare correctly as strings
  const floor = typeof min === 'string' && min > EARLIEST_DATE ? min : EARLIEST_DATE;
  const ceiling = typeof max === 'string' && max < LATEST_DATE ? max : LATEST_DATE;

  return (
    <Input
      type="date"
      min={floor}
      max={ceiling}
      onBlur={(e) => {
        const el = e.currentTarget;
        if (el.value && el.value < EARLIEST_DATE) setValueLikeTyping(el, floor);
        else if (el.value && el.value > LATEST_DATE) setValueLikeTyping(el, ceiling);
        onBlur?.(e);
      }}
      {...props}
    />
  );
}
