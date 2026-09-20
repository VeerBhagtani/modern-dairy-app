# Modern Drivers — Architecture

Driver tracking and delivery-intelligence platform for **Modern Dairy, Pune** (~40 drivers).

This document is Step 1 of the implementation workflow: the architecture, the
technology choices and *why*, the database design, how location data is
processed, and how the business-kilometre numbers are validated. Read it
before the code.

---

## 1. What the system is actually for

A driver's working day looks like this:

```
Modern Dairy → Restaurant A → Restaurant B → Personal customer 1 → 2 → 3
             → Modern Dairy → Restaurant C → Restaurant D → Modern Dairy
```

The platform records the **whole** day, then separates it into

* kilometres that are **confidently** Modern Dairy business travel,
* kilometres that are **probably** business but not proven,
* kilometres that are **personal / Porter** work,
* kilometres nobody can classify yet,
* kilometres lost to GPS gaps or invalid data.

The hard part is not the GPS. It is **not lying about what the GPS proves.**
Every design decision below follows from one rule:

> Uncertain distance is never silently added to the business total and never
> silently dropped from the day total. It is shown, separately, until a human
> reviews it.

### What this system deliberately does NOT claim

* GPS alone **cannot** prove a delivery happened. A geofence hit is evidence of
  presence, not of a delivery.
* GPS alone **cannot** identify a personal trip. Nothing is auto-labelled
  `PERSONAL` from geometry — see §6.
* Consumer phone GPS in a dense city is accurate to roughly 5–50 m and worse
  between buildings. Distances are reported to 0.1 km, never to metres, because
  finer precision would be fiction.
* Odometer-grade accuracy is not achievable from 30-second GPS sampling.
  Typical error on a city route is a few percent, and it is *not* symmetric:
  under-sampling loses distance, GPS noise adds it. The filters in §5 are tuned
  to bias toward losing a little rather than inventing a lot.

---

## 2. Technology stack and why

| Layer | Choice | Why this one |
|---|---|---|
| Driver app | **Capacitor 6 + vanilla HTML/JS**, packaged as an Android APK | The repo already ships a Capacitor app, an Android project, a signing keystore and a GitHub Actions APK build. A second Capacitor app reuses all of it. A driver app is one button and a status panel — React Native or native Kotlin would add a toolchain for no user-visible gain, and every Modern Dairy developer can already edit HTML. |
| Background GPS | **`@capacitor-community/background-geolocation`** | Already a dependency. Wraps Android's foreground-location service, owns the persistent notification Android requires, survives screen-off/minimise, and exposes permission + provider state so the app can show honest tracking health. |
| Local queue | **IndexedDB** in the driver app | Survives app kill and reboot; holds unsent points through a dead zone and replays them in order. `localStorage` is too small and synchronous. |
| Backend API | **Node 20 + Express**, on **Cloud Run** | Already the backend for this repo (same auth middleware, rate limiter, validators, Secret Manager, deploy workflow). Cloud Run scales to zero — 40 drivers is a rounding error of traffic, so the bill stays near the free tier. |
| Database | **Firestore (native mode)** | Already the datastore. Serverless, no instance to patch, per-document security rules, and a real-time listener API that gives the admin map live updates with no websocket server to run. Its weakness — no spatial index — does not bite here (see §4.4). |
| Distance/geo maths | **Own code**, `backend/src/drivers/geo.js` | Haversine plus filtering is ~100 lines and must be *auditable and reproducible*. A dependency here would be a liability, not a convenience. |
| Map | **MapLibre GL** (vendored in the repo) + **OpenFreeMap** tiles | Free, no API key, no per-view billing, open licence. The tile URL is one constant (`MAP_STYLE` in `dashboard/config.js`) so swapping to Mapbox/Google later is a one-line change. |
| Real-time | **Firestore snapshot listeners** on `driver_live/*` and `rides/*` | Sub-second updates to the dashboard with zero extra infrastructure. Reconnection, backoff and offline caching are handled by the SDK. |
| Auth | **Enrolment code → JWT** for drivers; existing **Firebase Auth admin uid + admin JWT** for staff | Drivers get no password to forget and no SMS bill. See §3. |
| Road-distance | **None (straight-line + dense sampling)** | A routing/map-matching API (Google Roads, Valhalla) would improve accuracy but costs money per request and introduces a provider that can silently change its answers. The interface `distanceProvider` in `track.js` is where one plugs in later. |
| AI/ML | **None** | Every requirement here is solved by deterministic, explainable rules. A model that guesses "personal vs business" would be unauditable, unreviewable in a payroll dispute, and worse than an honest `UNKNOWN`. |

