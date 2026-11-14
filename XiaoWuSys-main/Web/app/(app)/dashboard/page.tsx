import type { Metadata } from 'next';
import { DashboardScreen } from '@/components/dashboard/dashboard-screen';

export const metadata: Metadata = { title: 'Dashboard · XiaoMei ERP' };

export default function Page() {
  return <DashboardScreen />;
}
