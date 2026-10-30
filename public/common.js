// Small helpers shared by all pages.
export const $ = (sel) => document.querySelector(sel);

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export async function api(method, path, body, headers = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export const isoDay = (offset = 0) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

export function nav(active) {
  const links = [
    ['/', 'Home'], ['/authority', 'Licence office'], ['/rent', 'Car rental'], ['/wallet', 'Demo wallet'],
  ];
  return `<div class="wrap"><p class="logo">🪪 DriveProof</p><nav>${links
    .map(([href, label]) => `<a href="${href}" class="${href === active ? 'active' : ''}">${label}</a>`)
    .join('')}</nav></div>`;
}
