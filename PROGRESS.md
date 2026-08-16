# Modern Dairy App — Progress

Last updated: 2026-08-16

## What this is
A B2B + personal bulk-ordering Android app for Modern Dairy (Pune). Single-file
vanilla-JS frontend wrapped in Capacitor for Android (and a first iOS build
too), plus a companion admin website, both talking directly to Firestore.
A real Node.js backend exists in the repo but is still not deployed.

## Where everything lives
- **GitHub repo (source of truth):** https://github.com/VeerBhagtani/modern-dairy-app
- **This folder** is a local copy for reference — the repo is what's actually current if they ever diverge.
- **Latest APK:** `index.apk` in this folder (also as a GitHub Release: check
  https://github.com/VeerBhagtani/modern-dairy-app/releases — currently `v4.8.0-debug`).
- **Admin website (live):** https://modern-dairy-pune.web.app/admin/ — sign in
  with Name `Modern_Dairy`, password `Mdairypune@1942`. Tabs: Orders,
  Products, Broadcasts, Settings.
- **Firebase/GCP project:** `modern-dairy-pune` — console at
  https://console.firebase.google.com/project/modern-dairy-pune/overview
  (logged in as veerstarsky@gmail.com). Still on the free Spark plan.
- **Real OTP provider:** Message Central (VerifyNow) — customer ID and a
  long-lived auth token are in `www/index.html` (search `OTP_CUSTOMER_ID`).
  **`OTP_TESTING_MODE = true`** right now (same file, search it) — while on,
  *every* phone number accepts code **0000** with no real SMS sent, not just
  the dedicated test number. **Flip this to `false` before real launch**,
  or every login is bypassable with a known code.
- **Real GST verification provider:** sandbox.co.in — API key/secret are in
  `www/index.html` (search `GST_API_KEY`). Real/live credentials — real cost
  per lookup. Free test GSTIN for development: **27AAPFM1234A1ZV**.
- **Super admin account (in-app):** username `moderndairy`. Reached by
  tapping the app logo 5 times within 2 seconds on the login screen.
- **Firebase service account key** used for server-side FCM/Firestore access
  lives only as the GitHub Actions secret `FCM_SERVICE_ACCOUNT_JSON` — not
  checked into the repo anywhere.

## Done so far (this session, on top of everything below)
- **Admin website went live**, directly on Firestore (no backend needed):
  Orders (live status, search by order ID *and* product name, filter chips
  for every status including Cancelled/Denied), Products (price/MOQ/stock
  editing), Broadcasts (see below), Settings (business info synced live to
  the app).
- **Order lifecycle tightened up:**
  - Live status sync — admin changing an order's status now reflects on the
    customer's phone without reopening the app (Firestore `onSnapshot`
    listener, wired into `openOrder()`/`scrOrder()`).
  - Customer-only cancel — a customer can self-cancel while status is still
    `placed/confirmed/pending_confirmation/packed`; past that (or once
    delivered/denied) the button just directs them to call support. Enforced
    both in the UI and, for real, in `backend/firestore.rules`
    (`isCancellable()` + a diff check so only `status`+`cancelledAt` can
    change, and only by the order's own `createdByUid`). **The admin can
    never set an order to Cancelled** — that button is gone from the admin
    UI on purpose.
  - Admin **Deny** — admin can deny an order but must give their name and a
    reason first; shown to the customer in-app.
  - Confirming cancel in-app still asks the customer to call and confirm
    (not just a toast) — per explicit direction, cancelling isn't meant to
    be a single silent tap.
- **Fixed a real "can't track my order" bug**: `loadOrders()` was querying
  Firestore by a `uid` field the actual order-write path never sets (writes
  `createdByUid` under a separate anonymous session) — always came back
  empty and silently wiped the visible order history on every load. Now
  reads from the durable local order record instead.
- **Fixed debug builds wiping login/cart/address on every update**: CI was
  signing debug APKs with a fresh, runner-generated key every single build,
  which forces "uninstall before install" on-device (wipes localStorage).
  Fixed with a checked-in, stable debug keystore
  (`android/app/keystores/debug.keystore`) wired into
  `android/app/build.gradle`. Live-verified the shipped APK actually carries
  the stable signature. (One-time catch: anyone on an older build still has
  to uninstall once to pick up the new key; every build after that keeps
  data.)
- **Admin broadcast messages** — new Firestore `broadcasts` collection
  (public read, admin-only write). Admin picks a message + audience
  (everyone / business / personal) from the Broadcasts tab; shows as a
  dismissible in-app banner on the customer's Home screen.
- **Real push notifications for broadcasts** (not just the in-app banner) —
  this was the bigger piece:
  - Registered an actual Android app in the Firebase project, added
    `google-services.json` + `@capacitor/push-notifications`, so the app can
    request notification permission and register an FCM device token.
  - New Firestore `device_tokens` collection (customer writes their own
    token + account-type, admin-only read).
  - Sending an FCM push needs a service-account credential that can't live
    in the public admin website. The normal place to hold it (a Cloud
    Function) needs Blaze. Instead: `backend/scripts/send-broadcast-push.js`
    + `.github/workflows/send-broadcast-push.yml`, a GitHub Actions cron
    (every 3 min) holding that credential as a repo secret, relaying any new
    broadcast out via FCM — **zero cost, no billing account needed**.
  - Live-verified end to end multiple times with real test data (fake device
    token + fake broadcast → watched the scheduled relay authenticate, match
    the token, call the real FCM API, mark itself sent, flag a dead token —
    then deleted the test data each time).
  - (Built and then reverted per-order/single-customer targeting — the
    decision landed on: broadcasts always go to everyone in the chosen
    audience, never one specific number.)
- **Delivery fee helper added, not wired up** —
  `backend/src/services/uberDirectClient.js` now has `getDeliveryQuote()`
  and `calculateDeliveryFee()` (Uber's quoted cost + flat ₹20 markup, per
  explicit direction — percentage markups came out too small). Not connected
  to checkout yet; still waiting on real Uber Direct credentials.
- Logo size increased app-wide (navbar, home, catalogue, login, account) and
  product photo thumbnails enlarged in the catalogue, across a couple of
  rounds of "still too small."
- Full visual redesign shipped earlier this session too: emerald/amber
  palette, Plus Jakarta Sans, WCAG-AA-verified contrast on the new colors.

## Done in earlier sessions
- Android app built with Capacitor, wraps `www/index.html`.
- First iOS build exists (`.github/workflows/build-ios.yml`) — unsigned
  Simulator-only, not installable on a real iPhone (needs Apple Developer
  Program, $99/yr, not set up).
- Real phone OTP live via Message Central (see testing-mode note above).
- Real GST/GSTIN verification live via sandbox.co.in.
- Sign In / New account split, password-based sign-in, wallet for all
  customer types with Razorpay top-up (real widget if configured, else a
  working simulated flow).
- Stock-based order auto-confirmation + pending-confirmation queue.
- Backend code written (`backend/` — Express API, Firestore data layer,
  Secret Manager wiring, GST/Razorpay/WhatsApp/GoFrugal/Uber Direct/Twilio
  clients, rate limiting, input validation, Firestore rules). **Still not
  deployed.**
- Firebase project created, Firestore live (Mumbai region), rules + indexes
  deployed, Authentication enabled (Email/Password, Google, Phone).

## Not done yet / blocked
- **Backend still not deployed** — Cloud Run/Functions/Secret Manager all
  need the Blaze plan, blocked on a payment method until **Sept 11**. The
  admin website + Firestore-rules architecture is standing in for this in
  the meantime and has covered everything tried so far except things that
  need a real running process (see above for how that was worked around for
  push notifications specifically).
- **Client-side rate limiting on login** — discussed, not yet built. Real
  server-enforced rate limiting needs the backend (Sept 11); a basic
  client-side lockout-after-N-attempts was offered as a stopgap but not
  actioned yet.
- **`OTP_TESTING_MODE` must be flipped off before real launch** — flagged
  above and in the code, easy to forget.
- **Uber Direct integration** — customer ID/client ID/client secret still
  not actually received (asked for, never came through in a message). Quote
  + delivery-fee helper is written and ready, not wired to checkout, no live
  API call has been tested with real credentials yet.
- **Two secrets still ship inside the public APK/repo**: the Message Central
  auth token and the sandbox.co.in API key+secret. Should move server-side
  once the backend is deployed.
- Razorpay/WhatsApp Business/GoFrugal real credentials — not started.

## Next steps, in order
1. Add the client-side login-attempt lockout (quick, still pending).
2. When Sept 11 arrives and a payment method is added: upgrade to Blaze,
   deploy `backend/`, move the two exposed secrets server-side, and consider
   moving the push-notification relay from the free GitHub Actions cron to
   a proper Cloud Function (not required, just cleaner once available).
3. Get real Uber Direct credentials, do a one-time live auth/quote check,
   then decide whether/how to wire the delivery-fee helper into checkout.
4. Remember to flip `OTP_TESTING_MODE` to `false` before real users touch it.
5. Razorpay/WhatsApp/GoFrugal only if/when actually needed.

## How to pick this back up
Just continue the conversation in Claude Code from the same project folder —
conversation history persists automatically. The GitHub repo, Firebase
project, and this folder are the durable state; the chat itself is just
convenience on top of that.
