# Modern Dairy App — Progress

Last updated: 2026-09-11

## Session of 2026-09-11 — tracking fix, Request a driver, Account Center — READ THIS FIRST

**Nothing from the 2026-09-10 or 2026-09-11 sessions is committed yet**, but
the Firestore rules and Hosting (admin site + privacy policy) are live from the
working tree. Commit before anything else.

### Rider tracking had never worked — fixed and deployed
`match /orders/{orderId}` in `backend/firestore.rules` was never closed where
it looked closed, so the `order_blocks`, `deliveries` and `order_blocks_public`
blocks sat INSIDE it and only applied to sub-collections. The real top-level
collections fell to the admin-only catch-all. Proven live with an anonymous
probe: riders and customers got 403 on every delivery (the rider screen said
"Could not look that up", the customer map never appeared), and the app could
never read the public hold list, so the "account on hold" banner never showed
(the hold itself was still enforced by the order rule). Fixed and deployed;
re-probed: fetching one delivery is allowed, listing them is not.
**Before trusting any rules change, check every `match` sits at brace depth 2.**

### Decisions
- **Uber:** Uber Direct for all deliveries. Still blocked on Uber's side
  (`invalid_scope` — the Direct product isn't enabled for the app); own riders
  plus the free Leaflet tracking stay as the fallback until it is.
- **Request a driver:** business customers only. The card says "a small extra
  charge applies" until an amount is set in Settings.
- **Cash on delivery for B2C:** brainstormed, nothing built. On the table: UPI
  to the business QR at the door, a rider "cash collected" button with
  per-rider end-of-day totals, a delivery OTP, a COD cap for new customers, a
  COD fee or prepaid discount.

### Request a driver (business customers) — built
Home-screen card for B2B accounts: Request a driver → Collect payment (cash or
cheque) / Urgent delivery / Other help, plus optional details (required for
Other). Lands live in the admin **Driver requests** tab (the tab counts new
ones). The office assigns a driver (name + mobile), marks it done or cancels
it, and the customer's card shows the driver live. The customer can withdraw
while it's still open. Charge: Settings → "Driver request charge" (0 = no
amount shown). Collection `driver_requests`; rules deployed.

### Account Center — built
Admin **Accounts** tab: every customer account, filters All / B2B / B2C /
Supply held or stopped, search by name, business, phone or GSTIN. Each account
shows contact, GSTIN, bank check, address + map pin, first/last seen and recent
orders, with **Hold supply / Stop supply / Resume** (the credit-hold list the
order rule already enforces; the entry now records hold vs stop) and edits to
name, business name and address.
- Accounts still live on the phone. The app copies each profile — never the
  password — to `customer_accounts/{installUid}_{phone}` on launch, after
  sign-in and after an address change. **A customer only appears once they
  open the new APK.**
- Office edits go into the doc's `admin` map (customers can't write it); the
  app applies them to the phone on its next launch.
- Live rules probe, 26/26 (scratch script, not in the repo): valid writes
  allowed; forged owner, extra fields, preset status, back-dated time, office
  edits, password hash, phone change and listing all refused.
- Privacy policy section 6 now says account profiles and driver requests are
  stored in Firebase and passwords stay on the phone. Deployed.

