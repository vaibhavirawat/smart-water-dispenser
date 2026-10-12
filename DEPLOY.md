# Deploying online (HTTPS)

The app is a single Node service plus a MySQL database. Any host that can run the `Dockerfile` and give you a MySQL
database works. These steps use **Railway** (it offers MySQL natively); the same variables apply elsewhere.

## 1. Put the code on GitHub
Already done if you pushed this repo. `.env` and `.env.docker` are git-ignored, so no secrets are uploaded.

## 2. Create the project on Railway
1. Sign in at https://railway.com with GitHub → **New Project** → **Deploy from GitHub repo** → pick this repo.
   Railway detects the `Dockerfile` and builds it.
2. In the same project click **+ New** → **Database** → **Add MySQL**.
3. Open the app service → **Variables** and add:

| Variable | Value |
|---|---|
| `MYSQL_URL` | `${{MySQL.MYSQL_URL}}` (Railway's reference to the database it just made) |
| `SESSION_SECRET` | output of `openssl rand -hex 32` |
| `ADMIN_USERNAME` | e.g. `admin` |
| `ADMIN_PASSWORD` | a strong password (8+ chars); creates the first admin on first start |
| `COOKIE_SECURE` | `true` |
| `TRUST_PROXY` | `1` |
| `BASE_URL` | your public address, e.g. `https://smart-water.up.railway.app` (set after step 4) |
| `DEVICE_API_KEY` | `openssl rand -hex 16`, the same key goes into the ESP32 sketch |
| `SEED_DEMO` | `false` for an empty system, or leave unset for sample dispensers |
| `ALLOW_SIGNUP` | `true` or `false` |

4. App service → **Settings → Networking → Generate Domain**. Copy the address into `BASE_URL`, then redeploy.
5. Open the address: you should get the login page over HTTPS. Sign in with the admin account from the variables.

On every start the container creates missing tables, migrates old ones and creates the admin only if no users exist.

## 3. Password-reset email
Without email settings, reset links are only printed in the service logs. For real email add SMTP variables
(any provider: Gmail app password, Brevo, Resend, Mailgun...):

| Variable | Example |
|---|---|
| `SMTP_HOST` | `smtp.gmail.com` |
| `SMTP_PORT` | `587` |
| `SMTP_USER` / `SMTP_PASS` | your account / an *app password* |
| `SMTP_FROM` | `Smart Water <you@gmail.com>` |

Then open 🔑 in the dashboard and add an email to your admin account so it can be reset too.

## 4. Other hosts
- **Managed MySQL elsewhere** (Aiven, TiDB Cloud, PlanetScale-compatible...): set `DATABASE_URL=mysql://user:pass@host:port/db`
  and `DB_SSL=true` if the provider requires TLS.
- **Render / Fly / a VPS**: run the same Docker image, set the same variables, and make sure traffic arrives over HTTPS.
  Behind a reverse proxy always set `TRUST_PROXY=1`, otherwise every visitor looks like the proxy's IP and the rate limits
  (login, sign-up, reset) apply to everyone together.

## 5. Connect real devices / the simulator
- ESP32: in the sketch set `SERVER` to your `https://...` address and `API_KEY` to `DEVICE_API_KEY`.
- Simulator against the deployed app:
  ```bash
  API=https://YOUR-DOMAIN/api SIM_USER=admin SIM_PASSWORD='...' DEVICE_API_KEY=... npm run simulate
  ```

## Security checklist before sharing the link
- [ ] `SESSION_SECRET` is random and private (the app refuses to start in production without it).
- [ ] `COOKIE_SECURE=true` and you only use the `https://` address.
- [ ] `TRUST_PROXY=1` behind a platform proxy.
- [ ] Strong `ADMIN_PASSWORD`; consider `ALLOW_SIGNUP=false` if the dashboard shouldn't be open to strangers.
- [ ] `DEVICE_API_KEY` set (otherwise anyone who can reach the server can post readings).
- [ ] Database is not exposed publicly (on Railway use the private reference variable).

Known limits: the rate limiter lives in memory (resets on restart, one instance only), and the free tiers of most
hosts sleep when idle, so the first request after a pause can be slow.
