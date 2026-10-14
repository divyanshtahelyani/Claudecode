'use strict';
// HTTP server: JSON API + live updates (Server-Sent Events) + static pages. No external dependencies.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const store = require('./db');
const notify = require('./notify');

const { AppError } = store;
const PORT = Number(process.env.PORT) || 3000;
const RECEPTION_PIN = process.env.RECEPTION_PIN || '1234';
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_HOURS = 12;
const MAX_DAYS_AHEAD = 60;

// ---------- sessions (staff only; patients don't log in) ----------
const sessions = new Map(); // token -> { role: 'reception' | 'doctor', doctorId, expires }

function createSession(data) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { ...data, expires: Date.now() + SESSION_HOURS * 3600e3 });
  return token;
}
function sessionFrom(req) {
  const m = /^Bearer (\w+)$/.exec(req.headers.authorization || '');
  const s = m && sessions.get(m[1]);
  if (!s) return null;
  if (s.expires < Date.now()) { sessions.delete(m[1]); return null; }
  return { ...s, token: m[1] };
}
function pinMatches(given, expected) {
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- calling patients ----------
// Screens refresh every few seconds and pick up new calls from the call log (GET /api/calls).
function announceCall(a, { recall = false } = {}) {
  store.logCall(a.id, recall);
  if (!recall) {
    notify.patientCalled(a);
    const next = store.claimNextUpForNotice(a.doctor.id, a.date);
    if (next) notify.patientIsNext(next);
  }
}

// ---------- validation ----------
const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function cleanPhone(v) {
  const s = String(v ?? '').trim();
  const digits = s.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) throw new AppError(400, 'Please enter a valid phone number');
  return (s.startsWith('+') ? '+' : '') + digits;
}
function cleanDate(v) {
  const date = v ? String(v) : store.today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) throw new AppError(400, 'Invalid date');
  return date;
}
function bookingDate(v) {
  const date = cleanDate(v);
  const t = store.today();
  if (date < t) throw new AppError(400, 'You cannot book a date in the past');
  const days = (Date.parse(date) - Date.parse(t)) / 86400e3;
  if (days > MAX_DAYS_AHEAD) throw new AppError(400, `Bookings open up to ${MAX_DAYS_AHEAD} days ahead`);
  return date;
}
function patientFields(body) {
  const name = str(body.name, 80);
  if (!name) throw new AppError(400, 'Patient name is required');
  const age = body.age === '' || body.age == null ? null : Number(body.age);
  if (age !== null && (!Number.isInteger(age) || age < 0 || age > 130)) throw new AppError(400, 'Invalid age');
  const gender = ['M', 'F', 'O'].includes(body.gender) ? body.gender : null;
  return { name, phone: cleanPhone(body.phone), age, gender, reason: str(body.reason, 300), doctorId: Number(body.doctorId) };
}
const idParam = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new AppError(400, 'Invalid id');
  return n;
};

// ---------- auth guards ----------
function requireStaff(ctx) {
  if (!ctx.session) throw new AppError(401, 'Please log in');
  return ctx.session;
}
function requireReception(ctx) {
  const s = requireStaff(ctx);
  if (s.role !== 'reception') throw new AppError(403, 'Reception only');
  return s;
}
// Reception can act for any doctor; a doctor only for themselves.
function requireDoctorAccess(ctx, doctorId) {
  const s = requireStaff(ctx);
  if (s.role === 'doctor' && s.doctorId !== doctorId) throw new AppError(403, 'You can only manage your own queue');
  return s;
}

// ---------- routes ----------
const routes = [];
const route = (method, pattern, handler) =>
  routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), handler });

// Public: patients and the waiting-room display
route('GET', '/api/doctors', () => store.listDoctors());
route('GET', '/api/board', (ctx) => ({ date: cleanDate(ctx.query.get('date')), doctors: store.board(cleanDate(ctx.query.get('date'))) }));

// Without `after`, returns only the latest id so a screen that just opened doesn't replay old calls.
route('GET', '/api/calls', (ctx) => {
  const after = ctx.query.get('after');
  if (after === null) return { lastId: store.lastCallId(), calls: [] };
  const calls = store.callsAfter(Number(after) || 0);
  return { lastId: calls.length ? calls[calls.length - 1].id : Number(after) || 0, calls };
});

route('POST', '/api/book', (ctx) => {
  const p = patientFields(ctx.body);
  const a = store.createAppointment({ ...p, date: bookingDate(ctx.body.date), source: 'online' });
  return { id: a.id, token: a.token, date: a.date, status: a.status, doctor: a.doctor };
});