### Business signup was impossible on the demo APK — fixed in code
The bank-account step always failed ("Bank verification is not configured in
this build") and had no test shortcut. Fixed test login for a business account:
- GSTIN `27AAPFM1234A1ZV`, any business name
- Bank account `000123456789`, IFSC `TEST0000001` (accepted only with that GSTIN)
- Any contact name and address, mobile `9000000000`, code `0000`

### Storefront redesign (customer app) — built, needs a new APK
The owner benchmarked the app against Zomato's Hyperpure and asked for a
far more attractive, photo-led front end. Home, Catalogue and the Product page
were rebuilt; every other screen picked up the new colour tokens.
- **One strict system** (tightened the same day, after the owner said the
  first pass looked "vibe coded"):
  - "Modern" navy `#1B2A6B` (`--brand`) for structure and navigation.
  - Crest red `#D7262F` (`--crimson`) only where money moves: ADD, the
    stepper, discounts, the cart badge.
  - Neutrals everywhere else; green only for "in stock".
  - Butter yellow and the per-category pastels are gone from the storefront.
  - One discount chip (`.save`); radius tokens 8/12/16 px (`--r-sm/--r/--r-lg`).
  - `.eyebrow` is a sentence-case label on every screen; `.divider` is
    plain spacing; inner top bars show back + title only, no logo.
  - Headings and prices in Bricolage Grotesque; body stays Plus Jakarta Sans.
  - No gimmicks: no ticket notches, rotated plates or glow shadows.
- **Home:** navy masthead with search. A delivery card shows tomorrow's
  7–11 AM slot and "Order by 6:00 PM"; it switches to a red "Closes in 1h
  59m" countdown only in the last three hours. Below it:
  - a promo carousel of real packs, all navy (`PROMOS`; a slide hides itself
    if its product is disabled)
  - white photo category tiles
  - product shelves (regular items / popular, frozen, drinks)
  - one grouped shortcuts list: repeat last order, business credit, request
    a driver
- **Catalogue:** photo category rail on the left, two-column product cards
  with a full-width ADD button under the photo, so it never covers the pack.
- **Product page:** full-width photo, tap for a full-screen zoom, pack
  sizes, "More in <category>" shelf.
- **Photos:** `pimg()` rewrites Cloudinary URLs to
  `e_trim:10/c_pad,b_white,w_N,h_N/f_auto,q_auto` — the white studio
  margin is trimmed so packs fill their tiles, and images arrive 20–35×
  smaller (butter 730 KB → 20 KB). Non-Cloudinary URLs pass through `safeUrl`.
- `repaintRows()` now refreshes every `[data-act]` ADD/stepper on screen, so
  shelves on Home update when an item is added.
- Checked in headless Chrome at 412×915 (screenshots seeded a test business
  account in localStorage and blocked Firebase sign-up, so nothing was
  written to Firestore). All test suites pass.

### Rider link, delivery codes and rider maps — built; website side live
- **Delivery codes:** marking an order "Out for delivery" now issues a fresh
  random 10-character code (32-symbol alphabet, about 50 bits, no 0/O/1/I)
  and publishes `deliveries/{code}` instead of `deliveries/{orderNo}`.
  Order numbers run in sequence, so the old key let anyone guess their way
  to customers' addresses. The code is also written onto the order
  (`deliveryCode`), which is how the customer's app finds the live map.
  Re-marking an order, or moving it on, closes the previous trip, so old
  links stop working.
- **Rider link, nothing to install:** `https://modern-dairy-pune.web.app/ride/#CODE`
  (`legal/ride/index.html`). The code sits after `#`, so it never reaches a
  server log or a Referer header. The page shows the address, a map with the
  rider and the customer's pin, the straight-line distance, Navigate (Google
  Maps directions) and Call. It shares location while open and asks the
  phone to keep the screen awake. **Honest limit:** a browser can't share
  location with the screen locked or while Google Maps is in front, so the
  customer sees the last position until the rider comes back to the page.
- **Admin:** the moment an order goes out for delivery, its screen shows a
  Rider link card (Send on WhatsApp / Copy link). The customer's saved map
  pin (from the Account Center) is copied into the delivery as
  `destLat`/`destLng`. With no pin, Navigate goes by the address text.
- **App rider mode:** takes the code or a pasted link (any case, dashes
  optional) and gets the same map, distance, Navigate and Call. Tracking
  keeps running in the background while Google Maps navigates.
- Hosting `Permissions-Policy` now allows `geolocation=(self)` (it was blocked
  site-wide). Leaflet is also served from `/vendor/leaflet/`.
- Tested: rider end-to-end 9/9 against the live project (web link and app
  rider mode on a throwaway delivery, cleaned up afterwards); frontend tests
  52.
- **Not yet exercised in a browser:** the admin's code-issuing path (needs
  the admin login) and the customer app following `deliveryCode` to its map.
  Run one real trip end to end.
- **The current APK's rider flow stops working:** v5.13 riders type order
  numbers and v5.13 customers look up `deliveries/{orderNo}`, and both need
  the new APK. The web link works now.

### Android back button — fixed
The app never listened for Android's back button. With `@capacitor/app`
installed, an unhandled back press makes Android close the app, because this
single-page app keeps no browser history to go back through.
`handleHardwareBack()` now works in this order:
1. Closes a zoomed photo or a bottom sheet first.
2. Steps back through business signup (OTP → contact → bank → GSTIN) and
   password reset.
3. Walks back through the screens the customer visited (cart → product →
   catalogue → home).
4. Goes Home from any other tab, and from the order-placed screen (never
   back into checkout).
5. Keeps a rider's trip running: back only sends the app to the background.
6. On Home, asks "Press back again to exit".

Simulated end to end in headless Chrome: 18/18.

