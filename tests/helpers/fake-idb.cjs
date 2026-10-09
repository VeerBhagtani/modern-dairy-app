// Just enough IndexedDB for the driver app's queue: one database, object
// stores keyed by keyPath, put/delete/count/openCursor in key order, and
// transactions that complete asynchronously like the real thing.
'use strict';

function makeIndexedDB() {
  const stores = new Map();   // name -> Map(key -> value)
  const later = (fn) => setImmediate(fn);
  const database = {
    objectStoreNames: { contains: (n) => stores.has(n) },
    createObjectStore(name, { keyPath }) { stores.set(name, new Map()); stores.get(name).keyPath = keyPath; },
    transaction(name) {
      const map = stores.get(name);
      const tx = { oncomplete: null, onerror: null };
      let pending = 0;
      const done = () => { if (--pending === 0) later(() => tx.oncomplete && tx.oncomplete()); };
      const req = (fn) => { pending += 1; const r = { result: undefined, onsuccess: null, onerror: null }; later(() => { r.result = fn(); if (r.onsuccess) r.onsuccess(); done(); }); return r; };
      tx.objectStore = () => ({
        put: (v) => req(() => { map.set(v[map.keyPath], JSON.parse(JSON.stringify(v))); }),
        delete: (k) => req(() => { map.delete(k); }),
        count: () => req(() => map.size),
        openCursor() {
          const keys = [...map.keys()].sort();
          let i = 0;
          const r = { result: null, onsuccess: null, onerror: null };
          pending += 1;
          const step = () => later(() => {
            if (i < keys.length) {
              const k = keys[i];
              r.result = { value: map.get(k), continue() { i += 1; step(); } };
            } else { r.result = null; done(); }
            if (r.onsuccess) r.onsuccess();
          });
          step();
          return r;
        },
      });
      if (pending === 0) later(() => { if (pending === 0 && tx.oncomplete) tx.oncomplete(); });
      return tx;
    },
  };
  return {
    stores,
    open() {
      const r = { result: database, onsuccess: null, onerror: null, onupgradeneeded: null };
      later(() => { if (r.onupgradeneeded) r.onupgradeneeded(); if (r.onsuccess) r.onsuccess(); });
      return r;
    },
  };
}

module.exports = { makeIndexedDB };
