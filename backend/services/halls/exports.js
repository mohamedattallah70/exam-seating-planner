// Hall layout export to S3 bucket esp-hall-layouts (owner: Mohamed Rishi).
// One CSV and/or JSON object per export, keyed by hall id and timestamp, so
// earlier exports are kept as history. The halls IAM role may only
// s3:PutObject / s3:GetObject in this bucket (infra/provision.js).
const { PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const aws = require('../../shared/aws');
const { RESOURCES } = require('../../shared/config');

const BUCKET = RESOURCES.buckets.layouts;
const CSV_HEADER = ['hall_id', 'hall_name', 'building', 'row_no', 'col_no', 'label', 'status', 'block_reason'];

// RFC 4180 quoting, plus a leading ' on values a spreadsheet would run as a formula.
function csvCell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(hall) {
  const lines = [CSV_HEADER.join(',')];
  for (const s of hall.seats) {
    lines.push([hall.id, hall.name, hall.building, s.rowNo, s.colNo, s.label, s.status, s.blockReason].map(csvCell).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

function toJson(hall, exportedAt) {
  return JSON.stringify({
    exportedAt,
    hall: { id: hall.id, name: hall.name, building: hall.building, rows: hall.rows, cols: hall.cols },
    capacity: { totalSeats: hall.total_seats, usableSeats: hall.usable_seats, spacedSeats: hall.spaced_seats },
    seats: hall.seats.map((s) => ({ id: s.id, rowNo: s.rowNo, colNo: s.colNo, label: s.label, status: s.status, blockReason: s.blockReason })),
  }, null, 2);
}

async function exportLayout(hall, formats) {
  const exportedAt = new Date().toISOString();
  const stamp = exportedAt.replace(/[:.]/g, '-');
  const out = [];
  for (const format of formats) {
    const key = `halls/${hall.id}/layout-${stamp}.${format}`;
    const body = format === 'csv' ? toCsv(hall) : toJson(hall, exportedAt);
    await aws.s3().send(new PutObjectCommand({
      Bucket: BUCKET, Key: key, Body: body,
      ContentType: format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json',
      Metadata: { hallid: String(hall.id), seats: String(hall.seats.length) },
    }));
    out.push({ format, bucket: BUCKET, key, bytes: Buffer.byteLength(body) });
  }
  return { exportedAt, files: out };
}

async function readExport(key) {
  const res = await aws.s3().send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return { body: await res.Body.transformToString(), contentType: res.ContentType };
}

module.exports = { BUCKET, toCsv, toJson, csvCell, exportLayout, readExport };
