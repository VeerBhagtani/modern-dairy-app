/* Make async route handlers report their errors.
 *
 * Express 4 does not look at what a handler returns. An async handler that
 * throws — a Firestore contention error during a stop, a timeout loading the
 * dashboard — produces a rejected promise nobody is waiting on: the error
 * handler in index.js never runs, and the request is simply never answered.
 * The office's browser, or a driver's phone mid-upload, waits until Cloud Run
 * gives up, and on the phone that wait holds the upload queue shut.
 *
 * Wrapping every handler as it is registered sends those errors to next(),
 * where the existing handler turns them into a proper 500. Done at the router
 * rather than handler by handler, so a route added later is covered without
 * anybody remembering to.
 */
'use strict';

function wrap(fn) {
  // Error handlers are recognised by Express by their four parameters; they
  // must keep that shape, and they are not async anyway.
  if (typeof fn !== 'function' || fn.length === 4) return fn;
  const wrapped = function asyncSafe(req, res, next) {
    try {
      const out = fn(req, res, next);
      if (out && typeof out.catch === 'function') out.catch(next);
      return out;
    } catch (e) {
      return next(e);
    }
  };
  return wrapped;
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'all', 'use'];

function asyncRouter(router) {
  for (const m of METHODS) {
    const original = router[m].bind(router);
    router[m] = (...args) => original(...args.map((a) => (Array.isArray(a) ? a.map(wrap) : wrap(a))));
  }
  return router;
}

module.exports = { asyncRouter, wrap };
