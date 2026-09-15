# Download the app

**[modern-dairy-v1.0-demo.apk](modern-dairy-v1.0-demo.apk)** — 6.0 MB, Android 5.1+

Open that link on the phone and tap **Download raw file**. Android will ask you
to allow installs from your browser or file manager the first time; allow it,
then open the downloaded file.

| | |
|---|---|
| Package | `in.moderndairy.app` |
| Version | 1.0 (versionCode 1) |
| Min Android | 5.1 (API 22) |
| SHA-256 | see `modern-dairy-v1.0-demo.apk.sha256` |

## Signing in

Any 10-digit number, OTP **`0000`**. The sign-in screen tells you this too.

No SMS is sent: this build has no OTP provider credential, so it was built with
`DEMO_BUILD=true`, which turns on the fixed test code. `scripts/inject-secrets.js`
**refuses** to combine that flag with real credentials, so a build that can send
real SMS can never also accept `0000`.

## What this build does and does not do

**Real:** placing an order writes to Firestore, so it shows up in the admin
panel. Firestore security rules apply to it exactly as they would in production.

**Local to the phone:** wallet balance, credit, order history, your account.
Those are served by `MOCK()` in `www/index.html` because the Cloud Run backend
is written but not deployed (it needs Blaze billing). Uninstalling loses them.

**Not checked:** the GSTIN field validates format only — there is no GST
credential in this build, so nothing is verified against the government
register.

This is a **debug-signed** APK. It is for testing on your own devices. It is not
a Play Store release and must not be distributed to customers — see
`../DEPLOYMENT.md` step 4 for the real release path.

## Rebuilding it yourself

```bash
npm ci
DEMO_BUILD=true node scripts/inject-secrets.js
node scripts/inject-config.js          # add API_BASE=... for a live build
npm run preflight:built
npx cap sync android
cd android && ./gradlew assembleDebug
```
