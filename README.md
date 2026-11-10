# Smart Campus Facility Booking & Management System

A web application for discovering and booking classrooms, laboratories and meeting rooms at Kyungdong University, with an administrator area for managing facilities, booking requests and users. Built for the Web Application Development course.

> **Status:** Module 7, My Bookings and cancellation. Done so far: the Express server, PostgreSQL connection, security middleware, error handling, health check, schema and seed data, registration, login/logout with server-side sessions, role-based access control, the shared frontend foundation (design tokens, components, app shell, API client), the home, sign-in and registration pages, the facility API with search and filters, the Facilities and Facility details pages, requesting a booking from the Facility details page, the My bookings page with cancellation, and an automated test suite. Reviewing requests (approve and reject) and the full schedule come next.

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

The server checks these at startup and exits with a clear message if one is missing or invalid.

## Database

Create the tables, then load the sample data. These commands use `DATABASE_URL` from `server\.env`, so you don't need `psql`:

```powershell
npm run db:schema   # WARNING: drops and recreates all application tables (all data is lost)
npm run db:seed     # loads sample data into the empty tables
npm run db:reset    # both of the above, in order
```

Each file runs in a single transaction: if anything fails, the database is left unchanged.

> **Updating from an earlier module?** Module 5 added opening hours and weekend opening to facilities (`opens_at`, `closes_at`, `is_open_weekends`). There are no migrations yet, so run `npm run db:reset` once (again, if you reset for an earlier version of Module 5 that did not have `is_open_weekends`). Until you do, the facility pages fail with a server error, because those columns don't exist. Module 6 changed the schema again (student numbers are now 1 to 6 digits, and bookings have a `notes` column), so reset once more: until you do, submitting a booking request fails with a server error. The reset replaces all data, including accounts registered for testing, with the sample data. Module 7 did not change the schema, so it needs no reset.

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

Protecting a route in code:

```js
router.get('/bookings/pending', requireAuth, requireRole('admin'), controller.listPending);
```

The facility routes use `requireAuth` (any signed-in user). No route needs a specific role until the booking and admin modules. Until then, `requireRole` is covered by a unit test (`server/tests/require-role.test.js`), which replaced the temporary `/api/test/student` and `/api/test/admin` routes.

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
- **Not included (out of scope):** email verification, password reset, account lockout per email, and "log out of all devices" from the UI.
- **Cookie security:** in production (`NODE_ENV=production`), the cookie is marked `Secure` and only sent over HTTPS. Behind a reverse proxy, Express would also need `trust proxy` configured so rate limits see real client IP addresses.

## Facilities API

All of these require a signed-in user (students and administrators). Without a valid session they answer `401`.

| Method | Path                  | Result                                                                              |
| ------ | --------------------- | ----------------------------------------------------------------------------------- |
| GET    | `/api/facilities`     | `200` `{ facilities, total }`: facilities matching the filters below                |
| GET    | `/api/facilities/:id` | `200` `{ facility }` with description, building and equipment details. `404 FACILITY_NOT_FOUND` if it doesn't exist; `400` if the id is not a positive whole number |
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

Invalid values get a `400 VALIDATION_ERROR` listing every problem parameter in `details`. Results list bookable facilities first, then by building and room.

Each facility in the list:

```json
{ "id": 3, "name": "Computer Lab A", "type": "laboratory", "roomNumber": "310", "floor": 3, "capacity": 30,
  "status": "active", "isBookable": true, "openingHours": { "opensAt": "09:00", "closesAt": "21:00", "openWeekends": false },
  "building": { "id": 1, "code": "ENG", "name": "Engineering Hall" },
  "equipment": [{ "id": 5, "name": "Desktop computer", "quantity": 30 }, { "id": 1, "name": "Projector", "quantity": 1 }] }
```

`GET /api/facilities/:id` adds `description`, `building.description`, `equipment[].description` and `updatedAt`.

