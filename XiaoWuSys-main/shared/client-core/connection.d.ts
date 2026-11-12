export type ConnectionState = 'online' | 'offline_local' | 'server_down' | 'checking';
export type CloudState = 'unknown' | 'reachable' | 'unreachable' | 'disabled';

export const CONNECTION_STATES: ConnectionState[];

export function deriveConnectionState(input: { serverReachable: boolean | null | undefined; cloud?: CloudState | null }): ConnectionState;

export function connectionText(state: ConnectionState, options?: { cloud?: CloudState | null; browserOnline?: boolean }): { label: string; detail: string };

export function pendingText(total: number | null | undefined): string;

export function syncDisabledReason(input: { state: ConnectionState; syncing: boolean }): string | null;

export interface SyncResultMessage {
  type: 'success' | 'warning' | 'error';
  title: string;
  message: string;
}

export function syncResultMessage(status: number, body: unknown, options?: { canSeeConflicts?: boolean }): SyncResultMessage;
