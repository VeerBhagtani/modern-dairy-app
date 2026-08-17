# iOS IPA build & install (free Apple account, no App Store)

Mirrors the Android flow as closely as Apple's rules allow:

```
Android: Claude Code → build APK  → push to GitHub → download → install
iOS:     Claude Code → build IPA* → push to GitHub → download → sideload
```

\* CI produces a genuinely **unsigned** IPA. Apple requires every app on a
real iPhone to be signed with a real Apple ID — that can't happen
non-interactively in GitHub Actions without putting your Apple credentials
or a signing certificate into GitHub, which this setup deliberately never
does. So the one manual step is: **sign it locally, on your own computer,
with your own free Apple ID.** Nothing Apple-related ever touches GitHub.

Do NOT try to install the raw `.ipa` from the GitHub Release directly on
your iPhone (AirDrop, Mail, a link, etc.) — it is unsigned and iOS will
refuse to open it. It only becomes installable after the local signing step
below.

---

## 1. What CI does automatically (`.github/workflows/build-ipa.yml`)

On every push to `main`/`master` (and on-demand via **Actions → Build iOS
IPA → Run workflow**):

1. Generates the native iOS project fresh (`npx cap add ios` + `cap sync`)
   — same as the existing Simulator-only workflow already did.
2. Compiles the app for a real iPhone (`-sdk iphoneos`), with code signing
   explicitly turned off.
3. Packages the result into a standard `Payload/App.app` → `.ipa` zip.
4. Uploads it as a workflow **artifact** (`modern-dairy-ios-unsigned-ipa`).
5. Publishes/updates a GitHub **Release** tagged `ios-latest` with the IPA
   attached, so there's always one stable link to the newest build —
   `https://github.com/VeerBhagtani/modern-dairy-app/releases/tag/ios-latest`.

You don't need a Mac for any of this part.

---

## 2. Signing + installing on your iPhone (needs a Mac, once you have the IPA)

You have two realistic options. Both use your **free Apple ID** — no paid
Developer Program, no purchase.

### Option A — Sideloadly (simplest, Windows or Mac)

1. Install [Sideloadly](https://sideloadly.io/) on your Windows PC or Mac.
2. Plug in your iPhone, trust the computer.
3. Download the IPA from the `ios-latest` GitHub Release.
4. Open Sideloadly, drag the `.ipa` in, sign in with your Apple ID (this
   happens entirely inside Sideloadly, on your machine — it is never sent
   anywhere else, and it's never stored in this repo or GitHub).
5. Click Start. Sideloadly signs the IPA with a free-tier signing
   certificate tied to your Apple ID and installs it over USB.
6. On the iPhone: **Settings → General → VPN & Device Management** → trust
   the developer certificate (your Apple ID email) the first time.

### Option B — AltStore / AltServer (adds auto-refresh over Wi-Fi)

1. Install [AltServer](https://altstore.io/) on a Mac or Windows PC, and
   the AltStore companion app on your iPhone (AltServer walks you through
   this — it sideloads AltStore itself onto your phone once).
2. Sign into AltStore on the iPhone with your Apple ID.
3. Download the IPA from the `ios-latest` Release onto the iPhone (Files
   app, or AirDrop from your computer).
4. In AltStore on the iPhone: **My Apps → +** → pick the IPA file.
5. AltStore signs and installs it using your Apple ID via AltServer.
6. As long as AltServer is running on a computer on the same Wi-Fi as your
   phone periodically, AltStore can **auto-refresh** the app before it
   expires (see limitations below) — this is the main advantage over
   Sideloadly.

---

## 3. Free Apple ID signing — real limitations (this is Apple's policy, not a workaround)

- **Apps expire after 7 days.** A free Apple ID can only issue short-lived
  signing certificates. After 7 days, iOS refuses to launch the app until
  it's re-signed.
  - *Sideloadly:* just repeat the sideload (plug in, re-sign) every ~7 days
    with the latest IPA.
  - *AltStore:* can auto-refresh over Wi-Fi if AltServer is running on a
    nearby computer around the 7-day mark — no cable needed, but you do
    need to open AltStore on the phone occasionally so it can run.
- **Max 3 apps at a time per free Apple ID**, rotating every 7 days. Each
  distinct bundle ID you sideload counts against this. This app
  (`in.moderndairy.app`) only uses one slot, re-signing it each week
  doesn't add a new slot — it just renews the same one.
- **No push notifications, no background modes tied to Apple's paid
  entitlements**, and no App Store distribution — this is a personal
  developer-style install, not a production distribution channel.
- **Re-signing required whenever:**
  - 7 days pass since the last sign (mandatory, Apple-enforced), or
  - You install a new build (every time you pull a fresh IPA after making
    changes), or
  - You reinstall iOS / reset trust settings on the phone.

---

## 4. Building locally with Xcode instead (optional — only needed if you get a Mac and want to skip CI)

1. On a Mac with Xcode installed:
   ```
   npm install
   npx cap add ios      # generates ios/ (gitignored, not committed)
   npx cap sync ios
   npx cap open ios      # opens ios/App/App.xcworkspace in Xcode
   ```
2. In Xcode: select the `App` target → **Signing & Capabilities** → check
   "Automatically manage signing" → pick your Apple ID under Team (Xcode
   will offer a free "Personal Team" if you're not enrolled in the paid
   Program).
3. Plug in your iPhone, select it as the run destination, hit ▶ to build,
   sign, and install directly — no IPA/sideloading tool needed at all when
   you have physical Xcode access.
4. To export a standalone `.ipa` instead of installing straight from Xcode:
   **Product → Archive** → in the Organizer, **Distribute App → Development**
   → Xcode signs it with your free/personal team and exports a real signed
   `.ipa` you can install with Apple Configurator, Xcode's Devices window,
   or hand to Sideloadly/AltStore (already-signed IPAs work fine with
   those tools too).

---

## How I use this (future builds)

1. Make your code changes, push to `main`/`master` as usual (or run the
   workflow manually: **Actions → Build iOS IPA → Run workflow**).
2. Go to **Releases → `ios-latest`** (or the Actions run's Artifacts) and
   download `ModernDairy-unsigned.ipa`.
3. Sign + install it with **Sideloadly** (plug in phone, drag IPA, sign in
   with your Apple ID, click Start) — repeat this step roughly every 7 days
   even without a new build, since Apple's free signing certificates expire.
