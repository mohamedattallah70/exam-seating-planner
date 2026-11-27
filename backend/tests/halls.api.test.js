// Functional + security + integration tests for the Hall & Seat Layout
// service (owner: Mohamed Rishi), run against the RUNNING STACK
// (gateway :8080 -> services -> Neon + Floci), like test:exams / test:alloc.
//   npm run dev   (in another terminal)  then  npm run test:halls
// Safe for a shared database: it only creates its own uniquely named halls
// and exams ("ZZ Rishi Test ...") and deletes only those. It never resets or
// seeds the database and never touches existing halls.
// Writes docs/tests/halls-api-results.md (report evidence).
const fs = require('fs');
const path = require('path');
const { Pool } = require('@neondatabase/serverless');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { SQSClient, GetQueueAttributesCommand, GetQueueUrlCommand } = require('@aws-sdk/client-sqs');
const { AWS, RESOURCES } = require('../shared/config');

const API = 'http://localhost:8080/api';
const results = [];
const env = process.env;
const RUN = `ZZ Rishi Test ${Date.now().toString(36)}`;

async function call(method, url, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(API + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = res.status === 204 ? '' : await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}
const login = async (identifier, password) => (await call('POST', '/auth/login', { body: { identifier, password } })).data?.token;

async function test(idTag, type, scenario, expected, fn) {
  let actual; let pass;
  try { ({ actual, pass } = await fn()); } catch (e) { actual = `ERROR ${e.message}`; pass = false; }
  results.push({ idTag, type, scenario, expected, actual, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${idTag} ${scenario} -> ${actual}`);
}
const code = (r) => `${r.status}${r.data?.error ? ` ${r.data.error.code}` : ''}`;
const expectStatus = (r, s, extra = true, note = '') => ({ actual: `${code(r)}${note ? `; ${note}` : ''}`, pass: r.status === s && extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 45000) {
  const t = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) return null; await sleep(1500); }
}

(async () => {
  const s3 = new S3Client({ ...AWS, forcePathStyle: true });
  const sqs = new SQSClient(AWS);
  const admin = await login('admin@esp.test', env.SEED_ADMIN_PASSWORD);
  const proctor = await login('proctor1@esp.test', env.SEED_STAFF_PASSWORD);
  const student = await login('S1001', env.SEED_STUDENT_PASSWORD);
  if (!admin || !proctor || !student) { console.error('Login failed: is `npm run dev` running and backend/.env present?'); process.exit(1); }
  const createdHalls = []; const createdExams = [];

  // ---------- Milestone 1 acceptance ----------
  let h;
  await test('HA-N1', 'Normal', 'Admin creates a disposable 2x3 hall through the gateway', '201, seats A1-A3, B1-B3', async () => {
    const r = await call('POST', '/halls', { token: admin, body: { name: `${RUN} A`, building: 'Rishi Test Block', rows: 2, cols: 3 } });
    h = r.data?.hall; if (h) createdHalls.push(h.id);
    return expectStatus(r, 201, h?.seats.map((s) => s.label).join(',') === 'A1,A2,A3,B1,B2,B3', h?.seats.map((s) => s.label).join(','));
  });
  await test('HA-N2', 'Normal', 'Reopen the hall (refresh) shows the same grid', '200, 6 seats', async () => {
    const r = await call('GET', `/halls/${h.id}`, { token: admin });
    return expectStatus(r, 200, r.data.hall.seats.length === 6);
  });
  await test('HA-N3', 'Normal', 'Proctor reads the hall', '200', async () => expectStatus(await call('GET', `/halls/${h.id}`, { token: proctor }), 200));
  await test('HA-S1', 'Unauthenticated', 'Anonymous request to /api/halls', '401', async () => expectStatus(await call('GET', '/halls'), 401));
  await test('HA-S2', 'Unauthorized role', 'Student lists halls', '403', async () => expectStatus(await call('GET', '/halls', { token: student }), 403));
  await test('HA-S3', 'Unauthorized role', 'Proctor tries to create / delete a hall', '403 / 403', async () => {
    const a = await call('POST', '/halls', { token: proctor, body: { name: `${RUN} X`, building: 'X', rows: 1, cols: 1 } });
    const b = await call('DELETE', `/halls/${h.id}`, { token: proctor });
    return { actual: `${code(a)} / ${code(b)}`, pass: a.status === 403 && b.status === 403 };
  });
  await test('HA-S4', 'Unauthenticated', 'Forged/tampered JWT', '401', async () => expectStatus(await call('GET', '/halls', { token: `${admin.slice(0, -3)}abc` }), 401));

  // ---------- all six routes + validation ----------
  await test('HA-I1', 'Invalid input', 'rows=0 / cols=41 / duplicate name', '400 / 400 / 409 HALL_NAME_TAKEN', async () => {
    const a = await call('POST', '/halls', { token: admin, body: { name: `${RUN} B`, building: 'X', rows: 0, cols: 2 } });
    const b = await call('POST', '/halls', { token: admin, body: { name: `${RUN} B`, building: 'X', rows: 2, cols: 41 } });
    const c = await call('POST', '/halls', { token: admin, body: { name: `${RUN} A`, building: 'X', rows: 1, cols: 1 } });
    return { actual: `${code(a)} / ${code(b)} / ${code(c)}`, pass: a.status === 400 && b.status === 400 && c.status === 409 && c.data.error.code === 'HALL_NAME_TAKEN' };
  });
  const b2 = () => h.seats.find((s) => s.label === 'B2');
  await test('HA-N4', 'Normal', 'Block B2 -> usable 5 and hall leaves a min-6 search; reopen -> 6', '200/excluded/200', async () => {
    const a = await call('PATCH', `/halls/${h.id}/seats/${b2().id}`, { token: admin, body: { status: 'blocked', reason: 'Test' } });
    const s = await call('GET', `/halls?building=${encodeURIComponent('Rishi Test Block')}&minCapacity=6`, { token: admin });
    const c = await call('PATCH', `/halls/${h.id}/seats/${b2().id}`, { token: admin, body: { status: 'available' } });
    const excluded = !s.data.halls.some((x) => x.id === h.id);
    return { actual: `${a.status} usable=${a.data.hall?.usable_seats} excluded=${excluded}; ${c.status} usable=${c.data.hall?.usable_seats}`, pass: a.status === 200 && a.data.hall.usable_seats === 5 && excluded && c.status === 200 && c.data.hall.usable_seats === 6 };
  });
  await test('HA-N5', 'Normal', 'Search with spacing=true uses odd columns (2x3 -> 4)', '200, spaced_seats=4', async () => {
    const r = await call('GET', `/halls?name=${encodeURIComponent(RUN)}&spacing=true`, { token: admin });
    return expectStatus(r, 200, r.data.halls.find((x) => x.id === h.id)?.spaced_seats === 4);
  });
  await test('HA-N6', 'Normal', 'Resize 2x3 -> 3x4 keeps seat ids', '200, 12 seats, original ids kept', async () => {
    const r = await call('PUT', `/halls/${h.id}`, { token: admin, body: { rows: 3, cols: 4 } });
    const kept = h.seats.every((s) => r.data.hall?.seats.some((x) => x.id === s.id));
    if (r.status === 200) h = r.data.hall;
    return expectStatus(r, 200, r.data.hall?.seats.length === 12 && kept);
  });
  await test('HA-O1', 'Ownership', 'Block a seat id from another hall via this hall', '404', async () => {
    const r2 = await call('POST', '/halls', { token: admin, body: { name: `${RUN} C`, building: 'Rishi Test Block', rows: 1, cols: 1 } });
    if (r2.data?.hall) createdHalls.push(r2.data.hall.id);
    return expectStatus(await call('PATCH', `/halls/${h.id}/seats/${r2.data.hall.seats[0].id}`, { token: admin, body: { status: 'blocked' } }), 404);
  });

  // ---------- S3 export (Floci) ----------
  await test('HA-N7', 'Normal', 'Export layout -> objects exist in S3 esp-hall-layouts and match the saved grid', '201; CSV rows = seats; JSON statuses match', async () => {
    await call('PATCH', `/halls/${h.id}/seats/${b2().id}`, { token: admin, body: { status: 'blocked', reason: 'Export check' } });
    const r = await call('POST', `/halls/${h.id}/export`, { token: admin, body: {} });
    const get = async (key) => (await s3.send(new GetObjectCommand({ Bucket: RESOURCES.buckets.layouts, Key: key }))).Body.transformToString();
    const csv = (await get(r.data.files.find((f) => f.format === 'csv').key)).trim().split(/\r?\n/);
    const json = JSON.parse(await get(r.data.files.find((f) => f.format === 'json').key));
    const grid = (await call('GET', `/halls/${h.id}`, { token: admin })).data.hall.seats;
    const same = json.seats.map((s) => `${s.label}:${s.status}`).join() === grid.map((s) => `${s.label}:${s.status}`).join();
    await call('PATCH', `/halls/${h.id}/seats/${b2().id}`, { token: admin, body: { status: 'available' } });
    return expectStatus(r, 201, csv.length - 1 === grid.length && same && csv.some((l) => l.includes(',B2,blocked')), `keys=${r.data.files.map((f) => f.key).join(' ')} csvRows=${csv.length - 1} match=${same}`);
  });

  // ---------- availability ----------
  const day = '2027-06-14';
  await test('HA-N8', 'Business rule', 'Availability: free before booking, busy for overlap and adjacent slot', 'free / busy / busy', async () => {
    const at = async (start, dur) => (await call('GET', `/halls/available?date=${day}&start=${start}&duration=${dur}`, { token: admin })).data.halls.some((x) => x.id === h.id);
    const before = await at('18:00', 60);
    const ex = await call('POST', '/exams', { token: admin, body: { courseCode: 'RIS101', title: `${RUN} exam`, examDate: day, startTime: '18:00', durationMin: 60, hallIds: [h.id] } });
    if (ex.data?.exam) createdExams.push(ex.data.exam.id);
    const overlap = await at('18:30', 60); const adjacent = await at('19:00', 30); const later = await at('19:15', 30);
    return { actual: `exam ${ex.status}; 18:00 free=${before}; 18:30 free=${overlap}; 19:00 free=${adjacent}; 19:15 free=${later}`, pass: ex.status === 201 && before && !overlap && !adjacent && later };
  });
  await test('HA-B1', 'Business rule', 'Delete a hall used by an exam', '409 HALL_IN_USE', async () => {
    const r = await call('DELETE', `/halls/${h.id}`, { token: admin });
    return expectStatus(r, 409, r.data.error.code === 'HALL_IN_USE');
  });

  // ---------- published plan + worker (SNS -> SQS -> allocation worker) ----------
  const examId = createdExams[0];
  let victim;
  await test('HA-B2', 'Integration', 'Roster S1001-S1004, run + publish allocation on the test hall', 'import 201, run 201, publish 200', async () => {
    const imp = await call('POST', `/exams/${examId}/students`, { token: admin, body: { codes: 'S1001\nS1002\nS1003\nS1004' } });
    const run = await call('POST', `/exams/${examId}/allocation`, { token: admin, body: { strategy: 'fill', spacing: false } });
    const pub = await call('POST', `/exams/${examId}/allocation/publish`, { token: admin });
    return { actual: `import ${code(imp)} accepted=${imp.data?.accepted}; run ${code(run)}; publish ${code(pub)}`, pass: imp.status === 201 && run.status === 201 && pub.status === 200 };
  });
  await test('HA-B3', 'Business rule', 'Seat impact preview names the seated student', '200, outcome student_relocated', async () => {
    const a = (await call('GET', `/exams/${examId}/allocation`, { token: admin })).data.assignments;
    victim = a.find((x) => x.seat === 'A1');
    const seatId = h.seats.find((s) => s.label === 'A1').id;
    const r = await call('GET', `/halls/${h.id}/seats/${seatId}/impact`, { token: admin });
    return expectStatus(r, 200, r.data.affected[0]?.outcome === 'student_relocated' && r.data.affected[0].students[0].studentCode === victim.studentCode, `${victim?.studentCode} on A1`);
  });
  await test('HA-B4', 'Integration', 'Block A1 -> hall.seat_blocked -> worker moves the student exactly once; plan stays published', '200; student moved off A1; 4 seated; DLQ empty', async () => {
    const seatId = h.seats.find((s) => s.label === 'A1').id;
    const r = await call('PATCH', `/halls/${h.id}/seats/${seatId}`, { token: admin, body: { status: 'blocked', reason: 'Integration test' } });
    const moved = await waitFor(async () => {
      const v = await call('GET', `/exams/${examId}/allocation?student=${victim.studentCode}`, { token: admin });
      const s = v.data.assignments[0]?.seat; return s && s !== 'A1' ? { seat: s, v } : null;
    });
    const all = (await call('GET', `/exams/${examId}/allocation`, { token: admin })).data;
    const dlqUrl = (await sqs.send(new GetQueueUrlCommand({ QueueName: RESOURCES.dlqName }))).QueueUrl;
    const dlq = Number((await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['ApproximateNumberOfMessages'] }))).Attributes.ApproximateNumberOfMessages);
    return { actual: `${code(r)}; ${victim.studentCode} now on ${moved?.seat}; seated=${all.summary.seated}; status=${all.exam.allocation_status}; dlq=${dlq}`,
      pass: r.status === 200 && moved && all.summary.seated === 4 && all.exam.allocation_status === 'published' && dlq === 0 };
  });
  await test('HA-B5', 'Business rule', 'Shrink that removes a seat holding a published assignment', 'preview allowed=false; PUT 409 HALL_IN_USE_PUBLISHED', async () => {
    const im = await call('GET', `/halls/${h.id}/resize-impact?rows=1&cols=1`, { token: admin });
    const r = await call('PUT', `/halls/${h.id}`, { token: admin, body: { rows: 1, cols: 1 } });
    return { actual: `preview allowed=${im.data.allowed}; PUT ${code(r)}`, pass: im.data.allowed === false && r.status === 409 && r.data.error.code === 'HALL_IN_USE_PUBLISHED' };
  });
  await test('HA-B6', 'Business rule', 'Block seats until no free seat is left -> NO_RELOCATION_CAPACITY', 'eventually 409 NO_RELOCATION_CAPACITY', async () => {
    // 12 seats, A1 blocked, 4 students seated -> 7 free. Block free seats first, then an occupied one.
    const a = (await call('GET', `/exams/${examId}/allocation`, { token: admin })).data.assignments.map((x) => x.seat);
    const free = h.seats.filter((s) => s.label !== 'A1' && !a.includes(s.label));
    for (const s of free) await call('PATCH', `/halls/${h.id}/seats/${s.id}`, { token: admin, body: { status: 'blocked' } });
    const occupied = h.seats.find((s) => s.label === a[0]);
    const r = await call('PATCH', `/halls/${h.id}/seats/${occupied.id}`, { token: admin, body: { status: 'blocked' } });
    return expectStatus(r, 409, r.data.error?.code === 'NO_RELOCATION_CAPACITY', `blocked ${free.length} free seats first`);
  });

  // ---------- cleanup: only our own rows ----------
  await test('HA-N9', 'Normal', 'Cleanup: remove test exams, then delete the test halls', 'exam 204, hall 204 each', async () => {
    const out = [];
    if (env.DATABASE_URL && createdExams.length) {
      // A published plan cannot be cleared through the API (by design), so the
      // test flips ONLY its own exams back to draft first, like test:exams does.
      const owner = new Pool({ connectionString: env.DATABASE_URL });
      await owner.query("UPDATE exams SET allocation_status = 'draft' WHERE id = ANY($1::int[]) AND title LIKE 'ZZ Rishi Test %'", [createdExams]);
      await owner.end();
    }
    for (const id of createdExams) {
      await call('DELETE', `/exams/${id}/allocation`, { token: admin });
      out.push(`exam ${(await call('DELETE', `/exams/${id}`, { token: admin })).status}`);
    }
    for (const id of createdHalls) out.push(`hall ${(await call('DELETE', `/halls/${id}`, { token: admin })).status}`);
    return { actual: out.join(', '), pass: out.every((x) => x.endsWith('204')) };
  });

  const passed = results.filter((r) => r.pass).length;
  const esc = (s) => String(s).replace(/\|/g, '/').replace(/\n/g, ' ');
  const md = ['# Hall & Seat Layout service — API test results (Floci)', '',
    `Run: ${new Date().toISOString()} against the running stack (gateway :8080 → services → Neon + Floci SNS/SQS/S3). **${passed}/${results.length} passed.**`, '',
    '| ID | Type | Scenario | Expected | Actual | Result |', '|---|---|---|---|---|---|',
    ...results.map((r) => `| ${r.idTag} | ${r.type} | ${esc(r.scenario)} | ${esc(r.expected)} | ${esc(r.actual)} | ${r.pass ? 'PASS' : 'FAIL'} |`)].join('\n');
  const out = path.join(__dirname, '..', '..', 'docs', 'tests');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'halls-api-results.md'), `${md}\n`);
  console.log(`\n${passed}/${results.length} passed -> docs/tests/halls-api-results.md`);
  process.exit(passed === results.length ? 0 : 1);
})();
