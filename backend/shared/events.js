// Domain events between services. Producers (halls, exams) publish to the SNS
// topic esp-domain-events; SNS fans out to the SQS queue esp-allocation-events,
// which the allocation worker consumes. Event types and payloads are defined
// in docs/CONTRACT.md.
const crypto = require('crypto');
const { PublishCommand } = require('@aws-sdk/client-sns');
const aws = require('./aws');
const { RESOURCES } = require('./config');
const { log } = require('./logger');

async function publishEvent(type, payload, source) {
  const event = { id: crypto.randomUUID(), type, source, occurredAt: new Date().toISOString(), payload };
  try {
    await aws.sns().send(new PublishCommand({
      TopicArn: RESOURCES.topicArn,
      Message: JSON.stringify(event),
      MessageAttributes: { eventType: { DataType: 'String', StringValue: type } },
    }));
    log('info', 'event_published', { eventId: event.id, type });
  } catch (err) {
    // The DB change already happened; record the failure so it is visible.
    log('error', 'event_publish_failed', { eventId: event.id, type, message: err.message });
  }
  return event;
}

module.exports = { publishEvent };
