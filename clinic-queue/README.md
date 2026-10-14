# Clinic Queue

Appointment booking and token-calling software for a clinic. It has three sides, plus a waiting-room screen, all connected to one database and updating live:

| Side | URL | Who uses it | What they can do |
|---|---|---|---|
| **Patient** | `/patient` | Patients, on their phone | Book an appointment and get a token number; see "now serving", how many people are ahead and the approximate wait; get a full-screen alert, chime, vibration and voice message when their number is called; cancel. |
| **Reception** | `/reception` | Front desk (PIN login) | Register walk-ins (they get a token immediately), check in patients who booked online, call / re-queue / cancel anyone, see every doctor's queue, add doctors, deactivate them and reset their PINs. |
| **Doctor** | `/doctor` | Each doctor (own PIN) | See their own queue; **Call next patient**; **Finish & call next**; call again (re-announce); mark a no-show; write consultation notes; see who they've seen today. |
| **Display** | `/display` | TV in the waiting room | Big "Now serving" token for each doctor and the next tokens in line. Each call plays a chime and is **announced out loud** ("Token number 12. Please go to Dr. Sharma, room 1."). It shows token numbers only, never names. |

## How the queue works

```
 patient books online ──► booked ──(reception checks them in on arrival)──► waiting
 reception adds walk-in ─────────────────────────────────────────────────► waiting
 waiting ──(doctor/reception: Call next)──► called ──► done
                                              └──► no-show (skipped) ──(reception re-queues)──► waiting
```

* Tokens are numbered 1, 2, 3… per doctor, per day.
* **Call next** always takes the lowest waiting token. Online bookings are only called after they've been checked in, so people who haven't arrived are never called.
* Calling a new patient automatically finishes the one currently with the doctor.

## Run it

You need **Node.js 22.5 or newer**. There's nothing to install: it uses Node's built-in SQLite.

```bash
cd clinic-queue
npm start            # http://localhost:3000
npm test             # end-to-end API tests
```

On first run it creates two demo doctors:

| Login | PIN |
|---|---|
| Reception | `1234` |
| Dr. Anjali Sharma | `1111` |
| Dr. Rahul Verma | `2222` |

Change these before real use. Set `RECEPTION_PIN`, and change the doctor PINs in **Reception → Doctors → Reset PIN**.

To use it across the clinic, run it on one computer and open `http://<that-computer's-IP>:3000/...` on the reception PC, the doctors' PCs, the TV and patients' phones (same Wi-Fi). For patients to book from home, host it online (any Node host or VPS) behind HTTPS.

### Settings (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Web server port |
| `RECEPTION_PIN` | `1234` | Reception login PIN |
| `DB_PATH` | `./data/clinic.db` | SQLite database file (back this up) |
| `CLINIC_NAME` | `the clinic` | Used in SMS text |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | — | Optional. When set, patients get an SMS when they're called and when they're next in line. |

## Database

The SQLite file in `data/clinic.db` has three tables:

* `doctors`: name, specialty, room, hashed PIN, average minutes per patient, active flag
* `patients`: name, phone, age, gender (one row per name and phone, so family members can share a phone)
* `appointments`: patient, doctor, date, token, status, reason, doctor's notes, and the booked / checked-in / called / completed timestamps

## Files

```
server.js        HTTP server, JSON API, live updates (Server-Sent Events), login sessions
db.js            database schema and all queue logic
notify.js        optional SMS via Twilio
public/          the four screens (plain HTML/CSS/JS)
test/            end-to-end API tests
```

## Known limits / next steps

* Patients look up their tokens by phone number without an OTP. Add SMS OTP before going public.
* Staff sessions are kept in memory, so restarting the server logs staff out.
* Possible next steps: time-slot booking instead of same-day tokens, OTP login for patients, WhatsApp messages, printed token slips, prescriptions and billing, and reports.
