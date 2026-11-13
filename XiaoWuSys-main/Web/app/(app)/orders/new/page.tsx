import type { Metadata } from 'next';
import { PagePlaceholder } from '@/components/layout/page-placeholder';
import { RequireCapability } from '@/components/layout/require-capability';

export const metadata: Metadata = { title: 'Create Order · XiaoMei ERP' };

export default function Page() {
  return (
    <RequireCapability capability="create_order">
      <PagePlaceholder title="Create Order" batch="Batch M3" />
    </RequireCapability>
  );
}
