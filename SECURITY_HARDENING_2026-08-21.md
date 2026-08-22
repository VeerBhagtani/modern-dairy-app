# Security Hardening & Red-Team Report — Modern Dairy App

**Date:** 2026-08-21
**Scope:** Full audit → fix → authorized pen-test → re-test of the whole
application: the Capacitor customer app (`www/index.html`), the admin website
(`legal/admin/`), the Firestore security rules, the two GitHub Actions cron
relays (`backend/scripts/`), the (undeployed) Express backend (`backend/src/`),
the CI workflows, and the Android project.

> **Honest status:** this pass materially reduced the app's attack surface and
> closed every vulnerability found that could be fixed in code. It did **not**
> and cannot make the app "100% secure." Two things need your hands (secret
> rotation, CI secret config), the credentials already in git history are
> permanent, and some fixes are interim until the backend is actually deployed.

---

## ⚠ TWO MANUAL ACTIONS REQUIRED (only you can do these)

1. **Rotate every credential that was committed to the public repo.** Removing
   them from the code does not un-leak them — they are in the git history
   forever and the repo is public, so treat all of them as compromised:
   - sandbox.co.in **GST API key + API secret** → regenerate in the
     sandbox.co.in dashboard.
   - Message Central **OTP auth token** (and rotate/confirm the customer ID) →
     regenerate in the Message Central console.
   - The **super-admin password** (and the customer accounts, if any real ones
     exist) — the old hardcoded admin credential is revoked in code but was
     public; set a new one at first run.
2. **Add the rotated values as GitHub Actions secrets** so real builds are
   configured: repo **Settings → Secrets and variables → Actions → New secret**,
   names exactly: `OTP_CUSTOMER_ID`, `OTP_AUTH_TOKEN`, `GST_API_KEY`,
   `GST_API_SECRET`. CI injects them into `www/secrets.js` at build time
   (`scripts/inject-secrets.js`); the committed copy stays empty. With them
   unset, CI still produces a working **DEMO** build (test number + test GSTIN,
   no paid provider calls) — it never ships a half-configured live app.

Optional but recommended: purge the leaked values from git history with
`git filter-repo` (or BFG) and force-push. This is destructive and rewrites
history — your call. Rotation above is the real remedy regardless.

---

## 1. Vulnerabilities found and fixed

Severity uses CVSS-style bands. "Verified" states how the fix was checked
(64 automated checks live in `tests/`, run with `npm run test:security`).

### CRITICAL

**C1 — Authentication bypass shipped in production (`OTP_TESTING_MODE = true`).**
While on, *every* phone number skipped the real SMS and accepted the fixed code
`0000` — and the app printed "Testing mode — the code is 0000" on screen. Anyone
could type any 10-digit number + `0000` and be signed in as that number's
account: one-tap account takeover of every user, in a public APK.
*Root cause:* a hand-set boolean that was easy to forget to flip.
*Fix:* it is now **derived**, not hand-set — `OTP_TESTING_MODE = !OTP_READY`,
where `OTP_READY` is true only when a real OTP credential was injected at build
time. A build that can send SMS always demands a real code; the bypass cannot be
shipped on by accident. *Verified:* logic test + code review; DEMO build still
works via the dedicated test number only.

**C2 — Live credentials committed to a PUBLIC git repo.** The sandbox.co.in GST
key + secret, the Message Central OTP token, and an admin password were plain
string literals in `www/index.html` on `github.com`, scrapable by anyone.
*Fix:* all removed from source; real values now come from CI secrets injected
at build time into a gitignored-content `www/secrets.js`; a committed-secret
scanner (`scripts/check-no-secrets.js`, wired into
`.github/workflows/secret-scan.yml`) fails the build if any return.
*Residual:* the historical values are permanent in git history →
**rotation required** (see above). *Verified:* scanner self-test catches 8
secret shapes; working tree scans clean.

### HIGH

**H1 — Hardcoded super-admin credential in the public APK + repo**
(`moderndairy` / a literal password). Five taps on the logo + the two known
values opened the admin panel on any device. *Fix:* default removed entirely;
the panel is inaccessible until a per-device admin account is created at first
run; only a **salted PBKDF2-SHA256 hash** is stored, never the password;
credential change re-authenticates first. *Verified:* logic test.

**H2 — Plaintext password storage.** Customer and admin passwords were stored
verbatim in `localStorage`, readable via `adb backup`, a stolen/rooted phone,
DevTools, or any WebView-storage exposure — and people reuse passwords.
*Fix:* **PBKDF2-SHA256, 210k iterations, per-account random salt** (WebCrypto,
no custom crypto). Legacy plaintext accounts auto-upgrade to a hash on the next
correct login, then the plaintext is deleted. *Verified:* hashing, verification,
unique-salt, and legacy-migration all tested.

