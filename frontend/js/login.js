const msg = document.getElementById('msg');
if (new URLSearchParams(location.search).has('expired')) {
  msg.replaceChildren(ESP.el('div', { class: 'alert warn' }, 'Your session has ended. Please log in again.'));
}
if (ESP.session.token) location.href = 'home.html';

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const identifier = document.getElementById('identifier').value.trim();
  const password = document.getElementById('password').value;
  if (!identifier || !password) {
    msg.replaceChildren(ESP.el('div', { class: 'alert error' }, 'Enter your email/student code and password.'));
    return;
  }
  const btn = document.getElementById('submit');
  btn.disabled = true;
  try {
    const { token, user } = await ESP.api('/auth/login', { method: 'POST', body: { identifier, password } });
    ESP.session.save(token, user);
    location.href = 'home.html';
  } catch (err) {
    ESP.showError(msg, err);
  } finally {
    btn.disabled = false;
  }
});
