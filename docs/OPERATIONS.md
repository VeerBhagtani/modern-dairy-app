# Modern Drivers — operations

Things that need a person with the Google Cloud console, the office login or
a phone. CI cannot do them: its service account deliberately has no Firestore
data access, no billing access and no backup admin.

Project: `modern-drivers-pune` · Firestore `(default)` · Cloud Run `asia-south1`.

## 1. Rotate the office password (do first)

The password was exposed in the public repository's history (commit 61dd368).
Removing it from the files does not remove it from history or from forks.

1. Open https://modern-drivers-pune.web.app and sign in.
2. Top right → **Change password**. Use 14+ characters, not used anywhere else.
3. Every other session signs out within 30 s (`passwordChangedAt`).
4. Check: signing in with the old password fails; the new one works.

Accounts marked "must change password" (the seeded one) are now refused by the
server for everything except the password change.

## 2. Firestore backups and point-in-time recovery

Console → Firestore → **Disaster recovery**:

1. **Point-in-time recovery**: Enable. Keeps 7 days of versions, restorable to
   any minute.
2. **Backups** → Create schedule: Daily, retention 14 weeks. Add a Weekly one,
   retention 52 weeks, if the office wants a year.
3. Check: the schedule lists a backup the next day.

Or from Cloud Shell:

```
gcloud firestore databases update --database='(default)' --enable-pitr --project modern-drivers-pune
gcloud firestore backups schedules create --database='(default)' --recurrence=daily --retention=14w --project modern-drivers-pune
```

Restore test (once, to prove it works): Disaster recovery → Backups → Restore
to a **new** database id, e.g. `restore-test`; open it; delete it afterwards.

## 3. Budget alert

Google Cloud has no hard spending cap.

Console → Billing → **Budgets & alerts** → Create budget → Project
`modern-drivers-pune` → Amount ₹2,000/month → alerts at 50 %, 90 %, 100 %
(actual) and 100 % (forecast) → email the billing admins.

## 4. Route cache expiry (optional)

Paid road distances are cached in `route_cache` for 30 days (the app ignores
older rows). To have Firestore delete old rows itself:
Console → Firestore → **Time-to-live** → Create policy → collection group
`route_cache`, field `expiresAt`.

## 5. Retention (automatic)

Runs every 6 hours from the housekeeping, audited in `drivers_audit_log`:

| Data | Kept | Action |
|---|---|---|
| Raw GPS (`gps_raw`) | 180 days | `gps.retention_delete` |
| Processed results, segments, matches | 3 years | `result.retention_delete` (km totals stay on the ride) |
| `tracking_events` | 1 year | `events.retention_delete` |
| Audit log, reviews, alerts | forever | — |

Never touches an active ride or a ride with no processed result. Settings →
retention changes the numbers.

## 6. Confirm the depot

The dashboard shows a banner when no facility has a location, or none is near
Market Yard. Locations → **Modern Dairy depots**: check "Modern Dairy, Market Yard" exists,
is active, and its pin is on the building (satellite view). Without it the drive
back is never `RETURN_TO_MODERN_DAIRY`.

## 7. Verify every restaurant location

Restaurants → **Location audit — our pins against Google Maps** → Check. About 60 per batch, suburb-centre pins
first; repeat until "not checked yet" is 0. Then review SIGNIFICANT_DIFFERENCE
and NOT_FOUND rows one by one; apply only what you have looked at. Download
the CSV for the record. Needs the Places API enabled on the geocoding key.

## 8. First install of the permanently signed APK

APKs before build 197cbcb were signed with a throwaway key each time. The first
permanently-signed APK cannot install over those:

1. On each phone, wait for "Waiting to send" to reach 0 (nothing queued).
2. Uninstall Modern Drivers. Install from
   https://modern-drivers-pune.web.app/modern-drivers-release.apk
3. Every later update installs over the top.

Certificate SHA-256 (check with `apksigner verify --print-certs`):
`C7:28:9B:F2:14:9F:FC:9C:EE:2D:DF:FE:7A:CB:A9:D2:21:45:4B:9E:C7:99:60:12:A4:65:79:B5:D4:CF:EF:70`.
The key lives only in Secret Manager (`android-signing-key`). Losing it means
every phone must uninstall again — never delete that secret.

## 9. Rollback

- Backend: Cloud Run → `modern-drivers-api` → Revisions → pick the previous
  one → Manage traffic → 100 %.
- Dashboard: Firebase Hosting → Release history → Roll back.
- APK: re-install an older APK only if signed with the same key (versionCode
  must not go down, so uninstall first — empty the queue first).
