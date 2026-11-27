// Central configuration shared by every service.
// Only NON-secret values live here. Secrets are read at runtime from
// AWS Secrets Manager (see shared/secrets.js); .env is used only by the
// provisioning scripts that load those secrets into Secrets Manager.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const ENDPOINT = process.env.AWS_ENDPOINT || 'http://localhost:4566';
const REGION = 'us-east-1';
const ACCOUNT_ID = '000000000000'; // Floci default account

module.exports = {
  ENDPOINT,
  REGION,
  ACCOUNT_ID,
  // Floci accepts the dummy test/test credentials (same as the labs).
  // On real AWS these would come from the ECS task role, never from code.
  AWS: { endpoint: ENDPOINT, region: REGION, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } },

  PORTS: { gateway: 8080, auth: 3001, halls: 3002, exams: 3003, allocation: 3004 },

  CORS_ORIGINS: (process.env.CORS_ORIGINS || 'http://localhost:4566,http://127.0.0.1:4566')
    .split(',').map((s) => s.trim()).filter(Boolean),

  JWT: { issuer: 'esp-auth', audience: 'esp-api', expiresIn: '1h' },

  RESOURCES: {
    topicArn: `arn:aws:sns:${REGION}:${ACCOUNT_ID}:esp-domain-events`,
    queueName: 'esp-allocation-events',
    dlqName: 'esp-allocation-events-dlq',
    queueUrl: `${ENDPOINT}/${ACCOUNT_ID}/esp-allocation-events`,
    eventBus: 'esp-audit-bus',
    buckets: {
      web: 'esp-frontend',
      rosters: 'esp-roster-uploads',
      layouts: 'esp-hall-layouts',
      seatmaps: 'esp-seatmap-exports',
    },
    tables: { holidayCache: 'EspHolidayCache', revokedTokens: 'EspRevokedTokens' },
    secrets: {
      jwt: 'esp/jwt',
      calendarific: 'esp/calendarific',
      db: (service) => `esp/db/${service}`,
    },
    logGroup: (service) => `/esp/${service}`,
    metricNamespace: 'ESP',
  },
};
