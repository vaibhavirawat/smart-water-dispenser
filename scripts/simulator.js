// Simulates dispensers: random users draw water, devices send heartbeats.
// Usage: npm run simulate   (server must be running)
const BASE = process.env.API || 'http://localhost:3000/api';
const j = (path, method = 'GET', body) =>
  fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.DEVICE_API_KEY || '' }, body: body && JSON.stringify(body) })
    .then(async r => ({ ok: r.ok, data: r.status === 204 ? null : await r.json() }));

(async () => {
  console.log('Simulator running. Ctrl+C to stop.');
  setInterval(async () => {
    const { data: list } = await j('/dispensers');
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
  }, 3000);
})();
