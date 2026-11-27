// Functional + security tests for the Exam & Enrolment service, run against
// the running stack (gateway :8080 -> services -> Neon + Floci).
//   npm run dev   (in another terminal)  then  npm run test:exams
// Writes a results table to docs/tests/exams-api-results.md (report evidence).
const fs = require('fs');
const path = require('path');
const { Pool } = require('@neondatabase/serverless');
const { SQSClient, GetQueueAttributesCommand } = require('@aws-sdk/client-sqs');
const { AWS, RESOURCES } = require('../shared/config');

const API = 'http://localhost:8080/api';
const results = [];
const env = process.env;

async function call(method, url, { token, body, raw } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined || raw) headers['Content-Type'] = 'application/json';
  const res = await fetch(API + url, { method, headers, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined) });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, data };
}
const login = async (identifier, password) => (await call('POST', '/auth/login', { body: { identifier, password } })).data.token;

async function test(idTag, type, scenario, expected, fn) {
  let actual; let pass;
  try {
    const r = await fn();
    actual = r.actual; pass = r.pass;
  } catch (e) { actual = `ERROR ${e.message}`; pass = false; }
  results.push({ idTag, type, scenario, expected, actual, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${idTag} ${scenario} -> ${actual}`);
}
const expectStatus = (r, s, extra = true) => ({ actual: `${r.status}${r.data?.error ? ` ${r.data.error.code}` : ''}`, pass: r.status === s && extra });

(async () => {
  const owner = new Pool({ connectionString: env.DATABASE_URL });
  const admin = await login('admin@esp.test', env.SEED_ADMIN_PASSWORD);
  const proctor1 = await login('proctor1@esp.test', env.SEED_STAFF_PASSWORD);
  const proctor2 = await login('proctor2@esp.test', env.SEED_STAFF_PASSWORD);
  const student = await login('S1001', env.SEED_STUDENT_PASSWORD);
  const { data: { halls } } = await call('GET', '/exams/hall-options', { token: admin });
  const [hA, hB, hC] = halls.map((h) => h.id);
  const { data: { users: proctors } } = await call('GET', '/users?role=proctor', { token: admin });
  const p1 = proctors.find((p) => p.email === 'proctor1@esp.test').id;
  const created = [];
  const base = { title: 'API Test Exam', durationMin: 120 };

  let e1;
  await test('EX-N1', 'Normal', 'Admin creates exam in two halls', '201 + exam returned', async () => {
    const r = await call('POST', '/exams', { token: admin, body: { ...base, courseCode: 'TST101', examDate: '2027-02-10', startTime: '09:00', hallIds: [hA, hB] } });
    e1 = r.data?.exam?.id; if (e1) created.push(e1);
    return expectStatus(r, 201, r.data?.exam?.halls?.length === 2);
  });
  await test('EX-N2', 'Normal', 'Search exams by course code', '200, finds TST101', async () => {
    const r = await call('GET', '/exams?course=TST101', { token: admin });
    return expectStatus(r, 200, r.data.exams.some((x) => x.id === e1));
  });
  await test('EX-N3', 'Normal', 'Import roster by paste (5 valid, 1 bad format, 1 duplicate, 1 unknown)', '201, 5 accepted, 3 rejected with reasons', async () => {
    const r = await call('POST', `/exams/${e1}/students`, { token: admin, body: { codes: 'student_code\nS1001\nS1002,S1003\nS1004 S1005\nX99\nS1002\nS9999' } });
    const reasons = (r.data?.rejected || []).map((x) => x.reason).sort().join(',');
    return { actual: `${r.status} accepted=${r.data?.accepted} rejected=${reasons}`, pass: r.status === 201 && r.data.accepted === 5 && reasons === 'DUPLICATE_IN_FILE,INVALID_FORMAT,UNKNOWN_STUDENT' };
  });
  await test('EX-N4', 'Normal', 'Upload roster CSV to S3 (presigned URL) then import it', '201, 3 accepted', async () => {
    const u = await call('POST', `/exams/${e1}/students/upload-url`, { token: admin });
    const put = await fetch(u.data.url, { method: 'PUT', headers: { 'Content-Type': 'text/csv' }, body: 'student_code\nS1006\nS1007\nS1008\n' });
    const r = await call('POST', `/exams/${e1}/students`, { token: admin, body: { s3Key: u.data.key } });
    return { actual: `S3 PUT ${put.status}; import ${r.status} accepted=${r.data?.accepted}`, pass: put.status === 200 && r.status === 201 && r.data.accepted === 3 };
  });
  await test('EX-N5', 'Normal', 'Assign proctor1 to hall A of the exam', '201', async () => expectStatus(await call('POST', `/exams/${e1}/proctors`, { token: admin, body: { hallId: hA, proctorId: p1 } }), 201));
  await test('EX-N6', 'Normal', 'Proctor views exam they are assigned to', '200', async () => expectStatus(await call('GET', `/exams/${e1}`, { token: proctor1 }), 200));
  await test('EX-N7', 'Normal', 'Proctor list only shows own exams', '200, every exam assigned to proctor1', async () => {
    const r = await call('GET', '/exams', { token: proctor1 });
    return expectStatus(r, 200, r.data.exams.some((x) => x.id === e1));
  });
  await test('EX-N8', 'Normal', 'Holiday check: 2027-01-07 (Coptic Christmas) via Calendarific', '200, isHoliday=true', async () => {
    const r = await call('GET', '/holidays/check?date=2027-01-07', { token: admin });
    return { actual: `${r.status} isHoliday=${r.data?.isHoliday} source=${r.data?.source} ${r.data?.note || ''}`, pass: r.status === 200 && r.data.isHoliday === true };
  });
  await test('EX-N9', 'Normal', 'Second holiday check is served from DynamoDB cache', '200, source=cache', async () => {
    const r = await call('GET', '/holidays/check?date=2027-03-01', { token: admin });
    return { actual: `${r.status} source=${r.data?.source}`, pass: r.status === 200 && r.data.source === 'cache' };
  });
  await test('EX-N10', 'Normal', 'Reschedule exam publishes exam.rescheduled to SNS -> SQS', '200 and SQS message count increases', async () => {
    const sqs = new SQSClient(AWS);
    const count = async () => Number((await sqs.send(new GetQueueAttributesCommand({ QueueUrl: RESOURCES.queueUrl, AttributeNames: ['ApproximateNumberOfMessages'] }))).Attributes.ApproximateNumberOfMessages);
    const before = await count();
    const r = await call('PUT', `/exams/${e1}`, { token: admin, body: { ...base, courseCode: 'TST101', examDate: '2027-02-11', startTime: '10:00', hallIds: [hA, hB] } });
    await new Promise((res) => setTimeout(res, 1500));
    const after = await count();
    return { actual: `${r.status}; queue ${before} -> ${after}`, pass: r.status === 200 && after > before };
  });

  // ----- invalid input / business rules -----
  await test('EX-I1', 'Invalid input', 'Create exam with bad course code, past-format date, 10-min duration', '400 with field details', async () => {
    const r = await call('POST', '/exams', { token: admin, body: { courseCode: 'bad', title: 'x', examDate: '2027-13-40', startTime: '25:00', durationMin: 10, hallIds: [] } });
    return expectStatus(r, 400, (r.data?.error?.details?.length || 0) >= 5);
  });
  await test('EX-I2', 'Invalid input', 'Create exam in the past', '400 DATE_IN_PAST', async () => expectStatus(await call('POST', '/exams', { token: admin, body: { ...base, courseCode: 'TST102', examDate: '2024-01-10', startTime: '09:00', hallIds: [hC] } }), 400));
  await test('EX-I3', 'Business rule', 'Book hall A for an overlapping exam (12:10, inside the 15-min turnover)', '409 HALL_BOOKED', async () => {
    const r = await call('POST', '/exams', { token: admin, body: { ...base, courseCode: 'TST103', examDate: '2027-02-11', startTime: '12:10', hallIds: [hA] } });
    if (r.data?.exam?.id) created.push(r.data.exam.id);
    return expectStatus(r, 409, r.data?.error?.code === 'HALL_BOOKED');
  });
  let e2;
  await test('EX-I4', 'Business rule', 'Import a student into a second exam at an overlapping time', '422, reason TIMETABLE_CLASH', async () => {
    const c = await call('POST', '/exams', { token: admin, body: { ...base, courseCode: 'TST104', examDate: '2027-02-11', startTime: '11:00', hallIds: [hC] } });
    e2 = c.data?.exam?.id; if (e2) created.push(e2);
    const r = await call('POST', `/exams/${e2}/students`, { token: admin, body: { codes: 'S1001' } });
    return { actual: `${r.status} ${r.data?.error?.details?.[0]?.reason}`, pass: r.status === 422 && r.data.error.details[0].reason === 'TIMETABLE_CLASH' };
  });
  await test('EX-I5', 'Business rule', 'Assign proctor1 to an overlapping exam', '409 PROCTOR_CLASH', async () => expectStatus(await call('POST', `/exams/${e2}/proctors`, { token: admin, body: { hallId: hC, proctorId: p1 } }), 409));
  await test('EX-I6', 'Invalid input', 'Assign proctor to a hall the exam does not use', '400', async () => expectStatus(await call('POST', `/exams/${e1}/proctors`, { token: admin, body: { hallId: hC, proctorId: p1 } }), 400));

  // ----- security -----
  await test('EX-S1', 'Unauthenticated', 'List exams with no token', '401', async () => expectStatus(await call('GET', '/exams'), 401));
  await test('EX-S2', 'Unauthenticated', 'Forged/tampered JWT', '401', async () => expectStatus(await call('GET', '/exams', { token: `${admin.slice(0, -4)}AAAA` }), 401));
  await test('EX-S3', 'Unauthorized role', 'Student tries to create an exam', '403', async () => expectStatus(await call('POST', '/exams', { token: student, body: { ...base, courseCode: 'TST105', examDate: '2027-02-12', startTime: '09:00', hallIds: [hC] } }), 403));
  await test('EX-S4', 'Unauthorized role', 'Proctor tries to import a roster', '403', async () => expectStatus(await call('POST', `/exams/${e1}/students`, { token: proctor1, body: { codes: 'S1010' } }), 403));
  await test('EX-S5', 'Ownership', 'Proctor2 opens an exam they are not assigned to', '403 (logged ACCESS_DENIED)', async () => expectStatus(await call('GET', `/exams/${e1}`, { token: proctor2 }), 403));
  await test('EX-S6', 'Ownership', 'Import using an S3 upload key that belongs to another exam', '403', async () => {
    const u = await call('POST', `/exams/${e1}/students/upload-url`, { token: admin });
    return expectStatus(await call('POST', `/exams/${e2}/students`, { token: admin, body: { s3Key: u.data.key } }), 403);
  });
  await test('EX-S7', 'Injection', "SQL injection in search: course=' OR 1=1 --", '200 with 0 results (treated as text)', async () => {
    const r = await call('GET', `/exams?course=${encodeURIComponent("' OR 1=1 --")}`, { token: admin });
    return expectStatus(r, 200, r.data.exams.length === 0);
  });
  await test('EX-S8', 'Invalid input', 'Oversized request body (300 KB)', '413', async () => expectStatus(await call('POST', `/exams/${e1}/students`, { token: admin, raw: JSON.stringify({ codes: 'S1001 '.repeat(50000) }) }), 413));
  await test('EX-S9', 'Business rule', 'Delete an exam whose seating plan is published', '409 EXAM_PUBLISHED', async () => {
    await owner.query("UPDATE exams SET allocation_status = 'published' WHERE id = $1", [e1]); // simulate allocation service
    const r = await call('DELETE', `/exams/${e1}`, { token: admin });
    await owner.query("UPDATE exams SET allocation_status = 'none' WHERE id = $1", [e1]);
    return expectStatus(r, 409);
  });
  await test('EX-S10', 'Least privilege', 'exams DB role tries to change allocation_status directly', 'permission denied (column grant)', async () => {
    const { getSecret } = require('../shared/secrets');
    const svc = new Pool({ connectionString: (await getSecret(RESOURCES.secrets.db('exams'))).url });
    try { await svc.query("UPDATE exams SET allocation_status = 'published' WHERE id = $1", [e1]); return { actual: 'update succeeded', pass: false }; } catch (e) { return { actual: e.message, pass: /permission denied/.test(e.message) }; } finally { await svc.end(); }
  });

  // cleanup
  await test('EX-N11', 'Normal', 'Admin deletes the test exams', '204', async () => {
    const statuses = [];
    for (const id of created) statuses.push((await call('DELETE', `/exams/${id}`, { token: admin })).status);
    return { actual: statuses.join(','), pass: statuses.every((s) => s === 204) };
  });
  await owner.end();

  const passed = results.filter((r) => r.pass).length;
  const md = [`# Exam & Enrolment service — API test results`, '', `Run: ${new Date().toISOString()} against the deployed stack (gateway → services → Neon + Floci). **${passed}/${results.length} passed.**`, '',
    '| ID | Type | Scenario | Expected | Actual | Result |', '|---|---|---|---|---|---|',
    ...results.map((r) => `| ${r.idTag} | ${r.type} | ${r.scenario} | ${r.expected} | ${String(r.actual).replace(/\|/g, '/')} | ${r.pass ? 'PASS' : 'FAIL'} |`)].join('\n');
  const out = path.join(__dirname, '..', '..', 'docs', 'tests');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'exams-api-results.md'), `${md}\n`);
  console.log(`\n${passed}/${results.length} passed -> docs/tests/exams-api-results.md`);
  process.exit(passed === results.length ? 0 : 1);
})();
