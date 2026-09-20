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
  auditLog: () => db.collection('admin_audit_log'),
  appConfig: () => db.collection('app_config').doc('singleton'),
  otpChallenges: () => db.collection('otp_challenges'),
};

async function writeAuditLog({ adminId, action, target, before, after }) {
  await col.auditLog().add({
    adminId, action, target,
    before: before ?? null, after: after ?? null,
    at: admin.firestore.FieldValue.serverTimestamp(),
  });
}

module.exports = { admin, db, col, writeAuditLog, FieldValue: admin.firestore.FieldValue, Timestamp: admin.firestore.Timestamp };
