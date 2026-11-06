# Smart Campus Facility Booking & Management System

A web application for discovering and booking classrooms, laboratories and meeting rooms at Kyungdong University, with an administrator area for managing facilities, booking requests and users. Built for the Web Application Development course.

> **Status:** Module 4, frontend design system. Done so far: the Express server, PostgreSQL connection, security middleware, error handling, health check, schema and seed data, registration, login/logout with server-side sessions, role-based access control, and the shared frontend foundation: design tokens, components, app shell and API client. Application pages come next.

## Tech stack

| Layer    | Technology                                                       |
| -------- | ---------------------------------------------------------------- |
| Frontend | HTML5, CSS3, vanilla JavaScript (ES modules), Fetch API           |
| Backend  | Node.js, Express 5, REST/JSON API                                 |
| Database | PostgreSQL, accessed with the `pg` package and parameterized SQL  |
| Auth     | Own code: `bcryptjs` password hashing, sessions in PostgreSQL, `cookie-parser` |
| Security | `helmet` (security headers), `cors` (allow-list), `express-rate-limit` |
| Dev      | `nodemon` (auto-restart), `dotenv` (configuration)                |

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

**Demo accounts** (sample data only; never use these on a real deployment):

| Role    | Email                                                                  | Password       |
| ------- | ---------------------------------------------------------------------- | -------------- |
| Admin   | `admin@kdu.example`                                                    | `Admin@2026`   |
| Student | `minjun.kim@`, `seoyeon.lee@`, `jiho.park@`, `yuna.choi@` `kdu.example` | `Student@2026` |

Sample booking dates are relative to the day you run the seed (Korea time). Re-run `npm run db:reset` to refresh them.

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
| GET    | `/api/test/student`  | students only | Temporary route to check role-based access                              |
| GET    | `/api/test/admin`    | admins only   | Temporary route to check role-based access                              |

- New accounts are always `student`. Sending a `role` field at registration is rejected.
- Passwords must be 8–72 bytes. bcrypt ignores anything past 72 bytes, so longer passwords are rejected rather than silently cut.
- A wrong password, an unknown email and a deactivated account all get the same `401 INVALID_CREDENTIALS` "Invalid email or password." They also take about the same time, so the response doesn't reveal which emails have accounts.
- `401`: not logged in, or the session has ended. `403`: logged in, but the wrong role.
- Rate limits: 10 failed logins per 15 minutes, and 10 registrations per hour, per IP address. Over the limit, the server answers `429`.

Protecting a route in code:

```js
router.get('/bookings/pending', requireAuth, requireRole('admin'), controller.listPending);
```

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
- **Not included (out of scope):** email verification, password reset, account lockout per email, and "log out of all devices" from the UI.
- **Cookie security:** in production (`NODE_ENV=production`), the cookie is marked `Secure` and only sent over HTTPS. Behind a reverse proxy, Express would also need `trust proxy` configured so rate limits see real client IP addresses.

## Frontend

Plain HTML, CSS and vanilla JavaScript modules: no framework and no build step. The sitemap, the navigation for each role and the wireframe descriptions are in [`docs/ux-plan.md`](docs/ux-plan.md). The design system is shown live at <http://localhost:3000/pages/style-guide.html>, using sample content.

**CSS:** pages link only `css/main.css`, which imports, in order:

| File             | Contents                                                                                |
| ---------------- | --------------------------------------------------------------------------------------- |
| `tokens.css`     | Design tokens: colour palette and semantic colours, type scale, spacing, radii, shadows |
| `base.css`       | Reset, element defaults, visible focus styles, skip link, `.visually-hidden`            |
| `layout.css`     | App shell (header, navigation, footer), containers, page header, stack/cluster/grids    |
| `components.css` | Buttons, forms, cards, status badges, chips, alerts, tables, loading/empty/error states, dialog, toast |

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
| `js/components/app-shell.js` | Header, navigation for each role, user menu, footer, page access checks                     |
| `js/components/feedback.js`  | `renderLoading/Empty/Error`, `showFieldErrors(form, error.details)`, `withButtonLoading`, `toast`, `confirmDialog` |
| `js/components/status-badge.js` | `statusBadge('pending')` gives a labelled, coloured badge for booking or facility status |
| `js/utils/dom.js`            | `h(tag, attrs, ...children)` builds elements without `innerHTML`, so API text can never inject markup |

The Content-Security-Policy only allows scripts from this server, so inline `<script>` blocks and `onclick="…"` attributes are blocked. Put code in module files and attach events with `addEventListener`, or with `onClick` in `h()`.

## Project structure

```text
client/                  Static frontend served by Express
  index.html             Home (placeholder until the public pages are built)
  pages/                 One HTML file per page (style-guide.html so far)
  assets/                Favicon and images
  css/                   main.css → tokens, base, layout, components (+ pages/ for page-only CSS)
  js/config.js           API base URL
  js/api/                Fetch wrapper (client.js) and auth calls
  js/components/         App shell, feedback states, status badges
  js/pages/              One script per page
  js/utils/              DOM helper
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
  tests/
database/
  schema.sql             Tables, constraints, indexes, triggers (drops and recreates)
  seed.sql               Sample data for development and demos
docs/
  ux-plan.md             Sitemap, navigation per role, wireframe descriptions
.vscode/settings.json    Live Server settings (root /client, host localhost, port 5500)
```
