/* Reading a whole Firestore query page by page, with no cap.
 *
 * Kept apart from repo.js (which connects to Firestore when loaded) so the
 * paging itself — the part that used to truncate long rides — can be tested.
 *
 * @param makeQuery  (afterDoc|null) => query with .get() resolving to { docs, size }
 * @param pageSize   documents per page
 */
async function readAll(makeQuery, pageSize) {
  const out = [];
  let last = null;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const snap = await makeQuery(last).get();
    for (const d of snap.docs) out.push(d.data());
    if (snap.docs.length < pageSize) break;
    last = snap.docs[snap.docs.length - 1];
  }
  return out;
}

module.exports = { readAll };
