/**
 * Request parsing defaults for the panel's Express app.
 *
 * Express 5 changed two defaults that the handlers in this codebase were written
 * against under Express 4. This module restores the Express 4 behaviour so the
 * 2026-11-06 upgrade does not change request semantics:
 *
 * - Query parser: Express 5 uses "simple" (node:querystring); Express 4 used qs
 *   ("extended"), which also turns `a[b]=1` / `a[]=1` into objects / arrays.
 * - `req.body`: body-parser 2 leaves it `undefined` when the request has no JSON
 *   body; Express 4's `express.json()` always set `{}`. Handlers destructure
 *   `req.body` directly, so a body-less POST would otherwise turn from
 *   "defaults / 400 validation error" into a TypeError and a 500.
 */
const express = require('express');

function defaultBody(req, res, next) {
  if (req.body === undefined) req.body = {};
  next();
}

/**
 * @param {import('express').Express} app
 */
function applyRequestDefaults(app) {
  app.set('query parser', 'extended');
  app.use(express.json());
  app.use(defaultBody);
}

module.exports = { applyRequestDefaults, defaultBody };
