// /api/exams — Exam & Enrolment service routes (owner: Nour).
// Every route requires a valid JWT; writes are admin-only; proctors may only
// read exams they are assigned to (ownership check, logged when denied).
const express = require('express');
const { requireAuth, requireRole } = require('../../shared/auth');
const { validate, z, id } = require('../../shared/validate');
const { withTransaction, query } = require('../../shared/db');
const { badRequest, notFound, conflict, forbidden, HttpError } = require('../../shared/errors');
const { audit } = require('../../shared/audit');
const { publishEvent } = require('../../shared/events');
const store = require('./examStore');
const rules = require('./rules');
const { checkDate } = require('./holidays');
const roster = require('./roster');

const router = express.Router();
router.use(requireAuth());

// ---------- validation schemas ----------
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d), 'Not a real date');
const timeStr = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24h)');
const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

const examBody = z.object({
  courseCode: z.string().trim().toUpperCase().regex(/^[A-Z]{2,6}\d{2,4}[A-Z]?$/, 'Course code like CS301'),
  title: z.string().trim().min(3).max(120),
  examDate: dateStr,
  startTime: timeStr,
  durationMin: z.coerce.number().int().min(30).max(300),
  hallIds: z.array(id).min(1, 'Choose at least one hall').max(10)
    .refine((a) => new Set(a).size === a.length, 'Duplicate hall'),
}).refine((b) => toMin(b.startTime) >= 8 * 60, { path: ['startTime'], message: 'Exams start at 08:00 or later' })
  .refine((b) => toMin(b.startTime) + b.durationMin <= 22 * 60, { path: ['durationMin'], message: 'Exam must finish by 22:00' });

const listQuery = z.object({
  date: dateStr.optional(), from: dateStr.optional(), to: dateStr.optional(),
  course: z.string().trim().max(60).optional(),
  status: z.enum(['none', 'draft', 'published', 'needs_reallocation']).optional(),
});
const examParams = z.object({ id });

// ---------- helpers ----------
async function loadExam(examId) {
  const exam = await store.getExam(examId);
  if (!exam) throw notFound('Exam');
  return exam;
}

// Admin sees all; a proctor only exams they supervise; everyone else 403.
async function assertCanView(req, exam) {
  if (req.user.role === 'admin') return;
  if (req.user.role === 'proctor' && await store.isProctorAssigned(exam.id, req.user.id)) return;
  await audit(req, 'ACCESS_DENIED', { outcome: 'denied', target: `exam:${exam.id}`, details: { reason: 'not_assigned' } });
  throw forbidden('You are not assigned to this exam');
}

function assertFuture(date, time) {
  if (new Date(`${date}T${time}:00`) < new Date()) throw new HttpError(400, 'DATE_IN_PAST', 'Exams cannot be scheduled in the past');
}

// Serialises bookings per hall so two admins cannot double-book at the same instant.
async function lockHalls(client, hallIds) {
  for (const h of [...hallIds].sort((a, b) => a - b)) await client.query('SELECT pg_advisory_xact_lock(42, $1)', [h]);
}

async function assertHallsExist(hallIds) {
  const found = await store.existingHallIds(hallIds);
  const missing = hallIds.filter((h) => !found.includes(h));
  if (missing.length) throw badRequest('Unknown hall', missing.map((m) => ({ field: 'body.hallIds', message: `Hall ${m} does not exist` })));
}

function capacityWarning(enrolled, capacity) {
  return enrolled > capacity ? `Roster (${enrolled}) is larger than the usable seats in the selected halls (${capacity})` : null;
}

// ---------- exams ----------
router.get('/', requireRole('admin', 'proctor'), validate({ query: listQuery }), async (req, res) => {
  res.json({ exams: await store.listExams(req.valid.query, req.user) });
});

// Halls + whether each is free at a given time (used by the exam form).
router.get('/hall-options', requireRole('admin'), validate({
  query: z.object({ date: dateStr.optional(), start: timeStr.optional(), duration: z.coerce.number().int().min(0).max(300).optional(), excludeExamId: z.coerce.number().int().min(0).optional() }),
}), async (req, res) => {
  res.json({ halls: await store.hallOptions(req.valid.query) });
});

