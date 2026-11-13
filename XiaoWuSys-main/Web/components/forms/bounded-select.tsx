// Select pieces for lists whose entries can be very long (item names, customer names,
// categories). Long text is cut off with an ellipsis (full text in the tooltip) and the list is
// never wider than the field it opened from, nor than the screen.
//
// Why position="popper": Radix only sets --radix-select-trigger-width in popper mode; the
// default "item-aligned" mode sizes the list to its longest entry.
// Why min-w-0 on the item's last span: that span (ItemText) is a flex item and would not
// shrink below its content, so "truncate" alone never cuts anything.
import { SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { cn } from '@/lib/utils';

// The field itself: never wider than its container. The selected-value span is a flex item
// that would not shrink below its text, pushing the button past a dialog's edge; min-w-0 +
// overflow-hidden let the name inside (truncate, from BoundedSelectItem) end in an ellipsis.
export function BoundedSelectTrigger({ className, ...props }: React.ComponentProps<typeof SelectTrigger>) {
  return (
    <SelectTrigger
      className={cn(
        'w-full max-w-full min-w-0 overflow-hidden *:data-[slot=select-value]:min-w-0 *:data-[slot=select-value]:flex-1 *:data-[slot=select-value]:overflow-hidden',
        className
      )}
      {...props}
    />
  );
}

// The list: exactly as wide as the trigger and lined up with its left edge.
//   w-[var(--radix-select-trigger-width)]  the trigger's width (set by Radix in popper mode)
//   min-w-0       overrides the base min-w-36, which made lists under narrow triggers wider
//   align="start" the base default "center" made any wider list hang off both sides
export function BoundedSelectContent({ className, ...props }: React.ComponentProps<typeof SelectContent>) {
  return (
    <SelectContent
      position="popper"
      align="start"
      className={cn('w-[var(--radix-select-trigger-width)] max-w-[90vw] min-w-0', className)}
      {...props}
    />
  );
}

export function BoundedSelectItem({
  label,
  suffix,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<typeof SelectItem>, 'title'> & {
  /** full text, shown as a tooltip when the entry is cut off */
  label: string;
  /** short text kept whole after the cut-off part, e.g. "(12 in stock)" */
  suffix?: React.ReactNode;
}) {
  return (
    <SelectItem title={label} className={cn('*:[span]:last:min-w-0', className)} {...props}>
      {/* Also shown inside the trigger as the selected value: cut off with an ellipsis there too */}
      <span className="min-w-0 truncate overflow-hidden text-ellipsis whitespace-nowrap">{children}</span>
      {suffix && <span className="shrink-0 text-muted-foreground">{suffix}</span>}
    </SelectItem>
  );
}
