// Shared page shell: login check, role-based navigation, logout.
// NOTE: hiding links is only for usability; every API route is protected
// in the backend (401/403).
window.ESP = window.ESP || {};

const NAV = {
  admin: [['home.html', 'Dashboard'], ['halls.html', 'Halls'], ['exams.html', 'Exams'], ['allocation.html', 'Allocation']],
  proctor: [['home.html', 'Dashboard'], ['exams.html', 'My exams'], ['seat-map.html', 'Seat maps']],
  student: [['home.html', 'Dashboard'], ['my-seat.html', 'My seat']],
};

// const user = await ESP.initPage({ roles: ['admin'] })
ESP.initPage = async function initPage({ roles } = {}) {
  if (!ESP.session.token) { location.href = 'index.html'; return new Promise(() => {}); }
  const user = await ESP.api('/auth/me');
  const page = location.pathname.split('/').pop() || 'home.html';

  const nav = ESP.el('nav', { class: 'nav' }, (NAV[user.role] || []).map(([href, label]) =>
    ESP.el('a', { href, class: href === page ? 'active' : null }, label)));
  const logout = ESP.el('button', { type: 'button', onclick: async () => {
    try { await ESP.api('/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
    ESP.session.clear();
    location.href = 'index.html';
  } }, 'Log out');
  const header = ESP.el('header', { class: 'topbar' },
    ESP.el('div', { class: 'brand' }, 'Exam Seating Planner'), nav,
    ESP.el('div', { class: 'userbox' }, ESP.el('span', {}, user.name), ESP.el('span', { class: 'role-badge' }, user.role), logout));
  document.body.prepend(header);

  if (roles && !roles.includes(user.role)) {
    document.querySelector('main').replaceChildren(ESP.el('div', { class: 'alert error' }, 'Your role cannot use this page.'));
    return new Promise(() => {});
  }
  return user;
};
