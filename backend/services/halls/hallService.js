// Business rules for halls and seats (owner: Mohamed Rishi).
// Every change runs in ONE transaction; domain events are published only
// after the transaction commits (docs/CONTRACT.md section 6).
//
// Seat blocking does NOT move students itself. It only blocks the seat and
// publishes hall.seat_blocked; the allocation worker then removes draft
// assignments or relocates published ones (reconcile.js). This service
// checks beforehand that a published exam still has a free seat, so the
// worker's relocation can succeed.
const { withTransaction } = require('../../shared/db');
const { conflict, notFound } = require('../../shared/errors');
const store = require('./store');
const rules = require('./rules');

// Same advisory-lock key the allocation service uses per exam, so a block
// check never runs at the same time as a plan run/move/reconcile for that exam.
const lockExam = (client, examId) => client.query('SELECT pg_advisory_xact_lock(43, $1)', [examId]);

function nameTaken(err) {
  if (err.code === '23505') return conflict('HALL_NAME_TAKEN', 'A hall with this name already exists');
  return err;
}

async function createHall({ name, building, rows, cols }) {
  try {
    return await withTransaction(async (client) => {
      const { rows: [h] } = await client.query(
        'INSERT INTO halls (name, building, rows, cols) VALUES ($1, $2, $3, $4) RETURNING id', [name, building, rows, cols]);
      await client.query(
        `INSERT INTO seats (hall_id, row_no, col_no, label)
         SELECT $1, r, c, ${rules.SEAT_LABEL_SQL('r', 'c')}
         FROM generate_series(1, $2::int) AS r, generate_series(1, $3::int) AS c`, [h.id, rows, cols]);
      return store.getHall(h.id, client);
    });
  } catch (err) { throw nameTaken(err); }
}

// ---------- seat block / unblock ----------

// Who is affected if this seat is blocked, and would it be allowed?
async function seatImpact(hallId, seatId, db) {
  const seats = await store.getSeats(hallId, db);
  const seat = seats.find((s) => s.id === seatId);
  if (!seat) throw notFound('Seat in this hall');
  const assignments = await store.assignmentsOnSeats([seatId], db);
  const exams = new Map();
  for (const a of assignments) {
    if (!exams.has(a.examId)) {
      exams.set(a.examId, { examId: a.examId, courseCode: a.courseCode, title: a.title, examDate: a.examDate, startTime: a.startTime, planStatus: a.planStatus, students: [] });
    }
    exams.get(a.examId).students.push({ studentId: a.studentId, name: a.studentName, studentCode: a.studentCode });
  }
  const affected = [];
  for (const e of exams.values()) {
    if (e.planStatus === 'published') {
      const cap = await store.relocationCapacity(e.examId, seatId, db);
      e.freeSeats = cap.free_seats;
      e.studentsNeedingSeat = cap.needing_seat;
      e.outcome = cap.free_seats >= cap.needing_seat ? 'student_relocated' : 'refused_no_capacity';
    } else {
      e.outcome = 'draft_needs_reallocation';
    }
    affected.push(e);
  }
  return {
    hallId,
    seat: { id: seat.id, label: seat.label, status: seat.status },
    allowed: affected.every((e) => e.outcome !== 'refused_no_capacity'),
    affected,
  };
}

async function setSeatStatus(hallId, seatId, { status, reason }) {
  return withTransaction(async (client) => {
    // Lock the exams that currently use this seat first (sorted, so two
    // requests can't deadlock), then the seat row itself.
    const before = await store.assignmentsOnSeats([seatId], client);
    const examIds = [...new Set(before.map((a) => a.examId))].sort((a, b) => a - b);
    for (const id of examIds) await lockExam(client, id);

    const { rows: [seat] } = await client.query(
      'SELECT id, label, status FROM seats WHERE id = $1 AND hall_id = $2 FOR NO KEY UPDATE', [seatId, hallId]);
    if (!seat) throw notFound('Seat in this hall');

    let impact = null;
    // A retry of an already-blocked seat was checked the first time; skip the check.
    if (status === 'blocked' && seat.status !== 'blocked') {
      impact = await seatImpact(hallId, seatId, client);
      const refused = impact.affected.filter((e) => e.outcome === 'refused_no_capacity');
      if (refused.length) {
        throw conflict('NO_RELOCATION_CAPACITY',
          `Seat ${seat.label} is used in a published plan and there is no free seat to move the student to`,
          refused.map((e) => ({ examId: e.examId, courseCode: e.courseCode, freeSeats: e.freeSeats, studentsNeedingSeat: e.studentsNeedingSeat })));
      }
    }
    const changed = seat.status !== status;
    if (changed || status === 'blocked') {
      await client.query('UPDATE seats SET status = $1, block_reason = $2 WHERE id = $3',
        [status, status === 'blocked' ? (reason || null) : null, seatId]);
      await client.query('UPDATE halls SET updated_at = now() WHERE id = $1', [hallId]);
    }
    return {
      seat: { id: seat.id, label: seat.label, status },
      changed,
      // Re-publish on a retried block while students still sit there, so a
      // lost event can be recovered; the worker is idempotent.
      publish: status === 'blocked' && (changed || before.length > 0),
      affected: impact ? impact.affected : [],
      hall: await store.getHall(hallId, client),
    };
  });
}

