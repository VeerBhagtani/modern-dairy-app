# GPS reliability — root causes, fixes, verification

Written 2026-10-09 after the first real-phone trial showed frozen positions,
"No Signal" and unreliable kilometres. Each defect below was confirmed in
the code, and where possible reproduced by a test that fails on the old code.

## Pipeline

```
Android fused location (1 fix/s, foreground service "ride in progress")
 → app.js onLocation: keep a fix every 25 m or ~30 s
 → IndexedDB queue (saved before any upload)
 → POST /driver/rides/:id/points  {points, sentAt, health}
 → driverAuth (token, device, account) → ride ownership → clock correction
 → validation (normaliseIncomingPoint) → Firestore gps_raw (create = idempotent)
 → ride counters + driver_live (position, phone health, last contact)
 → trackingStatus (server) → GET /admin/dashboard every 20 s → map + table
 → recalculation (pipeline.js) every calcRefreshSec while new fixes arrive
```

## Confirmed defects

| # | Defect | Evidence | Fix |
|---|--------|----------|-----|
| 1 | **A phone clock off by more than 2 min lost the whole day.** Ride start is server time; fixes carry phone time. Slow clock → every fix refused "recorded before this ride started"; fast clock (>30 min) → "in the future". The app deletes refused fixes. | `gps-pipeline-api.test.mjs` "phone clock" fails on the old backend: 10/10 fixes refused. | Each upload carries `sentAt`; the server measures the phone's error and corrects every fix in the batch (≥ 1 min only). Raw phone time kept as `rawDeviceTs`. |
| 2 | **Uploads waited for 10 fixes.** Parked or slow, that is 4–5 min with nothing reaching the office: frozen marker, then "no signal". The 45 s timer is throttled by Android with the screen off. | `app.js` `if (n >= 10) sync()`. | Upload on a clock (`uploadIntervalSec`, 15 s) from the fix callback, which keeps running with the screen locked. |
| 3 | **A bare 403/404 wiped the phone's queue.** A deactivated account (403) or any 404 deleted every waiting fix for the ride. | `sync()` removed on `status 403/404`. | Server sends codes; the app drops fixes only on `RIDE_NOT_FOUND` / `NOT_YOUR_RIDE`. |
| 4 | **"Live/No signal" used the phone's clock against the server's** and only the fix age. A wrong phone clock, or any of a dozen causes, showed as "no signal". | `admin.js` `now - l.deviceTs`. | `drivers/trackingStatus.js`: LIVE, GPS unavailable, Internet disconnected, Sync pending, Stale, Tracking interrupted, Unknown, Ride stopped — from the corrected fix time and the phone's own report. |
| 5 | **The phone's state reached the office every 5 minutes at best**, and was written as an event every time. | `setInterval(reportHealth, 5 min)`; health on `writeLimiter` (30/15 min). | Health rides on every upload; a heartbeat sends it when nothing else does (`healthIntervalSec`), at once when GPS goes silent. Events only when something changes. |
| 6 | **Retries had no back-off and drained one batch per trigger.** After an hour offline, catch-up took many cycles; a failing server was hit every trigger. | `sync()`. | Exponential back-off with jitter (5 s → 5 min), reset when the network returns; up to 15 batches per run. |
| 7 | **Kilometres of a running ride refreshed every 15 minutes** and the fleet metrics never refreshed without a reload. | `FRESH_MS = 15 min`; `scheduleRefresh` updated only the table. | `calcRefreshSec` (2 min). Fixes read incrementally (`repo.loadPoints` cache), so this does not multiply Firestore reads. Metrics refresh with the table. |
| 8 | **A failed calculation or a ride with no GPS looked like 0 km.** | Fleet "Today" cell. | `calcState`: no GPS / calculating / failed (last good figure kept, marked out of date) / ok, with the time it was calculated. |
| 9 | **The dashboard's own lost connection was silent.** | `scheduleRefresh().catch(scheduleRefresh)`. | "This screen cannot reach the server … what is shown is from HH:MM", never applied to drivers. |
| 10 | **A reloaded app could leave a second native GPS watcher running.** | Watcher id held only in memory. | Id persisted; the stale watcher is removed before a new one is added. |
| 11 | **GPS spikes, parked drift, jams** (km audit, CALC 1.6.0). | `km-audit.test.mjs`. | Spike filter, stop merge, pause-on-the-way rule. |

Not defects (checked): duplicates are impossible (fix id = document id,
`create`); out-of-order batches are re-sorted; delayed fixes before an
office stop are kept, after it refused by name; drivers cannot stop rides
(server refuses); points cannot be posted to another driver's ride.

## What the office sees now

- **Live fleet → Tracking column**: the state, a sentence with the cause,
  last fix time and when the server received it.
- **Today column**: km, business/personal/unknown, "calculated HH:MM", or why
  there is no figure.
- **Tracking diagnostics** (Journeys page, or the driver's ride panel): server
  observations and phone reports side by side, report age, events, and the
  most likely cause.

## Configuration (Settings → thresholds; no deploy needed)

| Key | Default | Meaning |
|-----|---------|---------|
| `liveLocationSec` | 60 | Fix age that still counts as LIVE |
| `uploadIntervalSec` | 15 | How often the app uploads while riding |
| `healthIntervalSec` | 60 | Phone heartbeat when nothing to upload |
| `calcRefreshSec` | 120 | Max age of a running ride's km before recalculation |

## Deployment

- No database migration. New fields (`rawDeviceTs`, `clockSkewMs`,
  `driver_live.health/healthAt/lastContactAt`) are additive. The incremental
  read uses `gps_raw.serverTs`, covered by Firestore's automatic single-field
  index.
- No new environment variables or secrets.
- Backend, dashboard and APK must all be deployed. Old APKs keep working
  (no `sentAt`/health: no clock correction, fewer states).
- New readiness check: `GET /health/ready` (503 if Firestore is unreachable).
- Logs are JSON lines (`severity`, `event`, `requestId`, `driverId`, `rideId`);
  filter in Cloud Logging, e.g. `jsonPayload.event="gps_store_failed"`.

## Verification

Automated (`npm test`, 479 pass): `gps-pipeline-api` (A, B, E, F, I, J,
clocks, auth, states), `app-sync` (upload cadence, offline + back-off,
refusals, remote stop, duplicate watcher), `tracking-status`, `km-audit`
(G: noise, spikes), `simulated-journey` (K: full day with Porter detour and
personal), plus the browser check of the fleet screen (H: refresh, lost
connection, one timer, diagnostics).

Not verifiable without a phone: C (screen locked), D (backgrounded), OEM
battery killers, real upload latency. See `docs/DEVICE_TESTS.md`.

Known limits: if Android kills the app process, recording stops until the
driver opens the app (the boot notification covers restarts; a killed app
is shown to the office as STALE). Queued fixes are kept and sent on the next
open — they are not lost, but they wait. A phone clock changed mid-ride is
corrected only for fixes sent after the change.
