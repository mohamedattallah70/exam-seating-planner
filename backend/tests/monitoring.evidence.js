// Logging & monitoring evidence (owner: Mohamed Rishi, logging lead).
// Runs against the RUNNING STACK on Floci:  npm run dev  then  npm run evidence:monitoring
//   1. Generates SAFE security traffic through the gateway:
//        - 6 failed logins for identifiers that do not exist (no real account is locked)
//        - 12 student requests to /api/halls (403) and 3 anonymous requests (401)
//      It does NOT trigger an account lockout or the login rate limit, because on
//      a shared database / shared localhost those would block teammates for 15 min.
//      Those two paths are covered by tests/isolated/auth.js.
//   2. Reads back CloudWatch: metric filters, metric datapoints (ESP namespace),
//      alarm states, and CloudWatch Logs Insights queries.
//   3. Writes docs/tests/monitoring-evidence.md (IPs masked, no tokens/passwords).
// Note: Floci 2.5.0 Logs Insights supports fields / filter (one condition or `or`)
// / sort / limit, but not `and`, `>` or `stats`; the queries below stay in that
// subset. Full AWS versions (with stats) are listed in the report, marked not-run.
const fs = require('fs');
const path = require('path');
const CWL = require('@aws-sdk/client-cloudwatch-logs');
const CW = require('@aws-sdk/client-cloudwatch');
const { AWS, RESOURCES } = require('../shared/config');

const API = 'http://localhost:8080/api';
const env = process.env;
const logs = new CWL.CloudWatchLogsClient(AWS);
const cw = new CW.CloudWatchClient(AWS);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const maskIp = (ip) => (!ip ? '' : /^(::1|127\.|::ffff:127\.)/.test(ip) ? `${ip} (loopback)` : ip.replace(/[0-9a-f]+$/i, 'x'));