**H3 — Order price/total forgery at the Firestore-rules layer.** The
order-create rule bounded `total` but never tied it to the items, so a direct
Firestore write could keep genuine line items and declare `total: 1`. *Fix:* the
rule now requires `subtotal/gst/delivery` to be present, bounded, and to **sum
to `total`** (1-rupee rounding slack), plus stricter per-item shape checks. This
closes the "real items, ₹1 total" write at the rules layer; per-item price is
still cross-checked out-of-band by the price-verify cron. *Verified:* rules
compile against the live project (dry-run); constraint tested against four
forgery variants.

### MEDIUM

**M1 — Admin website rendered to any Firebase identity.** The shell (tabs,
Settings form) rendered for `if(user)` — true for *any* session, including an
anonymous one created from the console with the public web API key. Data reads
still failed on rules, but it disclosed structure and invited probing.
*Fix:* the admin page now signs out and rejects any session whose uid isn't the
admin uid.

**M2 — No client-side rate limiting** on login, OTP send, OTP verify (a 4-digit
code = 10k guesses), GST lookup, admin login, or password reset. *Fix:* a
persistent per-subject throttle module (5/15min on auth actions, 10/hr on the
metered GST lookup, with lockouts). *Verified:* lockout, per-subject isolation,
and reset-on-success tested. *Residual:* device-local and clearable — real
enforcement is the backend limiter (already written, undeployed).

**M3 — User-enumeration oracles.** Sign-in said "No account found for this
number" vs "Incorrect password"; password-reset distinguished "no account" from
"name doesn't match"; admin login timing differed for real vs unknown usernames.
*Fix:* single generic messages, constant-time comparison (`timingSafeEqual`),
and a dummy bcrypt compare so unknown admin usernames cost the same as real ones.

**M4 — XSS / URL-injection sinks.** Remote-config and catalogue values
(`APPCFG.logo`, product `img`, social links) flowed into `src`/`href`/inline
`onclick` unescaped — a `javascript:` URL or a quote-breakout was possible via a
compromised `app_config`/`products` write. Customer-supplied order fields render
in the **admin's** browser (stored-XSS → admin-session risk). *Fix:* `safeUrl()`
(scheme allowlist), `jsStr()` (JS-string escaping) and `esc()` applied at every
sink in both the app and the admin site. *Verified:* `javascript:`/`data:`/
`vbscript:`/case-variant/whitespace payloads all neutralized in tests.

**M5 — Mass assignment / prototype pollution.** Remote `app_config` and
`products` docs were spread into app state wholesale; the backend admin routes
`set(req.body)` verbatim. *Fix:* strict field allowlists with type coercion on
both sides (`pickFields` in the app, `pickAllowed`/`cleanProductPatch` +
`hasForbiddenKeys` in the backend); `__proto__`/`constructor`/`prototype`
rejected. *Verified:* unknown-field drop, `__proto__` non-pollution, and value
coercion tested.

**M6 — Path/query injection in the cron Firestore writes.** Attacker-controlled
doc ids (an FCM token *is* the device_tokens id; order ids can be client-chosen)
were interpolated unescaped into a PATCH URL — Firestore ids may contain `?`/`&`,
letting a caller append extra `updateMask.fieldPaths` and delete fields. *Fix:*
`encodeURIComponent` on the collection and id in both cron scripts.

**M7 — Price-verification bypass via pagination.** The verify-order-prices cron
listed only the first 300 orders (`pageSize=300`, no page token). Past 300 docs,
a forged order could sit outside page one and never be checked *or* retried.
*Fix:* both cron scripts now page through the entire collection.

**M8 — Admin API-key inputs echoed stored keys into the DOM.** A `type=password`
field hides a value from a shoulder-surfer only; the key sat in the DOM in
plaintext for any script/DevTools. *Fix:* fields are now write-only; only a
Configured/Missing status pill is shown; input is cleared after save.

### LOW

**L1 — Android `allowBackup="true"`** let `adb backup` (no root) lift WebView
storage — session token, account records, admin hash. *Fix:* `allowBackup=false`
+ Android-12 `dataExtractionRules` excluding all domains from cloud + device
transfer.

**L2 — WebView remote debugging enabled** in shipped builds
(`webContentsDebuggingEnabled: true`). *Fix:* set to `false`.

