/* A stable id for a restaurant that arrived from a spreadsheet.
 *
 * The CSV has no ids in it — just a name and an area — and it will be uploaded
 * again every time a restaurant is added. So the import has to recognise a row
 * it has already seen, or a thousand restaurants become two thousand on the
 * second upload.
 *
 * The id is derived from the name and area, normalised, so that the same
 * restaurant produces the same id every time regardless of spacing, case,
 * punctuation or the stray "Hotel"/"Restaurant" capitalisation that
 * spreadsheets collect. It deliberately does NOT normalise away words: "Sai
 * Restaurant" and "Sai Palace" are different places and must stay different
 * rows.
 *
 * The consequence to keep in mind: renaming a restaurant in the CSV creates a
 * new row rather than updating the old one, because there is nothing else to
 * match on. That is the honest behaviour for a file with no ids — the office
 * sees both and deletes the stale one — and it is why external_id, when the
 * file has one, always wins.
 */
'use strict';
const crypto = require('crypto');

function normalise(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')   // strip accents
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')       // punctuation is noise in a name
    .trim()
    .replace(/\s+/g, ' ');
}

/* An explicit external id always wins: it is the only thing in the file that
 * survives a rename. */
function placeIdFor({ externalId, name, area }) {
  if (externalId && String(externalId).trim()) {
    return `ext_${String(externalId).trim().replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 90)}`;
  }
  const key = `${normalise(name)}|${normalise(area)}`;
  return `csv_${crypto.createHash('sha1').update(key).digest('hex').slice(0, 24)}`;
}

module.exports = { normalise, placeIdFor };
