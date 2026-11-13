import type { Metadata } from 'next';
import { RequireCapability } from '@/components/layout/require-capability';
import { CreateOrderScreen } from '@/components/orders/create-order-screen';

export const metadata: Metadata = { title: 'Create Order · XiaoMei ERP' };

export default function Page() {
  return (
    <RequireCapability capability="create_order">
      <CreateOrderScreen />
    </RequireCapability>
  );
}
