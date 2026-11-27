// Security/audit trail. Each call:
//   1. appends a row to the audit_logs table (append-only: no service role
//      has UPDATE or DELETE on it), and
//   2. sends an event to the EventBridge bus esp-audit-bus, whose rule copies
//      it into the CloudWatch log group /esp/audit-events.
// Never put passwords or tokens in `details`.
const { PutEventsCommand } = require('@aws-sdk/client-eventbridge');
const aws = require('./aws');
const { RESOURCES } = require('./config');
const { query } = require('./db');
const { log } = require('./logger');

async function audit(req, action, { target = null, outcome = 'success', details = null, userId } = {}) {
  const row = {
    userId: userId ?? req?.user?.id ?? null,
    role: req?.user?.role ?? null,
    action,
    target,
    outcome,
    ip: req?.ip ?? null,
    details,
  };
  log(outcome === 'success' ? 'info' : 'warn', 'audit', row);
  await Promise.allSettled([
    query(
      'INSERT INTO audit_logs (user_id, role, action, target, outcome, ip, details) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [row.userId, row.role, action, target, outcome, row.ip, details ? JSON.stringify(details) : null],
    ),
    aws.events().send(new PutEventsCommand({
      Entries: [{
        EventBusName: RESOURCES.eventBus,
        Source: 'esp.app',
        DetailType: action,
        Detail: JSON.stringify(row),
      }],
    })),
  ]);
}

module.exports = { audit };
