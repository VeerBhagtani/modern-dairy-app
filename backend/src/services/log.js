/* Structured logs: one JSON object per line, which Cloud Logging indexes
 * (severity, event, and every field become searchable).
 *
 * Never pass a token, a password, a secret or a whole request body. Driver
 * and ride ids are fine; names and coordinates are not needed to debug
 * anything here and stay out.
 */
'use strict';

const crypto = require('crypto');

function emit(severity, event, fields = {}) {
  const line = { severity, event, time: new Date().toISOString(), ...fields };
  const out = severity === 'ERROR' || severity === 'WARNING' ? console.error : console.log;
  try { out(JSON.stringify(line)); } catch (e) { out(`{"severity":"${severity}","event":"${event}","logError":"unserialisable fields"}`); }
}

const log = {
  info: (event, fields) => emit('INFO', event, fields),
  warn: (event, fields) => emit('WARNING', event, fields),
  error: (event, fields) => emit('ERROR', event, fields),
};

// A request id on every request and response, so a phone's error report and
// the server's log line can be matched. A caller-supplied id is kept if sane.
function requestId() {
  return (req, res, next) => {
    const given = String(req.headers['x-request-id'] || '');
    req.id = /^[A-Za-z0-9._:-]{8,64}$/.test(given) ? given : crypto.randomUUID();
    res.setHeader('X-Request-Id', req.id);
    next();
  };
}

const errText = (e) => String((e && (e.message || e.code)) || e || '').slice(0, 300);

module.exports = { log, requestId, errText };
