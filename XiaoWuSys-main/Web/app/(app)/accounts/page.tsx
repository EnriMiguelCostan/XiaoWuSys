import type { Metadata } from 'next';
import { AccountsScreen } from '@/components/accounts/accounts-screen';
import { RequireCapability } from '@/components/layout/require-capability';

export const metadata: Metadata = { title: 'Accounts · XiaoMei ERP' };

// The whole module is for manage_accounts (Owner / Admin); the nav link is hidden for everyone
// else, and Express answers 403 to every request from them anyway.
export default function Page() {
  return (
    <RequireCapability capability="manage_accounts">
      <AccountsScreen />
    </RequireCapability>
  );
}
