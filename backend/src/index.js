const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const configRoutes = require('./routes/config');
const authRoutes = require('./routes/auth');
const ordersRoutes = require('./routes/orders');
const walletRoutes = require('./routes/wallet');
const adminRoutes = require('./routes/admin');

const app = express();
app.use(helmet());
app.use(cors()); // tighten to the app's actual origin(s) once known
app.use(express.json({ limit: '1mb' }));

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.use('/config', configRoutes);
app.use('/auth', authRoutes);
app.use('/orders', ordersRoutes);
app.use('/wallet', walletRoutes);
app.use('/admin', adminRoutes);

app.use((req, res) => res.status(404).json({ success: false, message: 'Not found' }));

// Keep error responses generic to the client; log full detail server-side.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Modern Dairy backend listening on :${PORT}`));
