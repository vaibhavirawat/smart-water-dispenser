const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

let dispensers = [], editingId = null, failures = 0, isAdmin = false, me = null;
let view = store.get('swd_view', 'cards');
const tankEls = new Map(); // id -> element, so water levels animate instead of re-rendering

// ---------- api / helpers ----------
async function api(path, method = 'GET', body) {
  const r = await fetch('/api' + path, {
    method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401 && !path.startsWith('/auth/password')) { location.href = '/login.html'; throw new Error('Login required'); }
  const data = r.status === 204 ? null : await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error || `Request failed (${r.status})`);
  return data;
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2600);
}
function ago(d) {
  if (!d) return 'never';
  const s = Math.max(0, (Date.now() - new Date(d)) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
const barColor = d => d.status === 'EMPTY' ? 'var(--red)' : d.status === 'LOW' ? 'var(--amber)' : 'var(--blue)';

// ---------- theme ----------
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  $('#themeBtn').textContent = t === 'dark' ? '☀️' : '🌙';
}
$('#themeBtn').onclick = () => {
  const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  store.set('swd_theme', t); applyTheme(t);
};
applyTheme(document.documentElement.dataset.theme);

// ---------- stat cards (with count-up) ----------
function renderCards(s) {
  const items = [
    ['Dispensers', s.total, 0], ['Healthy', s.ok, 0], ['Low / Empty', s.low + s.empty, 0],
    ['Offline', s.offline, 0], ['Used today (L)', s.today_liters, 1],
    ['Dispenses today', s.today_dispenses, 0], ['Open alerts', s.open_alerts, 0],
  ];
  const box = $('#cards');
  if (!box.children.length)
    box.innerHTML = items.map(([l]) => `<div class="card"><div class="v" data-v="0">0</div><div class="l">${l}</div></div>`).join('');
  [...box.children].forEach((c, i) => countTo(c.querySelector('.v'), items[i][1], items[i][2]));
}
function countTo(el, target, dp) {
  const from = +el.dataset.v || 0; el.dataset.v = target;
  if (from === target || matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = target.toFixed(dp); return; }
  const t0 = performance.now();
  (function step(t) {
    const k = Math.min(1, (t - t0) / 700), e = 1 - Math.pow(1 - k, 3);
    el.textContent = (from + (target - from) * e).toFixed(dp);
    if (k < 1) requestAnimationFrame(step);
  })(t0);
}

// ---------- dispenser list ----------
const SEV = { EMPTY: 0, OFFLINE: 1, LOW: 2, OK: 3, DISABLED: 4 };
function visible() {
  const q = $('#search').value.trim().toLowerCase(), f = $('#filter').value, sort = $('#sort').value;
  const list = dispensers.filter(d => (!f || d.status === f) && (!q || (d.name + ' ' + d.location).toLowerCase().includes(q)));
  const cmp = {
    name: (a, b) => a.name.localeCompare(b.name),
    level: (a, b) => a.level_pct - b.level_pct,
    status: (a, b) => SEV[a.status] - SEV[b.status] || a.level_pct - b.level_pct,
    usage: (a, b) => b.today_ml - a.today_ml,
  }[sort];
  return list.sort(cmp);
}

function actionButtons(d) {
  return isAdmin ? `
    <button class="sm" data-act="refill" data-id="${d.id}">Refill</button>
    <button class="sm" data-act="toggle" data-id="${d.id}">${d.enabled ? 'Disable' : 'Enable'}</button>
    <button class="sm" data-act="edit" data-id="${d.id}">Edit</button>
    <button class="sm danger" data-act="delete" data-id="${d.id}" aria-label="Delete">✕</button>` : '';
}

function tankHTML(d) {
  return `<div class="tank"><div class="water"></div><div class="pct"></div></div>
    <div class="tinfo"><b></b><div class="muted loc"></div><span class="badge"></span>
      <div class="row"><span>Level</span><span class="lv"></span></div>
      <div class="row"><span>Temperature</span><span class="tp"></span></div>
      <div class="row"><span>Used today</span><span class="td"></span></div>
      <div class="row"><span>Last seen</span><span class="ls"></span></div>
      <div class="btns"></div></div>`;
}
function fillTank(el, d) {
  el.dataset.id = d.id;
  el.querySelector('.tank').className = `tank st-${d.status}`;
  el.querySelector('.water').style.height = Math.max(0, Math.min(100, d.level_pct)) + '%';
  el.querySelector('.pct').textContent = Math.round(d.level_pct) + '%';
  el.querySelector('b').textContent = d.name;
  el.querySelector('.loc').textContent = d.location;
  const b = el.querySelector('.badge'); b.className = `badge ${d.status}`; b.textContent = d.status;
  el.querySelector('.lv').textContent = `${d.level_l.toFixed(1)} / ${d.capacity_l} L`;
  el.querySelector('.tp').textContent = d.temperature_c != null ? d.temperature_c + '°C' : '–';
  el.querySelector('.td').textContent = (d.today_ml / 1000).toFixed(1) + ' L';
  el.querySelector('.ls').textContent = ago(d.last_seen);
  const btns = el.querySelector('.btns'), html = actionButtons(d);
  if (btns.dataset.h !== html) { btns.innerHTML = html; btns.dataset.h = html; }
}

function renderList() {
  const list = visible(), host = $('#list');
  $('#vCards').classList.toggle('on', view === 'cards');
  $('#vTable').classList.toggle('on', view === 'table');

  if (!list.length) { host.innerHTML = '<div class="empty">No dispensers match.</div>'; tankEls.clear(); return; }

  if (view === 'cards') {
    let grid = host.querySelector('.tanks');
    if (!grid) { host.innerHTML = '<div class="tanks"></div>'; grid = host.firstChild; tankEls.clear(); }
    const keep = new Set(list.map(d => d.id));
    for (const [id, el] of tankEls) if (!keep.has(id)) { el.remove(); tankEls.delete(id); }
    list.forEach((d, i) => {
      let el = tankEls.get(d.id);
      if (!el) {
        el = document.createElement('article'); el.className = 'tank-card'; el.innerHTML = tankHTML(d);
        el.style.animationDelay = i * 0.05 + 's'; tankEls.set(d.id, el);
        fillTank(el, d); // level starts at 0 → animates up on next frame
        const w = el.querySelector('.water'), target = w.style.height; w.style.height = '0%';
        grid.appendChild(el); requestAnimationFrame(() => requestAnimationFrame(() => w.style.height = target));
      } else fillTank(el, d);
      if (grid.children[i] !== el) grid.insertBefore(el, grid.children[i] || null);
    });
  } else {
    tankEls.clear();
    host.innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Location</th><th>Water level</th><th>Temp</th><th>Today</th><th>Status</th><th>Last seen</th><th></th></tr></thead>
      <tbody>${list.map(d => `
        <tr class="click" data-id="${d.id}">
          <td><b>${esc(d.name)}</b></td><td>${esc(d.location)}</td>
          <td><span class="bar"><i style="width:${d.level_pct}%;background:${barColor(d)}"></i></span>${d.level_l.toFixed(1)} / ${d.capacity_l} L <small>(${d.level_pct}%)</small></td>
          <td>${d.temperature_c != null ? d.temperature_c + '°C' : '–'}</td>
          <td>${(d.today_ml / 1000).toFixed(1)} L</td>
          <td><span class="badge ${d.status}">${d.status}</span></td>
          <td><small>${ago(d.last_seen)}</small></td>
          <td>${actionButtons(d)}</td>
        </tr>`).join('')}</tbody></table></div>`;
  }
}

function renderAlerts(list) {
  $('#alerts').innerHTML = list.length ? list.map(a => `
    <li><div><span class="t">${esc(a.type.replace('_', ' '))}</span><br>${esc(a.message)} <small class="muted">${ago(a.created_at)}</small></div>
    ${isAdmin ? `<button class="sm" data-resolve="${a.id}">Resolve</button>` : ''}</li>`).join('')
    : '<li class="empty" style="justify-content:center">No open alerts 🎉</li>';
}

function barChart(el, data, label) {
  const W = el.viewBox.baseVal.width, H = 180, pad = { l: 30, b: 22, t: 8 };
  const max = Math.max(1, ...data.map(d => d.v)), bw = (W - pad.l) / data.length;
  let out = [0, 0.5, 1].map(f => {
    const y = pad.t + (H - pad.t - pad.b) * (1 - f);
    return `<line x1="${pad.l}" x2="${W}" y1="${y}" y2="${y}" stroke="var(--line)"/><text x="0" y="${y + 3}">${(max * f).toFixed(max < 5 ? 1 : 0)}</text>`;
  }).join('');
  data.forEach((d, i) => {
    const h = (H - pad.t - pad.b) * (d.v / max);
    out += `<rect class="bar-r" x="${pad.l + i * bw + 2}" y="${H - pad.b - h}" width="${bw - 4}" height="${h}" rx="2"><title>${d.x}: ${d.v} L</title></rect>`;
    if (label(i)) out += `<text x="${pad.l + i * bw + bw / 2}" y="${H - 6}" text-anchor="middle">${d.x}</text>`;
  });
  el.innerHTML = out;
}

async function refresh() {
  try {
    const [s, ds, al, daily, hourly] = await Promise.all([
      api('/stats'), api('/dispensers'), api('/alerts'), api('/usage/daily?days=7'), api('/usage/hourly'),
    ]);
    dispensers = ds;
    renderCards(s); renderList(); renderAlerts(al);
    barChart($('#daily'), daily.map(d => ({ x: d.date.slice(5), v: d.liters })), () => true);
    barChart($('#hourly'), hourly.map(h => ({ x: h.hour, v: h.liters })), i => i % 2 === 0);
    failures = 0;
    $('#conn').className = 'pill ok'; $('#conn').textContent = '● Live';
    $('#updated').textContent = 'Updated ' + new Date().toLocaleTimeString();
  } catch (e) {
    if (++failures >= 2) { $('#conn').className = 'pill bad'; $('#conn').textContent = '● Disconnected'; }
  }
}

// ---------- list interactions ----------
async function handleAction(b) {
  const d = dispensers.find(x => x.id == b.dataset.id);
  try {
    switch (b.dataset.act) {
      case 'refill': await api(`/dispensers/${d.id}/refill`, 'POST', {}); toast(`${d.name} refilled`); break;
      case 'toggle': await api(`/dispensers/${d.id}`, 'PUT', { enabled: !d.enabled }); break;
      case 'delete': if (confirm(`Delete ${d.name} and all its history?`)) await api(`/dispensers/${d.id}`, 'DELETE'); break;
      case 'edit': return openForm(d);
    }
    refresh();
  } catch (err) { toast(err.message); }
}
$('#list').addEventListener('click', e => {
  const b = e.target.closest('button[data-act]');
  if (b) return handleAction(b);
  const row = e.target.closest('[data-id]');
  if (row) openDetail(+row.dataset.id);
});
$('#alerts').addEventListener('click', async e => {
  const id = e.target.dataset.resolve; if (!id) return;
  try { await api(`/alerts/${id}/resolve`, 'POST'); refresh(); } catch (err) { toast(err.message); }
});
['#search', '#filter', '#sort'].forEach(s => $(s).addEventListener('input', () => { store.set('swd_sort', $('#sort').value); renderList(); }));
document.querySelectorAll('[data-view]').forEach(b => b.onclick = () => { view = b.dataset.view; store.set('swd_view', view); $('#list').innerHTML = ''; renderList(); });
document.addEventListener('keydown', e => {
  if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); $('#search').focus(); }
});
document.querySelectorAll('dialog').forEach(dlg => {
  dlg.addEventListener('click', e => { if (e.target === dlg || e.target.closest('[data-close]')) dlg.close(); }); // backdrop / ✕ / Cancel
});

// ---------- detail dialog ----------
function lineChart(el, pts, cap) {
  const W = 560, H = 200, p = { l: 34, r: 8, t: 10, b: 22 };
  if (pts.length < 2) { el.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle">Not enough data yet</text>`; return; }
  const t0 = +new Date(pts[0].created_at), t1 = +new Date(pts[pts.length - 1].created_at) || t0 + 1;
  const X = t => p.l + ((t - t0) / Math.max(1, t1 - t0)) * (W - p.l - p.r);
  const Y = v => p.t + (1 - v / cap) * (H - p.t - p.b);
  const step = Math.max(1, Math.floor(pts.length / 120)), s = pts.filter((_, i) => i % step === 0 || i === pts.length - 1);
  const line = s.map((q, i) => `${i ? 'L' : 'M'}${X(+new Date(q.created_at)).toFixed(1)} ${Y(q.level_l).toFixed(1)}`).join('');
  const hm = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  let out = [0, .5, 1].map(f => `<line x1="${p.l}" x2="${W - p.r}" y1="${Y(cap * f)}" y2="${Y(cap * f)}" stroke="var(--line)"/><text x="0" y="${Y(cap * f) + 3}">${(cap * f).toFixed(0)}L</text>`).join('');
  out += `<path class="area" d="${line}L${X(t1)} ${Y(0)}L${X(t0)} ${Y(0)}Z"/><path class="line" d="${line}"/>`;
  out += `<text x="${p.l}" y="${H - 5}">${hm(t0)}</text><text x="${W - p.r}" y="${H - 5}" text-anchor="end">${hm(t1)}</text>`;
  out += s.map(q => `<circle cx="${X(+new Date(q.created_at))}" cy="${Y(q.level_l)}" r="6" fill="transparent"><title>${hm(q.created_at)} – ${q.level_l.toFixed(1)} L</title></circle>`).join('');
  el.innerHTML = out;
}
async function openDetail(id) {
  const d = dispensers.find(x => x.id === id); if (!d) return;
  $('#dName').textContent = d.name; $('#dSub').textContent = d.location;
  $('#dStats').innerHTML = [
    ['Level', `${d.level_l.toFixed(1)} / ${d.capacity_l} L`], ['Status', d.status], ['Temp', d.temperature_c != null ? d.temperature_c + '°C' : '–'],
    ['Today', (d.today_ml / 1000).toFixed(1) + ' L'], ['Last seen', ago(d.last_seen)],
  ].map(([k, v]) => `<div><b>${esc(v)}</b><span>${k}</span></div>`).join('');
  $('#dChart').innerHTML = ''; $('#dEvents').innerHTML = '<li class="muted">Loading…</li>';
  $('#detail').showModal();
  try {
    const [hist, ev] = await Promise.all([api(`/dispensers/${id}/history?hours=24`), api(`/dispensers/${id}/events`)]);
    lineChart($('#dChart'), hist, d.capacity_l);
    $('#dEvents').innerHTML = ev.length ? ev.slice(0, 15).map(e =>
      `<li><span>${e.volume_ml} ml</span><span class="muted">${new Date(e.created_at).toLocaleString()}</span></li>`).join('')
      : '<li class="muted">No dispenses yet</li>';
  } catch (e) { $('#dEvents').innerHTML = `<li class="err">${esc(e.message)}</li>`; }
}

// ---------- add / edit form ----------
const dlg = $('#dlg'), form = $('#form');
function openForm(d) {
  editingId = d?.id ?? null;
  $('#dlgTitle').textContent = d ? 'Edit dispenser' : 'Add dispenser';
  form.name.value = d?.name ?? ''; form.location.value = d?.location ?? '';
  form.capacity_l.value = d?.capacity_l ?? 20; form.level_l.value = d?.level_l ?? 0;
  form.level_l.disabled = !!d;
  $('#formErr').textContent = ''; dlg.showModal();
}
$('#addBtn').onclick = () => openForm();
form.addEventListener('submit', async e => {
  e.preventDefault();
  const body = { name: form.name.value, location: form.location.value, capacity_l: +form.capacity_l.value };
  if (editingId === null) body.level_l = +form.level_l.value;
  try {
    await (editingId === null ? api('/dispensers', 'POST', body) : api(`/dispensers/${editingId}`, 'PUT', body));
    dlg.close(); toast('Saved'); refresh();
  } catch (err) { $('#formErr').textContent = err.message; }
});

// ---------- users (admin) ----------
async function loadUsers() {
  const users = await api('/users');
  $('#userList').innerHTML = users.map(u => `
    <li><span><b>${esc(u.username)}</b> <span class="badge ${u.role === 'admin' ? 'OK' : 'OFFLINE'}">${u.role}</span></span>
    ${u.username === me.username ? '<span class="muted">you</span>' : `<span>
      <button class="sm" data-role="${esc(u.username)}" data-to="${u.role === 'admin' ? 'viewer' : 'admin'}">Make ${u.role === 'admin' ? 'viewer' : 'admin'}</button>
      <button class="sm danger" data-del="${esc(u.username)}">Remove</button></span>`}</li>`).join('');
}
$('#usersBtn').onclick = async () => { $('#userErr').textContent = ''; $('#usersDlg').showModal(); try { await loadUsers(); } catch (e) { $('#userErr').textContent = e.message; } };
$('#userList').addEventListener('click', async e => {
  if (e.target.dataset.role) {
    try { await api(`/users/${encodeURIComponent(e.target.dataset.role)}/role`, 'PUT', { role: e.target.dataset.to }); loadUsers(); }
    catch (err) { $('#userErr').textContent = err.message; }
    return;
  }
  const u = e.target.dataset.del; if (!u || !confirm(`Remove user ${u}?`)) return;
  try { await api('/users/' + encodeURIComponent(u), 'DELETE'); loadUsers(); } catch (err) { $('#userErr').textContent = err.message; }
});
$('#userForm').addEventListener('submit', async e => {
  e.preventDefault(); const f = e.target; $('#userErr').textContent = '';
  try {
    await api('/users', 'POST', { username: f.username.value.trim(), password: f.password.value, role: f.role.value });
    f.reset(); toast('User added'); loadUsers();
  } catch (err) { $('#userErr').textContent = err.message; }
});

// ---------- password ----------
$('#pwBtn').onclick = () => { $('#pwForm').reset(); $('#pwErr').textContent = ''; $('#pwDlg').showModal(); };
$('#pwForm').addEventListener('submit', async e => {
  e.preventDefault(); const f = e.target;
  try {
    await api('/auth/password', 'POST', { current_password: f.current.value, new_password: f.next.value });
    $('#pwDlg').close(); toast('Password updated');
  } catch (err) { $('#pwErr').textContent = err.message; }
});

// ---------- header ----------
$('#exportBtn').onclick = () => { location.href = '/api/export/events.csv?days=30'; };
$('#logout').onclick = async () => { await fetch('/api/auth/logout', { method: 'POST' }); location.href = '/login.html'; };

(async () => {
  me = await api('/auth/me');
  isAdmin = me.role === 'admin';
  $('#who').textContent = `${me.username} · ${me.role}`;
  $('#addBtn').hidden = $('#usersBtn').hidden = !isAdmin;
  $('#sort').value = store.get('swd_sort', 'name');
  await refresh();
  setInterval(refresh, 5000);
})();
