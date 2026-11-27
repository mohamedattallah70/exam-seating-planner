// Neon Postgres access. Each service connects with ITS OWN least-privilege
// database role, whose connection string is stored in Secrets Manager under
// esp/db/<service>. The Neon serverless driver talks to Neon over WebSockets
// (TLS, port 443), so it also works on networks that block port 5432.
const { Pool } = require('@neondatabase/serverless');
const { getSecret } = require('./secrets');
const { RESOURCES } = require('./config');

let pool = null;

async function initDb(service) {
  if (pool) return pool;
  const secret = await getSecret(RESOURCES.secrets.db(service));
  pool = new Pool({ connectionString: secret.url, max: 5 });
  pool.on('error', (err) => console.error(JSON.stringify({ level: 'error', event: 'db_pool_error', message: err.message })));
  return pool;
}

function getPool() {
  if (!pool) throw new Error('Database not initialised: call initDb(service) first');
  return pool;
}

// Parameterised queries only: never build SQL by concatenating user input.
async function query(text, params = []) {
  return getPool().query(text, params);
}

// Runs fn(client) inside BEGIN/COMMIT; rolls back on any error.
async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { initDb, query, withTransaction, getPool };
