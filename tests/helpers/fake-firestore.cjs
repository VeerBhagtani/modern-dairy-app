// A small in-memory Firestore: enough of the API for the retention jobs, the
// office sign-in checks and the GPS ingest path (collection/doc/get/set/
// update/create/delete, where with < <= > >= == !=, orderBy asc/desc, limit,
// startAfter, select, listDocuments, bulkWriter with create, batch,
// runTransaction, FieldValue.increment/serverTimestamp).
'use strict';

function makeDb() {
  const store = new Map();   // full path -> data
  const db = {};

  const resolve = (prev, data) => {
    const out = { ...(prev || {}) };
    for (const [k, v] of Object.entries(data)) {
      out[k] = v && typeof v === 'object' && '__inc' in v ? (Number(out[k]) || 0) + v.__inc
        : v && typeof v === 'object' && v.__ts ? Date.now() : v;
    }
    return out;
  };
  function docRef(path) {
    const id = path.split('/').pop();
    const ref = {
      id, path, firestore: db,
      async get() { const data = store.get(path); return snap(ref, data); },
      async set(data, opts) {
        store.set(path, resolve(opts && opts.merge ? store.get(path) : {}, data));
      },
      async update(data) {
        if (!store.has(path)) throw Object.assign(new Error('NOT_FOUND'), { code: 5 });
        store.set(path, resolve(store.get(path), data));
      },
      async create(data) {
        if (store.has(path)) throw Object.assign(new Error('ALREADY_EXISTS'), { code: 6 });
        store.set(path, resolve({}, data));
      },
      async delete() { store.delete(path); },
      collection(name) { return colRef(`${path}/${name}`); },
    };
    return ref;
  }

  function snap(ref, data) {
    return { id: ref.id, ref, exists: data !== undefined, data: () => (data === undefined ? undefined : { ...data }), get: (f) => (data ? data[f] : undefined) };
  }

  function colRef(path, spec = { filters: [], order: null, lim: Infinity, after: null }) {
    const children = () => [...store.keys()].filter((k) => k.startsWith(`${path}/`) && !k.slice(path.length + 1).includes('/'));
    const with_ = (patch) => colRef(path, { ...spec, ...patch });
    return {
      path, firestore: db,
      doc(id) { return docRef(`${path}/${id || Math.random().toString(36).slice(2)}`); },
      async add(data) { const r = docRef(`${path}/${Math.random().toString(36).slice(2)}`); await r.set(data); return r; },
      where(f, op, v) { return with_({ filters: [...spec.filters, [f, op, v]] }); },
      orderBy(f, dir) { return with_({ order: f, dir: dir || 'asc' }); },
      limit(n) { return with_({ lim: n }); },
      startAfter(d) { return with_({ after: d }); },
      select() { return this; },
      async listDocuments() { return children().map(docRef); },
      async get() {
        let docs = children().map((k) => snap(docRef(k), store.get(k)));
        for (const [f, op, v] of spec.filters) {
          docs = docs.filter((d) => {
            const x = d.data()[f];
            return op === '<' ? x < v : op === '<=' ? x <= v : op === '>' ? x > v : op === '==' ? x === v
              : op === '!=' ? x !== v : op === '>=' ? x >= v : op === 'in' ? v.includes(x) : true;
          });
        }
        if (spec.order) {
          const sign = spec.dir === 'desc' ? -1 : 1;
          docs.sort((a, b) => sign * ((a.data()[spec.order] > b.data()[spec.order]) ? 1 : (a.data()[spec.order] < b.data()[spec.order]) ? -1 : (a.id > b.id ? 1 : -1)));
        }
        if (spec.after) {
          const i = docs.findIndex((d) => d.ref.path === spec.after.ref.path);
          docs = docs.slice(i + 1);
        }
        docs = docs.slice(0, spec.lim);
        return { docs, size: docs.length, empty: docs.length === 0 };
      },
    };
  }

  db.collection = (name) => colRef(name);
  db.bulkWriter = () => {
    const ops = [];
    const queue = (fn) => { let done; const p = new Promise((res, rej) => { done = { res, rej }; }); ops.push(() => fn().then(done.res, done.rej)); return p; };
    return {
      set(ref, data, opts) { return queue(() => ref.set(data, opts)); },
      create(ref, data) { return queue(() => ref.create(data)); },
      update(ref, data) { return queue(() => ref.update(data)); },
      delete(ref) { return queue(() => ref.delete()); },
      onWriteError() {},
      async close() { for (const op of ops) await op(); },   // eslint-disable-line no-await-in-loop
    };
  };
  db.batch = () => {
    const ops = [];
    return {
      set(ref, data, opts) { ops.push(() => ref.set(data, opts)); return this; },
      update(ref, data) { ops.push(() => ref.update(data)); return this; },
      create(ref, data) { ops.push(() => ref.create(data)); return this; },
      delete(ref) { ops.push(() => ref.delete()); return this; },
      async commit() { for (const op of ops) await op(); },   // eslint-disable-line no-await-in-loop
    };
  };
  // Reads run at once; writes are applied together after the function
  // returns, as Firestore does. Serialised, so two transactions never
  // interleave (Firestore would retry one; here the second simply waits).
  let txChain = Promise.resolve();
  db.runTransaction = (fn) => {
    const run = txChain.then(async () => {
      const ops = [];
      const tx = {
        get: (x) => x.get(),
        set(ref, data, opts) { ops.push(() => ref.set(data, opts)); return tx; },
        update(ref, data) { ops.push(() => ref.update(data)); return tx; },
        create(ref, data) { ops.push(() => ref.create(data)); return tx; },
        delete(ref) { ops.push(() => ref.delete()); return tx; },
      };
      const out = await fn(tx);
      for (const op of ops) await op();   // eslint-disable-line no-await-in-loop
      return out;
    });
    txChain = run.catch(() => {});
    return run;
  };
  db._store = store;
  return db;
}

const FieldValue = {
  increment: (n) => ({ __inc: n }),
  serverTimestamp: () => ({ __ts: true }),
  arrayUnion: (...xs) => xs,
  delete: () => undefined,
};

module.exports = { makeDb, FieldValue };
