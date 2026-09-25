# Modern Drivers

Driver tracking and delivery-intelligence platform for **Modern Dairy, Pune**.

**This is its own product.** It shares no code, no database and no login with
the Modern Dairy ordering app. The two are separate systems that happen to
belong to the same company, and keeping them apart means neither can break the
other.

Three parts:

| | What it is |
|---|---|
| `app/` | The Android app a driver installs. Name, Start Ride, live map. |
| `dashboard/` | The website the office uses. Live map, ride control, reports. |
| `backend/` | The API both talk to. |

---

## How it works, in one page

**The driver** installs the app and types their **name** once. The app asks for
location there and then, shows them on the map, and waits. At the start of the
day they press **Start Ride**. No password, no code, nothing to remember, and
nothing recorded until that button is pressed. Their phone then records the
journey until the office stops it — a driver cannot stop their own ride, and
the server enforces that, so a modified app changes nothing.

**The office** opens the dashboard and sees every driver on a map, with the age
of each position shown honestly: a fix from four minutes ago is labelled *last
known*, never *live*.

**At the end of the day** the system splits each journey into:

- **Verified business** — Modern Dairy travel it can prove
- **Likely business** — probably, but unproven
- **Personal** — the driver's own Porter work, marked by the office in review
- **Unknown** — it genuinely cannot tell
- **GPS gap** — the phone went dark; the distance is an estimate, labelled as one

The whole design rests on one rule: **an uncertain kilometre is never quietly
added to the business total, and never quietly dropped from the day's total.**
It sits in its own column until a person decides.

### What it does not claim

- GPS cannot prove a delivery happened. A geofence hit is evidence of presence.
- GPS cannot identify a personal trip. Nothing is auto-labelled personal from
  geometry — only the office deciding so in review.
- Without order records, most restaurant visits cap at **MEDIUM** confidence.
  That is the honest ceiling, not a bug. Importing real orders is the single
  biggest accuracy improvement available.

---

## Setting it up

You need a Google Cloud project **of its own** for this product, with billing
on, and about ten minutes.

> Use a dedicated project. The database rules in this repo are a deny-all, and
> deploying them to a project that also serves another product would replace
> that product's rules.

### 1. Create the deploy credentials

