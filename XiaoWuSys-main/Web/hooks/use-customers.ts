'use client';

// Saved customers (GET /api/customers), for names in the orders list and the Create Order picker.
// Reloaded after a sync and on demand (e.g. after a new customer was saved).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useConnection } from '@/components/connection/connection-provider';
import { api } from '@/lib/api';
import type { Customer } from '@/lib/orders';

export function useCustomers() {
  const { syncGeneration } = useConnection();
  const [customers, setCustomers] = useState<Customer[] | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api<{ customers?: Customer[] }>('GET', '/customers').then(({ ok, data }) => {
      if (!cancelled && ok) setCustomers(Array.isArray(data.customers) ? data.customers : []);
    });
    return () => {
      cancelled = true;
    };
  }, [syncGeneration, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  const sorted = useMemo(
    () => (customers ? [...customers].sort((a, b) => a.full_name.localeCompare(b.full_name)) : []),
    [customers]
  );
  const byId = useMemo(() => new Map(sorted.map((c) => [c.customer_id, c])), [sorted]);

  return { customers: sorted, byId, loaded: customers !== null, reload };
}
