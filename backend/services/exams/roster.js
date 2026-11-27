// Roster import: parse student codes (pasted text or a CSV in S3), validate
// every row against the business rules, and report accepted/rejected rows.
const crypto = require('crypto');
const { PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const aws = require('../../shared/aws');
const { RESOURCES } = require('../../shared/config');
const { query } = require('../../shared/db');
const { badRequest, forbidden } = require('../../shared/errors');
const { findStudentClashes } = require('./rules');

const CODE_RE = /^S\d{4,8}$/;
const MAX_ROWS = 1000;
const MAX_CSV_BYTES = 200 * 1024;
const BUCKET = RESOURCES.buckets.rosters;

// "S1001, S1002\nS1003" or a CSV with a student_code header -> ['S1001', ...]
function parseCodes(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length && /student|code/i.test(lines[0]) && !CODE_RE.test(lines[0].split(/[,;\s]/)[0].toUpperCase())) lines.shift(); // header
  const tokens = lines.flatMap((l) => l.split(/[,;\s]+/)).map((t) => t.replace(/^"|"$/g, '').trim().toUpperCase()).filter(Boolean);
  if (tokens.length === 0) throw badRequest('No student codes found');
  if (tokens.length > MAX_ROWS) throw badRequest(`Too many rows (max ${MAX_ROWS})`);
  return tokens;
}

// Applies the rules in order; the first failing rule is the rejection reason.
async function validateRows(exam, tokens) {
  const accepted = [];
  const rejected = [];
  const reject = (row, value, reason, message) => rejected.push({ row, value, reason, message });

  const valid = [...new Set(tokens.filter((t) => CODE_RE.test(t)))];
  const { rows: users } = await query("SELECT id, name, student_code FROM users WHERE role = 'student' AND student_code = ANY($1::text[])", [valid]);
  const byCode = new Map(users.map((u) => [u.student_code, u]));
  const { rows: enrolled } = await query('SELECT student_id FROM enrollments WHERE exam_id = $1', [exam.id]);
  const enrolledIds = new Set(enrolled.map((r) => r.student_id));
  const clashes = await findStudentClashes({
    studentIds: users.map((u) => u.id), date: exam.exam_date, start: exam.start_time, duration: exam.duration_min, excludeExamId: exam.id,
  });
  const clashBy = new Map(clashes.map((c) => [c.student_id, c]));

  const seen = new Set();
  tokens.forEach((code, i) => {
    const row = i + 1;
    if (!CODE_RE.test(code)) return reject(row, code, 'INVALID_FORMAT', 'Student codes look like S1234');
    if (seen.has(code)) return reject(row, code, 'DUPLICATE_IN_FILE', 'Listed more than once');
    seen.add(code);
    const user = byCode.get(code);
    if (!user) return reject(row, code, 'UNKNOWN_STUDENT', 'No student with this code');
    if (enrolledIds.has(user.id)) return reject(row, code, 'ALREADY_ENROLLED', 'Already on this exam roster');
    const clash = clashBy.get(user.id);
    if (clash) return reject(row, code, 'TIMETABLE_CLASH', `Already sitting ${clash.course_code} at ${clash.start_time} on the same day`);
    accepted.push({ row, studentId: user.id, code, name: user.name });
  });
  return { accepted, rejected };
}

// Short-lived presigned URL so the browser uploads the CSV straight to S3.
async function createUploadUrl(examId) {
  const key = `exam-${examId}/${crypto.randomUUID()}.csv`;
  const url = await getSignedUrl(aws.s3(), new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: 'text/csv' }), { expiresIn: 300 });
  return { key, url, expiresIn: 300 };
}

// Reads an uploaded roster. The key must belong to THIS exam (object ownership).
async function readUploadedCsv(examId, key) {
  if (!new RegExp(`^exam-${examId}/[0-9a-f-]{36}\\.csv$`).test(key)) throw forbidden('This upload does not belong to this exam');
  let obj;
  try {
    obj = await aws.s3().send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  } catch {
    throw badRequest('Uploaded file not found — upload it again');
  }
  if (obj.ContentLength > MAX_CSV_BYTES) throw badRequest('File too large (max 200 KB)');
  return obj.Body.transformToString();
}

module.exports = { parseCodes, validateRows, createUploadUrl, readUploadedCsv };
