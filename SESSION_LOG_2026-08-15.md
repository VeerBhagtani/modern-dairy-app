# Session Log — 2026-08-15

A chronological record of today's work. See `PROGRESS.md` in this same
folder for the current-state summary — this file is the "how we got here."

## What happened today, in order

1. **GST verification wired to sandbox.co.in** — switched the backend's GST
   client and Admin Panel from a single-key assumption to sandbox.co.in's
   real two-step flow (API key + secret → short-lived access token).
2. **Super admin account + stock-based order auto-confirmation** — replaced
   the shared admin password with a named super admin account (username +
   password). Orders now auto-confirm when every item is in stock, or land
   in a new "Pending confirmation" queue when anything is low stock.
3. **Built and shipped the Android APK** through several iterations,
   downloading GitHub Actions build artifacts and cutting tagged Releases
   (v1.6.0 through v2.7.0 across today).
4. **Wallet opened to all customers** (not just B2B), with a simulated
   Razorpay checkout for top-ups (uses the real widget if a live key is
   configured, otherwise a working fake payment for testing).
5. **Customer signup password** added (with confirm password), and a fix for
   the on-screen keyboard covering form fields (`windowSoftInputMode` wasn't
   set on the Android activity).
6. **Full backend security audit** (explicit, detailed user request): rate
   limiting per-endpoint sensitivity, server-side input validation across
   every route, JWT algorithm pinning, timing-safe webhook signature
   comparison, CORS allowlist, `.gitignore` secret-file patterns, dependency
   audit. Verified live (started the backend locally, hit real endpoints,
   confirmed 429s/400s/413s behave correctly) rather than just claimed.
7. **The OTP saga** (the bulk of today):
   - Enabled Firebase Authentication + Phone sign-in provider via API (free).
   - Registered a real Firebase Web app, wired it in — then discovered real
     Phone Auth needs Blaze billing (reCAPTCHA Enterprise requirement),
     confirmed directly via Google's API. Reverted to demo OTP rather than
     ship a broken flow.
   - User set up MSG91's OTP Widget — never got a response from it in the
     Capacitor WebView, across Web mode, Mobile mode, and even with
     Capacitor's native HTTP bridging enabled to bypass browser CORS.
   - Switched to MSG91's plain REST API instead — worked for sending, but
     delivery logs showed "DLT Template id not found": their default
     (DLT-exempt) template only applies to the Widget product, not the raw
     API. This is a real India/TRAI regulatory requirement, not a bug.
   - Switched providers entirely to **Message Central (VerifyNow)** — their
     OTP route doesn't require DLT/Sender ID registration. Verified all
     three calls (auth, send, verify) live against their real server before
     shipping. **This is what's live today and confirmed working.**
   - Fixed the OTP entry screen expecting 6 digits when Message Central
     sends 4-digit codes.
   - Added a free test phone number (9000000000, code 0000) that bypasses
     the real paid OTP send entirely, so testing doesn't cost money.
8. **GST verification moved to live**, same reasoning as OTP — wired
   directly into the app instead of waiting on backend deployment. Verified
   live against a real GSTIN. Found and fixed a bug in the backend's
   `gstClient.js` in the process (wrong endpoint shape, never actually
   tested until today).
9. **Admin sign-in UX** — removed the visible "Sign in as admin" button
   entirely (user's own security instinct: don't advertise where the admin
   panel is). Replaced with a 5-tap-the-logo gesture, no visible affordance.
10. **Sign In / New account split** — login screen previously forced every
    single sign-in (even returning users) through the full signup flow,
    including re-verifying GSTIN every time for B2B. Added a proper Sign In
    mode: phone + password + OTP only, restoring saved company/GSTIN from
    the local account record.
11. **Logo made bigger** across every screen (top bar, home header,
    catalogue header) after user feedback it was too small.
12. **First iOS build** — GitHub Actions macOS runner builds an unsigned
    Simulator-only `.app`. Confirmed working on the first attempt. Real
    iPhone installation needs an Apple Developer account, not set up yet.

## Key decisions made (so a fresh session doesn't re-litigate them)
- **Real OTP provider is Message Central, not MSG91 or Firebase.** Don't
  re-attempt MSG91 or Firebase Phone Auth without a clear reason — both were
  thoroughly dead-ended today (DLT wall / Blaze wall respectively).
- **DLT registration (India/TRAI) is a real regulatory requirement**, not
  something route-around-able in code, for any provider doing custom
  templates. Message Central's OTP route specifically avoids needing it;
  don't assume other providers do too without checking.
- **sandbox.co.in credentials given today are LIVE/production**, not
  sandbox/test — real cost per GST lookup. Use the free test GSTIN
  (27AAPFM1234A1ZV) for any further testing.
- Two real secrets now ship inside the public repo/APK by deliberate,
  discussed tradeoff (Message Central token, sandbox.co.in key+secret) —
  both flagged inline in code, both meant to move server-side once the
  backend deploys. Not an oversight.
- Admin entry point is intentionally hidden (5-tap logo), not a UX bug.
- Backend deployment (Blaze plan) remains the single next big unlock —
  covers real Firestore-backed data, moving the two exposed secrets
  server-side, and (optionally) switching OTP to Firebase if ever wanted.

## How to resume
Open Claude Code in this folder and continue — conversation history and all
the decisions above persist. The GitHub repo, Firebase project, and this
folder are the durable state.
