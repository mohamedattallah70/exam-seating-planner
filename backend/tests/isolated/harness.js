// Shared harness for ISOLATED tests (owner: Mohamed Rishi).
// A DISPOSABLE in-memory Postgres (PGlite) loaded with backend/db/schema.sql
// replaces Neon; SNS, S3, DynamoDB, EventBridge/audit and Secrets Manager are
// in-memory fakes. Nothing reaches Neon or Floci. Must be required BEFORE any
// service module, because it installs the fakes in the require cache.
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const backend = path.resolve(__dirname, '../..');
const repo = path.resolve(backend, '..');
const pg = new PGlite();

const wrapRes = (r) => ({ rows: r.rows, rowCount: r.affectedRows ?? r.rows.length });
const stub = (rel, exports) => {
  const file = require.resolve(path.join(backend, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};

stub('shared/db', {
  initDb: async () => {},
  getPool: () => { throw new Error('not used'); },
  query: async (text, params = []) => wrapRes(await pg.query(text, params)),
  withTransaction: (fn) => pg.transaction(async (tx) => fn({ query: async (t, p = []) => wrapRes(await tx.query(t, p)) })),
});
stub('shared/secrets', { getSecret: async (id) => (id === 'esp/jwt' ? { secret: 'isolated-test-only-secret' } : {}) });

const events = [];
stub('shared/events', { publishEvent: async (type, payload, source) => { const e = { id: `evt-${events.length + 1}`, type, source, occurredAt: new Date().toISOString(), payload }; events.push(e); return e; } });
const audits = [];
stub('shared/audit', { audit: async (_req, action, o = {}) => { audits.push({ action, ...o }); } });

const s3Objects = new Map();
const fakeS3 = { send: async (cmd) => {
  const { Bucket, Key, Body, ContentType } = cmd.input;
  if (cmd.constructor.name === 'PutObjectCommand') { s3Objects.set(`${Bucket}/${Key}`, { Body, ContentType }); return {}; }
  if (cmd.constructor.name === 'GetObjectCommand') {
    const o = s3Objects.get(`${Bucket}/${Key}`);
    if (!o) { const e = new Error('NoSuchKey'); e.name = 'NoSuchKey'; throw e; }
    return { ContentType: o.ContentType, Body: { transformToString: async () => o.Body } };
  }
  return {};
} };
// DynamoDB document client fake (GetCommand / PutCommand), keyed by table + key.
const dynamoItems = new Map();
const dynamoState = { failing: false };
const fakeDynamo = { send: async (cmd) => {
  if (dynamoState.failing) throw new Error('DynamoDB unavailable (simulated)');
  const { TableName, Key, Item } = cmd.input;
  if (cmd.constructor.name === 'PutCommand') { dynamoItems.set(`${TableName}/${Item.jti ?? Item.cacheKey}`, { ...Item }); return {}; }
  if (cmd.constructor.name === 'GetCommand') { const it = dynamoItems.get(`${TableName}/${Object.values(Key)[0]}`); return it ? { Item: { ...it } } : {}; }
  return {};
} };
const noop = { send: async () => ({}) };
stub('shared/aws', { s3: () => fakeS3, sns: () => noop, sqs: () => noop, events: () => noop, secrets: () => noop, logs: () => noop, cloudwatch: () => noop, dynamo: () => fakeDynamo });

// Structured log lines (what CloudWatch would receive) are captured, not printed.
const logs = [];
const origLog = console.log;
const origErr = console.error;
const capture = (orig) => (...a) => {
  if (typeof a[0] === 'string' && a[0].startsWith('{"time"')) { try { logs.push(JSON.parse(a[0])); } catch { /* ignore */ } return; }
  orig(...a);
};
console.log = capture(origLog);
console.error = capture(origErr);

async function loadSchema() {
  await pg.exec(fs.readFileSync(path.join(backend, 'db/schema.sql'), 'utf8'));
}
const q = async (sql, p) => (await pg.query(sql, p)).rows;

function makeTester() {
  const results = [];
  async function test(idTag, type, scenario, expected, fn) {
    let actual; let pass;
    try { ({ actual, pass } = await fn()); } catch (e) { actual = `ERROR ${e.message}`; pass = false; }
    results.push({ idTag, type, scenario, expected, actual, pass });
    origLog(`${pass ? 'PASS' : 'FAIL'} ${idTag} ${scenario} -> ${actual}`);
  }
  return { results, test };
}

function makeClient(base, defaultHeaders = {}) {
  return async function call(method, url, { token, body, headers = {} } = {}) {
    const h = { ...defaultHeaders, ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const res = await fetch(base() + url, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = res.status === 204 ? '' : await res.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  };
}
const code = (r) => `${r.status}${r.data?.error ? ` ${r.data.error.code}` : ''}`;
const expectStatus = (r, s, extra = true, note = '') => ({ actual: `${code(r)}${note ? `; ${note}` : ''}`, pass: r.status === s && extra });

function writeReport(file, title, intro, results) {
  const passed = results.filter((r) => r.pass).length;
  const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const md = [`# ${title}`, '', `Run: ${new Date().toISOString()} on **disposable storage**: ${intro} **${passed}/${results.length} passed.**`, '',
    '| ID | Type | Scenario | Expected | Actual | Result |', '|---|---|---|---|---|---|',
    ...results.map((r) => `| ${r.idTag} | ${r.type} | ${esc(r.scenario)} | ${esc(r.expected)} | ${esc(r.actual)} | ${r.pass ? 'PASS' : 'FAIL'} |`), ''].join('\n');
  fs.mkdirSync(path.join(repo, 'docs/tests'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'docs/tests', file), md);
  origLog(`\n${passed}/${results.length} passed. Wrote docs/tests/${file}`);
  return passed === results.length;
}

const listen = (app) => new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });

module.exports = { backend, repo, pg, q, loadSchema, events, audits, s3Objects, dynamoItems, dynamoState, logs, origLog, makeTester, makeClient, code, expectStatus, writeReport, listen };
