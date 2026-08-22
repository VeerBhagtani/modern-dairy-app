const router = require('express').Router();
const { col } = require('../services/firestore');

// The exact set of fields the customer app consumes. This endpoint is
// UNAUTHENTICATED, so it returned whatever happened to be in the app_config
// document — fine today, but the document is a shared mutable bag and the
// next person to stash an internal flag or a partner identifier in it would
// have published it to the internet by accident. Allowlist it at the edge.
const PUBLIC_CONFIG_FIELDS = [
  'businessName', 'logo', 'supportPhone', 'whatsapp', 'email', 'instagram', 'linkedin',
  'address', 'minOrderValue', 'freeDeliveryAbove', 'deliveryFee', 'platformFee', 'gstRate', 'orderCutoff',
  'businessHours', 'announcement', 'walletEnabled',
];

// GET /config — public runtime business config for the customer app (APPCFG merge).
router.get('/', async (req, res) => {
  const doc = await col.appConfig().get();
  const raw = doc.exists ? doc.data() : {};
  const data = {};
  for (const k of PUBLIC_CONFIG_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(raw, k)) data[k] = raw[k];
  }
  res.json({ success: true, data });
});

module.exports = router;
