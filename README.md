# Smart Campus Facility Booking & Management System

A web application for discovering and booking classrooms, laboratories and meeting rooms at Kyungdong University, with an administrator area for managing facilities, booking requests and users. Built for the Web Application Development course.

> **Status:** Module 1, project foundation. The Express server, PostgreSQL connection, security middleware, error handling and health check are in place. No application features yet.

## Tech stack

| Layer    | Technology                                                       |
| -------- | ---------------------------------------------------------------- |
| Frontend | HTML5, CSS3, vanilla JavaScript (ES modules), Fetch API           |
| Backend  | Node.js, Express 5, REST/JSON API                                 |
| Database | PostgreSQL, accessed with the `pg` package and parameterized SQL  |
| Security | `helmet` (security headers), `cors` (allow-list)                  |
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
| `CORS_ORIGINS` | no       | empty         | Comma-separated extra origins allowed to call the API (e.g. Live Server) |

The server checks these at startup and exits with a clear message if one is missing or invalid.

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

## Project structure

```text
client/                  Static frontend served by Express
  index.html
  pages/  assets/  css/
  js/api/  js/components/  js/pages/  js/utils/
server/
  .env.example           Configuration template (copy to server/.env)
  src/
    server.js            Starts the HTTP server, graceful shutdown
    app.js               Express app: middleware, routes, static files, error handling
    config/              Loads and validates environment variables
    db/                  PostgreSQL connection pool and query helper
    routes/              URL to controller mapping (mounted under /api)
    controllers/         Request/response handling
    services/            Business logic and database access
    middleware/          404 and central error handler
    utils/               Shared helpers (AppError)
  tests/
database/                schema.sql and seed.sql (added in a later module)
docs/                    Project documentation
```
