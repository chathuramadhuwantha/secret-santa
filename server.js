// Secret Santa web app — zero third-party dependencies.
// Node.js >= 22.13 (built-in SQLite via node:sqlite). Run: node server.js
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

// ---------------------------------------------------------------- config
loadEnvFile(path.join(__dirname, '.env'));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'santa.db');
const SECURE_COOKIES = process.env.SECURE_COOKIES === 'true';   // set true when served over https
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';         // set true behind Render/Railway/nginx
const PUBLIC_DIR = path.join(__dirname, 'public');

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

// ---------------------------------------------------------------- database
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS participants (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, username TEXT NOT NULL UNIQUE,
    pass_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS game (
    id INTEGER PRIMARY KEY CHECK (id = 1), status TEXT NOT NULL DEFAULT 'setup', started_at TEXT);
  INSERT OR IGNORE INTO game (id, status) VALUES (1, 'setup');
  -- One row per emoji in the current game. receiver_id = the name hidden behind the emoji.
  -- UNIQUE(picked_by) => a user can hold only one emoji. UNIQUE(symbol) => emojis are unique.
  CREATE TABLE IF NOT EXISTS emojis (
    id INTEGER PRIMARY KEY, symbol TEXT NOT NULL UNIQUE,
    receiver_id INTEGER UNIQUE REFERENCES participants(id) ON DELETE CASCADE,
    picked_by INTEGER UNIQUE REFERENCES participants(id) ON DELETE CASCADE,
    picked_at TEXT);
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, role TEXT NOT NULL, subject_id INTEGER NOT NULL,
    csrf TEXT NOT NULL, expires_at INTEGER NOT NULL);
`);

const EMOJI_POOL = ['🎅','🤶','🎄','⛄','🦌','🎁','🔔','⭐','❄️','🍪','🧦','🕯️','🍭','🍬','🧁','🍫','☕','🎀','🎉','🎊',
  '🐧','🦊','🐼','🐨','🦉','🐿️','🦔','🐶','🐱','🐰','🦄','🐸','🐢','🦋','🌲','🍀','🌈','🌙','💎','🎈',
  '🧸','🎸','🎺','🥁','🚂','🛷','⛸️','🎿','🍩','🍓','🍒','🥥','🍉','🍋','🌻','🌵','🐙','🦀','🐳','🦒',
  '🦁','🐯','🐮','🐷','🐵','🐥','🦩','🦚','🪐','🚀','🎯','🎨','🎮','🪀','🧩','🎠','🏰','🗻','🌋','🍄'];

// ---------------------------------------------------------------- passwords (scrypt)
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(pw), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${h.toString('base64')}`;
}
function verifyPassword(pw, stored) {
  try {
    const [alg, N, r, p, salt, hash] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const expected = Buffer.from(hash, 'base64');
    const got = crypto.scryptSync(String(pw), Buffer.from(salt, 'base64'), expected.length, { N: +N, r: +r, p: +p });
    return crypto.timingSafeEqual(got, expected);
  } catch { return false; }
}
const DUMMY_HASH = hashPassword(crypto.randomBytes(12).toString('hex'));  // equalises timing for unknown users

// ---------------------------------------------------------------- first admin
if (!db.prepare('SELECT 1 FROM admins LIMIT 1').get()) {
  const u = (process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase();
  let pw = process.env.ADMIN_PASSWORD;
  if (!pw) {
    pw = crypto.randomBytes(9).toString('base64url');
    console.log('\n================================================================');
    console.log(` First run: admin account created.\n   Username: ${u}\n   Password: ${pw}`);
    console.log(' Log in at /admin and change it from the dashboard.');
    console.log('================================================================\n');
  }
  db.prepare('INSERT INTO admins (username, pass_hash) VALUES (?, ?)').run(u, hashPassword(pw));
}

// ---------------------------------------------------------------- sessions
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const SESSION_TTL = { admin: 8 * 3600e3, user: 7 * 24 * 3600e3 };
function createSession(role, id) {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?)').run(sha(token), role, id, csrf, Date.now() + SESSION_TTL[role]);
  return { token, csrf, maxAge: SESSION_TTL[role] / 1000 };
}
function getSession(req) {
  const token = parseCookies(req.headers.cookie || '').ss;
  if (!token) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(sha(token));
  if (!s) return null;
  if (s.expires_at < Date.now()) { db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(s.token_hash); return null; }
  if (s.role === 'user' && !db.prepare('SELECT 1 FROM participants WHERE id = ?').get(s.subject_id)) return null;
  return s;
}
setInterval(() => db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()), 3600e3).unref();

