const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let dispensers = [], editingId = null, failures = 0, isAdmin = false;

async function api(path, method = 'GET', body) {
  const r = await fetch('/api' + path, {
    method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  const data = r.status === 204 ? null : await r.json().catch(() => ({}));
  if (r.status === 401 && !path.startsWith('/auth/login')) { location.href = '/login.html'; throw new Error('Login required'); }
  if (!r.ok) throw new Error(data?.error || `Request failed (${r.status})`);
  return data;
}

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2500);
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

function renderCards(s) {
  const items = [
    ['Dispensers', s.total], ['Healthy', s.ok], ['Low / Empty', s.low + s.empty],
    ['Offline', s.offline], ['Used today (L)', s.today_liters.toFixed(1)],
    ['Dispenses today', s.today_dispenses], ['Open alerts', s.open_alerts],
  ];
  $('#cards').innerHTML = items.map(([l, v]) => `<div class="card"><div class="v">${v}</div><div class="l">${l}</div></div>`).join('');
}

function renderTable() {
  const f = $('#filter').value;
  const list = dispensers.filter(d => !f || d.status === f);
  $('#rows').innerHTML = list.length ? list.map(d => `
    <tr>
      <td><b>${esc(d.name)}</b></td>
      <td>${esc(d.location)}</td>
      <td><span class="bar"><i style="width:${d.level_pct}%;background:${barColor(d)}"></i></span>${d.level_l.toFixed(1)} / ${d.capacity_l} L <small>(${d.level_pct}%)</small></td>
      <td>${d.temperature_c != null ? d.temperature_c + '°C' : '–'}</td>
      <td>${(d.today_ml / 1000).toFixed(1)} L</td>
      <td><span class="badge ${d.status}">${d.status}</span></td>
      <td><small>${ago(d.last_seen)}</small></td>
      <td>${!isAdmin ? '' : `
        <button class="sm" data-act="refill" data-id="${d.id}">Refill</button>
        <button class="sm" data-act="toggle" data-id="${d.id}">${d.enabled ? 'Disable' : 'Enable'}</button>
        <button class="sm" data-act="edit" data-id="${d.id}">Edit</button>
        <button class="sm" data-act="delete" data-id="${d.id}">✕</button>`}
      </td>
    </tr>`).join('') : '<tr><td colspan="8" class="empty">No dispensers match.</td></tr>';
}

function renderAlerts(list) {
  $('#alerts').innerHTML = list.length ? list.map(a => `
    <li><div><span class="t">${a.type.replace('_', ' ')}</span><br>${esc(a.message)} <small class="muted">${ago(a.created_at)}</small></div>
    ${isAdmin ? `<button class="sm" data-resolve="${a.id}">Resolve</button>` : ''}</li>`).join('') : '<li class="empty">No open alerts 🎉</li>';
}

function barChart(el, data, label) {
  const W = 400, H = 180, pad = { l: 28, b: 22, t: 8 };
  const max = Math.max(1, ...data.map(d => d.v));
  const bw = (W - pad.l) / data.length;
  let out = [0, 0.5, 1].map(f => {
    const y = pad.t + (H - pad.t - pad.b) * (1 - f);
    return `<line x1="${pad.l}" x2="${W}" y1="${y}" y2="${y}" stroke="var(--line)"/><text x="0" y="${y + 3}">${(max * f).toFixed(max < 5 ? 1 : 0)}</text>`;
  }).join('');
  data.forEach((d, i) => {
    const h = (H - pad.t - pad.b) * (d.v / max);
    out += `<rect x="${pad.l + i * bw + 2}" y="${H - pad.b - h}" width="${bw - 4}" height="${h}" rx="2"><title>${d.x}: ${d.v} L</title></rect>`;
    if (label(i, data.length)) out += `<text x="${pad.l + i * bw + bw / 2}" y="${H - 6}" text-anchor="middle">${d.x}</text>`;
  });
  el.innerHTML = out;
}

async function refresh() {
  try {
    const [s, ds, al, daily, hourly] = await Promise.all([
      api('/stats'), api('/dispensers'), api('/alerts'), api('/usage/daily?days=7'), api('/usage/hourly'),
    ]);
    dispensers = ds;
    renderCards(s); renderTable(); renderAlerts(al);
    barChart($('#daily'), daily.map(d => ({ x: d.date.slice(5), v: d.liters })), () => true);
    barChart($('#hourly'), hourly.map(h => ({ x: h.hour, v: h.liters })), i => i % 3 === 0);
    failures = 0;
    $('#conn').className = 'pill ok'; $('#conn').textContent = '● Live';
    $('#updated').textContent = 'Updated ' + new Date().toLocaleTimeString();
  } catch (e) {
    // keep showing last good data; flag the connection
    if (++failures >= 2) { $('#conn').className = 'pill bad'; $('#conn').textContent = '● Disconnected'; }
  }
}

// ----- actions -----
$('#rows').addEventListener('click', async e => {
  const b = e.target.closest('button[data-act]'); if (!b) return;
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
});
$('#alerts').addEventListener('click', async e => {
  const id = e.target.dataset.resolve; if (!id) return;
  try { await api(`/alerts/${id}/resolve`, 'POST'); refresh(); } catch (err) { toast(err.message); }
});
$('#filter').addEventListener('change', renderTable);

// ----- form -----
const dlg = $('#dlg'), form = $('#form');
function openForm(d) {
  editingId = d?.id ?? null;
  $('#dlgTitle').textContent = d ? 'Edit dispenser' : 'Add dispenser';
  form.name.value = d?.name ?? ''; form.location.value = d?.location ?? '';
  form.capacity_l.value = d?.capacity_l ?? 20; form.level_l.value = d?.level_l ?? 0;
  form.level_l.disabled = !!d; // level is controlled by sensors/refills when editing
  $('#formErr').textContent = ''; dlg.showModal();
}
$('#addBtn').onclick = () => openForm();
$('#cancel').onclick = () => dlg.close();
form.addEventListener('submit', async e => {
  e.preventDefault();
  const body = { name: form.name.value, location: form.location.value, capacity_l: +form.capacity_l.value };
  if (editingId === null) body.level_l = +form.level_l.value;
  try {
    await (editingId === null ? api('/dispensers', 'POST', body) : api(`/dispensers/${editingId}`, 'PUT', body));
    dlg.close(); toast('Saved'); refresh();
  } catch (err) { $('#formErr').textContent = err.message; }
});

$('#logout').onclick = async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  location.href = '/login.html';
};

(async () => {
  const me = await api('/auth/me');          // redirects to login on 401
  isAdmin = me.role === 'admin';
  $('#who').textContent = `${me.username} (${me.role})`;
  $('#addBtn').hidden = !isAdmin;
  refresh();
  setInterval(refresh, 5000);
})();
