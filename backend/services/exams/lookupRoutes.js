// /api/holidays and /api/users — lookups used by the exam forms (admin only).
const express = require('express');
const { requireAuth, requireRole } = require('../../shared/auth');
const { validate, z } = require('../../shared/validate');
const { query } = require('../../shared/db');
const { checkDate } = require('./holidays');

const holidayRouter = express.Router();
holidayRouter.use(requireAuth(), requireRole('admin'));
holidayRouter.get('/check', validate({ query: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD') }) }), async (req, res) => {
  const result = await checkDate(req.valid.query.date);
  if (!result.checked) return res.status(502).json({ error: { code: 'HOLIDAY_API_UNAVAILABLE', message: result.note } });
  res.json({ date: req.valid.query.date, ...result });
});

const userRouter = express.Router();
userRouter.use(requireAuth(), requireRole('admin'));
userRouter.get('/', validate({ query: z.object({ role: z.enum(['proctor', 'student']), search: z.string().trim().max(60).optional() }) }), async (req, res) => {
  const { role, search } = req.valid.query;
  const params = [role];
  let filter = '';
  if (search) { params.push(`%${search}%`); filter = 'AND (name ILIKE $2 OR student_code ILIKE $2 OR email ILIKE $2)'; }
  const { rows } = await query(`SELECT id, name, email, student_code FROM users WHERE role = $1 ${filter} ORDER BY name LIMIT 200`, params);
  res.json({ users: rows });
});

module.exports = { holidayRouter, userRouter };