function parseCookies(str) {
  const out = {};
  for (const part of str.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function sessionCookie(token, maxAge) {
  return `ss=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${SECURE_COOKIES ? '; Secure' : ''}`;
}

// ---------------------------------------------------------------- login rate limiting
const attempts = new Map();   // key -> { count, until }
function limited(key, max = 8) {   // 8 failures per account+IP, 40 per IP (offices share one IP)
  const a = attempts.get(key);
  return a && a.count >= max && a.until > Date.now();
}
function fail(key) {
  const a = attempts.get(key);
  if (!a || a.until < Date.now()) attempts.set(key, { count: 1, until: Date.now() + 15 * 60e3 });
  else a.count++;
}
setInterval(() => { const now = Date.now(); for (const [k, a] of attempts) if (a.until < now) attempts.delete(k); }, 60e3).unref();

// ---------------------------------------------------------------- helpers
const randInt = n => crypto.randomInt(n);
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = randInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const gameStatus = () => db.prepare('SELECT status, started_at FROM game WHERE id = 1').get();

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (msg, s = 400) => { throw new HttpError(s, msg); };

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');     // takes the write lock up front → selections are strictly serialised
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

function cleanName(v) {
  const s = String(v ?? '').trim().replace(/\s+/g, ' ');
  if (s.length < 1 || s.length > 60) bad('Name must be 1–60 characters.');
  return s;
}
function cleanUsername(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(s)) bad('Username must be 3–32 characters: letters, numbers, dot, dash or underscore.');
  return s;
}
function cleanPassword(v) {
  const s = String(v ?? '');
  if (s.length < 6 || s.length > 128) bad('Password must be 6–128 characters.');
  return s;
}

// ---------------------------------------------------------------- game logic
function startGame() {
  return tx(() => {
    if (gameStatus().status === 'active') bad('The game is already running. Reset it first.', 409);
    const ppl = db.prepare('SELECT id FROM participants').all();
    if (ppl.length < 3) bad('Add at least 3 participants before starting.');
    if (ppl.length > EMOJI_POOL.length) bad(`Maximum ${EMOJI_POOL.length} participants.`);
    db.exec('DELETE FROM emojis');
    const symbols = shuffle([...EMOJI_POOL]).slice(0, ppl.length);
    const names = shuffle(ppl.map(p => p.id));                       // random emoji → name map
    const ins = db.prepare('INSERT INTO emojis (symbol, receiver_id) VALUES (?, ?)');
    symbols.forEach((s, i) => ins.run(s, names[i]));
    db.prepare("UPDATE game SET status = 'active', started_at = datetime('now') WHERE id = 1").run();
    return { started: true, emojis: ppl.length };
  });
}

function resetGame() {
  return tx(() => {
    db.exec('DELETE FROM emojis');
    db.prepare("UPDATE game SET status = 'setup', started_at = NULL WHERE id = 1").run();
    return { reset: true };
  });
}

// A user picks an emoji. The name behind an unpicked emoji is still secret, so if it would
// break a rule (it's the picker's own name, or it would leave the last person with only their
// own name) it is swapped with another unpicked emoji's name before being revealed.
// Once picked, the row is final.
function pickEmoji(userId, emojiId) {
  return tx(() => {
    if (gameStatus().status !== 'active') bad('The game has not started yet.', 409);
    const already = db.prepare('SELECT id FROM emojis WHERE picked_by = ?').get(userId);
    if (already) bad('You have already chosen your emoji.', 409);
    const e = db.prepare('SELECT id, receiver_id, picked_by FROM emojis WHERE id = ?').get(emojiId);
    if (!e) bad('That emoji does not exist.', 404);
    if (e.picked_by) bad('Someone just picked that emoji. Please choose another.', 409);

    const openEmojis = db.prepare('SELECT id, receiver_id FROM emojis WHERE picked_by IS NULL').all();
    const othersLeft = db.prepare(`SELECT id FROM participants WHERE id != ? AND id NOT IN
      (SELECT picked_by FROM emojis WHERE picked_by IS NOT NULL)`).all(userId).map(r => r.id);

    const valid = receiver => {
      if (receiver === userId) return false;
      if (othersLeft.length === 1) {   // after this pick, exactly one person and one name remain
        const lastName = openEmojis.map(o => o.receiver_id).find(r => r !== receiver);
        if (lastName === othersLeft[0]) return false;
      }
      return true;
    };

    if (!valid(e.receiver_id)) {
      const swaps = shuffle(openEmojis.filter(o => o.id !== e.id && valid(o.receiver_id)));
      if (!swaps.length) bad('No valid assignment is possible. Ask the admin to reset the game.', 409);
      const other = swaps[0];
      const setR = db.prepare('UPDATE emojis SET receiver_id = ? WHERE id = ?');
      setR.run(null, e.id); setR.run(e.receiver_id, other.id); setR.run(other.receiver_id, e.id);
    }
    db.prepare("UPDATE emojis SET picked_by = ?, picked_at = datetime('now') WHERE id = ? AND picked_by IS NULL").run(userId, e.id);
    return myPick(userId);
  });
}

function myPick(userId) {
  return db.prepare(`SELECT e.symbol, p.name AS receiver, e.picked_at FROM emojis e
    JOIN participants p ON p.id = e.receiver_id WHERE e.picked_by = ?`).get(userId) || null;
}

// ---------------------------------------------------------------- routes
const routes = [];
const route = (method, pattern, role, handler) => routes.push({ method, pattern, role, handler });

route('POST', '/api/login', null, ({ body, req, res }) => {
  const role = body.role === 'admin' ? 'admin' : 'user';
  const username = String(body.username || '').trim().toLowerCase();
  const password = String(body.password || '');
  const key = `${clientIp(req)}|${role}|${username}`;
  if (limited(key) || limited(clientIp(req), 40)) bad('Too many failed attempts. Try again in 15 minutes.', 429);
  const row = db.prepare(`SELECT id, pass_hash FROM ${role === 'admin' ? 'admins' : 'participants'} WHERE username = ?`).get(username);
  const ok = verifyPassword(password, row ? row.pass_hash : DUMMY_HASH) && row;
  if (!ok) { fail(key); fail(clientIp(req)); bad('Wrong username or password.', 401); }
  attempts.delete(key);
  const old = parseCookies(req.headers.cookie || '').ss;
  if (old) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(old));
  const s = createSession(role, row.id);
  res.setHeader('Set-Cookie', sessionCookie(s.token, s.maxAge));
  return { role, redirect: role === 'admin' ? '/admin/dashboard' : '/play' };
});