### Paid / external services

| Service | Needed? | Cost at 40 drivers |
|---|---|---|
| Firebase (Blaze) | Yes | Firestore writes dominate: see §4.5. Roughly ₹300–700/month. |
| Cloud Run | Yes | Near zero; scales to zero outside working hours. |
| Google Secret Manager | Yes | ~₹10/month. |
| OpenFreeMap tiles | Free | ₹0, no key. |
| Message Central / Twilio SMS | **Optional** | Only if OTP driver login is switched on. Enrolment codes need no SMS. |
| GoFrugal API | Optional | Only for order import; the adapter is inert until credentials exist. |
| Google Roads API | Not used | Listed only because it is the upgrade path for road-snapped distance. |

---

## 3. Identity, roles and the ride-stop rule

```
Driver           name + phone number (self-registration)  →  driver JWT (access 30 m / refresh 90 d)
Admin / Manager  Firebase Auth uid  or  admin JWT          →  admin scope
```

* A driver token carries `type:'driver_access'`, `sub:<driverId>` and the device id. **Every**
  driver-facing route re-reads the driver document and refuses if the driver is
  deactivated — a valid token on a disabled account is worthless.
* A driver can only ever address their **own** `driverId`; the id is taken from
  the token, never from the request body. Routes that accept a `rideId` verify
  the ride belongs to the token's driver.
* **A driver cannot stop a ride.** There is no code path that lets them. The
  route `POST /driver/rides/:rideId/stop` exists *only* to return `403`, write a
  `tracking_event` of kind `unauthorized_ride_control` and raise an alert — so a
  tampered client is recorded rather than merely rejected. Stopping is
  `POST /admin/drivers/rides/:rideId/stop`, behind `requireAdmin`, and it demands
  a reason.
* Roles: `admin` (everything), `manager` (view + review + stop rides),
  `viewer` (read-only). Enforced server-side by `requireRole()` in `routes/driversAdmin.js`, on top of the existing `requireAdmin()` gate.
* Rides cannot run forever: `autoStopAfterHours` (default 16) closes a forgotten
  ride, and the closure is written as `status:'auto_closed'` with
  `stoppedBy:'system:timeout'` and the configured threshold recorded on the ride.
  Nothing ever stops silently.

---

## 4. Database design (Firestore)

Firestore is document-oriented, so "normalised" here means: one collection per
entity, ids as foreign keys, no duplicated mutable facts, and denormalised
*immutable* copies only where a historical record must not change under us
(e.g. a match stores the restaurant coordinates it matched against).

### 4.1 Collections

