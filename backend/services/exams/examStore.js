// Data access for the Exam & Enrolment service (parameterised SQL only).
const { query } = require('../../shared/db');

const EXAM_SELECT = `
  SELECT e.id, e.course_code, e.title, to_char(e.exam_date, 'YYYY-MM-DD') AS exam_date,
         to_char(e.start_time, 'HH24:MI') AS start_time, e.duration_min,
         to_char(e.start_time + make_interval(mins => e.duration_min), 'HH24:MI') AS end_time,
         e.holiday_note, e.holiday_checked, e.allocation_status, e.created_at, e.updated_at,
         (SELECT count(*)::int FROM enrollments en WHERE en.exam_id = e.id) AS enrolled,
         COALESCE((SELECT json_agg(json_build_object(
             'id', h.id, 'name', h.name, 'building', h.building,
             'usable_seats', (SELECT count(*)::int FROM seats s WHERE s.hall_id = h.id AND s.status = 'available')) ORDER BY h.name)
           FROM exam_halls eh JOIN halls h ON h.id = eh.hall_id WHERE eh.exam_id = e.id), '[]') AS halls
  FROM exams e`;

// Search/filter. Proctors only ever see exams they are assigned to.
async function listExams({ date, from, to, course, status }, user) {
  const where = [];
  const params = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  if (date) add('e.exam_date = ?', date);
  if (from) add('e.exam_date >= ?', from);
  if (to) add('e.exam_date <= ?', to);
  if (course) {
    params.push(`%${course}%`);
    where.push(`(e.course_code ILIKE $${params.length} OR e.title ILIKE $${params.length})`);
  }
  if (status) add('e.allocation_status = ?', status);
  if (user.role === 'proctor') add('EXISTS (SELECT 1 FROM proctor_assignments pa WHERE pa.exam_id = e.id AND pa.proctor_id = ?)', user.id);
  const sql = `${EXAM_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY e.exam_date, e.start_time LIMIT 500`;
  return (await query(sql, params)).rows;
}

async function getExam(id) {
  return (await query(`${EXAM_SELECT} WHERE e.id = $1`, [id])).rows[0] || null;
}

async function getProctors(examId) {
  return (await query(`
    SELECT pa.id, pa.hall_id, h.name AS hall_name, pa.proctor_id, u.name AS proctor_name, u.email AS proctor_email
    FROM proctor_assignments pa JOIN halls h ON h.id = pa.hall_id JOIN users u ON u.id = pa.proctor_id
    WHERE pa.exam_id = $1 ORDER BY h.name, u.name`, [examId])).rows;
}

async function isProctorAssigned(examId, proctorId) {
  return (await query('SELECT 1 FROM proctor_assignments WHERE exam_id = $1 AND proctor_id = $2', [examId, proctorId])).rowCount > 0;
}

async function getRoster(examId, search) {
  const params = [examId];
  let filter = '';
  if (search) { params.push(`%${search}%`); filter = 'AND (u.student_code ILIKE $2 OR u.name ILIKE $2)'; }
  return (await query(`
    SELECT u.id AS student_id, u.student_code, u.name, en.created_at AS enrolled_at
    FROM enrollments en JOIN users u ON u.id = en.student_id
    WHERE en.exam_id = $1 ${filter} ORDER BY u.student_code`, params)).rows;
}

async function existingHallIds(ids) {
  return (await query('SELECT id FROM halls WHERE id = ANY($1::int[])', [ids])).rows.map((r) => r.id);
}

// Halls with usable seats, and whether each is free for the given slot.
async function hallOptions({ date, start, duration, excludeExamId = 0 }) {
  const { rows } = await query(`
    SELECT h.id, h.name, h.building, h.rows, h.cols,
           (SELECT count(*)::int FROM seats s WHERE s.hall_id = h.id AND s.status = 'available') AS usable_seats,
           (SELECT string_agg(e.course_code || ' ' || to_char(e.start_time, 'HH24:MI'), ', ')
              FROM exam_halls eh JOIN exams e ON e.id = eh.exam_id
              WHERE eh.hall_id = h.id AND e.id <> $4 AND $1::date IS NOT NULL
                AND (e.exam_date + e.start_time) < ($1::date + $2::time + make_interval(mins => $3::int + 15))
                AND ($1::date + $2::time) < (e.exam_date + e.start_time + make_interval(mins => e.duration_min + 15))) AS booked_by
    FROM halls h ORDER BY h.name`, [date || null, start || '00:00', duration || 0, excludeExamId]);
  return rows.map((r) => ({ ...r, available: !r.booked_by }));
}

async function listImports(examId) {
  return (await query(`
    SELECT ri.id, ri.source, ri.s3_key, ri.accepted, ri.rejected, ri.created_at, u.name AS imported_by
    FROM roster_imports ri LEFT JOIN users u ON u.id = ri.imported_by
    WHERE ri.exam_id = $1 ORDER BY ri.created_at DESC LIMIT 20`, [examId])).rows;
}

module.exports = { listExams, getExam, getProctors, isProctorAssigned, getRoster, existingHallIds, hallOptions, listImports };
