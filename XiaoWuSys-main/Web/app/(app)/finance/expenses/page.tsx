import type { Metadata } from 'next';
import { ExpensesScreen } from '@/components/finance/finance-screens';
import { RequireCapability } from '@/components/layout/require-capability';

export const metadata: Metadata = { title: 'XiaoWuSys' };

export default function Page() {
  return (
    <RequireCapability capability="view_finance">
      <ExpensesScreen />
    </RequireCapability>
  );
}
