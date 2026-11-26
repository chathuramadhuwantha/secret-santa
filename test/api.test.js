// End-to-end API test: starts the server on a temp database and checks every game rule.
// Run: npm test
'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert/strict');

const PORT = 3999 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'santa-'));
const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT, HOST: '127.0.0.1', DB_FILE: path.join(dir, 't.db'), ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'admin-pass-123' },
  stdio: ['ignore', 'pipe', 'inherit'],
});

class Client {
  constructor() { this.cookie = ''; this.csrf = ''; }
  async req(method, p, body, { csrf = true } = {}) {
    const h = { 'Content-Type': 'application/json' };
    if (this.cookie) h.Cookie = this.cookie;
    if (csrf && this.csrf) h['X-CSRF-Token'] = this.csrf;
    const r = await fetch(BASE + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
    const sc = r.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
    let data = null; try { data = await r.json(); } catch {}
    return { status: r.status, data, headers: r.headers };
  }
  async login(role, username, password) {
    const r = await this.req('POST', '/api/login', { role, username, password });
    if (r.status === 200) this.csrf = (await this.req('GET', '/api/me')).data.csrf;
    return r;
  }
}

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; console.log('  ✓', msg); };

(async () => {
  await new Promise(r => srv.stdout.on('data', d => { if (/running/.test(d)) r(); }));
  try {
    console.log('Auth & protection');
    const anon = new Client();
    ok((await anon.req('GET', '/api/admin/overview')).status === 401, 'anonymous cannot reach admin API');
    ok((await anon.req('GET', '/admin/dashboard')).status === 302, 'anonymous is redirected away from admin page');
    ok((await anon.req('GET', '/play')).status === 302, 'anonymous is redirected away from play page');
    ok((await anon.login('admin', 'admin', 'wrong')).status === 401, 'wrong admin password rejected');

    const admin = new Client();
    ok((await admin.login('admin', 'ADMIN', 'admin-pass-123')).status === 200, 'admin logs in (username case-insensitive)');
    ok((await admin.req('POST', '/api/admin/participants', { name: 'X', username: 'xx1', password: 'abcdef' }, { csrf: false })).status === 403, 'request without CSRF token rejected');

    const N = Number(process.env.TEST_N || 12), users = [];
    for (let i = 0; i < N; i++) {
      const r = await admin.req('POST', '/api/admin/participants', { name: `Person ${i}`, username: `user${i}`, password: `pass${i}xyz` });
      assert.equal(r.status, 200, JSON.stringify(r.data)); users.push({ id: r.data.id, name: `Person ${i}`, username: `user${i}`, password: `pass${i}xyz` });
    }
    ok(true, `${N} participants created`);
    ok((await admin.req('POST', '/api/admin/participants', { name: 'Dup', username: 'user0', password: 'abcdef' })).status === 409, 'duplicate username rejected');

    const u0 = new Client(); await u0.login('user', 'user0', 'pass0xyz');
    ok((await u0.req('GET', '/api/admin/overview')).status === 403, 'normal user cannot use admin API');
    ok((await u0.req('GET', '/admin/dashboard')).status === 302, 'normal user cannot open admin page');
    ok((await u0.req('GET', '/api/game')).data.status === 'setup', 'game in setup before start');

    const ov = (await admin.req('GET', '/api/admin/overview')).data;
    const hash = (await admin.req('GET', '/api/admin/overview')).data;
    ok(!JSON.stringify(hash).includes('pass_hash'), 'password hashes never leave the server');

    for (let round = 1; round <= 40; round++) {
      await admin.req('POST', '/api/admin/game/reset', { confirm: 'RESET' });
      const st = await admin.req('POST', '/api/admin/game/start', {});
      assert.equal(st.status, 200);
      const clients = await Promise.all(users.map(async u => { const c = new Client(); await c.login('user', u.username, u.password); return { c, u }; }));

      const g = (await clients[0].c.req('GET', '/api/game')).data;
      if (round === 1) {
        ok(g.available.length === N && g.available.every(a => Object.keys(a).sort().join() === 'id,symbol'), 'available list contains only emoji ids/symbols, no names');
        ok(new Set(g.available.map(a => a.symbol)).size === N, 'all emojis are unique');
      }
      // Everyone grabs the SAME emoji simultaneously → exactly one may win.
      if (round === 1) {
        const target = g.available[0].id;
        const rs = await Promise.all(clients.map(({ c }) => c.req('POST', '/api/pick', { emojiId: target })));
        ok(rs.filter(r => r.status === 200).length === 1, 'simultaneous picks of one emoji: exactly one succeeds');
        ok(rs.filter(r => r.status === 409).length === N - 1, 'all other simultaneous picks are rejected');
      }
      // Remaining users pick random available emojis concurrently (with retries on 409).
      await Promise.all(clients.map(async ({ c }) => {
        for (let t = 0; t < 50; t++) {
          const s = (await c.req('GET', '/api/game')).data;
          if (s.mine) return;
          const a = s.available[Math.floor(Math.random() * s.available.length)];
          const r = await c.req('POST', '/api/pick', { emojiId: a.id });
          if (r.status === 200) return;
          assert.equal(r.status, 409, JSON.stringify(r.data));
        }
        throw new Error('could not pick');
      }));
      const results = await Promise.all(clients.map(async ({ c, u }) => ({ u, mine: (await c.req('GET', '/api/game')).data.mine })));
      assert.ok(results.every(r => r.mine), 'everyone picked');
      assert.ok(results.every(r => r.mine.receiver !== r.u.name), 'nobody got themselves');
      assert.equal(new Set(results.map(r => r.mine.receiver)).size, N, 'all receivers distinct');
      assert.equal(new Set(results.map(r => r.mine.symbol)).size, N, 'all emojis distinct');

      if (round === 1) {
        ok(true, 'every user picked exactly one emoji, nobody got their own name, all names distinct');
        const again = await clients[N - 1].c.req('POST', '/api/pick', { emojiId: g.available[1].id });
        ok(again.status === 409, 'a user cannot pick a second emoji');
        const before = results[N - 1].mine;
        const re = new Client(); await re.login('user', users[N - 1].username, users[N - 1].password);
        const after = (await re.req('GET', '/api/game')).data.mine;
        ok(after.receiver === before.receiver && after.symbol === before.symbol, 'same name shown after logging in again');
        ok((await admin.req('POST', '/api/admin/participants', { name: 'Late', username: 'late', password: 'abcdef' })).status === 409, 'participants locked while game is running');
        ok((await admin.req('POST', '/api/admin/game/reset', { confirm: 'nope' })).status === 400, 'reset requires typed confirmation');
        const asg = (await admin.req('GET', '/api/admin/assignments')).data.assignments;
        ok(asg.length === N, 'admin sees all completed selections');
      }
    }
    ok(true, '40 full games played with concurrent picking: all rules held every time');

    // password change logs out old sessions
    const pu = new Client(); await pu.login('user', users[1].username, users[1].password);
    await admin.req('PUT', `/api/admin/participants/${users[1].id}`, { password: 'newpass555' });
    ok((await pu.req('GET', '/api/game')).status === 401, 'changing a password logs the user out');
    ok((await new Client().login('user', users[1].username, 'newpass555')).status === 200, 'new password works');

    // brute force protection
    const bf = new Client(); let last;
    for (let i = 0; i < 10; i++) last = await bf.login('user', users[2].username, 'bad' + i);
    ok(last.status === 429, 'repeated wrong passwords are rate-limited');

    console.log(`\nAll ${passed} checks passed ✅`);
  } catch (e) {
    console.error('\nFAILED:', e.message); process.exitCode = 1;
  } finally { srv.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
})();
