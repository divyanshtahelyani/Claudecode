'use strict';
process.env.DB_PATH = ':memory:';
process.env.RECEPTION_PIN = '9999';
process.env.PATIENT_HOST = 'book.clinic.test';
process.env.STAFF_HOST = 'staff.clinic.test';

const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../db');
const { server } = require('../server');

let base;
const call = async (method, path, body, token) => {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
};

test.before(async () => {
  store.seedIfEmpty();
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

test('full patient → reception → doctor flow', async () => {
  const { data: doctors } = await call('GET', '/api/doctors');
  assert.equal(doctors.length, 2);
  const doc = doctors.find((d) => d.name.includes('Sharma'));

  // Patient books online -> booked, token 1
  const b1 = await call('POST', '/api/book', { name: 'Asha', phone: '98765 43210', doctorId: doc.id, date: store.today() });
  assert.equal(b1.status, 200);
  assert.equal(b1.data.token, 1);
  assert.equal(b1.data.status, 'booked');

  // Duplicate booking rejected
  const dup = await call('POST', '/api/book', { name: 'Asha', phone: '9876543210', doctorId: doc.id, date: store.today() });
  assert.equal(dup.status, 409);

  // Past date rejected
  assert.equal((await call('POST', '/api/book', { name: 'X', phone: '9876543211', doctorId: doc.id, date: '2000-01-01' })).status, 400);

  // Staff endpoints need login
  assert.equal((await call('GET', '/api/appointments')).status, 401);
  assert.equal((await call('POST', '/api/login', { role: 'reception', pin: '0000' })).status, 401);
  const rec = (await call('POST', '/api/login', { role: 'reception', pin: '9999' })).data.token;

  // Reception registers a walk-in -> waiting, token 2
  const w = await call('POST', '/api/walkin', { name: 'Bilal', phone: '9123456780', age: 34, gender: 'M', doctorId: doc.id }, rec);
  assert.equal(w.data.token, 2);
  assert.equal(w.data.status, 'waiting');

  // Patient view: Asha (booked) has nobody ahead
  const mine = (await call('GET', '/api/my?phone=9876543210')).data;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].ahead, 0);

  // Doctor logs in; wrong PIN rejected; cannot touch another doctor's queue
  assert.equal((await call('POST', '/api/login', { role: 'doctor', doctorId: doc.id, pin: '2222' })).status, 401);
  const dr = (await call('POST', '/api/login', { role: 'doctor', doctorId: doc.id, pin: '1111' })).data.token;
  const other = doctors.find((d) => d.id !== doc.id);
  assert.equal((await call('POST', `/api/doctors/${other.id}/next`, {}, dr)).status, 403);

  // A screen that opens now gets the latest call id, so old calls aren't replayed
  const { lastId: startId } = (await call('GET', '/api/calls')).data;

  // Call next: Asha is only booked (not checked in), so Bilal (waiting) is called
  const n1 = await call('POST', `/api/doctors/${doc.id}/next`, {}, dr);
  assert.equal(n1.data.token, 2);
  assert.equal(n1.data.status, 'called');

  // Reception checks Asha in; doctor finishes Bilal & calls next -> Asha
  await call('POST', `/api/appointments/${b1.data.id}/status`, { status: 'waiting' }, rec);
  await call('POST', `/api/appointments/${n1.data.id}/notes`, { notes: 'Paracetamol 500mg' }, dr);
  const n2 = await call('POST', `/api/doctors/${doc.id}/next`, {}, dr);
  assert.equal(n2.data.token, 1);

  // Both calls are in the call log (token and doctor only, no names); "call again" adds another entry
  await call('POST', `/api/doctors/${doc.id}/recall`, {}, dr);
  const log = (await call('GET', `/api/calls?after=${startId}`)).data;
  assert.deepEqual(log.calls.map((c) => [c.token, c.recall]), [[2, false], [1, false], [1, true]]);
  assert.equal(log.calls[0].doctorName, doc.name);
  assert.ok(!JSON.stringify(log).includes('Bilal'));
  assert.deepEqual((await call('GET', `/api/calls?after=${log.lastId}`)).data, { lastId: log.lastId, calls: [] });

  const list = (await call('GET', '/api/appointments', undefined, dr)).data;
  const bilal = list.find((a) => a.token === 2);
  assert.equal(bilal.status, 'done');
  assert.equal(bilal.notes, 'Paracetamol 500mg');

  // Public board shows token only
  const board = (await call('GET', '/api/board')).data.doctors.find((b) => b.doctor.id === doc.id);
  assert.equal(board.nowServing, 1);
  assert.ok(!JSON.stringify(board).includes('Asha'));

  // Invalid transition rejected; queue empty -> 404
  assert.equal((await call('POST', `/api/appointments/${bilal.id}/status`, { status: 'waiting' }, rec)).status, 400);
  await call('POST', `/api/appointments/${n2.data.id}/status`, { status: 'skipped' }, dr);
  assert.equal((await call('POST', `/api/doctors/${doc.id}/next`, {}, dr)).status, 404);

  // Reception re-queues the no-show and adds a doctor
  assert.equal((await call('POST', `/api/appointments/${n2.data.id}/status`, { status: 'waiting' }, rec)).data.status, 'waiting');
  assert.equal((await call('POST', '/api/admin/doctors', { name: 'Dr. New', pin: '12' }, rec)).status, 400);
  assert.equal((await call('POST', '/api/admin/doctors', { name: 'Dr. New', pin: '5555', room: '3' }, rec)).status, 200);
  assert.equal((await call('POST', '/api/admin/doctors', { name: 'Dr. Nope', pin: '5555' }, dr)).status, 403);
});

test('patient can cancel only with matching phone', async () => {
  const doc = (await call('GET', '/api/doctors')).data[0];
  const b = (await call('POST', '/api/book', { name: 'Chen', phone: '+447700900123', doctorId: doc.id, date: store.today() })).data;
  assert.equal((await call('POST', `/api/my/${b.id}/cancel`, { phone: '+447700900999' })).status, 404);
  assert.equal((await call('POST', `/api/my/${b.id}/cancel`, { phone: '+44 7700 900123' })).status, 200);
});

test('static pages are served and traversal is blocked', async () => {
  for (const p of ['/', '/patient', '/staff', '/reception', '/doctor', '/display', '/common.js', '/staff.webmanifest', '/sw.js', '/icon-512.png']) {
    assert.equal((await fetch(base + p)).status, 200, p);
  }
  assert.notEqual((await fetch(base + '/%2e%2e/server.js')).status, 200);
});

test('each web address only opens its own part', async () => {
  const get = (host, p) => new Promise((resolve) => {
    require('node:http').get({ host: '127.0.0.1', port: server.address().port, path: p, headers: { Host: host } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location, body }));
    });
  });
  assert.match((await get('book.clinic.test', '/')).body, /<title>Patient/);
  assert.equal((await get('book.clinic.test', '/reception')).status, 302);
  assert.equal((await get('book.clinic.test', '/display')).status, 302);
  assert.match((await get('staff.clinic.test', '/')).body, /<title>Clinic Staff/);
  assert.equal((await get('staff.clinic.test', '/doctor')).status, 200);
  assert.equal((await get('staff.clinic.test', '/patient')).status, 302);
  assert.equal((await get('staff.clinic.test', '/staff.webmanifest')).status, 200);
  // The API works on every address (one shared database)
  assert.equal((await get('book.clinic.test', '/api/doctors')).status, 200);
});
