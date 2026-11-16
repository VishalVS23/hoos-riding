// The private admin page (/admin): log in with ADMIN_PASSWORD (only in .env / Render's settings),
// then see recent rider reports and remove bad ones.
// - Wrong password 5 times → that internet address is locked out for 15 minutes.
// - A successful login gets a random "session" code, good for 12 hours (kept in memory,
//   so a server restart just means logging in again).

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const PASSWORD = (process.env.ADMIN_PASSWORD || '').trim();
export const configured = PASSWORD.length >= 8;

const SESSION_MS = 12 * 60 * 60_000;
const MAX_FAILS = 5;
const LOCKOUT_MS = 15 * 60_000;

const sessions = new Map(); // code -> expiresAt
const fails = new Map(); // ip -> { count, until }

const digest = (s) => createHash('sha256').update(String(s)).digest();

export function login(password, ip) {
  if (!configured) return { ok: false, status: 503, error: 'Admin page is off (no ADMIN_PASSWORD set).' };
  const now = Date.now();
  const f = fails.get(ip);
  if (f && f.until > now) {
    return { ok: false, status: 429, error: `Too many wrong tries. Wait ${Math.ceil((f.until - now) / 60_000)} min.` };
  }
  // Compare in constant time, so the answer time doesn't leak how close a guess was.
  if (typeof password !== 'string' || !timingSafeEqual(digest(password), digest(PASSWORD))) {
    // Count wrong tries within the last 15 minutes (start over after a quiet 15 min or a lockout).
    const fresh = !f || now - f.firstAt > LOCKOUT_MS || (f.until && f.until <= now);
    const count = (fresh ? 0 : f.count) + 1;
    fails.set(ip, { count, firstAt: fresh ? now : f.firstAt, until: count >= MAX_FAILS ? now + LOCKOUT_MS : 0 });
    return { ok: false, status: 401, error: 'Wrong password.' };
  }
  fails.delete(ip);
  const code = randomBytes(24).toString('hex');
  sessions.set(code, now + SESSION_MS);
  return { ok: true, token: code };
}

// Express middleware: only logged-in admins get through.
export function requireAdmin(req, res, next) {
  const code = (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const until = sessions.get(code);
  if (!until || until < Date.now()) {
    sessions.delete(code);
    return res.status(401).json({ error: 'Please log in again.' });
  }
  next();
}

setInterval(() => {
  const now = Date.now();
  for (const [code, until] of sessions) if (until < now) sessions.delete(code);
  for (const [ip, f] of fails) if (now - f.firstAt > 2 * LOCKOUT_MS && f.until < now) fails.delete(ip);
}, 60 * 60_000).unref();
