// "Changes must flow back" (Phase 1 feedback). The Hall and Exam services
// publish events (SNS -> SQS); the worker calls reconcile() for every exam the
// event touches. reconcile() is idempotent: running it twice changes nothing.
//
//   1. Remove assignments that are no longer valid: the seat was blocked, the
//      seat/hall is no longer part of the exam, or the student was un-enrolled.
//   2. PUBLISHED plan: students left without a seat are moved to the next free
//      seat (their old hall first, then the exam's other halls, same rules and
//      spacing as the last run). If someone still cannot be seated the plan
//      becomes needs_reallocation.
//      DRAFT plan: any change -> needs_reallocation (the admin re-runs it).
const { withTransaction } = require('../../shared/db');
const svc = require('./allocationService');
const engine = require('./engine');

async function reconcile(examId) {
  return withTransaction(async (client) => {
    await svc.lockExam(client, examId);
    let exam;
    try { exam = await svc.getExam(examId, client); } catch { return { examId, skipped: 'exam deleted' }; }
    if (exam.allocation_status === 'none') return { examId, status: 'none', changed: false };

    const removed = (await client.query(
      `DELETE FROM seat_assignments a USING seats s
        WHERE a.seat_id = s.id AND a.exam_id = $1
          AND (s.status = 'blocked'
               OR NOT EXISTS (SELECT 1 FROM exam_halls eh WHERE eh.exam_id = $1 AND eh.hall_id = s.hall_id)
               OR NOT EXISTS (SELECT 1 FROM enrollments e WHERE e.exam_id = $1 AND e.student_id = a.student_id))
      RETURNING a.student_id AS "studentId", s.hall_id AS "hallId", s.label AS "fromSeat"`, [examId])).rows;

    const unseated = (await client.query(
      `SELECT u.id, u.student_code AS "studentCode" FROM enrollments e JOIN users u ON u.id = e.student_id
        WHERE e.exam_id = $1 AND NOT EXISTS (SELECT 1 FROM seat_assignments a WHERE a.exam_id = $1 AND a.student_id = e.student_id)
        ORDER BY u.student_code`, [examId])).rows;

    const result = { examId, courseCode: exam.course_code, before: exam.allocation_status, removed: removed.length, relocated: [], seated: [], unplaced: [] };
    let status = exam.allocation_status;

    if (status === 'published' && unseated.length) {
      const run = await svc.lastRun(examId, client);
      const { halls, seats } = await svc.examHallsAndSeats(examId, client);
      const taken = new Set((await client.query('SELECT seat_id FROM seat_assignments WHERE exam_id = $1', [examId])).rows.map((r) => r.seat_id));
      const fromHall = new Map(removed.map((r) => [r.studentId, r]));
      for (const st of unseated) {
        const prev = fromHall.get(st.id);
        const seat = engine.nextFreeSeat({ halls, seats, takenSeatIds: taken, spacing: run?.spacing || false, preferHallId: prev?.hallId });
        if (!seat) { result.unplaced.push(st.studentCode); continue; }
        await client.query('INSERT INTO seat_assignments (exam_id, seat_id, student_id) VALUES ($1, $2, $3)', [examId, seat.id, st.id]);
        taken.add(seat.id);
        (prev ? result.relocated : result.seated).push({ studentCode: st.studentCode, from: prev?.fromSeat, toSeat: seat.label, hallId: seat.hallId });
      }
      if (result.unplaced.length) status = 'needs_reallocation';
    } else if (status === 'draft' && (removed.length || unseated.length)) {
      status = 'needs_reallocation';
    }

    if (status !== exam.allocation_status) await svc.setStatus(client, examId, status);
    result.status = status;
    result.changed = Boolean(removed.length || result.relocated.length || result.seated.length || status !== exam.allocation_status);
    return result;
  });
}

module.exports = { reconcile };
