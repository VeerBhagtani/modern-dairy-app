# Modern Dairy backend — deploy guide

This backend is written and ready but **not deployed**. Follow these steps once you
have a Google Cloud / Firebase project (see the in-app Admin Panel → setup guide
for how to create one).

## 1. Enable required APIs

```
gcloud config set project YOUR_PROJECT_ID
gcloud services enable run.googleapis.com firestore.googleapis.com \
  secretmanager.googleapis.com cloudbuild.googleapis.com
```

## 2. Create the Firestore database (if not already done via the Firebase console)

```
gcloud firestore databases create --location=asia-south1
```

## 3. Generate and store the JWT signing key

```
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
echo -n "PASTE_THE_OUTPUT_HERE" | gcloud secrets create jwt-signing-key --data-file=-
```

## 4. Create the first admin account

Firestore doesn't have a UI for password hashing, so run this once locally
(with `GOOGLE_APPLICATION_CREDENTIALS` pointed at a service account key, or
via `gcloud auth application-default login`):

```js
// scripts/create-admin.js (write this file once you're ready to run it)
const bcrypt = require('bcryptjs');
const admin = require('firebase-admin');
admin.initializeApp({ projectId: 'YOUR_PROJECT_ID' });
(async () => {
  const hash = await bcrypt.hash('choose-a-strong-password', 12);
  await admin.firestore().collection('admins').doc('admin').set({ passwordHash: hash });
  console.log('admin account created');
})();
```

## 5. Deploy Firestore rules and indexes

```
firebase deploy --only firestore:rules,firestore:indexes --project YOUR_PROJECT_ID
```

## 6. Build and deploy to Cloud Run

```
gcloud builds submit --tag asia-south1-docker.pkg.dev/YOUR_PROJECT_ID/modern-dairy/backend backend/

gcloud run deploy modern-dairy-backend \
  --image asia-south1-docker.pkg.dev/YOUR_PROJECT_ID/modern-dairy/backend \
  --region asia-south1 \
  --platform managed \
  --allow-unauthenticated \
  --set-env-vars GCP_PROJECT_ID=YOUR_PROJECT_ID \
  --min-instances 0 --max-instances 20
```

Grant the Cloud Run service account access to Secret Manager and Firestore:

```
PROJECT_NUMBER=$(gcloud projects describe YOUR_PROJECT_ID --format='value(projectNumber)')
SA="$PROJECT_NUMBER-compute@developer.gserviceaccount.com"

gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:$SA" --role="roles/secretmanager.secretAccessor"
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:$SA" --role="roles/secretmanager.admin"
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:$SA" --role="roles/datastore.user"
```

(`secretmanager.admin` is needed because the Admin Panel creates new secrets the
first time each key is saved — narrow this to a custom role scoped to just the
known secret IDs before going fully live, if you want tighter permissions.)

## 7. Point the app at the deployed backend

Cloud Run will print a URL like `https://modern-dairy-backend-xxxxx-el.a.run.app`.
Edit `www/config.js` in the main project:

```js
window.APP_CONFIG = {
  API_BASE: 'https://modern-dairy-backend-xxxxx-el.a.run.app',
  DEMO: false,
  RAZORPAY_KEY: '', // public Razorpay Key ID only, safe to expose client-side
};
```

Then rebuild the APK as usual (`npx cap sync android`, push, GitHub Actions builds it).

## 8. Configure integrations

Open the app → Account → Admin panel (now backed by the real server) → API keys.
Each key you paste is sent once over HTTPS and stored in Secret Manager — see the
in-app "How to get these" guide for where to obtain each one.

## Scale notes (target: 30k orders/hr)

That's roughly 8 orders/second sustained — comfortably within a single Cloud Run
service (`--max-instances 20` above is generous headroom, not a requirement) and
Firestore's default limits. The two things that matter as volume grows:
- **Idempotency keys** on order creation (already implemented) prevent duplicate
  orders from client retries during traffic spikes.
- **Composite indexes** (`firestore.indexes.json`) must be deployed before load
  testing — missing indexes cause query errors, not slowness, so this is a
  correctness step, not just a performance one.

## Left for you to decide/do

- **SMS/OTP provider**: code targets Twilio Verify. Sign up at twilio.com,
  create a Verify Service, and store `twilio-account-sid`, `twilio-auth-token`,
  `twilio-verify-service-sid` via the Admin Panel. Swap `src/services/smsClient.js`
  if you prefer a different provider (MSG91, Gupshup are common India alternatives).
- **GST provider**: code targets Masters India's API shape as a reference. Confirm
  this matches whichever GSP you actually sign up with — see
  `src/services/gstClient.js`'s header comment.
- **GoFrugal base URL**: varies by GoFrugal product edition/tenant — confirm the
  exact API base URL with GoFrugal support and set `GOFRUGAL_API_BASE_URL` env var
  if it differs from the default in `src/services/goFrugalClient.js`.
- **CORS**: `src/index.js` currently allows all origins (`cors()` with no options)
  — tighten this to your actual app origin(s) before going live.
