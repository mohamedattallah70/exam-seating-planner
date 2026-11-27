// S3 seat-map exports + CloudWatch custom metrics (Seat Allocation service).
// When a plan is published (or changed afterwards) one CSV per hall is written to
// the private, encrypted bucket esp-seatmap-exports:  exam-<id>/hall-<hallId>.csv
const { PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
const { PutMetricDataCommand } = require('@aws-sdk/client-cloudwatch');
const aws = require('../../shared/aws');
const { RESOURCES } = require('../../shared/config');
const { query } = require('../../shared/db');
const { log } = require('../../shared/logger');

const Bucket = RESOURCES.buckets.seatmaps;
const csvCell = (v) => {
  const s = String(v ?? '');
  // quote, and neutralise spreadsheet formulas (CSV injection)
  return `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
};

async function exportSeatMaps(examId) {
  const rows = (await query(
    `SELECT s.hall_id AS "hallId", h.name AS hall, s.label AS seat, u.student_code, u.name
       FROM seat_assignments a JOIN seats s ON s.id = a.seat_id JOIN halls h ON h.id = s.hall_id
       JOIN users u ON u.id = a.student_id
      WHERE a.exam_id = $1 ORDER BY h.name, s.row_no, s.col_no`, [examId])).rows;
  const byHall = new Map();
  rows.forEach((r) => { if (!byHall.has(r.hallId)) byHall.set(r.hallId, []); byHall.get(r.hallId).push(r); });
  await deleteSeatMaps(examId);
  const keys = [];
  for (const [hallId, list] of byHall) {
    const Key = `exam-${examId}/hall-${hallId}.csv`;
    const Body = ['hall,seat,student_code,name', ...list.map((r) => [r.hall, r.seat, r.student_code, r.name].map(csvCell).join(','))].join('\n');
    await aws.s3().send(new PutObjectCommand({ Bucket, Key, Body, ContentType: 'text/csv', ServerSideEncryption: 'AES256' }));
    keys.push(Key);
  }
  log('info', 'seatmap_exported', { examId, keys });
  return keys;
}

async function deleteSeatMaps(examId) {
  const listed = await aws.s3().send(new ListObjectsV2Command({ Bucket, Prefix: `exam-${examId}/` }));
  const objs = (listed.Contents || []).map((o) => ({ Key: o.Key }));
  if (objs.length) await aws.s3().send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: objs } }));
  return objs.length;
}

// Never let a monitoring failure break the request.
async function metric(name, value, unit = 'Count') {
  try {
    await aws.cloudwatch().send(new PutMetricDataCommand({
      Namespace: `${RESOURCES.metricNamespace}/Allocation`,
      MetricData: [{ MetricName: name, Value: value, Unit: unit, Timestamp: new Date() }],
    }));
  } catch (err) { log('warn', 'metric_failed', { name, message: err.message }); }
}

async function safeExport(examId) {
  try { return await exportSeatMaps(examId); } catch (err) { log('error', 'seatmap_export_failed', { examId, message: err.message }); return []; }
}

module.exports = { exportSeatMaps, deleteSeatMaps, safeExport, metric };
