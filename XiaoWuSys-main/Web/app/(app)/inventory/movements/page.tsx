import { Suspense } from 'react';
import type { Metadata } from 'next';
import { StockCardScreen } from '@/components/inventory/stock-card-screen';
import { RequireCapability } from '@/components/layout/require-capability';

export const metadata: Metadata = { title: 'XiaoWuSys' };

// Reads ?item=<id> in the browser, so it sits in a Suspense boundary
export default function Page() {
  return (
    <RequireCapability capability="view_stock">
      <Suspense>
        <StockCardScreen />
      </Suspense>
    </RequireCapability>
  );
}
