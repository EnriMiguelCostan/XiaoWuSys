// /dashboard: the first page after login (today's work, low stock, money).

import type { Metadata } from 'next';
import { DashboardScreen } from '@/components/dashboard/dashboard-screen';

export const metadata: Metadata = { title: 'XiaoWuSys' };

export default function Page() {
  return <DashboardScreen />;
}
