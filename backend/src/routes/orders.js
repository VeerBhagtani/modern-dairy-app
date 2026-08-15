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

      const [configSnap, ...productSnaps] = await Promise.all([
        tx.get(col.appConfig()),
        ...items.map(i => tx.get(col.products().doc(i.productId))),
      ]);
      const appConfig = configSnap.exists ? configSnap.data() : {};

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

        const unitPrice = Number(variant.b2b ?? variant.mrp);
        const lineTotal = unitPrice * qty;
        subtotal += lineTotal;
        lineItems.push({
          productId: req_i.productId, variantId: req_i.variantId,
          name: product.name, label: variant.label, unit: product.unit,
          qty, unitPrice, lineTotal,
        });
      }

      const gstRate = Number(appConfig.gstRate ?? 0.05);
      const gstAmount = Math.round(subtotal * gstRate);
      const deliveryFee = Number(appConfig.deliveryFee ?? 0);
      const total = subtotal + gstAmount + deliveryFee;

      const minOrderValue = Number(appConfig.minOrderValue ?? 0);
      if (subtotal < minOrderValue) {
        throw httpError(400, `Minimum order value is ₹${minOrderValue}. Current subtotal is ₹${subtotal}.`);
      }

      const orderNo = 'MD' + Date.now().toString(36).toUpperCase();
      const orderRef = col.orders().doc(uuid());
      const orderData = {
        customerId: req.userId, orderNo, items: lineItems,
        subtotal, gstAmount, deliveryFee, total,
        status: 'placed', idempotencyKey: key,
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
