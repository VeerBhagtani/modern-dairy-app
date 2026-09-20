# Modern Drivers

Driver tracking and delivery-intelligence platform for **Modern Dairy, Pune**.

* **Android app** — one Start Ride button, full-day GPS, offline queue.
* **Admin dashboard** — live map, remote ride stop, review, reports.
* **Backend** — ingestion, segmentation, classification, matching, exports.

Read [`ARCHITECTURE.md`](ARCHITECTURE.md) first: it explains the stack, the
database, how location data is processed and how the kilometre figures are
validated. This file is how to run, test and deploy it.

---

## The one thing to understand before using it

The platform separates a driver's day into **verified business**, **likely
business**, **personal**, **unknown** and **GPS-gap** kilometres, and it will
not move a kilometre into "verified business" without evidence.

With no order data loaded, most restaurant visits cap at **MEDIUM** confidence
and land in *likely*, not *verified*. That is correct behaviour, not a
misconfiguration. The single biggest accuracy improvement available is
importing real order records (Deliveries tab → Import orders); tuning
thresholds is a distant second.

---

## Repository layout

```
backend/
  src/drivers/            the processing engine — PURE, no Firestore, no clock
    config.js             every threshold, its range, and what breaks if moved
    geo.js                haversine, geofences, centroids
    validation.js         ingest validation + per-point quality verdicts
    track.js              ordering, de-duplication, jitter filter, gaps, hops
    stops.js              dwell clustering
    segmentation.js       point/hop partition (no double-counting, by construction)
    classification.js     8 segment types, confidence, evidence
    distance.js           buckets + reconciliation
    matching.js           visits <-> delivery orders
    pipeline.js           the whole calculation, as one reproducible function
    reports.js            report definitions, CSV and Excel export
    alerts.js             operational alerts
  src/routes/driver.js        the Android app's API
  src/routes/driversAdmin.js  the dashboard's API (role-gated)
  src/services/driversRepo.js the only Firestore-facing file in the subsystem
  src/services/orderSource/   provider-agnostic order integration
  src/jobs/driversMaintenance.js  auto-close, alerts, processing, retention
  scripts/drivers-maintenance.js  CLI for the above

app/               the Modern Drivers Android app (Capacitor)
  www/index.html  www/app.js  www/branding.js  www/config.js

dashboard/            the admin dashboard (static, Firebase Hosting)
  index.html  config.js  api.js  map.js  views.js  app.js

tests/drivers/            112 automated tests, incl. the simulated journey
docs/      this documentation
```

---

## Local development

### Prerequisites

Node 20+, Java 21 and the Android SDK (only for building the APK), and a
Firebase project with Firestore in native mode.

### Backend

```bash
cd backend
npm install
cp .env.example .env          # then fill in GCP_PROJECT_ID
npm run dev                   # http://localhost:8080
```

The backend reads credentials from **Google Secret Manager**, never from `.env`.
For local work, authenticate with an account that can read them:

```bash
gcloud auth application-default login
gcloud config set project <your-project-id>
```

`jwt-signing-key` must exist in Secret Manager or every login fails:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))" \
  | gcloud secrets create jwt-signing-key --data-file=-
```

Health check: `curl http://localhost:8080/healthz`

### Admin dashboard

```bash
# point it at your backend
$EDITOR dashboard/config.js      # set API_BASE
npx serve legal                      # then open http://localhost:3000/drivers/
```

Sign in with the Firebase account whose uid matches `ADMIN_UID`. That uid must
be identical in three places — `dashboard/config.js`,
`backend/src/middleware/adminAuth.js` (`ADMIN_FIREBASE_UID`) and `isAdmin()` in
`backend/firestore.rules`.

### Driver app

```bash
cd driver-app
npm install
node ../scripts/set-drivers-api-base.js https://your-backend.example
npx cap add android                       # generates the native project
node ../scripts/patch-drivers-manifest.js # location permissions + FGS type
npx cap sync android
cd android && ./gradlew assembleDebug
```

or, from the repository root, `npm run drivers:apk`.

