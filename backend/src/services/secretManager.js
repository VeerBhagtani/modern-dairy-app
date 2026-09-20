const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');

const client = new SecretManagerServiceClient();
const PROJECT_ID = process.env.GCP_PROJECT_ID;

// Known integration keys the admin panel can configure. The value here is the
// Secret Manager secret ID — must be [a-zA-Z0-9-_]+.
const KNOWN_SECRETS = {
  // Signs every driver and office token. The one secret this service cannot
  // run without.
  'jwt-signing-key': 'jwt-signing-key',
  // Optional: the GoFrugal order import. Absent means the adapter stays inert,
  // which is its honest state until the licence has API access.
  gofrugal: 'gofrugal-api-key',
  gofrugal_outlet_id: 'gofrugal-outlet-id',
  gofrugal_company_id: 'gofrugal-company-id',
};

const cache = new Map(); // secretId -> { value, fetchedAt }
const CACHE_TTL_MS = 5 * 60 * 1000;

async function getSecret(alias) {
  const secretId = KNOWN_SECRETS[alias] || alias;
  const cached = cache.get(secretId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.value;

  const name = `projects/${PROJECT_ID}/secrets/${secretId}/versions/latest`;
  try {
    const [version] = await client.accessSecretVersion({ name });
    const value = version.payload.data.toString('utf8');
    cache.set(secretId, { value, fetchedAt: Date.now() });
    return value;
  } catch (err) {
    if (err.code === 5 /* NOT_FOUND */) return null; // not configured yet — caller must handle
    throw err;
  }
}

async function setSecret(alias, value) {
  const secretId = KNOWN_SECRETS[alias] || alias;
  const parent = `projects/${PROJECT_ID}`;
  const secretName = `${parent}/secrets/${secretId}`;

  try {
    await client.getSecret({ name: secretName });
  } catch (err) {
    if (err.code !== 5) throw err;
    await client.createSecret({
      parent,
      secretId,
      secret: { replication: { automatic: {} } },
    });
  }

  await client.addSecretVersion({
    parent: secretName,
    payload: { data: Buffer.from(value, 'utf8') },
  });
  cache.delete(secretId);
}

async function secretStatus() {
  const aliases = Object.keys(KNOWN_SECRETS).filter((a) => a !== 'jwt-signing-key');
  const out = {};
  for (const alias of aliases) {
    const val = await getSecret(alias);
    out[alias] = val ? 'configured' : 'missing';
  }
  return out;
}

module.exports = { getSecret, setSecret, secretStatus, KNOWN_SECRETS };
