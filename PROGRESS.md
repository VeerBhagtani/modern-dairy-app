# Modern Dairy App — Progress

Last updated: 2026-08-15

## What this is
A B2B + personal bulk-ordering Android app for Modern Dairy (Pune). Single-file
vanilla-JS frontend wrapped in Capacitor for Android (and now a first iOS
build too), with a real (but not yet deployed) Node.js backend, and a
Firebase/Google Cloud project already created.

## Where everything lives
- **GitHub repo (source of truth):** https://github.com/VeerBhagtani/modern-dairy-app
- **This folder** is a local copy for reference — the repo is what's actually current if they ever diverge.
- **Latest APK:** `index.apk` in this folder (also as a GitHub Release: check
  https://github.com/VeerBhagtani/modern-dairy-app/releases for the newest tag — currently `v3.6.0-debug`).
- **Firebase/GCP project:** `modern-dairy-pune` — console at
  https://console.firebase.google.com/project/modern-dairy-pune/overview
  (logged in as veerstarsky@gmail.com)
- **Real OTP provider:** Message Central (VerifyNow) — customer ID and a
  long-lived auth token are in `www/index.html` (search `OTP_CUSTOMER_ID`).
  Free test number for development: **9000000000**, code **0000** (never
  calls the real provider, never costs anything).
- **Real GST verification provider:** sandbox.co.in — API key/secret are in
  `www/index.html` (search `GST_API_KEY`). These are **live/production**
  credentials — real cost per lookup. Free test GSTIN for development:
  **27AAPFM1234A1ZV** (bypasses the real call entirely).
- **Super admin account:** username `moderndairy`, password set during this
  project (changeable in-app, Admin Panel → Super admin account). Reached by
  tapping the app logo 5 times within 2 seconds on the login screen —
  deliberately no visible "admin" button anywhere in the UI.

## Done so far
- Android app built with Capacitor, wraps `www/index.html` (the actual app UI/logic).
- **First iOS build exists** — `.github/workflows/build-ios.yml` builds an
  unsigned Simulator-only `.app` on a GitHub Actions macOS runner. Not
  installable on a real iPhone yet — that needs an Apple Developer Program
  account ($99/yr) for code signing, not set up.
- App icon and in-app logo set from the real Modern Dairy logo, sized up
  across every screen (top bar, home header, catalogue header).
- B2B-focused redesign pass: new design tokens/type scale/colors, restructured
  home screen and cart, bigger product images, fixed a broken mobile layout in
  the admin panel.
- Real About Us content (the actual company history, 1956–present).
- **Real phone OTP is live** — Message Central's VerifyNow REST API, called
  directly from the app (no backend needed). Verified working end-to-end on a
  real device. (Backstory: tried Firebase Phone Auth — blocked by Blaze
  billing requirement for reCAPTCHA Enterprise; tried MSG91's Widget — never
  responded in the Capacitor WebView across every mode tried; tried MSG91's
  plain REST API — blocked by a DLT template requirement, confirmed via their
  own delivery logs, a real India/TRAI regulatory wall. Message Central's OTP
  route runs on pre-approved compliant routes so no DLT registration is
  needed on our side.)
- **Real GST/GSTIN verification is live** — sandbox.co.in, called directly
  from the app during Business signup. Verified live against a real GSTIN
  before shipping. (The backend's `gstClient.js` had a wrong,
  never-actually-tested endpoint shape — found and fixed while verifying this.)
- **Sign In / New account split** — login screen now has a toggle above
  Business/Personal. Sign In is just phone + password + OTP, no re-verifying
  GSTIN every time. Signup persists company/GSTIN locally so Sign In can
  restore them.
- **Customer signup now sets a password** too (password + confirm password,
  only enforced on first-time signup) alongside phone + OTP.
- **Wallet available to all customers**, not just B2B (labeled "Wallet" vs
  "Business credit"). Top-up goes through a Razorpay checkout — the real
  widget if a live key is configured in Admin Panel, otherwise a working
  simulated payment so the deposit-then-spend flow is fully testable today.
- **Stock-based order auto-confirmation**: orders where every item is in
  stock confirm immediately; anything with a low-stock item goes to a
  "Pending confirmation" queue in the Admin Panel that only the super admin
  can act on.
- **Local admin panel** built into the app (reached via the hidden logo-tap
  gesture, see above): edit business settings, product prices/MOQ/stock,
  change the super admin username/password, view on-device orders + the
  pending-confirmation queue, enter API keys, and a full step-by-step guide
  for getting each one. Saves to the phone's local storage only (no backend
  yet) — clearly labeled as demo mode in the UI itself.
