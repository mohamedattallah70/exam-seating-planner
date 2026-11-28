// Auth hardening — ISOLATED tests (owner: Mohamed Rishi).
// Real auth service + real halls service (both mounted behind a tiny
// path-routing gateway like gateway/server.js) on a DISPOSABLE PGlite DB and
// an in-memory DynamoDB fake. Each scenario uses its own X-Forwarded-For
// address so the per-IP login limiter does not mix scenarios.
//   cd backend && npm run test:auth:isolated
// Writes docs/tests/auth-isolated-results.md. The Floci run is in test:halls.
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const bcrypt = require('bcryptjs');
const H = require('./harness'); // installs the fakes first

const { backend, q, dynamoItems, dynamoState, logs, audits, origLog, code, expectStatus } = H;
const auth = require(path.join(backend, 'services/auth/index.js'));
const halls = require(path.join(backend, 'services/halls/index.js'));
const revocation = require(path.join(backend, 'services/auth/revocation.js'));
const jwt = require('jsonwebtoken');

const { results, test } = H.makeTester();
let BASE;
const call = H.makeClient(() => BASE);
const from = (ip) => ({ headers: { 'X-Forwarded-For': ip } });
const login = (identifier, password, ip) => call('POST', '/auth/login', { body: { identifier, password }, ...from(ip) });