async function call(method, url, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(API + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return res.status;
}

async function insights(group, queryString, sinceSec) {
  const now = Math.floor(Date.now() / 1000);
  const { queryId } = await logs.send(new CWL.StartQueryCommand({ logGroupNames: [group], startTime: now - sinceSec, endTime: now + 60, queryString }));
  for (let i = 0; i < 40; i += 1) {
    const r = await logs.send(new CWL.GetQueryResultsCommand({ queryId }));
    if (['Complete', 'Failed', 'Cancelled'].includes(r.status)) {
      return { status: r.status, rows: (r.results || []).map((row) => Object.fromEntries(row.filter((c) => c.field !== '@ptr').map((c) => [c.field, c.value]))) };
    }
    await sleep(500);
  }
  return { status: 'Timeout', rows: [] };
}

const table = (rows, cols) => (rows.length ? [`| ${cols.join(' | ')} |`, `|${cols.map(() => '---').join('|')}|`,
  ...rows.map((r) => `| ${cols.map((c) => String(c === 'ip' ? maskIp(r[c]) : (r[c] ?? '')).replace(/\|/g, '/')).join(' | ')} |`)].join('\n') : '_no rows_');

(async () => {
  const started = new Date();
  const out = [];
  // ---------- 1. traffic ----------
  const student = await (await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: 'S1001', password: env.SEED_STUDENT_PASSWORD }) })).json();
  if (!student.token) { console.error('Student login failed: is the stack running and backend/.env present?'); process.exit(1); }
  const traffic = { failedLogins: [], forbidden: [], unauthorized: [] };
  for (let i = 1; i <= 6; i += 1) traffic.failedLogins.push(await call('POST', '/auth/login', { body: { identifier: `monitoring-probe-${i}@invalid.test`, password: 'not-a-password' } }));
  for (let i = 0; i < 12; i += 1) traffic.forbidden.push(await call('GET', '/halls', { token: student.token }));
  for (let i = 0; i < 3; i += 1) traffic.unauthorized.push(await call('GET', '/halls'));
  console.log('traffic:', JSON.stringify(traffic));

  // ---------- 2. wait for log shipping (every 2 s) + metric filters ----------
  await sleep(12000);
  const { metricFilters } = await logs.send(new CWL.DescribeMetricFiltersCommand({}));
  const metrics = {};
  for (const f of metricFilters) {
    const name = f.metricTransformations[0].metricName;
    const st = await cw.send(new CW.GetMetricStatisticsCommand({ Namespace: RESOURCES.metricNamespace, MetricName: name, StartTime: new Date(started.getTime() - 600000), EndTime: new Date(Date.now() + 60000), Period: 300, Statistics: ['Sum'] }));
    metrics[name] = (st.Datapoints || []).reduce((n, d) => n + d.Sum, 0);
  }
  console.log('metric sums (this run window):', JSON.stringify(metrics));

  // alarms: Floci evaluates every 5 minutes on completed periods, so poll up to ~7 minutes
  let alarms = [];
  for (let i = 0; i < 42; i += 1) {
    alarms = (await cw.send(new CW.DescribeAlarmsCommand({}))).MetricAlarms;
    const want = ['ESP-FailedLogins-BruteForce', 'ESP-Forbidden-Spike'];
    if (want.every((n) => alarms.find((a) => a.AlarmName === n)?.StateValue === 'ALARM')) break;
    await sleep(10000);
  }
  console.log('alarms:', alarms.map((a) => `${a.AlarmName}=${a.StateValue}`).join(', '));
  const history = [];
  for (const a of alarms) {
    // 2 h back: an alarm may already be in ALARM from an earlier probe run (Floci keeps the state).
    // Filtered here because Floci 2.5.0 drops items when StartDate is passed.
    const from = started.getTime() - 2 * 3600e3;
    const { AlarmHistoryItems = [] } = await cw.send(new CW.DescribeAlarmHistoryCommand({ AlarmName: a.AlarmName, HistoryItemType: 'StateUpdate', MaxRecords: 100 }));
    AlarmHistoryItems.filter((h) => h.Timestamp.getTime() >= from)
      .forEach((h) => history.push({ at: h.Timestamp.toISOString(), alarm: a.AlarmName, summary: h.HistorySummary }));
  }
  history.sort((x, y) => x.at.localeCompare(y.at));

  // ---------- 3. Logs Insights (Floci-supported subset) ----------
  const since = Math.ceil((Date.now() - started.getTime()) / 1000) + 300;
  const Q = [
    ['Failed logins (feeds FailedLogins)', '/esp/auth', 'fields @timestamp, ip, userId, failedLogins | filter event = "login_failed" | sort @timestamp desc | limit 10', ['@timestamp', 'ip', 'userId', 'failedLogins']],
    ['401 / 403 responses at the gateway (feeds Unauthorized401 / Forbidden403)', '/esp/gateway', 'fields @timestamp, method, path, status, role | filter status = 401 or status = 403 | sort @timestamp desc | limit 20', ['@timestamp', 'method', 'path', 'status', 'role']],
    ['Denied access recorded by the shared role check (audit)', '/esp/halls', 'fields @timestamp, role, action, target, outcome | filter action = "ACCESS_DENIED" | sort @timestamp desc | limit 5', ['@timestamp', 'role', 'action', 'target', 'outcome']],
    ['Hall audit trail (create / block / resize / export / delete)', '/esp/halls', 'fields @timestamp, role, action, target, outcome | filter event = "audit" | sort @timestamp desc | limit 15', ['@timestamp', 'role', 'action', 'target', 'outcome']],
    ['Domain events published by Halls (SNS)', '/esp/halls', 'fields @timestamp, type, eventId | filter event = "event_published" | sort @timestamp desc | limit 5', ['@timestamp', 'type', 'eventId']],
  ];
  const qResults = [];
  for (const [title, group, qs, cols] of Q) {
    // the audit-trail queries look back further, to include the earlier walkthrough
    const r = await insights(group, qs, /audit trail|SNS/.test(title) ? 4 * 3600 : since);
    qResults.push({ title, group, qs, cols, ...r });
    console.log(`${r.status} ${title}: ${r.rows.length} rows`);
  }

  // ---------- 4. report ----------
  out.push('# Logging & monitoring evidence (CloudWatch on Floci)', '',
    `Run: ${started.toISOString()} against the running stack (gateway → services → Neon + Floci 2.5.0). Generated by \`npm run evidence:monitoring\`. IPs are masked; logs never contain tokens or passwords.`, '',
    '## 1. Traffic generated (safe for the shared database)', '',
    '| Probe | Count | Status codes returned |', '|---|---|---|',
    `| Failed logins, identifiers that do not exist | 6 | ${traffic.failedLogins.join(', ')} |`,
    `| Student calls GET /api/halls | 12 | ${traffic.forbidden.join(', ')} |`,
    `| Anonymous GET /api/halls | 3 | ${traffic.unauthorized.join(', ')} |`, '',
    'Account lockout (423) and the login rate limit (429) were **not** triggered here, so teammates are not locked out of the shared demo accounts; they are tested in `auth-isolated-results.md`.', '',
    '## 2. Metric filters → metrics (namespace `ESP`)', '',
    '| Log group | Filter | Pattern | Metric | Sum in this run window |', '|---|---|---|---|---|',
    ...metricFilters.map((f) => `| ${f.logGroupName} | ${f.filterName} | \`${f.filterPattern}\` | ${f.metricTransformations[0].metricName} | ${metrics[f.metricTransformations[0].metricName] ?? 0} |`), '',
    '## 3. Alarms', '',
    '| Alarm | Metric | Threshold (Sum / 5 min) | State | Reason |', '|---|---|---|---|---|',
    ...alarms.map((a) => `| ${a.AlarmName} | ${a.MetricName} | ≥ ${a.Threshold} | **${a.StateValue}** | ${(a.StateReason || '').replace(/\|/g, '/').slice(0, 140)} |`), '',
    'Alarm state changes in the 2 hours up to this run (Floci evaluates alarms every 5 minutes on completed periods; an alarm already in ALARM from an earlier probe stays there, so it shows no new change):', '',
    history.length ? ['| Time (UTC) | Alarm | Change |', '|---|---|---|', ...history.map((h) => `| ${h.at} | ${h.alarm} | ${h.summary} |`)].join('\n') : '_no state changes yet_', '',
    '## 4. CloudWatch Logs Insights queries (run on Floci)', '');
  for (const r of qResults) {
    out.push(`### ${r.title}`, '', `Log group \`${r.group}\`, status **${r.status}**, ${r.rows.length} rows`, '', '```', r.qs, '```', '', table(r.rows, r.cols), '');
  }
  out.push('## 5. Same questions in full AWS Logs Insights syntax (not run: Floci 2.5.0 does not support `stats` / `and` / `>`)', '',
    '```', 'filter event = "login_failed" | stats count(*) as failures by ip, bin(5m) | sort failures desc', '```',
    '```', 'filter event = "request" and status >= 400 | stats count(*) by status, path, role | sort count(*) desc', '```',
    '```', 'filter event = "audit" and outcome = "denied" | stats count(*) by action, role', '```', '');
  const file = path.join(__dirname, '..', '..', 'docs', 'tests', 'monitoring-evidence.md');
  fs.writeFileSync(file, out.join('\n'));
  console.log(`wrote ${path.relative(process.cwd(), file)}`);
})().catch((e) => { console.error(e); process.exit(1); });
