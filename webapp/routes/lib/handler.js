'use strict';

/** Wraps a route body so every failure becomes a JSON error with a sane status. */
function handle(fn) {
  return async (req, res) => {
    try {
      res.json(await fn(req, res));
    } catch (err) {
      const status = err.status || 500;
      const body = { error: err.message };
      if (err.rollbackStatus) body.rollbackStatus = err.rollbackStatus;
      res.status(status).json(body);
    }
  };
}

module.exports = { handle };