router.get('/:id', requireRole('admin', 'proctor'), validate({ params: examParams }), async (req, res) => {
  const exam = await loadExam(req.valid.params.id);
  await assertCanView(req, exam);
  const proctors = await store.getProctors(exam.id);
  const capacity = exam.halls.reduce((n, h) => n + h.usable_seats, 0);
  res.json({ exam: { ...exam, capacity, proctors } });
});

router.post('/', requireRole('admin'), validate({ body: examBody }), async (req, res) => {
  const b = req.valid.body;
  assertFuture(b.examDate, b.startTime);
  await assertHallsExist(b.hallIds);
  const holiday = await checkDate(b.examDate);

  const examId = await withTransaction(async (client) => {
    await lockHalls(client, b.hallIds);
    const clashes = await rules.findHallClashes({ hallIds: b.hallIds, date: b.examDate, start: b.startTime, duration: b.durationMin }, client);
    if (clashes.length) throw conflict('HALL_BOOKED', 'A selected hall is already booked at this time (15 min turnover included)', clashes);
    const { rows } = await client.query(
      `INSERT INTO exams (course_code, title, exam_date, start_time, duration_min, holiday_note, holiday_checked, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [b.courseCode, b.title, b.examDate, b.startTime, b.durationMin, holiday.note, holiday.checked, req.user.id],
    );
    await client.query('INSERT INTO exam_halls (exam_id, hall_id) SELECT $1, unnest($2::int[])', [rows[0].id, b.hallIds]);
    return rows[0].id;
  });

  await audit(req, 'EXAM_CREATED', { target: `exam:${examId}`, details: { courseCode: b.courseCode, holiday: holiday.isHoliday } });
  const exam = await store.getExam(examId);
  res.status(201).json({ exam, warnings: [holiday.note].filter(Boolean), holiday });
});

// Edit / reschedule: re-checks hall bookings, student and proctor clashes and the holiday calendar.
router.put('/:id', requireRole('admin'), validate({ params: examParams, body: examBody }), async (req, res) => {
  const old = await loadExam(req.valid.params.id);
  const b = req.valid.body;
  const timeChanged = old.exam_date !== b.examDate || old.start_time !== b.startTime || old.duration_min !== b.durationMin;
  const oldHalls = old.halls.map((h) => h.id);
  const added = b.hallIds.filter((h) => !oldHalls.includes(h));
  const removed = oldHalls.filter((h) => !b.hallIds.includes(h));
  if (timeChanged) assertFuture(b.examDate, b.startTime);
  if (added.length) await assertHallsExist(added);
  const slot = { date: b.examDate, start: b.startTime, duration: b.durationMin, excludeExamId: old.id };
  const holiday = old.exam_date !== b.examDate ? await checkDate(b.examDate) : { note: old.holiday_note, checked: old.holiday_checked };

  await withTransaction(async (client) => {
    await lockHalls(client, b.hallIds);
    const hallClashes = await rules.findHallClashes({ ...slot, hallIds: b.hallIds }, client);
    if (hallClashes.length) throw conflict('HALL_BOOKED', 'A selected hall is already booked at this time (15 min turnover included)', hallClashes);
    if (timeChanged) {
      const { rows: enrolled } = await client.query('SELECT student_id FROM enrollments WHERE exam_id = $1', [old.id]);
      const studentClashes = await rules.findStudentClashes({ ...slot, studentIds: enrolled.map((r) => r.student_id) }, client);
      if (studentClashes.length) throw conflict('STUDENT_CLASH', `${studentClashes.length} enrolled student(s) have another exam at the new time`, studentClashes);
      const { rows: procs } = await client.query('SELECT DISTINCT proctor_id FROM proctor_assignments WHERE exam_id = $1 AND hall_id = ANY($2::int[])', [old.id, b.hallIds]);
      const proctorClashes = await rules.findProctorClashes({ ...slot, proctorIds: procs.map((r) => r.proctor_id) }, client);
      if (proctorClashes.length) throw conflict('PROCTOR_CLASH', 'An assigned proctor is busy at the new time', proctorClashes);
    }
    await client.query(
      `UPDATE exams SET course_code=$2, title=$3, exam_date=$4, start_time=$5, duration_min=$6, holiday_note=$7, holiday_checked=$8, updated_at=now() WHERE id=$1`,
      [old.id, b.courseCode, b.title, b.examDate, b.startTime, b.durationMin, holiday.note, holiday.checked],
    );
    if (removed.length) await client.query('DELETE FROM exam_halls WHERE exam_id = $1 AND hall_id = ANY($2::int[])', [old.id, removed]);
    if (added.length) await client.query('INSERT INTO exam_halls (exam_id, hall_id) SELECT $1, unnest($2::int[])', [old.id, added]);
  });

  // Tell the allocation service so the seating plan stays consistent.
  if (timeChanged) {
    await publishEvent('exam.rescheduled', {
      examId: old.id,
      from: { date: old.exam_date, start: old.start_time, duration: old.duration_min },
      to: { date: b.examDate, start: b.startTime, duration: b.durationMin },
    }, 'exams');
  }
  if (added.length || removed.length) await publishEvent('exam.halls_changed', { examId: old.id, addedHallIds: added, removedHallIds: removed }, 'exams');
  await audit(req, 'EXAM_UPDATED', { target: `exam:${old.id}`, details: { timeChanged, addedHalls: added, removedHalls: removed } });

  const exam = await store.getExam(old.id);
  const capacity = exam.halls.reduce((n, h) => n + h.usable_seats, 0);
  const warnings = [holiday.note, capacityWarning(exam.enrolled, capacity),
    exam.allocation_status === 'published' && (removed.length || timeChanged) ? 'This exam has a published seating plan: the allocation service has been notified to re-check it' : null].filter(Boolean);
  res.json({ exam, warnings });
});

router.delete('/:id', requireRole('admin'), validate({ params: examParams }), async (req, res) => {
  const exam = await loadExam(req.valid.params.id);
  if (exam.allocation_status === 'published') throw conflict('EXAM_PUBLISHED', 'This exam has a published seating plan and cannot be deleted');
  await query('DELETE FROM exams WHERE id = $1', [exam.id]);
  await publishEvent('exam.deleted', { examId: exam.id }, 'exams');
  await audit(req, 'EXAM_DELETED', { target: `exam:${exam.id}`, details: { courseCode: exam.course_code } });
  res.status(204).end();
});

// ---------- roster ----------
router.get('/:id/students', requireRole('admin', 'proctor'), validate({ params: examParams, query: z.object({ search: z.string().trim().max(60).optional() }) }), async (req, res) => {
  const exam = await loadExam(req.valid.params.id);
  await assertCanView(req, exam);
  res.json({ students: await store.getRoster(exam.id, req.valid.query.search) });
});

router.post('/:id/students/upload-url', requireRole('admin'), validate({ params: examParams }), async (req, res) => {
  const exam = await loadExam(req.valid.params.id);
  res.status(201).json(await roster.createUploadUrl(exam.id));
});

router.post('/:id/students', requireRole('admin'), validate({
  params: examParams,
  body: z.object({ codes: z.string().max(20000).optional(), s3Key: z.string().max(200).optional() })
    .refine((b) => !!b.codes !== !!b.s3Key, 'Send either pasted codes or an uploaded file (s3Key), not both'),
}), async (req, res) => {
  const exam = await loadExam(req.valid.params.id);
  const { codes, s3Key } = req.valid.body;
  const text = s3Key ? await roster.readUploadedCsv(exam.id, s3Key) : codes;
  const tokens = roster.parseCodes(text);
  const { accepted, rejected } = await roster.validateRows(exam, tokens);

  await withTransaction(async (client) => {
    if (accepted.length) {
      await client.query('INSERT INTO enrollments (exam_id, student_id) SELECT $1, unnest($2::int[]) ON CONFLICT DO NOTHING', [exam.id, accepted.map((a) => a.studentId)]);
    }
    await client.query(
      'INSERT INTO roster_imports (exam_id, source, s3_key, accepted, rejected, report, imported_by) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [exam.id, s3Key ? 's3' : 'paste', s3Key || null, accepted.length, rejected.length, JSON.stringify({ rejected }), req.user.id],
    );
  });

  if (accepted.length) await publishEvent('exam.roster_changed', { examId: exam.id, addedStudentIds: accepted.map((a) => a.studentId), removedStudentIds: [] }, 'exams');
  await audit(req, 'ROSTER_IMPORTED', { target: `exam:${exam.id}`, outcome: accepted.length ? 'success' : 'rejected', details: { accepted: accepted.length, rejected: rejected.length, source: s3Key ? 's3' : 'paste' } });

  const updated = await store.getExam(exam.id);
  const capacity = updated.halls.reduce((n, h) => n + h.usable_seats, 0);
  const report = { accepted: accepted.length, rejected, enrolled: updated.enrolled, warnings: [capacityWarning(updated.enrolled, capacity)].filter(Boolean) };
  if (!accepted.length) return res.status(422).json({ error: { code: 'NO_VALID_ROWS', message: 'No student could be added', details: rejected }, report });
  res.status(201).json(report);
});

router.delete('/:id/students/:studentId', requireRole('admin'), validate({ params: z.object({ id, studentId: id }) }), async (req, res) => {
  const { id: examId, studentId } = req.valid.params;
  await loadExam(examId);
  const { rowCount } = await query('DELETE FROM enrollments WHERE exam_id = $1 AND student_id = $2', [examId, studentId]);
  if (!rowCount) throw notFound('Enrolment');
  await publishEvent('exam.roster_changed', { examId, addedStudentIds: [], removedStudentIds: [studentId] }, 'exams');
  await audit(req, 'STUDENT_UNENROLLED', { target: `exam:${examId}`, details: { studentId } });
  res.status(204).end();
});

router.get('/:id/imports', requireRole('admin'), validate({ params: examParams }), async (req, res) => {
  const exam = await loadExam(req.valid.params.id);
  res.json({ imports: await store.listImports(exam.id) });
});

// ---------- proctors ----------
router.post('/:id/proctors', requireRole('admin'), validate({ params: examParams, body: z.object({ hallId: id, proctorId: id }) }), async (req, res) => {
  const exam = await loadExam(req.valid.params.id);
  const { hallId, proctorId } = req.valid.body;
  if (!exam.halls.some((h) => h.id === hallId)) throw badRequest('This hall is not used by this exam', [{ field: 'body.hallId', message: 'Hall not in exam' }]);
  const { rows } = await query("SELECT id, name FROM users WHERE id = $1 AND role = 'proctor'", [proctorId]);
  if (!rows[0]) throw badRequest('Selected user is not a proctor', [{ field: 'body.proctorId', message: 'Not a proctor' }]);
  const clashes = await rules.findProctorClashes({ proctorIds: [proctorId], date: exam.exam_date, start: exam.start_time, duration: exam.duration_min, excludeExamId: exam.id });
  if (clashes.length) throw conflict('PROCTOR_CLASH', `${rows[0].name} is already supervising ${clashes[0].course_code} at ${clashes[0].start_time}`, clashes);
  const { rows: created } = await query(
    'INSERT INTO proctor_assignments (exam_id, hall_id, proctor_id) VALUES ($1,$2,$3) RETURNING id', [exam.id, hallId, proctorId],
  );
  await audit(req, 'PROCTOR_ASSIGNED', { target: `exam:${exam.id}`, details: { hallId, proctorId } });
  res.status(201).json({ assignment: { id: created[0].id, examId: exam.id, hallId, proctorId } });
});

router.delete('/:id/proctors/:assignmentId', requireRole('admin'), validate({ params: z.object({ id, assignmentId: id }) }), async (req, res) => {
  const { id: examId, assignmentId } = req.valid.params;
  const { rowCount } = await query('DELETE FROM proctor_assignments WHERE id = $1 AND exam_id = $2', [assignmentId, examId]);
  if (!rowCount) throw notFound('Proctor assignment');
  await audit(req, 'PROCTOR_UNASSIGNED', { target: `exam:${examId}`, details: { assignmentId } });
  res.status(204).end();
});

module.exports = router;
