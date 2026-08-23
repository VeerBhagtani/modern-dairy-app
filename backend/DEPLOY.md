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

## Notes

- `src/index.js` already: reads `process.env.PORT`, sets `trust proxy`, uses
  helmet + HSTS + an HTTPS redirect (production), an allowlist CORS, rate
  limiters, and a generic error handler. It's Cloud-Run-shaped as-is.
- `firestore.rules` are deployed separately with
  `firebase deploy --only firestore:rules` (already in use this project).
