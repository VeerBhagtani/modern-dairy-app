# Modern Dairy App — Progress

Last updated: 2026-08-14

## What this is
A B2B bulk-ordering Android app for Modern Dairy (Pune). Single-file vanilla-JS
frontend wrapped in Capacitor for Android, with a real (but not yet deployed)
Node.js backend, and a Firebase/Google Cloud project already created.

## Where everything lives
- **GitHub repo (source of truth):** https://github.com/VeerBhagtani/modern-dairy-app
- **This folder** is a local copy for reference — the repo is what's actually current if they ever diverge.
- **Latest APK:** `index.apk` in this folder (also as a GitHub Release: check
  https://github.com/VeerBhagtani/modern-dairy-app/releases for the newest tag).
- **Firebase/GCP project:** `modern-dairy-pune` — console at
  https://console.firebase.google.com/project/modern-dairy-pune/overview
  (logged in as veerstarsky@gmail.com)

## Done so far
- Android app built with Capacitor, wraps `www/index.html` (the actual app UI/logic).
- App icon and in-app logo set from the real Modern Dairy logo.
- B2B-focused redesign pass: new design tokens/type scale/colors, restructured
  home screen and cart, bigger product images, fixed a broken mobile layout in
  the admin panel.
- Real About Us content (the actual company history, 1956–present).
- **Local admin panel** built into the app (Account tab → Admin panel,
  password `moderndairy2026` unless changed): edit business settings, product
  prices/MOQ/stock, change admin password, view on-device orders, enter API
  keys, and a full step-by-step guide for getting each API key. This currently
  saves to the phone's local storage only (no backend yet) — clearly labeled
  as demo mode in the UI itself.
- **Backend code fully written** (`backend/` folder): Express API matching
  every endpoint the frontend calls, Firestore data layer, Secret Manager
  wiring, real HTTP clients for GST verification / Razorpay / WhatsApp /
  GoFrugal / Uber Direct / Twilio (not stubs — they'll work the moment real
  keys are added), server-side order/price/MOQ validation, audit logging,
  Firestore security rules. Not deployed yet.
- **Firebase project created:** `modern-dairy-pune`, Firestore database live
  (Mumbai region), security rules + indexes deployed. Currently on the free
  Spark plan.

## Not done yet / blocked
- **Authentication not enabled yet** — needs one manual click:
  https://console.firebase.google.com/project/modern-dairy-pune/authentication
  → "Get started". After that, Claude can enable Email/Password + Phone
  sign-in via API.
- **Backend not deployed** — Cloud Run, Secret Manager, and Cloud Build all
  require the Blaze (pay-as-you-go) plan, which needs a payment method added.
  Decision made: staying on free Spark for now, upgrade to Blaze later when
  ready to go live. No fixed subscription cost — usage-based, likely very
  cheap at this app's current scale.
- **Real API keys not obtained yet.** In progress:
  - GST verification: use https://console.sandbox.co.in (instant self-serve
    signup, unlike Surepass which is sales-gated)
  - Uber Direct: sign up at https://direct.uber.com — test/sandbox
    credentials appear immediately under Management → Developer tab;
    production needs billing + approval. Note: self-serve signup may be
    region-restricted — if so, needs a direct Uber sales contact instead.
  - Razorpay, WhatsApp Business API, GoFrugal — not started yet (were
    deprioritized in favor of GST + Uber Direct first).

## Next steps, in order
1. Click "Get started" on Firebase Authentication (link above) — free, instant.
2. Get GST verification key from sandbox.co.in and Uber Direct test credentials.
3. Paste keys into the app's Admin Panel as you get them.
4. When ready to go live: upgrade Firebase project to Blaze plan (needs a
   card), then the backend gets deployed to Cloud Run in one session.
5. Sign up for Razorpay (test key is instant, no KYC) and start the WhatsApp
   Business / Meta Developer signup (needs Business Verification, takes a
   few days — worth starting early) and GoFrugal (only if you already have a
   GoFrugal license).

## How to pick this back up
Just continue the conversation in Claude Code from the same project folder —
conversation history persists automatically. The GitHub repo, Firebase
project, and this folder are the durable state; the chat itself is just
convenience on top of that.
