import { checkDatabase } from '../services/health.service.js';
import AppError from '../utils/app-error.js';

/** GET /api/health - 200 when the API and database are reachable, 503 otherwise. */
export async function getHealth(req, res) {
  res.set('Cache-Control', 'no-store');

  let database;
  try {
    database = await checkDatabase();
  } catch (err) {
    throw new AppError(503, 'DATABASE_UNAVAILABLE', 'The database is currently unreachable.', { cause: err });
  }

  res.json({
    success: true,
    data: {
      status: 'ok',
      database: 'connected',
      databaseLatencyMs: database.latencyMs,
      timestamp: new Date().toISOString(),
    },
  });
}
