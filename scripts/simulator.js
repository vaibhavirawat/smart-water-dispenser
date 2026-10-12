// Simulates dispensers: random users draw water, devices send heartbeats, a technician refills tanks.
// Usage: SIM_USER=admin SIM_PASSWORD=... npm run simulate   (server must be running)
// The simulator signs in as an admin (to list dispensers and refill) and uses DEVICE_API_KEY for device calls.
const BASE = process.env.API || 'http://localhost:3000/api';
let cookie = '';

async function j(path, method = 'GET', body) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.DEVICE_API_KEY || '', ...(cookie && { Cookie: cookie }) },
    body: body && JSON.stringify(body),
  });
  const set = r.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return { ok: r.ok, status: r.status, data: r.status === 204 ? null : await r.json().catch(() => ({})) };
}

(async () => {
  const { SIM_USER, SIM_PASSWORD } = process.env;
  if (!SIM_USER || !SIM_PASSWORD) {
    console.error('Set SIM_USER and SIM_PASSWORD (an admin account), e.g.\n  SIM_USER=admin SIM_PASSWORD=yourpass npm run simulate');
    process.exit(1);
  }
  const login = await j('/auth/login', 'POST', { username: SIM_USER, password: SIM_PASSWORD });
  if (!login.ok) { console.error('Login failed:', login.data.error); process.exit(1); }
  console.log(`Simulator running as ${SIM_USER}. Ctrl+C to stop.`);

  setInterval(async () => {
    try {
      const { data: list, ok } = await j('/dispensers');
      if (!ok) return console.log('Could not list dispensers:', list.error);
      for (const d of list) {
        if (!d.enabled) continue;
        const temp = +(d.temperature_c ?? 9) + (Math.random() - 0.5);
        await j(`/dispensers/${d.id}/readings`, 'POST', { temperature_c: +temp.toFixed(1) });
        if (d.level_pct < 10 && Math.random() < 0.5) {
          await j(`/dispensers/${d.id}/refill`, 'POST', {}); // technician refills
          console.log(`${d.name}: refilled`);
        } else if (Math.random() < 0.35) {
          const ml = [250, 330, 500, 750][Math.floor(Math.random() * 4)];
          const r = await j(`/dispensers/${d.id}/dispense`, 'POST', { volume_ml: ml });
          console.log(r.ok ? `${d.name}: -${ml}ml` : `${d.name}: ${r.data.error}`);
        }
      }
    } catch (e) { console.log('tick failed:', e.message); }
  }, 3000);
})();
