{
  const { api, me, logout, say, el, decorate } = window.Santa;
  const $ = id => document.getElementById(id);
  decorate();
  let ov = null, editing = null, deleting = null, showNames = false;
  const A = (path, opts = {}) => api(path, { ...opts, redirectOn401: '/admin' });

  $('logout').addEventListener('click', () => logout('/admin'));

  // tabs
  document.querySelectorAll('[data-tab]').forEach(t => t.addEventListener('click', () => {
    document.querySelectorAll('[data-tab]').forEach(x => x.setAttribute('aria-selected', String(x === t)));
    document.querySelectorAll('[data-panel]').forEach(p => p.hidden = p.dataset.panel !== t.dataset.tab);
    if (t.dataset.tab === 'picks') loadPicks();
  }));

  const fmt = s => { if (!s) return ''; const d = new Date(s.replace(' ', 'T') + 'Z'); return isNaN(d) ? s : d.toLocaleString(); };

  async function load() {
    try { ov = await A('/api/admin/overview'); } catch (e) { return say($('pMsg'), e.message); }
    const n = ov.participants.length, active = ov.status === 'active';
    $('sPeople').textContent = n;
    $('sDone').textContent = ov.pickedCount;
    $('sLeft').textContent = active ? n - ov.pickedCount : '–';
    $('sStatus').textContent = active ? 'Running' : 'Setup';
    $('sStatus').className = 'pill ' + (active ? 'active' : 'setup');
    $('meter').style.width = active && n ? Math.round(ov.pickedCount / n * 100) + '%' : '0%';
    $('headline').textContent = active ? `${ov.pickedCount} of ${n} presents opened` : 'Set up your Secret Santa';
    $('sublead').textContent = active ? `Game started ${fmt(ov.startedAt)}.` : 'Add everyone below, then start the game from the Game tab.';
    $('lockNote').hidden = !active;
    $('addForm').querySelectorAll('input,button').forEach(i => i.disabled = active);
    $('startBtn').disabled = active;

    const tb = $('people'); tb.textContent = '';
    if (!n) { const tr = el('tr'), td = el('td', 'empty', 'No participants yet. Add the first one above.'); td.colSpan = 5; tr.append(td); tb.append(tr); }
    ov.participants.forEach(p => {
      const tr = el('tr');
      const c1 = el('td', null, p.name); c1.dataset.l = 'Name';
      const c2 = el('td', null, p.username); c2.dataset.l = 'Username';
      const c3 = el('td'); c3.dataset.l = 'Status';
      c3.append(el('span', 'pill ' + (p.symbol ? 'yes' : 'no'), p.symbol ? 'Picked ✓' : active ? 'Not yet' : 'Waiting'));
      const c4 = el('td'); c4.dataset.l = 'Emoji'; c4.append(el('span', 'e', p.symbol || '—'));
      const c5 = el('td'); const act = el('div', 'actions');
      const eb = el('button', 'ghost small', 'Edit'); eb.type = 'button'; eb.addEventListener('click', () => openEdit(p));
      const db = el('button', 'ghost small', 'Delete'); db.type = 'button'; db.disabled = active; db.addEventListener('click', () => openDel(p));
      act.append(eb, db); c5.append(act);
      tr.append(c1, c2, c3, c4, c5); tb.append(tr);
    });
  }

  async function loadPicks() {
    if (!ov) await load();
    let data;
    try { data = await A('/api/admin/assignments'); } catch (e) { return; }
    const tb = $('picks'); tb.textContent = '';
    if (!data.assignments.length) { const tr = el('tr'), td = el('td', 'empty', 'Nobody has picked yet.'); td.colSpan = 4; tr.append(td); tb.append(tr); }
    data.assignments.forEach(a => {
      const tr = el('tr');
      const c1 = el('td', null, a.giver); c1.dataset.l = 'Participant';
      const c2 = el('td'); c2.dataset.l = 'Emoji'; c2.append(el('span', 'e', a.symbol));
      const c3 = el('td', 'rcv', a.receiver); c3.dataset.l = 'Santa for';
      const c4 = el('td', null, fmt(a.picked_at)); c4.dataset.l = 'Picked at';
      tr.append(c1, c2, c3, c4); tb.append(tr);
    });
    $('avail').textContent = ov.available.length ? ov.available.join(' ') : '';
    $('availTitle').textContent = ov.status === 'active' ? `Still available (${ov.available.length})` : 'Start the game to create the emojis.';
  }
  $('toggleNames').addEventListener('click', () => {
    showNames = !showNames;
    $('pickWrap').classList.toggle('hidden-names', !showNames);
    $('toggleNames').textContent = showNames ? '🙈 Hide assigned names' : '👁 Show assigned names';
  });
  $('refresh').addEventListener('click', async () => { await load(); loadPicks(); });

  // add participant
  const genPw = () => { const A = 'abcdefghjkmnpqrstuvwxyz23456789'; const r = crypto.getRandomValues(new Uint32Array(10)); return Array.from(r, x => A[x % A.length]).join(''); };
  $('genPass').addEventListener('click', () => { $('aPass').value = genPw(); });
  $('aName').addEventListener('input', () => {
    if (!$('aUser').dataset.touched) $('aUser').value = $('aName').value.trim().toLowerCase().split(/\s+/)[0]?.replace(/[^a-z0-9._-]/g, '') || '';
  });
  $('aUser').addEventListener('input', () => { $('aUser').dataset.touched = '1'; });
  $('addForm').addEventListener('submit', async e => {
    e.preventDefault();
    const name = $('aName').value, username = $('aUser').value, password = $('aPass').value;
    try {
      await A('/api/admin/participants', { method: 'POST', body: { name, username, password } });
      say($('pMsg'), `${name.trim()} added.`, true);
      $('credText').textContent = `${name.trim()} · username: ${username.trim().toLowerCase()} · password: ${password} · ${location.origin}/login`;
      $('lastCreds').hidden = false;
      $('addForm').reset(); delete $('aUser').dataset.touched; $('aName').focus();
      load();
    } catch (err) { say($('pMsg'), err.message); }
  });
  $('copyCreds').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('credText').textContent); say($('pMsg'), 'Copied.', true); }
    catch { say($('pMsg'), 'Copy blocked. Select the text instead.'); }
  });

  // edit
  function openEdit(p) {
    editing = p; $('eName').value = p.name; $('eUser').value = p.username; $('ePass').value = ''; $('eMsg').textContent = '';
    $('eName').disabled = ov.status === 'active';
    $('editOv').classList.add('on'); $('eUser').focus();
  }
  $('eCancel').addEventListener('click', () => $('editOv').classList.remove('on'));
  $('editForm').addEventListener('submit', async e => {
    e.preventDefault();
    const body = { username: $('eUser').value };
    if (!$('eName').disabled) body.name = $('eName').value;
    if ($('ePass').value) body.password = $('ePass').value;
    try {
      await A('/api/admin/participants/' + editing.id, { method: 'PUT', body });
      $('editOv').classList.remove('on');
      say($('pMsg'), 'Saved.' + (body.password ? ' The new password is active and old sessions were logged out.' : ''), true);
      load();
    } catch (err) { say($('eMsg'), err.message); }
  });

  // delete
  function openDel(p) { deleting = p; $('dText').textContent = `${p.name} (${p.username}) will be removed and can no longer log in.`; $('dMsg').textContent = ''; $('delOv').classList.add('on'); $('dNo').focus(); }
  $('dNo').addEventListener('click', () => $('delOv').classList.remove('on'));
  $('dYes').addEventListener('click', async () => {
    try { await A('/api/admin/participants/' + deleting.id, { method: 'DELETE' }); $('delOv').classList.remove('on'); say($('pMsg'), 'Deleted.', true); load(); }
    catch (err) { say($('dMsg'), err.message); }
  });

  // game
  $('startBtn').addEventListener('click', async () => {
    try { const r = await A('/api/admin/game/start', { method: 'POST', body: {} }); say($('gMsg'), `Game started with ${r.emojis} presents! 🎉 Participants can now log in and pick.`, true); load(); }
    catch (err) { say($('gMsg'), err.message); }
  });
  $('resetBtn').addEventListener('click', async () => {
    try { await A('/api/admin/game/reset', { method: 'POST', body: { confirm: $('resetConfirm').value.trim() } }); $('resetConfirm').value = ''; say($('rMsg'), 'Game reset. All selections were cleared.', true); load(); }
    catch (err) { say($('rMsg'), err.message); }
  });

  // admin password
  $('pwForm').addEventListener('submit', async e => {
    e.preventDefault();
    try { await A('/api/admin/password', { method: 'PUT', body: { current: $('curPw').value, password: $('newPw').value } }); $('pwForm').reset(); say($('aMsg'), 'Password updated.', true); }
    catch (err) { say($('aMsg'), err.message); }
  });

  document.addEventListener('keydown', e => { if (e.key === 'Escape') { $('editOv').classList.remove('on'); $('delOv').classList.remove('on'); } });
  me('/admin').then(m => { $('hello').textContent = '🎅 ' + m.username; load(); setInterval(load, 15000); }).catch(() => {});
}
