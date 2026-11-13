'use client';

// const api = useApi();  const { ok, status, data } = await api('GET', '/orders');
// Returns the same function every render, so it is safe in effect dependency lists.
// The token is read at call time (see lib/api.ts), so nothing needs re-creating on login.
import { api } from '@/lib/api';

export function useApi() {
  return api;
}
