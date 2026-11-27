// Structured JSON logging -> console AND CloudWatch Logs (/esp/<service>).
// Never log passwords, tokens, Authorization headers or request bodies.
const crypto = require('crypto');
const { PutLogEventsCommand, CreateLogStreamCommand } = require('@aws-sdk/client-cloudwatch-logs');
const aws = require('./aws');
const { RESOURCES } = require('./config');

let serviceName = 'unknown';
let stream = null;
let buffer = [];
let timer = null;

function initLogger(service) {
  serviceName = service;
  stream = `${service}-${process.pid}-${Date.now()}`;
  aws.logs().send(new CreateLogStreamCommand({ logGroupName: RESOURCES.logGroup(service), logStreamName: stream }))
    .catch(() => {}); // group is created by infra/provision.js
  if (!timer) {
    timer = setInterval(flush, 2000);
    timer.unref();
  }
}

function log(level, event, fields = {}) {
  const entry = { time: new Date().toISOString(), level, service: serviceName, event, ...fields };
  const line = JSON.stringify(entry);
  (level === 'error' ? console.error : console.log)(line);
  if (stream) buffer.push({ timestamp: Date.now(), message: line });
  if (buffer.length >= 50) flush();
}

async function flush() {
  if (!stream || buffer.length === 0) return;
  const logEvents = buffer.splice(0, buffer.length);
  try {
    await aws.logs().send(new PutLogEventsCommand({ logGroupName: RESOURCES.logGroup(serviceName), logStreamName: stream, logEvents }));
  } catch { /* logging must never break a request */ }
}

// Logs one line per request: method, path, status, duration, user id and role.
function requestLogger() {
  return (req, res, next) => {
    req.id = req.get('x-request-id') || crypto.randomUUID();
    res.set('x-request-id', req.id);
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      log(res.statusCode >= 500 ? 'error' : 'info', 'request', {
        requestId: req.id,
        method: req.method,
        path: req.originalUrl.split('?')[0],
        status: res.statusCode,
        ms: Number((process.hrtime.bigint() - start) / 1000000n),
        userId: req.user?.id ?? null,
        role: req.user?.role ?? null,
        ip: req.ip,
      });
    });
    next();
  };
}

module.exports = { initLogger, log, flush, requestLogger };
