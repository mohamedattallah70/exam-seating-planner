// Seat Allocation & Lookup service (owner: Mohamed Attallah) — port 3004.
// Run / view / move / publish / clear seating plans, student "My seat",
// proctor seat maps; publishes CSV seat maps to S3 and custom metrics to
// CloudWatch. The event worker (worker.js) runs as a separate process.
const { createService } = require('../../shared/createService');
const routes = require('./routes');

const service = createService('allocation', (app) => app.use('/api', routes));

if (require.main === module) service.start();
module.exports = service;
