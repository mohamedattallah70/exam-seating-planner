// Functional, security and event-flow tests for the Seat Allocation & Lookup
// service, run against the running stack (gateway -> services -> Neon + Floci,
// SNS -> SQS -> allocation worker).
//   npm run dev   (in another terminal)  then  npm run test:alloc
// Writes docs/tests/allocation-api-results.md (report evidence).
const fs = require('fs');
const path = require('path');
const { Pool } = require('@neondatabase/serverless');
const { RESOURCES } = require('../shared/config');
const { publishEvent } = require('../shared/events');

const API = 'http://localhost:8080/api';
const results = [];
const env = process.env;

async function call(method, url, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(API + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, data };
}
const login = async (identifier, password) => (await call('POST', '/auth/login', { body: { identifier, password } })).data.token;
async function test(idTag, type, scenario, expected, fn) {
  let actual; let pass;
  try { ({ actual, pass } = await fn()); } catch (e) { actual = `ERROR ${e.message}`; pass = false; }
  results.push({ idTag, type, scenario, expected, actual, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${idTag} ${scenario} -> ${actual}`);
}
const expectStatus = (r, s, extra = true) => ({ actual: `${r.status}${r.data?.error ? ` ${r.data.error.code}` : ''}`, pass: r.status === s && extra });
// wait for the asynchronous worker (SQS long-poll) to apply an event
async function waitFor(fn, ms = 40000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await new Promise((r) => setTimeout(r, 1500)); }
}

(async () => {
  const owner = new Pool({ connectionString: env.DATABASE_URL });
  const admin = await login('admin@esp.test', env.SEED_ADMIN_PASSWORD);
  const proctor1 = await login('proctor1@esp.test', env.SEED_STAFF_PASSWORD);
  const proctor2 = await login('proctor2@esp.test', env.SEED_STAFF_PASSWORD);
  const student = await login('S1001', env.SEED_STUDENT_PASSWORD);
  const { data: { halls } } = await call('GET', '/exams/hall-options', { token: admin });
  const byName = (n) => halls.find((h) => h.name === n).id;
  const hA = byName('Main Hall A'); const hB = byName('Hall B'); const hC = byName('Lab C');
  const { data: { users: proctors } } = await call('GET', '/users?role=proctor', { token: admin });
  const p1 = proctors.find((p) => p.email === 'proctor1@esp.test').id;
  const codes = (from, n) => Array.from({ length: n }, (_, i) => `S${from + i}`).join(' ');
  const created = [];
  let blockedSeatId = null;
  const mkExam = async (courseCode, examDate, hallIds) => {
    const r = await call('POST', '/exams', { token: admin, body: { courseCode, title: 'Allocation Test', examDate, startTime: '09:00', durationMin: 120, hallIds } });
    created.push(r.data.exam.id); return r.data.exam.id;
  };
  const status = async (id) => (await owner.query('SELECT allocation_status FROM exams WHERE id = $1', [id])).rows[0].allocation_status;

  const e1 = await mkExam('ALC101', '2027-03-01', [hA, hB]);
  await call('POST', `/exams/${e1}/students`, { token: admin, body: { codes: codes(1001, 20) } });
  await call('POST', `/exams/${e1}/proctors`, { token: admin, body: { hallId: hA, proctorId: p1 } });

  // ----- security -----
  await test('AL-S1', 'Authentication', 'Run allocation without a token', '401', async () => expectStatus(await call('POST', `/exams/${e1}/allocation`, { body: {} }), 401));
  await test('AL-S2', 'Unauthorized role', 'Student tries to run an allocation', '403', async () => expectStatus(await call('POST', `/exams/${e1}/allocation`, { token: student, body: {} }), 403));
  await test('AL-S3', 'Invalid input', 'Unknown strategy / extra field in body', '400 VALIDATION_ERROR', async () => {
    const a = await call('POST', `/exams/${e1}/allocation`, { token: admin, body: { strategy: 'random' } });
    const b = await call('POST', `/exams/${e1}/allocation`, { token: admin, body: { strategy: 'fill', examId: 999 } });
    return expectStatus(a, 400, b.status === 400);
  });

  // ----- rules -----
  await test('AL-N1', 'Normal', 'Fill strategy: 20 students, largest hall first', '201, all 20 in Main Hall A, status draft', async () => {
    const r = await call('POST', `/exams/${e1}/allocation`, { token: admin, body: { strategy: 'fill' } });
    const a = r.data.halls.find((h) => h.hallId === hA);
    return expectStatus(r, 201, r.data.studentsSeated === 20 && a.seatsUsed === 20 && a.order === 1 && (await status(e1)) === 'draft');
  });
  await test('AL-N2', 'Normal', 'Row-by-row, left-to-right, student-code order, blocked seats skipped', 'S1001=A1, S1003=A4 (A3 blocked), S1011=B2', async () => {
    const { data } = await call('GET', `/exams/${e1}/allocation`, { token: admin });
    const seat = (c) => data.assignments.find((x) => x.studentCode === c).seat;
    return { actual: `S1001=${seat('S1001')} S1003=${seat('S1003')} S1011=${seat('S1011')}`, pass: seat('S1001') === 'A1' && seat('S1003') === 'A4' && seat('S1011') === 'B2' };
  });
  await test('AL-N3', 'Normal', 'Balance strategy splits by usable capacity (77:47)', '201, Hall A 12 / Hall B 8', async () => {
    const r = await call('POST', `/exams/${e1}/allocation`, { token: admin, body: { strategy: 'balance' } });
    const used = (id) => r.data.halls.find((h) => h.hallId === id).seatsUsed;
    return { actual: `${r.status} A=${used(hA)} B=${used(hB)}`, pass: r.status === 201 && used(hA) === 12 && used(hB) === 8 };
  });
  await test('AL-N4', 'Normal', 'Spacing option uses odd columns only', 'every seat column is odd', async () => {
    await call('POST', `/exams/${e1}/allocation`, { token: admin, body: { strategy: 'fill', spacing: true } });
    const { data } = await call('GET', `/exams/${e1}/allocation`, { token: admin });
    return { actual: `cols ${[...new Set(data.assignments.map((x) => x.colNo))].sort((a, b) => a - b).join(',')}`, pass: data.assignments.length === 20 && data.assignments.every((x) => x.colNo % 2 === 1) };
  });
  await call('POST', `/exams/${e1}/allocation`, { token: admin, body: { strategy: 'fill' } });
  await test('AL-N5', 'Normal', 'Search the plan by student code', '200, 1 match', async () => {
    const r = await call('GET', `/exams/${e1}/allocation?student=S1005`, { token: admin });
    return expectStatus(r, 200, r.data.assignments.length === 1);
  });
  let s20;
  await test('AL-N6', 'Normal', 'Move one student to a free seat', '200, S1020 now in H1', async () => {
    const { data } = await call('GET', `/exams/${e1}/allocation?student=S1020`, { token: admin });
    s20 = data.assignments[0];
    const r = await call('PATCH', `/allocations/${s20.assignmentId}`, { token: admin, body: { hallId: hA, seatLabel: 'H1' } });
    return expectStatus(r, 200, r.data.seat === 'H1');
  });
  await test('AL-S4', 'Business rule', 'Move a student onto a blocked seat / a taken seat', '409 SEAT_BLOCKED, 409 SEAT_TAKEN', async () => {
    const a = await call('PATCH', `/allocations/${s20.assignmentId}`, { token: admin, body: { hallId: hA, seatLabel: 'D5' } });
    const b = await call('PATCH', `/allocations/${s20.assignmentId}`, { token: admin, body: { hallId: hA, seatLabel: 'A1' } });
    return { actual: `${a.status} ${a.data?.error?.code}, ${b.status} ${b.data?.error?.code}`, pass: a.data?.error?.code === 'SEAT_BLOCKED' && b.data?.error?.code === 'SEAT_TAKEN' };
  });
  await test('AL-S5', 'Ownership', 'Assigned proctor opens the seat map before it is published', '409 NOT_PUBLISHED', async () => expectStatus(await call('GET', `/exams/${e1}/halls/${hA}/seat-map`, { token: proctor1 }), 409));
  await test('AL-N7', 'Normal', 'Publish: every student seated, seat maps exported to S3', '200 + CSV per used hall in esp-seatmap-exports', async () => {
    const r = await call('POST', `/exams/${e1}/allocation/publish`, { token: admin });
    return expectStatus(r, 200, r.data.exports?.length === 1 && r.data.exports[0] === `exam-${e1}/hall-${hA}.csv`);
  });
  await test('AL-S6', 'Business rule', 'Re-run a published plan', '409 ALREADY_PUBLISHED', async () => expectStatus(await call('POST', `/exams/${e1}/allocation`, { token: admin, body: {} }), 409));
  await test('AL-N8', 'Normal', 'Student sees only their own seat (id from JWT, query ignored)', '200, 1 seat = A1', async () => {
    const r = await call('GET', '/me/seats?studentId=1&student_id=2', { token: student });
    const mine = r.data.seats.filter((s) => s.course_code === 'ALC101');
    return expectStatus(r, 200, mine.length === 1 && mine[0].seat === 'A1');
  });
  await test('AL-N9', 'Normal', 'Assigned proctor opens published seat map of their hall', '200, 20 students shown', async () => {
    const r = await call('GET', `/exams/${e1}/halls/${hA}/seat-map`, { token: proctor1 });
    return expectStatus(r, 200, r.data.seatsUsed === 20);
  });
  await test('AL-S7', 'Ownership', 'Proctor2 opens a seat map of a hall they do not supervise', '403 NOT_YOUR_HALL (logged ACCESS_DENIED)', async () => expectStatus(await call('GET', `/exams/${e1}/halls/${hA}/seat-map`, { token: proctor2 }), 403));

  // ----- changes flow back (SNS -> SQS -> worker) -----
  await test('AL-I1', 'Integration', 'Hall service blocks a seat used by S1001 (hall.seat_blocked event)', 'worker moves S1001 to next free seat in the same hall; plan stays published', async () => {
    blockedSeatId = (await owner.query('SELECT seat_id FROM seat_assignments a JOIN users u ON u.id = a.student_id WHERE a.exam_id = $1 AND u.student_code = $2', [e1, 'S1001'])).rows[0].seat_id;
    await owner.query("UPDATE seats SET status = 'blocked', block_reason = 'test' WHERE id = $1", [blockedSeatId]);
    await publishEvent('hall.seat_blocked', { hallId: hA, seatId: blockedSeatId }, 'halls');
    const moved = await waitFor(async () => (await owner.query(
      `SELECT s.label, s.hall_id FROM seat_assignments a JOIN users u ON u.id = a.student_id JOIN seats s ON s.id = a.seat_id
        WHERE a.exam_id = $1 AND u.student_code = 'S1001' AND a.seat_id <> $2`, [e1, blockedSeatId])).rows[0]);
    return { actual: moved ? `S1001 -> ${moved.label}, ${await status(e1)}` : 'not moved', pass: !!moved && moved.hall_id === hA && (await status(e1)) === 'published' };
  });
  await test('AL-I2', 'Integration', 'Student added to a published plan (exam.roster_changed event)', 'worker seats S1021 automatically', async () => {
    await call('POST', `/exams/${e1}/students`, { token: admin, body: { codes: 'S1021' } });
    const seat = await waitFor(async () => (await owner.query(`SELECT 1 FROM seat_assignments a JOIN users u ON u.id = a.student_id WHERE a.exam_id = $1 AND u.student_code = 'S1021'`, [e1])).rowCount);
    return { actual: seat ? `seated, ${await status(e1)}` : 'not seated', pass: !!seat && (await status(e1)) === 'published' };
  });
  await test('AL-I3', 'Integration', 'Exam moved from Main Hall A to Hall B (exam.halls_changed event)', 'worker relocates all 21 students into Hall B', async () => {
    await call('PUT', `/exams/${e1}`, { token: admin, body: { courseCode: 'ALC101', title: 'Allocation Test', examDate: '2027-03-01', startTime: '09:00', durationMin: 120, hallIds: [hB] } });
    const done = await waitFor(async () => (await owner.query('SELECT count(*)::int AS n FROM seat_assignments a JOIN seats s ON s.id = a.seat_id WHERE a.exam_id = $1 AND s.hall_id = $2', [e1, hB])).rows[0].n === 21);
    return { actual: done ? `21 in Hall B, ${await status(e1)}` : 'not relocated', pass: !!done && (await status(e1)) === 'published' };
  });
  const e2 = await mkExam('ALC102', '2027-03-02', [hC]);
  await call('POST', `/exams/${e2}/students`, { token: admin, body: { codes: codes(1001, 10) } });
  await call('POST', `/exams/${e2}/allocation`, { token: admin, body: {} });
  await test('AL-I4', 'Integration', 'Roster changes on a DRAFT plan (exam.roster_changed)', 'worker marks it needs_reallocation; publish refused', async () => {
    await call('POST', `/exams/${e2}/students`, { token: admin, body: { codes: 'S1011' } });
    const s = await waitFor(async () => (await status(e2)) === 'needs_reallocation');
    const p = await call('POST', `/exams/${e2}/allocation/publish`, { token: admin });
    return { actual: `${s ? 'needs_reallocation' : await status(e2)}, publish ${p.status} ${p.data?.error?.code}`, pass: !!s && p.status === 409 };
  });
  await test('AL-N10', 'Normal', 'Re-run after needs_reallocation', '201, 11 seated, draft', async () => {
    const r = await call('POST', `/exams/${e2}/allocation`, { token: admin, body: {} });
    return expectStatus(r, 201, r.data.studentsSeated === 11 && (await status(e2)) === 'draft');
  });
  await test('AL-S8', 'Business rule', 'Not enough seats: 31 students in a 30-seat hall', '409 NOT_ENOUGH_SEATS {needed, available}', async () => {
    await call('POST', `/exams/${e2}/students`, { token: admin, body: { codes: codes(1012, 20) } });
    const r = await call('POST', `/exams/${e2}/allocation`, { token: admin, body: {} });
    return expectStatus(r, 409, r.data.error.details?.needed === 31 && r.data.error.details?.available === 30);
  });
  await test('AL-S9', 'Concurrency', 'Two admins run the allocation at the same time', 'both succeed in turn (advisory lock), no duplicate seats', async () => {
    await call('DELETE', `/exams/${e2}/students/${(await owner.query("SELECT id FROM users WHERE student_code='S1031'")).rows[0].id}`, { token: admin });
    const [a, b] = await Promise.all([1, 2].map(() => call('POST', `/exams/${e2}/allocation`, { token: admin, body: {} })));
    const n = (await owner.query('SELECT count(*)::int AS n, count(DISTINCT seat_id)::int AS d FROM seat_assignments WHERE exam_id = $1', [e2])).rows[0];
    return { actual: `${a.status}/${b.status}, ${n.n} rows, ${n.d} distinct seats`, pass: a.status === 201 && b.status === 201 && n.n === 30 && n.d === 30 };
  });
  await test('AL-S10', 'Least privilege', 'allocation DB role tries to rename an exam', 'permission denied (column grant)', async () => {
    const { getSecret } = require('../shared/secrets');
    const svc = new Pool({ connectionString: (await getSecret(RESOURCES.secrets.db('allocation'))).url });
    try { await svc.query("UPDATE exams SET title = 'hacked' WHERE id = $1", [e1]); return { actual: 'update succeeded', pass: false }; } catch (e) { return { actual: e.message, pass: /permission denied/.test(e.message) }; } finally { await svc.end(); }
  });
  await test('AL-N11', 'Normal', 'Admin overview lists both test exams with counts', '200', async () => {
    const r = await call('GET', '/allocations/overview', { token: admin });
    return expectStatus(r, 200, r.data.exams.filter((x) => created.includes(x.id)).length === 2);
  });

  // cleanup (owner connection: published plans cannot be deleted through the API by design)
  if (blockedSeatId) await owner.query("UPDATE seats SET status = 'available', block_reason = NULL WHERE id = $1", [blockedSeatId]);
  for (const id of created) {
    await owner.query("UPDATE exams SET allocation_status = 'none' WHERE id = $1", [id]);
    await call('DELETE', `/exams/${id}`, { token: admin });
  }
  await owner.end();

  const passed = results.filter((r) => r.pass).length;
  const md = ['# Seat Allocation & Lookup service — API test results', '', `Run: ${new Date().toISOString()} against the deployed stack (gateway → services → Neon + Floci, SNS → SQS → worker). **${passed}/${results.length} passed.**`, '',
    '| ID | Type | Scenario | Expected | Actual | Result |', '|---|---|---|---|---|---|',
    ...results.map((r) => `| ${r.idTag} | ${r.type} | ${r.scenario} | ${r.expected} | ${String(r.actual).replace(/\|/g, '/')} | ${r.pass ? 'PASS' : 'FAIL'} |`)].join('\n');
  const out = path.join(__dirname, '..', '..', 'docs', 'tests');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'allocation-api-results.md'), `${md}\n`);
  console.log(`\n${passed}/${results.length} passed -> docs/tests/allocation-api-results.md`);
  process.exit(passed === results.length ? 0 : 1);
})();
