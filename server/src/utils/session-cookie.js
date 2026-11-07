import config from '../config/index.js';

const { sessionCookieName, secureCookies } = config.auth;

// httpOnly: page JavaScript cannot read the token, so an XSS bug cannot steal it.
// sameSite 'lax': the browser does not attach it to cross-site POSTs (CSRF defence).
// path '/api': it is only sent with API requests, not with every page or image.
const baseOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: secureCookies,
  path: '/api',
};

export function readSessionToken(req) {
  const token = req.cookies?.[sessionCookieName];
  return typeof token === 'string' && token.length > 0 ? token : null;
}

export function setSessionCookie(res, token, expiresAt) {
  res.cookie(sessionCookieName, token, { ...baseOptions, expires: expiresAt });
}

export function clearSessionCookie(res) {
  res.clearCookie(sessionCookieName, baseOptions);
}
