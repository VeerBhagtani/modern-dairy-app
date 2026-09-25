// A small in-memory Firestore: enough of the API for the retention jobs and
// the office sign-in checks (collection/doc/get/set/update/delete, where with
// < and ==, orderBy, limit, startAfter, select, listDocuments, bulkWriter).
'use strict';

function makeDb() {
  const store = new Map();   // full path -> data
  const db = {};

  function docRef(path) {
    const id = path.split('/').pop();
    const ref = {
      id, path, firestore: db,
      async get() { const data = store.get(path); return snap(ref, data); },
      async set(data, opts) {
        store.set(path, opts && opts.merge ? { ...(store.get(path) || {}), ...data } : { ...data });
      },
      async update(data) {
        if (!store.has(path)) throw Object.assign(new Error('NOT_FOUND'), { code: 5 });
        store.set(path, { ...store.get(path), ...data });
      },
      async create(data) {
        if (store.has(path)) throw Object.assign(new Error('ALREADY_EXISTS'), { code: 6 });
        store.set(path, { ...data });
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
      orderBy(f) { return with_({ order: f }); },
      limit(n) { return with_({ lim: n }); },
      startAfter(d) { return with_({ after: d }); },
      select() { return this; },
      async listDocuments() { return children().map(docRef); },
      async get() {
        let docs = children().map((k) => snap(docRef(k), store.get(k)));
        for (const [f, op, v] of spec.filters) {
          docs = docs.filter((d) => {
            const x = d.data()[f];
            return op === '<' ? x < v : op === '==' ? x === v : op === '>=' ? x >= v : true;
          });
        }
        if (spec.order) docs.sort((a, b) => (a.data()[spec.order] > b.data()[spec.order] ? 1 : -1));
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
    return {
      set(ref, data, opts) { ops.push(() => ref.set(data, opts)); },
      delete(ref) { ops.push(() => ref.delete()); },
      async close() { for (const op of ops) await op(); },   // eslint-disable-line no-await-in-loop
    };
  };
  db._store = store;
  return db;
}

module.exports = { makeDb };
