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

/* THE REAL buildOrderDoc, lifted out of www/index.html rather than copied.
 *
 * The fixture above is a hand-written copy, and a copy only tests the rules
 * against what someone once believed the app sends. Add a field to
 * buildOrderDoc and the copy keeps passing while every real order starts
 * getting refused by hasOnly — which is exactly the failure that sent a
 * customer the message "your account is on hold". So the shapes below are
 * built by the app's own function: change it, and these tests change with it. */
const buildOrderDoc = (() => {
  const src = fs.readFileSync(path.join(ROOT, 'www', 'index.html'), 'utf8');
  const fn = src.match(/function buildOrderDoc\(order, uid\) \{[\s\S]*?\n\}/);
  if (!fn) throw new Error('buildOrderDoc could not be found in www/index.html');
  // eslint-disable-next-line no-new-func
  return new Function(`${fn[0]}; return buildOrderDoc;`)();
})();

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

/* Every order the app can actually produce must be acceptable.
 *
 * The rules lock the field set with hasOnly, so they and buildOrderDoc are one
 * contract in two files. When they drift, Firestore answers PERMISSION_DENIED
 * — the same answer it gives a customer on credit hold — and every order from
 * every customer is refused for a reason nobody can see. These three are the
 * shapes real customers generate; if any is refused, ordering is broken for
 * that whole class of customer. */
console.log('\n── Every real order shape is accepted ──');
const REAL = 'real-shape-uid';
const realDb = testEnv.authenticatedContext(REAL).firestore();
const shapes = [
  ['personal customer, saved profile, cash on delivery', {
    orderNo: 'MD-R1', customerType: 'b2c', payment: 'cod',
    items: [{ pk: 'milk', vid: 'v1', qty: 2, price: 32, name: 'Toned Milk', label: '500 ml', unit: 'pouch' }],
    subtotal: 64, gst: 0, delivery: 0, platform: 0, total: 64,
    name: 'Test Customer', phone: '9000000000', address: 'Camp, Pune' }],
  ['business customer on credit, several lines, platform fee', {
    orderNo: 'MD-R2', customerType: 'b2b', payment: 'credit',
    items: [{ pk: 'paneer', vid: 'v9', qty: 5, price: 310 }, { pk: 'curd', vid: 'v3', qty: 10, price: 48 }],
    subtotal: 2030, gst: 101.5, delivery: 0, platform: 2, total: 2133.5,
    company: 'Hotel Example', gstin: '27AAPFM1234A1ZV', name: 'Owner',
    phone: '9876500001', address: 'FC Road, Pune' }],
  // The brand-new install with nothing saved yet — every optional field null.
  // These are the ones that broke when the rules read properties directly
  // instead of via .get(field, null), because reading an absent property
  // raises an error and an error denies the write.
  ['brand-new customer, every optional field empty', {
    orderNo: 'MD-R3', customerType: 'b2c', payment: 'cod',
    items: [{ pk: 'milk', vid: 'v1', qty: 1, price: 32 }],
    subtotal: 32, gst: 0, delivery: 0, total: 32 }],
];
for (const [name, o] of shapes) {
  const d = { ...buildOrderDoc(o, REAL), placedAt: new Date().toISOString() };
  await allowed(setDoc(doc(realDb, 'orders', o.orderNo), d), name);
}
// The same generated shape must still fail the two forgeries it is meant to.
{
  const base = buildOrderDoc(shapes[0][1], REAL);
  await denied(setDoc(doc(realDb, 'orders/MD-R-FORGE1'),
    { ...base, orderNo: 'MD-R-FORGE1', placedAt: new Date().toISOString(), priceVerified: true }),
    'and a forged priceVerified:true on that same shape is still refused');
  await denied(setDoc(doc(realDb, 'orders/MD-R-FORGE2'),
    { ...base, orderNo: 'MD-R-FORGE2', placedAt: new Date().toISOString(), total: 1 }),
    'and a ₹1 total on real line items is still refused');
}

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
