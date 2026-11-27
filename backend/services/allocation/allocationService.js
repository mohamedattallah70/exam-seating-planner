// Seat Allocation & Lookup service: data access + business rules
// (owner: Mohamed Attallah; rules ported from his original allocationService).
// LIFECYCLE: none -> draft (run) -> published (publish).
//            Any change from another service that breaks a plan -> needs_reallocation.
// Students and proctors only ever see "published" plans.
const { query, withTransaction } = require('../../shared/db');
const { HttpError, notFound, conflict } = require('../../shared/errors');
const engine = require('./engine');

// Serialises every write to one exam's plan (run / move / publish / worker),
// so two admins (or the admin and the worker) cannot interleave.
const lockExam = (client, examId) => client.query('SELECT pg_advisory_xact_lock(43, $1)', [examId]);

async function getExam(examId, db = { query }) {
  const { rows } = await db.query(
    `SELECT id, course_code, title, exam_date::text AS exam_date, to_char(start_time, 'HH24:MI') AS start_time,
            duration_min, allocation_status
       FROM exams WHERE id = $1`, [examId]);
  if (!rows[0]) throw notFound('Exam');
  return rows[0];
}

async function lastRun(examId, db = { query }) {
  const { rows } = await db.query(
    'SELECT strategy, spacing, placed, trigger, created_at FROM allocation_runs WHERE exam_id = $1 ORDER BY id DESC LIMIT 1', [examId]);
  return rows[0] || null;
}

async function examHallsAndSeats(examId, db = { query }) {
  const halls = (await db.query(
    `SELECT h.id, h.name, h.building, h.rows, h.cols FROM exam_halls eh JOIN halls h ON h.id = eh.hall_id
      WHERE eh.exam_id = $1 ORDER BY h.name`, [examId])).rows;
  const seats = halls.length ? (await db.query(
    `SELECT id, hall_id AS "hallId", row_no AS "rowNo", col_no AS "colNo", label, status
       FROM seats WHERE hall_id = ANY($1::int[])`, [halls.map((h) => h.id)])).rows : [];
  return { halls, seats };
}

const setStatus = (db, examId, status) =>
  db.query('UPDATE exams SET allocation_status = $2, updated_at = now() WHERE id = $1', [examId, status]);

// ---------- 1. run the automatic allocation ----------
async function runAllocation(examId, { strategy, spacing }, userId) {
  const t0 = Date.now();
  return withTransaction(async (client) => {
    await lockExam(client, examId);
    const exam = await getExam(examId, client);
    if (exam.allocation_status === 'published') {
      throw conflict('ALREADY_PUBLISHED', 'This plan is published. Move single students instead, or wait for a change to mark it for re-allocation.');
    }
    const { halls, seats } = await examHallsAndSeats(examId, client);
    if (!halls.length) throw conflict('NO_HALLS', 'This exam has no halls yet. Add halls to the exam first.');
    const students = (await client.query(
      `SELECT u.id, u.student_code AS "studentCode" FROM enrollments e JOIN users u ON u.id = e.student_id WHERE e.exam_id = $1`,
      [examId])).rows;
    if (!students.length) throw conflict('NO_STUDENTS', 'No students are enrolled in this exam yet.');

    const result = engine.plan({ students, halls, seats, strategy, spacing });
    if (result.error) {
      throw conflict('NOT_ENOUGH_SEATS',
        `Not enough seats: ${result.needed} students but only ${result.available} usable seats. Add a hall, unblock seats or turn spacing off.`,
        { needed: result.needed, available: result.available });
    }
    await client.query('DELETE FROM seat_assignments WHERE exam_id = $1', [examId]);
    await client.query(
      `INSERT INTO seat_assignments (exam_id, seat_id, student_id)
       SELECT $1, s, u FROM unnest($2::int[], $3::int[]) AS t(s, u)`,
      [examId, result.assignments.map((a) => a.seatId), result.assignments.map((a) => a.studentId)]);
    await client.query(
      'INSERT INTO allocation_runs (exam_id, strategy, spacing, placed, trigger, run_by) VALUES ($1,$2,$3,$4,$5,$6)',
      [examId, strategy, spacing, result.assignments.length, 'manual', userId]);
    await setStatus(client, examId, 'draft');
    return { examId, status: 'draft', strategy, spacing, studentsSeated: result.needed, usableSeats: result.available, halls: result.perHall, ms: Date.now() - t0 };
  });
}

