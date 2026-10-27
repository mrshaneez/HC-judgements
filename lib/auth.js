import crypto from 'crypto';

const SECRET = process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD || 'change-me';

// ---- Signed session cookie carrying {email, role} ----
function sign(payload) {
  return crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}

export function makeSessionValue(sess) {
  const payload = Buffer.from(JSON.stringify({ e: sess.email, r: sess.role })).toString('base64url');
  return payload + '.' + sign(payload);
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

export function readSession(req) {
  const v = parseCookies(req).sess;
  if (!v) return null;
  const i = v.lastIndexOf('.');
  if (i < 0) return null;
  const payload = v.slice(0, i), sig = v.slice(i + 1);
  let a, b;
  try { a = Buffer.from(sign(payload)); b = Buffer.from(sig); } catch (e) { return null; }
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const o = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return { email: o.e, role: o.r };
  } catch (e) { return null; }
}

export function isAuthed(req) { return !!readSession(req); }            // any signed-in user
export function isAdmin(req) { const s = readSession(req); return !!s && s.role === 'admin'; }

export function setSessionCookie(res, sess) {
  res.setHeader('Set-Cookie', `sess=${makeSessionValue(sess)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000; Secure`);
}
export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'sess=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0; Secure');
}

// Bearer token check for the GitHub Actions cron ingest endpoint.
export function isCronAuthed(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const h = req.headers.authorization || '';
  return h === `Bearer ${secret}`;
}
