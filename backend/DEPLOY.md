# Backend deployment runbook (Cloud Run)

This is the prepared, near-one-click path to make the Modern Dairy backend
**authoritative** — which is what closes the audit's critical findings (F1 credit
ledger, F3 server-side pricing, F7 payment verification, F2 central accounts,
F4 keys off the client). Nothing here can run until **billing (Blaze) is on**,
because Cloud Run + Cloud Build + Secret Manager all require it.

There are two ways to run it: the **GitHub Actions workflow** (`Deploy Backend
(Cloud Run)`, manual dispatch) or the **local gcloud** commands below. Both build
`backend/Dockerfile` and deploy to Cloud Run.

---

## 0. One-time prerequisites (when a payment method is added ~Sept 11)

1. In the Firebase/GCP console for **modern-dairy-pune**, upgrade to the **Blaze**
   pay-as-you-go plan (add the payment method).
2. Enable the required APIs (once):
   ```
   gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
     artifactregistry.googleapis.com secretmanager.googleapis.com \
     --project modern-dairy-pune
   ```

## 1. Create the secrets the backend reads from Secret Manager

The backend loads credentials at runtime via `getSecret()` (never from code).
Create each one (values = the **rotated** provider credentials — see the security
report; the currently-exposed ones must be rotated first):

```
# JWT signing key (generate a fresh random one):
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))" \
  | gcloud secrets create jwt-signing-key --data-file=- --project modern-dairy-pune

# Provider credentials (repeat per key — names must match secretManager.js):
printf '%s' "<rotated-gst-key>"    | gcloud secrets create gst-api-key       --data-file=- --project modern-dairy-pune
printf '%s' "<rotated-gst-secret>" | gcloud secrets create gst-api-secret    --data-file=- --project modern-dairy-pune
# ...and twilio-*, razorpay-*, whatsapp-*, gofrugal-*, uber-* as you enable them.
```
(The admin panel's "API keys" screen can also write these once the backend is up.)

Grant the Cloud Run runtime service account access:
```
gcloud secrets add-iam-policy-binding jwt-signing-key \
  --member="serviceAccount:<PROJECT_NUMBER>-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor" --project modern-dairy-pune
# (repeat per secret, or grant at the project level to the runtime SA.)
```

## 2. (CI path) Create a deploy service account + repo secrets

If using the GitHub Actions workflow, create a service account with:
**Cloud Run Admin, Cloud Build Editor, Service Account User, Artifact Registry
Writer, Secret Manager Secret Accessor**, download its JSON key, and add repo
secrets:
- `GCP_PROJECT_ID` = `modern-dairy-pune`
- `GCP_SA_KEY` = the JSON key contents

Then run the **Deploy Backend (Cloud Run)** workflow (Actions → Run workflow).

## 3. (Local path) Deploy with gcloud

```
gcloud run deploy modern-dairy-api \
  --project modern-dairy-pune \
  --region asia-south1 \
  --source backend \
  --allow-unauthenticated \
  --set-env-vars GCP_PROJECT_ID=modern-dairy-pune,NODE_ENV=production \
  --port 8080
```
Add `--set-env-vars ALLOWED_ORIGINS=https://modern-dairy-pune.web.app` (comma-
separated) so the admin site's browser origin is accepted by CORS. Native app
requests have no Origin and are always allowed.

## 4. Verify

```
curl -s https://<service-url>/healthz    # -> {"ok":true}
```

## 5. Point the app at the backend

- Set `CONFIG.API_BASE` in **`www/config.js`** to `https://<service-url>/api`
  and `CONFIG.DEMO=false`, then rebuild the APK (CI). This flips the client from
  the localStorage demo backend to the real API.
- In **`www/index.html`**, set `FIRESTORE_LIVE = true` once the app reads
  server-owned data (customers/wallet) instead of localStorage.
- Move GST/OTP/bank verification to call the backend instead of the providers
  directly, so the keys leave the APK (F4/F14).

## 6. Post-deploy checklist (closes the audit blockers)

- [ ] Credit is a server-side ledger; the client never asserts a balance (F1).
- [ ] Order create recomputes price/MOQ/total server-side (F3).
- [ ] Razorpay verified via webhook/signature server-side (F7).
- [ ] Accounts/profiles/wallet stored in Firestore behind the API (F2).
- [ ] Provider keys removed from the APK; served from Secret Manager (F4/F14).
- [ ] Firestore scheduled backups / PITR enabled (F5).
- [ ] Rotate the previously-exposed OTP + GST credentials.

## 7. TTL policies — required, and NOT covered by `firebase deploy`

Four collections store short-lived state with an `expiresAt` field. The code
treats an expired document as invalid, so nothing insecure happens without
these policies — but nothing *deletes* the rows either. `refresh_tokens` is the
one that actually grows: rotation deletes a token when it is used, so every
abandoned session leaves a document behind for good.

`expiresAt` is written as a Firestore **Timestamp** (see `expiryAt()` in
`src/services/firestore.js`), which is what TTL policies require — it used to be
epoch milliseconds, which the code compared fine but TTL silently ignored.
`expiryMillis()` still reads the old numeric shape, so documents written before
that change keep expiring correctly instead of being treated as already-expired.

TTL is configured per field on the database, not in `firestore.rules` or
`firestore.indexes.json`, so `firebase deploy` will not do it:

```bash
for C in refresh_tokens otp_challenges gst_verifications admin_recovery; do
  gcloud firestore fields ttls update expiresAt \
    --collection-group="$C" --enable-ttl --project=modern-dairy-pune
done
```

- [ ] TTL policies enabled for the four collections above.

## 8. Move admin identity onto a custom claim

`isAdmin()` in `firestore.rules` accepts either `request.auth.token.admin ==
true` or one hardcoded uid. The literal is a deploy-safety fallback so that
shipping the rules cannot lock the current admin out before the claim exists —
it is not meant to stay.

```bash
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
export GCP_PROJECT_ID=modern-dairy-pune

node backend/scripts/set-admin-claim.js --email <the admin>@admin.local
node backend/scripts/set-admin-claim.js --list      # confirm it took
```

Then sign in to the admin website again (the script revokes existing sessions so
the new claim applies immediately), confirm it still works, and only then delete
the uid literal from `isAdmin()` and redeploy the rules. That last step is what
actually removes the published single-target uid.

- [ ] `admin: true` set, verified, uid literal removed from the rules.

## 9. Verify the rules before they reach production

`npm run test:rules` boots a local Firestore emulator and exercises the real
rules — cross-customer reads, forged owners, the priceVerified pin, credit
holds, delivery enumeration, admin-only collections. 45 assertions.

This is the check that matters: the rest of the suite only asserts that the
rules FILE contains certain text, and text-level checks have already missed a
real bypass once. Run it after any rules edit, before deploying.

```bash
npm run test:rules      # needs Java (the emulator is a JVM process)
npm run test:all        # everything, including the above
```

- [ ] `npm run test:rules` green against the rules you are about to deploy.

## Notes

- `src/index.js` already: reads `process.env.PORT`, sets `trust proxy`, uses
  helmet + HSTS + an HTTPS redirect (production), an allowlist CORS, rate
  limiters, and a generic error handler. It's Cloud-Run-shaped as-is.
- `firestore.rules` are deployed separately with
  `firebase deploy --only firestore:rules` (already in use this project).
