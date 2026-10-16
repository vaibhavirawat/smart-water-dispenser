// Built-in demo data, shown (read-only) when the dashboard cannot reach the server.
// It mirrors the shape of /api/dashboard, /api/dispensers/:id/history|events|refills exactly (see test/features.test.js).
(function (root) {
  const MIN = 60e3, HOUR = 3600e3;
  const BASE = [
    // id, name, location, capacity, level, temp, today ml, avg ml/h, status override
    [9001, 'Lobby Dispenser', 'Main Building - Lobby', 20, 17.5, 8.2, 4250, 160],
    [9002, 'Library Dispenser', 'Library - 2nd Floor', 20, 11.0, 9.0, 3100, 140],
    [9003, 'Cafeteria Dispenser', 'Cafeteria', 30, 4.2, 10.5, 9800, 460],
    [9004, 'Gym Dispenser', 'Sports Complex', 30, 25.0, 7.8, 1500, 90],
    [9005, 'Lab Dispenser', 'Science Block - Lab 3', 20, 14.3, 8.9, 2250, 120],
  ];

  function dispensers(now = Date.now()) {
    return BASE.map(([id, name, location, cap, level, temp, todayMl, perHour], i) => {
      const pct = (level / cap) * 100;
      const low = pct < 20;
      return {
        id, name, location, capacity_l: cap, level_l: level, temperature_c: temp, enabled: true,
        low_level_pct: null, high_temp_c: null, caretaker_username: null, last_seen: new Date(now - (4 + i * 3) * 1000).toISOString(),
        created_at: new Date(now - 30 * 24 * HOUR).toISOString(),
        today_ml: todayMl, used_24h_ml: perHour * 24,
        level_pct: Math.round(pct * 10) / 10, status: low ? 'LOW' : 'OK',
        effective_low_pct: 20, effective_high_temp_c: 25,
        avg_ml_per_hour: perHour, hours_to_empty: Math.round(((level * 1000) / perHour) * 10) / 10,
      };
    });
  }

  function dashboard(now = Date.now()) {
    const ds = dispensers(now);
    const alerts = [{
      id: 9001, dispenser_id: 9003, dispenser_name: 'Cafeteria Dispenser', type: 'LOW_LEVEL',
      message: 'Cafeteria Dispenser is low (14%)', resolved: 0, created_at: new Date(now - 25 * MIN).toISOString(), resolved_at: null,
    }];
    const daily = [];
    for (let i = 6; i >= 0; i--)
      daily.push({ date: new Date(now - i * 24 * HOUR).toLocaleDateString('en-CA'), liters: [92, 104, 98, 110, 87, 101, 76][6 - i] });
    const shape = [0, 0, 0, 0, 0, 0, 1, 3, 7, 9, 8, 11, 14, 12, 9, 8, 10, 9, 6, 4, 2, 1, 0, 0];
    const cutoff = new Date(now).getHours(); // today so far only
    const hourly = shape.map((v, h) => ({ hour: h, liters: h <= cutoff ? v : 0 }));
    return {
      stats: {
        total: ds.length, ok: ds.filter(d => d.status === 'OK').length, low: ds.filter(d => d.status === 'LOW').length,
        empty: 0, offline: 0, disabled: 0,
        today_liters: ds.reduce((s, d) => s + d.today_ml, 0) / 1000, today_dispenses: 64, open_alerts: alerts.length,
      },
      dispensers: ds, alerts, daily, hourly,
      complaints: [], // complaints need the server, so the offline demo has none
    };
  }

  // A smooth, gently falling level curve for the detail chart (oldest first, one point every 15 min for 24 h).
  function history(id, now = Date.now()) {
    const d = dispensers(now).find(x => x.id === id);
    if (!d) return [];
    const pts = [];
    for (let i = 95; i >= 0; i--) {
      const level = Math.min(d.capacity_l, d.level_l + (d.avg_ml_per_hour * (i * 0.25)) / 1000 + Math.sin(i / 7) * 0.15);
      pts.push({ level_l: Math.round(level * 100) / 100, temperature_c: d.temperature_c, created_at: new Date(now - i * 15 * MIN).toISOString() });
    }
    return pts;
  }

  const events = (id, now = Date.now()) => dispensers(now).some(d => d.id === id)
    ? [250, 500, 330, 750, 250, 500].map((ml, i) => ({ id: 9000 + i, volume_ml: ml, created_at: new Date(now - (i * 17 + 3) * MIN).toISOString() }))
    : [];
  const refills = (id, now = Date.now()) => dispensers(now).some(d => d.id === id)
    ? [{ id: 9001, added_l: 12, created_at: new Date(now - 2 * 24 * HOUR).toISOString() }]
    : [];

  const api = { dashboard, history, events, refills };
  if (typeof module !== 'undefined') module.exports = api;
  else root.SAMPLE = api;
})(typeof window !== 'undefined' ? window : globalThis);