// ---------- 2. view + search ----------
async function getAllocation(examId, { hallId, student }) {
  const exam = await getExam(examId);
  const params = [examId];
  const where = ['a.exam_id = $1'];
  if (hallId) { params.push(hallId); where.push(`s.hall_id = $${params.length}`); }
  if (student) { params.push(`%${student}%`); where.push(`(u.student_code ILIKE $${params.length} OR u.name ILIKE $${params.length})`); }
  const assignments = (await query(
    `SELECT a.id AS "assignmentId", u.student_code AS "studentCode", u.name AS "studentName",
            h.id AS "hallId", h.name AS hall, s.label AS seat, s.row_no AS "rowNo", s.col_no AS "colNo"
       FROM seat_assignments a JOIN users u ON u.id = a.student_id
       JOIN seats s ON s.id = a.seat_id JOIN halls h ON h.id = s.hall_id
      WHERE ${where.join(' AND ')} ORDER BY u.student_code`, params)).rows;
  const { halls, seats } = await examHallsAndSeats(examId);
  const run = await lastRun(examId);
  const used = (await query(
    `SELECT s.hall_id AS "hallId", count(*)::int AS n FROM seat_assignments a JOIN seats s ON s.id = a.seat_id
      WHERE a.exam_id = $1 GROUP BY s.hall_id`, [examId])).rows;
  const usedBy = new Map(used.map((r) => [r.hallId, r.n]));
  const counts = (await query(
    `SELECT (SELECT count(*)::int FROM enrollments WHERE exam_id = $1) AS enrolled,
            (SELECT count(*)::int FROM seat_assignments WHERE exam_id = $1) AS seated`, [examId])).rows[0];
  const ordered = engine.orderHalls(halls, seats, run?.spacing || false);
  return {
    exam,
    lastRun: run,
    summary: {
      ...counts,
      unseated: Math.max(counts.enrolled - counts.seated, 0),
      halls: ordered.map((h, i) => ({ hallId: h.id, hall: h.name, order: i + 1, usableSeats: h.usable.length, seatsUsed: usedBy.get(h.id) || 0 })),
    },
    assignments,
  };
}

// ---------- 3. move one student ----------
async function moveStudent(assignmentId, { hallId, seatLabel }) {
  return withTransaction(async (client) => {
    const a = (await client.query(
      `SELECT a.id, a.exam_id AS "examId", a.seat_id AS "seatId", u.student_code AS "studentCode"
         FROM seat_assignments a JOIN users u ON u.id = a.student_id WHERE a.id = $1`, [assignmentId])).rows[0];
    if (!a) throw notFound('Seat assignment');
    await lockExam(client, a.examId);
    const inExam = await client.query('SELECT 1 FROM exam_halls WHERE exam_id = $1 AND hall_id = $2', [a.examId, hallId]);
    if (!inExam.rowCount) throw new HttpError(400, 'HALL_NOT_IN_EXAM', 'That hall is not used by this exam.');
    const seat = (await client.query('SELECT id, status, label FROM seats WHERE hall_id = $1 AND upper(label) = upper($2)', [hallId, seatLabel])).rows[0];
    if (!seat) throw notFound(`Seat ${seatLabel} in that hall`);
    if (seat.status === 'blocked') throw conflict('SEAT_BLOCKED', `Seat ${seat.label} is blocked.`);
    if (seat.id === a.seatId) throw conflict('SAME_SEAT', 'The student is already in that seat.');
    const taken = await client.query('SELECT 1 FROM seat_assignments WHERE exam_id = $1 AND seat_id = $2', [a.examId, seat.id]);
    if (taken.rowCount) throw conflict('SEAT_TAKEN', `Seat ${seat.label} is already taken.`);
    await client.query('UPDATE seat_assignments SET seat_id = $2, updated_at = now() WHERE id = $1', [assignmentId, seat.id]);
    const exam = await getExam(a.examId, client);
    return { assignmentId, examId: a.examId, studentCode: a.studentCode, hallId, seat: seat.label, status: exam.allocation_status };
  });
}

// ---------- 4. publish ----------
async function publishAllocation(examId) {
  return withTransaction(async (client) => {
    await lockExam(client, examId);
    const exam = await getExam(examId, client);
    if (exam.allocation_status === 'published') throw conflict('ALREADY_PUBLISHED', 'Already published.');
    if (exam.allocation_status === 'none') throw conflict('NO_ALLOCATION', 'Run the allocation first.');
    if (exam.allocation_status === 'needs_reallocation') throw conflict('NEEDS_REALLOCATION', 'A change made this plan invalid. Run the allocation again before publishing.');
    const { unseated, stale } = (await client.query(
      `SELECT (SELECT count(*)::int FROM enrollments e WHERE e.exam_id = $1
                 AND NOT EXISTS (SELECT 1 FROM seat_assignments a WHERE a.exam_id = $1 AND a.student_id = e.student_id)) AS unseated,
              (SELECT count(*)::int FROM seat_assignments a WHERE a.exam_id = $1
                 AND NOT EXISTS (SELECT 1 FROM enrollments e WHERE e.exam_id = $1 AND e.student_id = a.student_id)) AS stale`,
      [examId])).rows[0];
    if (unseated || stale) {
      throw conflict('ALLOCATION_OUTDATED', 'The student list changed after the allocation was run. Run it again before publishing.', { unseated, notEnrolled: stale });
    }
    await setStatus(client, examId, 'published');
    return { examId, status: 'published' };
  });
}

