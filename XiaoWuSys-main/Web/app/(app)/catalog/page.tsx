// /catalog: the items list, with each item, the Recycle Bin and imports as sub pages.

import type { Metadata } from 'next';
import { CatalogScreen } from '@/components/catalog/catalog-screen';

export const metadata: Metadata = { title: 'XiaoWuSys' };

export default function Page() {
  return <CatalogScreen />;
}
