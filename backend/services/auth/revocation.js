// Token revocation (owner: Mohamed Rishi, auth lead).
// Logout writes the token's jti to DynamoDB EspRevokedTokens with
// expiresAt = the token's own expiry, so DynamoDB TTL deletes the row once
// the token could no longer be used anyway.
//
// requireAuth.isRevoked is a per-process hook, so every service that wants to
// reject logged-out tokens calls useRevocationCheck() in its index.js.
// A failed lookup throws, and requireAuth then answers 401 (fail closed).
const { GetCommand, PutCommand } = require('@aws-sdk/lib-dynamodb');
const aws = require('../../shared/aws');
const { RESOURCES } = require('../../shared/config');
const { requireAuth } = require('../../shared/auth');
const { log } = require('../../shared/logger');

const TABLE = RESOURCES.tables.revokedTokens;
// Positive results only: a revoked token stays revoked, so it is safe to
// cache. "Not revoked" is never cached, so a logout takes effect at once.
const revokedCache = new Map(); // jti -> expiresAt (epoch seconds)

async function revokeToken({ jti, exp, userId }) {
  if (!jti) throw new Error('Token has no jti');
  await aws.dynamo().send(new PutCommand({
    TableName: TABLE,
    Item: { jti, expiresAt: exp, userId, revokedAt: new Date().toISOString() },
  }));
  revokedCache.set(jti, exp);
}

async function isRevoked(jti) {
  if (!jti) return true; // every token we sign has a jti
  const now = Math.floor(Date.now() / 1000);
  const hit = revokedCache.get(jti);
  if (hit) {
    if (hit > now) return true;
    revokedCache.delete(jti);
  }
  try {
    const { Item } = await aws.dynamo().send(new GetCommand({ TableName: TABLE, Key: { jti }, ConsistentRead: true }));
    if (Item) { revokedCache.set(jti, Item.expiresAt); return true; }
    return false;
  } catch (err) {
    log('error', 'revocation_check_failed', { message: err.message });
    throw err;
  }
}

function useRevocationCheck() {
  requireAuth.isRevoked = isRevoked;
}

module.exports = { revokeToken, isRevoked, useRevocationCheck, _cache: revokedCache };
