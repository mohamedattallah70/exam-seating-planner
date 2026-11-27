// Shared fetch wrapper + small DOM helpers used by every page.
// Data is always inserted with textContent (never innerHTML) to prevent XSS.
window.ESP = window.ESP || {};

ESP.ApiError = class extends Error {
  constructor(status, error) {
    super(error?.message || `Request failed (${status})`);
    this.status = status;
    this.code = error?.code;
    this.details = error?.details;
  }
};

ESP.session = {
  get token() { return sessionStorage.getItem('esp_token'); },
  get user() { try { return JSON.parse(sessionStorage.getItem('esp_user')); } catch { return null; } },
  save(token, user) { sessionStorage.setItem('esp_token', token); sessionStorage.setItem('esp_user', JSON.stringify(user)); },
  clear() { sessionStorage.removeItem('esp_token'); sessionStorage.removeItem('esp_user'); },
};

// ESP.api('/exams', { method: 'POST', body: {...} })
ESP.api = async function api(path, { method = 'GET', body, query } = {}) {
  const url = new URL(ESP_CONFIG.API_BASE + path);
  if (query) Object.entries(query).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v); });
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (ESP.session.token) headers.Authorization = `Bearer ${ESP.session.token}`;

  let res;
  try {
    res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new ESP.ApiError(0, { code: 'NETWORK', message: 'Cannot reach the server. Is the backend running?' });
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (res.status === 401 && !path.startsWith('/auth/login')) {
    ESP.session.clear();
    location.href = 'index.html?expired=1';
  }
  if (!res.ok) throw new ESP.ApiError(res.status, data?.error);
  return data;
};

// el('td', { class: 'x', onclick: fn }, 'text', childNode)
ESP.el = function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
};

// Renders an API error (with field details) into a container.
ESP.showError = function showError(container, err) {
  container.replaceChildren(ESP.el('div', { class: 'alert error' },
    ESP.el('strong', {}, err.message || 'Something went wrong'),
    err.details?.length ? ESP.el('ul', {}, err.details.map((d) => ESP.el('li', {}, d.field ? `${d.field}: ${d.message}` : (d.message || JSON.stringify(d))))) : null));
};

ESP.toast = function toast(message, type = 'ok') {
  let box = document.getElementById('toast');
  if (!box) { box = ESP.el('div', { id: 'toast' }); document.body.append(box); }
  const item = ESP.el('div', { class: `alert ${type}` }, message);
  box.append(item);
  setTimeout(() => item.remove(), 4500);
};

ESP.fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }) : '');
ESP.fmtTime = (t) => (t ? String(t).slice(0, 5) : '');
