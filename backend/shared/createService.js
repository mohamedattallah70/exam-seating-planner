// Builds one microservice (its own Express app + port + DB role + log group).
// Every service gets the same security baseline: helmet headers, JSON size
// limit, request logging, health check and the shared error format.
const express = require('express');
const helmet = require('helmet');
const { initDb, query } = require('./db');
const { initLogger, log, requestLogger } = require('./logger');
const { notFoundHandler, errorHandler } = require('./errors');
const { PORTS } = require('./config');

function createService(name, mountRoutes) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback'); // requests arrive via the local gateway
  app.use(helmet());
  app.use(express.json({ limit: '200kb' }));
  app.use(requestLogger());

  app.get('/health', async (_req, res) => {
    try {
      await query('SELECT 1');
      res.json({ service: name, status: 'ok', db: 'ok' });
    } catch {
      res.status(503).json({ service: name, status: 'degraded', db: 'unreachable' });
    }
  });

  mountRoutes(app);
  app.use(notFoundHandler);
  app.use(errorHandler);

  async function start() {
    initLogger(name);
    await initDb(name);
    const port = PORTS[name];
    app.listen(port, () => log('info', 'service_started', { port }));
  }

  return { app, start };
}

module.exports = { createService };
