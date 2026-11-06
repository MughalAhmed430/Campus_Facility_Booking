import { API_BASE_URL, API_PREFIX, REQUEST_TIMEOUT_MS } from '../config.js';

/**
 * Error thrown for every failed API call. `code`, `message` and `details` come from
 * the server's error format: { success: false, error: { code, message, details } }.
 */
export class ApiError extends Error {
  constructor({ status, code, message, details }) {
    super(message);
    this.name = 'ApiError';
    this.status = status;   // HTTP status, or 0 when the server could not be reached
    this.code = code;       // e.g. VALIDATION_ERROR, AUTH_REQUIRED, FORBIDDEN, NETWORK_ERROR
    this.details = details; // for VALIDATION_ERROR: { fieldName: 'message', ... }
  }
}

/**
 * Calls the API and returns the `data` part of { success: true, data }.
 * Throws ApiError for anything else, with a message that is safe to show to users.
 *
 * Every request sends cookies (credentials: 'include'): the session cookie must travel
 * with same-origin requests AND with requests from Live Server on another port.
 *
 *   const { user } = await request('/auth/me');
 *   await request('/auth/login', { method: 'POST', body: { email, password } });
 *   const data = await request('/facilities', { query: { type: 'laboratory' }, signal });
 */
export async function request(path, { method = 'GET', body, query, signal, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const headers = { Accept: 'application/json' };
  const init = { method, headers, credentials: 'include' };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  // One controller aborts on timeout or when the caller's own signal aborts
  // (for example, a newer search replacing an older one).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), timeoutMs);
  const forwardAbort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', forwardAbort, { once: true });
  init.signal = controller.signal;

  let response;
  let payload;
  try {
    response = await fetch(buildUrl(path, query), init);
    payload = await readJson(response);
  } catch (err) {
    if (signal?.aborted) throw err; // the caller cancelled on purpose; they can ignore AbortError
    if (controller.signal.reason?.name === 'TimeoutError') {
      throw new ApiError({ status: 0, code: 'TIMEOUT', message: 'The server is taking too long to respond. Please try again.' });
    }
    if (API_BASE_URL) {
      console.error(`Request to ${API_BASE_URL}${API_PREFIX}${path} failed. If the API is running, check that CORS_ORIGINS in server/.env includes ${window.location.origin}.`);
    }
    throw new ApiError({ status: 0, code: 'NETWORK_ERROR', message: 'Cannot reach the server. Check your connection and try again.' });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forwardAbort);
  }

  if (response.ok && payload?.success === true) return payload.data;

  const error = payload?.success === false && payload.error
    ? new ApiError({ status: response.status, ...payload.error })
    : new ApiError({
      status: response.status,
      code: 'UNEXPECTED_RESPONSE',
      message: `Unexpected response from the server (HTTP ${response.status}).`,
    });

  // A session that ends while a page is open (logout in another tab, expiry,
  // deactivation). The app shell listens and sends the user to sign in.
  // /auth/* calls report 401 as a normal result (for example "not signed in").
  if (error.status === 401 && !path.startsWith('/auth/')) {
    window.dispatchEvent(new CustomEvent('api:unauthorized', { detail: error }));
  }
  throw error;
}

/** Shorthands: api.get(path), api.post(path, body), api.patch(path, body), ... */
export const api = {
  get: (path, options) => request(path, { ...options, method: 'GET' }),
  post: (path, body, options) => request(path, { ...options, method: 'POST', body }),
  put: (path, body, options) => request(path, { ...options, method: 'PUT', body }),
  patch: (path, body, options) => request(path, { ...options, method: 'PATCH', body }),
  delete: (path, options) => request(path, { ...options, method: 'DELETE' }),
};

function buildUrl(path, query) {
  const url = new URL(`${API_BASE_URL}${API_PREFIX}${path}`, window.location.origin);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  return url;
}

async function readJson(response) {
  if (response.status === 204) return null;
  if (!(response.headers.get('content-type') ?? '').includes('application/json')) return null;
  try {
    return await response.json();
  } catch (err) {
    if (err.name === 'SyntaxError') return null; // not JSON after all
    throw err; // aborted while reading the body
  }
}
