{
  const { api, say, decorate, GIFT_SVG } = window.Santa;
  decorate();
  document.getElementById('gift').outerHTML = GIFT_SVG;
  const role = document.body.dataset.role;
  const form = document.getElementById('loginForm'), msg = document.getElementById('msg'), go = document.getElementById('go');

  // already logged in with the right role? skip the form
  api('/api/me').then(m => { if (m.role === role) location.href = role === 'admin' ? '/admin/dashboard' : '/play'; }).catch(() => {});

  form.addEventListener('submit', async e => {
    e.preventDefault();
    go.disabled = true; say(msg, 'Checking…', true);
    try {
      const r = await api('/api/login', { method: 'POST', body: {
        role, username: document.getElementById('username').value, password: document.getElementById('password').value } });
      say(msg, 'Welcome! Opening…', true);
      location.href = r.redirect;
    } catch (err) {
      say(msg, err.message);
      document.getElementById('password').value = '';
      document.getElementById('password').focus();
      go.disabled = false;
    }
  });
  document.getElementById('username').focus();
}