### Owner feedback pass (v5.17.0-debug)
- **Shop hours, not the order cutoff.** The delivery card showed "Closes in
  1h 22m", a countdown to the 6 PM order cutoff, which read as the shop
  closing. It now shows real shop status from `SHOP_HOURS`:
  - Mon–Sat 8 AM–2 PM and 4 PM–9 PM; Sunday 8 AM–2 PM.
  - Shown as "Open till 2 PM" (green) or "Opens 4 PM" / "Opens 8 AM tomorrow".
  - The `businessHours` text was corrected in the live `app_config` and in
    the app's default.
  - Seven frontend tests cover the schedule.
- **Map pins that explain themselves:** 🛵 for the rider and 🏠 for the
  delivery address, on the customer's map, in app rider mode and on the
  rider web page.
- **Every order in progress** shows on Home as a swipeable row. A second
  order used to hide the first.
- **Highlights rotate.** The banners (five, one per category first), the
  "Popular" row and the category rows are reshuffled on every app open
  (`sessionPick`), so every product gets its turn.
- **Colour variety, still coordinated:**
  - Banners in five deep tones (navy, forest, maroon, teal, cocoa).
  - A soft pastel per category tile and rail plate (`CAT_LOOK`).
  - Green and amber tints on the shortcut icons.
  - Red still means ADD and discounts only.
- **Google Maps look:** not done. Real Google Maps needs a Maps API key on
  a billing-enabled project. The maps are still OpenStreetMap, and
  Navigate opens the Google Maps app.

### Maps: OpenFreeMap + MapLibre (v5.18.0-debug)
The owner didn't like the flat OpenStreetMap raster look and asked for a
free, good map provider instead of paying for Google Maps.
- Every map now draws **OpenFreeMap** vector maps with **MapLibre GL JS
  4.7.1**: the customer's live map, app rider mode and the rider web link.
  OpenFreeMap is free, needs no API key, has no usage cap and allows
  commercial use.
- MapLibre's strict-security build is vendored in `www/vendor/maplibre/`
  and `legal/vendor/maplibre/`, with its worker loaded from there too. The
  security policies only needed `tiles.openfreemap.org` added (and `blob:`
  images on Hosting). Leaflet is removed.
- `mdMap()` / `mdPin()` / `mdMove()` / `mdFit()` wrap MapLibre with the
  lat-first calls the screens use. A phone without WebGL gets a clear
  message instead of a broken map, and Navigate still works.
- The map credit folds into the ⓘ button once the map loads.
- **Customer tracking screen:** a taller map plus a rider card, e.g.
  "Suresh is on the way · 1.6 km away · about 5 min · updated just now"
  with a Call button when the rider gave a number. It's a straight-line
  distance at ~20 km/h, so it's labelled "about".
- If billing is ever switched on, Google's native Android Maps SDK is free
  with no limit. The JavaScript Maps API is not ($7 per 1,000 loads after
  10,000 a month).

### Still to do
1. **Merged and released.** PR #4 is merged into `master`, so `master`
   matches what is live (Hosting, Firestore rules) and the APK. The latest
   APK is **v5.18.0-debug**, built from `master`:
   https://github.com/VeerBhagtani/modern-dairy-app/releases/tag/v5.18.0-debug
   (direct download:
   https://github.com/VeerBhagtani/modern-dairy-app/releases/download/v5.18.0-debug/modern-dairy-v5.18.0-debug.apk). The same file is `index.apk` in this folder (git ignores
   it). The owner chose a public release knowing the APK carries the real
   OTP/GST credentials from the Actions secrets. **Rotate them soon**, since
   anyone downloading the APK can extract them.
2. First real rider trip end to end, now that the rules allow it.
3. `tests/bills-print.test.mjs` fails 3 "today" checks between 00:00 and 05:30
   IST (passes with `TZ=UTC`, and fails the same on the committed code). The
   test's idea of "today" crosses the UTC date line; not yet looked into
   whether the Bills tab's own "Today" filter has the same problem.

## Session of 2026-09-10 — admin login + password recovery

### Admin login changed (live)
- Username is now **`modern-dairy`** (Firebase account
  `modern-dairy@admin.local`, the same trusted uid
  `63cH4Dduh4WS7okdV0s0DcJtD7q2`). `Veer` no longer works. The password was
  reset and is deliberately not written anywhere in this repo.
- The admin website asks for the ID and password **on every visit** — reload,
  new tab, reopened browser. Firebase Auth runs on `inMemoryPersistence`, so no
  session is ever saved in the browser. Deployed to Hosting.
- `set-admin-login.sh`, which older notes below tell you to use, **never
  existed**. To reset the password by hand, with gcloud signed in as the project
  owner: POST
  `https://identitytoolkit.googleapis.com/v1/projects/modern-dairy-pune/accounts:update`
  with `{ localId: <uid>, password: ... }` (or `email`), bearer
  `gcloud auth print-access-token`, header `x-goog-user-project: modern-dairy-pune`.
  Never create a new user — a new uid is rejected by the rules, the panel and
  the backend.

