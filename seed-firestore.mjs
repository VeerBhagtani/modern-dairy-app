// One-time seed script: pushes the app's bundled CATALOGUE + APPCFG into
// Firestore's products/categories/app_config collections, so the admin
// website has real data to show and edit, and the customer app (once wired
// to read them) sees the same source of truth. Run with: node seed-firestore.mjs
// Not part of the app build — delete or ignore after running.
import fs from 'fs';

const PROJECT_ID = 'modern-dairy-pune';
const API_KEY = 'AIzaSyD-3RNHrI9ZPmdTioLiuCi2gjwdNXZH8HI';
const ADMIN_EMAIL = 'modern_dairy@admin.local';
const ADMIN_PASSWORD = 'Mdairypune@1942';

function toFirestoreValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFirestoreValue) } };
  if (typeof v === 'object') return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, val]) => [k, toFirestoreValue(val)])) } };
  return { stringValue: String(v) };
}

async function main() {
  const authRes = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD, returnSecureToken: true }),
  });
  const auth = await authRes.json();
  const token = auth.idToken;
  if (!token) { console.error('Auth failed:', auth); process.exit(1); }

  const catalogue = JSON.parse(fs.readFileSync('./scratch_catalogue.json', 'utf8'));
  let count = 0;
  for (const [id, product] of Object.entries(catalogue)) {
    const fields = toFirestoreValue(product).mapValue.fields;
    const res = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/products/${id}`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    });
    if (!res.ok) { console.error(`Failed for ${id}:`, await res.text()); } else { count++; }
  }
  console.log(`Seeded ${count} products.`);

  const appConfig = {
    businessName: 'Modern Dairy', logo: 'assets/logo.png', supportPhone: '+919881232966',
    whatsapp: '919881232966', email: 'info@moderndairy.in',
    instagram: 'https://www.instagram.com/modern.dairy/', linkedin: 'https://www.linkedin.com/company/modern-dairy-pune/',
    address: '1942, Dr. Saldhana Street, Camp, Pune 411001', minOrderValue: 2000, freeDeliveryAbove: 0,
    deliveryFee: 0, gstRate: 0.05, orderCutoff: '6:00 PM',
    businessHours: 'Mon–Sat 8:00 AM – 9:00 PM · Sun 8:00 AM – 2:00 PM', announcement: '', walletEnabled: true,
  };
  const cfgFields = toFirestoreValue(appConfig).mapValue.fields;
  const cfgRes = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/app_config/singleton`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: cfgFields }),
  });
  console.log('app_config seeded:', cfgRes.ok);
}
main();