| Collection | Key | Purpose | Notable fields |
|---|---|---|---|
| `drivers` | `driverId` (uuid) | Driver master record | `driverCode` (unique, human: `MD-014`), `name`, `phone`, `status`, `vehicleId`, `enrolment.codeHash`, `enrolment.expiresAt`, `deviceId` |
| `vehicles` | `vehicleId` | Optional vehicle assignment | `registration`, `type`, `activeDriverId` |
| `drivers_admins` | `uid`/`username` | Dashboard user roles | `role`, `name` |
| `rides` | `rideId` (uuid) | One working day of one driver | `driverId`, `dayKey`, `status`, `startedAt`, `stoppedAt`, `stoppedBy`, `stopReason`, `lastPointAt`, `pointCount` |
| `rides/{rideId}/gps_raw` | `pointId` = `clientPointId` | **Immutable raw GPS.** Never edited, never deleted by processing | `lat`, `lng`, `deviceTs`, `serverTs`, `accuracyM`, `speedMps`, `headingDeg`, `provider`, `batteryPct`, `isMoving` |
| `driver_live` | `driverId` | One doc, last known position — what the live map listens to | `lat`, `lng`, `deviceTs`, `serverTs`, `accuracyM`, `rideId`, `rideStatus` |
| `ride_processing` | `rideId` | Output of the pipeline (§5) | `calcVersion`, `processedAt`, `distance{}`, `quality{}`, `stopCount` |
| `ride_processing/{rideId}/segments` | `segmentId` (`seg_0007`) | Segments with classification + evidence | `type`, `confidence`, `evidence[]`, `distanceM`, `startTs`, `endTs`, `placeId`, `needsReview` |
| `segment_reviews` | auto | **Append-only** manual classification history | `rideId`, `segmentId`, `fromType`, `toType`, `reason`, `note`, `reviewerId`, `at`, `revertedBy` |
| `restaurants` | `placeId` | Delivery locations | `name`, `customerId`, `address`, `lat`, `lng`, `radiusM`, `active`, `area`, `schedule`, `externalId` |
| `facilities` | `placeId` | Modern Dairy sites | `name`, `lat`, `lng`, `radiusM`, `isStartPoint`, `active` |
| `delivery_orders` | `orderId` | Imported order records — **never fabricated** | `source`, `externalId`, `customerId`, `assignedDriverId`, `orderedAt`, `deliveredAt`, `windowStart/End`, `status` |
| `delivery_matches` | auto | Visit ↔ order matching results | `rideId`, `segmentId`, `orderId`, `outcome`, `confidence`, `evidence[]`, `reviewedBy` |
| `tracking_events` | auto | Health/anomaly log | `driverId`, `rideId`, `kind`, `detail`, `at` |
| `drivers_alerts` | auto | Operational alerts + resolution | `kind`, `severity`, `driverId`, `status`, `raisedAt`, `resolvedAt`, `resolvedBy` |
| `integration_logs` | auto | Every order-source sync | `source`, `op`, `ok`, `count`, `error`, `at` |
| `drivers_audit_log` | auto | Admin actions | `adminId`, `action`, `target`, `before`, `after`, `at` |
| `drivers_config` | `singleton` | Live thresholds (§5.6) | see `backend/src/drivers/config.js` |

### 4.2 Keys and integrity

* Primary keys are document ids. Foreign keys are plain string ids
  (`driverId`, `rideId`, `placeId`, `orderId`) validated with `isValidId()`
  before any path is built from them — a Firestore path is a string, so an
  unvalidated id is a path-traversal bug.
* **Duplicate active rides are impossible**: the ride is created inside a
  Firestore transaction that re-reads `rides where driverId == X and
  status == 'active'`, and the driver document holds `activeRideId`, written in
  the same transaction. A second Start Ride returns the *existing* ride.
* **Duplicate GPS points are impossible**: the point's document id is the
  `clientPointId` (a per-device monotonic `deviceId:seq` string). A replayed
  batch overwrites itself byte-for-byte instead of double-counting. The write
  uses `create`-semantics with a fallback so a retry is a no-op, not an edit.
* `driverCode` uniqueness is enforced by a `drivers_codes/{code}` reservation
  document written in the creating transaction.

### 4.3 Indexes

Added to `backend/firestore.indexes.json`:

```
rides:            driverId ASC, startedAt DESC
rides:            status ASC, startedAt DESC
rides:            dayKey ASC, driverId ASC
gps_raw (CG):     deviceTs ASC                 ← collection-group, for replay
delivery_orders:  assignedDriverId ASC, orderedAt DESC
delivery_orders:  customerId ASC, orderedAt DESC
delivery_matches: rideId ASC, outcome ASC
segment_reviews:  rideId ASC, at DESC
tracking_events:  driverId ASC, at DESC
drivers_alerts:   status ASC, raisedAt DESC
```

Every query the dashboard runs is either a document read or one of these.

### 4.4 Why no spatial index is needed

The only geospatial query is "which known place is this stop inside?".
Modern Dairy has on the order of 10² restaurants and a handful of facilities —
a few kilobytes. The backend loads the place list once, caches it for 5 minutes,
and does the containment test in memory with a bounding-box pre-filter. A
PostGIS deployment would be strictly more infrastructure for a linear scan over
a list that fits in a CPU cache. **If the place list ever passes ~10,000**, add a
geohash prefix field and query by prefix; the seam is `placesRepo.listActive()`.

### 4.5 Scale and retention

One driver at a 30-second interval over a 12-hour day:

```
12 h × 120 points/h  = 1,440 points/day/driver
× 40 drivers         = 57,600 writes/day
× 30 days            ≈ 1.73 M writes/month   ≈ ₹300–600/month of Firestore writes
Storage: ~250 bytes/point ⇒ ~14 MB/day ⇒ ~5 GB/year
```

