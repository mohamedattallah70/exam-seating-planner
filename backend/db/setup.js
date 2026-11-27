// Creates/updates the database: tables (schema.sql), one login role per
// service with a random password, and least-privilege grants (roles.sql).
// Uses the Neon OWNER connection (DATABASE_URL in .env) — only this script
// and seed.js use it; running services never do.
//   npm run db:setup            -> create anything missing (safe to re-run)
//   npm run db:setup -- --reset -> DROP all tables first (recovery / clean demo)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('@neondatabase/serverless');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const SERVICES = ['auth', 'halls', 'exams', 'allocation'];
const ENV_FILE = path.join(__dirname, '..', '.env');

function ensureEnvPassword(service) {
  const key = `DB_PASSWORD_${service.toUpperCase()}`;
  if (!process.env[key]) {
    process.env[key] = crypto.randomBytes(24).toString('base64url');
    fs.appendFileSync(ENV_FILE, `\n${key}=${process.env[key]}`);
    console.log(`  generated ${key} (saved to .env)`);
  }
  return process.env[key];
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL (Neon owner connection) missing in backend/.env');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = await pool.connect();
  try {
    if (process.argv.includes('--reset')) {
      console.log('Dropping all tables...');
      await db.query('DROP TABLE IF EXISTS audit_logs, allocation_runs, seat_assignments, roster_imports, proctor_assignments, enrollments, exam_halls, exams, seats, halls, users CASCADE');
    }
    console.log('Applying schema.sql...');
    await db.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

    console.log('Creating service roles...');
    for (const s of SERVICES) {
      const role = `esp_${s}`;
      const pw = ensureEnvPassword(s).replace(/'/g, "''");
      const exists = (await db.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount > 0;
      await db.query(exists
        ? `ALTER ROLE ${role} WITH LOGIN PASSWORD '${pw}'`
        : `CREATE ROLE ${role} WITH LOGIN PASSWORD '${pw}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
      console.log(`  ${role} ${exists ? 'updated' : 'created'}`);
    }

    console.log('Applying roles.sql (grants)...');
    await db.query(fs.readFileSync(path.join(__dirname, 'roles.sql'), 'utf8'));
    console.log('Database ready. Next: npm run provision (stores the service DB URLs in Secrets Manager).');
  } finally {
    db.release();
    await pool.end();
  }
}

main().catch((e) => { console.error('db:setup failed:', e.message); process.exit(1); });
