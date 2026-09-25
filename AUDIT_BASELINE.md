# Audit baseline — before the final fixes

Recorded 2026-09-25, before any change in this round.

## Code

| | |
|---|---|
| Repository | VeerBhagtani/modern-dairy-app |
| Branch | `modern-drivers-standalone` |
| Commit | `41675e3` (Deploy the final-audit changes), on `197cbcb` |
| Tests | 387 pass, 0 fail (`npm test`, Node 22) |
| Tracked secrets | none (git grep: no keys, no private keys, no office password) |
| Secret in history | office password in commit `61dd368` (public) — must be rotated |

## Deployment

| | |
|---|---|
| GCP project | `modern-drivers-pune` |
| API | Cloud Run `modern-drivers-api`, asia-south1, max 4 instances |
| Database | Firestore `(default)`, rules deny all client access |
| Dashboard + APK | Firebase Hosting, https://modern-drivers-pune.web.app |
| APK signing | permanent key in Secret Manager `android-signing-key`; cert SHA-256 `C7:28:9B:F2:…:CF:EF:70` |
| CI | deploy / dashboard / release workflows, each gated on the full test suite |
| CI identity | `github-deployer@…` — no Firestore data, billing or backup access |

## Environment limits of this audit

- No physical Android device.
- No network route to Google APIs, `*.run.app` or `*.web.app` from the sandbox.
- No Firestore reads, no Cloud Console.

## Findings at baseline

### Blockers (need a person)
1. Office password exposed in public history — rotate.
2. Real-device end-to-end test never run.
3. Restaurant location audit not yet run on production data.
4. Depot record ("Modern Dairy, Market Yard") not confirmed.
5. Firestore backups / PITR and a budget alert not confirmed.

### P1
- The seeded account's "must change password" was enforced only by the dashboard, not the server.
- Phone restart mid-ride: recording stops and the driver is not told (`RECEIVE_BOOT_COMPLETED` declared, unused).

### P2
- Processed-result (3 y) and tracking-event (1 y) retention configured but not implemented.
- Route Matrix answers not cached: the same legs are paid for repeatedly.
- No check or warning when the depot facility is missing or misplaced.

### P3
- 8 moderate npm advisories, one root (`uuid` < 11 buffer bounds with a caller-supplied `buf`, not used here); fix needs a firebase-admin major upgrade.
- Node 20 deprecation warnings from GitHub actions.
- Old github.io copy of the dashboard still published.
