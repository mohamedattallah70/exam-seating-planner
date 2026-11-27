// Seat Allocation & Lookup routes (owner: Mohamed Attallah): URLs + who may call them.
// Every route needs a valid JWT; admin-only writes; students/proctors only see their own data.
const express = require('express');
const { requireAuth, requireRole } = require('../../shared/auth');
const { validate, z, id } = require('../../shared/validate');
const { audit } = require('../../shared/audit');
const svc = require('./allocationService');
const { safeExport, metric } = require('./exports');

const router = express.Router();
router.use(requireAuth());
const admin = requireRole('admin');
const examParams = validate({ params: z.object({ examId: id }) });

// failed 409s are audited too, so the admin can see why a run was refused
const audited = (action, target, fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err.status === 409 || err.status === 403) await audit(req, err.status === 403 ? 'ACCESS_DENIED' : action, { target: target(req), outcome: err.status === 403 ? 'denied' : 'failed', details: { code: err.code } });
    next(err);
  }
};
const examTarget = (req) => `exam ${req.params.examId}`;

router.get('/allocations/overview', admin, async (_req, res) => res.json({ exams: await svc.listOverview() }));

router.post('/exams/:examId/allocation', admin, examParams,
  validate({ body: z.object({ strategy: z.enum(['fill', 'balance']).default('fill'), spacing: z.boolean().default(false) }).strict() }),
  audited('ALLOCATION_RUN', examTarget, async (req, res) => {
    const { examId } = req.valid.params;
    const r = await svc.runAllocation(examId, req.valid.body, req.user.id);
    await audit(req, 'ALLOCATION_RUN', { target: examTarget(req), details: { strategy: r.strategy, spacing: r.spacing, seated: r.studentsSeated } });
    await Promise.all([metric('StudentsSeated', r.studentsSeated), metric('AllocationRunMs', r.ms, 'Milliseconds')]);
    res.status(201).json(r);
  }));

router.get('/exams/:examId/allocation', admin, examParams,
  validate({ query: z.object({ hallId: id.optional(), student: z.string().trim().max(60).optional() }) }),
  async (req, res) => res.json(await svc.getAllocation(req.valid.params.examId, req.valid.query)));

router.post('/exams/:examId/allocation/publish', admin, examParams, audited('ALLOCATION_PUBLISHED', examTarget, async (req, res) => {
  const { examId } = req.valid.params;
  const r = await svc.publishAllocation(examId);
  const exports = await safeExport(examId);
  await audit(req, 'ALLOCATION_PUBLISHED', { target: examTarget(req), details: { exports } });
  res.json({ ...r, exports });
}));

router.delete('/exams/:examId/allocation', admin, examParams, audited('ALLOCATION_CLEARED', examTarget, async (req, res) => {
  await svc.clearAllocation(req.valid.params.examId);
  await audit(req, 'ALLOCATION_CLEARED', { target: examTarget(req) });
  res.status(204).end();
}));

const seatLabel = z.string().trim().regex(/^[A-Za-z]{1,2}[0-9]{1,2}$/, 'Seat like C7');
router.patch('/allocations/:assignmentId', admin, validate({ params: z.object({ assignmentId: id }), body: z.object({ hallId: id, seatLabel }).strict() }),
  audited('STUDENT_MOVED', (req) => `assignment ${req.params.assignmentId}`, async (req, res) => {
    const r = await svc.moveStudent(req.valid.params.assignmentId, req.valid.body);
    await audit(req, 'STUDENT_MOVED', { target: `exam ${r.examId}`, details: { studentCode: r.studentCode, to: r.seat } });
    if (r.status === 'published') await safeExport(r.examId);
    res.json(r);
  }));

router.get('/me/seats', requireRole('student'), async (req, res) => res.json({ seats: await svc.getMySeats(req.user.id) }));
router.get('/me/proctor-halls', requireRole('proctor'), async (req, res) => res.json({ halls: await svc.getMyProctorHalls(req.user.id) }));

router.get('/exams/:examId/halls/:hallId/seat-map', requireRole('admin', 'proctor'),
  validate({ params: z.object({ examId: id, hallId: id }) }),
  audited('SEAT_MAP_VIEW', (req) => `exam ${req.params.examId} hall ${req.params.hallId}`, async (req, res) => {
    res.json(await svc.getSeatMap(req.valid.params.examId, req.valid.params.hallId, req.user));
  }));

module.exports = router;
