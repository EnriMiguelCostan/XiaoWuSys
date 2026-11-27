// /suppliers: suppliers, each with its own page (/suppliers/<id>).

import type { Metadata } from 'next';
import { RequireCapability } from '@/components/layout/require-capability';
import { SuppliersScreen } from '@/components/suppliers/suppliers-screen';

export const metadata: Metadata = { title: 'XiaoWuSys' };

export default function Page() {
  return (
    <RequireCapability capability="view_stock">
      <SuppliersScreen />
    </RequireCapability>
  );
}
