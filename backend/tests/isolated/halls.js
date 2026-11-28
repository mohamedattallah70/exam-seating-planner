// Hall & Seat Layout service — ISOLATED tests (owner: Mohamed Rishi).
// Runs the real halls service code (routes, validation, shared auth/errors)
// and the real allocation worker (reconcile.js) against a DISPOSABLE
// in-memory Postgres (PGlite) loaded with backend/db/schema.sql.
// SNS, S3, audit and Secrets Manager are replaced by in-memory recorders, so
// nothing touches Neon or Floci. The Floci run is tests/halls.api.test.js.
//   cd backend && npm run test:halls:isolated
// Writes docs/tests/halls-isolated-results.md.
const path = require('path');
const express = require('express');
const { JSDOM } = require('jsdom');
const H = require('./harness'); // installs the fakes first

const { backend, repo, q, events, audits, s3Objects, origLog, code, expectStatus } = H;
const fs = require('fs');
const halls = require(path.join(backend, 'services/halls/index.js'));
const { requireAuth, signToken } = require(path.join(backend, 'shared/auth'));
const worker = require(path.join(backend, 'services/allocation/worker.js'));

const { results, test } = H.makeTester();
let API;
const call = H.makeClient(() => API);
const deliver = (e) => worker.handle({ MessageId: e.id, Body: JSON.stringify({ Type: 'Notification', Message: JSON.stringify(e) }) });

