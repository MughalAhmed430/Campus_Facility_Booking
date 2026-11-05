import AppError from '../utils/app-error.js';

/** Runs when no route or static file matched the request. */
export default function notFound(req, res, next) {
  next(new AppError(404, 'NOT_FOUND', 'The requested resource was not found.'));
}
