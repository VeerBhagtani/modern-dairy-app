# Modern Drivers — Android app

The driver's half of the platform: one big **Start Ride** button, an honest
tracking status, and nothing else to get in the way.

Full documentation is in [`docs/modern-drivers/`](../docs/modern-drivers/).

## Build

```bash
npm install
node ../scripts/set-drivers-api-base.js https://your-backend.example
npx cap add android                        # generates the native project
node ../scripts/patch-drivers-manifest.js  # location permissions + FGS type
npx cap sync android
cd android && ./gradlew assembleDebug
```

Or, from the repository root: `npm run drivers:apk`.
CI does the same in `.github/workflows/build-drivers-apk.yml`.

## Why `android/` is not committed

The app has no hand-written native code. A committed native tree would be 200+
files of generated Gradle config to re-sync on every Capacitor bump, and it
would drift. It is generated instead, and the one thing `cap add` does not know
about — the background-location permissions and the Android 14
`foregroundServiceType` — is applied by
[`scripts/patch-drivers-manifest.js`](../scripts/patch-drivers-manifest.js),
which is committed, idempotent, and runs in CI.

## Files

| File | What it is |
|---|---|
| `www/index.html` | the whole UI: enrolment, status, ride, health, account |
| `www/app.js` | queueing, syncing, the foreground-service watcher, state |
| `www/branding.js` | name, logo, colours — change these to rebrand, nothing else reads them |
| `www/config.js` | `API_BASE` and intervals; the committed copy is empty on purpose |
| `capacitor.config.json` | app id `in.moderndairy.drivers` |

## Behaviour worth knowing

**It never invents a location.** Only fixes the OS actually produced are
stored. If the phone gives nothing, the day has a gap, and the backend reports
it as a gap rather than interpolating over it.

**It never loses one either.** Points go into IndexedDB first and are deleted
only when the server confirms them by id. A dead zone, a force-stop or a flat
battery costs delay, not data.

**A point id is `<deviceId>:<monotonic seq>`**, persisted across restarts, and
it becomes the Firestore document id. A replayed upload therefore overwrites
itself instead of double-counting the kilometres.

**The driver cannot stop a ride.** There is no button, and the server refuses
the request and records the attempt. Only the office can stop one.

**A driver can mark a stretch personal.** That can only ever move kilometres
*out* of the business total, never in — which is why it is safe to let a driver
influence the classification at all.

**Status is honest.** "Tracking is on" means the watcher is running *and* fixes
are arriving. Weak signal, offline-with-queue, permission blocked and GPS off
each say so in their own words, and the office sees the same state.

## Known Android limitations

* **OEM battery managers** (Xiaomi, Oppo, Vivo, realme — common in this fleet)
  kill background services aggressively. The app detects the resulting gaps and
  reports them; it cannot prevent them. Drivers must set the app to "No
  restrictions" / allow autostart.
* **After a phone restart**, Android does not guarantee a background service
  resumes. The app re-attaches to the running ride when it is next opened. Tell
  drivers: after a restart, open Modern Drivers once. The app does not pretend
  otherwise.
* **"While using the app"** permission works, but tracking stops when the
  screen locks. The app says so rather than appearing to work.