- **Backend code written** (`backend/` folder): Express API matching every
  endpoint the frontend calls, Firestore data layer, Secret Manager wiring,
  real HTTP clients for GST verification / Razorpay / WhatsApp / GoFrugal /
  Uber Direct / Twilio, server-side order/price/MOQ validation, audit
  logging, Firestore security rules. **Security-hardened**: rate limiting
  (express-rate-limit, tuned per-endpoint sensitivity), server-side input
  validation everywhere, JWT algorithm pinning, timing-safe webhook
  signature checks, CORS allowlist, proper error status codes. Not deployed
  yet.
- **Firebase project created:** `modern-dairy-pune`, Firestore database live
  (Mumbai region), security rules + indexes deployed. Firebase
  **Authentication is now enabled** (Email/Password, Google, and Phone
  sign-in provider all on) — done this session, free, no billing needed.
  Still on the free Spark plan overall.

## Not done yet / blocked
- **Backend not deployed** — Cloud Run, Secret Manager, and Cloud Build all
  require the Blaze (pay-as-you-go) plan, which needs a payment method added.
  Decision made: staying on free Spark for now, upgrade to Blaze later when
  ready to go live. This also blocks: real Firestore-backed accounts/orders/
  wallet (currently all on-device local storage only), and Firebase's own
  Phone Auth (blocked by a separate Blaze-gated reCAPTCHA Enterprise
  requirement — Message Central was used instead specifically to avoid this).
- **Real API keys not obtained yet:**
  - Razorpay — not started (test key is instant, no KYC).
  - Uber Direct — not started (test/sandbox credentials appear immediately
    at direct.uber.com → Management → Developer tab; production needs
    billing + approval; self-serve signup may be region-restricted).
  - WhatsApp Business API — not started (needs Meta Business Verification,
    takes days — worth starting early).
  - GoFrugal — only relevant if there's an existing GoFrugal license.
- **Two secrets currently ship inside the public APK/repo** (both flagged
  inline in the code with the tradeoff explained): the Message Central auth
  token (long-lived, but not the raw account password) and the sandbox.co.in
  API key **and secret** (the raw, real, live-billed secret — no long-lived-
  token trick was possible there). Both should move server-side the moment
  the backend is deployed.
- **Local demo admin data won't survive a fresh install/reinstall** — orders,
  wallet balances, and customer accounts are all in this device's
  localStorage only, not synced anywhere, until the backend is live.

## Next steps, in order
1. Get Razorpay and Uber Direct test credentials (both near-instant), and
   start the WhatsApp Business / Meta Developer signup (slow — start early).
2. When ready to go live: upgrade Firebase project to Blaze plan (needs a
   card). Unlocks in one go: backend deployment to Cloud Run, real
   Firestore-backed accounts/orders/wallet, and (if wanted) switching real
   OTP over to Firebase Phone Auth instead of Message Central.
3. Move the Message Central and sandbox.co.in credentials into Secret
   Manager and route both through the backend once it's deployed, instead of
   shipping them in the app.
4. GoFrugal only if there's an existing license to connect.

## How to pick this back up
Just continue the conversation in Claude Code from the same project folder —
conversation history persists automatically. The GitHub repo, Firebase
project, and this folder are the durable state; the chat itself is just
convenience on top of that.
