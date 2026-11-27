// Reads secrets from AWS Secrets Manager (Floci) and caches them in memory.
// Services never read secrets from .env or source code.
const { GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const aws = require('./aws');

const cache = new Map();
const TTL_MS = 5 * 60 * 1000; // re-read every 5 min so a rotated secret is picked up

async function getSecret(id) {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const out = await aws.secrets().send(new GetSecretValueCommand({ SecretId: id }));
  let value = out.SecretString;
  try { value = JSON.parse(value); } catch { /* plain string secret */ }
  cache.set(id, { value, at: Date.now() });
  return value;
}

module.exports = { getSecret };
