// Request validation with zod. Usage:
//   router.post('/', validate({ body: schema }), handler)
// Parsed, type-safe values are placed on req.valid.{body,query,params}.
const { z } = require('zod');
const { badRequest } = require('./errors');

function validate(schemas) {
  return (req, _res, next) => {
    req.valid = req.valid || {}; // allow several validate() steps on one route
    for (const part of ['params', 'query', 'body']) {
      if (!schemas[part]) continue;
      const result = schemas[part].safeParse(req[part] ?? {});
      if (!result.success) {
        const details = result.error.issues.map((i) => ({ field: [part, ...i.path].join('.'), message: i.message }));
        return next(badRequest('Invalid request', details));
      }
      req.valid[part] = result.data;
    }
    next();
  };
}

// Common building blocks
const id = z.coerce.number().int().positive();
const idParams = z.object({ id });

module.exports = { validate, z, id, idParams };
