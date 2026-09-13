# Deployment

One runbook, in order. Everything that can be checked automatically is checked
by `npm run preflight` and by CI; what is left here is the work that needs a
console this repo cannot reach.

Deeper detail lives in [`backend/DEPLOY.md`](backend/DEPLOY.md) (Cloud Run),
[`PLAY_STORE_LISTING.md`](PLAY_STORE_LISTING.md) and
[`IOS_IPA_BUILD.md`](IOS_IPA_BUILD.md).

---

## What "deployed" means today

Two things, and it is worth being exact about which:

| Piece | State | Deployed by |
|---|---|---|
| Android app (Capacitor + `www/`) | ships in **DEMO** mode — data lives on the device | `Build Signed Release AAB` |
| Order mirror → Firestore | **LIVE** — placed orders reach the admin panel | in the app bundle |
| `backend/firestore.rules` | **LIVE and load-bearing** — the only enforcement layer | `Deploy Firebase` |
| Admin panel, rider app, legal pages (`legal/`) | Firebase Hosting | `Deploy Firebase` |
| Express API (`backend/`) | **written, not deployed** — needs Blaze billing | `Deploy Backend (Cloud Run)` |

Because the API is dormant, **the Firestore rules are the whole security
boundary.** Deploy them with the workflow, never by hand: the workflow runs
`npm run test:rules` against a real emulator first, and a text-level check has
already missed a genuine bypass in these rules once.

### The one limitation to go in with your eyes open

There is still no server-side authentication. Identity is a per-install
anonymous Firebase UID, so a block against a UID is defeated by reinstalling
the app, and a forged price is *detected* after the write (by
`verify-order-prices`, hourly) rather than prevented. Closing that needs the
Cloud Run backend, which needs Blaze. Everything below is safe to ship as a
pilot; none of it makes that sentence untrue.

---

## 0. Verify before anything

```bash
npm ci && (cd backend && npm ci)
npm run preflight     # tree is deployable: no credentials, placeholders intact, targets exist
npm run test:all      # 8 suites incl. the Firestore rules on a real emulator (needs Java)
```

CI (`.github/workflows/ci.yml`) runs both on every push and pull request. A red
CI is a blocked deploy — there is no path in the workflows that packages or
publishes anything without these passing first.

## 1. Rotate what has already leaked

The git history of this public repo permanently contains a live GST API key and
secret, an OTP provider bearer token, and an admin password. History rewriting
does not un-leak them; only rotation does.

- [ ] Rotate the sandbox.co.in GST key + secret; put the new pair in GitHub
      Actions secrets (`GST_API_KEY`, `GST_API_SECRET`) — never in a file.
- [ ] Rotate the Message Central OTP credential (`OTP_CUSTOMER_ID`,
      `OTP_AUTH_TOKEN`).
- [ ] Change the admin password; `backend/scripts/set-admin-claim.js` and the
      recovery route both assume it is not the committed one.
- [ ] Turn on MFA for the Google account that owns the Firebase project.

## 2. Lock down the Firebase project

- [ ] **App Check** with Play Integrity, enforced on Firestore. Without it the
      project id in the app bundle is enough for anyone to talk to Firestore
      directly; the rules still hold, but every rate limit and every
      client-side guard is bypassed.
- [ ] Firestore **backups / PITR** enabled.
- [ ] **TTL policies** — these are per-field settings on the database and
      `firebase deploy` does not touch them, so nothing deletes expired rows
      without this:
      ```bash
      for C in refresh_tokens otp_challenges gst_verifications admin_recovery; do
        gcloud firestore fields ttls update expiresAt \
          --collection-group="$C" --enable-ttl --project=modern-dairy-pune
      done
      ```

## 3. Deploy rules, indexes and hosting

Add the repo secret `FIREBASE_SERVICE_ACCOUNT` (a service-account JSON key with
Firebase Rules Admin, Cloud Datastore Index Admin, Firebase Hosting Admin,
Service Usage Consumer), then run **Actions → Deploy Firebase (rules, indexes,
hosting)**.

