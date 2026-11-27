// API gateway / load-balancer simulator (port 8080).
// The single public entry point for the browser. It applies CORS, security
// headers and rate limiting, then routes each request by path to the
// microservice that owns it (same idea as the ALB path rules created in
// infra/provision.js; Floci's ALB/ECS are control-plane only, as in Lab 8).
const http = require('http');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const { rateLimit } = require('express-rate-limit');
const { PORTS, CORS_ORIGINS } = require('../shared/config');
const { initLogger, log, requestLogger } = require('../shared/logger');

// Order matters: the most specific patterns come first.
const ROUTES = [
  [/^\/api\/auth(\/|$)/, 'auth'],
  [/^\/api\/halls(\/|$)/, 'halls'],
  [/^\/api\/exams\/[^/]+\/(allocation|halls\/[^/]+\/seat-map)(\/|$)/, 'allocation'],
  [/^\/api\/(allocations|me)(\/|$)/, 'allocation'],
  [/^\/api\/(exams|holidays|users)(\/|$)/, 'exams'],
];

const app = express();
app.disable('x-powered-by');
app.use(helmet());
app.use(cors({
  origin: (origin, cb) => cb(null, !origin || CORS_ORIGINS.includes(origin)),
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['x-request-id'],
  maxAge: 600,
}));
app.use(requestLogger());
app.use('/api', rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: 'draft-8', legacyHeaders: false }));

app.get('/api/health', async (_req, res) => {
  const results = await Promise.all(Object.keys(PORTS).filter((s) => s !== 'gateway').map(async (service) => {
    try {
      const r = await fetch(`http://127.0.0.1:${PORTS[service]}/health`, { signal: AbortSignal.timeout(3000) });
      return [service, (await r.json()).status];
    } catch {
      return [service, 'down'];
    }
  }));
  const services = Object.fromEntries(results);
  const healthy = Object.values(services).every((s) => s === 'ok');
  res.status(healthy ? 200 : 503).json({ status: healthy ? 'ok' : 'degraded', services });
});

app.use((req, res) => {
  const route = ROUTES.find(([re]) => re.test(req.path));
  if (!route) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Unknown API route' } });
  const service = route[1];
  const headers = { ...req.headers, host: `127.0.0.1:${PORTS[service]}`, 'x-forwarded-for': req.ip, 'x-request-id': req.id };
  const upstream = http.request(
    { hostname: '127.0.0.1', port: PORTS[service], path: req.originalUrl, method: req.method, headers },
    (up) => {
      res.status(up.statusCode);
      for (const [k, v] of Object.entries(up.headers)) {
        if (!k.startsWith('access-control-')) res.setHeader(k, v);
      }
      up.pipe(res);
    },
  );
  upstream.on('error', () => {
    log('error', 'upstream_unavailable', { service, path: req.path });
    if (!res.headersSent) res.status(503).json({ error: { code: 'SERVICE_UNAVAILABLE', message: `The ${service} service is not available` } });
  });
  req.pipe(upstream);
});

initLogger('gateway');
app.listen(PORTS.gateway, () => log('info', 'gateway_started', { port: PORTS.gateway, routes: ROUTES.map(([re, s]) => `${re} -> ${s}`) }));
