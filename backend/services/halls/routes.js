// Hall & Seat Layout API (owner: Mohamed Rishi), mounted at /api/halls.
// Roles: admin manages halls; proctor has read-only access to halls and
// grids; students cannot use any hall route. Impact previews name students,
// so they are admin-only. Static paths (/available) are declared before /:id.
const express = require('express');
const { requireAuth, requireRole } = require('../../shared/auth');
const { validate, z, id } = require('../../shared/validate');
const { notFound, forbidden } = require('../../shared/errors');
const { audit } = require('../../shared/audit');
const { publishEvent } = require('../../shared/events');
const { log } = require('../../shared/logger');
const store = require('./store');
const svc = require('./hallService');
const exportsS3 = require('./exports');
const { MAX_DIM } = require('./rules');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const dim = z.coerce.number().int().min(1).max(MAX_DIM);
const bodyDim = z.number().int().min(1).max(MAX_DIM);
const hallName = z.string().trim().min(2).max(60);
const building = z.string().trim().min(1).max(60);
const bool = z.enum(['true', 'false']).optional().transform((v) => v === 'true');

const hallParams = z.object({ id });
const seatParams = z.object({ id, seatId: id });
const createBody = z.object({ name: hallName, building, rows: bodyDim, cols: bodyDim }).strict();
const updateBody = z.object({ name: hallName.optional(), building: building.optional(), rows: bodyDim.optional(), cols: bodyDim.optional() })
  .strict().refine((b) => Object.keys(b).length > 0, { message: 'Send at least one of name, building, rows, cols' });
const seatBody = z.object({ status: z.enum(['available', 'blocked']), reason: z.string().trim().max(120).optional() }).strict();
const listQuery = z.object({
  name: z.string().trim().max(60).optional().default(''),
  building: z.string().trim().max(60).optional().default(''),
  minCapacity: z.coerce.number().int().min(0).max(MAX_DIM * MAX_DIM).optional().default(0),
  spacing: bool,
});
const availableQuery = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine((d) => !Number.isNaN(Date.parse(d)), 'Not a real date'),
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24h)'),
  duration: z.coerce.number().int().min(30).max(300),
  minCapacity: z.coerce.number().int().min(0).max(MAX_DIM * MAX_DIM).optional().default(0),
  spacing: bool,
});
const exportBody = z.object({ formats: z.array(z.enum(['csv', 'json'])).min(1).max(2).optional() }).strict();

router.use(requireAuth());
const staff = requireRole('admin', 'proctor');
const admin = requireRole('admin');

router.get('/', staff, validate({ query: listQuery }), wrap(async (req, res) => {
  res.json({ halls: await store.listHalls(req.valid.query) });
}));

// Halls free for the whole slot (15-min turnover each side). Used by the exam form.
router.get('/available', staff, validate({ query: availableQuery }), wrap(async (req, res) => {
  const q = req.valid.query;
  const result = await store.availableHalls(q);
  res.json({ slot: { date: q.date, start: q.start, duration: q.duration }, halls: result.available, booked: result.booked });
}));

router.post('/', admin, validate({ body: createBody }), wrap(async (req, res) => {
  const hall = await svc.createHall(req.valid.body);
  await audit(req, 'HALL_CREATED', { target: `hall:${hall.id}`, details: { name: hall.name, rows: hall.rows, cols: hall.cols } });
  res.status(201).json({ hall });
}));

router.get('/:id', staff, validate({ params: hallParams }), wrap(async (req, res) => {
  const hall = await store.getHall(req.valid.params.id);
  if (!hall) throw notFound('Hall');
  res.json({ hall });
}));

router.get('/:id/resize-impact', admin, validate({ params: hallParams, query: z.object({ rows: dim, cols: dim }) }), wrap(async (req, res) => {
  res.json(await svc.resizeImpact(req.valid.params.id, req.valid.query.rows, req.valid.query.cols));
}));

