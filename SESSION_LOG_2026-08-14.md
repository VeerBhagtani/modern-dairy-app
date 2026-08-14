# Session Log — 2026-08-14

A chronological record of today's work, so you (or a fresh Claude session) can
pick up exactly where this left off. See `PROGRESS.md` in this same folder for
the current-state summary — this file is the "how we got here."

## What happened today, in order

1. **Found the app** — `index.html` in Documents was an existing "Modern
   Dairy — Business Ordering" web app (single-file vanilla JS). Set up as a
   proper Capacitor Android project (`ModernDairy_v2/`).
2. **Built and shipped the first APK** via a new GitHub repo
   (`VeerBhagtani/modern-dairy-app`, public) + GitHub Actions workflow that
   builds a debug APK on every push and gets published as a GitHub Release.
3. **Fixed a real bug**: APK showed `ERR_CONNECTION_REFUSED` on
   `https://localhost/` on physical devices. Root cause: `MainActivity.java`
   had replaced Capacitor's `BridgeWebViewClient` with a plain
   `WebViewClient` to handle external links (WhatsApp/tel/maps), which broke
   Capacitor's local-asset-serving interception. Fixed by extending
   `BridgeWebViewClient` instead.
4. **UI/UX redesign pass** — new design tokens (type scale, colors, spacing),
   restructured home screen and cart, logo swapped in, app launcher icon
   generated from the logo (was previously still Capacitor's default icon).
5. **Built a working local Admin Panel** inside the app itself (Account tab →
   Admin panel). Business settings editor, product price/MOQ/stock editor,
   admin password change, API key input fields (GoFrugal/GST/Razorpay/
   WhatsApp/Uber Direct) with a full step-by-step "how to get these keys"
   guide built into the app, and an on-device orders view. All of this
   currently persists to the phone's local storage only — clearly labeled as
   demo mode — since there was no backend yet.
6. **Fixed a broken mobile layout** in the admin panel (a product-editing row
   was overflowing on real phone screens — rebuilt as a responsive grid).
7. **Replaced About Us** with the real Modern Dairy company history (1956
   Shyam Sundar Dairy → founding of Modern Dairy → next generation).
8. **Discussed infrastructure** for a real launch (target: handle real order
   volume reliably). Decision: Google Cloud/Firebase stack — Cloud Run
   (backend), Firestore (database, Mumbai region), Secret Manager (API
   keys), Cloud Functions (webhooks), Firebase Hosting (admin panel),
   Firebase Auth. Reasoning: the frontend already had dormant Firebase
   integration code, and it's a pay-as-you-go model, not a big subscription.
9. **Built the real backend** (`backend/` folder) — a fork wrote a complete
   Express API matching every endpoint the frontend already calls, Firestore
   data access layer, real HTTP client implementations for GST/Razorpay/
   WhatsApp/GoFrugal/Uber Direct/Twilio (reading credentials from Secret
   Manager, not hardcoded), server-side order/price/MOQ validation (never
   trusts client-submitted numbers), audit logging, Firestore security rules
   (deny-all direct client access), deploy docs. Validated with `node --check`
   on every file. Not deployed yet.
10. **Created the actual Firebase/GCP project**: `modern-dairy-pune`
    (`modern-dairy` was already taken globally). Installed and authenticated
    both the Firebase CLI and gcloud CLI (via browser login flows you
    completed). Enabled Firestore + Identity Toolkit APIs, created the
    Firestore database in `asia-south1` (Mumbai), deployed
    `firestore.rules` and `firestore.indexes.json` from the backend folder.
11. **Hit the billing wall**: Cloud Run / Secret Manager / Cloud Build all
    require the Blaze (pay-as-you-go) plan, which needs a payment method.
    Decision: **stay on free Spark plan for now, upgrade to Blaze later**
    when ready to actually deploy the backend.
12. **API key hunting**: tried browser automation (declined — no Chrome
    extension connected), so did manual research instead. Found:
    - GST verification: Surepass is sales-gated (not instant); switched
      recommendation to **sandbox.co.in** which has genuine instant
      self-service signup.
    - Uber Direct: corrected earlier info — signup is at
      **direct.uber.com**, and test/sandbox credentials appear immediately
      after signup (not gated behind a multi-day review as first assumed) —
      production credentials need billing + approval. Self-serve signup may
      be region-restricted; if so, needs a direct Uber sales contact.
    - Razorpay, WhatsApp, GoFrugal — deprioritized for today, guidance
      already given in earlier chat turns (see PROGRESS.md next-steps).
13. **Saved everything here** — this folder (`Desktop/MD APP`) is a full copy
    of the project including `.git` history, plus the latest APK
    (`index.apk`) and `PROGRESS.md`.

## Key decisions made (so a fresh session doesn't re-litigate them)
- Stack: Google Cloud/Firebase, not AWS/Azure.
- Region: `asia-south1` (Mumbai) everywhere.
- Staying on Spark (free) plan until ready to actually launch; deploy
  backend only after upgrading to Blaze.
- GST provider: sandbox.co.in (not Surepass).
- Never put real secrets in the frontend/APK — Admin Panel's local API-key
  storage is explicitly temporary/demo, real keys belong in Secret Manager
  once the backend is deployed.
- Admin panel local password: `moderndairy2026` (changeable in-app).

## Immediate next actions
See "Next steps, in order" in `PROGRESS.md`.

## How to resume
Open Claude Code in this folder (or `Documents\ModernDairy_v2`, which is the
actual working repo this was copied from) and continue — or paste this file's
content into a fresh session if starting somewhere new.
