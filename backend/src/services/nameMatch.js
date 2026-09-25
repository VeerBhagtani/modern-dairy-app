/* Is Google's business the same as the office's customer, by name?
 *
 * The office's list and Google Maps name the same shop differently:
 *
 *   "Hotel ABC"          ↔ "ABC Family Restaurant & Bar"
 *   "Shree Ganesh Hotel" ↔ "Ganesh Pure Veg Restaurant"
 *   "Vaishali"           ↔ "Vaishaali Restaurant"
 *
 * So the words that only say what kind of place it is (hotel, restaurant,
 * family, pure veg, bar…) and honorifics (shree, shri, sri) are set aside, and
 * what is left is compared allowing for spelling variants.
 *
 * A match on a name alone is not proof. "Ganesh", "Sai", "Shiv" name hundreds
 * of Pune businesses, so a match resting only on such words is reported as
 * COMMON and needs location evidence before it counts. That is the rule the
 * office asked for: never match just because the names look vaguely alike.
 */
'use strict';

const LEVEL = { STRONG: 'strong', PARTIAL: 'partial', COMMON: 'common', NONE: 'none' };

// What kind of place it is, not which one.
const KIND_WORDS = new Set([
  'hotel', 'hotels', 'restaurant', 'restaurants', 'restro', 'resto', 'restobar', 'cafe', 'caffe', 'bar', 'bars', 'pub',
  'family', 'pure', 'veg', 'nonveg', 'non', 'vegetarian', 'dhaba', 'bhojanalaya', 'bhojnalaya', 'bhojanalay', 'mess',
  'lounge', 'bistro', 'kitchen', 'foods', 'food', 'eatery', 'eateries', 'canteen', 'caterers', 'catering', 'bakery',
  'bakers', 'snacks', 'snack', 'centre', 'center', 'and', 'the', 'n', 'of', 'a',
  'pvt', 'private', 'ltd', 'limited', 'llp', 'co', 'company', 'enterprises', 'enterprise', 'dining', 'fine', 'multicuisine',
  'multi', 'cuisine', 'permit', 'room', 'wine', 'shop', 'stall', 'new', 'pune', 'branch',
]);
// Honorifics, spelled several ways.
const HONORIFICS = new Set(['shree', 'shri', 'sri', 'shriee', 'shre', 'sree', 'om', 'jai', 'jay']);
// Words so common in Pune business names that sharing one proves nothing.
const COMMON = new Set([
  'sai', 'ganesh', 'ganesha', 'ganpati', 'shiv', 'shiva', 'shivam', 'krishna', 'laxmi', 'lakshmi', 'balaji', 'datta',
  'hanuman', 'maruti', 'durga', 'ambika', 'mahalaxmi', 'swami', 'samarth', 'royal', 'maharaja', 'king', 'kings', 'star',
  'city', 'delight', 'paradise', 'palace', 'classic', 'grand', 'annapurna', 'amrut', 'amrit', 'swad', 'tasty', 'spicy',
  'hind', 'bharat', 'india', 'indian', 'punjabi', 'south', 'udupi', 'chinese', 'fast', 'kolhapuri', 'malvani', 'misal',
  'vada', 'pav', 'chai', 'tea', 'coffee', 'biryani', 'pizza', 'burger', 'juice', 'sweets', 'sweet', 'mart', 'best',
]);

function normalise(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[''`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Spelling variants that are the same word: doubled letters and the vowel
// spellings transliteration produces (vaishaali/vaishali, shiv/shiva is left
// to the edit distance).
function skeleton(w) {
  return w.replace(/aa/g, 'a').replace(/ee/g, 'i').replace(/oo/g, 'u').replace(/(.)\1+/g, '$1').replace(/[aeiou]$/, '');
}

function editDistance(a, b) {
  if (a === b) return 0;
  const m = a.length; const n = b.length;
  if (Math.abs(m - n) > 2) return 3;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i += 1) {
    const cur = [i];
    for (let j = 1; j <= n; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

function sameWord(a, b) {
  if (a === b) return true;
  if (skeleton(a) === skeleton(b)) return true;
  const len = Math.min(a.length, b.length);
  if (len >= 8) return editDistance(a, b) <= 2;
  if (len >= 5) return editDistance(a, b) <= 1;
  return false;
}

/* The identifying words of a name. Numbers are kept ("Hotel 7 Loves"). */
function identifying(name) {
  const words = normalise(name).split(' ').filter(Boolean);
  const out = words.filter((w) => !KIND_WORDS.has(w) && !HONORIFICS.has(w));
  return out.length ? out : words.filter((w) => !HONORIFICS.has(w));
}

/**
 * @returns {{ level, score, shared: string[] }}
 *   STRONG   every identifying word of ours is in theirs, and theirs adds at
 *            most as many identifying words again ("ABC" ↔ "ABC Family …")
 *   PARTIAL  at least half of our identifying words are in theirs
 *   COMMON   STRONG or PARTIAL, but every shared word is a common one
 *   NONE     nothing identifying in common
 */
function compare(ours, theirs) {
  const A = identifying(ours);
  const B = identifying(theirs);
  if (!A.length || !B.length) return { level: LEVEL.NONE, score: 0, shared: [] };
  const shared = A.filter((a) => B.some((b) => sameWord(a, b)));
  if (!shared.length) {
    // "Sainath" and "Sai Nath": the words run together on one side.
    const ja = A.join(''); const jb = B.join('');
    if (ja.length >= 6 && (ja === jb || skeleton(ja) === skeleton(jb))) return { level: LEVEL.STRONG, score: 1, shared: [ja] };
    return { level: LEVEL.NONE, score: 0, shared: [] };
  }
  const ourCover = shared.length / A.length;
  const theirCover = B.filter((b) => A.some((a) => sameWord(a, b))).length / B.length;
  const score = Math.round(((ourCover * 2 + theirCover) / 3) * 100) / 100;
  let level = ourCover === 1 && theirCover >= 0.5 ? LEVEL.STRONG : ourCover >= 0.5 ? LEVEL.PARTIAL : LEVEL.NONE;
  if (level !== LEVEL.NONE && shared.every((w) => COMMON.has(w) || w.length <= 2)) level = LEVEL.COMMON;
  return { level, score, shared };
}

/* A shorter search for Google: the identifying words only. */
function shortName(name) { return identifying(name).join(' '); }

module.exports = { LEVEL, compare, identifying, shortName, normalise, sameWord };