That is comfortable. It is also why points are uploaded in **batches of up to
200 in one `BulkWriter` commit** rather than one HTTP request per fix.

Retention (`drivers_config.retention`), all configurable:

* `rawGpsDays` (default 180) — raw points are deleted after this by
  `backend/src/jobs/retention.js`, and **only** after the ride has processed
  results, so reports stay auditable.
* `processedDays` (default 1095) — segments, distances and audit stay 3 years.
* Audit, review history and alerts are **never** auto-deleted inside the
  retention window; deleting them would defeat their purpose.
* Archival: rides older than `rawGpsDays` keep `ride_processing` (a few kB each)
  and lose only the point cloud. Export the point cloud to Cloud Storage first
  if it must be kept longer — `retention.js` supports an `archiveTo` hook.

---

## 5. How location data is processed

`backend/src/drivers/` is **pure**: every function takes plain arrays/objects
and returns plain objects. No Firestore, no clock, no network. That is what
makes the numbers reproducible and testable, and it is why the whole pipeline
can be re-run over the raw points at any time to produce a new, versioned
answer without touching the originals.

```
gps_raw (immutable)
   │
   ├─ validation.js   reject impossible points, keep the reason
   ├─ track.js        order, de-duplicate, drop noise, detect gaps, measure distance
   ├─ stops.js        dwell clustering → stops with centroid + duration
   ├─ segmentation.js stops + travel legs → an ordered segment list
   ├─ classification.js  rules + evidence + confidence → segment types
   ├─ matching.js     stops ↔ delivery_orders → matched / possible / unmatched
   └─ distance.js     buckets + reconciliation
   │
   └→ ride_processing (versioned, replaceable, never overwrites raw)
```

### 5.1 Validation (`validation.js`)

A point is **rejected** (never deleted — stored with a reason) when:

| Reason | Test |
|---|---|
| `bad_coords` | lat ∉ [-90,90], lng ∉ [-180,180], or exactly (0,0) |
| `bad_timestamp` | not finite, before 2020, or more than `clockSkewMin` ahead of server time |
| `bad_accuracy` | accuracy negative, or > `rejectAccuracyM` (default 200 m) |
| `implausible_jump` | implied speed from the previous kept point > `maxSpeedMps` (default 33 m/s ≈ 120 km/h) |
| `duplicate` | same `clientPointId`, or identical (ts, lat, lng) as the previous point |

`bad_accuracy` and `implausible_jump` points are excluded from **distance** but
still shown on the replay map in grey, so a reviewer can see what was thrown
away and why.

### 5.2 Distance (`track.js`)

* Haversine on the WGS-84 mean radius (6 371 008.8 m) between consecutive kept
  points. Over 30-second city hops the error versus Vincenty is < 0.5 m.
* Movement under `minMoveM` (default 12 m) is treated as **GPS jitter while
  parked** and contributes zero. Without this, a phone sitting at a restaurant
  for 20 minutes accumulates hundreds of metres of fictional travel.
* A hop that spans a **gap** longer than `gapSeconds` (default 300 s) is *not*
  added to the measured total. It is recorded separately as
  `gapEstimateM`, method `"straight_line_estimate"`, because the driver
  certainly travelled *something* and pretending it was zero is as wrong as
  pretending the straight line was the real route.
* Each hop is attributed to exactly one segment, by point index range. A point
  index belongs to one and only one segment, which is what makes
  double-counting structurally impossible rather than merely unlikely.
* Every distance carries a `method`: `measured` (dense GPS),
  `estimated` (bridged a gap), or `inferred` (derived, e.g. per-order splits).

### 5.3 Stops (`stops.js`)

A stop is a run of consecutive points that stay within `stopRadiusM`
(default 60 m) of their running centroid for at least `stopMinDwellSec`
(default 180 s). Output: centroid, entry/exit times, dwell, point range.
A traffic light does not qualify; a delivery does.

### 5.4 Segments (`segmentation.js`)

The day becomes a strictly ordered, gapless alternation:

```
[travel] [stop] [travel] [stop] … [travel]
```

Adjacent index ranges share no point. `sum(segment.distanceM) + gapEstimateM`
equals the day's total by construction — the reconciliation check in §5.7 is
therefore a real assertion about the code, not a hope.

### 5.5 Classification (`classification.js`)

