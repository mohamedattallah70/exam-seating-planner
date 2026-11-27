// SQL reads for the Hall & Seat Layout service. Every query is parameterised.
// The halls DB role may read exams, exam_halls, seat_assignments and the
// public user columns (see db/roles.sql); it writes only halls and seats.
const { query } = require('../../shared/db');
const { HALL_TURNOVER_MIN } = require('./rules');

const run = (db, sql, params) => (db || { query }).query(sql, params);

const HALL_COLUMNS = `
  h.id, h.name, h.building, h.rows, h.cols, h.created_at, h.updated_at,
  (SELECT count(*)::int FROM seats s WHERE s.hall_id = h.id) AS total_seats,
  (SELECT count(*)::int FROM seats s WHERE s.hall_id = h.id AND s.status = 'available') AS usable_seats,
  (SELECT count(*)::int FROM seats s WHERE s.hall_id = h.id AND s.status = 'available' AND s.col_no % 2 = 1) AS spaced_seats`;

// Search by name/building text and minimum usable (or spaced) capacity.
async function listHalls({ name = '', building = '', minCapacity = 0, spacing = false }) {
  const capCol = spacing ? 'spaced_seats' : 'usable_seats';
  const { rows } = await query(`
    SELECT * FROM (SELECT ${HALL_COLUMNS} FROM halls h) x
    WHERE strpos(lower(x.name), lower($1)) > 0
      AND strpos(lower(x.building), lower($2)) > 0
      AND x.${capCol} >= $3
    ORDER BY lower(x.name), x.id`, [name, building, minCapacity]);
  return rows;
}

async function getHallRow(id, db) {
  const { rows } = await run(db, `SELECT ${HALL_COLUMNS} FROM halls h WHERE h.id = $1`, [id]);
  return rows[0] || null;
}

async function getSeats(hallId, db) {
  const { rows } = await run(db, `
    SELECT id, row_no AS "rowNo", col_no AS "colNo", label, status, block_reason AS "blockReason"
    FROM seats WHERE hall_id = $1 ORDER BY row_no, col_no`, [hallId]);
  return rows;
}

// Hall + full grid (used to reopen a saved layout, and for the S3 export).
async function getHall(id, db) {
  const hall = await getHallRow(id, db);
  if (!hall) return null;
  hall.seats = await getSeats(id, db);
  return hall;
}

// Exams that use this hall (any status) — blocks deletion.
async function examsUsingHall(hallId, db) {
  const { rows } = await run(db, `
    SELECT e.id, e.course_code, e.exam_date::text AS exam_date, to_char(e.start_time, 'HH24:MI') AS start_time, e.allocation_status
    FROM exam_halls eh JOIN exams e ON e.id = eh.exam_id
    WHERE eh.hall_id = $1 ORDER BY e.exam_date, e.start_time`, [hallId]);
  return rows;
}

// Assignments sitting on the given seats, with exam and student details.
async function assignmentsOnSeats(seatIds, db) {
  if (!seatIds.length) return [];
  const { rows } = await run(db, `
    SELECT a.exam_id AS "examId", e.course_code AS "courseCode", e.title,
           e.exam_date::text AS "examDate", to_char(e.start_time, 'HH24:MI') AS "startTime",
           e.allocation_status AS "planStatus",
           s.id AS "seatId", s.label AS "seatLabel",
           u.id AS "studentId", u.name AS "studentName", u.student_code AS "studentCode"
    FROM seat_assignments a
    JOIN exams e ON e.id = a.exam_id
    JOIN seats s ON s.id = a.seat_id
    JOIN users u ON u.id = a.student_id
    WHERE a.seat_id = ANY($1::int[])
    ORDER BY e.exam_date, e.start_time, s.row_no, s.col_no`, [seatIds]);
  return rows;
}

// For a published exam: free usable seats in its halls versus students that
// still need a seat because their seat is blocked (pending relocations).
// `extraBlockedSeatId` is the seat we are about to block.
async function relocationCapacity(examId, extraBlockedSeatId, db) {
  const { rows } = await run(db, `
    WITH exam_seats AS (
      SELECT s.id, s.status FROM exam_halls eh JOIN seats s ON s.hall_id = eh.hall_id WHERE eh.exam_id = $1
    ), taken AS (
      SELECT seat_id FROM seat_assignments WHERE exam_id = $1
    )
    SELECT
      (SELECT count(*)::int FROM exam_seats es
         WHERE es.status = 'available' AND es.id <> $2 AND es.id NOT IN (SELECT seat_id FROM taken)) AS free_seats,
      (SELECT count(*)::int FROM seat_assignments a JOIN seats s ON s.id = a.seat_id
         WHERE a.exam_id = $1 AND (s.status = 'blocked' OR s.id = $2)) AS needing_seat`, [examId, extraBlockedSeatId]);
  return rows[0];
}

// Halls with no exam overlapping [start, start + duration], including the
// 15-minute turnover on both sides (so adjacent bookings count as busy).
async function availableHalls({ date, start, duration, minCapacity = 0, spacing = false }) {
  const capCol = spacing ? 'spaced_seats' : 'usable_seats';
  const { rows } = await query(`
    SELECT x.*, b.booked_by FROM (SELECT ${HALL_COLUMNS} FROM halls h) x
    LEFT JOIN LATERAL (
      SELECT string_agg(e.course_code || ' ' || to_char(e.start_time, 'HH24:MI'), ', ' ORDER BY e.start_time) AS booked_by
      FROM exam_halls eh JOIN exams e ON e.id = eh.exam_id
      WHERE eh.hall_id = x.id
        AND (e.exam_date + e.start_time) < ($1::date + $2::time + make_interval(mins => $3::int + $4::int))
        AND ($1::date + $2::time) < (e.exam_date + e.start_time + make_interval(mins => e.duration_min + $4::int))
    ) b ON true
    WHERE x.${capCol} >= $5
    ORDER BY lower(x.name), x.id`, [date, start, duration, HALL_TURNOVER_MIN, minCapacity]);
  return {
    available: rows.filter((r) => !r.booked_by).map(({ booked_by: _b, ...h }) => h),
    booked: rows.filter((r) => r.booked_by).map((r) => ({ id: r.id, name: r.name, bookedBy: r.booked_by })),
  };
}

module.exports = { listHalls, getHallRow, getSeats, getHall, examsUsingHall, assignmentsOnSeats, relocationCapacity, availableHalls };
