'use strict';
// Database layer: one SQLite file shared by the patient, reception and doctor sides.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'clinic.db');
if (DB_PATH !== ':memory:') fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS doctors (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  specialty   TEXT NOT NULL DEFAULT '',
  room        TEXT NOT NULL DEFAULT '',
  pin_hash    TEXT NOT NULL,
  avg_minutes INTEGER NOT NULL DEFAULT 10,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS patients (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  phone      TEXT NOT NULL,
  age        INTEGER,
  gender     TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (phone, name)
);
CREATE TABLE IF NOT EXISTS appointments (
  id             INTEGER PRIMARY KEY,
  patient_id     INTEGER NOT NULL REFERENCES patients(id),
  doctor_id      INTEGER NOT NULL REFERENCES doctors(id),
  date           TEXT NOT NULL,              -- YYYY-MM-DD
  token          INTEGER NOT NULL,           -- per doctor, per day
  status         TEXT NOT NULL,              -- booked | waiting | called | done | skipped | cancelled
  source         TEXT NOT NULL DEFAULT 'online', -- online | walkin
  reason         TEXT NOT NULL DEFAULT '',
  notes          TEXT NOT NULL DEFAULT '',
  notified_next  INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  checked_in_at  TEXT,
  called_at      TEXT,
  completed_at   TEXT,
  UNIQUE (doctor_id, date, token)
);
CREATE INDEX IF NOT EXISTS idx_appt_day ON appointments(date, doctor_id, status);
CREATE INDEX IF NOT EXISTS idx_patient_phone ON patients(phone);
`);

// ---------- helpers ----------
const ACTIVE = ['booked', 'waiting', 'called'];

// Which status changes are allowed. 'called' is reached via callNext/callSpecific only.
const TRANSITIONS = {
  booked: ['waiting', 'cancelled'],
  waiting: ['cancelled'],
  called: ['done', 'skipped', 'waiting'],
  skipped: ['waiting', 'cancelled'],
  done: [],
  cancelled: [],
};

class AppError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
const now = () => new Date().toISOString();

function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(String(pin), salt, 32).toString('hex')}`;
}
function verifyPin(pin, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const a = crypto.scryptSync(String(pin), salt, 32);
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

// ---------- doctors ----------
const publicDoctor = (d) => d && ({
  id: d.id, name: d.name, specialty: d.specialty, room: d.room,
  avgMinutes: d.avg_minutes, active: !!d.active,
});

function listDoctors({ includeInactive = false } = {}) {
  const sql = `SELECT * FROM doctors ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY name`;
  return db.prepare(sql).all().map(publicDoctor);
}
const getDoctorRow = (id) => db.prepare('SELECT * FROM doctors WHERE id = ?').get(id);
const getDoctor = (id) => publicDoctor(getDoctorRow(id));

function addDoctor({ name, specialty = '', room = '', pin, avgMinutes = 10 }) {
  const r = db.prepare(
    'INSERT INTO doctors (name, specialty, room, pin_hash, avg_minutes) VALUES (?, ?, ?, ?, ?)'
  ).run(name, specialty, room, hashPin(pin), avgMinutes);
  return getDoctor(Number(r.lastInsertRowid));
}

function updateDoctor(id, { name, specialty, room, pin, avgMinutes, active }) {
  const d = getDoctorRow(id);
  if (!d) throw new AppError(404, 'Doctor not found');
  db.prepare(`UPDATE doctors SET name = ?, specialty = ?, room = ?, pin_hash = ?, avg_minutes = ?, active = ?
              WHERE id = ?`).run(
    name ?? d.name, specialty ?? d.specialty, room ?? d.room,
    pin ? hashPin(pin) : d.pin_hash, avgMinutes ?? d.avg_minutes,
    active === undefined ? d.active : (active ? 1 : 0), id);
  return getDoctor(id);
}

function checkDoctorPin(id, pin) {
  const d = getDoctorRow(id);
  return d && d.active && verifyPin(pin, d.pin_hash) ? publicDoctor(d) : null;
}

// ---------- patients & appointments ----------
function upsertPatient({ name, phone, age = null, gender = null }) {
  const existing = db.prepare('SELECT * FROM patients WHERE phone = ? AND name = ? COLLATE NOCASE').get(phone, name);
  if (existing) {
    db.prepare('UPDATE patients SET age = COALESCE(?, age), gender = COALESCE(?, gender) WHERE id = ?')
      .run(age, gender, existing.id);
    return existing.id;
  }
  return Number(db.prepare('INSERT INTO patients (name, phone, age, gender) VALUES (?, ?, ?, ?)')
    .run(name, phone, age, gender).lastInsertRowid);
}

const APPT_SELECT = `
  SELECT a.*, p.name AS patient_name, p.phone, p.age, p.gender,
         d.name AS doctor_name, d.specialty, d.room, d.avg_minutes
  FROM appointments a
  JOIN patients p ON p.id = a.patient_id
  JOIN doctors d ON d.id = a.doctor_id`;

const shapeAppt = (r) => r && ({
  id: r.id, token: r.token, date: r.date, status: r.status, source: r.source,
  reason: r.reason, notes: r.notes,
  patient: { id: r.patient_id, name: r.patient_name, phone: r.phone, age: r.age, gender: r.gender },
  doctor: { id: r.doctor_id, name: r.doctor_name, specialty: r.specialty, room: r.room },
  createdAt: r.created_at, checkedInAt: r.checked_in_at, calledAt: r.called_at, completedAt: r.completed_at,
});

const getAppointment = (id) => shapeAppt(db.prepare(`${APPT_SELECT} WHERE a.id = ?`).get(id));

function createAppointment({ name, phone, age, gender, doctorId, date, reason = '', source }) {
  const doctor = getDoctorRow(doctorId);
  if (!doctor || !doctor.active) throw new AppError(400, 'Please choose an available doctor');
  return tx(() => {
    const patientId = upsertPatient({ name, phone, age, gender });
    const dup = db.prepare(`SELECT token FROM appointments WHERE patient_id = ? AND doctor_id = ? AND date = ?
                            AND status IN ('booked','waiting','called')`).get(patientId, doctorId, date);
    if (dup) throw new AppError(409, `${name} already has token ${dup.token} with ${doctor.name} on ${date}`);
    const { next } = db.prepare('SELECT COALESCE(MAX(token), 0) + 1 AS next FROM appointments WHERE doctor_id = ? AND date = ?')
      .get(doctorId, date);
    const walkin = source === 'walkin';
    const r = db.prepare(`INSERT INTO appointments (patient_id, doctor_id, date, token, status, source, reason, checked_in_at)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(patientId, doctorId, date, next, walkin ? 'waiting' : 'booked', walkin ? 'walkin' : 'online',
        reason, walkin ? now() : null);
    return getAppointment(Number(r.lastInsertRowid));
  });
}

function listAppointments({ date = today(), doctorId } = {}) {
  const rows = doctorId
    ? db.prepare(`${APPT_SELECT} WHERE a.date = ? AND a.doctor_id = ? ORDER BY a.token`).all(date, doctorId)
    : db.prepare(`${APPT_SELECT} WHERE a.date = ? ORDER BY d.name, a.token`).all(date);
  return rows.map(shapeAppt);
}

// Patients waiting (or booked) with a lower token for the same doctor & day.
function peopleAhead(a) {
  return db.prepare(`SELECT COUNT(*) AS n FROM appointments
                     WHERE doctor_id = ? AND date = ? AND token < ? AND status IN ('waiting','booked')`)
    .get(a.doctor.id, a.date, a.token).n;
}
function nowServing(doctorId, date) {
  const r = db.prepare(`SELECT token FROM appointments WHERE doctor_id = ? AND date = ? AND status = 'called'
                        ORDER BY called_at DESC LIMIT 1`).get(doctorId, date);
  return r ? r.token : null;
}

// What a patient sees when they look up their phone number.
function appointmentsByPhone(phone) {
  const rows = db.prepare(`${APPT_SELECT} WHERE p.phone = ? AND a.date >= ? ORDER BY a.date, a.token`)
    .all(phone, today());
  return rows.map((r) => {
    const a = shapeAppt(r);
    const ahead = ['booked', 'waiting'].includes(a.status) ? peopleAhead(a) : 0;
    return {
      id: a.id, token: a.token, date: a.date, status: a.status, reason: a.reason,
      patientName: a.patient.name, doctor: a.doctor,
      ahead, estimatedWaitMinutes: ahead * r.avg_minutes,
      nowServing: nowServing(a.doctor.id, a.date),
    };
  });
}

function setStatus(id, status, { notes } = {}) {
  const a = getAppointment(id);
  if (!a) throw new AppError(404, 'Appointment not found');
  if (!(TRANSITIONS[a.status] || []).includes(status)) {
    throw new AppError(400, `Cannot change a ${a.status} appointment to ${status}`);
  }
  if (status === 'waiting') {
    // Check-in, or re-queue after a skip: keep the original check-in time if there is one.
    db.prepare(`UPDATE appointments SET status = 'waiting', completed_at = NULL,
                checked_in_at = COALESCE(checked_in_at, ?) WHERE id = ?`).run(now(), id);
  } else if (status === 'done' || status === 'skipped') {
    db.prepare('UPDATE appointments SET status = ?, notes = COALESCE(?, notes), completed_at = ? WHERE id = ?')
      .run(status, notes ?? null, now(), id);
  } else {
    db.prepare('UPDATE appointments SET status = ? WHERE id = ?').run(status, id);
  }
  return getAppointment(id);
}

function saveNotes(id, notes) {
  db.prepare('UPDATE appointments SET notes = ? WHERE id = ?').run(notes, id);
  return getAppointment(id);
}

// Finish whoever is currently with the doctor, then call the given (or next waiting) patient.
function call(doctorId, date, appointmentId = null) {
  return tx(() => {
    let target;
    if (appointmentId) {
      target = db.prepare(`SELECT * FROM appointments WHERE id = ? AND doctor_id = ?`).get(appointmentId, doctorId);
      if (!target) throw new AppError(404, 'Appointment not found for this doctor');
      if (target.date !== date) throw new AppError(400, "Only today's patients can be called");
      if (!['waiting', 'skipped', 'booked'].includes(target.status)) {
        throw new AppError(400, `Cannot call a ${target.status} appointment`);
      }
    } else {
      target = db.prepare(`SELECT * FROM appointments WHERE doctor_id = ? AND date = ? AND status = 'waiting'
                           ORDER BY token LIMIT 1`).get(doctorId, date);
      if (!target) throw new AppError(404, 'No patients are waiting');
    }
    db.prepare(`UPDATE appointments SET status = 'done', completed_at = ?
                WHERE doctor_id = ? AND date = ? AND status = 'called'`).run(now(), doctorId, target.date);
    db.prepare(`UPDATE appointments SET status = 'called', called_at = ?, checked_in_at = COALESCE(checked_in_at, ?)
                WHERE id = ?`).run(now(), now(), target.id);
    return getAppointment(target.id);
  });
}

function currentPatient(doctorId, date = today()) {
  return shapeAppt(db.prepare(`${APPT_SELECT} WHERE a.doctor_id = ? AND a.date = ? AND a.status = 'called'
                               ORDER BY a.called_at DESC LIMIT 1`).get(doctorId, date));
}

// The first waiting patient who hasn't yet been told they're next (for the optional SMS).
function claimNextUpForNotice(doctorId, date) {
  const r = db.prepare(`SELECT id FROM appointments WHERE doctor_id = ? AND date = ? AND status = 'waiting'
                        ORDER BY token LIMIT 1`).get(doctorId, date);
  if (!r) return null;
  const changed = db.prepare('UPDATE appointments SET notified_next = 1 WHERE id = ? AND notified_next = 0').run(r.id).changes;
  return changed ? getAppointment(r.id) : null;
}

// Public waiting-room board: token numbers only, never names.
function board(date = today()) {
  return listDoctors().map((d) => {
    const counts = Object.fromEntries(db.prepare(`SELECT status, COUNT(*) AS n FROM appointments
      WHERE doctor_id = ? AND date = ? GROUP BY status`).all(d.id, date).map((r) => [r.status, r.n]));
    const upNext = db.prepare(`SELECT token FROM appointments WHERE doctor_id = ? AND date = ? AND status = 'waiting'
                               ORDER BY token LIMIT 5`).all(d.id, date).map((r) => r.token);
    return {
      doctor: d, nowServing: nowServing(d.id, date), upNext,
      waiting: counts.waiting || 0, booked: counts.booked || 0, done: counts.done || 0,
    };
  });
}

// First run: create two demo doctors so the app is usable immediately.
function seedIfEmpty() {
  if (db.prepare('SELECT COUNT(*) AS n FROM doctors').get().n > 0) return false;
  addDoctor({ name: 'Dr. Anjali Sharma', specialty: 'General Physician', room: '1', pin: '1111' });
  addDoctor({ name: 'Dr. Rahul Verma', specialty: 'Paediatrics', room: '2', pin: '2222' });
  return true;
}

module.exports = {
  db, AppError, today, verifyPin,
  listDoctors, getDoctor, addDoctor, updateDoctor, checkDoctorPin,
  createAppointment, listAppointments, getAppointment, appointmentsByPhone,
  setStatus, saveNotes, call, currentPatient, claimNextUpForNotice, board, seedIfEmpty,
};
