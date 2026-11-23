import type { Metadata } from 'next';
import { ClientsScreen } from '@/components/clients/clients-screen';
import { RequireCapability } from '@/components/layout/require-capability';

export const metadata: Metadata = { title: 'XiaoWuSys' };

export default function Page() {
  return (
    <RequireCapability capability="view_orders">
      <ClientsScreen />
    </RequireCapability>
  );
}
