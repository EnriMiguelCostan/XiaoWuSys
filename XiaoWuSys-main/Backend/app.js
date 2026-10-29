// ==========================================
// EXPRESS APP FACTORY
// Builds the HTTP API from its dependencies, so server.js (real databases) and the automated
// tests (a throw-away SQLite file) run exactly the same routes and middleware.
// ==========================================
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { verifyToken, requireRole } = require('./middleware/authMiddleware');

const DEFAULT_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:4173', 'http://127.0.0.1:4173'];

// CORS_ORIGINS="https://shop.example.com,http://localhost:5173" (or "*" to allow any site)
const parseOrigins = (value) => {
  if (!value || !value.trim()) return DEFAULT_ORIGINS;
  return value.split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
};

const corsOriginCheck = (origins) => (origin, cb) => {
  // No Origin header: same-origin requests, curl, server-to-server. Allowed.
  if (!origin || origins.includes('*') || origins.includes(origin)) return cb(null, true);
  return cb(null, false); // browser blocks the response; no error page leaks
};

// Small set of safe default headers (what "helmet" would add for a JSON API)
const securityHeaders = (req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Cross-Origin-Opener-Policy', 'same-origin');
  res.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  if (req.path.startsWith('/api')) res.set('Cache-Control', 'no-store');
  next();
};

const createApp = ({
  pgPool, localDb, localDbPath, orderLocks, inventoryEvents,
  syncAndNotify, listConflicts, corsOrigins = parseOrigins(process.env.CORS_ORIGINS)
}) => {
  const app = express();
  app.disable('x-powered-by');
  // Behind a reverse proxy (Render, Railway, nginx): TRUST_PROXY=1 so req.ip is the real client
  if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);

  app.use(securityHeaders);
  app.use(cors({ origin: corsOriginCheck(corsOrigins), methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] }));
  app.use(express.json({ limit: '100kb' }));

  // Audit fix M8: Express 5 leaves req.body undefined when a request has no JSON body.
  app.use((req, res, next) => {
    if (req.body === undefined || req.body === null) req.body = {};
    next();
  });

  // Databases and services for the routers
  app.use((req, res, next) => {
    req.pgPool = pgPool;
    req.localDb = localDb;
    req.localDbPath = localDbPath;
    req.orderLocks = orderLocks;
    req.inventoryEvents = inventoryEvents;
    next();
  });

  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/orders', require('./routes/orders'));
  app.use('/api/inventory', require('./routes/inventory'));
  app.use('/api/customers', require('./routes/customers'));
  app.use('/api/reports', require('./routes/reports'));

  // Health check (no login needed; reveals nothing sensitive)
  app.get('/api/status', (req, res) => {
    res.json({ message: 'XiaoMei ERP Server is running', status: 'online' });
  });

  // Manual sync: 200 done, 409 conflicts with newer cloud edits (C3), 503 cloud unreachable
  app.post('/api/sync', verifyToken, async (req, res) => {
    try {
      const summary = await syncAndNotify();
      if (summary.aborted) {
        return res.status(503).json({ error: 'CLOUD_UNREACHABLE', message: 'Sync paused: the cloud database cannot be reached.', summary });
      }
      if (summary.conflicts.length > 0 || summary.unresolved_conflicts > 0) {
        return res.status(409).json({
          error: 'SYNC_CONFLICT',
          message: 'Some offline changes were not applied because someone else changed the same record online.',
          summary
        });
      }
      res.status(200).json({ message: 'Sync complete.', summary });
    } catch (error) {
      res.status(500).json({ error: 'SYNC_FAILED', message: 'Sync failed. Please try again.' });
    }
  });

  app.get('/api/sync/conflicts', verifyToken, requireRole(['Owner', 'Admin']), async (req, res) => {
    try {
      res.status(200).json({ conflicts: await listConflicts(localDb) });
    } catch (error) {
      res.status(500).json({ error: 'SYNC_FAILED', message: 'Could not read sync conflicts.' });
    }
  });

  // ---- Errors: always structured JSON, never HTML or stack traces (audit M8) ----
  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'NOT_FOUND', message: `No route for ${req.method} ${req.originalUrl}.` });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'INVALID_JSON', message: 'Request body is not valid JSON.' });
    }
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large.' });
    }
    if (err.type && err.status >= 400 && err.status < 500) {
      return res.status(err.status).json({ error: 'BAD_REQUEST', message: 'The request could not be read.' });
    }
    const errorId = crypto.randomUUID();
    console.error(`❌ Unhandled error ${errorId} on ${req.method} ${req.originalUrl}:`, err);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Something went wrong on the server.', error_id: errorId });
  });

  return app;
};

module.exports = { createApp, parseOrigins, corsOriginCheck, DEFAULT_ORIGINS };
