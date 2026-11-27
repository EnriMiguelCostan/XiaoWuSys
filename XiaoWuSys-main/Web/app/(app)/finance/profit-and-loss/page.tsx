// /finance/profit-and-loss: the Owner's profit and loss report.

import type { Metadata } from 'next';
import { ProfitLossScreen } from '@/components/finance/finance-screens';
import { RequireCapability } from '@/components/layout/require-capability';

export const metadata: Metadata = { title: 'XiaoWuSys' };

export default function Page() {
  return (
    <RequireCapability capability="set_quote">
      <ProfitLossScreen />
    </RequireCapability>
  );
}
