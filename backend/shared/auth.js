// Authentication + authorization middleware used by EVERY service.
// The JWT secret comes from Secrets Manager (esp/jwt). User id and role are
// taken only from the signed token, never from the URL or body.
const jwt = require('jsonwebtoken');
const { getSecret } = require('./secrets');
const { JWT, RESOURCES } = require('./config');
const { audit } = require('./audit');

async function jwtSecret() {
  const s = await getSecret(RESOURCES.secrets.jwt);
  return s.secret;
}

function deny(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

// 401 if the token is missing, invalid or expired.
function requireAuth() {
  return async (req, res, next) => {
    const header = req.get('authorization') || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) return deny(res, 401, 'UNAUTHENTICATED', 'Login required');
    try {
      const claims = jwt.verify(token, await jwtSecret(), { algorithms: ['HS256'], issuer: JWT.issuer, audience: JWT.audience });
      req.user = { id: Number(claims.sub), role: claims.role, name: claims.name, studentCode: claims.studentCode ?? null, jti: claims.jti, exp: claims.exp };
      if (requireAuth.isRevoked && await requireAuth.isRevoked(claims.jti)) {
        return deny(res, 401, 'TOKEN_REVOKED', 'Session has ended, please log in again');
      }
      next();
    } catch {
      audit(req, 'INVALID_TOKEN', { outcome: 'denied', target: req.originalUrl.split('?')[0] });
      return deny(res, 401, 'UNAUTHENTICATED', 'Invalid or expired token');
    }
  };
}
// Hook for token revocation (logout). The auth service may set this.
requireAuth.isRevoked = null;

// 403 if the logged-in user's role is not in the allowed list.
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return deny(res, 401, 'UNAUTHENTICATED', 'Login required');
    if (!roles.includes(req.user.role)) {
      audit(req, 'ACCESS_DENIED', { outcome: 'denied', target: `${req.method} ${req.originalUrl.split('?')[0]}`, details: { required: roles } });
      return deny(res, 403, 'FORBIDDEN', 'You do not have permission to do this');
    }
    next();
  };
}

async function signToken(user, jti) {
  return jwt.sign(
    { sub: String(user.id), role: user.role, name: user.name, studentCode: user.student_code ?? null, jti },
    await jwtSecret(),
    { algorithm: 'HS256', expiresIn: JWT.expiresIn, issuer: JWT.issuer, audience: JWT.audience },
  );
}

module.exports = { requireAuth, requireRole, signToken };
