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

async function writeAuditLog({ adminId, action, target, before, after }) {
  await col.auditLog().add({
    adminId, action, target,
    before: before ?? null, after: after ?? null,
    at: admin.firestore.FieldValue.serverTimestamp(),
  });
}

module.exports = { admin, db, col, writeAuditLog, FieldValue: admin.firestore.FieldValue, Timestamp: admin.firestore.Timestamp };
