// Report building and export formatting. Pure: takes processing results in,
// returns rows out. The route layer fetches and the HTTP layer serialises.
//
// Every report that carries a distance also carries how that distance was
// arrived at, because a spreadsheet column labelled "km" with no provenance is
// how a tracking system starts lying to the people who depend on it.

const { SEGMENT_TYPE } = require('./classification');

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

// RFC 4180 quoting, plus one hardening step: a cell starting with = + - @ or a
// control character is prefixed with a single quote so Excel and LibreOffice
// treat it as text. Without it, a restaurant named "=cmd|..." becomes a formula
// injection the moment somebody opens the export.
function csvCell(value) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(columns, rows) {
  const head = columns.map((c) => csvCell(c.label)).join(',');
  const body = rows.map((r) => columns.map((c) => csvCell(typeof c.value === 'function' ? c.value(r) : r[c.key])).join(','));
  // BOM so Excel on Windows reads UTF-8 restaurant names correctly.
  return `﻿${[head, ...body].join('\r\n')}\r\n`;
}

// Excel-compatible export without a dependency: SpreadsheetML 2003, which
// Excel and LibreOffice both open natively as a real worksheet (not a CSV
// rename). Keeps the repo free of a binary xlsx writer for a handful of tables.
function toExcelXml(sheetName, columns, rows) {
  const esc = (v) => String(v ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const cell = (v) => {
    const isNum = typeof v === 'number' && Number.isFinite(v);
    return `<Cell><Data ss:Type="${isNum ? 'Number' : 'String'}">${esc(v)}</Data></Cell>`;
  };
  const header = `<Row>${columns.map((c) => `<Cell><Data ss:Type="String">${esc(c.label)}</Data></Cell>`).join('')}</Row>`;
  const body = rows.map((r) => `<Row>${columns.map((c) => cell(typeof c.value === 'function' ? c.value(r) : r[c.key])).join('')}</Row>`).join('');
  return `<?xml version="1.0"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Worksheet ss:Name="${esc(sheetName).slice(0, 31)}"><Table>${header}${body}</Table></Worksheet></Workbook>`;
}

const iso = (ms) => (ms == null ? '' : new Date(ms).toISOString());
// Reports are read by people in Pune; UTC timestamps in a payroll argument are
// an own goal. Stored values stay epoch-ms/UTC — this is a display concern only.
const IST = (ms) => (ms == null ? '' : new Date(ms + 5.5 * 3600000).toISOString().replace('T', ' ').slice(0, 19) + ' IST');

// ---------------------------------------------------------------------------
// Report definitions
// ---------------------------------------------------------------------------

const REPORTS = {
  // 1–3. Distance per driver per period.
  driver_distance: {
    title: 'Driver distance',
    columns: [
      { key: 'date', label: 'Date' },
      { key: 'driverName', label: 'Driver' },
      { key: 'driverCode', label: 'Driver ID' },
      { key: 'verifiedBusinessKm', label: 'Verified business km' },
      { key: 'likelyBusinessKm', label: 'Likely business km' },
      { key: 'personalKm', label: 'Personal / non-business km' },
      { key: 'unknownKm', label: 'Unknown km' },
      { key: 'gapKm', label: 'GPS gap (estimated) km' },
      { key: 'totalKm', label: 'Total tracked km' },
      { key: 'visits', label: 'Restaurant visits' },
      { key: 'matched', label: 'Matched deliveries' },
      { key: 'pendingReview', label: 'Segments needing review' },
      { key: 'quality', label: 'GPS quality' },
      { key: 'calcVersion', label: 'Calc version' },
    ],
  },
  // 4. Business kilometres only — the payroll-facing view.
  business_km: {
    title: 'Modern Dairy business kilometres',
    columns: [
      { key: 'date', label: 'Date' },
      { key: 'driverName', label: 'Driver' },
      { key: 'driverCode', label: 'Driver ID' },
      { key: 'verifiedBusinessKm', label: 'Verified business km' },
      { key: 'likelyBusinessKm', label: 'Likely (unverified) km' },
      { key: 'unknownKm', label: 'Unknown km (excluded)' },
      { key: 'basis', label: 'Basis' },
    ],
  },
  // 7. Restaurant visits.
  restaurant_visits: {
    title: 'Restaurant visits',
    columns: [
      { key: 'date', label: 'Date' },
      { key: 'driverName', label: 'Driver' },
      { key: 'placeName', label: 'Restaurant' },
      { key: 'customerId', label: 'Customer ID' },
      { key: 'arrivedAtIst', label: 'Arrived' },
      { key: 'dwellMin', label: 'Dwell (min)' },
      { key: 'approachKm', label: 'Distance to reach (km)' },
      { key: 'confidence', label: 'Visit confidence' },
      { key: 'matchOutcome', label: 'Delivery match' },
    ],
  },
  // 8. Delivery matching.
  delivery_matching: {
    title: 'Delivery matching',
    columns: [
      { key: 'date', label: 'Date' },
      { key: 'driverName', label: 'Driver' },
      { key: 'outcome', label: 'Outcome' },
      { key: 'orderId', label: 'Order' },
      { key: 'customerId', label: 'Customer' },
      { key: 'placeName', label: 'Location' },
      { key: 'visitAtIst', label: 'Visit time' },
      { key: 'confidence', label: 'Confidence' },
      { key: 'reason', label: 'Reason / evidence' },
    ],
  },
  // 9. GPS reliability.
  gps_reliability: {
    title: 'GPS tracking reliability',
    columns: [
      { key: 'date', label: 'Date' },
      { key: 'driverName', label: 'Driver' },
      { key: 'points', label: 'Fixes received' },
      { key: 'usable', label: 'Fixes usable' },
      { key: 'coverage', label: 'Coverage vs expected' },
      { key: 'gapCount', label: 'Tracking gaps' },
      { key: 'gapMinutes', label: 'Gap minutes' },
      { key: 'jumps', label: 'Implausible jumps' },
      { key: 'lowAccuracy', label: 'Low-accuracy fixes' },
      { key: 'quality', label: 'Grade' },
      { key: 'reasons', label: 'Notes' },
    ],
  },
  // 11. Route anomalies.
  route_anomaly: {
    title: 'Route anomalies',
    columns: [
      { key: 'date', label: 'Date' },
      { key: 'driverName', label: 'Driver' },
      { key: 'kind', label: 'Anomaly' },
      { key: 'atIst', label: 'When' },
      { key: 'detail', label: 'Detail' },
    ],
  },
  // 12. Manual classification audit.
  classification_audit: {
    title: 'Manual classification audit',
    columns: [
      { key: 'atIst', label: 'When' },
      { key: 'reviewerId', label: 'Reviewer' },
      { key: 'driverName', label: 'Driver' },
      { key: 'date', label: 'Ride date' },
      { key: 'segmentId', label: 'Segment' },
      { key: 'fromType', label: 'From' },
      { key: 'toType', label: 'To' },
      { key: 'distanceKm', label: 'Distance moved (km)' },
      { key: 'note', label: 'Note' },
      { key: 'reverted', label: 'Reverted' },
    ],
  },
};

// ---------------------------------------------------------------------------
// Row builders
// ---------------------------------------------------------------------------

const km = (m) => Math.round((m / 1000) * 10) / 10;

function driverDistanceRows(rows) {
  // rows: [{ ride, result, driver }]
  return rows.map(({ ride, result, driver }) => ({
    date: ride.dayKey,
    driverName: driver?.name || ride.driverId,
    driverCode: driver?.driverCode || '',
    verifiedBusinessKm: result.distance.km.verifiedBusiness,
    likelyBusinessKm: result.distance.km.likelyBusiness,
    personalKm: result.distance.km.personal,
    unknownKm: result.distance.km.unknown,
    gapKm: result.distance.km.gapEstimate,
    totalKm: result.distance.km.dayTotal,
    visits: result.counts.restaurantVisits,
    matched: result.matching.summary.matched,
    pendingReview: result.review.pending,
    quality: result.track.quality.grade,
    calcVersion: result.calcVersion,
  }));
}

function businessKmRows(rows) {
  return rows.map(({ ride, result, driver }) => ({
    date: ride.dayKey,
    driverName: driver?.name || ride.driverId,
    driverCode: driver?.driverCode || '',
    verifiedBusinessKm: result.distance.km.verifiedBusiness,
    likelyBusinessKm: result.distance.km.likelyBusiness,
    unknownKm: result.distance.km.unknown,
    basis: 'Verified = HIGH-confidence segments only (facility anchor or a matching delivery order). Likely = MEDIUM. Unknown is excluded from both.',
  }));
}

function restaurantVisitRows(rows) {
  const out = [];
  for (const { ride, result, driver } of rows) {
    const matchBySegment = new Map(result.matching.matches.map((m) => [m.segmentId, m]));
    for (const v of result.visits) {
      out.push({
        date: ride.dayKey,
        driverName: driver?.name || ride.driverId,
        placeName: v.placeName,
        customerId: v.customerId,
        arrivedAtIst: IST(v.arrivedAt),
        dwellMin: v.dwellSec == null ? '' : Math.round(v.dwellSec / 60),
        approachKm: km(v.approachDistanceM),
        confidence: v.confidence,
        matchOutcome: matchBySegment.get(v.segmentId)?.outcome || 'UNMATCHED_VISIT',
      });
    }
  }
  return out;
}

function deliveryMatchingRows(rows) {
  const out = [];
  for (const { ride, result, driver } of rows) {
    const name = driver?.name || ride.driverId;
    for (const m of result.matching.matches) {
      out.push({
        date: ride.dayKey, driverName: name, outcome: m.outcome, orderId: m.orderId,
        customerId: m.customerId, placeName: m.placeId || '', visitAtIst: IST(m.visitAt),
        confidence: m.confidence, reason: m.evidence.map((e) => e.detail).join('; '),
      });
    }
    for (const v of result.matching.unmatchedVisits) {
      out.push({
        date: ride.dayKey, driverName: name, outcome: v.outcome, orderId: '',
        customerId: v.customerId || '', placeName: v.placeName || '', visitAtIst: IST(v.visitAt),
        confidence: '', reason: v.reason,
      });
    }
    for (const o of result.matching.unmatchedOrders) {
      out.push({
        date: ride.dayKey, driverName: name, outcome: o.outcome, orderId: o.orderId,
        customerId: o.customerId || '', placeName: '', visitAtIst: '',
        confidence: '', reason: o.reason,
      });
    }
  }
  return out;
}

function gpsReliabilityRows(rows) {
  return rows.map(({ ride, result, driver }) => ({
    date: ride.dayKey,
    driverName: driver?.name || ride.driverId,
    points: result.track.totals.rawCount,
    usable: result.track.totals.acceptedCount,
    coverage: `${Math.round((result.track.quality.coverage || 0) * 100)}%`,
    gapCount: result.track.totals.gapCount,
    gapMinutes: Math.round(result.track.totals.gapSecondsTotal / 60),
    jumps: result.track.totals.byReason.implausible_jump || 0,
    lowAccuracy: result.track.totals.byReason.low_accuracy || 0,
    quality: result.track.quality.grade,
    reasons: result.track.quality.reasons.join('; '),
  }));
}

function routeAnomalyRows(rows) {
  const out = [];
  for (const { ride, result, driver } of rows) {
    const name = driver?.name || ride.driverId;
    for (const g of result.track.gaps) {
      out.push({ date: ride.dayKey, driverName: name, kind: 'tracking_gap', atIst: IST(g.fromTs), detail: `${Math.round(g.seconds / 60)} min silence, ${Math.round(g.straightLineM)} m straight-line` });
    }
    const jumps = result.track.totals.byReason.implausible_jump || 0;
    if (jumps) out.push({ date: ride.dayKey, driverName: name, kind: 'implausible_jump', atIst: '', detail: `${jumps} fix(es) rejected as physically impossible` });
    const mock = result.track.totals.byReason.mock_location || 0;
    if (mock) out.push({ date: ride.dayKey, driverName: name, kind: 'mock_location', atIst: '', detail: `${mock} fix(es) flagged by Android as mock locations` });
    for (const s of result.segments) {
      if (s.type === SEGMENT_TYPE.UNKNOWN && s.distanceM > 5000) {
        out.push({ date: ride.dayKey, driverName: name, kind: 'large_unknown_leg', atIst: IST(s.startTs), detail: `${km(s.distanceM)} km unclassified` });
      }
      if (s.ambiguousPlaces) {
        out.push({ date: ride.dayKey, driverName: name, kind: 'ambiguous_geofence', atIst: IST(s.startTs), detail: s.ambiguousPlaces.map((p) => p.name).join(' / ') });
      }
    }
  }
  return out;
}

function classificationAuditRows(reviews, driversById, ridesById) {
  return reviews.map((r) => ({
    atIst: IST(r.at),
    reviewerId: r.reviewerId,
    driverName: driversById.get(ridesById.get(r.rideId)?.driverId)?.name || '',
    date: ridesById.get(r.rideId)?.dayKey || '',
    segmentId: r.segmentId,
    fromType: r.fromType,
    toType: r.toType,
    distanceKm: r.distanceM == null ? '' : km(r.distanceM),
    note: r.note || '',
    reverted: r.reverted ? 'yes' : '',
  }));
}

module.exports = {
  REPORTS, toCsv, toExcelXml, csvCell, iso, IST,
  driverDistanceRows, businessKmRows, restaurantVisitRows, deliveryMatchingRows,
  gpsReliabilityRows, routeAnomalyRows, classificationAuditRows,
};
