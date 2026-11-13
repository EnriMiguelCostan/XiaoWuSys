import type { Metadata } from 'next';
import { PagePlaceholder } from '@/components/layout/page-placeholder';
import { RequireCapability } from '@/components/layout/require-capability';

export const metadata: Metadata = { title: 'Orders · XiaoMei ERP' };

export default function Page() {
  return (
    <RequireCapability capability="view_orders">
      <PagePlaceholder title="Orders" batch="Batch M3" />
    </RequireCapability>
  );
}
