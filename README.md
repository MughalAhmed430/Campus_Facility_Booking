# Smart Campus Facility Booking & Management System

A web application for discovering and booking classrooms, laboratories and meeting rooms at Kyungdong University, with an administrator area for managing facilities, booking requests and users. Built for the Web Application Development course.

> **Status:** complete for submission: every page in the plan is built. A walk-through for presenting it is in [`docs/demo-script.md`](docs/demo-script.md). Built: the Express server, PostgreSQL connection, security middleware, error handling, health check, schema and seed data, registration, login/logout with server-side sessions, role-based access control, the shared frontend foundation (design tokens, components, app shell, API client), the home, sign-in and registration pages, the facility API with search and filters, the Facilities and Facility details pages, requesting a booking from the Facility details page, the My bookings page with cancellation, the administrators' Requests page (approve and reject, in transactions), the booking schedule (a week per facility, every facility's day for administrators, and a "Free at" filter), the administrators' Bookings page (every booking, with filters and pages, and cancelling an approved booking with a reason), facility management (create, edit, close, deactivate; bookings are left in place and counted), user management (activate and deactivate accounts), an automated test suite, a concurrency check against real PostgreSQL, in-app notifications for students (an approval, a rejection or an administrator's cancellation writes one in the same transaction as the change), key-figure reports for administrators (requests, approval rate, hours booked and an estimated utilization for a date range), and a dashboard for each role as the start page after signing in.

## Tech stack

| Layer    | Technology                                                       |
| -------- | ---------------------------------------------------------------- |
| Frontend | HTML5, CSS3, vanilla JavaScript (ES modules), Fetch API           |
| Backend  | Node.js, Express 5, REST/JSON API                                 |
| Database | PostgreSQL, accessed with the `pg` package and parameterized SQL  |
| Auth     | Own code: `bcryptjs` password hashing, sessions in PostgreSQL, `cookie-parser` |
| Security | `helmet` (security headers), `cors` (allow-list), `express-rate-limit` |
| Dev      | `nodemon` (auto-restart), `dotenv` (configuration)                |
| Tests    | Node's built-in test runner (`node --test`), PGlite (in-memory PostgreSQL); Playwright and axe-core for browser checks in Edge |

## Prerequisites (Windows 11)

- **Node.js 22 LTS or newer.** Check with `node -v`.
- **A PostgreSQL database**, local or hosted, and its connection string.
- Git and VS Code (recommended).

## Setup

Run these in PowerShell from the project folder:

```powershell
npm install
Copy-Item server\.env.example server\.env
code server\.env
```

In `server\.env`, set `DATABASE_URL` to your PostgreSQL connection string. `server\.env` is git-ignored. Never commit it.