It runs preflight, then the emulator rules suite, then deploys, then smoke-
checks that `/`, `/privacy-policy.html`, `/terms.html`, `/admin/` and `/ride/`
all answer 200. Equivalent by hand, if you must:

```bash
npm run test:rules && npx firebase-tools deploy \
  --only firestore:rules,firestore:indexes,storage,hosting --project modern-dairy-pune
```

- [ ] Deployed, smoke check green.

## 4. Build and ship the app

**Actions → Build Signed Release AAB.** Inputs: `api_base` (leave blank while
the backend is dormant) and `version_name`. Required repo secrets:
`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`,
`ANDROID_KEY_PASSWORD`, plus the provider credentials from step 1.

The workflow runs preflight and the full test suite, injects `www/secrets.js`
and `www/config.js` from the build environment, preflights the *generated*
config, sets `versionCode` from the run number, builds, and then verifies the
AAB is actually signed before uploading it.

Never edit `www/config.js` or `www/secrets.js` to configure a build — the
committed copies are placeholders and preflight fails if they are not.

- [ ] AAB uploaded to the Play Console; listing fields from
      `PLAY_STORE_LISTING.md` (its Website and Privacy Policy URLs point at the
      hosting site deployed in step 3).

## 5. When billing is on: deploy the backend

This is what closes the audit's remaining critical findings — server-side
pricing, a real credit ledger, verified payments, provider keys off the client.
Full runbook in [`backend/DEPLOY.md`](backend/DEPLOY.md). In short:

1. Upgrade the project to **Blaze**; enable Run, Cloud Build, Artifact
   Registry and Secret Manager.
2. Create the secrets (`jwt-signing-key`, `gst-api-*`, `otp-*`,
   `razorpay-key-secret`, `razorpay-webhook-secret`) and grant the Cloud Run
   runtime service account `secretmanager.secretAccessor`.
3. Add repo secrets `GCP_PROJECT_ID` and `GCP_SA_KEY`; run **Actions → Deploy
   Backend (Cloud Run)**. It runs the backend suites, deploys with
   `ALLOWED_ORIGINS` set, and fails unless `/healthz` answers.
4. Register the Razorpay webhook at `<service-url>/api/payments/webhook` using
   the **webhook** secret (not the API key secret).
5. Re-run **Build Signed Release AAB** with `api_base = <service-url>/api`. That
   single input is what takes the app out of DEMO mode.

- [ ] Backend live, healthz green, app rebuilt against it.

## 6. Remove the admin uid literal

`isAdmin()` in `firestore.rules` accepts a custom claim *or* one hardcoded uid.
The literal is a lock-out fallback for the first rules deploy, it is published
in a public repo, and preflight warns about it on every run until it is gone.

```bash
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
export GCP_PROJECT_ID=modern-dairy-pune
node backend/scripts/set-admin-claim.js --email <the admin>@admin.local
node backend/scripts/set-admin-claim.js --list
```

Sign in to the admin site again (the script revokes existing sessions), confirm
it works, *then* delete the uid literal and re-run **Deploy Firebase**.

- [ ] Claim set, verified, literal removed, rules redeployed.

## 7. Scheduled jobs that are part of the deployment

These are compensating controls for the dormant backend, not optional extras.
Confirm each is enabled in Actions after the first deploy:

| Workflow | Cadence | What breaks if it stops |
|---|---|---|
| `verify-order-prices.yml` | hourly | forged order prices go unnoticed |
| `nightly-audit.yml` | nightly | drift in the repo goes unnoticed |
| `reverify-business.yml` | scheduled | stale GST verifications stay trusted |
| `secret-scan.yml` + `ci.yml` | every push | the credential tripwire |

## Rollback

- **Hosting**: Firebase Console → Hosting → previous release → Rollback.
- **Rules**: re-run **Deploy Firebase** from the last known-good commit. There
  is no console rollback for rules; the commit is the rollback.
- **Backend**: `gcloud run services update-traffic modern-dairy-api
  --to-revisions <previous>=100 --region asia-south1`.
- **App**: Play Console → halt the staged rollout. An already-installed APK
  cannot be recalled, which is why `api_base` is a build input — a bad backend
  is rolled back at the backend, not by shipping a new APK.
