// Demo data: 1 admin, 3 proctors, 80 students, 3 halls with seat grids.
// Passwords are NOT in the code: they come from backend/.env
// (SEED_ADMIN_PASSWORD, SEED_STAFF_PASSWORD, SEED_STUDENT_PASSWORD) and are
// generated + saved there on first run.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { Pool } = require('@neondatabase/serverless');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const ENV_FILE = path.join(__dirname, '..', '.env');
function envPassword(key) {
  if (!process.env[key]) {
    process.env[key] = `Esp-${crypto.randomBytes(6).toString('base64url')}1!`;
    fs.appendFileSync(ENV_FILE, `\n${key}=${process.env[key]}`);
  }
  return process.env[key];
}

const FIRST = ['Ahmed', 'Mona', 'Omar', 'Sara', 'Youssef', 'Nada', 'Karim', 'Laila', 'Hassan', 'Farida', 'Ali', 'Mariam', 'Tarek', 'Salma', 'Mostafa', 'Habiba'];
const LAST = ['Hassan', 'Mahmoud', 'Ibrahim', 'Saleh', 'Fathy', 'Nabil', 'Kamal', 'Adel', 'Samir', 'Rashad'];

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = await pool.connect();
  try {
    const [adminHash, staffHash, studentHash] = await Promise.all([
      bcrypt.hash(envPassword('SEED_ADMIN_PASSWORD'), 10),
      bcrypt.hash(envPassword('SEED_STAFF_PASSWORD'), 10),
      bcrypt.hash(envPassword('SEED_STUDENT_PASSWORD'), 10),
    ]);
    const users = [['Exam Office Admin', 'admin@esp.test', null, adminHash, 'admin']];
    for (let i = 1; i <= 3; i++) users.push([`Proctor ${i}`, `proctor${i}@esp.test`, null, staffHash, 'proctor']);
    for (let i = 1; i <= 80; i++) {
      const code = `S${1000 + i}`;
      users.push([`${FIRST[i % FIRST.length]} ${LAST[i % LAST.length]}`, `${code.toLowerCase()}@students.esp.test`, code, studentHash, 'student']);
    }
    for (const u of users) {
      await db.query(
        'INSERT INTO users (name, email, student_code, password_hash, role) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (email) DO NOTHING', u,
      );
    }

    const halls = [['Main Hall A', 'Building A', 8, 10, ['A3', 'D5', 'H10']], ['Hall B', 'Building A', 6, 8, ['B2']], ['Lab C', 'Building C', 5, 6, []]];
    for (const [name, building, rows, cols, blocked] of halls) {
      const { rows: r } = await db.query(
        'INSERT INTO halls (name, building, rows, cols) VALUES ($1,$2,$3,$4) ON CONFLICT (name) DO NOTHING RETURNING id', [name, building, rows, cols],
      );
      if (!r[0]) continue;
      // Seat label = row letter + column number, e.g. C7
      await db.query(
        `INSERT INTO seats (hall_id, row_no, col_no, label, status, block_reason)
         SELECT $1, r, c, chr(64 + r) || c,
                CASE WHEN (chr(64 + r) || c) = ANY($4) THEN 'blocked' ELSE 'available' END,
                CASE WHEN (chr(64 + r) || c) = ANY($4) THEN 'Broken chair' END
         FROM generate_series(1, $2::int) r, generate_series(1, $3::int) c`,
        [r[0].id, rows, cols, blocked],
      );
    }
    console.log(`Seeded ${users.length} users and ${halls.length} halls.`);
    console.log('Logins: admin@esp.test, proctor1@esp.test..proctor3, students S1001..S1080 (passwords in backend/.env SEED_*).');
  } finally {
    db.release();
    await pool.end();
  }
}

main().catch((e) => { console.error('seed failed:', e.message); process.exit(1); });
