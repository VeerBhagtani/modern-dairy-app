// Seeding the first office login.
//
// The rule worth protecting here is the last one: a redeploy must never put the
// seeded password back over one the office has chosen. Everything else is about
// refusing to store something that is not a password hash.
//
// Firestore is stubbed rather than mocked at the library level — the seed only
// needs collection().doc().get()/create(), and a Map models that exactly.
import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HASH = '$2a$12$G8CiQjZrP0X8SF.fD2.9zOBxlY8FJ3B2lBLGkhH6y7oOs7lrKXL9e';

function load() {
  const store = new Map();
  const fake = {
    db: {
      collection: () => ({
        doc: (id) => ({
          get: async () => ({ exists: store.has(id), data: () => store.get(id) }),
          create: async (d) => {
            if (store.has(id)) { const e = new Error('exists'); e.code = 6; throw e; }
            store.set(id, d);
          },
        }),
      }),
    },
  };
  const orig = Module._load;
  Module._load = function (req, ...rest) {
    if (req === './firestore') return fake;
    return orig.call(this, req, ...rest);
  };
  const require_ = Module.createRequire(path.join(ROOT, 'tests', 'x.cjs'));
  delete require_.cache?.[path.join(ROOT, 'backend/src/services/seedAdmin.js')];
  const mod = require_(path.join(ROOT, 'backend/src/services/seedAdmin.js'));
  Module._load = orig;
  return { seed: mod.seedAdminIfMissing, store };
}

test('nothing is stored as a password unless it is a bcrypt hash', async () => {
  const { seed, store } = load();
  for (const bad of ['Mdairypune@1942', '', 'not-a-hash', '$2a$12$tooshort']) {
    const r = await seed({ username: 'someone', passwordHash: bad });
    assert.equal(r.seeded, false, `"${bad}" must not be stored`);
  }
  assert.equal(store.size, 0);
});

test('an invalid username is refused rather than turned into a path', async () => {
  const { seed, store } = load();
  for (const bad of ['a/b', '.', '..', 'x'.repeat(200)]) {
    assert.equal((await seed({ username: bad, passwordHash: HASH })).seeded, false);
  }
  assert.equal(store.size, 0);
});

test('with nothing configured it does nothing at all', async () => {
  const { seed, store } = load();
  assert.equal((await seed({ username: null, passwordHash: null })).seeded, false);
  assert.equal(store.size, 0);
});

test('it seeds an admin that must change its password', async () => {
  const { seed, store } = load();
  assert.equal((await seed({ username: 'Modern-dairy', passwordHash: HASH, name: 'Modern Dairy' })).seeded, true);
  const row = store.get('Modern-dairy');
  assert.equal(row.role, 'admin');
  assert.equal(row.status, 'active');
  assert.equal(row.mustChangePassword, true, 'a password that shipped with the software must be replaced');
  assert.equal(row.passwordHash, HASH);
});

test('a password the office has chosen survives every later deploy', async () => {
  const { seed, store } = load();
  await seed({ username: 'Modern-dairy', passwordHash: HASH });

  // The office signs in and sets its own password.
  store.get('Modern-dairy').passwordHash = '$2a$12$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  store.get('Modern-dairy').mustChangePassword = false;

  // Every redeploy runs the seed again.
  for (let i = 0; i < 3; i += 1) {
    const r = await seed({ username: 'Modern-dairy', passwordHash: HASH });
    assert.equal(r.seeded, false);
    assert.equal(r.reason, 'already exists');
  }
  assert.notEqual(store.get('Modern-dairy').passwordHash, HASH, 'the seeded password must not come back');
  assert.equal(store.get('Modern-dairy').mustChangePassword, false);
});
