// Business rules for scheduling: clash detection between exams that share a
// hall, a student or a proctor. Two exams "overlap" when their time windows
// intersect; halls also need a 15-minute turnover buffer between exams.
const { query } = require('../../shared/db');

const HALL_TURNOVER_MIN = 15;

// Overlap of exam alias `e` with the window ($2 date, $3 start, $4 duration) +/- $5 buffer.
const OVERLAP = `
  (e.exam_date + e.start_time) < ($2::date + $3::time + make_interval(mins => $4::int + $5::int))
  AND ($2::date + $3::time) < (e.exam_date + e.start_time + make_interval(mins => e.duration_min + $5::int))`;

function run(client, sql, params) {
  return (client || { query }).query(sql, params);
}

// Exams already using any of these halls at an overlapping time.
async function findHallClashes({ hallIds, date, start, duration, excludeExamId = 0 }, client) {
  if (!hallIds.length) return [];
  const { rows } = await run(client, `
    SELECT e.id AS exam_id, e.course_code, to_char(e.start_time, 'HH24:MI') AS start_time, e.duration_min, h.id AS hall_id, h.name AS hall_name
    FROM exam_halls eh JOIN exams e ON e.id = eh.exam_id JOIN halls h ON h.id = eh.hall_id
    WHERE eh.hall_id = ANY($1::int[]) AND e.id <> $6 AND ${OVERLAP}
    ORDER BY e.start_time`, [hallIds, date, start, duration, HALL_TURNOVER_MIN, excludeExamId]);
  return rows;
}

// Students (from the given ids) who already sit another exam at an overlapping time.
async function findStudentClashes({ studentIds, date, start, duration, excludeExamId = 0 }, client) {
  if (!studentIds.length) return [];
  const { rows } = await run(client, `
    SELECT en.student_id, u.student_code, e.id AS exam_id, e.course_code, to_char(e.start_time, 'HH24:MI') AS start_time
    FROM enrollments en JOIN exams e ON e.id = en.exam_id JOIN users u ON u.id = en.student_id
    WHERE en.student_id = ANY($1::int[]) AND e.id <> $6 AND ${OVERLAP}`, [studentIds, date, start, duration, 0, excludeExamId]);
  return rows;
}

// Proctors (from the given ids) already supervising an overlapping exam.
async function findProctorClashes({ proctorIds, date, start, duration, excludeExamId = 0 }, client) {
  if (!proctorIds.length) return [];
  const { rows } = await run(client, `
    SELECT pa.proctor_id, u.name AS proctor_name, e.id AS exam_id, e.course_code, to_char(e.start_time, 'HH24:MI') AS start_time
    FROM proctor_assignments pa JOIN exams e ON e.id = pa.exam_id JOIN users u ON u.id = pa.proctor_id
    WHERE pa.proctor_id = ANY($1::int[]) AND e.id <> $6 AND ${OVERLAP}`, [proctorIds, date, start, duration, 0, excludeExamId]);
  return rows;
}

// Number of available (not blocked) seats in the given halls.
async function usableCapacity(hallIds, client) {
  if (!hallIds.length) return 0;
  const { rows } = await run(client, "SELECT count(*)::int AS n FROM seats WHERE hall_id = ANY($1::int[]) AND status = 'available'", [hallIds]);
  return rows[0].n;
}

module.exports = { findHallClashes, findStudentClashes, findProctorClashes, usableCapacity, HALL_TURNOVER_MIN };
