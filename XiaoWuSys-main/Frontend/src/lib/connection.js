// Connection and sync wording shared by every screen (PB 3 / PB 4).
// Plain JS (no React, no DOM) so the future Next.js and mobile apps can reuse it.
//
// The shop server and the cloud are two different things:
//   online         the shop server answers and it can reach the cloud
//   offline_local  the shop server answers, but the cloud cannot be reached (or is switched
//                  off in demo mode): work is saved on this computer and synced later
//   server_down    the shop server itself cannot be reached from this browser
//   checking       the server has not tried the cloud yet (only right after it starts)
// navigator.onLine is only a hint: the shop server is often on this same computer, so a
// browser that thinks it is offline can still reach it.

export const CONNECTION_STATES = ['online', 'offline_local', 'server_down', 'checking'];

export const deriveConnectionState = ({ serverReachable, cloud }) => {
  if (serverReachable === false) return 'server_down';
  if (serverReachable === null || serverReachable === undefined) return 'checking';
  if (cloud === 'reachable') return 'online';
  if (cloud === 'unreachable' || cloud === 'disabled') return 'offline_local';
  return 'checking';
};

// -> { label, detail } in plain words for the status bar
export const connectionText = (state, { cloud, browserOnline = true } = {}) => {
  switch (state) {
    case 'online':
      return { label: 'Online', detail: 'Changes are saved to the cloud.' };
    case 'offline_local':
      return {
        label: 'Offline: saving on this computer',
        detail: cloud === 'disabled'
          ? 'Demo mode: there is no cloud connection, so everything stays on this computer.'
          : 'The cloud cannot be reached. Your work is kept here and sent automatically when the connection is back.'
      };
    case 'server_down':
      return {
        label: "Can't reach the shop server",
        detail: browserOnline
          ? 'Check that the shop server is turned on and running. Nothing new can be saved until it is back.'
          : 'This computer is not connected to the network. Nothing new can be saved until it is back.'
      };
    default:
      return { label: 'Checking the connection…', detail: 'The shop server is checking the cloud connection.' };
  }
};

// '3 changes waiting to sync'
export const pendingText = (total) => {
  const n = Number(total) || 0;
  if (n <= 0) return 'No changes waiting';
  return `${n} change${n === 1 ? '' : 's'} waiting to sync`;
};

// Why "Sync now" cannot be pressed right now (null = it can)
export const syncDisabledReason = ({ state, syncing }) => {
  if (syncing) return 'A sync is already running.';
  if (state === 'server_down') return "The shop server can't be reached, so there is nothing to sync with yet.";
  return null;
};

// Result of POST /api/sync for a ResultDialog -> { type, title, message }
//   200 done, 409 conflicts with newer cloud edits, 503 cloud unreachable, 0 server unreachable
export const syncResultMessage = (status, body, { canSeeConflicts = false } = {}) => {
  const summary = (body && body.summary) || {};
  if (status === 200) {
    const sent = Number(summary.synced) || 0;
    return {
      type: 'success',
      title: 'Everything is up to date',
      message: sent > 0
        ? `${sent} change${sent === 1 ? ' was' : 's were'} sent to the cloud.`
        : 'There was nothing waiting to be sent.'
    };
  }
  if (status === 409) {
    const n = Number(summary.unresolved_conflicts) || (summary.conflicts || []).length;
    return {
      type: 'warning',
      title: 'Some changes were not applied',
      message: 'Some offline changes were not applied because someone changed the same record online.'
        + (canSeeConflicts && n > 0 ? `\nRecords that need a decision: ${n}.` : '\nAsk the Owner or an Admin to review them.')
    };
  }
  if (status === 503) {
    return {
      type: 'warning',
      title: 'Still offline',
      message: 'The cloud is still unreachable. Your work is saved on this computer and will be sent when the connection is back.'
    };
  }
  if (status === 0) {
    return { type: 'error', title: "Can't reach the shop server", message: 'Check that the shop server is turned on and running, then try again.' };
  }
  return { type: 'error', title: 'Sync did not finish', message: (body && body.message) || 'Please try again in a moment.' };
};