Each segment gets a `type`, a `confidence` and an **evidence array** — the list
of facts the rule used. The dashboard shows the evidence next to the verdict,
because a number a manager cannot explain to a driver is worthless.

Stops:

| Situation | Type | Confidence |
|---|---|---|
| Inside a Modern Dairy facility geofence | `MODERN_DAIRY_DEPARTURE` (first) / `RETURN_TO_MODERN_DAIRY` | HIGH |
| Inside a restaurant geofence **and** a matching delivery order exists for that customer/driver/day | `LIKELY_RESTAURANT_VISIT` | HIGH |
| Inside a restaurant geofence, dwell ≥ `visitMinDwellSec` , no order data | `LIKELY_RESTAURANT_VISIT` | MEDIUM |
| Inside a restaurant geofence, dwell short, or two restaurants overlap the stop | `LIKELY_RESTAURANT_VISIT` | LOW → `needsReview` |
| Driver declared the stop personal | `PERSONAL_OR_NON_BUSINESS` | MEDIUM |
| Anything else | `UNKNOWN` | UNKNOWN → `needsReview` |

Travel legs take the **weaker** of their two endpoints:

| Endpoints | Type | Confidence |
|---|---|---|
| business anchor → business anchor, both HIGH | `TRAVEL_BETWEEN_BUSINESS_LOCATIONS` | HIGH |
| facility → first business stop | `MODERN_DAIRY_DEPARTURE` | HIGH |
| last business stop → facility | `RETURN_TO_MODERN_DAIRY` | HIGH |
| one endpoint business, one unknown | `UNKNOWN` | LOW |
| both endpoints declared/reviewed personal | `PERSONAL_OR_NON_BUSINESS` | MEDIUM |
| contains a data gap | `GPS_GAP_OR_INVALID_DATA` | UNKNOWN |

**The three rules that matter most**

1. Nothing becomes `PERSONAL` from geometry alone. Only a driver declaration or
   an admin review does that. Geometry can only ever say `UNKNOWN`.
2. Nothing becomes `BUSINESS` because it is *near* a restaurant. It must be
   inside the configured geofence and satisfy a dwell rule.
3. A restaurant visit is never evidence that a delivery occurred. That is the
   separate matching engine (§6), and its verdict is a separate field.

Thresholds are all in `drivers_config` and documented with their limitations in
`backend/src/drivers/config.js`.

### 5.6 Configurable thresholds

`config.js` holds the defaults, the allowed range, and a one-line note on what
goes wrong if you move each one. `drivers_config/singleton` overrides them at
runtime; every override is audit-logged and stamped onto the processing result,
so an old report can always be explained by the thresholds that produced it.

### 5.7 Reconciliation

```
totalMeasuredM = verifiedBusinessM + likelyBusinessM + personalM + unknownM + invalidM
dayTotalM      = totalMeasuredM + gapEstimateM
```

`distance.js` computes both sides and returns `reconciliation.ok` plus the
residual in metres. If it is ever non-zero, the API returns it — visibly — in
`quality.reconciliationResidualM` instead of quietly rounding it away.

**Only HIGH-confidence business distance is `verifiedBusinessKm`.** MEDIUM is
reported as `likelyBusinessKm`, next to it, never inside it.

---

## 6. Personal / Porter trips

GPS cannot tell a Porter drop from a delivery. The system therefore does not
guess. Three honest inputs are supported:

1. **Driver declaration** in the app: "this next stretch is personal". It is
   timestamped, recorded as `evidence: driver_declared`, and it can only *move
   distance out of* the business total — never into it. That asymmetry is what
   makes it safe to let a driver touch the classification at all.
2. **Order records**: a stop with a matching order is business, with evidence.
3. **Admin review**: the final word, appended as a new decision (§7).

Everything else stays `UNKNOWN` and visible.

---

## 7. Review and audit

A manual review **never** edits a segment's original classification and
**never** touches `gps_raw`. It appends to `segment_reviews`, and the segment
document gains `currentReview` pointing at the newest decision. Reverting
appends another decision. The full chain — who, when, from what, to what, why —
is queryable and exportable (report 12).

---

## 8. How the business-distance calculation is validated

Four independent layers, all in `tests/drivers/`:

1. **Unit tests on known geometry.** Haversine against published reference
   distances (Pune landmarks), a square loop whose perimeter is known exactly,
   a stationary noisy cloud that must yield ~0 km.
