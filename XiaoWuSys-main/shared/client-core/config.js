// Where the shop server (Express) lives, worked out at RUN time, not build time (Batch M0, N1/N3, Q4).
//
// One build of the UI serves every branch and every device on the shop Wi-Fi. A tablet that
// opened http://192.168.1.20:3000 must call http://192.168.1.20:5000/api, and the shop computer
// itself must call http://localhost:5000/api. Both follow from the address the page was opened on.
// An explicit address (NEXT_PUBLIC_API_URL / VITE_API_URL) still wins when one is configured.

export const DEFAULT_API_PORT = 5000;

const trimSlash = (s) => String(s).trim().replace(/\/+$/, '');

// configured: optional explicit API address (must end with /api)
// location:   window.location (or a stand-in in tests); omitted on the server
export const resolveApiBase = ({ configured, location, port = DEFAULT_API_PORT } = {}) => {
  if (typeof configured === 'string' && configured.trim()) return trimSlash(configured);
  const loc = location || (typeof window !== 'undefined' ? window.location : null);
  if (!loc || !loc.hostname) return `http://localhost:${port}/api`;
  const protocol = loc.protocol === 'https:' ? 'https:' : 'http:';
  return `${protocol}//${loc.hostname}:${port}/api`;
};

// Socket.io connects to the server root, not to /api
export const socketUrlFor = (apiBase) => trimSlash(apiBase).replace(/\/api$/, '');
