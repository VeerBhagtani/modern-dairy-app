// Stopping a ride: the usual reason on Tab, and who stopped it from a list.
//
// Driven end to end in Chromium during development (Tab fills the reason,
// "+ Add a name…" adds and selects the name, the stop carries both). These
// hold the pieces in place.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const VIEWS = read('dashboard/views.js');
const ADMIN = read('backend/src/routes/admin.js');
const REPO = read('backend/src/services/repo.js');

test('Tab in the empty reason box fills the usual reason', () => {
  assert.match(VIEWS, /var USUAL_STOP_REASON = 'End of shift — driver returned to Modern Dairy';/);
  assert.match(VIEWS, /if \(e\.key === 'Tab' && !e\.shiftKey && !reasonEl\.value\.trim\(\)\) reasonEl\.value = USUAL_STOP_REASON;/);
  // Phones have no Tab key: the same reason is one tap away.
  assert.match(VIEWS, /id="stopUsual"/);
});

test('who stopped the ride is chosen from a list, and required', () => {
  assert.match(VIEWS, /<select id="stopBy">/);
  assert.match(VIEWS, /\+ Add a name…/);
  assert.match(VIEWS, /if \(!by \|\| by === ADD\) \{ showErr\('Choose who is stopping this ride\.'\); return; \}/);
});

test('the server accepts only a name on the list, so a typo cannot become a person', () => {
  const stop = ADMIN.slice(ADMIN.indexOf("router.post('/rides/:rideId/stop'"), ADMIN.indexOf('// The names offered as "stopped by"'));
  assert.match(stop, /names\.find\(\(n\) => n\.toLowerCase\(\) === String\(stoppedByName\)\.trim\(\)\.toLowerCase\(\)\)/);
  assert.match(stop, /byName,/);
});

test('the name is kept on the ride and in the audit log', () => {
  assert.match(REPO, /stoppedByName: byName/);
  assert.match(REPO, /after: \{ reason, kind, byName \}/);
});

test('the same person added twice, in another case, is one name', () => {
  assert.match(REPO, /if \(list\.some\(\(n\) => n\.toLowerCase\(\) === clean\.toLowerCase\(\)\)\) return list;/);
});

test('managing the list needs a manager; reading it, any office login', () => {
  assert.match(ADMIN, /router\.get\('\/stop-names', requireRole\('viewer'\)/);
  assert.match(ADMIN, /router\.post\('\/stop-names', requireRole\('manager'\)/);
  assert.match(ADMIN, /router\.delete\('\/stop-names', requireRole\('manager'\)/);
});