- **Opening hours** are campus local time (Asia/Seoul) and the same on every day the facility is open. `openWeekends: false` means it is closed on Saturday and Sunday (Korea time). In the sample data, classrooms and labs are closed at weekends; the library study rooms and the student center meeting room are open every day. Booking requests are only accepted inside the hours, and none on a weekend when `openWeekends` is false.
- **`isBookable`** is true only for `active` facilities. Facilities under maintenance and retired (`inactive`) ones are still listed and can be opened, but cannot be requested.
- There is no pagination yet: a campus has a few hundred rooms at most, and the list returns them all.

## Booking requests API

| Method | Path                                           | Access    | Result                                                                                           |
| ------ | ---------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------ |
| POST   | `/api/bookings`                                | student   | `201` `{ booking }`, always `pending` and owned by the signed-in student. `400 VALIDATION_ERROR` lists every problem in `details`. `409 BOOKING_CONFLICT` if an approved or completed booking overlaps. Administrators get `403` |
| GET    | `/api/bookings/mine`                           | student   | `200` `{ bookings }`: every booking of the signed-in student, latest start first (see below). Administrators get `403` |
| POST   | `/api/bookings/:id/cancel`                     | student   | `200` `{ booking }`, now `cancelled`. Body `{ "reason": "…" }` is optional (up to 500 characters). `404 BOOKING_NOT_FOUND` if it doesn't exist or isn't the student's own. `409 BOOKING_NOT_CANCELLABLE`, with the reason in `message`. Administrators get `403` |
| GET    | `/api/facilities/:id/bookings?date=YYYY-MM-DD` | signed in | `200` `{ date, bookings: [{ startTime, endTime }] }`: the approved bookings that day, with nothing about who booked. `404 FACILITY_NOT_FOUND` if it doesn't exist |

Body for `POST /api/bookings`:

```json
{ "facilityId": 3, "date": "2026-11-16", "startTime": "10:00", "endTime": "11:30",
  "participantCount": 12, "purpose": "Capstone project team meeting", "notes": "Optional, up to 500 characters" }
```

- **Times** are campus local time (Asia/Seoul), written `HH:MM`, whichever time zone the server runs in. The date must be today or later, and a request for today cannot start in the past.
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

## Tests

```powershell
npm test
```

The tests start the real Express app on a random port, backed by **PGlite**: PostgreSQL compiled to WebAssembly, running in memory inside the test process. Each test file gets a fresh database loaded from `database/schema.sql` and `database/seed.sql`, so the tests also check that both files still load. They never connect to the database in `server\.env`, and they need no PostgreSQL install and no browser. A run takes about 6 seconds.

| File                                 | Covers                                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------------------------- |
| `server/tests/facilities.test.js`    | Facility list (each filter, combined filters, search, empty result, invalid filters), facility detail, not found, invalid ids, `/api/buildings`, `/api/equipment`, `401` without a session |
| `server/tests/require-role.test.js`  | `requireRole`: allowed role, wrong role (`403`), no user (`401`)                           |
| `server/tests/seed-data.test.js`     | The sample data follows the facility rules (no weekend bookings in rooms closed at weekends, all inside opening hours, past and upcoming statuses correct) whichever weekday the seed runs on; schema defaults |
| `server/tests/bookings.test.js`      | Booking requests: every validation rule and its limits, who may request, conflicts with approved bookings, simultaneous requests through the real API, and the approved-times endpoint |
| `server/tests/my-bookings.test.js`   | The status-change table; the student's own list (only theirs, order, shape, `canCancel`, nothing about administrators); approved bookings becoming completed when listed; cancelling (pending at any time, approved until it starts, refusals with their messages, another student's booking, invalid input, roles, the freed slot); two simultaneous cancellations through the real API |
| `server/tests/email-domain.test.js`  | The registration email-domain check with DNS mocked: disposable domains, MX records, the fallback to an A/AAAA address, domains that do not exist, null MX, and going ahead with a logged warning when DNS times out or errors |
| `server/tests/registration.test.js`  | `POST /api/auth/register` through the real app: a new account can sign in straight away, a fake or disposable domain is refused in the same `400` as other field errors, a DNS failure does not block registration |
| `server/tests/helpers/test-server.js` | Starts the app on PGlite with fake DNS; `request()`, `login()` and `holdUntilSimultaneous()` helpers for new tests  |

