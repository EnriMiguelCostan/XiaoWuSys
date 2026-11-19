'use client';

// Pick-or-create field for short free-text values that should stay consistent (the catalog's
// Category and Unit). Replaces the native <datalist>, whose drop-down ignored the app theme (a
// black browser menu in dark mode) and silently turned every typo into a new value.
//
// - The trigger is a button styled like <Input> (same height, border, focus ring, error state).
//   Clicking it always opens the full list and puts the cursor in the search box.
// - Matching ignores case and extra spaces, so "shirts" offers the existing "Shirts" (and "PCS"
//   the existing "pcs") instead of a near-duplicate. "Create" appears only when nothing matches
//   exactly. The current value is always listed, spelled as it is saved, so picking it again is
//   not a change.
// - The pop-up is rendered inside the Dialog (no portal) on purpose: the Dialog's scroll lock
//   only lets the wheel scroll elements inside it, and its focus trap then includes the search box.
// - Keyboard (WAI-ARIA combobox pattern): ArrowDown / ArrowUp move, Home / End jump, Enter picks,
//   Escape closes the list only (Radix closes the top-most layer first, never the Dialog).
//
// The server stays the authority on the saved value (length, spacing, duplicates); this only
// helps the user pick consistently.
import { Fragment, useId, useMemo, useRef, useState } from 'react';
import { Popover as PopoverPrimitive } from 'radix-ui';
import { Check, ChevronsUpDown, Plus, Search } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Collapse runs of spaces and trim, as the saved value will be */
export const tidyText = (text: string) => text.replace(/\s+/g, ' ').trim();
const matchKey = (text: string) => tidyText(text).toLocaleLowerCase('en');

type Option = { kind: 'existing' | 'create'; value: string };

