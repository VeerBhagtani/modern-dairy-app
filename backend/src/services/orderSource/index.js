// Order-source integration layer.
//
// The tracking system must never depend on WHICH order system Modern Dairy
// runs. Everything downstream consumes the normalised order shape below; an
// adapter's only job is to produce it. Adding GoFrugal, or replacing it later,
// is a new file in this directory and a config change — not a rebuild.
//
// NORMALISED ORDER
// {
//   id, source, externalId,
//   customerId,            // must match restaurants[].customerId to be matchable
//   placeId,               // optional: our restaurant id, when the source knows it
//   lat, lng,              // optional: expected delivery coordinates
//   assignedDriverId,      // optional: our driver id
//   orderedAt, windowStart, windowEnd, deliveredAt,   // epoch ms or null
//   status,                // source's own status string
//   raw                    // the untouched source payload, for audit
// }
//
// Two rules no adapter may break:
//   1. Never invent an order. If the source has no record, there is no record.
//   2. Never guess a customerId. An order whose customer cannot be resolved is
//      imported UNRESOLVED and reported, not quietly attached to a nearby one.

// Firestore is required lazily, inside the functions that persist. Keeping it
// out of the module's top level means the adapter registry, the normalised
// order contract and validateOrder() can be loaded and tested without a
// database or a service account — which is also what stops this layer from
// quietly growing a dependency on one.
function repo() { return require('../driversRepo'); }

const adapters = new Map();

function register(name, adapter) { adapters.set(name, adapter); }
function get(name) { return adapters.get(name) || null; }
function list() { return [...adapters.keys()]; }

// Every adapter is checked against this before anything is written. A source
// that cannot supply a customer id or a time is not usable for matching, and
// saying so at import time is far better than a silent zero-match report.
function validateOrder(o) {
  const problems = [];
  if (!o || typeof o !== 'object') return ['order is not an object'];
  if (!o.externalId || typeof o.externalId !== 'string') problems.push('externalId missing');
  if (!o.customerId || typeof o.customerId !== 'string') problems.push('customerId missing — order cannot be matched to a location');
  if (!Number.isFinite(o.orderedAt) && !Number.isFinite(o.windowStart)) problems.push('no orderedAt or windowStart — order cannot be matched in time');
  if (o.lat != null && (!Number.isFinite(o.lat) || Math.abs(o.lat) > 90)) problems.push('lat invalid');
  if (o.lng != null && (!Number.isFinite(o.lng) || Math.abs(o.lng) > 180)) problems.push('lng invalid');
  return problems;
}

async function logIntegration({ source, op, ok, count, error, detail }) {
  await repo().C.integrationLogs().add({
    source, op, ok, count: count ?? null,
    error: error ? String(error).slice(0, 1000) : null,
    detail: detail ?? null,
    at: Date.now(),
  });
}

/**
 * Pull orders from a source and upsert them. Idempotent: the document id is
 * `${source}_${externalId}`, so re-running a sync updates rather than
 * duplicating, and a partially failed sync can simply be run again.
 */
async function syncOrders(sourceName, params, adminId) {
  const adapter = get(sourceName);
  if (!adapter) {
    await logIntegration({ source: sourceName, op: 'sync', ok: false, error: 'unknown source' });
    throw Object.assign(new Error(`Unknown order source "${sourceName}"`), { code: 'UNKNOWN_SOURCE' });
  }
  if (!(await adapter.isConfigured())) {
    await logIntegration({ source: sourceName, op: 'sync', ok: false, error: 'not configured' });
    throw Object.assign(new Error(`${sourceName} is not configured — add its credentials before syncing.`), { code: 'NOT_CONFIGURED' });
  }

  let fetched;
  try {
    fetched = await adapter.fetchOrders(params);
  } catch (err) {
    await logIntegration({ source: sourceName, op: 'fetch', ok: false, error: err.message });
    throw err;
  }

  const accepted = [];
  const rejected = [];
  for (const o of fetched) {
    const problems = validateOrder(o);
    if (problems.length) { rejected.push({ externalId: o?.externalId || null, problems }); continue; }
    accepted.push(o);
  }

  const { db } = require('../firestore');
  const writer = db.bulkWriter();
  for (const o of accepted) {
    writer.set(repo().C.orders().doc(`${sourceName}_${o.externalId}`), {
      ...o,
      source: sourceName,
      importedAt: Date.now(),
    }, { merge: true });
  }
  await writer.close();

  await logIntegration({
    source: sourceName, op: 'sync', ok: true, count: accepted.length,
    detail: { rejected: rejected.length, params: params || null },
  });
  if (adminId) await repo().writeAudit({ adminId, action: 'orders.sync', target: sourceName, after: { imported: accepted.length, rejected: rejected.length } });

  // Rejected rows are returned, not swallowed: an import that silently drops a
  // third of the orders looks identical to one that worked.
  return { imported: accepted.length, rejected };
}

// Wire up the shipped adapters.
register('manual', require('./manual'));
register('gofrugal', require('./gofrugal'));

module.exports = { register, get, list, syncOrders, validateOrder, logIntegration };