// ---------- update / resize ----------

async function resizeImpact(hallId, rows, cols, db) {
  const hall = await store.getHall(hallId, db);
  if (!hall) throw notFound('Hall');
  const plan = rules.resizePlan(hall.seats, hall.rows, hall.cols, rows, cols);
  const assignments = await store.assignmentsOnSeats(plan.removed.map((s) => s.id), db);
  const published = assignments.filter((a) => a.planStatus === 'published');
  const drafts = assignments.filter((a) => a.planStatus !== 'published');
  const group = (list) => [...list.reduce((m, a) => {
    if (!m.has(a.examId)) m.set(a.examId, { examId: a.examId, courseCode: a.courseCode, title: a.title, examDate: a.examDate, startTime: a.startTime, planStatus: a.planStatus, students: [] });
    m.get(a.examId).students.push({ studentId: a.studentId, name: a.studentName, studentCode: a.studentCode, seatLabel: a.seatLabel });
    return m;
  }, new Map()).values()];
  return {
    hallId,
    from: { rows: hall.rows, cols: hall.cols },
    to: { rows, cols },
    removedSeats: plan.removed.map((s) => ({ id: s.id, label: s.label, status: s.status })),
    addedSeats: plan.added,
    capacityBefore: { totalSeats: hall.total_seats, usableSeats: hall.usable_seats, spacedSeats: hall.spaced_seats },
    capacityAfter: plan.capacityAfter,
    allowed: published.length === 0,
    blockedBy: group(published),
    draftsInvalidated: group(drafts),
  };
}

async function updateHall(hallId, changes) {
  try {
    return await withTransaction(async (client) => {
      const { rows: [old] } = await client.query('SELECT id, name, building, rows, cols FROM halls WHERE id = $1 FOR UPDATE', [hallId]);
      if (!old) throw notFound('Hall');
      const next = { name: changes.name ?? old.name, building: changes.building ?? old.building, rows: changes.rows ?? old.rows, cols: changes.cols ?? old.cols };
      let removedSeatIds = [];
      let added = 0;
      const resized = next.rows !== old.rows || next.cols !== old.cols;
      if (resized) {
        // Lock the seats that will disappear so no plan can grab them meanwhile.
        const { rows: removed } = await client.query(
          'SELECT id FROM seats WHERE hall_id = $1 AND (row_no > $2 OR col_no > $3) FOR UPDATE', [hallId, next.rows, next.cols]);
        removedSeatIds = removed.map((s) => s.id);
        const blocking = (await store.assignmentsOnSeats(removedSeatIds, client)).filter((a) => a.planStatus === 'published');
        if (blocking.length) {
          const examsList = [...new Set(blocking.map((a) => a.courseCode))].join(', ');
          throw conflict('HALL_IN_USE_PUBLISHED', `Removed seats hold published assignments (${examsList}). Shrink refused.`,
            blocking.map((a) => ({ examId: a.examId, courseCode: a.courseCode, seatLabel: a.seatLabel })));
        }
        // Draft assignments on removed seats go with the seats (FK cascade).
        if (removedSeatIds.length) await client.query('DELETE FROM seats WHERE id = ANY($1::int[])', [removedSeatIds]);
        const ins = await client.query(
          `INSERT INTO seats (hall_id, row_no, col_no, label)
           SELECT $1, r, c, ${rules.SEAT_LABEL_SQL('r', 'c')}
           FROM generate_series(1, $2::int) AS r, generate_series(1, $3::int) AS c
           WHERE r > $4 OR c > $5`, [hallId, next.rows, next.cols, old.rows, old.cols]);
        added = ins.rowCount;
      }
      await client.query('UPDATE halls SET name = $2, building = $3, rows = $4, cols = $5, updated_at = now() WHERE id = $1',
        [hallId, next.name, next.building, next.rows, next.cols]);
      return { hall: await store.getHall(hallId, client), resized, removedSeatIds, addedSeats: added, from: { rows: old.rows, cols: old.cols } };
    });
  } catch (err) { throw nameTaken(err); }
}

// ---------- delete ----------

async function deleteHall(hallId) {
  try {
    return await withTransaction(async (client) => {
      const { rows: [hall] } = await client.query('SELECT id, name FROM halls WHERE id = $1 FOR UPDATE', [hallId]);
      if (!hall) throw notFound('Hall');
      const exams = await store.examsUsingHall(hallId, client);
      if (exams.length) {
        throw conflict('HALL_IN_USE', `Hall is used by ${exams.length} exam(s) and cannot be deleted`,
          exams.map((e) => ({ examId: e.id, courseCode: e.course_code, examDate: e.exam_date })));
      }
      await client.query('DELETE FROM halls WHERE id = $1', [hallId]);
      return hall;
    });
  } catch (err) {
    // exam_halls is ON DELETE RESTRICT: an exam added between check and delete
    if (err.code === '23503') throw conflict('HALL_IN_USE', 'Hall is used by an exam and cannot be deleted');
    throw err;
  }
}

module.exports = { createHall, seatImpact, setSeatStatus, resizeImpact, updateHall, deleteHall };
