'use client';

// GET /api/orders/options once per tab (migration 015): the payment methods and the details
// each one needs, refund reasons, delivery methods, garment sizes and print limits. The server
// decides these lists; the forms only show them.
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { OrderOptions } from '@/lib/orders';

let cached: OrderOptions | null = null;
let loading: Promise<OrderOptions | null> | null = null;

const load = () => {
  if (!loading) {
    loading = api<OrderOptions>('GET', '/orders/options').then(({ ok, data }) => {
      if (ok && data.payment_methods) cached = data;
      else loading = null; // try again next time
      return cached;
    });
  }
  return loading;
};

export function useOrderOptions(): OrderOptions | null {
  const [options, setOptions] = useState<OrderOptions | null>(cached);
  useEffect(() => {
    if (cached) return undefined;
    let alive = true;
    void load().then((o) => alive && o && setOptions(o));
    return () => {
      alive = false;
    };
  }, []);
  return options;
}
