const router = require('express').Router();
const { v4: uuid } = require('uuid');
const { col, db, FieldValue } = require('../services/firestore');
const { requireAuth } = require('../middleware/auth');
const { writeLimiter } = require('../middleware/rateLimit');
const { isValidId, isPositiveInt, isOptionalBoundedString } = require('../middleware/validate');

router.use(requireAuth());

// GET /orders — this customer's orders, newest first.
router.get('/', async (req, res) => {
  const snap = await col.orders()
    .where('customerId', '==', req.userId)
    .orderBy('placedAt', 'desc')
    .limit(100)
    .get();
  res.json({ success: true, data: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
});

// GET /orders/:id
router.get('/:id', async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(404).json({ success: false, message: 'Order not found' });
  const doc = await col.orders().doc(req.params.id).get();
  if (!doc.exists || doc.data().customerId !== req.userId) {
    return res.status(404).json({ success: false, message: 'Order not found' });
  }
  res.json({ success: true, data: { id: doc.id, ...doc.data() } });
});

const MAX_ITEMS = 50;
const MAX_QTY = 100000;

// POST /orders { items:[{productId, variantId, qty}], idempotencyKey }
// Prices, MOQ, and totals are ALWAYS recomputed server-side from Firestore product
// data — client-submitted prices/totals are ignored. This is intentional: the
// frontend must never be the source of truth for money.
router.post('/', writeLimiter, async (req, res) => {
  const { items, idempotencyKey } = req.body || {};
  if (!Array.isArray(items) || !items.length || items.length > MAX_ITEMS) {
    return res.status(400).json({ success: false, message: `items must be an array of 1 to ${MAX_ITEMS} entries` });
  }
  if (!isOptionalBoundedString(idempotencyKey, { max: 200 })) {
    return res.status(400).json({ success: false, message: 'idempotencyKey is too long' });
  }
  for (const i of items) {
    if (!i || !isValidId(i.productId) || !isValidId(i.variantId) || !isPositiveInt(Number(i.qty), { max: MAX_QTY })) {
      return res.status(400).json({ success: false, message: 'Each item needs a valid productId, variantId, and qty' });
    }
  }
  const key = idempotencyKey || null;

  try {
    const order = await db.runTransaction(async (tx) => {
      if (key) {
        const existing = await tx.get(col.orders().where('customerId', '==', req.userId).where('idempotencyKey', '==', key).limit(1));
        if (!existing.empty) {
          const d = existing.docs[0];
          return { id: d.id, ...d.data(), _alreadyExisted: true };
        }
      }

      const [configSnap, customerSnap, ...productSnaps] = await Promise.all([
        tx.get(col.appConfig()),
        tx.get(col.customers().doc(req.userId)),
        ...items.map(i => tx.get(col.products().doc(i.productId))),
      ]);
      const appConfig = configSnap.exists ? configSnap.data() : {};
      // The customer's tier comes from their SERVER-SIDE record, read inside
      // this transaction — never from the request. Without this the line below
      // charged variant.b2b to everyone whenever a wholesale price existed, so
      // every retail order was silently billed at wholesale.
      if (!customerSnap.exists) throw httpError(401, 'Account not found');
      const isB2B = customerSnap.data().customerType === 'b2b';

      let subtotal = 0;
      const lineItems = [];
      for (let idx = 0; idx < items.length; idx++) {
        const req_i = items[idx];
        const pSnap = productSnaps[idx];
        if (!pSnap.exists) throw httpError(400, `Product ${req_i.productId} does not exist`);
        const product = pSnap.data();
        const variant = (product.variants || []).find(v => v.id === req_i.variantId);
        if (!variant) throw httpError(400, `Variant ${req_i.variantId} not found on ${req_i.productId}`);
        if (variant.stock === 'out') throw httpError(400, `${product.name} (${variant.label}) is out of stock`);

        const qty = Number(req_i.qty) || 0;
        if (qty < (variant.moq || 1)) {
          throw httpError(400, `${product.name} (${variant.label}) requires a minimum quantity of ${variant.moq}`);
        }

        const unitPrice = Number(isB2B ? (variant.b2b ?? variant.mrp) : variant.mrp);
        const lineTotal = unitPrice * qty;
        subtotal += lineTotal;
        lineItems.push({
          productId: req_i.productId, variantId: req_i.variantId,
          name: product.name, label: variant.label, unit: product.unit,
          qty, unitPrice, lineTotal,
        });
      }

      const gstRate = Number(appConfig.gstRate ?? 0.05);
      // Rounded to paise, matching cartTotals() in www/index.html. This was
      // Math.round(...) — whole rupees — so the server's total disagreed with
      // the total the customer was quoted on any order where GST had a paise
      // component, and with the 1-rupee tolerance the Firestore rules allow.
      const gstAmount = Math.round(subtotal * gstRate * 100) / 100;
      const deliveryFee = Number(appConfig.deliveryFee ?? 0);
      const platformFee = Number(appConfig.platformFee ?? 2);
      const total = Math.round((subtotal + gstAmount + deliveryFee + platformFee) * 100) / 100;

      // The minimum order value is a WHOLESALE term — it buys the customer
      // wholesale rates and credit. Applying it to retail (as this did) would
      // have rejected every ordinary customer's order under ₹2,000 the day the
      // backend went live. movMet() in the app has always gated it on b2b.
      const minOrderValue = Number(appConfig.minOrderValue ?? 0);
      if (isB2B && subtotal < minOrderValue) {
        throw httpError(400, `Minimum order value is ₹${minOrderValue}. Current subtotal is ₹${subtotal}.`);
      }

      const orderNo = 'MD' + Date.now().toString(36).toUpperCase();
      const orderRef = col.orders().doc(uuid());
      const orderData = {
        customerId: req.userId, orderNo, items: lineItems,
        // Recorded from the server-side customer record, so anything that
        // re-checks this order later (verify-order-prices.js, billing) is
        // reading a tier the customer could not choose for themselves.
        customerType: isB2B ? 'b2b' : 'b2c',
        subtotal, gstAmount, deliveryFee, platformFee, total,
        status: 'placed', idempotencyKey: key,
        // Priced server-side in this transaction, so it never needs the
        // out-of-band price check that client-written orders do.
        priceVerified: true, priceMismatch: false,
        placedAt: FieldValue.serverTimestamp(),
      };
      tx.set(orderRef, orderData);
      return { id: orderRef.id, ...orderData };
    });

    res.json({ success: true, data: order });
  } catch (e) {
    if (e.httpStatus) return res.status(e.httpStatus).json({ success: false, message: e.message });
    console.error('order create failed', e);
    res.status(500).json({ success: false, message: 'Could not place the order. Please try again.' });
  }
});

function httpError(status, message) {
  const e = new Error(message);
  e.httpStatus = status;
  return e;
}

module.exports = router;