route('GET', '/api/my', (ctx) => store.appointmentsByPhone(cleanPhone(ctx.query.get('phone'))));

route('POST', '/api/my/:id/cancel', (ctx) => {
  const a = store.getAppointment(idParam(ctx.params.id));
  if (!a || a.patient.phone !== cleanPhone(ctx.body.phone)) throw new AppError(404, 'Appointment not found');
  if (!['booked', 'waiting'].includes(a.status)) throw new AppError(400, 'This appointment can no longer be cancelled');
  store.setStatus(a.id, 'cancelled');
  return { ok: true };
});

// Staff login
route('POST', '/api/login', (ctx) => {
  const { role, pin } = ctx.body;
  if (role === 'reception') {
    if (!pinMatches(pin, RECEPTION_PIN)) throw new AppError(401, 'Wrong PIN');
    return { token: createSession({ role }), role };
  }
  if (role === 'doctor') {
    const doctor = store.checkDoctorPin(Number(ctx.body.doctorId), pin);
    if (!doctor) throw new AppError(401, 'Wrong doctor or PIN');
    return { token: createSession({ role, doctorId: doctor.id }), role, doctor };
  }
  throw new AppError(400, 'Unknown role');
});
route('POST', '/api/logout', (ctx) => { if (ctx.session) sessions.delete(ctx.session.token); return { ok: true }; });
route('GET', '/api/me', (ctx) => {
  const s = requireStaff(ctx);
  return { role: s.role, doctor: s.doctorId ? store.getDoctor(s.doctorId) : null };
});

// Staff: queues
route('GET', '/api/appointments', (ctx) => {
  const s = requireStaff(ctx);
  const date = cleanDate(ctx.query.get('date'));
  const doctorId = s.role === 'doctor' ? s.doctorId : (Number(ctx.query.get('doctorId')) || undefined);
  return store.listAppointments({ date, doctorId });
});

route('POST', '/api/walkin', (ctx) => {
  requireReception(ctx);
  const p = patientFields(ctx.body);
  const a = store.createAppointment({ ...p, date: store.today(), source: 'walkin' });
  return a;
});

route('POST', '/api/appointments/:id/status', (ctx) => {
  const id = idParam(ctx.params.id);
  const current = store.getAppointment(id);
  if (!current) throw new AppError(404, 'Appointment not found');
  requireDoctorAccess(ctx, current.doctor.id);
  const a = store.setStatus(id, str(ctx.body.status, 20), { notes: ctx.body.notes == null ? undefined : str(ctx.body.notes, 2000) });
  return a;
});

route('POST', '/api/appointments/:id/notes', (ctx) => {
  const id = idParam(ctx.params.id);
  const current = store.getAppointment(id);
  if (!current) throw new AppError(404, 'Appointment not found');
  requireDoctorAccess(ctx, current.doctor.id);
  return store.saveNotes(id, str(ctx.body.notes, 2000));
});

route('POST', '/api/appointments/:id/call', (ctx) => {
  const id = idParam(ctx.params.id);
  const current = store.getAppointment(id);
  if (!current) throw new AppError(404, 'Appointment not found');
  requireDoctorAccess(ctx, current.doctor.id);
  const a = store.call(current.doctor.id, store.today(), id);
  announceCall(a);
  return a;
});

route('POST', '/api/doctors/:id/next', (ctx) => {
  const doctorId = idParam(ctx.params.id);
  requireDoctorAccess(ctx, doctorId);
  const a = store.call(doctorId, store.today());
  announceCall(a);
  return a;
});

route('POST', '/api/doctors/:id/recall', (ctx) => {
  const doctorId = idParam(ctx.params.id);
  requireDoctorAccess(ctx, doctorId);
  const a = store.currentPatient(doctorId);
  if (!a) throw new AppError(404, 'No patient is currently called');
  announceCall(a, { recall: true });
  return a;
});

route('GET', '/api/doctors/:id/current', (ctx) => {
  const doctorId = idParam(ctx.params.id);
  requireDoctorAccess(ctx, doctorId);
  return store.currentPatient(doctorId) || null;
});

