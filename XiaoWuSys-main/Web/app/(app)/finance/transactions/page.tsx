// /finance/transactions: every peso in and out in a month, in one list.

import type { Metadata } from 'next';
import { TransactionsScreen } from '@/components/finance/finance-screens';
import { RequireCapability } from '@/components/layout/require-capability';

export const metadata: Metadata = { title: 'XiaoWuSys' };

export default function Page() {
  return (
    <RequireCapability capability="view_finance">
      <TransactionsScreen />
    </RequireCapability>
  );
}