### Forgot / change password by SMS code — BUILT, NOT LIVE
"Forgot password?" on the sign-in screen and "Change password" in Settings:
pick one of the two recovery numbers (shown only as `••••••0666` /
`••••••2966`), receive an SMS code, set a new password. It all runs on the
backend — `backend/src/routes/adminRecovery.js`, mounted at `/admin-recovery`.

- The recovery numbers live only in Secret Manager (`admin-recovery-phones`).
  The page sends an index, never a number, so a code can only reach those
  phones. That secret and the OTP credentials (`otp-customer-id`,
  `otp-auth-token`) are deliberately **outside `KNOWN_SECRETS`**, so the
  admin website's API-keys endpoint cannot change them — only the GCP project
  owner can. (Otherwise a stolen admin session could repoint recovery at the
  thief's phone.)
- The new password goes straight to Firebase Auth, which keeps a salted hash.
  It is never stored, logged or echoed. Every admin session is revoked after a
  change.
- A code lasts 10 minutes; 5 wrong tries burn it; a code sent to one number
  can't be redeemed as the other; all recovery texts share one budget of
  5/hour regardless of IP.
- SMS goes through Message Central (`backend/src/services/messageCentralClient.js`),
  the same provider as the app.
- Hosting CSP `connect-src` now allows `https://*.run.app` — without it the
  GoFrugal backend call would have been blocked by the browser too.
- The admin page and CSP changes went live with the 2026-09-11 Hosting
  deploy. Until the backend is live, the recovery screen says the server
  isn't live yet.
- Tests: `tests/admin-recovery.test.mjs` (19 checks, drives the real route
  over HTTP with stubbed Firestore/Secret Manager/SMS), now part of
  `npm run test:security`.

**To make it live (needs Blaze — see `backend/DEPLOY.md`):**
1. Create secrets `admin-recovery-phones` (the two numbers, comma-separated),
   `otp-customer-id` and `otp-auth-token` (the **rotated** Message Central
   values).
2. Deploy the backend with
   `ALLOWED_ORIGINS=https://modern-dairy-pune.web.app,https://modern-dairy-pune.firebaseapp.com`.
   Its runtime service account needs Secret Manager access and Firebase
   Authentication Admin.
3. Admin → Settings → Backend URL = the Cloud Run URL, then
   `firebase deploy --only hosting`.
4. Run one real reset end to end.

**Known gap:** anyone who already knows the password can still change it
through Firebase's own API without an SMS code. Closing that means routing
sign-in through the backend and switching off email/password sign-in in
Firebase. Not done.

## Session of 2026-08-24

Four things shipped, all **merged to `master`** (PR #1, merge commit
`23b263e`) and all deployed live: admin website, Firestore rules, and APK
v5.13.0-debug. `master` is the source of truth and matches what is running —
verified by hashing the served admin page against the local file (they differ
only by CRLF line endings, which git introduces on checkout).

The working branch `bills-printing-gofrugal` has been deleted.

### 1. Bills tab — bulk printing (admin website)
New **Bills** tab between Orders and Products. One button builds every matching
bill into a single print job, one bill per page, and hands it to the browser's
print dialog — so it prints on whatever printer that PC is set to use. Paper
selector for A4 / A5 / 80mm / 58mm swaps the `@page` rule; Copy selector prints
Original / Duplicate / Triplicate, or all three.

Search matches bill number, customer, company or phone and **deliberately
ignores the date filter**, so reprinting an old bill is one search away. Print
counts are tracked per bill (and undoable), which drives a "print only the N not
yet printed" button — the daily workflow.

The bill itself is a full 14-section GST tax invoice: seller block with
GSTIN/FSSAI/MSME, e-invoice + transaction blocks, party details, the
`SNo → Total` product table, taxable/CGST/SGST/IGST/cess strip, amount in words
(Indian lakh/crore), per-rate GST summary, customer account summary,
declarations, GSTIN-verification note, jurisdiction, IRN QR area, signatory.

- **Tax is only ever split, never recomputed.** `subtotal`/`gst` are what the
  customer was charged; per-line rounding drift is absorbed into the largest
  line so the invoice can never disagree with the payment.
- Delivery and platform fee ride as 0% lines (SAC 9968/9997) so the totals
  strip foots exactly.
- **No fake QR is ever drawn.** The QR areas render an image only from the
  IRP's signed payload; otherwise they reserve the space and say why.
- **Specimen registration numbers** are used until Settings holds real ones.
  Every bill meanwhile prints a "not valid for tax purposes" line and both tabs
  warn. All self-clearing on save.

**TO DO before issuing a real bill:** fill Settings → GSTIN, PAN, FSSAI, MSME,
bank details, and **have your CA approve the two declarations + the GST
verification note** before any of it reaches a customer.

### 2. GoFrugal billing — built, OFF by default
GoFrugal is designed as the billing system of record: Print pushes the sale via
the backend, GoFrugal allots the legal invoice number and e-invoice, and we
print that (our `orderNo` drops to an "Order Ref." line).

**Currently inert** — it needs both a backend URL and the Settings toggle, and
neither is set, so printing behaves exactly as it does standalone.

- `POST /admin/orders/:id/bill` is **idempotent**: the claim is staked inside a
  Firestore transaction before the network call, so "print all" pressed twice
  cannot raise duplicate bills. A timeout deliberately *holds* the claim — a
  delayed retry beats a duplicate in the books.
- `requireAdmin` now also accepts a Firebase ID token matching the admin uid,
  so the admin website reaches the backend with no second login.
- GoFrugal's total is cross-checked against what the customer paid; a
  disagreement is flagged and blocks silent printing.

**Blocked on two things**, in this order:
1. API access is not enabled on the Modern Dairy GoFrugal licence (licence is
   active; API is a separate support request). Request/response shapes in
   `goFrugalClient.js` are the documented pattern but **unverified**.
2. **Catalogue mapping** — the real blocker. GoFrugal bills by its own item
   code; our order items carry `pk`/`vid`. Every product needs a
   `gofrugalItemCode` and the app must copy it onto order items at checkout.

Full write-up + the exact questions to put to GoFrugal support:
`GOFRUGAL_INTEGRATION.md`.

### 3. Rider live tracking (free map)
When an order goes **out for delivery**, the customer's order screen shows a
live map with the rider moving on it. **Leaflet + OpenStreetMap** — no API key,
no billing account, no usage contract. Leaflet is vendored into
`www/vendor/leaflet/` because the app's CSP only allows `'self'` scripts.

**Rider flow: no password.** Tap the logo 5× → name + mobile → the order number
the office issued → Start trip. Nothing to enrol, hand out or rotate.

**Why that needed a new collection.** The rider's login used to be what let
them read the order (they need the address). Removing it without a replacement
would have meant letting any signed-in device read orders — publishing every
customer's name, phone, address and GSTIN. So riders no longer touch orders at
all: marking an order out for delivery publishes `deliveries/{orderNo}` holding
only doorstep information. The order number is the document id, and the rules
allow `get` but never `list`, so knowing a number fetches exactly that one
record and gives no way to enumerate any other.

**Residual risk, stated plainly:** anyone who knows a live order number can see
that one delivery's address and post a location to it. Every update carries the
rider's name and phone, so the office can see who. That is the cost of no rider
login, bounded to one delivery rather than the whole order book. If it ever
matters, a 4-digit PIN on the delivery record is a small change.

**Backgrounding** is the hard part and is handled properly:
`@capacitor-community/background-geolocation` holds a real **foreground service
with a persistent notification** — the only way Android permits continuous
location with the screen off. Manifest gained `ACCESS_BACKGROUND_LOCATION`,
`FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION`, `WAKE_LOCK`.

⚠️ **Android asks for "Allow all the time".** Anything less and tracking stops
seconds after the rider's screen locks. This is the single most likely reason
it will look broken — tell riders explicitly.

⚠️ **The delivery record is only created when you mark an order out for
delivery from now on.** An order already sitting in that status has none — flip
it away and back to generate one.

Stale fixes are labelled rather than shown as live: past 90s the map says when
the last update arrived.

### 4. Cancel button bug (fixed)
The **Cancel order** button's visibility was a *not-in-[cancelled, delivered,
denied]* test, so it stayed on screen through `out_for_delivery`. Tapping it
reached a guard that refused and showed a "call us" sheet — a button that could
not do what it said. Now gated on `CANCELLABLE_STATUSES`, the same list as
`isCancellable()` in the rules, and it disappears live the moment the status
flips. Two races closed: the confirm sheet could be open when the status moved
on (it returned *silently* — indistinguishable from a broken app), and that
sheet could be left floating over a screen whose button had vanished.

