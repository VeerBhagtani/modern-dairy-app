# Modern Drivers — test plan

Two halves: the automated suite, which runs anywhere, and the manual plan,
which covers the things no unit test can reach — a real phone losing signal, a
driver revoking permission, an admin stopping a ride from another building.

Run the manual plan **before the first rollout** and after any change to the
Android app, the ride lifecycle or the Firestore rules.

---

## 1. Automated

```bash
npm run test:drivers
```

About 400 tests (`npm test`), no database and no network. What they cover:

| File | Covers |
|---|---|
| `geo.test.mjs` | haversine against known distances, geofence containment, proximity ≠ containment, 0.1 km rounding |
| `track.test.mjs` | ingest validation, field allow-listing, noise filtering, teleport rejection, de-duplication, order-independence, gap estimation, mock locations, quality grading |
| `segmentation.test.mjs` | **property tests over 25 random days**: every point in exactly one segment, every hop attributed exactly once, totals agree, time ordering |
| `classification.test.mjs` | facility/restaurant/unknown rules, the MEDIUM ceiling without orders, ambiguity handling, driver declarations, the confidence→bucket mapping, review override, reconciliation |
| `matching.test.mjs` | matched / possible / needs-review / unmatched both ways, one-order-one-visit, many orders one visit, determinism, CSV parsing incl. IST times |
| `reports.test.mjs` | CSV quoting, **formula-injection neutralisation**, BOM, Excel typing, every report's columns, metre-based roll-ups |
| `alerts.test.mjs` | thresholds, escalation, de-duplication, resolution, **no coordinates in any alert** |
| `security.test.mjs` | the architectural invariants — no driver stop path, no driver id from a request, mass-assignment guards, token re-checking, rules brace depth, no hardcoded secrets |
| `simulated-journey.test.mjs` | the full scenario from the brief, end to end (below) |

### The simulated journey

`Dairy → A → B → Personal 1 → 2 → 3 → Dairy → C → D → Dairy`, synthesised at
30-second sampling from real Pune coordinates with GPS noise, a six-minute
tunnel gap and a 4 km multipath spike. It asserts:

- the whole journey is recorded (297 fixes, 10 stops, 19 segments);
- all four restaurants are detected — as **likely** visits, never as proven deliveries;
- all three Modern Dairy calls are recognised, HIGH confidence;
- the three Porter stops are **UNKNOWN**, never auto-personal and never auto-business;
- unknown distance stays visible and separate, and is flagged for review;
- the verified total contains nothing flagged for review;
- buckets reconcile, and the day total sits within ±15 % of the straight-line
  leg sum (so nothing is counted twice);
- the spike is rejected and removing it changes the total by < 2 m;
- the gap is estimated, labelled, and excluded from business distance;
- raw GPS is byte-identical after processing;
- re-running produces identical output;
- adding one order record raises **only** that visit to HIGH;
- a driver declaration moves kilometres out of business and never into it, and
  leaves the day total unchanged;
- an admin review overrides the machine and preserves the original verdict;
- every segment carries evidence;
- an out-of-range threshold is rejected loudly, not clamped quietly.

---

## 2. Manual — Android driver app

Record, for every run: phone make/model, Android version, APK versionCode
(Settings → Apps → Modern Drivers), and the Diagnostics screen (tap the
version line five times) before and after. Minimum set: one Android 14+
phone, one Android 11–13, and one Xiaomi/Realme/Oppo/Vivo (aggressive battery
manager).

**The first install of a permanently-signed APK over an older debug-signed
one fails with "App not installed".** Let the old app empty its queue (Waiting
to send = 0), uninstall it, then install. Every later update installs over
the top.

Do these on a real phone on a real network. An emulator will not reproduce the
OEM battery-manager behaviour that causes most real gaps.

### Signing in
1. Fresh install → one screen asking for a name, with the tracking notice behind a link. There is no code and no password.
2. Enter a name and continue → the main screen appears and Android asks for location **straight away**, before any ride.
3. Allow it → the map appears with the driver's own marker on it. **No ride is running and nothing is stored** — check the dashboard shows no ride and no points.
4. Deny it → the map area says location is blocked and how to fix it. The app does not pretend to know where the phone is.
5. Close and reopen → the name is remembered, the map comes back, and it is still not tracking.

