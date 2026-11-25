'use client';

// Print areas of one order line (migration 017). For a catalog item priced "per print area" (a
// blank T-shirt, polo, hoodie, tote) the price is the blank plus each print: front A4, back A3, a
// left-chest logo, names and numbers... The sizes, their prices and the placements come from the
// server (GET /api/orders/options); the quote is worked out on the server.
import { Plus, X } from 'lucide-react';
import { peso } from '@xiaowu/client-core/format';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useOrderOptions } from '@/hooks/use-order-options';
import type { PrintArea } from '@/lib/orders';

export const parseAreas = (text: string | null | undefined): PrintArea[] => {
  if (!text) return [];
  try {
    const list = JSON.parse(text);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
};

export function PrintAreasEditor({
  id,
  value,
  onChange,
  disabled,
}: {
  id: string;
  value: PrintArea[];
  onChange: (next: PrintArea[]) => void;
  disabled?: boolean;
}) {
  const options = useOrderOptions();
  const sizes = options?.print_sizes ?? [];
  const placements = options?.print_placements ?? [];
  if (sizes.length === 0 || placements.length === 0) return null;
  const used = new Set(value.map((a) => a.placement));
  const next = placements.find((p) => !used.has(p)) ?? placements[0];
  const total = value.reduce((s, a) => s + (sizes.find((x) => x.size === a.size)?.price ?? 0), 0);
  const put = (i: number, patch: Partial<PrintArea>) => onChange(value.map((a, j) => (j === i ? { ...a, ...patch } : a)));

  return (
    <div className="space-y-2" aria-labelledby={`${id}-label`}>
      <p id={`${id}-label`} className="text-xs text-muted-foreground">
        Print areas (priced per piece on top of the blank){value.length > 0 && <>: {peso(total)} a piece before the bulk price</>}
      </p>
      {value.map((a, i) => (
        <div key={`${a.placement}-${i}`} className="flex flex-wrap items-center gap-2">
          <Select value={a.placement} onValueChange={(v) => put(i, { placement: v })} disabled={disabled}>
            <SelectTrigger aria-label={`Print area ${i + 1}: placement`} className="h-8 w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {placements.map((p) => (
                <SelectItem key={p} value={p}>
                  {p}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={a.size} onValueChange={(v) => put(i, { size: v })} disabled={disabled}>
            <SelectTrigger aria-label={`Print area ${i + 1}: size`} className="h-8 w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {sizes.map((s) => (
                <SelectItem key={s.size} value={s.size}>
                  {s.label} · {peso(s.price)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={disabled}
            aria-label={`Remove print area ${i + 1}`}
            onClick={() => onChange(value.filter((_, j) => j !== i))}
          >
            <X aria-hidden />
          </Button>
        </div>
      ))}
      {value.length < 6 && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => onChange([...value, { placement: next, size: value.length === 0 ? 'A4' : 'A3' }])}
        >
          <Plus aria-hidden /> Add a print area
        </Button>
      )}
    </div>
  );
}
