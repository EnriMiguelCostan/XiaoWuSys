import type { Metadata } from 'next';
import { PagePlaceholder } from '@/components/layout/page-placeholder';
import { RequireCapability } from '@/components/layout/require-capability';

export const metadata: Metadata = { title: 'Accounts · XiaoMei ERP' };

export default function Page() {
  return (
    <RequireCapability capability="manage_accounts">
      <PagePlaceholder title="Accounts" batch="Batch M4" />
    </RequireCapability>
  );
}
