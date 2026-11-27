// /finance/payments: money received by month and year; a month opens at /finance/payments/<YYYY-MM>.

import type { Metadata } from 'next';
import { PaymentsReportScreen } from '@/components/finance/finance-screens';
import { RequireCapability } from '@/components/layout/require-capability';

export const metadata: Metadata = { title: 'XiaoWuSys' };

export default function Page() {
  return (
    <RequireCapability capability="view_finance">
      <PaymentsReportScreen />
    </RequireCapability>
  );
}
