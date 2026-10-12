# Smart Water Dispenser Management System
Node.js · Express · MySQL · HTML/CSS/JS

![Dashboard](docs/dashboard.png)

A full-stack system for monitoring a fleet of smart water dispensers: devices report water level and temperature to a REST API backed by MySQL, and a live dashboard shows tank levels, usage trends and alerts.

## Features
- Real-time dashboard (auto-refresh every 5 s) with status cards, per-dispenser level bars and usage charts
- Automatic alerts: low level, empty, high temperature, device offline
- Add / edit / disable / delete dispensers, refill, resolve alerts
- Device simulator for demos and testing

## Architecture
```
Devices / simulator ──HTTP──▶ Express REST API ──▶ MySQL
                                   ▲
              Dashboard (HTML/CSS/JS, polls API)
```

## Run
1. Make sure MySQL is running; edit `.env` if your credentials differ.
2. `npm install`
3. `cp .env.example .env` (first time only), then `npm run db:init`  (creates schema + sample data)
4. `npm start` → http://localhost:3000
5. Optional: `npm run simulate` for live fake traffic.

## REST API
| Method | Path | Purpose |
|---|---|---|
| GET/POST | /api/dispensers | list / create |
| GET/PUT/DELETE | /api/dispensers/:id | read / update / delete |
| POST | /api/dispensers/:id/readings | device heartbeat `{level_l, temperature_c}` |
| POST | /api/dispensers/:id/dispense | log a draw `{volume_ml}` (atomic) |
| POST | /api/dispensers/:id/refill | refill `{added_l?}` |
| GET | /api/dispensers/:id/events | recent dispenses |
| GET | /api/stats, /api/usage/daily, /api/usage/hourly | dashboard data |
| GET | /api/alerts, POST /api/alerts/:id/resolve | alerts |
| GET | /api/health | liveness + DB check |

## Reliability design
- Connection pool, parameterized queries, input validation.
- Dispense/refill/readings run in transactions with row locks (`FOR UPDATE`), so concurrent draws can't oversell water.
- Status is derived at read time (never stale); alerts are deduplicated and auto-resolve.
- Background job raises OFFLINE alerts when a device stops reporting.
- Dashboard polls every 5s, keeps last good data, and shows a Disconnected pill on failure.
- Graceful shutdown on SIGINT/SIGTERM.

## Real hardware (ESP32)
`firmware/esp32_dispenser/` contains an Arduino sketch that reports real sensor data:

| Sensor | Pin | Purpose |
|---|---|---|
| HC-SR04 ultrasonic | TRIG 5 / ECHO 18 | tank water level |
| DS18B20 | 4 | water temperature |
| YF-S201 flow sensor | 19 | volume dispensed |

1. Set `DEVICE_API_KEY` in `.env` and restart the server.
2. In the sketch set your Wi-Fi, the server's **LAN IP**, the same API key and the dispenser id.
3. Flash with Arduino IDE (libraries: OneWire, DallasTemperature).

The ESP32 sends a reading every 10 s (doubles as a heartbeat, so the dashboard shows it online) and a dispense event whenever water flows. If it stops reporting, an OFFLINE alert is raised.