route('POST', '/api/logout', 'any', ({ req, res }) => {
  const token = parseCookies(req.headers.cookie || '').ss;
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
  res.setHeader('Set-Cookie', sessionCookie('', 0));
  return { ok: true };
});

route('GET', '/api/me', 'any', ({ session }) => {
  if (session.role === 'admin') {
    const a = db.prepare('SELECT username FROM admins WHERE id = ?').get(session.subject_id);
    return { role: 'admin', username: a.username, csrf: session.csrf };
  }
  const p = db.prepare('SELECT name, username FROM participants WHERE id = ?').get(session.subject_id);
  return { role: 'user', name: p.name, username: p.username, csrf: session.csrf };
});

// ---- user
route('GET', '/api/game', 'user', ({ session }) => {
  const g = gameStatus();
  const mine = myPick(session.subject_id);
  const total = db.prepare('SELECT COUNT(*) c FROM emojis').get().c;
  const picked = db.prepare('SELECT COUNT(*) c FROM emojis WHERE picked_by IS NOT NULL').get().c;
  // Only ids and symbols of still-available emojis are sent. Never the names behind them.
  const available = mine || g.status !== 'active' ? [] :
    db.prepare('SELECT id, symbol FROM emojis WHERE picked_by IS NULL ORDER BY id').all();
  return { status: g.status, mine, available, total, picked };
});

