/* REAL Firestore rules tests, against the emulator.
 *
 * Everything else in this suite checks the rules FILE — that some string is
 * present. That is not the same as checking that Firestore enforces anything,
 * and the difference is not academic: the priceVerified bypass found in the
 * second review pass passed every structural assertion, because the rule text
 * looked right. What it missed was a query semantic (a filter does not match
 * documents where the field is absent), which only shows up when you run it.
 *
 * Run with:  npm run test:rules
 * (firebase emulators:exec boots a local Firestore on 8080 and tears it down.)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  initializeTestEnvironment, assertFails, assertSucceeds,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs, query, where } from 'firebase/firestore';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN_UID = '63cH4Dduh4WS7okdV0s0DcJtD7q2';   // the legacy literal in the rules

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log('  PASS  ' + name); } else { fail++; console.log('  FAIL  ' + name); } };
async function allowed(p, name) { try { await assertSucceeds(p); ok(true, name); } catch (e) { ok(false, name + '  [' + String(e.message).slice(0, 90) + ']'); } }
async function denied(p, name) { try { await assertFails(p); ok(true, name); } catch (e) { ok(false, name + '  [expected denial, was ALLOWED]'); } }

const testEnv = await initializeTestEnvironment({
  projectId: 'modern-dairy-rules-test',
  firestore: {
    rules: fs.readFileSync(path.join(ROOT, 'backend', 'firestore.rules'), 'utf8'),
    host: '127.0.0.1', port: 8080,
  },
});

const ALICE = 'alice-uid', BOB = 'bob-uid', BLOCKED = 'blocked-uid';
const alice = testEnv.authenticatedContext(ALICE).firestore();
const bob = testEnv.authenticatedContext(BOB).firestore();
const blocked = testEnv.authenticatedContext(BLOCKED).firestore();
const anon = testEnv.unauthenticatedContext().firestore();
const adminClaim = testEnv.authenticatedContext('some-other-uid', { admin: true }).firestore();
const adminUid = testEnv.authenticatedContext(ADMIN_UID).firestore();

// A well-formed order, exactly as www/index.html's buildOrderDoc emits it.
const order = (uid, over = {}) => ({
  orderNo: 'MD-TEST-1', items: [{ pk: 'paneer', vid: 'v1', qty: 2, price: 70 }],
  subtotal: 140, gst: 7, delivery: 0, platform: 2, total: 149,
  payment: 'cod', customerType: 'b2c', name: 'A', phone: '9811111111',
  address: 'somewhere', status: 'placed', createdByUid: uid,
  placedAt: new Date().toISOString(), priceVerified: false,
  ...over,
});

await testEnv.clearFirestore();
await testEnv.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  await setDoc(doc(db, 'order_blocks/list'), { blockedUids: [BLOCKED], blockedPhones: ['9700000001'], entries: [] });
  await setDoc(doc(db, 'orders/alice-order'), order(ALICE));
  await setDoc(doc(db, 'orders/alice-shipped'), order(ALICE, { status: 'out_for_delivery' }));
  await setDoc(doc(db, 'deliveries/CODE12345X'), { orderNo: 'MD-1', active: true, address: 'x', phone: '9811111111' });
  await setDoc(doc(db, 'deliveries/CODEFINISH'), { orderNo: 'MD-2', active: false, address: 'y' });
  await setDoc(doc(db, 'customers/cust1'), { phone: '9811111111', balance: 500 });
  await setDoc(doc(db, 'admin_audit_log/e1'), { action: 'x' });
  await setDoc(doc(db, 'order_blocks_public/hashes'), { hashes: ['deadbeef'] });
  await setDoc(doc(db, 'products/paneer'), { name: 'Paneer' });
});

console.log('\n── Orders: ownership ──');
await allowed(getDoc(doc(alice, 'orders/alice-order')), 'owner reads their own order');
await denied(getDoc(doc(bob, 'orders/alice-order')), "another customer CANNOT read someone else's order");
await denied(getDoc(doc(anon, 'orders/alice-order')), 'an unauthenticated caller cannot read an order');
await denied(getDocs(collection(bob, 'orders')), 'orders cannot be listed unconstrained');
await allowed(getDocs(query(collection(alice, 'orders'), where('createdByUid', '==', ALICE))), 'owner can list their own orders');

console.log('\n── Orders: create is pinned ──');
await allowed(setDoc(doc(alice, 'orders/new-ok'), order(ALICE)), 'a well-formed order is accepted');
await denied(setDoc(doc(alice, 'orders/forged-owner'), order(BOB)), 'cannot create an order owned by someone else');
await denied(setDoc(doc(alice, 'orders/forged-status'), order(ALICE, { status: 'delivered' })), 'cannot create an order already delivered');
// The second-pass bug, now a real test rather than a string match.
await denied(setDoc(doc(alice, 'orders/pv-true'), order(ALICE, { priceVerified: true })),
  'cannot pre-set priceVerified true (would skip the price check)');
const noPv = order(ALICE); delete noPv.priceVerified;
await denied(setDoc(doc(alice, 'orders/pv-missing'), noPv),
  'cannot OMIT priceVerified (would hide the order from the price-check query)');
await denied(setDoc(doc(alice, 'orders/extra-field'), order(ALICE, { isPaid: true })), 'cannot smuggle an unknown field');
await denied(setDoc(doc(alice, 'orders/bad-total'), order(ALICE, { total: 1 })), 'declared total must equal its parts');
await denied(setDoc(doc(alice, 'orders/free'), order(ALICE, { subtotal: 0, gst: 0, delivery: 0, platform: 0, total: 0 })), 'a zero-total order is refused');

console.log('\n── Orders: credit hold ──');
await denied(setDoc(doc(blocked, 'orders/blocked-try'), order(BLOCKED)), 'a blocked UID cannot place an order');
await allowed(setDoc(doc(alice, 'orders/not-blocked'), order(ALICE)), 'an unblocked UID still can');
// Honest about the known limitation, asserted so nobody mistakes it for closed.
await allowed(setDoc(doc(alice, 'orders/phone-swap'), order(ALICE, { phone: '9999999999' })),
  'KNOWN GAP: the phone half of the hold is client-supplied and evadable (uid half is what holds)');

console.log('\n── Orders: self-cancel ──');
await allowed(updateDoc(doc(alice, 'orders/alice-order'), { status: 'cancelled', cancelledAt: new Date().toISOString() }), 'owner cancels a placed order');
await denied(updateDoc(doc(alice, 'orders/alice-shipped'), { status: 'cancelled' }), 'cannot cancel once out for delivery');
await denied(updateDoc(doc(bob, 'orders/alice-order'), { status: 'cancelled' }), "cannot cancel someone else's order");
await denied(updateDoc(doc(alice, 'orders/not-blocked'), { status: 'delivered' }), 'owner cannot mark their order delivered');
await denied(updateDoc(doc(alice, 'orders/not-blocked'), { status: 'cancelled', total: 1 }), 'cancel cannot also change the total');
await denied(deleteDoc(doc(alice, 'orders/not-blocked')), 'owner cannot delete an order');

console.log('\n── Deliveries: bearer code, no enumeration ──');
await allowed(getDoc(doc(alice, 'deliveries/CODE12345X')), 'holding the code reads that delivery');
await denied(getDocs(collection(alice, 'deliveries')), 'deliveries cannot be listed (no enumeration)');
await denied(getDoc(doc(anon, 'deliveries/CODE12345X')), 'unauthenticated cannot read a delivery');
await allowed(updateDoc(doc(alice, 'deliveries/CODE12345X'), { riderLat: 18.5, riderLng: 73.8, riderAt: new Date().toISOString(), riderName: 'Rider' }), 'rider position can be posted while active');
await denied(updateDoc(doc(alice, 'deliveries/CODEFINISH'), { riderLat: 18.5, riderLng: 73.8, riderName: 'R' }), 'tracking stops once the trip is closed');
await denied(updateDoc(doc(alice, 'deliveries/CODE12345X'), { address: 'attacker rewrote this' }), 'the delivery address cannot be rewritten by a holder');
await denied(setDoc(doc(alice, 'deliveries/NEWCODE001'), { active: true }), 'a customer cannot create a delivery');

console.log('\n── customer_accounts: own record only ──');
await allowed(setDoc(doc(alice, `customer_accounts/${ALICE}_9811111111`), { phone: '9811111111', type: 'b2c', name: 'Alice' }), 'writes its own uid-prefixed record');
await denied(setDoc(doc(alice, `customer_accounts/${BOB}_9811111111`), { phone: '9811111111', type: 'b2c' }), "cannot write under another uid's prefix");
await denied(getDoc(doc(bob, `customer_accounts/${ALICE}_9811111111`)), "cannot read another customer's account record");
await denied(getDocs(collection(alice, 'customer_accounts')), 'customer_accounts cannot be listed');
await denied(updateDoc(doc(alice, `customer_accounts/${ALICE}_9811111111`), { admin: { note: 'self-granted' } }), 'cannot write the office-only admin map');

console.log('\n── Admin-only collections stay shut ──');
await denied(getDoc(doc(alice, 'customers/cust1')), 'a customer cannot read the customers collection');
await denied(getDoc(doc(alice, 'admin_audit_log/e1')), 'a customer cannot read the audit log');
await denied(getDoc(doc(alice, 'order_blocks/list')), 'a customer cannot read the block list');
await denied(getDoc(doc(anon, 'order_blocks_public/hashes')), 'the old public phone-hash list is no longer world-readable');
await denied(setDoc(doc(alice, 'products/paneer'), { name: 'Free Paneer' }), 'a customer cannot rewrite the catalogue');
await allowed(getDoc(doc(anon, 'products/paneer')), 'the catalogue stays publicly readable');

console.log('\n── Admin access ──');
await allowed(getDoc(doc(adminUid, 'customers/cust1')), 'the legacy admin uid still works (deploy does not lock anyone out)');
await allowed(getDoc(doc(adminClaim, 'customers/cust1')), 'a custom claim grants admin without a rules redeploy');
await allowed(getDocs(collection(adminClaim, 'deliveries')), 'admin can enumerate deliveries');
await allowed(updateDoc(doc(adminClaim, 'orders/alice-shipped'), { status: 'delivered' }), 'admin can move an order forward');
await denied(getDoc(doc(testEnv.authenticatedContext('nobody', { admin: false }).firestore(), 'customers/cust1')), 'admin:false is not admin');

await testEnv.cleanup();
console.log(`\nFIRESTORE RULES: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
