// Exam & Enrolment service (owner: Nour) — port 3003.
// Exams + hall booking, roster import (paste or CSV via S3), proctor
// assignment, Egyptian public-holiday check (Calendarific, cached in DynamoDB).
const { createService } = require('../../shared/createService');
const examRoutes = require('./routes');
const { holidayRouter, userRouter } = require('./lookupRoutes');

const service = createService('exams', (app) => {
  app.use('/api/exams', examRoutes);
  app.use('/api/holidays', holidayRouter);
  app.use('/api/users', userRouter);
});

if (require.main === module) service.start();
module.exports = service;