### Also removed this session
- **The in-app admin panel is gone entirely** (478 lines). It was a
  device-local demo panel behind 5 logo taps that let anyone holding a phone
  override the prices *shown* on it and order at those prices — a large part of
  why `verify-order-prices.js` exists. The 5-tap gesture now opens rider mode.
  The real admin is the website.
- **Broadcasts no longer show as an in-app banner.** They still go out as push
  notifications, and the admin Broadcasts tab is unchanged.

### Releases published this session
All built by the `build-apk` GitHub Actions workflow (JDK 21) — local Gradle
builds are impossible here, see the note at the end of this file.
- **v5.10.0-debug** — rider live tracking, first cut
- **v5.11.0-debug** — rider looks up one order instead of a list
- **v5.12.0-debug** — cancel button hidden once out for delivery
- **v5.13.0-debug** — rider signs in with a name, no password *(current;
  `index.apk` in this folder is byte-identical to it)*

### Tests added
- `npm run test:bills` — 137 bills + 27 GoFrugal adapter assertions
- `npm run test:app` — 16 cancel-visibility assertions, including that the
  app's cancellable list matches the rules' (verified to fail if widened)
- `npm run test:security` — unchanged, still 44 + 20

### Two bugs the tests caught
1. A missing GoFrugal total parsed as `0` (because `Number(null) === 0`), which
   would have flagged **every** bill as a total mismatch.
