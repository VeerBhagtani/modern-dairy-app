# Firestore collections

- **customers/{id}** — `name, phone, customerType('b2b'|'b2c'), company, gstin, balance, createdAt`
- **customers/{id}/wallet_ledger/{id}** — `type, amount, note, status('pending_confirmation'|'settled'), at, settledAt, settledBy, newBalance`
- **orders/{id}** — `customerId, orderNo, items[{productId,variantId,name,label,unit,qty,unitPrice,lineTotal}], subtotal, gstAmount, deliveryFee, total, status, idempotencyKey, placedAt`
- **products/{id}** — `name, cat, img, unit, desc, storage, freshness, active, variants[{id,label,mrp,b2b,moq,case,stock('in'|'low'|'out')}]`
- **categories/{id}** — `name, order, active`
- **app_config/singleton** — public APPCFG fields (businessName, phone, whatsapp, email, instagram, address, businessHours, minOrderValue, gstRate, deliveryFee, announcement, walletEnabled, ...)
- **admin_audit_log/{id}** — `adminId, action, target, before, after, at`
- **admins/{username}** — `passwordHash` (bcrypt) — create the first admin manually, see README