route('POST', '/api/pick', 'user', ({ session, body }) => {
  const id = Number(body.emojiId);
  if (!Number.isInteger(id)) bad('Choose an emoji.');
  return { mine: pickEmoji(session.subject_id, id) };
});

// ---- admin
route('GET', '/api/admin/overview', 'admin', () => {
  const g = gameStatus();
  const participants = db.prepare(`SELECT p.id, p.name, p.username, p.created_at, e.symbol, e.picked_at
    FROM participants p LEFT JOIN emojis e ON e.picked_by = p.id ORDER BY p.name COLLATE NOCASE`).all();
  const total = db.prepare('SELECT COUNT(*) c FROM emojis').get().c;
  const pickedCount = participants.filter(p => p.symbol).length;
  const available = db.prepare('SELECT symbol FROM emojis WHERE picked_by IS NULL ORDER BY id').all().map(r => r.symbol);
  return { status: g.status, startedAt: g.started_at, participants, total, pickedCount, available };
});

route('GET', '/api/admin/assignments', 'admin', () => ({
  // Only revealed (picked) assignments: unpicked ones are not final yet.
  assignments: db.prepare(`SELECT g.name AS giver, e.symbol, r.name AS receiver, e.picked_at FROM emojis e
    JOIN participants g ON g.id = e.picked_by JOIN participants r ON r.id = e.receiver_id
    ORDER BY e.picked_at`).all(),
}));

route('POST', '/api/admin/participants', 'admin', ({ body }) => {
  if (gameStatus().status === 'active') bad('The game is running. Reset it before adding participants.', 409);
  const name = cleanName(body.name), username = cleanUsername(body.username), pw = cleanPassword(body.password);
  try {
    const r = db.prepare('INSERT INTO participants (name, username, pass_hash) VALUES (?, ?, ?)').run(name, username, hashPassword(pw));
    return { id: Number(r.lastInsertRowid) };
  } catch (e) { if (/UNIQUE/.test(e.message)) bad('That username is already taken.', 409); throw e; }
});

route('PUT', '/api/admin/participants/:id', 'admin', ({ body, params }) => {
  const id = Number(params.id);
  const p = db.prepare('SELECT * FROM participants WHERE id = ?').get(id);
  if (!p) bad('Participant not found.', 404);
  const active = gameStatus().status === 'active';
  const name = body.name !== undefined ? cleanName(body.name) : p.name;
  if (active && name !== p.name) bad('Names cannot change while the game is running. Reset first.', 409);
  const username = body.username !== undefined ? cleanUsername(body.username) : p.username;
  const hash = body.password ? hashPassword(cleanPassword(body.password)) : p.pass_hash;
  try {
    db.prepare('UPDATE participants SET name = ?, username = ?, pass_hash = ? WHERE id = ?').run(name, username, hash, id);
  } catch (e) { if (/UNIQUE/.test(e.message)) bad('That username is already taken.', 409); throw e; }
  if (body.password) db.prepare("DELETE FROM sessions WHERE role = 'user' AND subject_id = ?").run(id);   // log out old sessions
  return { ok: true };
});

route('DELETE', '/api/admin/participants/:id', 'admin', ({ params }) => {
  if (gameStatus().status === 'active') bad('The game is running. Reset it before deleting participants.', 409);
  const id = Number(params.id);
  db.prepare("DELETE FROM sessions WHERE role = 'user' AND subject_id = ?").run(id);
  const r = db.prepare('DELETE FROM participants WHERE id = ?').run(id);
  if (!r.changes) bad('Participant not found.', 404);
  return { ok: true };
});