router.put('/:id', admin, validate({ params: hallParams, body: updateBody }), wrap(async (req, res) => {
  const hallId = req.valid.params.id;
  let r;
  try {
    r = await svc.updateHall(hallId, req.valid.body);
  } catch (err) {
    if (err.code === 'HALL_IN_USE_PUBLISHED') await audit(req, 'HALL_RESIZE_REFUSED', { target: `hall:${hallId}`, outcome: 'denied', details: { to: req.valid.body } });
    throw err;
  }
  if (r.resized) {
    await publishEvent('hall.resized', { hallId, removedSeatIds: r.removedSeatIds }, 'halls');
    await audit(req, 'HALL_RESIZED', { target: `hall:${hallId}`, details: { from: r.from, to: { rows: r.hall.rows, cols: r.hall.cols }, removed: r.removedSeatIds.length, added: r.addedSeats } });
  } else {
    await audit(req, 'HALL_UPDATED', { target: `hall:${hallId}` });
  }
  res.json({ hall: r.hall, removedSeatIds: r.removedSeatIds, addedSeats: r.addedSeats });
}));

router.get('/:id/seats/:seatId/impact', admin, validate({ params: seatParams }), wrap(async (req, res) => {
  const { id: hallId, seatId } = req.valid.params;
  if (!(await store.getHallRow(hallId))) throw notFound('Hall');
  res.json(await svc.seatImpact(hallId, seatId));
}));

router.patch('/:id/seats/:seatId', admin, validate({ params: seatParams, body: seatBody }), wrap(async (req, res) => {
  const { id: hallId, seatId } = req.valid.params;
  if (!(await store.getHallRow(hallId))) throw notFound('Hall');
  let r;
  try {
    r = await svc.setSeatStatus(hallId, seatId, req.valid.body);
  } catch (err) {
    if (err.code === 'NO_RELOCATION_CAPACITY') await audit(req, 'SEAT_BLOCK_REFUSED', { target: `hall:${hallId} seat:${seatId}`, outcome: 'denied', details: err.details });
    throw err;
  }
  if (r.publish) await publishEvent('hall.seat_blocked', { hallId, seatId }, 'halls');
  if (r.changed) {
    await audit(req, r.seat.status === 'blocked' ? 'SEAT_BLOCKED' : 'SEAT_UNBLOCKED', {
      target: `hall:${hallId} seat:${r.seat.label}`,
      details: { affectedExams: r.affected.map((e) => ({ examId: e.examId, outcome: e.outcome, students: e.students.length })) },
    });
  }
  res.json({ seat: r.seat, changed: r.changed, affected: r.affected, hall: r.hall });
}));

router.delete('/:id', admin, validate({ params: hallParams }), wrap(async (req, res) => {
  const hallId = req.valid.params.id;
  try {
    const hall = await svc.deleteHall(hallId);
    await audit(req, 'HALL_DELETED', { target: `hall:${hallId}`, details: { name: hall.name } });
  } catch (err) {
    if (err.code === 'HALL_IN_USE') await audit(req, 'HALL_DELETE_REFUSED', { target: `hall:${hallId}`, outcome: 'denied' });
    throw err;
  }
  res.status(204).end();
}));

// S3 layout export (CSV + JSON by default).
router.post('/:id/export', admin, validate({ params: hallParams, body: exportBody }), wrap(async (req, res) => {
  const hall = await store.getHall(req.valid.params.id);
  if (!hall) throw notFound('Hall');
  const result = await exportsS3.exportLayout(hall, req.valid.body.formats || ['csv', 'json']);
  log('info', 'hall_layout_exported', { hallId: hall.id, files: result.files.map((f) => f.key) });
  await audit(req, 'HALL_LAYOUT_EXPORTED', { target: `hall:${hall.id}`, details: { keys: result.files.map((f) => f.key) } });
  res.status(201).json(result);
}));

// Read a stored export back. Only keys under this hall's own prefix.
router.get('/:id/export', admin, validate({ params: hallParams, query: z.object({ key: z.string().max(200) }) }), wrap(async (req, res) => {
  const hallId = req.valid.params.id;
  const { key } = req.valid.query;
  if (!new RegExp(`^halls/${hallId}/layout-[0-9TZ-]+\\.(csv|json)$`).test(key)) throw forbidden('That export does not belong to this hall');
  let obj;
  try { obj = await exportsS3.readExport(key); } catch (err) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) throw notFound('Export');
    throw err;
  }
  res.type(obj.contentType || 'text/plain').send(obj.body);
}));

module.exports = router;
