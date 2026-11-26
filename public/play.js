{
  const { api, me, logout, say, el, decorate } = window.Santa;
  const $ = id => document.getElementById(id);
  decorate();
  let state = null, chosen = null, poll = null, busy = false;

  $('logout').addEventListener('click', () => logout('/login'));

  async function load() {
    try {
      state = await api('/api/game', { redirectOn401: '/login' });
      render();
    } catch (e) { if (e.status !== 401) say($('msg'), e.message); }
  }

  function render() {
    $('msg').textContent = '';
    $('choose').hidden = $('waiting').hidden = $('result').hidden = true;
    if (state.mine) {
      $('rEmoji').textContent = state.mine.symbol;
      $('rName').textContent = state.mine.receiver;
      $('result').hidden = false;
      stopPoll(); return;
    }
    if (state.status !== 'active') { $('waiting').hidden = false; startPoll(8000); return; }
    $('choose').hidden = false;
    $('progress').textContent = `🎁 ${state.available.length} of ${state.total} presents still wrapped`;
    const wall = $('wall'), current = new Set(state.available.map(a => String(a.id)));
    // remove presents others have taken since the last refresh
    [...wall.children].forEach(c => { if (!current.has(c.dataset.id)) { c.classList.add('gone'); setTimeout(() => c.remove(), 400); } });
    const have = new Set([...wall.children].map(c => c.dataset.id));
    state.available.forEach((a, i) => {
      if (have.has(String(a.id))) return;
      const b = el('button', 'emoji'); b.type = 'button'; b.dataset.id = a.id; b.setAttribute('role', 'listitem');
      b.setAttribute('aria-label', 'Present ' + a.symbol);
      b.style.animationDelay = Math.min(i * 30, 600) + 'ms';
      b.append(el('span', null, a.symbol));
      b.addEventListener('click', () => ask(a));
      wall.append(b);
    });
    if (!state.available.length) say($('msg'), 'All presents have been opened.', true);
    startPoll(5000);   // keep the wall in sync with other players
  }

  function startPoll(ms) { stopPoll(); poll = setInterval(() => { if (!busy && !$('confirm').classList.contains('on')) load(); }, ms); }
  function stopPoll() { if (poll) clearInterval(poll); poll = null; }

  function ask(a) {
    chosen = a;
    $('cEmoji').textContent = a.symbol; $('cMsg').textContent = '';
    $('cYes').disabled = false;
    $('confirm').classList.add('on'); $('cYes').focus();
  }
  $('cNo').addEventListener('click', () => $('confirm').classList.remove('on'));

  $('cYes').addEventListener('click', async () => {
    if (!chosen || busy) return;
    busy = true; $('cYes').disabled = true; say($('cMsg'), 'Unwrapping…', true);
    try {
      const r = await api('/api/pick', { method: 'POST', body: { emojiId: chosen.id }, redirectOn401: '/login' });
      $('confirm').classList.remove('on');
      openGift(r.mine);
    } catch (e) {
      say($('cMsg'), e.message);
      await load();                      // emoji was taken or user already picked → refresh the wall
      if (state && state.mine) $('confirm').classList.remove('on');
    }
    busy = false;
  });

  function openGift(mine) {
    stopPoll();
    $('nEmoji').textContent = mine.symbol; $('nName').textContent = mine.receiver;
    const conf = $('confetti'); conf.textContent = '';
    const colors = ['#f2c14e', '#c8263f', '#2f7a59', '#fffaf3', '#7fe0a7'];
    for (let i = 0; i < 60; i++) {
      const c = document.createElement('i');
      const ang = Math.random() * Math.PI * 2, dist = 120 + Math.random() * 220;
      c.style.setProperty('--x', Math.cos(ang) * dist + 'px');
      c.style.setProperty('--y', Math.sin(ang) * dist - 80 + 'px');
      c.style.setProperty('--r', (Math.random() * 720 - 360) + 'deg');
      c.style.background = colors[i % colors.length];
      conf.append(c);
    }
    const g = $('gift'); g.className = 'gift shake';
    $('reveal').classList.add('on');
    setTimeout(() => { g.className = 'gift open'; setTimeout(() => $('doneBtn').focus(), 1700); }, 1500);
    state = { ...state, mine };
  }
  $('doneBtn').addEventListener('click', () => { $('reveal').classList.remove('on'); render(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') $('confirm').classList.remove('on'); });

  me('/login').then(m => { $('hello').textContent = '👋 ' + m.name; load(); }).catch(() => {});
}
