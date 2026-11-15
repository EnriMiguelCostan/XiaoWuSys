'use client';

// The one date field used everywhere. Same look as <Input>, plus a floor of EARLIEST_DATE
// (2018-01-01) so nobody can pick or keep a date from the 1900s by mistake.
//   - min defaults to EARLIEST_DATE; a later min (e.g. "today" for deadlines) still wins
//   - the browser's calendar greys out everything before min
//   - a year typed by hand that lands before the floor is raised to min when the field loses
//     focus (it fires a normal change, so the page's state follows)
import { Input } from '@/components/ui/input';
import { EARLIEST_DATE } from '@/lib/input-limits';

type DateInputProps = Omit<React.ComponentProps<typeof Input>, 'type'>;

/** Sets an input's value the way typing does, so React's onChange runs. */
function setValueLikeTyping(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

export function DateInput({ min, onBlur, ...props }: DateInputProps) {
  const floor = typeof min === 'string' && min > EARLIEST_DATE ? min : EARLIEST_DATE;

  return (
    <Input
      type="date"
      min={floor}
      onBlur={(e) => {
        const el = e.currentTarget;
        // ISO dates (YYYY-MM-DD) compare correctly as strings
        if (el.value && el.value < EARLIEST_DATE) setValueLikeTyping(el, floor);
        onBlur?.(e);
      }}
      {...props}
    />
  );
}
