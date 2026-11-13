'use client';

// const { user, status, logout } = useSession();
// Show or hide with can(user, 'capability') from @xiaowu/client-core/permissions,
// never by comparing user.role (rules guard: no-role-checks). user.role is for display only.
export { useSessionContext as useSession } from '@/components/providers/session-provider';
export type { SessionContextValue, SessionStatus } from '@/components/providers/session-provider';