The facility tests use the sample data, so changing the sample facilities in `seed.sql` may need matching changes in the tests.

Run `npm test` and `npm run test:browser` one after the other, not at the same time. Every test file starts its own in-memory PostgreSQL, so running both together, plus a browser, can run out of memory. Test processes then stop with `Fatal process out of memory`, which is not a test failure.

### Browser checks

```powershell
npm run test:browser
```

These open the real pages in **Microsoft Edge** (part of Windows 11), driven by Playwright, with the app running on PGlite exactly as in `npm test`. The `playwright-core` package uses the installed browser, so nothing else is downloaded. About 280 checks in about a minute:

- every flow built so far: the signed-out pages, sign-in errors, registration, search and filters, facility details, requesting a booking at phone width (field errors, success, and a time already booked), My bookings (tabs and counts, the table on desktop and cards on a phone, cancelling with and without a reason, a booking changed by someone else meanwhile, empty and error states), an expired session, signing out, and what an administrator sees;
- no horizontal scrolling, on every page at 9 widths from 320 to 1920 px;
- **axe-core** accessibility scans (WCAG 2.2 levels A and AA, plus best-practice rules) on each page and state, at 320 and 1280 px;
- keyboard use: the skip link, Tab order, a visible focus ring on every stop, and focus never hidden under the sticky header;
- no JavaScript errors and no Content-Security-Policy violations in the console.

