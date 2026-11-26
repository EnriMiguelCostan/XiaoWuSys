'use client';

// The one date field used everywhere (November 2026). The browser's own date field shows the
// computer's format (often dd/mm/yyyy) and a calendar that looks different in every browser, so the
// app draws its own: the date is shown and typed as MM/DD/YYYY, and the calendar button opens a
// month view in the app's style. The value given to the page is still ISO (YYYY-MM-DD), so every
// form and the server keep working unchanged.
//   - limited to EARLIEST_DATE..LATEST_DATE (2018-01-01 to 2034-12-31); a later min / earlier max wins
//   - days outside min..max are greyed out; a typed date outside them is moved to the nearest end
//   - onChange is called like a normal input's: (e) => e.target.value is 'YYYY-MM-DD' (or '')
// DateTimeInput: the same, with a time (HH:MM) next to it, for 'YYYY-MM-DDTHH:MM' values.
import { useEffect, useMemo, useState } from 'react';
import { Popover } from 'radix-ui';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EARLIEST_DATE, LATEST_DATE } from '@/lib/input-limits';
import { cn } from '@/lib/utils';

type BaseProps = Omit<React.ComponentProps<typeof Input>, 'type' | 'value' | 'onChange' | 'min' | 'max'> & {
  value?: string;
  min?: string;
  max?: string;
  onChange?: (e: { target: { value: string }; currentTarget: { value: string } }) => void;
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const pad = (n: number) => String(n).padStart(2, '0');
const isoOf = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;
/** 'YYYY-MM-DD' -> 'MM/DD/YYYY' */
const toUs = (iso: string) => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}` : '');
/** 'MM/DD/YYYY' -> 'YYYY-MM-DD' when it is a real date, else null */
const fromUs = (text: string) => {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text.trim());
  if (!m) return null;
  const [mo, d, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return isoOf(y, mo - 1, d);
};
const todayIso = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const event = (value: string) => ({ target: { value }, currentTarget: { value } });

function Calendar({ value, floor, ceiling, onPick }: { value: string; floor: string; ceiling: string; onPick: (iso: string) => void }) {
  const start = value || (todayIso() < floor ? floor : todayIso() > ceiling ? ceiling : todayIso());
  const [view, setView] = useState({ y: Number(start.slice(0, 4)), m: Number(start.slice(5, 7)) - 1 });
  const days = useMemo(() => {
    const first = new Date(Date.UTC(view.y, view.m, 1)).getUTCDay();
    const count = new Date(Date.UTC(view.y, view.m + 1, 0)).getUTCDate();
    return [...Array(first).fill(null), ...Array.from({ length: count }, (_, i) => i + 1)] as (number | null)[];
  }, [view]);
  // Date (UTC) rolls the month over into the next / previous year by itself
  const move = (by: number) => setView((v) => {
    const d = new Date(Date.UTC(v.y, v.m + by, 1));
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() };
  });
  const years = useMemo(() => {
    const list = [];
    for (let y = Number(floor.slice(0, 4)); y <= Number(ceiling.slice(0, 4)); y++) list.push(y);
    return list;
  }, [floor, ceiling]);
  const today = todayIso();

  return (
    <div className="w-72 space-y-2 p-3">
      <div className="flex items-center justify-between gap-1">
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Previous month" onClick={() => move(-1)}>
          <ChevronLeft aria-hidden />
        </Button>
        <div className="flex items-center gap-1">
          <select
            aria-label="Month"
            className="h-8 rounded-md border bg-background px-1 text-sm"
            value={view.m}
            onChange={(e) => setView((v) => ({ ...v, m: Number(e.target.value) }))}
          >
            {MONTHS.map((name, i) => (
              <option key={name} value={i}>
                {name}
              </option>
            ))}
          </select>
          <select
            aria-label="Year"
            className="h-8 rounded-md border bg-background px-1 text-sm"
            value={view.y}
            onChange={(e) => setView((v) => ({ ...v, y: Number(e.target.value) }))}
          >
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </div>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Next month" onClick={() => move(1)}>
          <ChevronRight aria-hidden />
        </Button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-xs text-muted-foreground" aria-hidden>
        {WEEKDAYS.map((d) => (
          <span key={d}>{d}</span>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1" role="grid" aria-label={`${MONTHS[view.m]} ${view.y}`}>
        {days.map((d, i) => {
          if (d === null) return <span key={`blank-${i}`} />;
          const iso = isoOf(view.y, view.m, d);
          const off = iso < floor || iso > ceiling;
          const picked = iso === value;
          return (
            <button
              key={iso}
              type="button"
              disabled={off}
              aria-pressed={picked}
              aria-label={toUs(iso)}
              onClick={() => onPick(iso)}
              className={cn(
                'h-8 rounded-md text-sm tabular-nums transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-30',
                iso === today && !picked && 'font-semibold text-primary ring-1 ring-primary/40',
                picked && 'bg-primary text-primary-foreground hover:bg-primary/90'
              )}
            >
              {d}
            </button>
          );
        })}
      </div>
      <div className="flex justify-between border-t pt-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => onPick('')}>
          Clear
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={today < floor || today > ceiling} onClick={() => onPick(today)}>
          Today
        </Button>
      </div>
    </div>
  );
}

export function DateInput({ value = '', min, max, onChange, onBlur, disabled, className, id, ...props }: BaseProps) {
  // ISO dates (YYYY-MM-DD) compare correctly as strings
  const floor = typeof min === 'string' && min > EARLIEST_DATE ? min : EARLIEST_DATE;
  const ceiling = typeof max === 'string' && max < LATEST_DATE ? max : LATEST_DATE;
  const [text, setText] = useState(toUs(value));
  const [open, setOpen] = useState(false);
  useEffect(() => setText(toUs(value)), [value]);

  const commit = (iso: string) => {
    const clamped = iso && iso < floor ? floor : iso && iso > ceiling ? ceiling : iso;
    setText(toUs(clamped));
    if (clamped !== value) onChange?.(event(clamped));
  };

  return (
    <div className={cn('flex min-w-0 items-center gap-1', className)}>
      <Input
        id={id}
        inputMode="numeric"
        autoComplete="off"
        placeholder="MM/DD/YYYY"
        maxLength={10}
        disabled={disabled}
        value={text}
        onChange={(e) => {
          const next = e.target.value.replace(/[^\d/]/g, '');
          setText(next);
          const iso = fromUs(next);
          if (iso && iso >= floor && iso <= ceiling) onChange?.(event(iso));
          if (next === '') onChange?.(event(''));
        }}
        onBlur={(e) => {
          if (text.trim() === '') commit('');
          else {
            const iso = fromUs(text);
            if (iso) commit(iso);
            else setText(toUs(value)); // not a real date: back to the last good one
          }
          onBlur?.(e);
        }}
        {...props}
      />
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <Button type="button" variant="outline" size="icon" disabled={disabled} aria-label="Open the calendar">
            <CalendarDays aria-hidden />
          </Button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            align="end"
            sideOffset={6}
            className="z-50 rounded-xl border bg-popover text-popover-foreground shadow-lg outline-none data-open:animate-in data-open:fade-in-0"
          >
            <Calendar
              value={value}
              floor={floor}
              ceiling={ceiling}
              onPick={(iso) => {
                commit(iso);
                setOpen(false);
              }}
            />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}

/** A date and a time: value 'YYYY-MM-DDTHH:MM' (like <input type="datetime-local">) */
export function DateTimeInput({ value = '', min, max, onChange, disabled, id, required, className }: BaseProps) {
  const date = value.slice(0, 10);
  const time = value.slice(11, 16);
  const send = (d: string, t: string) => onChange?.(event(d ? `${d}T${t || '00:00'}` : ''));
  return (
    <div className={cn('flex min-w-0 flex-wrap items-center gap-2', className)}>
      <DateInput id={id} required={required} disabled={disabled} value={date} min={min?.slice(0, 10)} max={max?.slice(0, 10)} onChange={(e) => send(e.target.value, time)} className="min-w-0 flex-1" />
      <Input
        aria-label="Time"
        type="time"
        className="w-32"
        disabled={disabled || !date}
        value={time}
        onChange={(e) => send(date, e.target.value)}
      />
    </div>
  );
}