**L3 — No security headers / CSP.** *Fix:* Firebase Hosting now sends CSP, HSTS,
`X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`,
`Permissions-Policy`, COOP; the Capacitor app carries a CSP `<meta>` pinning
script/connect/img sources to only the hosts it actually uses; the backend uses
a strict `default-src 'none'` helmet CSP + HSTS + an HTTPS redirect.

**L4 — Weak password policy** (min 6, so `123456` was allowed). *Fix:* min 8
with at least one letter and one digit, enforced on signup and reset.

**L5 — Over-exposed API responses.** The admin object carried `passwordHash`;
wallet ledger entries carried the internal `settledBy` admin id; the
unauthenticated `/config` returned the whole `app_config` doc. *Fix:* explicit
field projections / DTOs on all three.

**L6 — Backend OTP regex pinned to exactly 6 digits** — would have rejected the
live provider's 4-digit codes the moment the backend went live. *Fix:* `\d{4,8}`.

---

## 2. Already secure (verified correct, left as-is)

- **Server-side order pricing** — the backend recomputes every price, MOQ and
  total from Firestore and ignores client-submitted money entirely.
- **JWT algorithm pinned to HS256** on verify (alg-confusion mitigated); access
  token 15m / refresh 30d; wrong-type tokens rejected.
- **Firestore authz** — `isAdmin()`/`isOwner()` gating; customers can only
  self-cancel their own orders from cancellable states and can only change
  `status`+`cancelledAt`; no one (not even admin) can set `cancelled`;
  device-token docs are self-owned and can't be re-pointed.
- **Wallet top-ups require admin confirmation** — a client top-up only records a
  request; the balance moves in an admin-gated transaction. No client-trusted
  payment.
- **Idempotency key** on order creation prevents duplicate orders on retry.
- **Backend already had** helmet, an allowlist CORS policy, a generic error
  handler (no stack traces to clients), dependency-free input validators, per-IP
  and per-phone rate limiters, and Secret-Manager-only credentials.
- **FCM service-account key** lives only as a GitHub Actions secret, never in the
  repo. The Firebase web/Android API keys are public-by-design project ids
  (access is decided by rules), correctly treated as non-secret.

---

## 3. Remaining risks (could not be fully closed here)

| # | Risk | Severity | Why it remains |
|---|------|----------|----------------|
| R1 | Leaked credentials in git history + live | **Critical** | Rotation is a manual action outside code; history rewrite is destructive and your call. |
| R2 | OTP token + GST key still ship *inside the APK* | **High** | Architectural — no server yet. Now out of the public repo and CI-injected, but still extractable by decompiling the APK. Real fix = deploy `backend/` (blocked on Blaze until ~Sept 11). |
| R3 | Client-side throttle is device-local / clearable | **Medium** | Genuine rate limiting needs the backend limiter (written, undeployed). |
| R4 | Per-item price forgery (b2c order tagged `b2b`) | **Medium** | Rules can't re-price a variable item list; the cron flags mismatches after the fact. Real fix = server-side pricing on Cloud Run. |
| R5 | Firestore rules validate item *shape*, not full catalogue price | **Medium** | Same root cause; the price-verify cron is the compensating control until the backend deploys. |

None of these are newly introduced — they are the residue of the "no backend
deployed yet" architecture, now clearly bounded and monitored.

---

## 4. Files changed

**Customer app**
- `www/index.html` — removed all hardcoded secrets; added `safeUrl`/`jsStr`
  output-safety, PBKDF2 password hashing + legacy migration, attempt throttling,
  GSTIN checksum, remote-config/product allowlists, derived testing-mode,
  first-run admin setup, generic auth errors, CSP `<meta>`, escaped order-item
  qty.
- `www/secrets.js` *(new)* — committed empty placeholder for build-time secrets.
- `www/config.js` — unchanged (already secret-free).

**Admin website**
- `legal/admin/index.html` — reject any non-admin Firebase session; escape
  customer-supplied order qty.

**Firestore / rules**
- `backend/firestore.rules` — `totalsAddUp()` and stricter per-item validation on
  order create.

**Cron relays**
- `backend/scripts/send-broadcast-push.js`, `verify-order-prices.js` — full
  pagination; `encodeURIComponent` on collection + doc id in PATCH URLs.

**Backend API**
- `src/index.js` — strict helmet CSP, HSTS, HTTPS redirect, `x-powered-by` off.
- `src/middleware/validate.js` — 4–8 digit OTP; `pickAllowed`/`hasForbiddenKeys`.
- `src/middleware/adminAuth.js` — dummy-hash timing defense; strip `passwordHash`
  from returned admin.