2. Stacked phone table cells used flexbox, which splits at `<br>` into two flex
   items and widened every row instead of stacking it.

### Still outstanding
- **End-to-end rider test on real phones.** Never done: it needs a phone
  actually moving, and the Firestore emulator will not run here (needs Java 11+,
  this machine has 8). Rules compiled and deployed, all wiring checks pass, but
  the first real trip is the actual test. Do a dry run before a customer sees it.
- Fill in the real GSTIN/PAN/FSSAI/MSME/bank details in Settings.
- CA sign-off on the invoice declarations and GST note.

## Security hardening pass (2026-08-21) — still relevant
A full audit + fix + pen-test pass ran this session. What changed, and the
two things you MUST do by hand:

- **ROTATE these now — they were committed to a PUBLIC repo and are in git
  history forever** (removing them from the working tree does not un-leak
  them): the sandbox.co.in GST **API key + secret**, the Message Central OTP
  **auth token** (+ customer ID), and the old super-admin password
  `moderndairy` / (the value formerly in code). Assume all are compromised.
- **Set the new CI secrets** so real builds are configured: in GitHub repo
  Settings → Secrets → Actions add `OTP_CUSTOMER_ID`, `OTP_AUTH_TOKEN`,
  `GST_API_KEY`, `GST_API_SECRET` (use the *rotated* values). Builds inject
  them into `www/secrets.js` at build time; the committed copy stays empty.
  With them unset, CI still builds a working DEMO app (test number/GSTIN).
- The **hardcoded-credential auth bypass is closed**: `OTP_TESTING_MODE` is
  no longer a hand-set `true`. It is now derived from `OTP_HAS_CREDENTIAL` —
  testing mode (any number + code `0000`) only exists in a build with no real
  OTP credential injected. A real build (secrets set) always demands a real
  SMS code and disables the `0000` bypass. No way to ship the bypass on by
  accident. (Verified end-to-end for both demo and real builds after a
  mid-session regression in this exact area was caught and fixed — an earlier
  version of the fix broke `0000` login in demo builds; the send/verify path
  now stays active regardless of credential presence.)
- Passwords (customer + admin) are now stored as **salted PBKDF2-SHA256
  hashes**, never plaintext; legacy plaintext accounts auto-upgrade on first
  correct login. Client-side **rate limiting** now guards login / OTP send +
  verify / GST lookup / admin login / password reset.
- Frontend/admin XSS sinks hardened (`safeUrl`/`jsStr`/escaping on all
  remote-config, catalogue and customer-order fields); remote config +
  product data are now allowlisted (no mass assignment / prototype
  pollution). Firestore order-create rule now enforces the totals add up
  (kills the "real items, total ₹1" forgery at the rules layer). Admin
  website now rejects any non-admin Firebase session. Security headers/CSP
  added (Hosting + the app). Android `allowBackup` off; WebView remote
  debugging off. Dependency audits clean (`npm audit --omit=dev` = 0).
- Regression tests live in `tests/` (`npm run test:security`, 64 checks);
  a committed-secret scanner (`npm run check:secrets`) + a CI workflow
  (`.github/workflows/secret-scan.yml`) stop this regressing.
- Full write-up: `SECURITY_HARDENING_2026-08-21.md`.

## (previous) Last updated: 2026-08-16

## What this is
A B2B + personal bulk-ordering Android app for Modern Dairy (Pune). Single-file
vanilla-JS frontend wrapped in Capacitor for Android (and a first iOS build
too), plus a companion admin website, both talking directly to Firestore.
A real Node.js backend exists in the repo but is still not deployed.

