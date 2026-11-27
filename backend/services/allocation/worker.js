// Allocation event worker (owner: Mohamed Attallah).
// Long-polls SQS esp-allocation-events (fed by SNS esp-domain-events) and keeps
// seating plans valid when halls or exams change. A message is deleted only
// after it was handled; failures are retried by SQS and after 3 receives the
// message moves to the dead-letter queue esp-allocation-events-dlq.
const { ReceiveMessageCommand, DeleteMessageCommand } = require('@aws-sdk/client-sqs');
const aws = require('../../shared/aws');
const { RESOURCES } = require('../../shared/config');
const { initDb, query } = require('../../shared/db');
const { initLogger, log } = require('../../shared/logger');
const { audit } = require('../../shared/audit');
const { reconcile } = require('./reconcile');
const { safeExport, deleteSeatMaps, metric } = require('./exports');

const examsUsingSeat = async (seatId) => (await query('SELECT DISTINCT exam_id FROM seat_assignments WHERE seat_id = $1', [seatId])).rows.map((r) => r.exam_id);
const examsUsingHall = async (hallId) => (await query(
  `SELECT e.id FROM exam_halls eh JOIN exams e ON e.id = eh.exam_id WHERE eh.hall_id = $1 AND e.allocation_status <> 'none'`, [hallId])).rows.map((r) => r.id);

async function reconcileAndReport(examId, event, { forceExport = false } = {}) {
  const r = await reconcile(examId);
  if (r.skipped) return r;
  for (const m of r.relocated) {
    await audit(null, 'STUDENT_RELOCATED', { target: `exam ${examId}`, details: { studentCode: m.studentCode, from: m.from, to: m.toSeat, cause: event.type, eventId: event.id } });
  }
  if (r.relocated.length) await metric('SeatsRelocated', r.relocated.length);
  if (r.status === 'needs_reallocation' && r.before !== 'needs_reallocation') {
    await audit(null, 'ALLOCATION_INVALIDATED', { target: `exam ${examId}`, outcome: 'failed', details: { cause: event.type, eventId: event.id, unplaced: r.unplaced } });
    await metric('PlansInvalidated', 1);
  }
  if (r.status === 'published' && (r.changed || forceExport)) await safeExport(examId);
  return r;
}

const HANDLERS = {
  'hall.seat_blocked': async (e) => Promise.all((await examsUsingSeat(e.payload.seatId)).map((id) => reconcileAndReport(id, e))),
  // seats removed by a resize already lost their assignments (FK cascade); re-check every exam on the hall
  'hall.resized': async (e) => Promise.all((await examsUsingHall(e.payload.hallId)).map((id) => reconcileAndReport(id, e))),
  // seats don't depend on time, so a published plan stays valid: refresh the export (it carries the date)
  'exam.rescheduled': (e) => reconcileAndReport(e.payload.examId, e, { forceExport: true }),
  'exam.halls_changed': (e) => reconcileAndReport(e.payload.examId, e),
  'exam.roster_changed': (e) => reconcileAndReport(e.payload.examId, e),
  'exam.deleted': async (e) => ({ deletedExports: await deleteSeatMaps(e.payload.examId) }),
};

function parse(body) {
  const msg = JSON.parse(body);
  return msg.Type === 'Notification' && msg.Message ? JSON.parse(msg.Message) : msg; // raw or SNS envelope
}

async function handle(message) {
  const t0 = Date.now();
  let event;
  try { event = parse(message.Body); } catch {
    log('warn', 'event_unparseable', { messageId: message.MessageId });
    return true; // poison message: drop it, it can never succeed
  }
  const handler = HANDLERS[event.type];
  if (!handler) { log('warn', 'event_ignored', { type: event.type, eventId: event.id }); return true; }
  try {
    const result = await handler(event);
    log('info', 'event_handled', { type: event.type, eventId: event.id, ms: Date.now() - t0, result });
    await metric('EventsProcessed', 1);
    return true;
  } catch (err) {
    log('error', 'event_failed', { type: event.type, eventId: event.id, receiveCount: message.Attributes?.ApproximateReceiveCount, message: err.message });
    await metric('EventsFailed', 1);
    return false; // not deleted -> SQS retries, then DLQ
  }
}

async function loop() {
  const sqs = aws.sqs();
  for (;;) {
    try {
      const { Messages = [] } = await sqs.send(new ReceiveMessageCommand({
        QueueUrl: RESOURCES.queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 20, VisibilityTimeout: 30,
        AttributeNames: ['ApproximateReceiveCount'],
      }));
      for (const m of Messages) {
        if (await handle(m)) await sqs.send(new DeleteMessageCommand({ QueueUrl: RESOURCES.queueUrl, ReceiptHandle: m.ReceiptHandle }));
      }
    } catch (err) {
      log('error', 'queue_poll_failed', { message: err.message });
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

if (require.main === module) {
  (async () => {
    initLogger('allocation');
    await initDb('allocation');
    log('info', 'worker_started', { queue: RESOURCES.queueName });
    loop();
  })();
}

module.exports = { handle, HANDLERS };
