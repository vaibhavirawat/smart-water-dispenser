const express = require('express');
const auth = require('../../auth');
const { HttpError, wrap } = require('../http');
const complaints = require('../services/complaints');

const r = express.Router();
const limiter = auth.makeLimiter(+(process.env.COMPLAINT_LIMIT || 10), 3600e3); // per person, so nobody can flood the caretakers

// Any signed-in person can report a problem with any dispenser.
r.post('/api/complaints', auth.requireAuth, wrap(async (req, res) => {
  if (limiter.blocked(req.user.username)) throw new HttpError(429, 'You have sent a lot of complaints in the last hour. Please wait a little.');
  const b = req.body || {};
  const c = await complaints.create(req.user, { dispenser_id: Number(b.dispenser_id), category: b.category, description: b.description });
  limiter.record(req.user.username);
  res.status(201).json(c);
}));

// Role-scoped: admins see all, caretakers their dispensers' complaints, technicians their jobs, users their own.
r.get('/api/complaints', auth.requireAuth, wrap(async (req, res) => {
  const status = req.query.status;
  if (status && !['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'].includes(status)) throw new HttpError(400, 'Unknown status');
  res.json(await complaints.list(req.user, { status }));
}));

r.get('/api/complaints/:id', auth.requireAuth, wrap(async (req, res) => {
  const c = await complaints.getVisible(req.user, req.params.id);
  res.json({ ...c, events: await complaints.timeline(c.id) });
}));

// Caretaker (or admin) hands the job to a technician.
r.post('/api/complaints/:id/assign', auth.requireRole('caretaker'), wrap(async (req, res) =>
  res.json(await complaints.assign(req.user, req.params.id, req.body?.technician))));

// IN_PROGRESS / RESOLVED (technician or caretaker), CLOSED (caretaker), OPEN = reopen (reporter or caretaker).
r.post('/api/complaints/:id/status', auth.requireAuth, wrap(async (req, res) =>
  res.json(await complaints.setStatus(req.user, req.params.id, req.body?.status, req.body?.note))));

module.exports = r;