## Where everything lives
- **GitHub repo (source of truth):** https://github.com/VeerBhagtani/modern-dairy-app
- **This folder** is a local copy for reference — the repo is what's actually current if they ever diverge.
- **Latest APK:** `index.apk` in this folder — this is
  **v5.13.0-debug**, byte-identical to the published release
  https://github.com/VeerBhagtani/modern-dairy-app/releases/tag/v5.13.0-debug
  Built by GitHub Actions on JDK 21 (this machine only has Java 8, so local
  Gradle builds are not possible — Gradle 8.2.1 needs JDK 17+).
  **Still a DEMO-mode build:** no real OTP/GST credentials were injected, so
  OTP runs in test mode (any number + `0000`) and only the test GSTIN
  verifies. For a launch build with real SMS/GST, set the four CI secrets
  (see above) and let the `build-apk` workflow build it.
  All releases: https://github.com/VeerBhagtani/modern-dairy-app/releases
- **Admin website (live):** https://modern-dairy-pune.web.app/admin/ — sign in
  with username **`modern-dairy`** (since 2026-09-10; account
  `modern-dairy@admin.local`). The password is deliberately NOT written down
  here; it must stay out of the repo. It asks for the ID and password on every
  visit. To change the login by hand, update the EXISTING uid through the
  Identity Toolkit API — see the 2026-09-10 section at the top. Creating a new
  user in the Firebase console gets a new uid that the rules, the panel and the
  backend all reject.
  Tabs: Dashboard, Orders, **Bills**, Products, Broadcasts, Controls,
  Settings, Maintenance, Assistant. Responsive — the data tables restack as
  cards on a phone.
- **Firebase/GCP project:** `modern-dairy-pune` — console at
  https://console.firebase.google.com/project/modern-dairy-pune/overview
  (logged in as veerstarsky@gmail.com). Still on the free Spark plan.
- **Real OTP provider:** Message Central (VerifyNow). As of 2026-08-21 the
  customer ID + auth token are **no longer in `www/index.html`** — they come
  from `window.APP_SECRETS` (`www/secrets.js`), injected by CI from GitHub
  secrets at build time (`OTP_CUSTOMER_ID`, `OTP_AUTH_TOKEN`). Testing mode is
  now **derived, not hand-set**: with no credential injected the build is DEMO
  (every number accepts `0000`); with the credential injected it's a real build
  that always demands a real SMS code and disables the `0000` bypass. The old
  committed token is compromised → **rotate it** (see the banner up top).
- **Real GST verification provider:** sandbox.co.in — key/secret also moved out
  of `www/index.html` into `www/secrets.js` / CI secrets (`GST_API_KEY`,
  `GST_API_SECRET`). Real/live credentials, real cost per lookup; the old
  committed pair is compromised → **rotate it**. Free test GSTIN (works with no
  credential, bypasses the paid lookup): **27AAPFM1234A1ZV**.
- **In-app admin panel: REMOVED (2026-08-24).** The device-local demo panel
  behind five logo taps is gone entirely — it let anyone holding a phone
  override the prices shown on that device and then order at them. The five-tap
  gesture now opens **rider mode** instead. The only admin is the website above.
- **Firebase service account key** used for server-side FCM/Firestore access
  lives only as the GitHub Actions secret `FCM_SERVICE_ACCOUNT_JSON` — not
  checked into the repo anywhere.

