// "Not enough stock" rows from a 409 INSUFFICIENT_INVENTORY (create order and approve).
// Every number is the server's (services/capacity.js); nothing is worked out here.
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { Shortage } from '@/lib/orders';

export function ShortageTable({ shortages }: { shortages: Shortage[] }) {
  return (
    <div className="max-h-64 min-w-0 overflow-auto rounded-md border">
      <Table>
        <TableHeader className="sticky top-0 bg-muted">
          <TableRow>
            <TableHead>Material</TableHead>
            <TableHead className="text-right">Needed</TableHead>
            <TableHead className="text-right">Free to use</TableHead>
            <TableHead className="text-right">Missing</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {shortages.map((s) => (
            <TableRow key={s.inventory_id}>
              <TableCell className="min-w-32 whitespace-normal wrap-anywhere">{s.item_name || 'A material'}</TableCell>
              <TableCell className="text-right tabular-nums">{s.requested.toLocaleString()}</TableCell>
              <TableCell className="text-right tabular-nums">{s.available.toLocaleString()}</TableCell>
              <TableCell className="text-right font-semibold text-danger tabular-nums">
                {s.shortfall === undefined ? '—' : s.shortfall.toLocaleString()}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