// ---------- 5. clear a draft ----------
async function clearAllocation(examId) {
  return withTransaction(async (client) => {
    await lockExam(client, examId);
    const exam = await getExam(examId, client);
    if (exam.allocation_status === 'published') throw conflict('ALREADY_PUBLISHED', 'A published plan cannot be cleared.');
    await client.query('DELETE FROM seat_assignments WHERE exam_id = $1', [examId]);
    await setStatus(client, examId, 'none');
  });
}

// ---------- 6. admin overview ----------
async function listOverview() {
  return (await query(
    `SELECT e.id, e.course_code, e.title, e.exam_date::text AS exam_date, to_char(e.start_time, 'HH24:MI') AS start_time,
            e.allocation_status,
            (SELECT count(*)::int FROM enrollments n WHERE n.exam_id = e.id) AS enrolled,
            (SELECT count(*)::int FROM seat_assignments a WHERE a.exam_id = e.id) AS seated,
            (SELECT count(*)::int FROM exam_halls h WHERE h.exam_id = e.id) AS halls
       FROM exams e ORDER BY e.exam_date, e.start_time`)).rows;
}

// ---------- 7. student "My seat" (id always from the JWT) ----------
async function getMySeats(studentId) {
  return (await query(
    `SELECT e.course_code, e.title, e.exam_date::text AS exam_date, to_char(e.start_time, 'HH24:MI') AS start_time,
            e.duration_min, h.name AS hall, h.building, s.label AS seat, s.row_no AS "rowNo", s.col_no AS "colNo"
       FROM seat_assignments a JOIN exams e ON e.id = a.exam_id
       JOIN seats s ON s.id = a.seat_id JOIN halls h ON h.id = s.hall_id
      WHERE a.student_id = $1 AND e.allocation_status = 'published' AND e.exam_date >= current_date
      ORDER BY e.exam_date, e.start_time`, [studentId])).rows;
}

// ---------- 8. proctor "My halls" ----------
async function getMyProctorHalls(proctorId) {
  return (await query(
    `SELECT e.id AS "examId", e.course_code, e.title, e.exam_date::text AS exam_date, to_char(e.start_time, 'HH24:MI') AS start_time,
            h.id AS "hallId", h.name AS hall, h.building, e.allocation_status = 'published' AS "seatMapReady"
       FROM proctor_assignments p JOIN exams e ON e.id = p.exam_id JOIN halls h ON h.id = p.hall_id
      WHERE p.proctor_id = $1 AND e.exam_date >= current_date
      ORDER BY e.exam_date, e.start_time, h.name`, [proctorId])).rows;
}

// ---------- 9. seat map of one hall ----------
async function getSeatMap(examId, hallId, user) {
  const exam = await getExam(examId);
  const hall = (await query(
    `SELECT h.id, h.name, h.building, h.rows, h.cols FROM exam_halls eh JOIN halls h ON h.id = eh.hall_id
      WHERE eh.exam_id = $1 AND eh.hall_id = $2`, [examId, hallId])).rows[0];
  if (!hall) throw new HttpError(404, 'HALL_NOT_IN_EXAM', 'That hall is not used by this exam');
  if (user.role === 'proctor') {
    const ok = await query('SELECT 1 FROM proctor_assignments WHERE exam_id = $1 AND hall_id = $2 AND proctor_id = $3', [examId, hallId, user.id]);
    if (!ok.rowCount) throw new HttpError(403, 'NOT_YOUR_HALL', 'You are not assigned to this hall for this exam');
    if (exam.allocation_status !== 'published') throw conflict('NOT_PUBLISHED', 'The seating plan for this exam is not published yet.');
  }
  const seats = (await query(
    `SELECT s.id, s.row_no AS "rowNo", s.col_no AS "colNo", s.label, s.status,
            u.student_code AS "studentCode", u.name AS "studentName"
       FROM seats s LEFT JOIN seat_assignments a ON a.seat_id = s.id AND a.exam_id = $1
       LEFT JOIN users u ON u.id = a.student_id
      WHERE s.hall_id = $2 ORDER BY s.row_no, s.col_no`, [examId, hallId])).rows;
  return { exam, hall, seatsUsed: seats.filter((s) => s.studentCode).length, seats };
}

module.exports = {
  HttpError, lockExam, getExam, lastRun, examHallsAndSeats, setStatus,
  runAllocation, getAllocation, moveStudent, publishAllocation, clearAllocation,
  listOverview, getMySeats, getMyProctorHalls, getSeatMap,
};
