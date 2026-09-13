const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    projectId: process.env.GCP_PROJECT_ID,
  });
}

const db = admin.firestore();
if (process.env.FIRESTORE_DATABASE_ID && process.env.FIRESTORE_DATABASE_ID !== '(default)') {
  db.settings({ databaseId: process.env.FIRESTORE_DATABASE_ID });
}

const col = {
  customers: () => db.collection('customers'),
  orders: () => db.collection('orders'),
  products: () => db.collection('products'),
  categories: () => db.collection('categories'),
  walletLedger: (customerId) => db.collection('customers').doc(customerId).collection('wallet_ledger'),
  // Across every customer. Used by the Razorpay webhook to find the deposit
  // request a captured payment belongs to from its order id alone, without
  // having to trust the customerId carried in the payment's notes.
  // Needs the COLLECTION_GROUP index in firestore.indexes.json.
  walletLedgerGroup: () => db.collectionGroup('wallet_ledger'),
  auditLog: () => db.collection('admin_audit_log'),
  appConfig: () => db.collection('app_config').doc('singleton'),
  otpChallenges: () => db.collection('otp_challenges'),
  // Proof that a phone number's GSTIN was actually checked against the GST
  // provider. Written by POST /auth/b2b/register, required by verify-otp
  // before it will hand out a b2b account — see routes/auth.js.
  gstVerifications: () => db.collection('gst_verifications'),
  // One document per LIVE refresh token, keyed by its jti. Present = usable;
  // absent = already consumed or revoked. See middleware/auth.js.
  refreshTokens: () => db.collection('refresh_tokens'),
};

/* Short-lived documents (refresh tokens, OTP challenges, GSTIN verifications,
 * the admin recovery challenge) all carry an `expiresAt`.
 *
 * It has to be a Firestore TIMESTAMP, not epoch milliseconds. The code is
 * happy either way — it just compares numbers — but Firestore's TTL policies
 * only act on timestamp fields, so storing a number meant nothing was ever
 * deleted and these collections grew forever. Writing a real Timestamp is what
 * makes `gcloud firestore fields ttls update expiresAt ...` actually work.
 *
 * expiryMillis() reads either shape so documents written before this change
 * still expire correctly instead of being treated as already-expired (which
 * would have logged everyone out) or never-expiring.
 */
const expiryAt = (ms) => admin.firestore.Timestamp.fromMillis(Date.now() + ms);
const expiryMillis = (v) => (v && typeof v.toMillis === 'function') ? v.toMillis() : Number(v || 0);
const notExpired = (v) => Date.now() < expiryMillis(v);

async function writeAuditLog({ adminId, action, target, before, after }) {
  await col.auditLog().add({
    adminId, action, target,
    before: before ?? null, after: after ?? null,
    at: admin.firestore.FieldValue.serverTimestamp(),
  });
}

module.exports = {
  admin, db, col, writeAuditLog,
  expiryAt, expiryMillis, notExpired,
  FieldValue: admin.firestore.FieldValue, Timestamp: admin.firestore.Timestamp,
};
