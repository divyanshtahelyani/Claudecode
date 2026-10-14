'use strict';
// Optional SMS to patients through Twilio. Without credentials, messages are only logged,
// and patients are still called on the waiting-room display and on their own phone's browser.
const SID = process.env.TWILIO_ACCOUNT_SID;
const TOKEN = process.env.TWILIO_AUTH_TOKEN;
const FROM = process.env.TWILIO_FROM;
const CLINIC = process.env.CLINIC_NAME || 'the clinic';

const enabled = Boolean(SID && TOKEN && FROM);

async function sendSms(to, body) {
  if (!enabled) {
    console.log(`[sms disabled] to ${to}: ${body}`);
    return;
  }
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${SID}:${TOKEN}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: FROM, Body: body }),
    });
    if (!res.ok) console.error(`[sms] Twilio ${res.status}: ${await res.text()}`);
  } catch (err) {
    console.error('[sms] failed:', err.message);
  }
}

const roomText = (d) => (d.room ? `, room ${d.room}` : '');

function patientCalled(a) {
  return sendSms(a.patient.phone,
    `${CLINIC}: Token ${a.token}, it is your turn. Please go to ${a.doctor.name}${roomText(a.doctor)} now.`);
}

function patientIsNext(a) {
  return sendSms(a.patient.phone,
    `${CLINIC}: Token ${a.token}, you are next for ${a.doctor.name}. Please wait near ${a.doctor.room ? `room ${a.doctor.room}` : 'the cabin'}.`);
}

module.exports = { enabled, patientCalled, patientIsNext };
