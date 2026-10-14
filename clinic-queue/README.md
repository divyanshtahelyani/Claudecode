# Clinic Queue

Appointment booking and token-calling software for a clinic. It has three parts, all connected to **one shared database**, and every screen **refreshes every 5 seconds** to show the latest data:

| Part | Type | Who uses it | What they can do |
|---|---|---|---|
| **Patient website** (`/patient`) | Public website | Patients, on their phone or computer | Book an appointment and get a token number; see "now serving", how many people are ahead and the approximate wait; get a full-screen alert, chime, vibration and voice message when their number is called; cancel. |
| **Staff app** (`/staff`) | Installable app (Windows, Mac, Android, iPhone) | **Reception** (PIN) and **doctors** (own PIN) | Reception: register walk-ins, check in online bookings, call / re-queue / cancel anyone, see every doctor's queue, add doctors, deactivate them and reset their PINs. Doctor: see their own queue, **Call next**, **Finish & call next**, call again, mark a no-show, write notes. |
| **Display website** (`/display`) | Website for the waiting-room TV | Waiting room | Big "Now serving" token for each doctor plus the next tokens in line. Each call plays a chime and is **announced out loud** ("Token number 12. Please go to Dr. Sharma, room 1."). It shows token numbers only, never names. |

```
  Patient website ─┐
  Staff app ───────┼──►  one server  ──►  one database (data/clinic.db)
  Display website ─┘     every screen asks for the latest data every 5 seconds
```

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
* Every call is saved in a call log. The display and the patient's phone check it every 5 seconds, so no announcement is missed.

## Try it on your computer

You need **Node.js 22.5 or newer**. There's nothing else to install: it uses Node's built-in SQLite.

```bash
cd clinic-queue
npm start            # then open http://localhost:3000
npm test             # automated tests
```

On first run it creates two demo doctors:

| Login | PIN |
|---|---|
| Reception | `1234` |
| Dr. Anjali Sharma | `1111` |
| Dr. Rahul Verma | `2222` |

Change these before real use. Set `RECEPTION_PIN`, and change the doctor PINs in **Reception → Doctors → Reset PIN**.

## Put it online (website + app + display)

The patient website must be reachable from the internet, so the server has to run on a hosting service. It runs as **one** server with **one** database; the three parts are just different web addresses pointing to it.

1. **Host the server** on any Node.js host that keeps files between restarts (for example Railway or Render with a persistent disk/volume, or a small VPS).
   * Start command: `npm start` (from the `clinic-queue` folder)
   * Set `DB_PATH` to a file on the persistent disk, e.g. `/data/clinic.db`, so appointments aren't lost on restart.
   * Set `RECEPTION_PIN`.
2. **Give each part its own address** (optional but recommended). Point three (sub)domains to the same server and tell it which is which:
   ```
   PATIENT_HOST=book.myclinic.com      → opens the patient website
   STAFF_HOST=staff.myclinic.com       → opens the staff app
   DISPLAY_HOST=display.myclinic.com   → opens the display
   ```
   Each address then opens only its own part. Without these settings, everything is under one address: `/patient`, `/staff`, `/display`.
3. **Install the staff app** on each reception and doctor device: open the staff address and
   * Windows / Mac (Chrome or Edge): click **Install app** (or the install icon in the address bar)
   * Android (Chrome): **⋮ → Install app**
   * iPhone / iPad (Safari): **Share → Add to Home Screen**

   It gets its own icon and window. HTTPS is required for installing, and all the hosts above provide it.
4. **Open the display address on the TV** (any smart-TV browser, or a laptop / TV stick plugged into it) and press **Start display** once to allow sound.

### Settings (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Web server port (hosts usually set this for you) |
| `DB_PATH` | `./data/clinic.db` | The database file. Keep it on persistent storage and back it up. |
| `RECEPTION_PIN` | `1234` | Reception login PIN |
| `PATIENT_HOST`, `STAFF_HOST`, `DISPLAY_HOST` | — | Web address for each part (see above). Comma-separate several. |
| `CLINIC_NAME` | `the clinic` | Used in SMS text |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | — | Optional. When set, patients get an SMS when they're called and when they're next in line. |

## Database

The SQLite database has four tables:

* `doctors`: name, specialty, room, hashed PIN, average minutes per patient, active flag
* `patients`: name, phone, age, gender (one row per name and phone, so family members can share a phone)
* `appointments`: patient, doctor, date, token, status, reason, doctor's notes, and the booked / checked-in / called / completed timestamps
* `calls`: every time a token is called or called again (used for announcements)

## Files

```
server.js            HTTP server, JSON API, staff logins, which address opens which part
db.js                database schema and all queue logic
notify.js            optional SMS via Twilio
public/patient.html  patient website
public/staff.html    staff app start page (+ reception.html, doctor.html, staff.webmanifest, sw.js, icons)
public/display.html  waiting-room display
public/common.js     shared helpers, including the 5-second refresh
test/                automated tests
```

## Known limits / next steps

* Patients look up their tokens by phone number without an OTP. Add SMS OTP before going public.
* Staff sessions are kept in memory, so restarting the server logs staff out.
* The staff app needs an internet connection to the server; it doesn't work offline.
* Possible next steps: an Android / iPhone store version of the staff app, time-slot booking, WhatsApp messages, printed token slips, prescriptions and billing, and reports.