In [Cloud Shell](https://console.cloud.google.com/?cloudshell=true):

```bash
PROJECT=<your-project-id>
SA=github-deployer@$PROJECT.iam.gserviceaccount.com
gcloud config set project $PROJECT

gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com \
  firebaserules.googleapis.com firebasehosting.googleapis.com firestore.googleapis.com

gcloud iam service-accounts create github-deployer --display-name="GitHub deployer"
sleep 20
# artifactregistry.admin, not .writer: a first deploy has to CREATE the
# container repository, which writer cannot do.
for R in run.admin cloudbuild.builds.editor artifactregistry.admin \
         iam.serviceAccountUser secretmanager.admin storage.admin \
         firebaserules.admin datastore.indexAdmin; do
  gcloud projects add-iam-policy-binding $PROJECT \
    --member="serviceAccount:$SA" --role="roles/$R" --quiet >/dev/null && echo "ok: $R"
done

gcloud iam service-accounts keys create key.json --iam-account=$SA
echo "Open key.json with the Cloud Shell editor — do not print it to the terminal"
```

Add two repository secrets under **Settings → Secrets and variables → Actions**:

| Name | Value |
|---|---|
| `GCP_PROJECT_ID` | your project id |
| `GCP_SA_KEY` | the contents of `key.json` |

### 2. Put the office dashboard online

Actions → **Publish the office dashboard** → Run workflow. It pushes the site to
a `gh-pages` branch, hosted free by GitHub Pages at:

```
https://<your-github-username>.github.io/<repo>/
```

**The first time only**, turn Pages on by hand — GitHub does not let a workflow
do it: **Settings → Pages → Source: _Deploy from a branch_ → Branch `gh-pages`
/ `(root)` → Save**. After that every change to `dashboard/` republishes itself.

The site asks for the **server address** on its sign-in screen the first time
and remembers it, so it works as soon as the API below is deployed, with no
rebuild. (Set a `DRIVERS_API_BASE` secret and it is baked in instead.)

### 3. Deploy the API

Actions → **Deploy** → Run workflow. It creates the signing key, deploys the
API, checks it answers, deploys the database rules, points the dashboard at the
API and deploys it. Re-runnable, and it stops rather than half-deploying.

### 4. Create your office login

Nobody can sign in until you make an account:

```bash
git clone https://github.com/<you>/modern-drivers && cd modern-drivers/backend
npm install
GCP_PROJECT_ID=<your-project-id> npm run create-admin -- --user veer --name "Veer" --role admin
```

Roles: `viewer` (read only), `manager` (+ stop rides, review journeys),
`admin` (+ thresholds and driver accounts).

### 5. Build the app

Add a repository secret `DRIVERS_API_BASE` with the API URL the deploy printed,
then Actions → **Build and publish the app**. The APK is published as a plain
file in the repository, so it downloads on any phone with no GitHub login:

```
https://github.com/<you>/<repo>/raw/gh-pages/modern-drivers.apk
```

**The app works before any of this.** With no server configured it records the
route on the phone, draws it live on the map, and says plainly that nothing has
reached the office yet. Real GPS, held locally — not a demo, and no coordinate
is ever invented. Once `DRIVERS_API_BASE` is set and the APK rebuilt, it sends
everything it has saved.

### 6. Add your locations

In the dashboard, under **Locations**:

1. **Modern Dairy depots** — nothing classifies correctly until at least one exists.
2. **Restaurants** — one at a time, or a CSV import.
3. Optionally **Deliveries → Import orders** — this is what turns *likely*
   kilometres into *verified* ones.

Drivers need nothing from you. They install the app, type their name, and register themselves;
they appear in the Drivers list, where you can switch off anyone who should not
be there.

---

## Running it locally

```bash
# API
cd backend && npm install && cp .env.example .env    # set GCP_PROJECT_ID
gcloud auth application-default login
npm run dev                                          # localhost:8080

# Dashboard
# set API_BASE in dashboard/config.js, then
npx serve dashboard

# Android app
cd app && npm install
node ../scripts/set-api-base.js https://your-api www/config.js
npx cap add android
node ../scripts/patch-manifest.js
npx @capacitor/assets generate --android
npx cap sync android && cd android && ./gradlew assembleDebug
```

or `npm run apk` from the repository root.

The native `app/android/` tree is **generated, not committed** — the app has no
hand-written native code, so committing it would mean 200+ files of generated
Gradle config to re-sync on every Capacitor bump.

---

## Tests

```bash
npm test      # 116 tests, no database and no network needed
```

The processing engine in `backend/src/drivers/` is pure — no Firestore, no
clock — which is what makes the kilometre figures reproducible and testable.
The suite covers geodesy against known distances, GPS noise filtering, the
segmentation invariants as property tests over 25 randomly generated days,
classification, delivery matching, reports, alerts, the security invariants,
and the full simulated journey from the specification:

```
Dairy → Restaurant A → B → 3 personal stops → Dairy → C → D → Dairy
```

synthesised at 30-second sampling from real Pune coordinates with GPS noise, a
six-minute tunnel gap and a 4 km multipath spike.

Manual test plans for the phone and the dashboard are in
[`docs/TESTING.md`](docs/TESTING.md). Run them before rolling out.

---

## Money

| | Roughly, per month |
|---|---|
| Nothing running | ₹0 |
| 1 driver, testing | under ₹50 |
| 40 drivers, all day, dashboard open | ₹600–1,000 |

Firestore writes dominate. Two things move the number a lot: the GPS sampling
interval (60s instead of 30s roughly halves it) and whether the dashboard sits
open all day.

Google Cloud has **no hard spending cap**. Set a budget alert.

---

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — the stack and why, the database, how GPS becomes kilometres, and what the system refuses to claim
- [`docs/TESTING.md`](docs/TESTING.md) — automated and manual test plans, and odometer field validation
- [`docs/PRIVACY.md`](docs/PRIVACY.md) — what is collected, when, who can see it, how long it is kept
- [`docs/OPERATIONS.md`](docs/OPERATIONS.md) — password rotation, backups, budget, depot, restaurant audit, APK install, rollback
- [`docs/PLAY_BACKGROUND_LOCATION.md`](docs/PLAY_BACKGROUND_LOCATION.md) — read before submitting to Google Play

## Before you trust the numbers

Run two vehicles for a week and compare the daily figure against their
odometers. Expect GPS to read a few percent low — it measures straight lines
between fixes and roads curve. Record the ratio. Do not apply a correction
factor to make one vehicle match; that is how a tracking system stops being
auditable.
