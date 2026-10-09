# Real-device test checklist

Automated tests cannot prove what Android does to a running app. Do this on
each phone model the drivers use, with the newest APK
(https://modern-drivers-pune.web.app/modern-drivers.apk, app version 2.1.0).
Keep the office dashboard open on a laptop: Live fleet, and the driver's
**Tracking diagnostics**.

## Record per phone

| Item | Value |
|------|-------|
| Make / model | |
| Android version | (app: ⓘ → Something is not working → Android version) |
| Location permission | Allow all the time / While using |
| Precise location | on / off |
| Battery optimisation | Unrestricted / Optimised (+ maker setting: Autostart, background activity) |
| Notifications allowed | yes / no |

## Tests (mark pass/fail, note times)

1. **Start** — Start Ride. Notification "Modern Drivers — ride in progress"
   appears. Dashboard: **Live** within 30 s.
2. **Update rate** — drive 2 km. Marker moves at least every ~20 s;
   "fix … received …" gap on the dashboard ≤ 20 s. Note the upload latency
   (fix time vs received time).
3. **C: screen locked** — lock the phone, drive 10 min. Dashboard stays
   **Live** throughout; the route has no gap.
4. **D: background** — open WhatsApp/Maps for 10 min while driving.
   Same as above.
5. **B: no internet** — mobile data off, drive 10 min. Dashboard shows
   **Stale location** (or **Internet disconnected** if the phone reported it);
   the app says "Recording — offline" with a growing count. Data back on:
   within 1 min the count reaches 0, the route fills the gap with the original
   times, and km increase within ~2 min. No duplicate kilometres.
6. **GPS off** — turn Location off for 2 min. Dashboard: **GPS unavailable —
   Location switch is off** within ~1 min. Turn on: back to **Live**.
7. **Indoors** — stay in a basement 5 min: **GPS unavailable — no GPS fix
   since …** (not "no signal").
8. **Kill the app** — swipe it away from recents. Note whether the
   notification stays (phone-dependent). Dashboard after 2 min: **Stale**.
   Reopen the app: recording resumes; queued fixes upload.
9. **Restart the phone mid-ride** — "ride not recorded" notification appears;
   tapping it resumes.
10. **I: office stop** — stop the ride from the dashboard while the phone has
    data off; turn data on: the app shows "The office stopped your ride",
    the notification disappears, no new ride starts.
11. **Distance** — compare the day's measured km with the car's trip meter or
    Google Maps timeline for the same route; note the difference.
12. **Battery** — note battery % at start and after 2 h of riding.

## Pass criteria

- No unexplained gap > 2 min with the screen locked (tests 3–4).
- Every non-live period shows the right cause (tests 5–8).
- After reconnecting, no fix lost and no km doubled (test 5).
- Measured km within ~5 % of the reference (test 11).

Any failure: open **Tracking diagnostics**, screenshot it, and note the phone
model — the "Reported by the phone" block says what the phone believed.
