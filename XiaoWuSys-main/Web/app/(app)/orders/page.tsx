import { Suspense } from 'react';
import type { Metadata } from 'next';
import { RequireCapability } from '@/components/layout/require-capability';
import { OrdersScreen } from '@/components/orders/orders-screen';

export const metadata: Metadata = { title: 'XiaoWuSys' };

// OrdersScreen reads ?order=<id> in the browser, so it sits in a Suspense boundary.
export default function Page() {
  return (
    <RequireCapability capability="view_orders">
      <Suspense>
        <OrdersScreen />
      </Suspense>
    </RequireCapability>
  );
}
