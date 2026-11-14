// ==========================================
// LIVE ORDER UPDATES (Socket.io) - PB 14 / PB 5
//
// Server -> client events:
//   order_updated    { order_id, tracking_no, production_status, version }   to every screen
//   order_overridden { order_id, tracking_no, overridden_by_role }           only to the account
//                                                                            whose change was replaced
//
// "order_updated" has two sources, like stock updates:
//  1. Postgres NOTIFY 'orders_changed' (migration 010), heard by the LISTEN client in
//     inventoryEvents.js: every committed change, from any branch.
//  2. notifyUpdated() calls from this server's own routes, after COMMIT. Covers orders saved
//     offline (no NOTIFY) and keeps this branch instant while the LISTEN link reconnects.
// The same change usually arrives through both, so an order_id + version that was already
// sent is not sent again. Screens only use the event as "reload this order"; they never
// take values from it without asking the API.
// ==========================================

const REMEMBER = 500; // most recent orders whose last sent version is remembered

const createOrderEvents = ({ io }) => {
  const sent = new Map(); // order_id -> version last sent

  const notifyUpdated = (order) => {
    if (!order || !order.order_id) return;
    const payload = {
      order_id: order.order_id,
      tracking_no: order.tracking_no || null,
      production_status: order.production_status || null,
      version: order.version || null
    };
    if (payload.version) {
      if (sent.get(payload.order_id) === payload.version) return;
      sent.delete(payload.order_id); // re-insert so the newest stays last
      sent.set(payload.order_id, payload.version);
      if (sent.size > REMEMBER) sent.delete(sent.keys().next().value);
    }
    io.emit('order_updated', payload);
  };

  // Tells one account (all its screens on this server) that a higher rank replaced its change
  const notifyOverridden = ({ user_id, order_id, tracking_no = null, overridden_by_role = null }) => {
    if (!user_id || !order_id) return 0;
    let told = 0;
    for (const socket of io.sockets.sockets.values()) {
      if (socket.data && socket.data.user && socket.data.user.user_id === user_id) {
        socket.emit('order_overridden', { order_id, tracking_no, overridden_by_role });
        told += 1;
      }
    }
    return told;
  };

  return { notifyUpdated, notifyOverridden };
};

module.exports = { createOrderEvents };
