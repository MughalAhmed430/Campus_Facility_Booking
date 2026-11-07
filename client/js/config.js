// Where the API lives.
//
// Pages opened through Express (http://localhost:3000) call the API on the same
// origin, so the base URL is empty. When client/ is served by VS Code Live Server
// (port 5500), the API is on port 3000 of the SAME host name. Keeping the host name
// identical (localhost with localhost, 127.0.0.1 with 127.0.0.1) keeps the session
// cookie "same-site", so the browser sends it. That origin must also be listed in
// CORS_ORIGINS in server/.env.
const LIVE_SERVER_PORT = '5500';
const API_PORT = '3000';

export const API_BASE_URL =
  window.location.port === LIVE_SERVER_PORT
    ? `${window.location.protocol}//${window.location.hostname}:${API_PORT}`
    : '';

export const API_PREFIX = '/api';

export const REQUEST_TIMEOUT_MS = 15_000;
