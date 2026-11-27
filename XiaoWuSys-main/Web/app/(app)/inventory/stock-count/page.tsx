// /inventory/stock-count: shelf counts that correct the system quantity.

import { Suspense } from 'react';
import type { Metadata } from 'next';
import { StockDocumentsScreen } from '@/components/inventory/stock-documents-screen';
import { RequireCapability } from '@/components/layout/require-capability';

export const metadata: Metadata = { title: 'XiaoWuSys' };

// Migration 015: the screen reads ?new=1&supplier=&item= in the browser, so it sits in a Suspense boundary
export default function Page() {
  return (
    <RequireCapability capability="view_stock">
      <Suspense>
        <StockDocumentsScreen type="stock_count" />
      </Suspense>
    </RequireCapability>
  );
}
