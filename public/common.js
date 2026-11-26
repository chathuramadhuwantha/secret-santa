// Shared helpers: API calls, snow, tree skyline, garland lights.
window.Santa = (() => {
  let csrf = null;
  async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (csrf) headers['X-CSRF-Token'] = csrf;
    const res = await fetch(path, { method: opts.method || 'GET', headers, credentials: 'same-origin',
      body: opts.body ? JSON.stringify(opts.body) : undefined });
    let data = {};
    try { data = await res.json(); } catch {}
    if (res.status === 401 && opts.redirectOn401) { location.href = opts.redirectOn401; throw new Error('Please log in.'); }
    if (!res.ok) { const e = new Error(data.error || 'Request failed.'); e.status = res.status; e.data = data; throw e; }
    return data;
  }
  async function me(loginPath) {
    const m = await api('/api/me', { redirectOn401: loginPath });
    csrf = m.csrf; return m;
  }
  async function logout(to) {
    try { await api('/api/logout', { method: 'POST' }); } catch {}
    location.href = to;
  }
  const say = (el, text, ok) => { el.textContent = text; el.className = 'msg ' + (ok ? 'ok' : 'bad'); };
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  function decorate() {
    // falling snow
    const c = document.createElement('canvas'); c.id = 'snow'; document.body.prepend(c);
    const ctx = c.getContext('2d');
    let flakes = [], W = 0, H = 0;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const resize = () => {
      W = c.width = innerWidth * devicePixelRatio; H = c.height = innerHeight * devicePixelRatio;
      const n = Math.min(160, Math.round(innerWidth / 9));
      flakes = Array.from({ length: n }, () => ({ x: Math.random() * W, y: Math.random() * H, r: (Math.random() * 2.4 + .8) * devicePixelRatio, s: Math.random() * .7 + .3, w: Math.random() * 6.28 }));
    };
    const tick = () => {
      ctx.clearRect(0, 0, W, H); ctx.fillStyle = 'rgba(255,255,255,.85)';
      for (const f of flakes) {
        f.y += f.s * devicePixelRatio; f.w += .01; f.x += Math.sin(f.w) * .4 * devicePixelRatio;
        if (f.y > H) { f.y = -5; f.x = Math.random() * W; }
        ctx.beginPath(); ctx.arc(f.x, f.y, f.r, 0, 6.283); ctx.fill();
      }
      if (!reduce) requestAnimationFrame(tick);
    };
    addEventListener('resize', resize); resize(); tick();

    // pine tree skyline
    const t = document.createElement('div'); t.className = 'trees'; t.setAttribute('aria-hidden', 'true');
    let trees = '';
    for (let i = 0; i < 22; i++) {
      const x = i * 48 + (i % 3) * 7, h = 70 + ((i * 37) % 60), w = h * .55, col = i % 2 ? '#174634' : '#1f5c43';
      trees += `<g transform="translate(${x},${140 - h})"><polygon points="${w / 2},0 ${w},${h * .45} 0,${h * .45}" fill="${col}"/>
        <polygon points="${w / 2},${h * .2} ${w * 1.1},${h * .72} ${-w * .1},${h * .72}" fill="${col}"/>
        <polygon points="${w / 2},${h * .42} ${w * 1.2},${h - 12} ${-w * .2},${h - 12}" fill="${col}"/>
        <rect x="${w / 2 - 4}" y="${h - 12}" width="8" height="12" fill="#3b2a20"/>
        ${i % 4 === 0 ? `<circle cx="${w / 2}" cy="2" r="4" fill="#f2c14e"/>` : ''}</g>`;
    }
    t.innerHTML = `<svg viewBox="0 0 1060 140" preserveAspectRatio="xMidYMax slice"><rect y="128" width="1060" height="12" fill="#eef6f1"/>${trees}</svg>`;
    document.body.append(t);

    // garland
    const g = document.querySelector('.lights');
    if (g) g.innerHTML = '<i></i>'.repeat(Math.max(8, Math.min(28, Math.round(innerWidth / 42))));
  }

  const GIFT_SVG = `<svg class="hero-gift" viewBox="0 0 120 120" aria-hidden="true"><rect x="18" y="50" width="84" height="60" rx="6" fill="#c8263f"/>
    <rect x="12" y="38" width="96" height="18" rx="5" fill="#e03a52"/><rect x="54" y="38" width="12" height="72" fill="#f2c14e"/>
    <path d="M60 38c-8-18-32-22-32-6s24 8 32 6zm0 0c8-18 32-22 32-6s-24 8-32 6z" fill="#f2c14e"/></svg>`;

  return { api, me, logout, say, el, decorate, GIFT_SVG };
})();