(async () => {
  await H.loadSchema();
  const mkUser = async (name, email, role, studentCode = null) => (await q(
    'INSERT INTO users (name, email, role, student_code, password_hash) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, role, student_code',
    [name, email, role, studentCode, 'not-a-real-hash']))[0];
  const uAdmin = await mkUser('Admin User', 'admin@local.test', 'admin');
  const uProctor = await mkUser('Proctor User', 'proctor@local.test', 'proctor');
  const students = [];
  for (let i = 1; i <= 6; i += 1) students.push(await mkUser(`Student ${i}`, `s${i}@local.test`, 'student', `S900${i}`));
  const tok = { admin: await signToken(uAdmin, 'jti-a'), proctor: await signToken(uProctor, 'jti-p'), student: await signToken(students[0], 'jti-s') };

  // Test gateway: /api/auth/me (for the frontend shell) + the halls service app.
  const gw = express();
  gw.get('/api/auth/me', requireAuth(), (req, res) => res.json({ id: req.user.id, name: req.user.name, role: req.user.role }));
  gw.use(halls.app);
  const server = await H.listen(gw);
  API = `http://127.0.0.1:${server.address().port}/api`;

  // ================= Milestone 1: CRUD + roles =================
  let h1;
  await test('HL-N1', 'Normal', 'Admin creates a 2x3 hall', '201, seats A1-A3, B1-B3', async () => {
    const r = await call('POST', '/halls', { token: tok.admin, body: { name: 'Disposable Hall 1', building: 'Test Block', rows: 2, cols: 3 } });
    h1 = r.data?.hall;
    const labels = h1?.seats.map((s) => s.label).join(',');
    return expectStatus(r, 201, labels === 'A1,A2,A3,B1,B2,B3' && h1.usable_seats === 6, labels);
  });
  await test('HL-N2', 'Normal', 'Reopen the saved grid (refresh)', '200, same 6 seat ids', async () => {
    const r = await call('GET', `/halls/${h1.id}`, { token: tok.admin });
    return expectStatus(r, 200, r.data.hall.seats.map((s) => s.id).join() === h1.seats.map((s) => s.id).join());
  });
  await test('HL-N3', 'Normal', 'Proctor reads the hall list and the grid', '200 and 200', async () => {
    const a = await call('GET', '/halls', { token: tok.proctor }); const b = await call('GET', `/halls/${h1.id}`, { token: tok.proctor });
    return { actual: `${a.status} / ${b.status}`, pass: a.status === 200 && b.status === 200 && a.data.halls.some((h) => h.id === h1.id) };
  });
  await test('HL-S1', 'Unauthenticated', 'List halls with no token', '401', async () => expectStatus(await call('GET', '/halls'), 401));
  await test('HL-S2', 'Unauthenticated', 'Tampered JWT (signature changed)', '401', async () => expectStatus(await call('GET', '/halls', { token: `${tok.admin.slice(0, -3)}abc` }), 401));
  await test('HL-S3', 'Unauthorized role', 'Student lists halls / creates a hall', '403 and 403', async () => {
    const a = await call('GET', '/halls', { token: tok.student });
    const b = await call('POST', '/halls', { token: tok.student, body: { name: 'Nope', building: 'X', rows: 1, cols: 1 } });
    return { actual: `${code(a)} / ${code(b)}`, pass: a.status === 403 && b.status === 403 };
  });
  await test('HL-S4', 'Unauthorized role', 'Proctor tries create, block, delete and impact preview', '403 x4', async () => {
    const seat = h1.seats[0].id;
    const rs = await Promise.all([
      call('POST', '/halls', { token: tok.proctor, body: { name: 'Nope2', building: 'X', rows: 1, cols: 1 } }),
      call('PATCH', `/halls/${h1.id}/seats/${seat}`, { token: tok.proctor, body: { status: 'blocked' } }),
      call('DELETE', `/halls/${h1.id}`, { token: tok.proctor }),
      call('GET', `/halls/${h1.id}/seats/${seat}/impact`, { token: tok.proctor })]);
    return { actual: rs.map((r) => r.status).join(','), pass: rs.every((r) => r.status === 403) };
  });
  await test('HL-I1', 'Invalid input', 'Rows 0, cols 41, rows 1.5, blank name, missing building', '400 x5 with field details', async () => {
    const base = { name: 'Bad Hall', building: 'B', rows: 2, cols: 2 };
    const bads = [{ rows: 0 }, { cols: 41 }, { rows: 1.5 }, { name: '  ' }, { building: undefined }];
    const rs = await Promise.all(bads.map((b) => call('POST', '/halls', { token: tok.admin, body: { ...base, ...b } })));
    return { actual: rs.map(code).join(','), pass: rs.every((r) => r.status === 400 && r.data.error.details?.length) };
  });
  await test('HL-I2', 'Invalid input', 'Unknown field in body (strict schema)', '400', async () => expectStatus(await call('POST', '/halls', { token: tok.admin, body: { name: 'X Hall', building: 'B', rows: 1, cols: 1, isAdmin: true } }), 400));
  await test('HL-I3', 'Business rule', 'Duplicate hall name', '409 HALL_NAME_TAKEN', async () => {
    const r = await call('POST', '/halls', { token: tok.admin, body: { name: 'Disposable Hall 1', building: 'Other', rows: 1, cols: 1 } });
    return expectStatus(r, 409, r.data.error.code === 'HALL_NAME_TAKEN');
  });
  await test('HL-I4', 'Invalid input', 'Non-numeric hall id / missing hall', '400 and 404', async () => {
    const a = await call('GET', '/halls/abc', { token: tok.admin }); const b = await call('GET', '/halls/999999', { token: tok.admin });
    return { actual: `${code(a)} / ${code(b)}`, pass: a.status === 400 && b.status === 404 };
  });
  await test('HL-S5', 'Injection', "Search name=' OR 1=1 --", '200 with 0 results (treated as text)', async () => {
    const r = await call('GET', `/halls?name=${encodeURIComponent("' OR 1=1 --")}`, { token: tok.admin });
    return expectStatus(r, 200, r.data.halls.length === 0, `${r.data.halls?.length} results`);
  });

  // ================= search, capacity, spacing =================
  const b2 = h1.seats.find((s) => s.label === 'B2');
  await test('HL-N4', 'Normal', 'Search by building + min capacity 6; spacing capacity of 2x3', 'found; spaced_seats=4', async () => {
    const r = await call('GET', '/halls?building=test%20block&minCapacity=6', { token: tok.admin });
    const h = r.data.halls.find((x) => x.id === h1.id);
    const sp = await call('GET', '/halls?minCapacity=5&spacing=true', { token: tok.admin });
    return expectStatus(r, 200, h && h.spaced_seats === 4 && !sp.data.halls.some((x) => x.id === h1.id), `usable=${h?.usable_seats} spaced=${h?.spaced_seats}; spacing>=5 excludes it`);
  });
  await test('HL-N5', 'Normal', 'Block B2 -> capacity 5, drops out of min-6 search; reopen -> 6', '200, 5, excluded, 200, 6', async () => {
    const a = await call('PATCH', `/halls/${h1.id}/seats/${b2.id}`, { token: tok.admin, body: { status: 'blocked', reason: 'Broken chair' } });
    const s1 = await call('GET', '/halls?minCapacity=6', { token: tok.admin });
    const b = await call('PATCH', `/halls/${h1.id}/seats/${b2.id}`, { token: tok.admin, body: { status: 'available' } });
    const excluded = !s1.data.halls.some((x) => x.id === h1.id);
    return { actual: `${a.status} usable=${a.data.hall.usable_seats} excluded=${excluded}; ${b.status} usable=${b.data.hall.usable_seats}`, pass: a.status === 200 && a.data.hall.usable_seats === 5 && excluded && b.status === 200 && b.data.hall.usable_seats === 6 };
  });
  await test('HL-N6', 'Normal', 'Blocking an unused seat publishes hall.seat_blocked {hallId, seatId}', 'one event with exact payload', async () => {
    const ev = events.filter((e) => e.type === 'hall.seat_blocked' && e.payload.seatId === b2.id);
    return { actual: `${ev.length} event(s) ${JSON.stringify(ev[0]?.payload)}`, pass: ev.length === 1 && Object.keys(ev[0].payload).join() === 'hallId,seatId' && ev[0].payload.hallId === h1.id && ev[0].source === 'halls' };
  });

  // ================= ownership =================
  const { data: { hall: h2 } } = await call('POST', '/halls', { token: tok.admin, body: { name: 'Disposable Hall 2', building: 'Test Block', rows: 1, cols: 2 } });
  await test('HL-O1', 'Ownership', 'Block a seat id that belongs to another hall', '404, other hall seat unchanged', async () => {
    const r = await call('PATCH', `/halls/${h1.id}/seats/${h2.seats[0].id}`, { token: tok.admin, body: { status: 'blocked' } });
    const imp = await call('GET', `/halls/${h1.id}/seats/${h2.seats[0].id}/impact`, { token: tok.admin });
    const st = (await q('SELECT status FROM seats WHERE id=$1', [h2.seats[0].id]))[0].status;
    return { actual: `${code(r)} / impact ${code(imp)}; seat ${st}`, pass: r.status === 404 && imp.status === 404 && st === 'available' };
  });

  // ================= resize (no plans) =================
  await test('HL-N7', 'Normal', 'Resize 2x3 -> 3x4 keeps seat ids and blocked status', '200, 12 seats, old ids kept, blocked kept', async () => {
    await call('PATCH', `/halls/${h1.id}/seats/${b2.id}`, { token: tok.admin, body: { status: 'blocked' } });
    const r = await call('PUT', `/halls/${h1.id}`, { token: tok.admin, body: { rows: 3, cols: 4 } });
    const seats = r.data.hall.seats;
    const keptIds = h1.seats.every((s) => seats.find((x) => x.id === s.id && x.label === s.label));
    const b2now = seats.find((s) => s.label === 'B2');
    return expectStatus(r, 200, seats.length === 12 && keptIds && b2now.status === 'blocked' && r.data.addedSeats === 6, `seats=${seats.length} added=${r.data.addedSeats} B2=${b2now?.status}`);
  });
  await test('HL-N8', 'Normal', 'Resize-impact preview for 3x4 -> 2x2', '200, removes 8, usable after 3', async () => {
    const r = await call('GET', `/halls/${h1.id}/resize-impact?rows=2&cols=2`, { token: tok.admin });
    return expectStatus(r, 200, r.data.removedSeats.length === 8 && r.data.capacityAfter.usableSeats === 3 && r.data.allowed, `removed=${r.data.removedSeats?.length} usableAfter=${r.data.capacityAfter?.usableSeats}`);
  });
  await test('HL-N9', 'Normal', 'Shrink back to 2x3 publishes hall.resized with removed seat ids', '200 + event payload {hallId, removedSeatIds[6]}', async () => {
    const before = events.length;
    const r = await call('PUT', `/halls/${h1.id}`, { token: tok.admin, body: { rows: 2, cols: 3 } });
    const ev = events.slice(before).find((e) => e.type === 'hall.resized');
    return expectStatus(r, 200, ev && ev.payload.hallId === h1.id && ev.payload.removedSeatIds.length === 6 && Object.keys(ev.payload).join() === 'hallId,removedSeatIds', `event ${JSON.stringify(ev?.payload)}`);
  });
  await test('HL-I5', 'Invalid input', 'Resize-impact with cols=0 / PUT with empty body', '400 and 400', async () => {
    const a = await call('GET', `/halls/${h1.id}/resize-impact?rows=2&cols=0`, { token: tok.admin });
    const b = await call('PUT', `/halls/${h1.id}`, { token: tok.admin, body: {} });
    return { actual: `${code(a)} / ${code(b)}`, pass: a.status === 400 && b.status === 400 };
  });

  // ================= S3 export =================
  await test('HL-N10', 'Normal', 'Export layout to S3 (CSV + JSON) matches saved grid incl. blocked B2', '201, 2 objects, 6 rows, B2 blocked', async () => {
    const r = await call('POST', `/halls/${h1.id}/export`, { token: tok.admin, body: {} });
    const csvKey = r.data.files.find((f) => f.format === 'csv').key;
    const jsonKey = r.data.files.find((f) => f.format === 'json').key;
    const csv = s3Objects.get(`esp-hall-layouts/${csvKey}`).Body.trim().split('\r\n');
    const json = JSON.parse(s3Objects.get(`esp-hall-layouts/${jsonKey}`).Body);
    const grid = (await call('GET', `/halls/${h1.id}`, { token: tok.admin })).data.hall.seats;
    const same = json.seats.map((s) => `${s.label}:${s.status}`).join() === grid.map((s) => `${s.label}:${s.status}`).join();
    const back = await call('GET', `/halls/${h1.id}/export?key=${encodeURIComponent(csvKey)}`, { token: tok.admin });
    return expectStatus(r, 201, csv.length === 7 && csv.some((l) => l.includes(',B2,blocked')) && same && back.status === 200,
      `bucket=${r.data.files[0].bucket} csvRows=${csv.length - 1} jsonMatchesGrid=${same} readBack=${back.status}`);
  });
  await test('HL-O2', 'Ownership', "Read another hall's export key through this hall", '403', async () => {
    const r2 = await call('POST', `/halls/${h2.id}/export`, { token: tok.admin, body: { formats: ['json'] } });
    return expectStatus(await call('GET', `/halls/${h1.id}/export?key=${encodeURIComponent(r2.data.files[0].key)}`, { token: tok.admin }), 403);
  });
  await test('HL-S6', 'Injection', 'CSV export neutralises a formula-looking block reason', "cell starts with '", async () => {
    const a1 = (await q("SELECT id FROM seats WHERE hall_id=$1 AND label='A1'", [h1.id]))[0].id;
    await call('PATCH', `/halls/${h1.id}/seats/${a1}`, { token: tok.admin, body: { status: 'blocked', reason: '=HYPERLINK("http://x")' } });
    const r = await call('POST', `/halls/${h1.id}/export`, { token: tok.admin, body: { formats: ['csv'] } });
    const line = s3Objects.get(`esp-hall-layouts/${r.data.files[0].key}`).Body.split('\r\n').find((l) => l.includes(',A1,'));
    await call('PATCH', `/halls/${h1.id}/seats/${a1}`, { token: tok.admin, body: { status: 'available' } });
    return { actual: line, pass: line.endsWith(`"'=HYPERLINK(""http://x"")"`) };
  });

  // ================= availability =================
  const mkExam = async (courseCode, date, start, dur, status = 'none') => (await q(
    `INSERT INTO exams (course_code, title, exam_date, start_time, duration_min, allocation_status) VALUES ($1,'Test exam',$2,$3,$4,$5) RETURNING id`,
    [courseCode, date, start, dur, status]))[0].id;
  const exBook = await mkExam('TST100', '2027-03-01', '09:00', 120);
  await q('INSERT INTO exam_halls VALUES ($1,$2)', [exBook, h2.id]);
  await test('HL-N11', 'Business rule', 'Available halls: overlap, adjacent (11:00 start, inside 15-min turnover), and 11:15', 'h2 busy, busy, free', async () => {
    const at = async (start, duration) => (await call('GET', `/halls/available?date=2027-03-01&start=${start}&duration=${duration}`, { token: tok.admin })).data;
    const over = await at('10:00', 60); const adj = await at('11:00', 60); const after = await at('11:15', 60); const before = await at('07:00', 105);
    const free = (d) => d.halls.some((h) => h.id === h2.id);
    return { actual: `10:00 ${free(over)}, 11:00 ${free(adj)}, 11:15 ${free(after)}, 07:00-08:45 ${free(before)}; booked=${over.booked.find((b) => b.id === h2.id)?.bookedBy}`,
      pass: !free(over) && !free(adj) && free(after) && free(before) && over.halls.some((h) => h.id === h1.id) };
  });
  await test('HL-I6', 'Invalid input', 'Available with bad date / 25:00 / duration 10', '400 x3', async () => {
    const rs = await Promise.all(['date=2027-13-45&start=09:00&duration=60', 'date=2027-03-01&start=25:00&duration=60', 'date=2027-03-01&start=09:00&duration=10']
      .map((qs) => call('GET', `/halls/available?${qs}`, { token: tok.admin })));
    return { actual: rs.map(code).join(','), pass: rs.every((r) => r.status === 400) };
  });
  await test('HL-N12', 'Normal', 'Route order: /halls/available is not treated as /halls/:id', '400 VALIDATION_ERROR on missing query (not 404 hall)', async () => {
    const r = await call('GET', '/halls/available', { token: tok.admin });
    return expectStatus(r, 400, r.data.error.details.some((d) => d.field.startsWith('query.')));
  });
  await test('HL-B1', 'Business rule', 'Delete a hall that an exam uses', '409 HALL_IN_USE, hall kept', async () => {
    const r = await call('DELETE', `/halls/${h2.id}`, { token: tok.admin });
    return expectStatus(r, 409, r.data.error.code === 'HALL_IN_USE' && (await q('SELECT 1 FROM halls WHERE id=$1', [h2.id])).length === 1);
  });

  // ================= plans: block + resize rules with the real worker =================
  // Hall P: 2x3. Published exam PUB uses P with students on A1, A2, A3, B1 (B2, B3 free).
  const { data: { hall: hp } } = await call('POST', '/halls', { token: tok.admin, body: { name: 'Disposable Plan Hall', building: 'Test Block', rows: 2, cols: 3 } });
  const seat = (lbl) => hp.seats.find((s) => s.label === lbl).id;
  const exPub = await mkExam('PUB200', '2027-04-01', '09:00', 60, 'published');
  const exDraft = await mkExam('DRF300', '2027-04-02', '09:00', 60, 'draft');
  for (const ex of [exPub, exDraft]) {
    await q('INSERT INTO exam_halls VALUES ($1,$2)', [ex, hp.id]);
    await q("INSERT INTO allocation_runs (exam_id, strategy, spacing, placed) VALUES ($1,'fill',false,4)", [ex]);
  }
  const place = async (ex, st, lbl) => {
    await q('INSERT INTO enrollments (exam_id, student_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [ex, st.id]);
    await q('INSERT INTO seat_assignments (exam_id, seat_id, student_id) VALUES ($1,$2,$3)', [ex, seat(lbl), st.id]);
  };
  await place(exPub, students[0], 'A1'); await place(exPub, students[1], 'A2'); await place(exPub, students[2], 'A3'); await place(exPub, students[3], 'B1');
  await place(exDraft, students[4], 'B3');
  const seatOf = async (ex, st) => (await q('SELECT s.label FROM seat_assignments a JOIN seats s ON s.id=a.seat_id WHERE a.exam_id=$1 AND a.student_id=$2', [ex, st.id]))[0]?.label;
  const statusOf = async (ex) => (await q('SELECT allocation_status FROM exams WHERE id=$1', [ex]))[0].allocation_status;

  await test('HL-B2', 'Business rule', 'Seat impact preview of A1 (published, 2 free seats)', '200, allowed, PUB200 student S9001 relocated', async () => {
    const r = await call('GET', `/halls/${hp.id}/seats/${seat('A1')}/impact`, { token: tok.admin });
    const e = r.data.affected?.[0];
    return expectStatus(r, 200, r.data.allowed && e.outcome === 'student_relocated' && e.students[0].studentCode === 'S9001' && e.freeSeats === 2, `${e?.courseCode} ${e?.outcome} free=${e?.freeSeats}`);
  });
  await test('HL-B3', 'Business rule', 'Block A1 (published): halls does NOT move the student; worker relocates once', 'PATCH 200 seat still assigned; after event S9001 on B2; replay = no change', async () => {
    const before = events.length;
    const r = await call('PATCH', `/halls/${hp.id}/seats/${seat('A1')}`, { token: tok.admin, body: { status: 'blocked' } });
    const stillA1 = await seatOf(exPub, students[0]);
    const ev = events.slice(before).filter((e) => e.type === 'hall.seat_blocked');
    await deliver(ev[0]);
    const after1 = await seatOf(exPub, students[0]);
    await deliver(ev[0]); // SQS redelivery of the same message
    const after2 = await seatOf(exPub, students[0]);
    const count = (await q('SELECT count(*)::int n FROM seat_assignments WHERE exam_id=$1', [exPub]))[0].n;
    return { actual: `${r.status}; before worker=${stillA1}; events=${ev.length}; after worker=${after1}; after replay=${after2}; assignments=${count}; status=${await statusOf(exPub)}`,
      pass: r.status === 200 && stillA1 === 'A1' && ev.length === 1 && after1 === 'B2' && after2 === 'B2' && count === 4 && (await statusOf(exPub)) === 'published' };
  });
  await test('HL-B4', 'Business rule', 'Pending relocations count: block A2 (PUB200 has 1 free seat, B3) then A3 before the worker runs', 'A2 200, A3 409 NO_RELOCATION_CAPACITY, A3 unchanged, no event', async () => {
    // free for PUB200 now: B3 only (draft exam's seat does not count for PUB200)
    const a2 = await call('PATCH', `/halls/${hp.id}/seats/${seat('A2')}`, { token: tok.admin, body: { status: 'blocked' } });
    const before = events.length;
    const a3 = await call('PATCH', `/halls/${hp.id}/seats/${seat('A3')}`, { token: tok.admin, body: { status: 'blocked' } });
    const st = (await q('SELECT status FROM seats WHERE id=$1', [seat('A3')]))[0].status;
    return { actual: `A2 ${code(a2)}; A3 ${code(a3)} details=${JSON.stringify(a3.data.error?.details)}; A3 ${st}; new events=${events.length - before}`,
      pass: a2.status === 200 && a3.status === 409 && a3.data.error.code === 'NO_RELOCATION_CAPACITY' && st === 'available' && events.length === before
        && audits.some((x) => x.action === 'SEAT_BLOCK_REFUSED') };
  });
  await test('HL-B5', 'Business rule', 'Worker processes A2 event: S9002 moves to B3; then A3 block still refused (no free seat)', 'S9002 on B3; 409', async () => {
    await deliver(events.filter((e) => e.type === 'hall.seat_blocked' && e.payload.seatId === seat('A2')).at(-1));
    const s2 = await seatOf(exPub, students[1]);
    const a3 = await call('PATCH', `/halls/${hp.id}/seats/${seat('A3')}`, { token: tok.admin, body: { status: 'blocked' } });
    return { actual: `S9002 on ${s2}; A3 ${code(a3)}`, pass: s2 === 'B3' && a3.status === 409 };
  });
  await test('HL-B6', 'Business rule', 'Retry of an already-blocked seat (A1)', '200 changed=false, no duplicate SEAT_BLOCKED audit', async () => {
    const n = audits.filter((x) => x.action === 'SEAT_BLOCKED').length;
    const r = await call('PATCH', `/halls/${hp.id}/seats/${seat('A1')}`, { token: tok.admin, body: { status: 'blocked' } });
    return expectStatus(r, 200, r.data.changed === false && audits.filter((x) => x.action === 'SEAT_BLOCKED').length === n, `changed=${r.data.changed}`);
  });
  await test('HL-B7', 'Business rule', 'Block B3, shared by a draft plan and a published plan with no free seat left', '409 NO_RELOCATION_CAPACITY (published rule wins)', async () => {
    // B3 holds S9002 of PUB200 (published) and S9005 of DRF300 (draft). PUB200 has no free seat -> refused.
    const r = await call('PATCH', `/halls/${hp.id}/seats/${seat('B3')}`, { token: tok.admin, body: { status: 'blocked' } });
    return expectStatus(r, 409, r.data.error.code === 'NO_RELOCATION_CAPACITY');
  });
  // Draft-only rule on a fresh hall
  const { data: { hall: hd } } = await call('POST', '/halls', { token: tok.admin, body: { name: 'Disposable Draft Hall', building: 'Test Block', rows: 1, cols: 2 } });
  const exDraft2 = await mkExam('DRF400', '2027-04-03', '09:00', 60, 'draft');
  await q('INSERT INTO exam_halls VALUES ($1,$2)', [exDraft2, hd.id]);
  await q('INSERT INTO enrollments VALUES ($1,$2)', [exDraft2, students[5].id]);
  await q('INSERT INTO seat_assignments (exam_id, seat_id, student_id) VALUES ($1,$2,$3)', [exDraft2, hd.seats[0].id, students[5].id]);
  await test('HL-B8', 'Business rule', 'Block a seat used by a draft plan only', '200; worker removes assignment, exam needs_reallocation', async () => {
    const before = events.length;
    const r = await call('PATCH', `/halls/${hd.id}/seats/${hd.seats[0].id}`, { token: tok.admin, body: { status: 'blocked' } });
    await deliver(events[before]);
    const left = (await q('SELECT count(*)::int n FROM seat_assignments WHERE exam_id=$1', [exDraft2]))[0].n;
    return expectStatus(r, 200, r.data.affected[0]?.outcome === 'draft_needs_reallocation' && left === 0 && (await statusOf(exDraft2)) === 'needs_reallocation', `assignments left=${left} status=${await statusOf(exDraft2)}`);
  });
  await test('HL-B9', 'Business rule', 'Resize-impact + shrink that removes a seat with a published assignment (2x3 -> 1x3)', 'preview allowed=false; PUT 409 HALL_IN_USE_PUBLISHED; grid unchanged', async () => {
    const im = await call('GET', `/halls/${hp.id}/resize-impact?rows=1&cols=3`, { token: tok.admin });
    const r = await call('PUT', `/halls/${hp.id}`, { token: tok.admin, body: { rows: 1, cols: 3 } });
    const n = (await q('SELECT count(*)::int n FROM seats WHERE hall_id=$1', [hp.id]))[0].n;
    return { actual: `preview allowed=${im.data.allowed} blockedBy=${im.data.blockedBy.map((x) => x.courseCode)}; PUT ${code(r)}; seats=${n}`,
      pass: im.data.allowed === false && r.status === 409 && r.data.error.code === 'HALL_IN_USE_PUBLISHED' && n === 6 && audits.some((x) => x.action === 'HALL_RESIZE_REFUSED') };
  });
  await test('HL-B10', 'Business rule', 'Grow a hall used by a published plan (2x3 -> 2x4) is allowed (no blanket lock)', '200, 8 seats, hall.resized with removedSeatIds []', async () => {
    const before = events.length;
    const r = await call('PUT', `/halls/${hp.id}`, { token: tok.admin, body: { rows: 2, cols: 4 } });
    const ev = events.slice(before).find((e) => e.type === 'hall.resized');
    await deliver(ev);
    return expectStatus(r, 200, r.data.hall.seats.length === 8 && ev.payload.removedSeatIds.length === 0 && (await statusOf(exPub)) === 'published', `seats=${r.data.hall.seats?.length}`);
  });
  await test('HL-B11', 'Business rule', 'Now A3 can be blocked (new free seats A4/B4)', '200; worker moves S9003 to a free seat', async () => {
    const before = events.length;
    const r = await call('PATCH', `/halls/${hp.id}/seats/${seat('A3')}`, { token: tok.admin, body: { status: 'blocked' } });
    await deliver(events[before]);
    const s3 = await seatOf(exPub, students[2]);
    return expectStatus(r, 200, ['A4', 'B4'].includes(s3), `S9003 now on ${s3}`);
  });
  await test('HL-N13', 'Normal', 'Delete an unused hall, then it is gone', '204 then 404, seats removed', async () => {
    const { data: { hall: hx } } = await call('POST', '/halls', { token: tok.admin, body: { name: 'Disposable Delete Me', building: 'Test Block', rows: 1, cols: 1 } });
    const d = await call('DELETE', `/halls/${hx.id}`, { token: tok.admin });
    const g = await call('GET', `/halls/${hx.id}`, { token: tok.admin });
    const d2 = await call('DELETE', `/halls/${hx.id}`, { token: tok.admin });
    const seatsLeft = (await q('SELECT count(*)::int n FROM seats WHERE hall_id=$1', [hx.id]))[0].n;
    return { actual: `${d.status} / GET ${g.status} / DELETE again ${d2.status}; seats=${seatsLeft}`, pass: d.status === 204 && g.status === 404 && d2.status === 404 && seatsLeft === 0 };
  });

  // ================= frontend (jsdom against the same API) =================
  const html = fs.readFileSync(path.join(repo, 'frontend/halls.html'), 'utf8');
  const scripts = ['config.js', 'api.js', 'layout.js', 'halls.js'].map((f) => fs.readFileSync(path.join(repo, 'frontend/js', f), 'utf8'));
  async function page(role, qs = '') {
    const dom = new JSDOM(html.replace(/<script[\s\S]*?<\/script>/g, ''), { url: `http://localhost/halls.html${qs}`, runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window;
    w.fetch = fetch; w.confirm = () => true; w.scrollTo = () => {};
    w.sessionStorage.setItem('esp_token', tok[role]);
    w.sessionStorage.setItem('esp_user', JSON.stringify({ role }));
    w.eval(scripts[0]); w.ESP_CONFIG.API_BASE = API;
    scripts.slice(1).forEach((s) => w.eval(s));
    const until = async (pred, ms = 4000) => { const t = Date.now(); while (!pred()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 25)); } };
    return { w, d: w.document, until };
  }
  await test('HL-F1', 'Frontend', 'Admin opens halls.html?id=<2x3 hall>: grid A1-B3, blocked B2 shown, admin controls visible', 'labels + blocked + controls', async () => {
    const { d, until } = await page('admin', `?id=${h1.id}`);
    await until(() => d.querySelectorAll('#seat-grid .seat').length === 6);
    const labels = [...d.querySelectorAll('#seat-grid .seat strong')].map((n) => n.textContent).join(',');
    const blocked = [...d.querySelectorAll('#seat-grid .seat.blocked strong')].map((n) => n.textContent).join(',');
    const ctrls = !d.querySelector('.admin-only').classList.contains('hidden') && !d.getElementById('new-btn').classList.contains('hidden');
    return { actual: `${labels}; blocked=${blocked}; controls=${ctrls}`, pass: labels === 'A1,A2,A3,B1,B2,B3' && blocked === 'B2' && ctrls };
  });
  await test('HL-F2', 'Frontend', 'Admin clicks A1 -> impact panel, then blocks it via the UI', 'panel shows "Block seat A1?", seat becomes blocked', async () => {
    const { d, until } = await page('admin', `?id=${h1.id}`);
    await until(() => d.querySelectorAll('#seat-grid button.seat').length === 6);
    [...d.querySelectorAll('#seat-grid button.seat')].find((b) => b.dataset.label === 'A1').click();
    await until(() => /Block seat A1\?/.test(d.getElementById('seat-panel').textContent));
    [...d.querySelectorAll('#seat-panel button')].find((b) => b.textContent === 'Block A1').click();
    await until(() => [...d.querySelectorAll('#seat-grid .seat.blocked strong')].some((n) => n.textContent === 'A1'));
    const st = (await q("SELECT status FROM seats WHERE hall_id=$1 AND label='A1'", [h1.id]))[0].status;
    await call('PATCH', `/halls/${h1.id}/seats/${(await q("SELECT id FROM seats WHERE hall_id=$1 AND label='A1'", [h1.id]))[0].id}`, { token: tok.admin, body: { status: 'available' } });
    return { actual: `DB A1=${st}`, pass: st === 'blocked' };
  });
  await test('HL-F3', 'Frontend', 'Proctor page is read-only (no create/edit/delete, seats not clickable)', 'no admin controls, 0 seat buttons', async () => {
    const { d, until } = await page('proctor', `?id=${h1.id}`);
    await until(() => d.querySelectorAll('#seat-grid .seat').length === 6);
    const hidden = d.querySelector('.admin-only').classList.contains('hidden') && d.getElementById('new-btn').classList.contains('hidden');
    return { actual: `adminHidden=${hidden} seatButtons=${d.querySelectorAll('#seat-grid button').length}`, pass: hidden && d.querySelectorAll('#seat-grid button').length === 0 };
  });
  await test('HL-F4', 'Frontend', 'XSS: hall named <img src=x onerror=...> renders as text', 'no <img> element created', async () => {
    const r = await call('POST', '/halls', { token: tok.admin, body: { name: '<img src=x onerror=alert(1)>', building: 'XSS', rows: 1, cols: 1 } });
    const { d, until } = await page('admin', `?id=${r.data.hall.id}`);
    await until(() => d.getElementById('hall-title').textContent.includes('<img'));
    return { actual: `title="${d.getElementById('hall-title').textContent}" imgs=${d.querySelectorAll('img').length}`, pass: d.querySelectorAll('img').length === 0 };
  });

  // ---------- report ----------
  server.close();
  const ok = H.writeReport('halls-isolated-results.md', 'Hall & Seat Layout service — isolated test results',
    'in-memory PGlite Postgres loaded with `backend/db/schema.sql`, the real halls service, the real allocation worker (`reconcile.js`) and jsdom for the page. SNS, S3, DynamoDB and audit were in-memory fakes. **Not** run on Neon or Floci (see `halls-api-results.md` for that).', results);
  process.exit(ok ? 0 : 1);
})().catch((e) => { origLog(e); process.exit(1); });
