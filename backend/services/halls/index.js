// Hall & Seat Layout service (owner: Mohamed Rishi) — port 3002.
// Halls and seat grids: create/search/edit/resize/delete, seat blocking with
// impact previews, availability by time slot, and layout export to S3.
// Publishes hall.seat_blocked / hall.resized to SNS for the allocation worker.
// DB connection string and JWT secret come from Secrets Manager
// (esp/db/halls, esp/jwt) via shared/db and shared/auth.
const { createService } = require('../../shared/createService');
const routes = require('./routes');
const { useRevocationCheck } = require('../auth/revocation');

// Reject tokens that were revoked at logout (DynamoDB EspRevokedTokens).
useRevocationCheck();

const service = createService('halls', (app) => app.use('/api/halls', routes));

if (require.main === module) service.start();
module.exports = service;