## Done in the 2026-08-21 session
- **Security audit + fix: forged order prices.** Ran a real (not just diff)
  security review. Finding: `orders` create rule in `firestore.rules` only
  checked `total is number` — never validated it against real catalogue
  prices, so anyone with the app's public Firebase config could write an
  order directly to Firestore at any price (e.g. real items, `total: 1`).
  Fixed with two changes, both deployed live:
  - `backend/firestore.rules` — items must now have positive, bounded
    price/qty, and `total` is capped at ₹5,00,000 (defense-in-depth only —
    Firestore rules can't cheaply re-check price against the catalogue for
    up to 50 items per write, so this alone doesn't close the gap).
  - `backend/scripts/verify-order-prices.js` +
    `.github/workflows/verify-order-prices.yml` — new GitHub Actions cron
    (every 3 min, same zero-cost pattern as the broadcast push relay) that
    re-checks every new order's item prices against the live `products`
    collection and flags mismatches (`priceMismatch`/`priceMismatchDetail`
    on the order doc, surfaced as a ⚠ badge + warning banner in the admin
    website). Real fix (server-side price computation) still needs the
    backend deployed (Sept 11).
  - Also checked: the in-app "super admin" panel (logo-tap, `moderndairy`)
    and the admin website's own login — both confirmed **not** exploitable;
    admin website login is real Firebase Auth, and every privileged write is
    gated by `isAdmin()` in the rules regardless of client-side UI state.
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
- ~~**Client-side rate limiting on login**~~ — **DONE 2026-08-21.** A
  persistent per-subject throttle now guards login / OTP send / OTP verify /
  GST lookup / admin login / password reset (see `throttle*` in
  `www/index.html`). It's device-local and clearable, so real server-enforced
  limiting still wants the backend (Sept 11), but the online-guessing / SMS-and-
  GST-abuse holes are closed.
- ~~**`OTP_TESTING_MODE` must be flipped off before launch**~~ — **no longer a
  manual step (2026-08-21).** It's derived from whether a real OTP credential
  was injected, so a real build can't ship with the bypass on. Just set the CI
  secrets and the bypass is off automatically.
- **Uber Direct integration** — real customer ID/client ID/client secret were
  received and live-tested (2026-08-17): OAuth `client_credentials` auth
  succeeds (credentials are valid), but the `eats.deliveries` scope is
  rejected as `invalid_scope` — same result with no scope param at all. This
  means the **Uber Direct product hasn't been enabled/approved for this app**
  on Uber's developer dashboard yet — needs action on Uber's side before the
  scope will work. Credentials were **not** written anywhere (repo rule: real
  creds only ever go in GCP Secret Manager, never committed/local files) —
  they'll need to be re-supplied once Secret Manager is available (Sept 11)
  or once the scope issue is resolved and a quick recheck is wanted sooner.
  Quote + delivery-fee helper (`backend/src/services/uberDirectClient.js`)
  is written and ready, not wired to checkout.
- **Two secrets still ship inside the APK** (Message Central auth token,
  sandbox.co.in key+secret) — but **no longer in the public repo** as of
  2026-08-21: they're CI-injected at build time, not committed. They remain
  extractable by decompiling the APK, so the real fix is still to move them
  server-side once the backend is deployed. The previously-committed values are
  in git history → **rotate them.**
- **GoFrugal** — integration is BUILT (2026-08-24) but inert. Blocked on two
  things in order: (1) API access is not enabled on the licence — a separate
  support request, the licence itself is active; (2) **catalogue mapping** is
  the real blocker: GoFrugal bills by its own item code and our order items
  carry `pk`/`vid`, so every product needs a `gofrugalItemCode` and the app
  must copy it onto order items at checkout. Request/response shapes in
  `goFrugalClient.js` are the documented pattern but unverified against a live
  tenant. See `GOFRUGAL_INTEGRATION.md` for the exact questions to ask.
- Razorpay / WhatsApp Business real credentials — not started.
- **Rider tracking has never been tested end-to-end on real phones.** It needs
  a phone actually moving, and the Firestore emulator will not run on this
  machine (needs Java 11+, only Java 8 installed). Rules compiled and deployed,
  all wiring checks pass — but the first real trip is the actual test.
- **E-invoice QR is not rendered.** GoFrugal returns the IRP's signed QR
  payload and it is stored, but nothing on the admin page can encode a QR yet,
  so the bill prints a labelled placeholder instead. No fake QR is ever drawn.
  Needs a QR encoder inlined into the page (a CDN library would need a CSP
  change).

## Next steps, in order
1. **Rotate the leaked credentials and set the CI secrets** (see the banner at
   the top) — the single most important launch blocker now. Until then any
   local/CI build is DEMO-mode. (The order-forgery rules hardening is already
   deployed; `firestore.rules` has been redeployed several times since.)
2. When Sept 11 arrives and a payment method is added: upgrade to Blaze,
   deploy `backend/`, move the two APK-embedded secrets server-side, and
   consider moving the push-notification relay from the free GitHub Actions
   cron to a proper Cloud Function (not required, just cleaner once available).
3. Resolve the Uber Direct `invalid_scope` issue (enable/approve the Direct
   API product for this app on Uber's developer dashboard), then re-supply
   the credentials for a live auth+quote recheck, then decide whether/how to
   wire the delivery-fee helper into checkout.
4. Razorpay/WhatsApp/GoFrugal only if/when actually needed.

Before every release: `npm run test:security`, `npm run test:bills`,
`npm run test:app`, and `npm run check:secrets`.

Building the APK: **not possible on this machine** — Gradle 8.2.1 needs JDK 17+
and only Java 8 is installed. Use the `build-apk` GitHub Actions workflow
(`gh workflow run build-apk.yml --ref <branch>`), download the artifact, then
`gh release create`. That is how every release since v5.10.0 was made.

## How to pick this back up
Just continue the conversation in Claude Code from the same project folder —
conversation history persists automatically. The GitHub repo, Firebase
project, and this folder are the durable state; the chat itself is just
convenience on top of that.
