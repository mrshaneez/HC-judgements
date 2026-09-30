import crypto from 'crypto';

const SECRET = process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD || 'change-me';

// Deterministic session token derived from the secret. Rotating ADMIN_PASSWORD/
// SESSION_SECRET invalidates existing sessions.
export function makeToken() {
  return crypto.createHmac('sha256', SECRET).update('admin-session-v1').digest('hex');
}

export function parseCookies(req) {
  const h = req.headers.cookie || '';
  const out = {};
  h.split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

export function isAuthed(req) {
  const c = parseCookies(req);
  return c.admin && c.admin === makeToken();
}

export function setSessionCookie(res) {
  const token = makeToken();
  res.setHeader('Set-Cookie', `admin=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000; Secure`);
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'admin=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0; Secure');
}

// Bearer token check for the GitHub Actions cron ingest endpoint.
export function isCronAuthed(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const h = req.headers.authorization || '';
  return h === `Bearer ${secret}`;
}
