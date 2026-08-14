const router = require('express').Router();
const { col } = require('../services/firestore');

// GET /config — public runtime business config for the customer app (APPCFG merge).
// Never returns secrets; only content an admin has explicitly set as public.
router.get('/', async (req, res) => {
  const doc = await col.appConfig().get();
  const data = doc.exists ? doc.data() : {};
  res.json({ success: true, data });
});

module.exports = router;