(async () => {
  await H.loadSchema();
  // Random per-run password, hashed at runtime: nothing secret is stored in the repo.
  const pw = crypto.randomBytes(12).toString('base64url');
  const hash = await bcrypt.hash(pw, 10);
  const mk = async (name, email, role, sc = null) => (await q(
    'INSERT INTO users (name, email, role, student_code, password_hash) VALUES ($1,$2,$3,$4,$5) RETURNING id', [name, email, role, sc, hash]))[0].id;
  const adminId = await mk('Admin User', 'admin@local.test', 'admin');
  const victimId = await mk('Lock Victim', 'victim@local.test', 'proctor');
  await mk('Student One', 's1@local.test', 'student', 'S1001');
  const userRow = async (id) => (await q('SELECT failed_logins, locked_until, last_login_at FROM users WHERE id=$1', [id]))[0];

  const gw = express();
  gw.use((req, res, next) => (req.path.startsWith('/api/auth') ? auth.app : halls.app)(req, res, next));
  const server = await H.listen(gw);
  BASE = `http://127.0.0.1:${server.address().port}/api`;

  // ---------- existing login behaviour kept ----------
  let adminTok;
  await test('AU-N1', 'Normal', 'Admin logs in by email; student logs in by student code', '200 + token / 200', async () => {
    const a = await login('admin@local.test', pw, '10.0.0.1');
    const s = await login('s1001', pw, '10.0.0.1');
    adminTok = a.data?.token;
    return { actual: `${code(a)} / ${code(s)} role=${s.data?.user?.role}`, pass: a.status === 200 && !!adminTok && s.status === 200 && s.data.user.role === 'student' };
  });
  await test('AU-I1', 'Invalid input', 'Login with missing password / 2-char identifier', '400 / 400', async () => {
    const a = await call('POST', '/auth/login', { body: { identifier: 'admin@local.test' }, ...from('10.0.0.2') });
    const b = await call('POST', '/auth/login', { body: { identifier: 'ab', password: 'x' }, ...from('10.0.0.2') });
    return { actual: `${code(a)} / ${code(b)}`, pass: a.status === 400 && b.status === 400 };
  });
  await test('AU-S1', 'Enumeration', 'Unknown account and wrong password give the same 401 message', 'identical 401 bodies', async () => {
    const a = await login('nobody@local.test', 'wrong-pass', '10.0.0.3');
    const b = await login('admin@local.test', 'wrong-pass', '10.0.0.3');
    return { actual: `${code(a)} / ${code(b)}`, pass: a.status === 401 && b.status === 401 && JSON.stringify(a.data) === JSON.stringify(b.data) };
  });
  await test('AU-N2', 'Normal', 'Successful login resets the failure counter', 'failed_logins 1 -> 0, last_login_at set', async () => {
    const before = (await userRow(adminId)).failed_logins;
    await login('admin@local.test', pw, '10.0.0.3');
    const after = await userRow(adminId);
    return { actual: `before=${before} after=${after.failed_logins} last_login_at=${!!after.last_login_at}`, pass: before === 1 && after.failed_logins === 0 && !!after.last_login_at };
  });

  // ---------- lockout ----------
  await test('AU-B1', 'Business rule', '4 wrong passwords -> 401 each, counter 4, not locked', '401 x4', async () => {
    const rs = [];
    for (let i = 0; i < 4; i += 1) rs.push((await login('victim@local.test', `wrong-${i}`, '10.0.1.1')).status);
    const u = await userRow(victimId);
    return { actual: `${rs.join(',')}; failed_logins=${u.failed_logins} locked_until=${u.locked_until}`, pass: rs.every((s) => s === 401) && u.failed_logins === 4 && !u.locked_until };
  });
  await test('AU-B2', 'Business rule', '5th wrong password locks the account for 15 minutes', '423 ACCOUNT_LOCKED, Retry-After ~900s', async () => {
    const r = await login('victim@local.test', 'wrong-5', '10.0.1.1');
    const u = await userRow(victimId);
    const mins = (new Date(u.locked_until) - Date.now()) / 60000;
    const ra = Number(r.headers.get('retry-after'));
    return { actual: `${code(r)}; Retry-After=${ra}; locked ~${mins.toFixed(1)} min`, pass: r.status === 423 && r.data.error.code === 'ACCOUNT_LOCKED' && ra > 880 && ra <= 900 && mins > 14.8 && mins <= 15 };
  });
  await test('AU-B3', 'Business rule', 'Correct password while locked is still refused', '423, no token', async () => {
    const r = await login('victim@local.test', pw, '10.0.1.2');
    return expectStatus(r, 423, !r.data.token);
  });
  await test('AU-B4', 'Business rule', 'After the lock expires: counter restarts at 1, then a correct login works', '401 (failed_logins=1) then 200 (0)', async () => {
    await q("UPDATE users SET locked_until = now() - interval '1 second' WHERE id=$1", [victimId]); // simulate 15 min passing
    const a = await login('victim@local.test', 'wrong-again', '10.0.1.3');
    const n1 = (await userRow(victimId)).failed_logins;
    const b = await login('victim@local.test', pw, '10.0.1.3');
    const u = await userRow(victimId);
    return { actual: `${code(a)} failed_logins=${n1}; ${code(b)} failed_logins=${u.failed_logins} locked_until=${u.locked_until}`, pass: a.status === 401 && n1 === 1 && b.status === 200 && u.failed_logins === 0 && !u.locked_until };
  });
  await test('AU-B5', 'Business rule', 'Concurrent wrong passwords cannot skip the lock (6 in parallel)', 'account locked; every response is 401 or 423, none 200', async () => {
    await q('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id=$1', [victimId]);
    const rs = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => login('victim@local.test', `par-${i}`, `10.0.2.${i}`)));
    const u = await userRow(victimId);
    return { actual: `${rs.map((r) => r.status).sort().join(',')}; failed_logins=${u.failed_logins} locked=${!!u.locked_until}`, pass: !!u.locked_until && rs.filter((r) => r.status === 423).length >= 1 && rs.every((r) => [401, 423].includes(r.status)) };
  });
  await test('AU-M1', 'Monitoring', 'Failures emit login_failed log lines (FailedLogins metric filter) and account_locked / ACCOUNT_LOCKED audit', 'logs + audit present, no password in logs', async () => {
    const failed = logs.filter((l) => l.event === 'login_failed').length;
    const locked = logs.filter((l) => l.event === 'account_locked').length;
    const leaked = logs.some((l) => JSON.stringify(l).includes(pw));
    return { actual: `login_failed=${failed} account_locked=${locked} ACCOUNT_LOCKED audits=${audits.filter((a) => a.action === 'ACCOUNT_LOCKED').length} passwordInLogs=${leaked}`, pass: failed >= 10 && locked >= 2 && !leaked };
  });

  // ---------- logout -> revoked token ----------
  await test('AU-R1', 'Normal', 'Logout stores the jti in EspRevokedTokens with expiresAt = token exp', '204, item with matching TTL', async () => {
    const claims = jwt.decode(adminTok);
    const r = await call('POST', '/auth/logout', { token: adminTok, ...from('10.0.3.1') });
    const item = dynamoItems.get(`EspRevokedTokens/${claims.jti}`);
    return expectStatus(r, 204, item && item.expiresAt === claims.exp && item.userId === adminId, `expiresAt=${item?.expiresAt} exp=${claims.exp}`);
  });
  await test('AU-R2', 'Security', 'Revoked token is rejected by /auth/me and by the Halls API (cache cleared, read from DynamoDB)', '401 TOKEN_REVOKED x2', async () => {
    revocation._cache.clear();
    const a = await call('GET', '/auth/me', { token: adminTok, ...from('10.0.3.1') });
    revocation._cache.clear();
    const b = await call('GET', '/halls', { token: adminTok, ...from('10.0.3.1') });
    return { actual: `${code(a)} / ${code(b)}`, pass: a.status === 401 && b.status === 401 && a.data.error.code === 'TOKEN_REVOKED' && b.data.error.code === 'TOKEN_REVOKED' };
  });
  await test('AU-R3', 'Security', 'A different (new) token of the same user still works', '200 on /halls', async () => {
    const t = (await login('admin@local.test', pw, '10.0.3.2')).data.token;
    return expectStatus(await call('GET', '/halls', { token: t, ...from('10.0.3.2') }), 200);
  });
  await test('AU-R4', 'Security', 'Revocation store down: protected request fails closed; logout reports 503', '401 / 503 REVOCATION_UNAVAILABLE', async () => {
    const t = (await login('admin@local.test', pw, '10.0.3.3')).data.token;
    dynamoState.failing = true;
    const a = await call('GET', '/halls', { token: t, ...from('10.0.3.3') });
    dynamoState.failing = false;
    // logout: lookup must succeed, the write fails
    const realSend = require(path.join(backend, 'shared/aws')).dynamo();
    const orig = realSend.send;
    realSend.send = async (cmd) => (cmd.constructor.name === 'PutCommand' ? Promise.reject(new Error('down')) : orig(cmd));
    const b = await call('POST', '/auth/logout', { token: t, ...from('10.0.3.3') });
    realSend.send = orig;
    return { actual: `${code(a)} / ${code(b)}`, pass: a.status === 401 && b.status === 503 && b.data.error.code === 'REVOCATION_UNAVAILABLE' };
  });
  await test('AU-S2', 'Security', 'Token signed with another secret / without jti', '401 / 401', async () => {
    const forged = jwt.sign({ sub: String(adminId), role: 'admin', jti: 'x' }, 'not-the-secret', { issuer: 'esp-auth', audience: 'esp-api', expiresIn: '1h' });
    const noJti = jwt.sign({ sub: String(adminId), role: 'admin' }, 'isolated-test-only-secret', { issuer: 'esp-auth', audience: 'esp-api', expiresIn: '1h' });
    const a = await call('GET', '/halls', { token: forged, ...from('10.0.3.4') });
    const b = await call('GET', '/halls', { token: noJti, ...from('10.0.3.4') });
    return { actual: `${code(a)} / ${code(b)}`, pass: a.status === 401 && b.status === 401 };
  });

  // ---------- login rate limit ----------
  await test('AU-L1', 'Security', '10 failed logins from one IP, then the 11th is rate limited', '401 x10 then 429 TOO_MANY_ATTEMPTS', async () => {
    const rs = [];
    for (let i = 0; i < 11; i += 1) rs.push(await login(`ghost${i}@local.test`, 'nope', '10.0.9.9'));
    const last = rs.at(-1);
    return { actual: `${rs.slice(0, 10).map((r) => r.status).join(',')} then ${code(last)}`, pass: rs.slice(0, 10).every((r) => r.status === 401) && last.status === 429 && last.data.error.code === 'TOO_MANY_ATTEMPTS' };
  });
  await test('AU-L2', 'Security', 'Limited IP is blocked even with the right password; another IP is not', '429 / 200', async () => {
    const a = await login('admin@local.test', pw, '10.0.9.9');
    const b = await login('admin@local.test', pw, '10.0.9.10');
    return { actual: `${code(a)} / ${code(b)}`, pass: a.status === 429 && b.status === 200 };
  });
  await test('AU-L3', 'Normal', '15 successful logins from one IP are not limited (shared lab IP)', '200 x15', async () => {
    const rs = [];
    for (let i = 0; i < 15; i += 1) rs.push((await login('admin@local.test', pw, '10.0.8.8')).status);
    return { actual: rs.join(','), pass: rs.every((s) => s === 200) };
  });

  server.close();
  const ok = H.writeReport('auth-isolated-results.md', 'Auth hardening — isolated test results',
    'real auth + halls services on in-memory PGlite (`backend/db/schema.sql`), DynamoDB/EventBridge/CloudWatch replaced by in-memory fakes. **Not** run on Neon or Floci; the revoked-token check through the real gateway is case HA-S5 in `halls-api-results.md`.', results);
  process.exit(ok ? 0 : 1);
})().catch((e) => { origLog(e); process.exit(1); });
