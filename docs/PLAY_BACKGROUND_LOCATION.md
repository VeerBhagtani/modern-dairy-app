# Publishing Modern Drivers with background location

Google Play reviews **every** app that requests `ACCESS_BACKGROUND_LOCATION`
by hand, and rejects most of them. Read this before submitting; a rejection
costs a week.

## First: do you need Play at all?

Probably not. This is an internal app for ~40 employees of one company. Three
routes, easiest first:

1. **Direct APK distribution.** Build the APK in CI and send it to drivers.
   No review, no policy, no waiting. Drivers must allow "install unknown apps"
   once. This is the recommended route for the first rollout, and it is what
   `build-drivers-apk.yml` produces today.
2. **Managed Google Play (private app).** If Modern Dairy has Google Workspace,
   publish privately to the organisation. Still reviewed, but as a private app
   the background-location bar is lower.
3. **Public Play listing.** Only if the app must be installable from the store
   by anyone. Everything below applies.

## If you do submit publicly

### 1. The manifest must be honest

`scripts/patch-drivers-manifest.js` adds:

```
ACCESS_FINE_LOCATION
ACCESS_COARSE_LOCATION
ACCESS_BACKGROUND_LOCATION
FOREGROUND_SERVICE
FOREGROUND_SERVICE_LOCATION      (required from Android 14)
RECEIVE_BOOT_COMPLETED
ACCESS_NETWORK_STATE
POST_NOTIFICATIONS
```

and declares the plugin's service with `foregroundServiceType="location"`.
Without that last part the app crashes on Android 14 the moment tracking
starts — on exactly the newest phones.

### 2. The Data safety form

Declare, truthfully:

* **Location (precise)** — collected, **shared: no**, not optional for the
  app's core purpose, encrypted in transit, deletable on request.
* Purpose: *App functionality* and *Business/fleet management*. Do **not** tick
  analytics, advertising or personalisation; none of them is true here, and an
  untrue Data safety form is its own violation.

### 3. The background-location justification

Reviewers want a specific, verifiable answer to "why can this not work in the
foreground?". Something like:

> Modern Drivers is an internal fleet app used by delivery drivers employed by
> Modern Dairy, Pune. A driver starts a shift in the app and then rides a
> motorcycle or tempo for 8–12 hours with the phone in a pocket or a mount,
> screen off. The app records the route to calculate the business kilometres
> the driver is paid for and to let the dispatch office locate a delivery in
> progress. Foreground-only access would stop recording the moment the screen
> locks, which is essentially the entire shift, and the kilometre figures the
> drivers are paid on would be wrong. Tracking runs only between an explicit
> "Start Ride" by the driver and a stop by the office; a persistent
> notification is displayed for the whole period; no location is recorded
> outside that window.

### 4. The demo video

Required, and the most common cause of rejection. It must show, in one take:

1. the app opening on a real device;
2. the in-app notice explaining what is collected and why, **before** the
   permission prompt;
3. the system permission dialog and the choice of "Allow all the time";
4. Start Ride;
5. the persistent notification in the shade;
6. the screen locking and the app continuing to record.

Upload it unlisted to YouTube and link it in the form.

### 5. The prominent-disclosure screen

Play requires an in-app disclosure **before** the permission request, saying
what is collected and why. The app shows `PRIVACY_NOTICE` (served from
`backend/src/routes/driver.js`) at enrolment, before any permission prompt.
Screenshot it for the submission.

### 6. Privacy policy

A public URL is mandatory. `legal/privacy-policy.html` already exists for the
customer app; add a Modern Drivers section covering the fields in
[`PRIVACY.md`](PRIVACY.md), or publish a separate page.

## Common rejection reasons, and how this app stands

| Reason | Status |
|---|---|
| No prominent in-app disclosure before the prompt | covered — enrolment notice |
| Background location not core to the feature | genuinely core; justification above |
| Video does not show the flow end to end | your job at submission time |
| Data safety form contradicts the manifest | keep both honest; they will be compared |
| App works fine in the foreground only | it does not, and the video shows why |
| Missing `foregroundServiceType` on Android 14 | added by the manifest patch script |
