# Play Store Listing — ready to paste

Prepared 2026-08-16, ready for the moment the Play Console account is approved.

## App details
- **App name** (max 30 chars): `Modern Dairy`
- **Category**: Shopping (or Food & Drink — either fits; Shopping usually
  gets better discovery for an ordering app)
- **Contact email**: info@moderndairy.in
- **Contact phone**: +91 98812 32966
- **Website**: (use the Firebase Hosting URL for now if no separate site: https://modern-dairy-pune.web.app)
- **Privacy Policy URL**: https://modern-dairy-pune.web.app/privacy-policy.html

## Short description (max 80 characters)
```
Order dairy, frozen & beverages from Modern Dairy Pune — business or personal
```
(78 chars)

## Full description (max 4000 characters)
```
Modern Dairy — Wholesale & Personal Ordering, Pune

Order fresh dairy, frozen foods, and beverages directly from Modern Dairy,
Pune's trusted dairy supplier since 1975. Whether you run a shop, restaurant,
or hotel, or you're ordering for your home, Modern Dairy makes it simple.

FOR BUSINESSES
• Wholesale pricing with GSTIN verification
• Business credit wallet — top up and order without repeated payments
• Tax invoices for every order
• Bulk ordering with minimum order value discounts

FOR PERSONAL CUSTOMERS
• Browse the full catalogue — milk, ghee, paneer, curd, frozen snacks, and more
• Simple phone-based sign in, no passwords to remember card details
• Track your orders and reorder your regulars in one tap

WHY MODERN DAIRY
• Family-run business since 1956, serving Pune for over 65 years
• FSSAI licensed, quality-checked products
• Reliable next-day delivery across Pune
• Real customer support — call, WhatsApp, or email us directly

Download the app to get started. New here? Sign up in under a minute with
just your phone number.

Need help? Reach us at +91 98812 32966 or info@moderndairy.in.
```
(~1250 chars — well under the 4000 limit; can expand later with more product detail if wanted)

## Content rating questionnaire — how to answer
Google's IARC questionnaire asks about violence, sexual content, gambling,
etc. For this app, every answer is straightforwardly "No" / "None" — it's a
retail ordering app with no user-generated content, no chat between
strangers, no gambling, no mature themes. Expect a rating of **"Everyone"
(3+)** or similar once submitted — no action needed beyond answering
honestly, which is easy here.

## Target audience & content
- **Target age group**: 18+ is reasonable given it involves account
  creation, payments, and a wallet — select "Adults" or the oldest bracket
  offered if Play forces a single age selection, even though older teens
  could plausibly use it too. Simpler and avoids extra child-safety
  requirements that don't apply to this app's actual audience.
- **Ads**: No (app doesn't show ads)
- **In-app purchases**: Technically no (wallet top-ups are prepaid balance
  for real-world dairy products, not in-app digital content — but if Play
  Console's form doesn't have a clean category for this, "No" is still the
  most accurate answer since nothing is purchased *within* the app itself
  in the traditional in-app-purchase sense)

## Data Safety form — answers to paste

Play Console's Data Safety form asks what data is collected and why, per
category. Based on what the app actually does:

| Data type | Collected? | Shared with third parties? | Purpose |
|---|---|---|---|
| Name | Yes | No | Account functionality |
| Phone number | Yes | Yes (SMS/OTP provider, for verification only) | Account functionality, App functionality |
| Physical address | Yes (delivery address) | No | App functionality (order fulfilment) |
| Other financial info (wallet balance, order value) | Yes | No | App functionality |
| Payment info | No — collected directly by Razorpay, not by this app | Yes (Razorpay, to process payment) | App functionality |
| App activity (order history) | Yes | No | App functionality, Analytics |
| Device or other identifiers | No | No | — |

Additional questions Play Console will ask:
- **Is all data encrypted in transit?** Yes (HTTPS everywhere)
- **Do you provide a way for users to request data deletion?** Yes — via
  contacting support (email/phone in Privacy Policy section 8)
- **Is data collection required or optional?** Required for core account/
  ordering functionality — the app can't function without a phone number
  and, for Business accounts, a GSTIN

## Screenshots & graphics — still needed (can't draft these, need the real app)
- **App icon**: already exists (`android/app/src/main/res/mipmap-*`)
- **Feature graphic** (1024×500 px): needs a designed banner — can create
  once you confirm you want one, or source a designer
- **Phone screenshots** (min 2, recommend 4-8): need to be captured from the
  actual running app — Home screen, Catalogue, Cart/Checkout, and Order
  tracking are good choices. Can walk through capturing these together when
  ready.
