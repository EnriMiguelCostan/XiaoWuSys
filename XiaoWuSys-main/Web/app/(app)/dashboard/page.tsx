import type { Metadata } from 'next';
import { PagePlaceholder } from '@/components/layout/page-placeholder';

export const metadata: Metadata = { title: 'Dashboard · XiaoMei ERP' };

export default function Page() {
  return (
    <PagePlaceholder title="Dashboard" batch="Batch M4" />
  );
}