The native `android/` tree is **generated, not committed** — the app has no
hand-written native code, so a committed tree would be 200+ files of generated
Gradle config to keep in sync with each Capacitor bump. CI regenerates it the
same way ([`build-drivers-apk.yml`](../../.github/workflows/build-drivers-apk.yml)).

---

## Database setup

Firestore needs no schema migration — collections appear on first write — but
it does need **rules** and **indexes** deployed, and both live in this repo:

```bash
firebase deploy --only firestore:rules,firestore:indexes
```

Every query the dashboard runs is covered by
`backend/firestore.indexes.json`. A missing index shows up as a Firestore error
containing a one-click "create index" link; if you see one, add it to that file
too, or it will be missing again in the next environment.

### First-run data

1. **Facilities** — Locations tab → add each Modern Dairy site with its
   coordinates. Nothing classifies correctly until at least one exists.
2. **Restaurants** — add them, or import a CSV
   (`name, customer_id, address, lat, lng, radius_m, area, external_id, schedule, active`).
   `customer_id` must match the order system's customer key, or orders can
   never be matched to visits.
3. **Drivers** — Drivers tab → add each driver, and give them the one-time
   enrolment code it shows. The code is displayed **once**.
4. **Orders** (optional but high value) — Deliveries tab → import a CSV.

There is no seed script that invents drivers, restaurants or GPS history. Test
fixtures live only in `tests/drivers/helpers/`, are never loaded by the backend,
and must never be seeded into a real project.

### Migrations

Two kinds of change need a deliberate step:

* **Rules / indexes** — `firebase deploy --only firestore:rules,firestore:indexes`.
* **Calculation changes** — bump `CALC_VERSION` in `backend/src/drivers/config.js`,
  deploy, then Settings → Recalculate over the affected date range. Existing
  results keep the version and thresholds that produced them until you do; that
  is deliberate, so an old report stays explainable.

---

## Tests

```bash
npm run test:drivers     # 112 tests, no database or network needed
npm test                 # drivers + the existing app tests
```

The suite covers: geodesy against known distances; GPS validation and noise
filtering; the segmentation invariants (as property tests over 25 randomly
generated days); classification and confidence; delivery matching; reports and
export escaping; alerts; the security and authorisation invariants; and the
full simulated journey from the brief
(`tests/drivers/simulated-journey.test.mjs`).

Manual test plans for the Android app and the dashboard — the things a unit
test cannot reach, like killing the app mid-ride or revoking permission — are
in [`TESTING.md`](TESTING.md). Run them before any rollout.

---

## Deployment

### Backend (Cloud Run)

The existing [`deploy-backend.yml`](../../.github/workflows/deploy-backend.yml)
workflow deploys this service; the drivers routes ship with it. Environment:

| Variable | Purpose |
|---|---|
| `GCP_PROJECT_ID` | Firestore and Secret Manager project |
| `FIRESTORE_DATABASE_ID` | usually `(default)` |
| `ALLOWED_ORIGINS` | must include the dashboard origin, e.g. `https://modern-dairy-pune.web.app` |
| `ADMIN_FIREBASE_UID` | the admin uid, if it differs from the default |
| `NODE_ENV=production` | enables the HTTPS redirect |

Secrets (Secret Manager, never env vars): `jwt-signing-key`, and — only if the
GoFrugal order sync is switched on — `gofrugal-api-key`, `gofrugal-outlet-id`,
`gofrugal-company-id`.

The service account needs `roles/datastore.user` and
`roles/secretmanager.secretAccessor`.

### Dashboard (Firebase Hosting)

```bash
$EDITOR dashboard/config.js     # API_BASE for this environment
firebase deploy --only hosting
```

It is then at `https://<project>.web.app/drivers/`.

### Driver APK

Run the **Build Modern Drivers APK** workflow. It needs the
`DRIVERS_API_BASE` repository secret (an `https://` URL — the build fails on
anything else, because location data must never cross the network in the clear).
The artifact is a debug APK; for a release build, add a keystore step mirroring
the existing `build-release-aab.yml`.

### Scheduled maintenance

