import type { Metadata } from 'next';
import { PagePlaceholder } from '@/components/layout/page-placeholder';

export const metadata: Metadata = { title: 'Catalog · XiaoMei ERP' };

export default function Page() {
  return (
    <PagePlaceholder title="Catalog" batch="Batch M2" />
  );
}
