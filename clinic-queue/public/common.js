// Helpers shared by every page.
const storage = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* private mode */ } },
};

async function api(path, { method = 'GET', body, auth } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const token = auth && storage.get(auth);
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || res.statusText);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Live updates from the server; EventSource reconnects on its own.
function listen(onEvent) {
  const es = new EventSource('/api/events');
  es.onmessage = (e) => { try { onEvent(JSON.parse(e.data)); } catch { /* ignore */ } };
  return es;
}

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(msg, kind = '') {
  let box = $('#toasts');
  if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.appendChild(box); }
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function todayStr() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function fmtDate(s) {
  if (s === todayStr()) return 'Today';
  return new Date(`${s}T00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}
function fmtTime(iso) {
  return iso ? new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '';
}
function minutesSince(iso) {
  return iso ? Math.max(0, Math.round((Date.now() - new Date(iso)) / 60000)) : 0;
}
const badge = (status) => `<span class="badge s-${esc(status)}">${esc(status)}</span>`;
const genderLabel = (g) => ({ M: 'Male', F: 'Female', O: 'Other' }[g] || '');

// ---- sound & speech for calling patients ----
let audioCtx;
function unlockAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch { /* no audio */ }
}
function chime() {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  [[880, 0], [660, 0.35]].forEach(([freq, at]) => {
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'sine';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t + at);
    g.gain.exponentialRampToValueAtTime(0.4, t + at + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.6);
    o.connect(g).connect(audioCtx.destination);
    o.start(t + at);
    o.stop(t + at + 0.65);
  });
}
function speak(text) {
  if (!('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 0.9;
  speechSynthesis.speak(u);
}
function callText(ev) {
  return `Token number ${ev.token}. Please go to ${ev.doctorName}${ev.room ? `, room ${ev.room}` : ''}.`;
}

function setupLogout(btn, key, after) {
  btn.addEventListener('click', async () => {
    try { await api('/api/logout', { method: 'POST', auth: key }); } catch { /* already gone */ }
    storage.del(key);
    after();
  });
}
