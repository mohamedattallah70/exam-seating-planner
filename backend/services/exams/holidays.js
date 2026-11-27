// External integration: Calendarific Holidays API (Egyptian public holidays).
// - API key read from Secrets Manager (esp/calendarific), only on the server.
// - One API call per year: results cached in DynamoDB (EspHolidayCache, TTL 7 days),
//   which keeps us well inside the free plan and makes checks fast.
// - Never blocks the workflow: if the API fails, the exam is still saved with
//   a "holiday not checked" note.
const { GetCommand, PutCommand } = require('@aws-sdk/lib-dynamodb');
const aws = require('../../shared/aws');
const { getSecret } = require('../../shared/secrets');
const { RESOURCES } = require('../../shared/config');
const { log } = require('../../shared/logger');

const CACHE_DAYS = 7;
const TIMEOUT_MS = 5000;
// Calendarific also returns observances/seasons; only real days off matter here.
const PUBLIC_TYPES = /national|public|bank|religious|common local/i;

async function fetchFromApi(year) {
  const { apiKey } = await getSecret(RESOURCES.secrets.calendarific);
  const url = new URL('https://calendarific.com/api/v2/holidays');
  url.search = new URLSearchParams({ api_key: apiKey, country: 'EG', year: String(year) });
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Calendarific responded ${res.status}`);
  const body = await res.json();
  return (body.response?.holidays || [])
    .filter((h) => h.type?.some((t) => PUBLIC_TYPES.test(t)))
    .map((h) => ({ date: h.date.iso.slice(0, 10), name: h.name, type: h.type.join(', ') }));
}

async function getEgyptHolidays(year) {
  const cacheKey = `EG-${year}`;
  const db = aws.dynamo();
  const cached = await db.send(new GetCommand({ TableName: RESOURCES.tables.holidayCache, Key: { cacheKey } })).catch(() => null);
  if (cached?.Item && cached.Item.expiresAt > Date.now() / 1000) return { holidays: cached.Item.holidays, source: 'cache' };

  const holidays = await fetchFromApi(year);
  await db.send(new PutCommand({
    TableName: RESOURCES.tables.holidayCache,
    Item: { cacheKey, holidays, fetchedAt: new Date().toISOString(), expiresAt: Math.floor(Date.now() / 1000) + CACHE_DAYS * 86400 },
  })).catch((e) => log('warn', 'holiday_cache_write_failed', { message: e.message }));
  log('info', 'holiday_api_called', { year, count: holidays.length });
  return { holidays, source: 'api' };
}

// -> { checked, isHoliday, holidays: [{date,name,type}], source, note }
async function checkDate(date) {
  try {
    const { holidays, source } = await getEgyptHolidays(Number(date.slice(0, 4)));
    const matches = holidays.filter((h) => h.date === date);
    return {
      checked: true,
      isHoliday: matches.length > 0,
      holidays: matches,
      source,
      note: matches.length ? `Egyptian public holiday: ${matches.map((h) => h.name).join(', ')}` : null,
    };
  } catch (err) {
    log('warn', 'holiday_api_failed', { message: err.message });
    return { checked: false, isHoliday: false, holidays: [], source: 'none', note: 'Holiday check unavailable — please verify the date manually' };
  }
}

module.exports = { checkDate };
