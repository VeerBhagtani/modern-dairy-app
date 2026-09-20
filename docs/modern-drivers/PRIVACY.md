# Modern Drivers — privacy position

This platform records where ~40 employees are, all working day. That is
sensitive personal data and the design treats it as such. This document states
what the system does, what it deliberately does not do, and what still needs a
lawyer.

**This is an engineering position, not legal advice.** Have counsel review the
driver notice and the retention period before rollout.

---

## What is collected

Only while a ride is active:

| Field | Why |
|---|---|
| latitude, longitude | the journey itself — the whole point |
| device timestamp | ordering, dwell detection, distance |
| server receipt time | to detect a wrong or tampered phone clock |
| accuracy | to know which fixes can be trusted for distance |
| speed, heading | anomaly detection; often absent, and absence is fine |
| provider, mock flag | to detect falsified locations |
| battery % | to explain why tracking stopped |
| driver id, ride id | to attribute the journey |

Not collected: contacts, call logs, SMS, photos, microphone, other apps,
browsing, or anything at all outside an active ride.

## When it is collected

Between an explicit **Start Ride** by the driver and a **stop by an
administrator** (or the configured automatic timeout). There is no other code
path that starts tracking. There is no hidden or silent mode, and adding one
would require changing the Android app, the backend and the audit log
simultaneously.

The driver always knows:

* Android shows a **persistent notification** the entire time.
* The app's main screen shows a green/amber/red tracking state and the age of
  the last position.
* The notice below is shown at enrolment and reachable at any time from the
  main screen.

## Who can see it

* Administrators signed in to the dashboard with the Modern Dairy Firebase
  account, under a role (`admin` / `manager` / `viewer`).
* The backend service account, to process it.
* Nobody else. Firestore rules deny every other client identity, and drivers
  have no Firestore identity at all.

Every administrative action — stopping a ride, reclassifying a segment,
changing a threshold, deleting expired data — is written to
`drivers_audit_log` with who, when and why.

## How long it is kept

Configurable in Settings, with these defaults:

| Data | Default |
|---|---|
| Raw GPS points | 180 days |
| Processed results, segments, matches | 3 years |
| Tracking health events | 1 year |
| Audit log, reviews, alerts | not auto-deleted inside the retention window |

Raw points are deleted only after the ride has a processed result, so reports
stay auditable after the point cloud is gone. Deletion is real, irreversible,
and audited — which is why the scheduled job only *reports* what is expired and
an actual deletion is a deliberate manual run.

## Alignment with Indian law

The design follows the **Digital Personal Data Protection Act 2023**
principles:

| Principle | How |
|---|---|
| Notice | shown at enrolment and on the main screen, in plain words |
| Purpose limitation | tracking only during an authorised ride, only for business kilometres and operational support |
| Data minimisation | no field is collected that the kilometre calculation or tracking health does not need |
| Storage limitation | finite, configurable retention with real deletion |
| Accuracy | drivers and admins can correct classifications, with an audit trail |
| Security | TLS everywhere, role-based access, no client write path, secrets in Secret Manager |
| Accountability | every access-granting decision and every admin action is logged |

**Open questions for counsel**, which the code cannot settle:

1. Is employee consent the right lawful basis here, or legitimate employment
   purposes? The notice is written for the second, with consent recorded at
   enrolment as evidence of notice.
2. Is 180 days the right raw-GPS retention for a payroll and dispute window?
3. Does the driver's employment contract need amending to reference this?
4. What is the grievance route if a driver disputes a day's classification? The
   system supports review and correction; the *process* is a management matter.

## What this system deliberately will not do

* It will not track outside an authorised ride.
* It will not let an administrator start tracking on a driver's phone remotely.
* It will not hide that tracking is on.
* It will not present a stale position as a live one.
* It will not put a coordinate in an alert, an email or a notification.
* It will not delete or edit a raw GPS point during processing.
* It will not guess that an unexplained stop was personal — or business.

---

## The driver notice (as shown in the app)

> **How Modern Drivers uses your location**
>
> * Your location is recorded only while a ride is running — from the moment
>   you press Start Ride until the office stops it.
> * It is used to work out the kilometres you travel for Modern Dairy
>   deliveries, and to help the office find you if a delivery goes wrong.
> * It is not recorded before you start a ride, and it is not recorded after
>   the office stops it.
> * Only Modern Dairy office staff with a dashboard login can see it.
> * Android shows a permanent notification on your phone the whole time
>   tracking is on.
> * Location history is deleted automatically after the retention period set by
>   the office.
> * You can mark part of your day as personal in the app. Personal stretches
>   are kept out of Modern Dairy business kilometres.
> * Only the office can stop a ride. If you need it stopped, call the office.

The authoritative copy is `PRIVACY_NOTICE` in
`backend/src/routes/driver.js` — served from the server so the wording can be
corrected without shipping a new APK, and so there is exactly one version of it.
Translate it to Marathi and Hindi before rollout; the array it lives in takes
any number of lines.