// Reception: manage doctors
route('GET', '/api/admin/doctors', (ctx) => { requireReception(ctx); return store.listDoctors({ includeInactive: true }); });
route('POST', '/api/admin/doctors', (ctx) => {
  requireReception(ctx);
  const name = str(ctx.body.name, 80);
  const pin = str(ctx.body.pin, 12);
  if (!name) throw new AppError(400, 'Doctor name is required');
  if (!/^\d{4,12}$/.test(pin)) throw new AppError(400, 'PIN must be 4–12 digits');
  const d = store.addDoctor({
    name, pin, specialty: str(ctx.body.specialty, 80), room: str(ctx.body.room, 20),
    avgMinutes: Math.min(120, Math.max(1, Number(ctx.body.avgMinutes) || 10)),
  });
  return d;
});
route('PATCH', '/api/admin/doctors/:id', (ctx) => {
  requireReception(ctx);
  const b = ctx.body;
  if (b.pin != null && !/^\d{4,12}$/.test(String(b.pin))) throw new AppError(400, 'PIN must be 4–12 digits');
  const d = store.updateDoctor(idParam(ctx.params.id), {
    name: b.name != null ? str(b.name, 80) || undefined : undefined,
    specialty: b.specialty != null ? str(b.specialty, 80) : undefined,
    room: b.room != null ? str(b.room, 20) : undefined,
    pin: b.pin != null ? String(b.pin) : undefined,
    avgMinutes: b.avgMinutes != null ? Math.min(120, Math.max(1, Number(b.avgMinutes) || 10)) : undefined,
    active: b.active,
  });
  return d;
});

// ---------- plumbing ----------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024) { reject(new AppError(413, 'Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(v && typeof v === 'object' ? v : {});
      } catch { reject(new AppError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

// The three parts can live on their own web addresses, all sharing this server and database, e.g.
//   PATIENT_HOST=book.myclinic.com  DISPLAY_HOST=display.myclinic.com  STAFF_HOST=staff.myclinic.com
// On such an address "/" opens that part and the other parts' pages are hidden.
// Any other address (e.g. localhost) shows everything, with a menu at "/".
const SITES = {
  patient: { home: 'patient', pages: ['patient'] },
  display: { home: 'display', pages: ['display'] },
  staff: { home: 'staff', pages: ['staff', 'reception', 'doctor'] },
};
const hostList = (v) => String(v || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
const SITE_BY_HOST = new Map([
  ...hostList(process.env.PATIENT_HOST).map((h) => [h, SITES.patient]),
  ...hostList(process.env.DISPLAY_HOST).map((h) => [h, SITES.display]),
  ...hostList(process.env.STAFF_HOST).map((h) => [h, SITES.staff]),
]);
const ALL_PAGES = ['index', 'patient', 'display', 'staff', 'reception', 'doctor'];

function serveStatic(req, res, pathname) {
  const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
  const site = SITE_BY_HOST.get(host);
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = `/${site ? site.home : 'index'}`;
  if (!path.extname(rel)) rel += '.html'; // /doctor -> doctor.html
  const page = path.basename(rel, '.html');
  if (rel.endsWith('.html') && ALL_PAGES.includes(page) && site && !site.pages.includes(page)) {
    res.writeHead(302, { Location: '/' });
    return res.end();
  }
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;

  if (!pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    return serveStatic(req, res, pathname);
  }

  try {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(pathname);
      if (!m) continue;
      const ctx = {
        params: m.groups || {}, query: url.searchParams, session: sessionFrom(req),
        body: ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : {},
      };
      return sendJson(res, 200, await r.handler(ctx));
    }
    throw new AppError(404, 'Not found');
  } catch (err) {
    if (!(err instanceof AppError)) console.error(err);
    sendJson(res, err.status || 500, { error: err instanceof AppError ? err.message : 'Something went wrong' });
  }
});

if (require.main === module) {
  if (store.seedIfEmpty()) {
    console.log('Created demo doctors: Dr. Anjali Sharma (PIN 1111), Dr. Rahul Verma (PIN 2222)');
  }
  server.listen(PORT, () => {
    console.log(`Clinic queue running on http://localhost:${PORT}`);
    console.log(`  Patient website:  http://localhost:${PORT}/patient`);
    console.log(`  Display website:  http://localhost:${PORT}/display     (TV in the waiting room)`);
    console.log(`  Staff app:        http://localhost:${PORT}/staff       (reception PIN ${process.env.RECEPTION_PIN ? 'from RECEPTION_PIN' : '1234'})`);
    console.log(`  SMS:       ${notify.enabled ? 'Twilio enabled' : 'off (set TWILIO_* to enable)'}`);
  });
}

module.exports = { server, sessions };
