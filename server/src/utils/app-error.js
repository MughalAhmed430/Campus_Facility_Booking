/**
 * An error that is safe to show to API clients. Throw it from controllers or
 * services; the central error handler turns it into a JSON response.
 *
 *   throw new AppError(404, 'FACILITY_NOT_FOUND', 'Facility not found.');
 *
 * `cause` is logged on the server but never sent to the client.
 */
export default class AppError extends Error {
  constructor(statusCode, code, message, { details, cause } = {}) {
    super(message, { cause });
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}