route('POST', '/api/admin/game/start', 'admin', () => startGame());
route('POST', '/api/admin/game/reset', 'admin', ({ body }) => {
  if (body.confirm !== 'RESET') bad('Type RESET to confirm.');
  return resetGame();
});

route('PUT', '/api/admin/password', 'admin', ({ session, body, req }) => {
  const a = db.prepare('SELECT * FROM admins WHERE id = ?').get(session.subject_id);
  if (!verifyPassword(String(body.current || ''), a.pass_hash)) { fail(clientIp(req)); bad('Current password is wrong.', 403); }
  const pw = String(body.password || '');
  if (pw.length < 10) bad('New admin password must be at least 10 characters.');
  db.prepare('UPDATE admins SET pass_hash = ? WHERE id = ?').run(hashPassword(pw), a.id);
  db.prepare("DELETE FROM sessions WHERE role = 'admin' AND subject_id = ? AND token_hash != ?").run(a.id, session.token_hash);
  return { ok: true };
});

// ---------------------------------------------------------------- pages (server-side guarded)
const PAGES = {
  '/': { file: 'login.html' },
  '/login': { file: 'login.html' },
  '/admin': { file: 'admin-login.html' },
  '/play': { file: 'play.html', role: 'user', login: '/login' },
  '/admin/dashboard': { file: 'admin.html', role: 'admin', login: '/admin' },
};
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png' };

function securityHeaders(res) {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (SECURE_COOKIES) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

function clientIp(req) {
  if (TRUST_PROXY && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.statusCode = status;
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'no-store');
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 16 * 1024) { reject(new HttpError(413, 'Request too large.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'Invalid JSON.')); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  securityHeaders(res);
  const url = new URL(req.url, 'http://x');
  const p = url.pathname.replace(/\/+$/, '') || '/';
  try {
    if (p.startsWith('/api/')) {
      let params = {};
      const r = routes.find(rt => {
        if (rt.method !== req.method) return false;
        const a = rt.pattern.split('/'), b = p.split('/');
        if (a.length !== b.length) return false;
        const pr = {};
        for (let i = 0; i < a.length; i++) { if (a[i].startsWith(':')) pr[a[i].slice(1)] = b[i]; else if (a[i] !== b[i]) return false; }
        params = pr; return true;
      });
      if (!r) bad('Not found.', 404);
      let session = null;
      if (r.role) {
        session = getSession(req);
        if (!session) bad('Please log in.', 401);
        if (r.role !== 'any' && session.role !== r.role) bad('Not allowed.', 403);
        if (req.method !== 'GET' && req.headers['x-csrf-token'] !== session.csrf) bad('Session check failed. Refresh the page.', 403);
      }
      if (req.method !== 'GET' && !/^application\/json/.test(req.headers['content-type'] || '')) bad('Expected JSON.', 415);
      const body = req.method === 'GET' ? {} : await readBody(req);
      return send(res, 200, await r.handler({ req, res, body, params, session }));
    }

    const page = PAGES[p];
    if (page) {
      if (page.role) {
        const s = getSession(req);
        if (!s || s.role !== page.role) { res.statusCode = 302; res.setHeader('Location', page.login); return res.end(); }
      }
      return send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, page.file)), MIME['.html']);
    }

    // static assets (css/js/svg) — no directory traversal, no html served directly
    const file = path.normalize(path.join(PUBLIC_DIR, p));
    const ext = path.extname(file);
    if (file.startsWith(PUBLIC_DIR + path.sep) && ext !== '.html' && MIME[ext] && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.setHeader('Cache-Control', 'no-cache');
      res.statusCode = 200; res.setHeader('Content-Type', MIME[ext]);
      return res.end(fs.readFileSync(file));
    }
    send(res, 404, 'Not found', 'text/plain; charset=utf-8');
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'Something went wrong on the server.' });
  }
});

server.listen(PORT, HOST, () => console.log(`🎄 Secret Santa running on http://localhost:${PORT}  (admin: /admin)`));