| Command                                     | Effect                                                                       |
| ------------------------------------------- | ---------------------------------------------------------------------------- |
| `npm run test:browser -- --screenshots`     | Also saves screenshots at 320, 768, 1280 and 1920 px in `tests\browser\screenshots\` (git-ignored), for a visual review |
| `npm run test:browser -- --only layout`     | Runs one group: `public-pages`, `facilities`, `booking`, `my-bookings` or `layout` |
| `npm run test:browser -- --browser chrome`  | Uses Google Chrome instead of Edge                                           |
| `npm run test:browser -- --headed`          | Shows the browser window while the checks run                                |

When a module adds a page, add it to `PAGES` in `tests/browser/checks/layout.js` (responsive and axe checks) and put its flows in a new file in `tests/browser/checks/`, listed in `tests/browser/run.js`.

axe cannot measure contrast where text sits on a pseudo-element or a background image (the home page hero, the arrow inside select boxes), or where the text is a single character (the counts on the My bookings tabs). It prints a `note:` line for those instead of passing or failing them; they were checked by hand from the colour tokens. The tab counts are 10.5:1 (unselected) and 9.7:1 (selected).

## Frontend

Plain HTML, CSS and vanilla JavaScript modules: no framework and no build step. The sitemap, the navigation for each role and the wireframe descriptions are in [`docs/ux-plan.md`](docs/ux-plan.md). The design system is shown live at <http://localhost:3000/pages/style-guide.html>, using sample content.

**Pages built so far:**

| Page                              | Access       | What it does                                                                                 |
| --------------------------------- | ------------ | -------------------------------------------------------------------------------------------- |
| `/` (`index.html`)                | public       | Landing page with Sign in / Create account. Signed-in users go straight to Facilities        |
| `/pages/login.html`               | public       | Sign in. Returns to `?next=` (same-site paths only), explains `?reason=expired` and `?registered=1` |
| `/pages/register.html`            | public       | Create a student account, then continue to Sign in with the email pre-filled                 |
| `/pages/facilities.html`          | signed in    | Search and filter facilities. Filters are kept in the URL; below 1024px they fold behind a "Filters" button |
| `/pages/facility.html?id=…`       | signed in    | Facility details: description, equipment, opening hours, status, location, and the booking request form for students |
| `/pages/my-bookings.html`         | students     | The student's bookings in tabs: Upcoming, Pending, Past, Cancelled & rejected (`?tab=pending` and so on opens one). A table on desktop, cards on phones. Cancel, with confirmation and an optional reason, where the rules allow |
| `/pages/style-guide.html`         | public       | Design system reference (sample content)                                                     |

Until the dashboards exist, everyone starts on Facilities after signing in. Menu links to pages that later modules will build stay hidden until those pages exist: see `PLANNED_PAGES` in `js/components/app-shell.js`, and remove a page from that list when you build it.

**CSS:** pages link only `css/main.css`, which imports, in order:

| File             | Contents                                                                                |
| ---------------- | --------------------------------------------------------------------------------------- |
| `tokens.css`     | Design tokens: colour palette and semantic colours, type scale, spacing, radii, shadows |
| `base.css`       | Reset, element defaults, visible focus styles, skip link, `.visually-hidden`            |
| `layout.css`     | App shell (header, navigation, footer), containers, page header, stack/cluster/grids    |
| `components.css` | Buttons, forms, cards, status badges, chips, alerts, tables, details lists, breadcrumb, filter panel, loading/empty/error states, dialog, toast |

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
| `js/api/facilities.js`       | `listFacilities(filters, { signal })`, `getFacility(id)`, `listBuildings()`, `listEquipment()` |
| `js/components/app-shell.js` | Header, navigation for each role, user menu, footer, page access checks, `homeFor(user)`, `safeNextPath(next)` |
| `js/components/feedback.js`  | `renderLoading/Empty/Error` (pass `heading: 'h1'` when the state replaces a whole page), `renderAlert`, `showFieldErrors(form, error.details)`, `withButtonLoading`, `toast`, `confirmDialog` |
| `js/components/status-badge.js` | `statusBadge('pending')` gives a labelled, coloured badge for booking or facility status |
| `js/components/facility-card.js` | `facilityCard(facility)` for lists, `equipmentChips`, `facilityUrl(id)`                  |
| `js/utils/dom.js`            | `h(tag, attrs, ...children)` builds elements without `innerHTML`, so API text can never inject markup |
| `js/utils/format.js`         | Labels: facility type, floor, "ENG 310", location line, opening hours, plurals              |
| `js/utils/storage.js`        | `sessionStorage` wrapped so pages still work when storage is blocked                        |
| `js/utils/validation.js`     | Browser-side checks that mirror the server's rules (email, password length, student number) |

The Content-Security-Policy only allows scripts from this server, so inline `<script>` blocks and `onclick="…"` attributes are blocked. Put code in module files and attach events with `addEventListener`, or with `onClick` in `h()`.

## Project structure

```text
client/                  Static frontend served by Express
  index.html             Home: landing page for signed-out visitors
  pages/                 One HTML file per page (login, register, facilities, facility, my-bookings, style-guide)
  assets/                Favicon and images
  css/                   main.css → tokens, base, layout, components (+ pages/ for page-only CSS)
  js/config.js           API base URL
  js/api/                Fetch wrapper (client.js), auth, facility and booking calls
  js/components/         App shell, feedback states and dialogs, status badges, facility card, booking form, tabs
  js/pages/              One script per page
  js/utils/              DOM helper, formatting, storage, browser-side validation
server/
  .env.example           Configuration template (copy to server/.env)
  src/
    server.js            Starts the HTTP server, graceful shutdown
    app.js               Express app: middleware, routes, static files, error handling
    config/              Loads and validates environment variables
    db/                  PostgreSQL connection pool, query helper, SQL file runner
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
.vscode/settings.json    Live Server settings (root /client, host localhost, port 5500)
```
