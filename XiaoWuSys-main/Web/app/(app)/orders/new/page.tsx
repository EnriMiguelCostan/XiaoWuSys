// /orders/new: the create-order form.

import { Suspense } from 'react';
import type { Metadata } from 'next';
import { RequireCapability } from '@/components/layout/require-capability';
import { CreateOrderScreen } from '@/components/orders/create-order-screen';

export const metadata: Metadata = { title: 'XiaoWuSys' };

// Reads ?customer=<id> in the browser (from a client's profile), so it sits in a Suspense boundary
export default function Page() {
  return (
    <RequireCapability capability="create_order">
      <Suspense>
        <CreateOrderScreen />
      </Suspense>
    </RequireCapability>
  );
}