### Start Ride
6. Press Start Ride → the **persistent notification** appears and the status turns green.
7. Grant "While using the app" only → the app keeps working and says tracking may stop in the background.
8. Grant "Allow all the time" → tracking survives the screen going off.
9. Press Start Ride twice quickly → one ride, not two. Check the dashboard shows one.
10. Force-stop the app, reopen → it re-attaches to the same ride and resumes tracking.
11. Reboot the phone mid-ride, unlock it, do **not** open the app → within a minute a notification "Your ride is not being recorded" appears. Tap it → the app opens, re-attaches to the same ride and the status turns green. (Android 10+ forbids restarting location tracking from the background, so the app asks rather than resuming silently. On Android 13+ this needs the notification permission.)
11a. Reboot with **no** ride running → no notification.
11b. Mid-ride, let the office stop the ride while the phone is off, then reboot → the notification appears; tapping it opens the app, which shows the ride as stopped and does not record.
11c. Install a newer APK over the old one mid-ride → the same notification (app updates also end recording).

### Tracking
12. Walk/drive 2 km → the dashboard marker follows; "Points sent" climbs.
13. Lock the screen for 10 minutes → points keep arriving.
14. Switch to another app for 10 minutes → points keep arriving.
15. Turn on aeroplane mode for 10 minutes → "Waiting to send" climbs, status shows offline. Turn it off → the queue drains and nothing is lost.
16. Kill the app while points are queued, reopen → the queue is still there and drains.
17. Turn GPS off during a ride → the status turns red and says so; the dashboard raises `tracking_permission_lost`.
18. Revoke location permission during a ride → same, plus the "Fix location permission" button opens settings.
19. Let the battery optimiser kill the app (leave it overnight on a Xiaomi/Oppo) → the next day's dashboard shows the gap as a **gap**, and the distance across it is reported as an estimate.

### The rule that must not break
20. There is **no** stop button anywhere in the app.
21. With an HTTP client and the driver's token, `POST /driver/rides/<id>/stop` → **403**, and an `unauthorized_ride_control` event plus an alert appear in the dashboard.
22. With the same token, `POST /driver/rides/<someone-else's-ride>/points` → **403**, and a `cross_driver_upload_blocked` event.
23. With the same token, `POST /admin/drivers/rides/<id>/stop` → 401/403.

### Personal kilometres
24. The app has **no** personal-trip button — a driver cannot label their own day. In the dashboard, review a stretch as personal → those kilometres move to the personal column, business drops by the same amount, and the day total is unchanged.

---

## 3. Manual — admin dashboard

### Access
25. Sign in with a wrong password → "Wrong username or password" — the same message as an unknown username, so it gives nothing away.
26. Close the tab and reopen → signed out (the token lives in sessionStorage).
27. With a `viewer` role, try to stop a ride → 403 "This action needs the manager role."

### Live map
28. Two drivers on rides → two markers, no duplicates. Refresh repeatedly: still two.
29. Stop one driver's phone → within `staleLocationSec` the marker turns amber and the popup says **LAST KNOWN position — not live**.
30. A driver who never started → no marker, "No position", not a stale one at (0,0).

### Ride control
31. Stop a ride with no reason → refused.
32. Stop with a reason → the driver's phone learns within a minute and shows who stopped it and why; the audit log records admin, time and reason.
33. Emergency stop → recorded with the `EMERGENCY STOP:` prefix.
34. Leave a ride running past `autoStopAfterHours` (temporarily lower it to 1 h to test) → it auto-closes as `auto_closed`, with the threshold in the reason and an audit row. **It is never silent.**

### Review and reports
35. Open a ride → the replay map draws the route, with excluded fixes in grey.
36. Reclassify a segment → the total moves between buckets, the day total does not change, the original verdict is still on the segment, and the change is in the audit log.
37. Revert it → the machine verdict returns, and both decisions remain in the history.
38. Run each report for a week; export CSV and Excel and open both in Excel.
39. Import a restaurants CSV with two bad rows → the bad rows are listed, the good ones import.
40. Import the same file again → the rows update, they do not duplicate.
41. Change `stopMinDwellSec` in Settings → past rides are unchanged until you recalculate, and the UI says so.

---

## 4. Field validation (do this before trusting the numbers for pay)

Automated tests prove the maths is self-consistent. They cannot prove it matches
the road. For one week:

1. Pick two vehicles. Read the odometer at the start and end of each day.
2. Record GPS day-total vs odometer delta.
3. Expect the GPS figure to read **a few percent low** — it measures straight
   lines between fixes, and roads curve.
4. Record the ratio per vehicle. If it is stable, the system is behaving; if it
   swings day to day, look at the GPS reliability report for that driver before
   looking at the code.
5. Do **not** apply a correction factor to make one vehicle match. A fudge
   factor tuned on two weeks of one bike is how a tracking system stops being
   auditable.

Log the results in this file's history, alongside the `calcVersion` they were
measured against.
