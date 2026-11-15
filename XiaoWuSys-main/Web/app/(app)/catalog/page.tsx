import type { Metadata } from 'next';
import { CatalogScreen } from '@/components/catalog/catalog-screen';

export const metadata: Metadata = { title: 'XiaoWuSys' };

export default function Page() {
  return <CatalogScreen />;
}
