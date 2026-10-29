// Where the backend API lives. Set VITE_API_URL in Frontend/.env (see .env.example) when the
// backend is not on this computer, e.g. VITE_API_URL=https://xiaomei-api.example.com/api
export const API_BASE = (import.meta.env.VITE_API_URL || 'http://localhost:5000/api').replace(/\/$/, '');
export const SOCKET_URL = API_BASE.replace(/\/api$/, '');