2. **Property tests.** For randomly generated tracks: segments partition the
   points exactly once; bucket sum equals the measured total; re-running the
   pipeline on the same input yields a byte-identical result
   (`determinism`); and reordering the input batches changes nothing.
3. **The simulated journey** (`simulated-journey.test.mjs`): the full
   Dairy → A → B → 3 personal stops → Dairy → C → D route, synthesised at 1 Hz
   from real Pune coordinates with injected GPS noise, a 6-minute tunnel gap and
   one 3 km teleport spike. It asserts every requirement of Part 20: the whole
   journey is recorded, restaurant visits are *likely* not certain, personal
   legs are never auto-classified business, unknown stays visible, the verified
   total excludes uncertain kilometres, nothing is double-counted, review works,
   and the raw points are unchanged afterwards.
4. **Field validation (manual, documented in [`TESTING.md`](TESTING.md) §4).**
   Before trusting the numbers operationally, run one vehicle for a week with
   its odometer read at start and end of each day and compare. Expect the GPS
   total to read a few percent low. Record the ratio; do **not** "correct" the
   code to match a single vehicle.

---

## 9. Data flow

```
 Android (Modern Drivers)
   Start Ride ──POST /driver/rides/start──► backend ── transaction ──► rides/{id} (active)
   foreground service → fixes (30 s)
        → IndexedDB queue
        → POST /driver/rides/{id}/points  (batches ≤200, clientPointId dedupe)
                     │
                     ├─► rides/{id}/gps_raw/*        (immutable)
                     ├─► driver_live/{driverId}      (last known — live map)
                     └─► tracking_events             (stale/permission/gap)

 Admin dashboard (legal/drivers)
   Firestore listener  ← driver_live/*, rides/*        (live markers, honest staleness)
   REST (admin JWT/Firebase) ── /admin/drivers/**      (CRUD, stop ride, review, reports)

 Nightly / on demand
   processRide(rideId) ─► ride_processing/{rideId} + segments   (versioned)
   syncOrders()       ─► delivery_orders  (manual CSV today, GoFrugal adapter ready)
   matchRide(rideId)  ─► delivery_matches
   rideTimeout()      ─► auto-close forgotten rides (audited)
   retention()        ─► delete raw points past the window
```

---

## 10. Privacy position (India)

* Tracking runs **only** between an explicit Start Ride and an admin stop. There
  is no code path that starts tracking otherwise; there is no hidden mode.
* The driver app shows, on its main screen and in a consent notice accepted at
  enrolment: what is collected, why, who can see it, how long it is kept, and
  that the employer stops the ride, not the driver.
* Android's persistent foreground notification stays visible the entire time.
* Location data is readable only by authenticated admin roles; Firestore rules
  deny every client read of `gps_raw` and `driver_live` outright — they are
  served through the backend, under a role check, or through the admin site's
  Firebase identity.
* Retention is finite and configurable, and deletion is real (§4.5).
* Aligned with the DPDP Act 2023 principles of notice, purpose limitation, data
  minimisation and storage limitation. **This is an engineering position, not
  legal advice — have counsel review the driver notice before rollout.**

---

## 11. Known limitations (read before promising anything)

1. Android OEM battery managers (Xiaomi, Oppo, Vivo, realme — common in this
   fleet) kill background services aggressively. The app detects the resulting
   gaps and reports them; it cannot prevent them. Drivers must whitelist the app,
   and the dashboard surfaces who has not.
2. Distance is straight-line between fixes, so it under-reads on curved roads
   and in traffic. Map-matching is the upgrade path, at a per-request cost.
3. A restaurant inside a mall or a dense market may sit within two geofences.
   Those stops are flagged `LOW` / `needsReview` by design, not resolved.
4. Without order data from GoFrugal, most restaurant visits cap at **MEDIUM**
   confidence. The single highest-value improvement to accuracy is importing
   real orders — not tuning any threshold.
5. Personal-trip separation is only as good as the driver declarations and the
   admin reviews behind it. With neither, those kilometres correctly land in
   `unknown`, and the unknown bucket will be large at first.
6. Phone clocks can be wrong or deliberately changed. Server receipt time is
   stored alongside device time and large skews are flagged, but a driver with
   root can still feed false GPS. Detection (mock-location flag, impossible
   speeds) is implemented; prevention is not possible from user space.