export function CreatableCombobox({
  id,
  value,
  options: choices,
  onChange,
  maxLength,
  noun,
  placeholder = `Select or create ${noun}…`,
  required,
  onMissing,
  disabled,
  'aria-describedby': describedBy,
  'aria-invalid': invalid,
}: {
  id: string;
  value: string;
  /** Existing values (any order, may repeat or be empty; the first spelling of a value wins) */
  options: readonly (string | null | undefined)[];
  onChange: (value: string) => void;
  /** Longest value the server accepts (a TEXT_MAX entry) */
  maxLength: number;
  /** What one value is called, in lower case: "category", "unit" */
  noun: string;
  placeholder?: string;
  /** Blocks the form's submit while empty; onMissing lets the form show its field error */
  required?: boolean;
  onMissing?: () => void;
  disabled?: boolean;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean | 'true' | 'false';
}) {
  const listId = useId();
  const optionId = (i: number) => `${listId}-option-${i}`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  // Unique (ignoring case and spacing), A-Z ignoring case. The current value goes in first so its
  // own spelling wins and it is always listed.
  const sorted = useMemo(() => {
    const seen = new Map<string, string>();
    for (const c of [value, ...choices]) {
      const tidy = tidyText(c ?? '');
      if (tidy && !seen.has(matchKey(tidy))) seen.set(matchKey(tidy), tidy);
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
  }, [value, choices]);

  const typed = tidyText(query);
  const options = useMemo<Option[]>(() => {
    const key = matchKey(typed);
    const found: Option[] = sorted
      .filter((c) => !key || matchKey(c).includes(key))
      .map((c) => ({ kind: 'existing', value: c }));
    const exact = sorted.some((c) => matchKey(c) === key);
    return key && !exact ? [...found, { kind: 'create', value: typed }] : found;
  }, [sorted, typed]);

  const selectedKey = matchKey(value);

  const scrollIntoView = (index: number) => {
    requestAnimationFrame(() => {
      listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: 'nearest' });
    });
  };

  const moveTo = (index: number) => {
    if (options.length === 0) return;
    const next = (index + options.length) % options.length;
    setActive(next);
    scrollIntoView(next);
  };

  const openChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      // Always start from the full list, with the current value highlighted
      setQuery('');
      const current = sorted.findIndex((c) => matchKey(c) === selectedKey);
      setActive(Math.max(current, 0));
      if (current >= 0) scrollIntoView(current);
    }
  };

  const choose = (option: Option | undefined) => {
    if (!option) return;
    onChange(option.value);
    setOpen(false); // Radix then returns focus to the trigger
  };

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        moveTo(active + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        moveTo(active - 1);
        break;
      case 'Home':
        if (options.length) { e.preventDefault(); moveTo(0); }
        break;
      case 'End':
        if (options.length) { e.preventDefault(); moveTo(options.length - 1); }
        break;
      case 'Enter':
        e.preventDefault(); // never submits the surrounding form
        choose(options[active]);
        break;
      case 'Tab':
        setOpen(false);
        break;
    }
  };

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={openChange}>
      <div className="relative min-w-0">
        <PopoverPrimitive.Trigger asChild>
          <button
            ref={triggerRef}
            id={id}
            type="button"
            disabled={disabled}
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-describedby={describedBy}
            // aria-invalid is not valid on a button; the error is read out through aria-describedby
            data-invalid={invalid === true || invalid === 'true' ? '' : undefined}
            className={cn(
              // Same box as components/ui/input.tsx, so the form's fields line up
              'flex h-8 w-full min-w-0 cursor-pointer items-center justify-between gap-2 rounded-lg border border-input bg-transparent py-1 pr-2 pl-2.5 text-left text-base transition-colors outline-none pointer-coarse:h-10 md:text-sm',
              'focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
              'disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50',
              'data-invalid:border-destructive data-invalid:ring-3 data-invalid:ring-destructive/20',
              'dark:bg-input/30 dark:hover:bg-input/50 dark:data-invalid:border-destructive/50 dark:data-invalid:ring-destructive/40'
            )}
          >
            <span className={cn('min-w-0 flex-1 truncate', !value && 'text-muted-foreground')}>{value || placeholder}</span>
            <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          </button>
        </PopoverPrimitive.Trigger>
        {required && (
          // A button cannot be `required`, so this hidden twin carries the value for the browser's
          // form check. Its "invalid" event is cancelled: the form shows the message under the field.
          <input
            tabIndex={-1}
            aria-hidden
            className="sr-only"
            required
            value={value}
            onChange={() => {}}
            onInvalid={(e) => {
              e.preventDefault();
              onMissing?.();
              triggerRef.current?.focus();
            }}
          />
        )}
      </div>

      {/* No PopoverPrimitive.Portal: see the note at the top of this file */}
      <PopoverPrimitive.Content
        align="start"
        sideOffset={4}
        collisionPadding={16}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement).querySelector<HTMLInputElement>('input')?.focus();
        }}
        className={cn(
          'z-50 flex w-(--radix-popover-trigger-width) min-w-60 max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md outline-none',
          'origin-(--radix-popover-content-transform-origin) duration-100 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95'
        )}
      >
        <div className="flex items-center gap-2 border-b border-border px-2.5">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <input
            role="combobox"
            aria-label={`Search or type a new ${noun}`}
            aria-expanded
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={options[active] ? optionId(active) : undefined}
            className="h-9 w-full min-w-0 bg-transparent py-2 text-base outline-none placeholder:text-muted-foreground pointer-coarse:h-10 md:text-sm"
            placeholder={`Search or type a new ${noun}…`}
            maxLength={maxLength}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
              listRef.current?.scrollTo({ top: 0 });
            }}
            onKeyDown={onSearchKeyDown}
          />
        </div>

        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={`${noun} options`}
          className="max-h-60 overflow-y-auto overscroll-contain p-1"
        >
          {options.length === 0 && (
            <p className="px-2 py-3 text-center text-sm text-muted-foreground">
              Nothing to pick yet. Type a name to create one.
            </p>
          )}
          {options.map((option, i) => {
            const creating = option.kind === 'create';
            const selected = !creating && matchKey(option.value) === selectedKey;
            return (
              <Fragment key={creating ? '__create__' : option.value}>
                {creating && i > 0 && <div aria-hidden className="-mx-1 my-1 h-px bg-border" />}
                <div
                  id={optionId(i)}
                  data-index={i}
                  role="option"
                  aria-selected={selected}
                  data-active={i === active || undefined}
                  onMouseMove={() => i !== active && setActive(i)}
                  // Keep focus in the search box while clicking (the list closes on click anyway)
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(option)}
                  className={cn(
                    'flex cursor-pointer items-start gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none pointer-coarse:min-h-10 pointer-coarse:items-center',
                    'data-active:bg-accent data-active:text-accent-foreground',
                    creating && 'font-medium'
                  )}
                >
                  {creating ? (
                    <Plus className="mt-0.5 size-4 shrink-0" aria-hidden />
                  ) : (
                    <Check className={cn('mt-0.5 size-4 shrink-0', !selected && 'invisible')} aria-hidden />
                  )}
                  <span className="min-w-0 flex-1 wrap-anywhere whitespace-normal">
                    {creating ? <>Create &ldquo;{option.value}&rdquo;</> : option.value}
                  </span>
                </div>
              </Fragment>
            );
          })}
        </div>
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Root>
  );
}
