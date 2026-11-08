import app from './app.js';
import config from './config/index.js';
import pool from './db/pool.js';
import { describeEmailSender } from './services/email.service.js';
import { checkDatabase } from './services/health.service.js';

const server = app.listen(config.port, (err) => {
  if (err) {
    console.error(
      err.code === 'EADDRINUSE'
        ? `Port ${config.port} is already in use. Stop the other process or set a different PORT in server/.env.`
        : `Server failed to start: ${err.message}`,
    );
    process.exit(1);
  }

  console.log(`Server running (${config.nodeEnv}) at http://localhost:${config.port}`);
  // Names the sender address only; the app password is never printed.
  console.log(`Email: ${describeEmailSender()}. Verification links point to ${config.clientBaseUrl}`);
  for (const warning of config.email.warnings) console.warn(`Email: ${warning}`);

  // Report database reachability at startup; the server keeps running either way
  // and /api/health reports the live status.
  checkDatabase()
    .then(({ latencyMs }) => console.log(`Database connected (${latencyMs} ms)`))
    .catch((dbErr) => console.error(`Database connection failed: ${dbErr.message}. Check DATABASE_URL in server/.env.`));
});

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received: closing server and database pool...`);

  server.close(async () => {
    await pool.end();
    process.exit(0);
  });

  // Force exit if open connections keep the server from closing.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