| Variable       | Required | Default       | Purpose                                                                |
| -------------- | -------- | ------------- | ---------------------------------------------------------------------- |
| `DATABASE_URL` | yes      | none          | PostgreSQL connection string                                           |
| `PORT`         | no       | `3000`        | Port the server listens on                                             |
| `NODE_ENV`     | no       | `development` | `development` or `production`                                          |
| `CORS_ORIGINS` | no       | empty         | Comma-separated extra origins allowed to call the API with the session cookie (e.g. Live Server). See [Running the frontend on another port](#running-the-frontend-on-another-port-live-server) |
| `STORAGE_DIR`  | no       | `server/storage` | Folder for uploaded profile photos. Keep it outside `client/`: files are only served through the API, which checks who is asking. It is created on the first upload and is not in Git |

The server checks these at startup and exits with a clear message if one is missing or invalid. If the database cannot be reached, it says so and names `DATABASE_URL`.

`npm install` may report 2 moderate vulnerabilities. Both are in `minimatch`, used only by `nodemon` (the development auto-restart tool); nothing the running application loads is affected. `npm audit fix --force` would replace `nodemon` with a breaking version, so it is left as it is.

## Database

Create the tables, then load the sample data. These commands use `DATABASE_URL` from `server\.env`, so you don't need `psql`:

```powershell
npm run db:schema   # WARNING: drops and recreates all application tables (all data is lost)
npm run db:seed     # loads sample data into the empty tables
npm run db:reset    # both of the above, in order
```

Each file runs in a single transaction: if anything fails, the database is left unchanged.

**Demo accounts** (sample data only; never use these on a real deployment):

| Role    | Email                                                                  | Password       |
| ------- | ---------------------------------------------------------------------- | -------------- |
| Admin   | `admin@kdu.example`                                                    | `Admin@2026`   |
| Student | `minjun.kim@`, `seoyeon.lee@`, `jiho.park@`, `yuna.choi@` `kdu.example` | `Student@2026` |

Sample booking dates are relative to the day you run the seed (Korea time). For rooms closed at weekends, a date that would fall on Saturday or Sunday moves to the nearest weekday. Re-run `npm run db:reset` to refresh them.

### Verify the double-booking guard

Run this in the Neon SQL Editor (or `psql`). It tries to add an **approved** booking that overlaps an existing approved booking by one hour:

```sql
INSERT INTO bookings (user_id, facility_id, start_time, end_time, attendees, purpose, status, decided_by, decided_at)
SELECT user_id, facility_id, start_time + interval '1 hour', end_time + interval '1 hour',
       2, 'Overlap test', 'approved', decided_by, now()
FROM bookings
WHERE status = 'approved'
ORDER BY start_time
LIMIT 1;
```

Expected: `ERROR: conflicting key value violates exclusion constraint "bookings_no_overlap"` (SQLSTATE `23P01`), and no row is inserted.

Optional, run one statement at a time: the same slot is accepted as a *pending* request, approving it fails with the same error, then you delete the test row.

```sql
INSERT INTO bookings (user_id, facility_id, start_time, end_time, attendees, purpose)
SELECT user_id, facility_id, start_time + interval '1 hour', end_time + interval '1 hour', 2, 'Overlap test'
FROM bookings
WHERE status = 'approved'
ORDER BY start_time
LIMIT 1
RETURNING id, status;

UPDATE bookings
SET status = 'approved', decided_by = (SELECT id FROM users WHERE role = 'admin' LIMIT 1), decided_at = now()
WHERE purpose = 'Overlap test';

DELETE FROM bookings WHERE purpose = 'Overlap test';
```

### Prove it under real concurrency

```powershell
npm run verify:concurrency
```

The automated tests run on PGlite, which has a single connection, so they cannot show two transactions running at the same moment. This script does that on the real PostgreSQL in `server\.env`, using separate connections. It adds a temporary room, two temporary accounts and about 12 requests (500+ days ahead), runs the checks, then deletes everything it added, also when a check fails. Nothing else in the database is changed. It takes 10 to 30 seconds.

Before releasing the competing operations, each check confirms in `pg_stat_activity` that all of them are blocked on a lock at the same moment. So a pass means they really ran against each other, not one after another by luck.

| Check | Expected |
| ----- | -------- |
| Two connections approve two overlapping requests directly in SQL, with no application code | The second waits for the first; when the first commits, the second fails with `23P01` from `bookings_no_overlap` |
| Six overlapping requests approved through the application at the same moment | One approved, five rejected automatically, five `409` responses |
| One request approved twice at the same moment | One succeeds, one gets `409 BOOKING_NOT_PENDING` |
| An approval and a rejection of one request at the same moment | Exactly one decision is stored: the one that succeeded |
| An approval and the student's cancellation at the same moment | The cancellation stands either way |
| Afterwards | No two approved bookings overlap |

Last run on Neon (10 November 2026): 13 checks passed, 0 failed, and no temporary data was left behind.

## Run

```powershell
npm run dev    # development: restarts when files in server\src change (type rs + Enter to restart manually)
npm start      # plain node, no auto-restart
```

Open <http://localhost:3000>. Stop the server with `Ctrl+C`.

nodemon does not watch `server\.env`. After editing it, type `rs` + Enter or restart the server.

## Check the server and database

```powershell
curl.exe -s http://localhost:3000/api/health
```

- **200**: `{"success":true,"data":{"status":"ok","database":"connected",...}}`
- **503**: `{"success":false,"error":{"code":"DATABASE_UNAVAILABLE",...}}`. The server is running but cannot reach PostgreSQL. The terminal running the server shows the reason.

The server also prints `Database connected` or `Database connection failed: ...` right after it starts.

## API response format

Every API response uses the same JSON shape:

```json
{ "success": true,  "data": { } }
{ "success": false, "error": { "code": "NOT_FOUND", "message": "The requested resource was not found." } }
```

Error messages are safe to show to users. Stack traces and database errors are only logged on the server.

Validation errors list every problem field in `details`, so a form can highlight all of them at once:

```json
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "Some fields are missing or invalid.",
  "details": { "email": "Enter a valid email address.", "password": "Password must be at least 8 characters." } } }
```

## Authentication

Authentication is our own code (no hosted auth product), built on server-side sessions:

1. On login, the server checks the password with bcrypt, creates a random 256-bit token, stores its SHA-256 hash in the `sessions` table, and sends the token in an `httpOnly` cookie named `sid`.
2. On every protected request, the server hashes the cookie value and looks it up, joined to `users`. A session only counts if it hasn't expired and the account is still active.
3. Logout deletes the row, so the token stops working everywhere at once. Deactivating a user stops all their sessions on their next request.

Sessions last 8 hours from login and survive server restarts, because they live in PostgreSQL rather than server memory.

| Method | Path                 | Access        | Result                                                                  |
| ------ | -------------------- | ------------- | ----------------------------------------------------------------------- |
| POST   | `/api/auth/register` | public        | `201` `{ user }`. Body: `fullName`, `email`, `password`, optional `studentNumber` |
| POST   | `/api/auth/login`    | public        | `200` `{ user, sessionExpiresAt }` and sets the `sid` cookie            |
| POST   | `/api/auth/logout`   | anyone        | `200` `{ loggedOut: true }`. Deletes the session and clears the cookie  |
| GET    | `/api/auth/me`       | logged in     | `200` `{ user }`: who is logged in (use this on every page load)        |

- New accounts are always `student`. Sending a `role` field at registration is rejected.
- Passwords must be 8–72 bytes. bcrypt ignores anything past 72 bytes, so longer passwords are rejected rather than silently cut.
- A wrong password, an unknown email and a deactivated account all get the same `401 INVALID_CREDENTIALS` "Invalid email or password." They also take about the same time, so the response doesn't reveal which emails have accounts.
- `401`: not logged in, or the session has ended. `403`: logged in, but the wrong role.
- Rate limits: 10 failed logins per 15 minutes, and 10 registrations per hour, per IP address. Over the limit, the server answers `429`.

### Profile API

Any signed-in user (student or administrator), for their own account only. Signing in itself is unchanged.

| Method | Path                    | Result |
| ------ | ----------------------- | ------ |
| GET    | `/api/profile`          | `200` `{ user }`: `id`, `fullName`, `email`, `role`, `studentNumber`, `hasPhoto`, `createdAt` |
| PATCH  | `/api/profile`          | Body `{ "fullName": "…" }` (1 to 100 characters). `200` `{ user }`. The email (the sign-in name), the student number and the role cannot be changed here; anything else in the body is ignored |
| POST   | `/api/profile/password` | Body `{ "currentPassword", "newPassword" }`. `200` `{ otherSessionsEnded }`. The new password follows the registration rules and must differ from the current one. `400 WRONG_PASSWORD` (under `currentPassword`) if the current password is wrong. This session stays signed in; the user's other sessions are deleted. 10 failed attempts per 15 minutes per IP address, then `429` |
| PUT    | `/api/profile/photo`    | `multipart/form-data` with one file in the field `photo`: JPEG, PNG or WebP, at most 2 MB. `200` `{ user }`. The type is read from the file's first bytes, not its name or the type the browser claims, so a renamed program is refused with `400` |
| DELETE | `/api/profile/photo`    | `200` `{ user }`. Removes the photo and its file |
| GET    | `/api/profile/photo`    | The signed-in user's photo, or `404 PHOTO_NOT_FOUND` |
| GET    | `/api/users/:id/photo`  | That user's photo, for the user themselves or an administrator. Anyone else gets `404`, the same as for an account with no photo |

Photos are saved in `STORAGE_DIR/avatars/` under a random name the server chooses (`users.photo_file`); the uploader's file name is never used. `npm run db:reset` empties the `photo_file` column but leaves old files in the folder; they can be deleted by hand.

Protecting a route in code:

```js
router.get('/bookings/pending', requireAuth, requireRole('admin'), controller.listPending);
```

Browsing facilities uses `requireAuth` (any signed-in user). Routes for one role add `requireRole`: students request and cancel their own bookings and read their notifications; administrators review requests, manage bookings, facilities and users. The role is always checked on the server; hiding a page or a menu link in the browser is only a convenience. `requireRole` also has a unit test of its own (`server/tests/require-role.test.js`).

### Running the frontend on another port (Live Server)

The simplest setup is to open the app through Express at <http://localhost:3000>. Pages and API then share one origin, and no extra configuration is needed.

If you serve `client/` from another port, such as VS Code Live Server on 5500:

1. Add the frontend's exact origin to `server\.env`, then restart the server. It must be an exact origin: the server never answers with a `*` wildcard, because browsers refuse to send cookies to a wildcard origin.
   ```text
   CORS_ORIGINS=http://localhost:5500
   ```
2. **Every `fetch` to the API must include `credentials: 'include'`.** Without it, the browser does not send the session cookie cross-origin, and it ignores the cookie in the login response. You stay logged out without any visible error. The shared API client (`client/js/api/client.js`) already does this for every request, so use it rather than calling `fetch` directly. If you ever need a raw `fetch`, add the option yourself:
   ```js
   const response = await fetch('http://localhost:3000/api/auth/me', { credentials: 'include' });
   ```
3. **Use the same host name for both:** `localhost` with `localhost`. Live Server often opens `http://127.0.0.1:5500`; browsers treat `127.0.0.1` and `localhost` as different sites. A `SameSite=Lax` cookie set by `localhost:3000` is then not sent from a `127.0.0.1` page.

The repository's `.vscode/settings.json` already sets Live Server's root to `/client`, its host to `localhost` and its port to `5500`. On port 5500, `client/js/config.js` sends API calls to port 3000 on the same host name automatically.

### Security notes and academic simplifications

- **CSRF:** cookie sessions need protection against cross-site requests. We use three layers: the cookie is `SameSite=Lax`; requests that change data must come from this server's own origin or one listed in `CORS_ORIGINS` (checked against the `Origin` header); and the API only reads JSON bodies. There is no separate CSRF token.
- **Rate limits** are kept in server memory, so they reset on restart. They count per IP address, so many students behind one campus network share one limit.
- **Email addresses at registration:** the server refuses disposable email services (the `disposable-email-domains-js` list) and domains that cannot receive mail (no MX record and no A/AAAA address, or a domain that does not exist). This shows the domain is real, not that the mailbox exists or belongs to the person registering: the project sends no email. If DNS cannot answer within 3 seconds per lookup, registration goes ahead and the server logs a warning. The sample accounts use `@kdu.example`, which does not exist in DNS: they sign in normally, but registering a new account needs a real email domain.
- **No record of who changed a facility or an account:** closing or editing a facility and activating or deactivating an account update `updated_at`, but not who did it. Booking decisions and cancellations do record who and when. Recording these too would need new columns; it was left out to keep the schema stable this late in the project.
- **Administrator accounts** come from the sample data. There is no page for creating administrators, changing roles or resetting someone else's password. Every user can change their own name, photo and password on **My profile**; changing the password signs out their other sessions.
- **Uploaded photos** are checked by content and size, stored outside the public folder and served only to their owner and administrators. They are not scanned for viruses or re-encoded, which a production system would do.
- **Not included (out of scope):** email verification, password reset by email, and account lockout per email.
- **Cookie security:** in production (`NODE_ENV=production`), the cookie is marked `Secure` and only sent over HTTPS. Behind a reverse proxy, Express would also need `trust proxy` configured so rate limits see real client IP addresses.

## Facilities API

All of these require a signed-in user (students and administrators). Without a valid session they answer `401`.

| Method | Path                  | Result                                                                              |
| ------ | --------------------- | ----------------------------------------------------------------------------------- |
| GET    | `/api/facilities`     | `200` `{ facilities, total }`: facilities matching the filters below                |
| GET    | `/api/facilities/:id` | `200` `{ facility }` with description, building and equipment details. `404 FACILITY_NOT_FOUND` if it doesn't exist; `400` if the id is not a positive whole number |
| GET    | `/api/facilities/:id/schedule?from=YYYY-MM-DD&days=7` | `200`: the facility's bookings, day by day, for 1 to 7 days (`days` defaults to 7). See "Schedule" below. `404 FACILITY_NOT_FOUND`; `400` for a missing or impossible date, or `days` outside 1–7 |
| POST   | `/api/facilities`     | **admin.** `201` `{ facility }`. `400 VALIDATION_ERROR` lists every problem; `409 ROOM_TAKEN` (`details.roomNumber`) when the building already has that room number. Students get `403` |
| PUT    | `/api/facilities/:id` | **admin.** `200` `{ facility }`: replaces the details and equipment. The status is not changed here. `400`, `404`, `409` as above |
| PATCH  | `/api/facilities/:id/status` | **admin.** Body `{ "status": "active" \| "maintenance" \| "inactive" }`. `200` `{ facility, usage }`, `usage` being `{ upcomingApprovedBookings, pendingRequests }` left in place. `400`, `404` |
| GET    | `/api/facilities/:id/usage` | **admin.** `200` `{ usage }`: the same counts, before deciding. `404` |
| GET    | `/api/buildings`      | `200` `{ buildings: [{ id, code, name }] }`, for filters and forms                   |
| GET    | `/api/equipment`      | `200` `{ equipment: [{ id, name }] }`, for filters and forms                         |

Filters for `GET /api/facilities` (all optional, combined with AND):

| Parameter     | Example                     | Meaning                                                                  |
| ------------- | --------------------------- | ------------------------------------------------------------------------ |
| `q`           | `q=eng 310`                 | Text in the name, room number, building code or name, or "CODE ROOM". Case-insensitive; `%` and `_` are plain text |
| `type`        | `type=laboratory`           | `classroom`, `laboratory` or `meeting_room`                              |
| `building`    | `building=2`                | Building id (from `/api/buildings`)                                      |
| `minCapacity` | `minCapacity=30`            | At least this many seats (1–1000)                                        |
| `equipment`   | `equipment=1,5`             | Equipment ids; the facility must have **all** of them                    |
| `status`      | `status=active`             | `active`, `maintenance` and/or `inactive`. Leave out to list all         |
| `date`, `startTime`, `endTime` | `date=2026-11-16&startTime=10:00&endTime=12:00` | **Free at** that time: bookable, open that day for the whole time, and no approved booking in any of it. Pending requests don't count. All three or none; the date must be today or later, a start today must not have passed, and the end must be after the start |

Invalid values get a `400 VALIDATION_ERROR` listing every problem parameter in `details`. Results list bookable facilities first, then by building and room.

Each facility in the list:

```json
{ "id": 3, "name": "Computer Lab A", "type": "laboratory", "roomNumber": "310", "floor": 3, "capacity": 30,
  "status": "active", "isBookable": true, "openingHours": { "opensAt": "09:00", "closesAt": "21:00", "openWeekends": false },
  "building": { "id": 1, "code": "ENG", "name": "Engineering Hall" },
  "equipment": [{ "id": 5, "name": "Desktop computer", "quantity": 30 }, { "id": 1, "name": "Projector", "quantity": 1 }] }
```

`GET /api/facilities/:id` adds `description`, `building.description`, `equipment[].description` and `updatedAt`.

### Managing facilities (administrators)

Body for `POST` and `PUT /api/facilities`:

```json
{ "name": "Media Studio", "buildingId": 1, "roomNumber": "410", "type": "meeting_room", "capacity": 8, "floor": 4,
  "description": "Optional, up to 1000 characters", "opensAt": "09:00", "closesAt": "18:00", "openWeekends": false,
  "status": "active", "equipment": [{ "id": 1, "quantity": 1 }, { "id": 2, "quantity": 2 }] }
```

- **Fields:** `type` is `classroom`, `laboratory` or `meeting_room`; `capacity` 1 to 1000; `floor` −5 to 50; `closesAt` after `opensAt`; each equipment type at most once, quantity 1 to 1000. `status` is read only by `POST` (default `active`). Buildings and equipment types come from the sample data; there is no page for managing those lists.
- **One transaction:** the facility and its equipment are saved together, or not at all. The room-number rule is the `UNIQUE (building_id, room_number)` constraint itself, so two administrators saving the same room at once cannot both succeed.
- **Facilities are never deleted.** `inactive` retires one and `maintenance` closes it for now; both stop new requests and stop pending requests being approved. Bookings keep pointing at the facility, so history stays intact.
- **Closing a facility cancels nothing, on purpose.** Approved bookings stay approved, and the answer says how many remain (`usage`). The administrator then cancels each on the Bookings page, with a reason the student sees. An automatic bulk cancellation would give every student the same generic reason and would be hard to undo if the closure was a mistake. The same holds for edits: shrinking the opening hours or the seats does not touch bookings already approved.

### Schedule

`GET /api/facilities/:id/schedule` answers with `facilityId`, `from`, `openingHours`, `isBookable` and `days`. Each day is `{ date, isOpen, bookings }`, and each booking is `{ startTime, endTime, kind }`:

| `kind`         | What it is                                                                  |
| -------------- | --------------------------------------------------------------------------- |
| `booked`       | Someone's approved or completed booking: times only, never who or why       |
| `yours`        | The signed-in student's own approved or completed booking                   |
| `your-request` | The signed-in student's own pending request                                 |

Other students' pending requests are left out: they hold no time, and who asked for what is not other students' business. Administrators see every booking as `booked` here; their own day schedule has the details. Days run from midnight to midnight, Korea time. The booking form uses the same endpoint with `days=1` for its "Already booked" line.

- **Opening hours** are campus local time (Asia/Seoul) and the same on every day the facility is open. `openWeekends: false` means it is closed on Saturday and Sunday (Korea time). In the sample data, classrooms and labs are closed at weekends; the library study rooms and the student center meeting room are open every day. Booking requests are only accepted inside the hours, and none on a weekend when `openWeekends` is false.
- **`isBookable`** is true only for `active` facilities. Facilities under maintenance and retired (`inactive`) ones are still listed and can be opened, but cannot be requested.
- There is no pagination yet: a campus has a few hundred rooms at most, and the list returns them all.

## Users API

Administrators only: students get `403`.

| Method | Path                       | Result                                                                              |
| ------ | -------------------------- | ----------------------------------------------------------------------------------- |
| GET    | `/api/users?q=&role=&status=&page=` | `200` `{ users, total, page, pageSize, totalPages }`: accounts by name, 20 to a page. `q` searches the name, email and student number; `role` is `student` or `admin`; `status` is `active` or `inactive` |
| PATCH  | `/api/users/:id/status`    | Body `{ "active": true \| false }`. `200` `{ user }`. `404 USER_NOT_FOUND`; `409 CANNOT_DEACTIVATE_SELF` |

- **Each user** has `id`, `fullName`, `email`, `role`, `studentNumber`, `isActive`, `createdAt`, `upcomingApprovedBookings` and `pendingRequests`. Password hashes are never selected.
- **Deactivating** signs the person out everywhere at once (their sessions are deleted, and every session lookup checks `is_active` too) and makes sign-in answer "Invalid email or password." Accounts are never deleted. Their bookings are left in place and counted, as for facilities.
- **Your own account** cannot be deactivated, so an active administrator always remains. Two administrators deactivating each other at the same moment are made to take turns (the administrator rows are locked first); the second finds its own account deactivated and is refused.

## Booking requests API

| Method | Path                                           | Access    | Result                                                                                           |
| ------ | ---------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------ |
| POST   | `/api/bookings`                                | student   | `201` `{ booking }`, always `pending` and owned by the signed-in student. `400 VALIDATION_ERROR` lists every problem in `details`. `409 BOOKING_CONFLICT` if an approved or completed booking overlaps. Administrators get `403` |
| GET    | `/api/bookings/:id`                            | both      | `200` `{ booking }`: a student's own booking (as in `/mine`), or any booking for an administrator (as in the list). `404 BOOKING_NOT_FOUND` otherwise, also for another student's booking. Used by the printable confirmation |
| GET    | `/api/bookings/mine`                           | student   | `200` `{ bookings }`: every booking of the signed-in student, latest start first (see below). Administrators get `403` |
| POST   | `/api/bookings/:id/cancel`                     | both      | `200` `{ booking }`, now `cancelled`. One address, two rules, chosen by role. **Student:** their own booking; body `{ "reason": "…" }` is optional (up to 500 characters); `404 BOOKING_NOT_FOUND` if it doesn't exist or isn't their own. **Administrator:** any approved booking; `reason` is required (5 to 500 characters). `409 BOOKING_NOT_CANCELLABLE`, with the reason in `message` |
| GET    | `/api/bookings?status=&facility=&from=&to=&q=&page=` | admin | `200` `{ bookings, total, page, pageSize, totalPages }`: every booking, latest start first, 20 to a page (see "Managing bookings" below). Students get `403` |
| GET    | `/api/bookings/requests`                       | admin     | `200` `{ requests }`: pending requests that have not started, soonest first (see "Reviewing requests" below). Students get `403` |
| POST   | `/api/bookings/:id/approve`                    | admin     | `200` `{ booking, autoRejected: [ids] }`. Body `{ "note": "…" }` is optional (up to 500 characters). `404 BOOKING_NOT_FOUND`; `409` `BOOKING_NOT_PENDING`, `BOOKING_STARTED`, `FACILITY_NOT_BOOKABLE` or `BOOKING_CONFLICT`. Students get `403` |
| POST   | `/api/bookings/:id/reject`                     | admin     | `200` `{ booking }`. Body `{ "reason": "…" }` is required (5 to 500 characters). `404 BOOKING_NOT_FOUND`; `409 BOOKING_NOT_PENDING`. Students get `403` |
| GET    | `/api/bookings/schedule?date=YYYY-MM-DD&type=` | admin     | `200` `{ date, facilities }`: every facility (`type` optional) with its opening hours, `isOpen` that day, and its approved, completed and pending bookings that day, each with `student`, times, `participantCount`, `purpose` and `notes`. Retired facilities appear only on a day they have bookings. Approved bookings that have ended are marked completed first. Students get `403` |

Body for `POST /api/bookings`:

```json
{ "facilityId": 3, "date": "2026-11-16", "startTime": "10:00", "endTime": "11:30",
  "participantCount": 12, "purpose": "Capstone project team meeting", "notes": "Optional, up to 500 characters" }
```

- **Times** are campus local time (Asia/Seoul), written `HH:MM`, whichever time zone the server runs in, and on the hour or half hour (`10:00`, `10:30`; the form offers a list of times every 30 minutes). The date must be today or later, and a request for today cannot start in the past. Facility opening hours are on the hour or half hour too.
- **Reservation reference:** every booking in the API has `reference`, its id written `FR-000042`. It is shown wherever a booking appears, and the administrators' booking search (`q`) finds a booking by it (`FR-000042`, `FR-42` or `fr42`).
- **Length:** from 30 minutes to 4 hours. The request must fall entirely inside the facility's opening hours, on a day it is open.
- **Participants:** from 1 to the facility's capacity. **Purpose:** 5 to 500 characters. Anything else in the body, such as `status` or a user id, is ignored.
- **Pending requests do not hold a slot:** several can overlap, and an administrator approves at most one. A request is refused only when an approved or completed booking already covers part of the time. `bookings_no_overlap` cannot fire for a pending row, so that check is part of the `INSERT` statement. The constraint is what stops two approvals from overlapping.

### Booking lifecycle and cancellation

```text
pending  ──> approved ──> completed
   │            │
   ├──> rejected└──> cancelled
   └──> cancelled
```

`STATUS_TRANSITIONS` in `server/src/services/booking.service.js` is the one list of allowed changes. Rejected, cancelled and completed are final. Every `UPDATE` that changes a status only matches rows whose current status allows that change, so when two requests race to change one booking, at most one succeeds.

- **Cancelling (students, own bookings only):** a **pending** request can be cancelled at any time, even after its start time has passed: it never held the slot. An **approved** booking can be cancelled until it starts. Rejected, cancelled and completed bookings cannot. Who cancelled, when and the optional reason are recorded (`cancelled_by`, `cancelled_at`, `cancellation_reason`). The approval stays on record too. Cancelling an approved booking frees its time for new requests at once.
- **Completed:** nothing runs on a timer. When a student's bookings are listed, their approved bookings that have ended are first marked `completed`, in one `UPDATE`; running it again changes nothing.
- **Another student's booking** gives the same `404` as one that doesn't exist, so booking ids reveal nothing.
- Each booking in `GET /api/bookings/mine` has `status`, `facility` (`id`, `name`, `roomNumber`, `building`), `date`, `startTime`, `endTime` (Korea time), `participantCount`, `purpose`, `notes`, `hasStarted`, `canCancel` (the rule above), `createdAt`, `decision` (`{ decidedAt, note }` or `null`) and `cancellation` (`{ cancelledAt, byYou, reason }` or `null`). Administrators appear only as "an administrator": no names or ids.

### Reviewing requests (administrators)

- **The queue** lists pending requests that have not started yet, soonest first, because those need a decision first. Requests whose start time has passed can no longer be approved; the student can clear them from My bookings. Each request has `student` (`id`, `fullName`, `email`, `studentNumber`), `facility` (with `capacity` and `isBookable`), `overlappingRequests` (the other pending requests in that room it overlaps), `timeTaken` (an approved booking already takes part of its time) and `canApprove`.
- **Approving** records who, when and the optional note. In the same transaction it rejects every other pending request that overlaps it in the same room, with the note "Another request for this time was approved." They could never be approved now. Either all of it happens or none of it does.
- **Refusals:** an approval is refused if the request is no longer pending, has started, or its facility is not bookable. It is also refused when an approved booking already takes part of the time. That last check is `bookings_no_overlap` itself: the database refuses the `UPDATE` (`23P01`), which the API returns as `409 BOOKING_CONFLICT`.
- **Locking:** before deciding, an approval locks the request and every pending request overlapping it, in id order (`SELECT … FOR UPDATE`). A second approval, rejection or cancellation touching any of them waits for the first to finish, then sees its result. Taking locks in one fixed order means two approvals cannot deadlock. `npm run verify:concurrency` checks all of this on real PostgreSQL.
- **Rejecting** needs a reason the student can act on (at least 5 characters). One conditional `UPDATE` decides, so it cannot overwrite a decision or cancellation made at the same moment. A request whose start time has passed can still be rejected, to clear it.
- **What the student sees:** their My bookings page shows the decision, with the note or reason, and they get a notification (see "Notifications API").
- **New requests during an approval:** a request sent while an approval is being saved can slip in as pending next to the newly approved booking. That's harmless: it can never be approved, and the queue marks it "Time already booked".
- `withTransaction()` in `server/src/db/pool.js` runs a function as one transaction on one connection (`BEGIN`, then `COMMIT`, or `ROLLBACK` if it throws).

### Managing bookings (administrators)

- **The list** (`GET /api/bookings`) is every booking in the system, latest start first, 20 to a page. Filters are optional and combine with AND: `status` (one or several, `status=approved,pending`), `facility` (an id), `from` and `to` (the booking's date in Korea time, inclusive) and `q` (part of the student's name, email or student number; `%` and `_` are plain text). Invalid filters give one `400` listing every problem. A `page` past the last one returns no bookings, with `total` and `totalPages` still correct. Approved bookings that have ended are marked completed first.
- **Each booking** has the whole record: `student` (`id`, `fullName`, `email`, `studentNumber`), `facility` (with `capacity`), date and times, `participantCount`, `purpose`, `notes`, `createdAt`, `hasStarted`, `canCancel`, `decision` (`{ decidedAt, note, by: { id, fullName } }` or `null`) and `cancellation` (`{ cancelledAt, reason, byStudent, by: { id, fullName } }` or `null`). Administrators see each other's names here; students never do.
- **Cancelling:** an administrator can cancel an **approved** booking until it **ends** (a room can fail during a booking; students can cancel only until it starts). The reason is required, because the student sees it on My bookings. Who, when and why are recorded, and the approval stays on record. The time is free for other requests at once.
- **Pending requests are not cancelled by administrators:** they are rejected on the Requests page, so every request gets a recorded decision. Trying gives `409 BOOKING_NOT_CANCELLABLE` saying so.
- **Racing changes:** one conditional `UPDATE` decides. If the student (or another administrator) cancels at the same moment, exactly one cancellation is stored and the other gets `409`.

## Notifications API

For students only: each call works on the signed-in student's own notifications. Administrators get `403`; they receive none, because the Requests page is already their list of what is waiting.

| Method | Path                              | Result                                                                    |
| ------ | --------------------------------- | ------------------------------------------------------------------------- |
| GET    | `/api/notifications`              | `200` `{ notifications, unreadCount }`: the latest 50, newest first       |
| GET    | `/api/notifications/unread-count` | `200` `{ unreadCount }`, for the number in the menu                       |
| POST   | `/api/notifications/:id/read`     | `200` `{ unreadCount }`. Marking one that is already read changes nothing. `404 NOTIFICATION_NOT_FOUND` if it doesn't exist or is someone else's |
| POST   | `/api/notifications/read-all`     | `200` `{ marked, unreadCount: 0 }`                                         |

- **Each notification** has `id`, `type` (`booking_approved`, `booking_rejected`, `booking_cancelled` or `system`), `title`, `message`, `bookingId` (or `null`), `isRead` and `createdAt`.
- **What creates one:** an approval, a rejection (including the automatic rejection of requests overlapping an approved one) and an administrator's cancellation. Each goes to the student who owns the booking. A student's own actions (sending a request, cancelling) create none.
- **Stored together with the change, or not at all.** An approval inserts its notifications inside the approval's transaction (`notifyBookingOwners`). A rejection and an administrator's cancellation are each one statement that updates the booking and inserts the notification (`WITH changed AS (UPDATE … RETURNING *) INSERT …`); one statement is one transaction. So a decision is never stored without its notification, and a notification never exists for a change that was rolled back. The tests make the database refuse the notification and check that the booking is unchanged.
- **The text comes from the booking row itself** (`bookingNotificationsSql`), so it cannot disagree with what was stored. Administrators are never named.
- **Simplifications:** no live updates (the menu count is loaded once per page view), no deleting, no preferences, and no notifications about facility closures or account changes.

## Reports API

For administrators only (`403` for students). Read-only: it changes nothing.

| Method | Path                                                  | Result                                              |
| ------ | ----------------------------------------------------- | --------------------------------------------------- |
| GET    | `/api/reports/summary?from=YYYY-MM-DD&to=YYYY-MM-DD`  | `200` `{ range, totals, byStatus, facilities }`     |

- **The range** is the booking's date in Korea time, both ends included. Without dates it is the last 30 days: `to` is today and `from` is 29 days before `to`. It may be at most one year (366 days). Dates that are not real, a `to` before `from`, or a longer range give one `400` with `details.from` / `details.to`.
- **`range`** is `{ from, to, days, weekdays }`. **`byStatus`** has a count for each of the five statuses.
- **`totals`** has `requests`, `decided`, `approved`, `approvalRatePercent`, `bookedHours`, `openHours` and `utilizationPercent`. A percentage has one decimal, and is `null` when there is nothing to divide by (no decided request, no open hours), so "no data" is never shown as 0 %.
- **`facilities`** lists every facility, busiest first, with `bookings`, `bookedHours`, `openHours` and `utilizationPercent`, plus `id`, `name`, `building`, `roomNumber`, `type` and `status`.

The formulas, which the Reports page (`/pages/admin/reports.html`) also prints under the figures:

| Figure           | Formula                                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------------------------- |
| Booking requests | Every request dated in the range, whatever became of it                                                    |
| Approval rate    | approved ÷ decided. *Decided* = approved or rejected by an administrator. *Approved* includes bookings since completed, or cancelled after approval. Pending requests and requests cancelled before a decision are left out |
| Hours booked     | The summed length of approved and completed bookings, in every facility                                    |
| Utilization      | Booked hours ÷ open hours, over the facilities that are not inactive. *Open hours* of a facility = its daily opening hours × the days of the range it is open (Saturdays and Sundays are skipped for a facility closed at weekends) |

**Utilization is a deliberate simplification.** It uses each facility's opening hours and status as they are now, because the schema keeps no history of earlier hours, closures or public holidays:

- A facility whose hours were changed is measured against its new hours for the whole range.
- Inactive facilities are left out of the total (their bookings still count in "Hours booked", and they are listed as "Not counted").
- A facility under maintenance is counted, because it is expected back; time it spent closed lowers its figure.

So utilization is an estimate, good for comparing facilities with each other, not an audited number. An exact figure would need a table recording each change of hours and status with its date. Not included: charts, CSV export, figures per student, and comparisons with an earlier period.

## Academic API (courses, professors, registration)

A separate module next to facility reservations, which keep their names and rules. There
is no professor role: an administrator acts as the academic office and enters the data.
Professors are records (name, department, optional photo with its credit), not accounts.
**All academic data in the seed is sample data:** the semester's name ends "(sample)".

| Method | Path                             | Who       | Result |
| ------ | -------------------------------- | --------- | ------ |
| GET    | `/api/semesters`                 | signed in | `{ semesters, currentId }`. Current: the semester running today, else the next one, else the last |
| POST   | `/api/semesters`                 | admins    | `{ name, startsOn, endsOn }` -> `201 { semester }`. `409 SEMESTER_OVERLAP` when the dates overlap another semester (an exclusion constraint) |
| GET    | `/api/departments`               | signed in | `{ departments }` (from the seed) |
| GET    | `/api/professors?department=`    | signed in | `{ professors }`: `fullName`, `department`, `hasPhoto`, `photoCredit`, `courseCount` |
| POST / PUT / DELETE | `/api/professors[/:id]` | admins | `{ fullName, departmentId }`. Delete only one who teaches no course (`409 PROFESSOR_HAS_COURSES`) |
| PUT / DELETE | `/api/professors/:id/photo` | admins   | `multipart/form-data`: `photo` (JPEG, PNG or WebP by content, at most 2 MB) and `credit` (required, 3 to 200 characters) |
| GET    | `/api/professors/:id/photo`      | signed in | The photo, or `404` |
| GET    | `/api/courses?semester=&q=&department=` | signed in | `{ semester, courses }` for one semester (the current one by default). Each course has `seatLimit`, `seatsTaken`, `seatsLeft`, `professor`, `slots` (weekly lectures with their room), and for a student `isRegistered`, `canRegister`, `canDrop` |
| GET    | `/api/courses/mine?semester=`    | students  | The timetable: `{ semester, courses, totalCredits }` |
| GET    | `/api/courses/:id`               | signed in | `{ course }` |
| GET    | `/api/courses/:id/students`      | admins    | The class list |
| POST / PUT / DELETE | `/api/courses[/:id]` | admins   | `{ semesterId (create only), code, title, credits, departmentId, professorId, description?, seatLimit }`. `409 COURSE_CODE_TAKEN` (codes are unique per semester), `SEATS_BELOW_REGISTERED`, `COURSE_HAS_STUDENTS` (a course anyone registered for cannot be deleted) |
| POST   | `/api/courses/:id/slots`         | admins    | A weekly lecture `{ weekday (1 = Monday), startTime, endTime, facilityId }` -> `201 { slot, sessionsCreated, autoRejected }`. See the rule below |
| DELETE | `/api/courses/:id/slots/:slotId` | admins    | Removes it: its sessions from now on are deleted (the room is free again); past ones stay |
| POST   | `/api/courses/:id/register`      | students  | `200 { course }`. `409 COURSE_FULL`, `TIMETABLE_CLASH` (a lecture overlaps a course already taken), `ALREADY_REGISTERED`, `REGISTRATION_CLOSED` (the semester has ended) |
| POST   | `/api/courses/:id/drop`          | students  | `200 { course }`. `409 NOT_REGISTERED`, `REGISTRATION_CLOSED` |

### Lectures and rooms: the shared room guard

A weekly lecture becomes one `lecture_sessions` row per remaining week of the semester.
Lecture sessions and approved or completed bookings are both mirrored, by triggers, into
`room_occupancy`, which has one exclusion constraint, `room_occupancy_no_overlap`
(facility `=`, time range `&&`). So, in the database itself:

- a lecture cannot be scheduled over an approved reservation, nor over another lecture;
- a reservation cannot be approved over a lecture (`409 BOOKING_CONFLICT`, "A lecture is held in this room…");
- a new request for a time a lecture holds is refused (`409 BOOKING_CONFLICT`, naming the course);
- "Free at", the facility week and the administrators' day schedule show lectures as taken time.

Adding a lecture runs in one transaction: a query finds clashes first, for a clear message
(`409 LECTURE_CONFLICT` with the weeks and the reservation references or lecture codes);
the professor must not lecture elsewhere then (`409 PROFESSOR_CLASH`); and pending requests
for those times are rejected with "A lecture was scheduled in this room at this time." and a
notification, as an approval does for overlapping requests. An approval committing at the
same moment is stopped by the constraint, whichever comes first (tested in
`server/tests/courses.test.js`). `bookings_no_overlap` stays as it was.

### Registration and the seat limit

Registering locks the student's row, then the course's row (always in that order), counts
the registered students and checks for timetable clashes before inserting. Two students
asking for the last seat at the same moment are handled one after the other: one gets it,
the other gets `409 COURSE_FULL`. Dropping keeps the row (`status 'dropped'`) as history.

## Grades API

Each course has weighted assessments (the sample courses: Assignments 30, Midterm exam 30,
Final exam 40). The administrator enters each registered student's marks; the server
computes everything else, so a student can never see or change anyone else's.

| Method | Path | Who | Result |
| ------ | ---- | --- | ------ |
| GET    | `/api/courses/:id/assessments` | admins, or a student registered for it | `{ assessments: [{ id, name, weight, maxPoints }], weightTotal }` |
| POST / PUT / DELETE | `/api/courses/:id/assessments[/:assessmentId]` | admins | `{ name, weight (0.01 to 100), maxPoints }`. `409 WEIGHTS_OVER_100` (the course row is locked, so two administrators cannot both pass 100), `ASSESSMENT_NAME_TAKEN`, `MARKS_ABOVE_MAX`, `ASSESSMENT_HAS_MARKS` (delete) |
| GET    | `/api/courses/:id/gradebook` | admins | Every registered student with their marks and result |
| PUT    | `/api/courses/:id/assessments/:assessmentId/marks` | admins | `{ marks: [{ studentId, points }] }`, `points: null` removes a mark. All or nothing; `400` with `details["marks.<studentId>"]` for a mark outside 0 to the maximum or a student who is not registered |
| GET    | `/api/grades/mine` | students | `{ semesters: [{ semester, courses, gpa, credits, creditsEarned }], cgpa, creditsEarned, scale }`: only the signed-in student's own marks are read |
| GET    | `/api/grades/scale` | signed in | The grade scale |

**How a grade is calculated** (`server/src/services/grade.service.js`, tested in `server/tests/grades.test.js`):

- Course total = the sum over assessments of (points ÷ out of) × weight, out of 100, rounded to 2 decimals.
- A course is **complete** when every assessment is marked and the weights add up to exactly 100. Only then does it get a letter, and only complete courses count in a GPA. Until then the total is shown as provisional ("25.2 so far, 30% marked").
- Semester GPA and CGPA = the credit-weighted average of grade points. An F counts in the GPA but earns no credits.

| Grade | Course total | Grade points |
| ----- | ------------ | ------------ |
| A+ | 95 to 100 | 4.5 |
| A  | 90 to under 95 | 4.0 |
| B+ | 85 to under 90 | 3.5 |
| B  | 80 to under 85 | 3.0 |
| C+ | 75 to under 80 | 2.5 |
| C  | 70 to under 75 | 2.0 |
| D+ | 65 to under 70 | 1.5 |
| D  | 60 to under 65 | 1.0 |
| F  | under 60 | 0.0 |

The scale is the common Korean 4.5 scale, chosen for the project; the university's official
regulations would replace it. The sample data has a finished previous semester (Park Ji-ho:
GPA 3.56) and a current one where only the midterm is marked.

## Attendance API

Attendance is taken per lecture session: the dated lectures generated from each course's
weekly times (see the Academic API). The administrator marks each registered student
present, absent or excused, and can change or remove a mark later.

| Method | Path | Who | Result |
| ------ | ---- | --- | ------ |
| GET | `/api/courses/:id/sessions` | admins | The course's lectures that have started, latest first, each with how many students are marked |
| GET | `/api/sessions/:id/attendance` | admins | The class list for one lecture, with each student's mark (`null`: not marked) |
| PUT | `/api/sessions/:id/attendance` | admins | `{ records: [{ studentId, status }] }`, status `present`, `absent`, `excused` or `null` (remove). All or nothing. `409 SESSION_NOT_STARTED` for a lecture that has not started; `400` for a student not registered |
| GET | `/api/courses/:id/attendance-report` | admins | Every registered student's counts and rate, lowest rate first, and how many are below the limit |
| GET | `/api/attendance/mine?semester=` | students | The student's own counts and rate per course (the current semester by default) |

**The rate** = present ÷ (present + absent), to one decimal. Excused lectures are left out,
and lectures not marked do not count. Below **80%** the student sees a warning on their
timetable and the report flags them (`server/src/services/attendance.service.js`, tested in
`server/tests/attendance.test.js`). The sample data marks every lecture before the seed day;
Kim Min-jun is below 80% in BUS1010.

## Counselling API

The advisors are the professors. Each has weekly office hours; a student asks for a 30- or
60-minute meeting inside them, with a category (academic advising, course planning, career
guidance, research supervision, internship, other) and a short description. An
administrator approves or declines it. The statuses and transitions are the reservations'
own: pending → approved | rejected (shown as "declined") | cancelled; approved → completed |
cancelled.

| Method | Path | Who | Result |
| ------ | ---- | --- | ------ |
| GET | `/api/advisors` | signed in | `{ advisors (with officeHours), categories, lengths }`. Administrators: `?all=1` adds professors without office hours |
| GET | `/api/advisors/:id/availability?date=` | signed in | The 30-minute starts in that day's office hours: `{ slots: [{ startTime, endTime, free }] }`. Approved meetings and past times are not free; pending requests hold no time |
| POST / DELETE | `/api/advisors/:id/office-hours[/:hoursId]` | admins | `{ weekday, startTime, endTime, location }` on the half hour. `409 OFFICE_HOURS_OVERLAP` |
| POST | `/api/meetings` | students | `{ professorId, date, startTime, minutes (30 or 60), category, description }`. Must fit inside one office-hours block, today to 60 days ahead. `409 MEETING_CONFLICT` (the advisor has an approved meeting then), `MEETING_OVERLAPS_YOURS` |
| GET | `/api/meetings/mine` | students | Their own meetings, latest first |
| POST | `/api/meetings/:id/cancel` | students | Their own: a pending request any time, an approved meeting until it starts (the booking rule). `409 MEETING_NOT_CANCELLABLE` |
| GET | `/api/meetings?status=` | admins | Meetings by status; pending ones list the other pending requests they overlap |
| POST | `/api/meetings/:id/approve` | admins | `{ note? }` -> `{ meetingId, autoDeclined }`. In one transaction, overlapping pending requests to the same professor are declined ("Another meeting at this time was approved."), and every student is notified |
| POST | `/api/meetings/:id/decline` | admins | `{ reason }` (required), shown to the student |

**The advisor guard:** `meetings_no_overlap`, an exclusion constraint like
`bookings_no_overlap`: one professor never has two overlapping approved or completed
meetings, whatever the application does. Approving locks the request and the requests it
overlaps in id order, as for bookings; two simultaneous approvals of overlapping requests
end with exactly one approved (tested in `server/tests/meetings.test.js`, which also inserts
directly to show the database refusing).

## Assignments API

The academic office sets assignments per course (title, instructions, due date and time,
"out of", an optional attached file). Students of the course hand in one file each.

| Method | Path | Who | Result |
| ------ | ---- | --- | ------ |
| GET | `/api/courses/:id/assignments` | admins, or a student registered for it | `{ assignments }`, soonest due first. A student's include `mySubmission`, `canSubmit` and `why`; an administrator's, how many were handed in and marked |
| POST / PUT | `/api/courses/:id/assignments[/:assignmentId]` | admins | `multipart/form-data`: `title`, `instructions`, `dueDate`, `dueTime` (KST), `maxPoints`, optional file `attachment` (PUT: `removeAttachment=true` drops it) |
| DELETE | `/api/courses/:id/assignments/:assignmentId` | admins | Only one nobody handed in (`409 ASSIGNMENT_HAS_SUBMISSIONS`) |
| GET | `/api/assignments/:id/attachment` | admins, or a registered student | The attached file, as a download |
| PUT | `/api/assignments/:id/submission` | students | `multipart/form-data`, one file in `file`. `409 DEADLINE_PASSED` (replacing after the deadline), `SUBMISSION_MARKED` |
| GET | `/api/assignments/:id/submission/file` | students | Their own file |
| GET | `/api/assignments/:id/submissions` | admins | Every registered student with their submission, or none |
| GET | `/api/assignments/:id/submissions/:studentId/file` | admins | That student's file |
| PUT | `/api/assignments/:id/submissions/:studentId/mark` | admins | `{ points, feedback? }`; the student is notified ("Assignment marked") in the same transaction |

**The rules:**

- **Files:** at most 10 MB. Allowed: PDF, Word (`.docx`, `.doc`), PowerPoint (`.pptx`, `.ppt`), ZIP, images (JPEG, PNG, WebP) and source or text files (`.py`, `.java`, `.js`, `.c`, `.cpp`, `.html`, `.sql`, `.txt`, `.md` and others). The name's extension must be allowed **and** the content must match it (`server/src/utils/document-type.js`): a PDF starts with `%PDF-`, a `.docx` is a ZIP containing `word/`, a source file is valid UTF-8 text with no NUL bytes. A renamed program is refused.
- **Deadline:** a file can be replaced until the deadline. After it, a first submission is still accepted and flagged **late**; replacing is refused. Once marked, a submission cannot be replaced.
- **Storage:** files are saved in `STORAGE_DIR/assignments/` and `STORAGE_DIR/submissions/` under random names, never under the uploader's name, and served only through the endpoints above with `Content-Disposition: attachment`. Text files (including `.html` and `.js`) are served as plain text, so nothing uploaded can run in the browser.
- **Grades:** an assessment can take its marks "from the course's marked assignments" (`source: 'assignments'`, chosen on the gradebook). A student's mark for it is the average of (points ÷ out of) over their marked assignments, scaled to the assessment's maximum. In the sample data the current semester's "Assignments" assessments work this way.
- **Not included:** virus scanning and previewing files in the browser.

## Tests

```powershell
npm test
```

The tests start the real Express app on a random port, backed by **PGlite**: PostgreSQL compiled to WebAssembly, running in memory inside the test process. Each test file gets a fresh database loaded from `database/schema.sql` and `database/seed.sql`, so the tests also check that both files still load. They never connect to the database in `server\.env`, and they need no PostgreSQL install and no browser. A run takes about 20 seconds.

| File                                 | Covers                                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------------------------- |
| `server/tests/facilities.test.js`    | Facility list (each filter, combined filters, search, empty result, invalid filters), facility detail, not found, invalid ids, `/api/buildings`, `/api/equipment`, `401` without a session |
| `server/tests/require-role.test.js`  | `requireRole`: allowed role, wrong role (`403`), no user (`401`)                           |
| `server/tests/seed-data.test.js`     | The sample data follows the facility rules (no weekend bookings in rooms closed at weekends, all inside opening hours, past and upcoming statuses correct) whichever weekday the seed runs on; schema defaults |
| `server/tests/bookings.test.js`      | Booking requests: every validation rule and its limits, who may request, conflicts with approved bookings, and simultaneous requests through the real API |
| `server/tests/my-bookings.test.js`   | The status-change table; the student's own list (only theirs, order, shape, `canCancel`, nothing about administrators); approved bookings becoming completed when listed; cancelling (pending at any time, approved until it starts, refusals with their messages, another student's booking, invalid input, roles, the freed slot); two simultaneous cancellations through the real API |
| `server/tests/booking-review.test.js` | The review queue (only pending requests that have not started, order, shape, clash markers, a closed facility); approving (the decision recorded, overlapping requests rejected automatically and only those, each refusal with nothing changed, a failure partway through undoing the whole approval); rejecting (reason required and recorded, refusals); simultaneous approvals, rejections and cancellations through the real API |
| `server/tests/admin-bookings.test.js` | The administrators' list (order, the whole record, who cancelled, each filter and their combination, Korea dates, `%` and `_` as plain text, pages, ended bookings marked completed, invalid input, roles); an administrator's cancellation (recorded, what the student sees, the freed time, allowed until the booking ends, each refusal with nothing changed, the required reason); an administrator racing the student or another administrator through the real API |
| `server/tests/admin-facilities.test.js` | Creating a facility (stored with its equipment, each validation rule, a room number already taken, unknown building or equipment with nothing stored, roles); editing (details and equipment replaced, status untouched, bookings left alone, a failure partway through undoing the whole edit); status changes (the counts of what is left, bookings in place, a closed facility refusing requests and approvals, reopening); two administrators creating the same room at once |
| `server/tests/notifications.test.js` | What creates a notification (approval with and without a note, rejection, automatic rejections, an administrator's cancellation) and what does not; the change and its notification stored together or not at all, with the database refusing the notification; the student's list (only their own, order, shape, the latest 50, the unread count); marking one and all as read; another student's notification; roles |
| `server/tests/users.test.js`         | The account list (shape, no password hash, booking counts, search, role and status filters, pages, invalid input, roles); deactivating (signed out at once, sign-in refused, bookings left), reactivating, your own account refused, invalid input; two administrators deactivating each other at once |
| `server/tests/reports.test.js`       | Key figures against bookings built by hand: counts by status with both end dates included, the approval rate (cancelled-after-approval counted, pending and withdrawn left out), hours booked, open hours and utilization (weekends, maintenance counted, inactive left out), every facility busiest first, a single day, an empty range (`null`, not 0 %), the default 30 days, invalid, reversed and over-long ranges, roles; and that open hours follow a facility's current hours and status |
| `server/tests/schedule.test.js`      | A facility's schedule (each kind of booking, what is left out, nothing about who booked, open and closed days, midnight boundaries, the hours, the date range, invalid input, `401`); the administrators' day (students, purposes and requests, order, retired facilities, the type filter, weekends, ended bookings marked completed, invalid input, `403`); the "Free at" filter (opening hours, weekends, maintenance and retired rooms, overlapping, back-to-back, requests that don't count, combined filters, invalid input) |
| `server/tests/email-domain.test.js`  | The registration email-domain check with DNS mocked: disposable domains, MX records, the fallback to an A/AAAA address, domains that do not exist, null MX, and going ahead with a logged warning when DNS times out or errors |
| `server/tests/registration.test.js`  | `POST /api/auth/register` through the real app: a new account can sign in straight away, a fake or disposable domain is refused in the same `400` as other field errors, a DNS failure does not block registration |
| `server/tests/demo-script.test.js`   | The facts `docs/demo-script.md` relies on, against fresh sample data: what the two dashboards and Reports show (Park Ji-ho's pending request, the two lab requests in the administrators' preview, figures for this week and the last 30 days), the two overlapping requests for Computer Lab A, the automatic rejection and its notification, the 2 approved bookings left when Group Study Room B is deactivated, a deactivated student's session ending |
| `server/tests/helpers/test-server.js` | Starts the app on PGlite with fake DNS, with transactions; `request()`, `login()`, `holdUntilSimultaneous()` and `failStatement()` helpers for new tests |

The facility tests use the sample data, so changing the sample facilities in `seed.sql` may need matching changes in the tests.

**Memory:** every test file starts its own in-memory PostgreSQL, and Windows can only hand out so much memory in total (RAM plus page file). With every file starting at once, test processes sometimes stopped with `Fatal process out of memory: Zone`, even with plenty of RAM free. So `npm test` runs at most 4 files at a time (`--test-concurrency=4`). For the same reason, run `npm test` and `npm run test:browser` one after the other, not together.

PGlite has one connection, so tests of simultaneous requests show the requests arriving at the same moment, but they then run one at a time. `npm run verify:concurrency` (see "Prove it under real concurrency") shows real parallel transactions on PostgreSQL.

### Browser checks

```powershell
npm run test:browser
```

These open the real pages in **Microsoft Edge** (part of Windows 11), driven by Playwright, with the app running on PGlite exactly as in `npm test`. The `playwright-core` package uses the installed browser, so nothing else is downloaded. About 1090 checks in six to eight minutes:

- every flow:
  - the signed-out pages, sign-in errors, registration;
  - search and filters, facility details;
  - requesting a booking at phone width (field errors, success, and a time already booked);
  - My bookings (tabs and counts, the table on desktop and cards on a phone, cancelling with and without a reason, a booking changed by someone else meanwhile, empty and error states);
  - the administrators' Requests page (clash markers, approving with the automatic rejection, rejecting with a required reason, a request decided elsewhere meanwhile, empty and error states, what each student then sees);
  - the schedule: a facility's week as a student, on a phone and as an administrator (what each sees, the timeline's layout, the week in the address bar, an error state); choosing free time and how long to fill in the booking form, and a new request appearing on the schedule; the "Free at" filter and its link to a filled-in form; the administrators' day (details dialog, moving between days, the type filter, overlapping requests side by side, weekends, phone layout);
  - the administrators' Bookings page (each filter and the address bar, pages, the details dialog, cancelling with a required reason, a booking cancelled by the student meanwhile, empty and error states, phone layout, what the student then sees);
  - notifications (none yet, then an approval, a rejection and a cancellation made through the real API; the unread count in the menu on every page; marking one and all as read; error state; phone; no page for administrators);
  - managing facilities and users (creating a facility with field errors and a room number already taken, editing it, the warning with the count of bookings left and its link when deactivating a facility that has bookings, reactivating; the user list and filters, deactivating an account and its session ending at once, activating it again);
  - reports (the default 30 days, the four figures and both tables checked against the database, the note on the utilization simplification, a chosen range kept in the address bar, refused dates, an empty range, phone layout, no access for students);
  - the dashboards (where each role lands after signing in; every figure checked against the database and its link; the previews; utilization named as an estimate and opening Reports on the same week; one source failing while the rest loads; a new student with nothing yet; phone layout; no access to the other role's dashboard);
  - the profile and printing (changing the name, uploading a photo and a renamed file being refused, removing it, changing the password with the other browser signed out, reservation references, the printable confirmation and request record, printing without the menu, approving and rejecting from the administrators' day schedule, finding a booking by reference);
  - an expired session, signing out, and who may open which page;
- no horizontal scrolling, on every page at 9 widths from 320 to 1920 px;
- **axe-core** accessibility scans (WCAG 2.2 levels A and AA, plus best-practice rules) on each page and state, at 320 and 1280 px;
- keyboard use: the skip link, Tab order, a visible focus ring on every stop, and focus never hidden under the sticky header;
- no JavaScript errors and no Content-Security-Policy violations in the console.

| Command                                     | Effect                                                                       |
| ------------------------------------------- | ---------------------------------------------------------------------------- |
| `npm run test:browser -- --screenshots`     | Also saves screenshots at 320, 768, 1280 and 1920 px in `tests\browser\screenshots\` (git-ignored), for a visual review |
| `npm run test:browser -- --only layout`     | Runs one group: `public-pages`, `facilities`, `booking`, `my-bookings`, `booking-review`, `schedule`, `admin-bookings`, `admin-manage`, `notifications`, `reports`, `dashboards`, `profile`, `courses`, `grades`, `attendance`, `counselling`, `assignments` or `layout` |
| `npm run test:browser -- --browser chrome`  | Uses Google Chrome instead of Edge                                           |
| `npm run test:browser -- --headed`          | Shows the browser window while the checks run                                |

When a module adds a page, add it to `PAGES` in `tests/browser/checks/layout.js` (responsive and axe checks; `as` says whether a student, an administrator or nobody is signed in) and put its flows in a new file in `tests/browser/checks/`, listed in `tests/browser/run.js`.

axe cannot measure contrast where text sits on a pseudo-element or a background image (the home page hero, the arrow inside select boxes, the "Closed" and "No bookings" notes on the hatched or shaded parts of a schedule), or where the text is a single character (the counts on the My bookings tabs). It prints a `note:` line for those instead of passing or failing them; they were checked by hand from the colour tokens. The tab counts are 10.5:1 (unselected) and 9.7:1 (selected).

## Frontend

Plain HTML, CSS and vanilla JavaScript modules: no framework and no build step. The sitemap, the navigation for each role and the wireframe descriptions are in [`docs/ux-plan.md`](docs/ux-plan.md). The design system is shown live at <http://localhost:3000/pages/style-guide.html>, using sample content.

**Pages:**

| Page                              | Access       | What it does                                                                                 |
| --------------------------------- | ------------ | -------------------------------------------------------------------------------------------- |
| `/` (`index.html`)                | public       | Landing page with Sign in / Create account. Signed-in users go straight to their dashboard   |
| `/pages/login.html`               | public       | Sign in. Returns to `?next=` (same-site paths only), explains `?reason=expired` and `?registered=1` |
| `/pages/register.html`            | public       | Create a student account, then continue to Sign in with the email pre-filled                 |
| `/pages/dashboard.html`           | students     | The student's start page: "Welcome, {name}" and "Book a facility"; three figures (upcoming bookings, pending requests, unread notifications), each linking to its page; the next 5 bookings and requests, soonest first; the latest 3 notifications. Nothing is changed from here |
| `/pages/facilities.html`          | signed in    | Search and filter facilities, including "Free at" a date and time. Filters are kept in the URL; below 1024px they fold behind a "Filters" button. With a time chosen, each card opens the facility with that time already in its booking form |
| `/pages/facility.html?id=…`       | signed in    | Facility details: description, equipment, opening hours, status, location, the week's schedule (`&week=` keeps the week shown) and the booking request form for students. Choosing free time on the schedule asks how long (30 minutes up to what fits, at most 4 hours) and fills in the form; the start and end times are lists every 30 minutes; `&date=&startTime=&endTime=` arrive filled in. The schedule is a 7-column timeline from 768px and a list of days on phones |
| `/pages/my-bookings.html`         | students     | The student's bookings in tabs: Upcoming, Pending, Past, Cancelled & rejected (`?tab=pending` and so on opens one). A table on desktop, cards on phones. Cancel, with confirmation and an optional reason, where the rules allow |
| `/pages/profile.html`             | signed in    | **My profile**, linked from the name and picture in the header: the profile photo (upload, change, remove), the full name, and changing the password with the current one. Email and student number are shown but not editable |
| `/pages/booking-print.html?id=…`  | signed in    | A printable record of one booking (the student's own, or any for an administrator), with its reference. An approved booking prints as a "Reservation confirmation"; anything else as a "Reservation request record" marked NOT CONFIRMED. Printing leaves out the menu and buttons. Linked from My bookings and from Details on Bookings |
| `/pages/courses.html`             | students     | The courses of the current semester (sample data, labelled), with search and a department filter kept in the URL. Each card: professor (photo and credit when there is one), weekly lectures and rooms, seats left, Register or Drop (with confirmation). Clashes and full courses are explained above the list |
| `/pages/timetable.html`           | students     | The student's week, Monday to Friday, drawn like the facility week, and their courses with total credits and attendance (rate, present/absent/excused); a warning names any course below 80%. Linked from Courses |
| `/pages/grades.html`              | students     | My grades: CGPA and credits earned; per semester, each course's marks per assessment, total (provisional until complete) and letter, and the semester GPA; how grades are calculated, with the scale |
| `/pages/transcript.html`          | students     | A printable transcript: completed courses with grade and points, courses in progress without a mark, semester GPAs and the CGPA. Marked as sample data when it is |
| `/pages/counselling.html`         | students     | Request a meeting: choose an advisor (their office hours and place are shown), a date, then one of the free 30-minute starts, the length, a category and a description. My meetings below, with status, place, the decision or reason, and Cancel where allowed. Linked from Courses; meeting notifications link here |
| `/pages/course.html?id=…`         | students     | One of the student's courses: professor, lectures, and its assignments: instructions, due time, the attached file, "Hand in" or "Replace my file", the file handed in (Late when it was), and the mark with feedback. Linked from the timetable |
| `/pages/notifications.html`       | students     | What administrators decided about the student's bookings, newest first, unread ones marked. "Mark as read" per notification and "Mark all as read"; each links to the right tab of My bookings. The menu link shows the unread count on every page |
| `/pages/admin/dashboard.html`     | admins       | The administrators' start page: four figures (pending requests, bookings today, active facilities, "Utilization this week (estimate)"), each linking to its page; the 5 pending requests starting soonest, to look at (deciding is done on Requests); today's approved bookings by start time |
| `/pages/admin/requests.html`      | admins       | Pending requests, soonest first, with clashes marked. Approve (optional note; the dialog lists the overlapping requests it will reject) or reject (reason required). A table on desktop, cards on phones |
| `/pages/admin/bookings.html`      | admins       | Every booking, latest first, 20 to a page. Filters (student, facility, dates, statuses) and the page are kept in the URL; below 1024px the filters fold behind a "Filters" button. "Details" shows the whole record, with who decided and who cancelled. "Cancel", on approved bookings, asks for a required reason. A table on desktop, cards on phones |
| `/pages/admin/facilities.html`    | admins       | Every facility with its type, seats, hours and status. "New facility" and "Edit" open the form. "Close for maintenance", "Deactivate", "Reopen" and "Reactivate" change the status after a confirmation that says how many approved bookings and pending requests it has, with a link to them on the Bookings page; nothing is cancelled automatically |
| `/pages/admin/facility-form.html` | admins       | One form for a new facility, or with `?id=` an existing one: details, opening hours, and the equipment checklist with quantities. Errors from the server appear under each field. When editing, it says how many approved bookings an edit will not change |
| `/pages/admin/users.html`         | admins       | Every account, by name, 20 to a page, with search, role and account filters kept in the URL. "Deactivate" (with the same count-and-link warning) and "Activate"; your own account has no button |
| `/pages/admin/schedule.html`      | admins       | Every facility's bookings on one day (`?date=&type=`), with pending requests outlined. Previous day, Today, Next day, a date picker and a type filter. Choosing a booking shows its details and reference; a pending request that has not started can be approved or rejected from there, with the same confirmations and rules as on Requests. A timeline from 1024px, one card per facility below |
| `/pages/admin/reports.html`       | admins       | Key figures for a date range (`?from=&to=`, the last 30 days without): requests, approval rate, hours booked and estimated utilization; bookings by status; every facility, busiest first, with a bar for its utilization. The page prints how each figure is calculated and what utilization simplifies |
| `/pages/admin/courses.html`       | admins       | Courses of a semester with professor, lectures and seats; "New semester" (a dialog), "New course", "Professors", "Manage" per course |
| `/pages/admin/course-form.html`   | admins       | A new course, or with `?id=` one course: details; its weekly lectures (add with day, times and an open room; remove with confirmation); the class list; delete when nobody has registered |
| `/pages/admin/gradebook.html?course=…` | admins  | One course's assessments (add, edit, delete; a warning until the weights add up to 100) and a marks table with a box per student and assessment; "Save marks" sends only changed marks, and errors appear at their box. Opened from "Assessments and marks" on the course page |
| `/pages/admin/attendance.html?course=…` | admins | One course's attendance: choose a lecture that has started (`&session=` keeps it), mark each student Present, Absent, Excused or Not marked ("Mark everyone not marked as present" fills the rest), save only what changed; the report below lists every student's counts and rate, lowest first |
| `/pages/admin/meetings.html`      | admins       | Counselling: requests waiting for a decision (with overlaps pointed out), Approve (optional note; says what it declines) and Decline (reason required); all meetings by status; each professor's office hours (add, remove). Linked from Courses |
| `/pages/admin/assignments.html?course=…` | admins | One course's assignments: the list (handed in, marked, Delete when nobody has), each one's submissions (download, mark out of its maximum, feedback) and "New assignment" with an optional attachment. Linked from the course page |
| `/pages/admin/professors.html`    | admins       | Professors with department and number of courses: add and edit in a dialog, add or change a photo with its required credit, delete one who teaches nothing |
| `/pages/style-guide.html`         | public       | Design system reference (sample content)                                                     |

After signing in, each role starts on its dashboard (`homeFor(user)` in `js/components/app-shell.js`); the home page and the application's name in the header lead there too.

### Dashboards

The dashboards have no API of their own. Each figure and preview comes from the call behind the page it links to, so a number on a dashboard cannot disagree with that page:

| Dashboard     | Shows                                                     | From                                          |
| ------------- | --------------------------------------------------------- | --------------------------------------------- |
| Student       | Upcoming bookings, pending requests, the next 5           | `GET /api/bookings/mine` (the rules of the My bookings tabs) |
| Student       | Unread notifications, the latest 3                        | `GET /api/notifications`                      |
| Administrator | Pending requests, the 5 starting soonest                  | `GET /api/bookings/requests` (the order of the Requests page) |
| Administrator | Bookings today (approved, including ones already over)    | `GET /api/bookings/schedule?date=` today      |
| Administrator | Active facilities                                         | `GET /api/facilities?status=active`           |
| Administrator | Utilization this week (estimate)                          | `GET /api/reports/summary` for Monday to Sunday of this week |

- **Utilization is always named an estimate.** It is the simplified figure described under [Reports API](#reports-api), and it counts approved bookings later in the week as well. The card says so in its name and its note, and opens Reports on the same week, where the simplification is explained.
- **One source failing leaves the rest working.** Its figures show "–" with "Could not be loaded" (never 0), and its preview offers "Try again".
- **The cost** is several requests per page view (two for a student, four for an administrator) instead of one. A single dashboard endpoint would save requests but repeat queries that already exist and are already tested.
- **Not included:** live updates, charts, and deciding or cancelling from a dashboard.

**CSS:** pages link only `css/main.css`, which imports, in order:

| File             | Contents                                                                                |
| ---------------- | --------------------------------------------------------------------------------------- |
| `tokens.css`     | Design tokens: colour palette and semantic colours, type scale, spacing, radii, shadows |
| `base.css`       | Reset, element defaults, visible focus styles, skip link, `.visually-hidden`            |
| `layout.css`     | App shell (header, navigation, footer), containers, page header, stack/cluster/grids    |
| `components.css` | Buttons, forms, cards, status badges, chips, alerts, tables, details lists, breadcrumb, filter panel, loading/empty/error states, dialog, toast |
| `schedule.css`   | The facility week and the administrators' day: the key, booking items, and the timeline layouts |

Styles used by one page only live in `css/pages/` (`home.css`, `auth.css`, `style-guide.css`) and are linked by that page after `main.css`.

Components use semantic tokens (`--color-primary`, `--color-text-muted`, …), never raw hex values. Every text/background pair meets WCAG AA contrast.

**Page template:** every page uses this structure. The shell fills the header (role-specific navigation and user menu) and the footer.

```html
<link rel="stylesheet" href="/css/main.css">
<script type="module" src="/js/pages/my-page.js"></script>
…
<a class="skip-link" href="#main">Skip to main content</a>
<header class="app-header" data-app-header></header>
<main id="main" class="app-main" tabindex="-1"><div class="container">…</div></main>
<footer class="app-footer" data-app-footer></footer>
```

```js
// js/pages/my-page.js
import { initAppShell } from '../components/app-shell.js';
import { api } from '../api/client.js';

const user = await initAppShell({ access: 'student' }); // 'public' | 'signed-in' | 'student' | 'admin'
if (user) {
  const data = await api.get('/facilities', { query: { type: 'laboratory' } });
}
```

`initAppShell` redirects signed-out visitors to Sign in. A signed-in user with the wrong role sees a "not available to your account" message instead of the page. The server still enforces every permission; the shell only decides what to show.

**JavaScript modules:**

| Module                       | Purpose                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| `js/config.js`               | API base URL: same origin, or port 3000 when served by Live Server on 5500                  |
| `js/api/client.js`           | `api.get/post/put/patch/delete`. Always `credentials: 'include'`, JSON in and out, 15 s timeout; failures throw `ApiError { status, code, message, details }` |
| `js/api/auth.js`             | `getCurrentUser()` (returns `null` when signed out), `login`, `register`, `logout`          |
| `js/api/facilities.js`       | `listFacilities(filters, { signal })`, `getFacility(id)`, `getFacilitySchedule(id, { from, days })`, `listBuildings()`, `listEquipment()` |
| `js/components/app-shell.js` | Header, navigation for each role, user menu, footer, page access checks, `homeFor(user)`, `safeNextPath(next)` |
| `js/components/feedback.js`  | `renderLoading/Empty/Error` (pass `heading: 'h1'` when the state replaces a whole page), `renderAlert`, `showFieldErrors(form, error.details)`, `withButtonLoading`, `toast`, `confirmDialog`, `reasonDialog`, `infoDialog` |
| `js/components/stat-card.js` | `statCard({ id, label, value, note, href })`, a dashboard figure that links to its page; `failedStatCard` for one that could not be loaded; `statGrid(cards)` |
| `js/components/status-badge.js` | `statusBadge('pending')` gives a labelled, coloured badge for booking or facility status |
| `js/components/facility-card.js` | `facilityCard(facility, { linkQuery })` for lists, `equipmentChips`, `facilityUrl(id, linkQuery)` |
| `js/components/week-schedule.js` | `weekSchedule(facility, { week, forStudent, onChoose, onWeekChange })`: a facility's week with its navigation and key; returns `{ element, reload }` |
| `js/utils/dom.js`            | `h(tag, attrs, ...children)` builds elements without `innerHTML`, so API text can never inject markup |
| `js/utils/format.js`         | Labels: facility type, floor, "ENG 310", location line, opening hours, dates, date ranges and moments in Korea time, plurals |
| `js/utils/campus-time.js`    | Korea time whatever the device's time zone: today, the time now, weekends, `addDays`, `mondayOf` |
| `js/utils/timeline.js`       | Times as minutes, free time between bookings, putting overlapping items side by side         |
| `js/utils/storage.js`        | `sessionStorage` wrapped so pages still work when storage is blocked                        |
| `js/utils/validation.js`     | Browser-side checks that mirror the server's rules (email, password length, student number) |

The Content-Security-Policy only allows scripts from this server, so inline `<script>` blocks and `onclick="…"` attributes are blocked. Put code in module files and attach events with `addEventListener`, or with `onClick` in `h()`.

## Project structure

```text
client/                  Static frontend served by Express
  index.html             Home: landing page for signed-out visitors
  pages/                 One HTML file per page (login, register, dashboard, facilities, facility, my-bookings, notifications, style-guide)
  pages/admin/           Administrator pages (dashboard, requests, bookings, schedule, facilities, facility-form, users, reports)
  assets/                Favicon and images
  css/                   main.css → tokens, base, layout, components, schedule (+ pages/ for page-only CSS)
  js/config.js           API base URL
  js/api/                Fetch wrapper (client.js), auth, facility, booking, user, notification and report calls
  js/components/         App shell, feedback states and dialogs, status badges, stat cards, facility card, booking form, tabs, week schedule, pagination
  js/pages/              One script per page (js/pages/admin/ for administrator pages)
  js/utils/              DOM helper, formatting, Korea time, timeline maths, storage, browser-side validation
server/
  .env.example           Configuration template (copy to server/.env)
  src/
    server.js            Starts the HTTP server, graceful shutdown
    app.js               Express app: middleware, routes, static files, error handling
    config/              Loads and validates environment variables
    db/                  PostgreSQL connection pool, query and transaction helpers, SQL file runner,
                         verify-concurrency.js (npm run verify:concurrency)
    routes/              URL to controller mapping (mounted under /api)
    controllers/         Request/response handling
    services/            Business logic and database access
    middleware/          Auth and role checks, rate limits, origin check, 404, central error handler
    utils/               Shared helpers (AppError, input validation, session cookie)
  tests/                 Automated tests (npm test): *.test.js, helpers/ (app on in-memory PGlite)
tests/
  browser/               Browser checks (npm run test:browser): run.js, harness.js, checks/
database/
  schema.sql             Tables, constraints, indexes, triggers (drops and recreates)
  seed.sql               Sample data for development and demos
docs/
  ux-plan.md             Sitemap, navigation per role, wireframe descriptions
  demo-script.md         A 12-minute walk-through for presenting the system
.vscode/settings.json    Live Server settings (root /client, host localhost, port 5500)
```
