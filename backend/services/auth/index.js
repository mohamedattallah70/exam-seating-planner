// Auth service (shared identity). Owner: Mohamed Rishi (auth lead).
// Login / me / logout from the foundation, plus the hardening agreed in
// docs/CONTRACT.md:
//   * Account lockout: 5 failed logins -> locked for 15 minutes (423).
//     Uses users.failed_logins / users.locked_until; a correct password does
//     not unlock early. The counter restarts after a lock expires.
//   * Stricter rate limit on POST /api/auth/login: 10 failed attempts per
//     IP per 15 minutes (429). Successful logins do not count, so a class
//     sharing one IP is not locked out by its own successful sign-ins.
//   * Logout revokes the token: its jti goes into DynamoDB EspRevokedTokens
//     with TTL = token expiry (revocation.js). Every request through
//     requireAuth() in this service checks it, and the Halls service does too.
// Turnstile (from the proposal) is optional in the contract and not added.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { rateLimit } = require('express-rate-limit');
const { createService } = require('../../shared/createService');
const { query } = require('../../shared/db');
const { requireAuth, signToken } = require('../../shared/auth');
const { validate, z } = require('../../shared/validate');
const { audit } = require('../../shared/audit');
const { log } = require('../../shared/logger');
const { revokeToken, useRevocationCheck } = require('./revocation');

const LOCKOUT = { maxFailures: 5, minutes: 15 };
const LOGIN_LIMIT = { windowMs: 15 * 60 * 1000, limit: 10 };

const loginSchema = z.object({
  identifier: z.string().trim().min(3).max(120), // email or student code
  password: z.string().min(1).max(72),
});

// Used when the identifier is unknown (or the account is locked) so response
// time does not reveal whether an account exists.
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10);

const loginLimiter = rateLimit({
  windowMs: LOGIN_LIMIT.windowMs,
  limit: LOGIN_LIMIT.limit,
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (req, res) => {
    log('warn', 'login_rate_limited', { ip: req.ip });
    audit(req, 'LOGIN_RATE_LIMITED', { outcome: 'denied', target: 'POST /api/auth/login' });
    res.status(429).json({ error: { code: 'TOO_MANY_ATTEMPTS', message: 'Too many failed login attempts from this address. Try again later.' } });
  },
});

const lockedResponse = (res, lockedUntil) => {
  const seconds = Math.max(1, Math.ceil((new Date(lockedUntil).getTime() - Date.now()) / 1000));
  res.set('Retry-After', String(seconds));
  return res.status(423).json({ error: { code: 'ACCOUNT_LOCKED', message: `Account locked after too many failed logins. Try again in ${Math.ceil(seconds / 60)} minute(s).` } });
};

const service = createService('auth', (app) => {
  app.post('/api/auth/login', loginLimiter, validate({ body: loginSchema }), async (req, res, next) => {
    try {
      const { identifier, password } = req.valid.body;
      const { rows } = await query(
        `SELECT id, name, email, student_code, role, password_hash, locked_until, (locked_until > now()) AS locked
           FROM users WHERE lower(email) = lower($1) OR student_code = upper($1)`,
        [identifier],
      );
      const user = rows[0];

      if (user?.locked) {
        await bcrypt.compare(password, DUMMY_HASH); // same work as a normal attempt
        log('warn', 'login_blocked_locked', { ip: req.ip, userId: user.id });
        await audit(req, 'LOGIN_BLOCKED_LOCKED', { outcome: 'denied', userId: user.id });
        return lockedResponse(res, user.locked_until);
      }

      const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
      if (!user || !ok) {
        let state = null;
        if (user) {
          // One atomic UPDATE: concurrent failures can't skip the 5th count.
          ({ rows: [state] } = await query(
            `UPDATE users SET
               failed_logins = CASE WHEN locked_until <= now() THEN 1 ELSE failed_logins + 1 END,
               locked_until = CASE WHEN (CASE WHEN locked_until <= now() THEN 1 ELSE failed_logins + 1 END) >= $2
                                   THEN now() + make_interval(mins => $3) ELSE NULL END
             WHERE id = $1 RETURNING failed_logins, locked_until`,
            [user.id, LOCKOUT.maxFailures, LOCKOUT.minutes]));
        }
        log('warn', 'login_failed', { ip: req.ip, userId: user?.id ?? null, failedLogins: state?.failed_logins ?? null });
        await audit(req, 'LOGIN_FAILED', { outcome: 'denied', userId: user?.id ?? null, details: { reason: 'bad_credentials', failedLogins: state?.failed_logins ?? null } });
        if (state?.locked_until) {
          log('warn', 'account_locked', { ip: req.ip, userId: user.id, minutes: LOCKOUT.minutes });
          await audit(req, 'ACCOUNT_LOCKED', { outcome: 'denied', userId: user.id, details: { failedLogins: state.failed_logins, minutes: LOCKOUT.minutes } });
          return lockedResponse(res, state.locked_until);
        }
        return res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Incorrect email/student code or password' } });
      }

      await query('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [user.id]);
      const token = await signToken(user, crypto.randomUUID());
      req.user = { id: user.id, role: user.role };
      await audit(req, 'LOGIN_SUCCESS', { userId: user.id });
      res.json({ token, user: { id: user.id, name: user.name, role: user.role, studentCode: user.student_code } });
    } catch (err) { next(err); }
  });

  app.get('/api/auth/me', requireAuth(), (req, res) => {
    const { id, name, role, studentCode } = req.user;
    res.json({ id, name, role, studentCode });
  });

  app.post('/api/auth/logout', requireAuth(), async (req, res) => {
    try {
      await revokeToken({ jti: req.user.jti, exp: req.user.exp, userId: req.user.id });
    } catch (err) {
      log('error', 'token_revoke_failed', { userId: req.user.id, message: err.message });
      await audit(req, 'LOGOUT', { outcome: 'failed', details: { tokenRevoked: false } });
      return res.status(503).json({ error: { code: 'REVOCATION_UNAVAILABLE', message: 'Could not end the session on the server. Please try again.' } });
    }
    await audit(req, 'LOGOUT', { details: { tokenRevoked: true } });
    res.status(204).end();
  });
});

useRevocationCheck();

if (require.main === module) service.start();
module.exports = { ...service, LOCKOUT, LOGIN_LIMIT };