- `src/routes/admin.js` — allowlisted product + config writes.
- `src/routes/config.js` — public-field projection.
- `src/routes/wallet.js` — ledger DTO (drops `settledBy`).

**Android**
- `android/app/src/main/AndroidManifest.xml` — `allowBackup=false` +
  `dataExtractionRules`.
- `android/app/src/main/res/xml/data_extraction_rules.xml` *(new)*.
- `capacitor.config.json` — WebView debugging off.

**CI / tooling / config**
- `.github/workflows/{build-apk,build-ios,build-ipa,build-release-aab}.yml` —
  build-time secret injection step.
- `.github/workflows/secret-scan.yml` *(new)* — secret scan + placeholder guard
  + security tests + dep audit on every push.
- `scripts/inject-secrets.js`, `check-no-secrets.js`, `check-secrets-placeholder.js`
  *(new)*.
- `tests/frontend-security.test.mjs`, `tests/backend-security.test.mjs` *(new)*.
- `firebase.json` — security headers. `.gitignore` — `www/secrets.local.js`.
- `package.json` — `test:security` / `check:secrets` / `inject:secrets` scripts;
  removed `@capacitor/assets`. `backend/package.json` — `uuid` override.

---

## 5. Dependencies changed

- **Root:** removed `@capacitor/assets` (unused; sole source of the `sharp`/libvips
  **high** and `uuid` advisories). Result: `npm audit --omit=dev` → **0
  vulnerabilities**. Remaining advisories live only in `@capacitor/cli` (CI build
  tooling, never shipped); a `tar` override was tried and reverted because it
  breaks `npx cap sync` — the real fix is a coordinated Capacitor 8 major upgrade,
  out of scope for a security pass.
- **Backend:** `uuid` pinned to `^11.1.1` via `overrides`; `firebase-admin` held
  at `^12.7.0` (v13/14 are breaking majors, no environment to test against yet).
  Result: `npm audit` → **0 vulnerabilities**.
- App-icon generation still works on demand with `npx @capacitor/assets generate`.

---

## 6. Tests performed

| Check | Result |
|-------|--------|
| Frontend security logic (`tests/frontend-security.test.mjs`) | **44/44 pass** |
| Backend security logic (`tests/backend-security.test.mjs`) | **20/20 pass** |
| Admin product-patch mass-assignment cleaner | **8/8 pass** |
| Order-forgery rule constraint (`totalsAddUp`) | pass (all forgery variants blocked) |
| Firestore rules compile (firebase dry-run, nothing deployed) | **compiled successfully** |
| Committed-secret scanner + self-test (8 secret shapes) | working tree **clean**; 8/8 caught |
| Secrets-placeholder guard (fails on real values) | pass |
| All inline scripts parse (`node --check`) | app 10/10, admin 1/1 OK |
| Backend modules load (no wiring errors) | pass |
| `npm audit --omit=dev` (root) / `npm audit` (backend) | **0 / 0** |
| `npx cap sync android` (the CI build step) | succeeds |

**Attack categories exercised:** authentication bypass (C1), credential exposure
(C2/H1/H2/L5), authorization/IDOR at the rules layer (H3/M1/M6), business-logic
forgery (H3/M7), XSS/injection (M4/M6), mass assignment + prototype pollution
(M5), enumeration/timing oracles (M3), brute-force/abuse (M2), input validation
(GSTIN/OTP/ids), and dependency vulnerabilities.

**Could not be verified here:** live end-to-end Firestore-rules enforcement (the
emulator needs JDK 11+; only a JRE 8 is on this machine) — rules were verified by
compile + static constraint analysis instead. Runtime behavior of the new rules
should be spot-checked in the Firebase console emulator, or accepted on the next
`firebase deploy --only firestore:rules`, before relying on it in production.

---

## 7. Final assessment

The application is **meaningfully harder to compromise** than at the start of
this pass: the outright authentication bypass is gone, no live credential is in
the source tree, passwords are hashed, the admin surfaces are gated, the order-
forgery gap is closed at the rules layer, and every injection/mass-assignment
sink found is now escaped or allowlisted — with 64 regression tests and a CI
secret-scan to keep it from sliding back.

It is **not** invulnerable, and no app can be. The honest gaps are: the leaked
credentials must be rotated by hand (they're public and permanent in history),
two secrets still ship inside the APK until the backend is deployed, and the
strongest rate-limiting/pricing controls only come online with that backend
(~Sept 11). Do the two manual actions at the top, and re-run
`npm run test:security` + `npm run check:secrets` before each release.
