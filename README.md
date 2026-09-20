# Modern Dairy — Pune

Two products share this repository, one backend and one Firebase project.

| Product | What it is | Where |
|---|---|---|
| **Modern Dairy** | B2B/B2C ordering app for customers (Android, Capacitor) and the office admin panel | `www/`, `android/`, `legal/admin/` |
| **Modern Drivers** | Driver tracking and delivery-intelligence platform for the ~40 delivery drivers | `driver-app/`, `legal/drivers/`, `backend/src/drivers/` |

Both are served by the same Express API in `backend/` on Cloud Run, the same
Firestore database, and the same Firebase Hosting site.

---

## Modern Drivers

A driver presses **Start Ride** at the beginning of their day. The platform
records the whole working day and separates it into kilometres that are
confidently Modern Dairy business travel, kilometres that are probably business
but unproven, personal Porter work, and kilometres nobody can classify yet —
without ever quietly folding the uncertain ones into the business total.

**Start here:**

* [`docs/modern-drivers/README.md`](docs/modern-drivers/README.md) — setup, tests, deployment, troubleshooting
* [`docs/modern-drivers/ARCHITECTURE.md`](docs/modern-drivers/ARCHITECTURE.md) — the stack, the schema, how GPS becomes kilometres, and what the system refuses to claim
* [`docs/modern-drivers/TESTING.md`](docs/modern-drivers/TESTING.md) — automated and manual test plans
* [`docs/modern-drivers/PRIVACY.md`](docs/modern-drivers/PRIVACY.md) — what is collected, when, who sees it, how long it is kept
* [`docs/modern-drivers/PLAY_BACKGROUND_LOCATION.md`](docs/modern-drivers/PLAY_BACKGROUND_LOCATION.md) — read before submitting the APK to Google Play

```bash
npm run test:drivers      # 112 tests, no database or network needed
npm run drivers:apk       # build the driver APK
```

## Modern Dairy (ordering)

* [`PROGRESS.md`](PROGRESS.md) — the running development log; read the top section first
* [`backend/README.md`](backend/README.md), [`backend/DEPLOY.md`](backend/DEPLOY.md) — the API
* [`GOFRUGAL_INTEGRATION.md`](GOFRUGAL_INTEGRATION.md) — billing integration status
* [`PLAY_STORE_LISTING.md`](PLAY_STORE_LISTING.md), [`IOS_IPA_BUILD.md`](IOS_IPA_BUILD.md) — store builds

```bash
npm run test:security     # needs backend/node_modules installed
npm run test:bills
npm run test:app
```

---

## Ground rules for this repository

* **No secrets in git.** `npm run check:secrets` runs in CI and blocks a commit
  that adds one. Real credentials live in Google Secret Manager; build-time
  values arrive from GitHub Actions secrets.
* **Firestore rules:** every `match` block must sit at brace depth 2. A block
  that drifts inside another silently stops applying — that bug has shipped in
  this file once already, and `tests/drivers/security.test.mjs` now checks it.
* **Never fabricate data.** No seeded GPS history, no invented delivery
  records, no demo mode that looks like real tracking. Test fixtures live in
  `tests/` and are never loaded by the backend.
