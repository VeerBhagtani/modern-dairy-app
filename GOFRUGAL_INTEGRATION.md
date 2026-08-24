# GoFrugal billing integration

**Status as of 2026-08-24:** built and tested, **not live.** Two things block it:
the Cloud Run backend isn't deployed (Blaze-plan blocker), and API access isn't
enabled on the Modern Dairy GoFrugal licence.

## How it works

GoFrugal is the **billing system of record**. Pressing Print in the admin
panel's Bills tab does this:

```
Admin panel  ──POST /admin/orders/:id/bill──▶  Cloud Run backend  ──▶  GoFrugal
     ▲                                                                    │
     └────────  bill no. + IRN + signed QR  ◀─────────────────────────────┘
                              │
                              ▼
                    print on this PC's printer
```

The bill that comes out of the printer carries **GoFrugal's** invoice number.
Our own `orderNo` (MD-1041) drops to an "Order Ref." line. Two invoice numbers
for one sale is not an option, and the legal one is GoFrugal's.

It cannot go browser → GoFrugal directly: GoFrugal sends no CORS headers for
the Firebase Hosting origin, the hosting CSP's `connect-src` doesn't include
them, and the API key would sit in the browser for anyone with the admin page
open.

## What's already built

| Piece | Where | State |
|---|---|---|
| Bill-raising client | `backend/src/services/goFrugalClient.js` | Built; request/response shapes unverified |
| Endpoint | `POST /admin/orders/:id/bill` in `backend/src/routes/admin.js` | Built, idempotent, audit-logged |
| Firebase-token admin auth | `backend/src/middleware/adminAuth.js` | Built — the panel's existing Firebase login now works against the backend, no second login |
| Print flow | Bills tab in `legal/admin/index.html` | Built, behind Settings → "Raise bills in GoFrugal before printing" |
| Adapter tests | `tests/gofrugal.test.mjs` | 27 passing |
| Flow tests | `tests/bills-print.test.mjs` | 137 passing |

**Idempotency.** Pressing "Print all 40 bills" twice must never raise 80 bills.
An order that already has `gofrugal.billNo` is skipped client-side *and*
server-side; the server stakes a claim inside a Firestore transaction before
the network call, so two admins clicking at once can't both get through. A
claim expires after 2 minutes. On a **timeout** the claim is deliberately *not*
released — the bill may exist in GoFrugal, and a delayed retry beats a
duplicate in the books.

**Total cross-check.** We send our own totals as `expected`. GoFrugal recomputes
tax from its own masters; if its total differs from what the customer was
charged by more than ₹1, the order is flagged `totalMismatch`, the Bills list
shows "⚠ total differs", and printing asks for confirmation first. That
disagreement means a price or tax master is out of step — it should never be
printed over silently.

## What to ask GoFrugal support

API access is often gated behind a support request. Ask for:

1. **Enable API access** on the account (licence is active; API is not).
2. **The API base URL for our edition/tenant.** The code defaults to
   `https://api.gofrugal.com/rayapi/v1` — this is a guess. Set the real one in
   the `GOFRUGAL_API_BASE_URL` env var.
3. **The endpoint that raises a bill/invoice** (not a sales order — we need an
   allotted invoice number back). Set it in `GOFRUGAL_BILL_ENDPOINT`.
4. **The request schema** for that endpoint, and **the response schema** —
   specifically the field names for bill number, bill date, and total.
5. **Whether the response includes e-invoice fields** (IRN, AckNo, AckDt,
   SignedQRCode) when the bill qualifies, or whether that's a second call.
6. **Auth**: confirm it's the `X-Auth-Token` header, and how the token is
   issued/rotated.
7. **Duplicate protection**: will GoFrugal reject a second bill carrying the
   same `referenceNo`? If yes, that's a free second line of defence.
8. **Outlet and company IDs** for the Camp outlet.
9. **Rate limits.**

Only these need changing afterwards, all in `goFrugalClient.js`:
`BASE_URL`, `ENDPOINT`, `toGoFrugalBill()`, `fromGoFrugalResponse()`.

## Prerequisite: catalogue mapping

**This is the one thing that will block go-live even after the API is on.**
GoFrugal bills by its own item code. Our order items carry `pk` (product key)
and `vid` (variant id) — not a GoFrugal code. Until every product in Firestore
carries a `gofrugalItemCode`, GoFrugal cannot match our lines.

`toGoFrugalBill()` already prefers `i.gofrugalItemCode` and falls back to
`i.pk`. The remaining work is: add the field to the Products tab, fill it in
for every product/variant, and make the customer app copy it onto order items
at checkout.

## Configuration

**Secrets** (Secret Manager, via Admin Panel → API keys — never committed):
- `gofrugal` → API key
- `gofrugal_outlet_id`
- `gofrugal_company_id`

**Env vars** (Cloud Run): `GOFRUGAL_API_BASE_URL`, `GOFRUGAL_BILL_ENDPOINT`,
`GOFRUGAL_TIMEOUT_MS` (default 20000), `ADMIN_FIREBASE_UID`.

**Admin panel** (Settings): Backend URL, and the "Raise bills in GoFrugal
before printing" toggle. Both must be set before anything calls out — with
them unset, Print behaves exactly as it does today.

## Still open

- **QR rendering.** GoFrugal returns the IRP's signed QR payload and we store
  it, but nothing on the admin page can draw a QR yet. The bill prints a box
  saying "signed QR received — rendering not yet enabled" rather than a fake.
  Needs a QR encoder inlined into the page (a CDN library would need a CSP
  change). No fake QR is ever drawn — only the IRP's signed payload is valid.
- **Order of operations at go-live**: deploy backend → enable GoFrugal API →
  map the catalogue → test on ONE bill → then turn the Settings toggle on.