`drivers-maintenance.yml` runs every 15 minutes and auto-closes forgotten
rides, reconciles alerts, and processes finished rides. **Retention deletion is
a dry run there on purpose** — deleting location history is irreversible, so it
happens only when someone runs the workflow with `delete_expired = true`.

On Cloud Run instead of Actions: deploy `backend/scripts/drivers-maintenance.js`
as a Cloud Run job and trigger it from Cloud Scheduler.

### Staging vs production

Keep two Firebase projects. Nothing in the repo hardcodes an environment except
three values, each of which is set at deploy time:

| What | Where |
|---|---|
| Backend URL for the APK | `DRIVERS_API_BASE` secret → `app/www/config.js` |
| Backend URL for the dashboard | `API_BASE` in `dashboard/config.js` |
| Firebase project | `.firebaserc`, and `firebase use <alias>` |

Never point a staging APK at production: its GPS would become real tracking
records for real drivers.

---

## External services and what they cost

| Service | Required | Roughly, at 40 drivers |
|---|---|---|
| Firebase / Firestore (Blaze) | yes | ₹300–700 per month (writes dominate; ~1.7 M/month) |
| Cloud Run | yes | near zero, scales to zero overnight |
| Secret Manager | yes | ~₹10 per month |
| Firebase Hosting | yes | free tier |
| OpenFreeMap tiles | no key | ₹0 |
| Message Central / Twilio | no | only if OTP driver login is added later |
| GoFrugal API | optional | licence cost; the adapter is inert without it |

No AI or ML service is used. Every rule in the classifier is deterministic and
explainable, which is what a payroll dispute actually needs.

---

## Troubleshooting

**A driver's position says "last known", never "live".**
The phone is not delivering fixes. Check Alerts for `gps_missing` or
`tracking_permission_lost`, then the driver's own Phone health panel. The
usual cause on Xiaomi/Oppo/Vivo/realme is OEM battery management killing the
service — the app must be set to "No restrictions"/"Allow autostart". The
dashboard never paints an old fix as live, so this is visible rather than
silently wrong.

**A ride will not start: "Could not start the ride".**
Either the account is deactivated (403) or the APK has no `API_BASE`. Check the
driver's status in the Drivers tab first.

**A driver says Start Ride does nothing after a phone restart.**
Android does not guarantee that a background service survives a reboot. The app
re-attaches when it is next opened. Tell drivers: after a restart, open Modern
Drivers once.

**Everything is UNKNOWN.**
No facilities or restaurants are loaded, or their coordinates are wrong. Open a
ride, use the replay map, and check the geofences sit on the actual buildings.

**Verified business kilometres are near zero.**
Expected without order data — the work is in *likely business*. Import orders
to raise the matching visits to HIGH.

**The totals do not add up.**
They are asserted to. Open the ride: the "How this adds up" box shows the
residual. A non-zero residual is a bug — report it with the ride id.

**A report is empty but rides exist.**
Those rides have not been processed. The dashboard says so
("N ride(s) ... have not been calculated"). Run Settings → Recalculate.

**`FAILED_PRECONDITION: The query requires an index`.**
Deploy the indexes: `firebase deploy --only firestore:indexes`.

**Admin API calls return 403 "This action needs the admin role".**
Add a `drivers_admins/{adminId}` document with `role: "admin"`. The document id
is the value the backend logs as `adminId` (`firebase:<uid>` for a Firebase
login).

**The dashboard loads but every request fails with a CORS error.**
`ALLOWED_ORIGINS` on Cloud Run does not include the hosting origin.

**An import silently imported fewer rows than the file has.**
It is not silent — the result lists every skipped row and why. Rows with a
missing or invalid coordinate, or an unknown driver code, are reported rather
than guessed at.

---

## Privacy and legal

Tracking runs only between an explicit Start Ride and an admin stop. The driver
notice shown at enrolment and on the main screen is served from
`PRIVACY_NOTICE` in `backend/src/routes/driver.js`, so it can be corrected
without shipping an APK. See [`PRIVACY.md`](PRIVACY.md) for the position taken
and what still needs a lawyer's eye, and
[`PLAY_BACKGROUND_LOCATION.md`](PLAY_BACKGROUND_LOCATION.md) before submitting
to Google Play.
