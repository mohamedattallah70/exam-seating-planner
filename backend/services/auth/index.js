// Auth service (shared identity). Owner: Mohamed Rishi (auth lead).
// Basic login / me / logout provided in the foundation so every service can
// be tested; hardening (lockout, token revocation in DynamoDB, Turnstile,
// login rate limit) is added by the owner.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { createService } = require('../../shared/createService');
const { query } = require('../../shared/db');
const { requireAuth, signToken } = require('../../shared/auth');
const { validate, z } = require('../../shared/validate');
const { audit } = require('../../shared/audit');
const { log } = require('../../shared/logger');

const loginSchema = z.object({
  identifier: z.string().trim().min(3).max(120), // email or student code
  password: z.string().min(1).max(72),
});

// Used when the identifier is unknown so response time does not reveal
// whether an account exists.
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10);

const service = createService('auth', (app) => {
  app.post('/api/auth/login', validate({ body: loginSchema }), async (req, res, next) => {
    try {
      const { identifier, password } = req.valid.body;
      const { rows } = await query(
        'SELECT id, name, email, student_code, role, password_hash FROM users WHERE lower(email) = lower($1) OR student_code = upper($1)',
        [identifier],
      );
      const user = rows[0];
      const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
      if (!user || !ok) {
        log('warn', 'login_failed', { ip: req.ip, userId: user?.id ?? null });
        await audit(req, 'LOGIN_FAILED', { outcome: 'denied', userId: user?.id ?? null, details: { reason: 'bad_credentials' } });
        return res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Incorrect email/student code or password' } });
      }
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
    await audit(req, 'LOGOUT');
    res.status(204).end();
  });
});

if (require.main === module) service.start();
module.exports = service;
