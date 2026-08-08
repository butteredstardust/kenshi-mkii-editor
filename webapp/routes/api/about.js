'use strict';

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');

const { handle } = require('../lib/handler');

const router = express.Router();

/*
 * The Acknowledgements page's source.
 *
 * It serves the REAL `ACKNOWLEDGEMENTS.md` rather than a copy pasted into a
 * frontend module, because the CC BY-SA attribution the item catalogue carries
 * is a licence obligation: a second copy is a copy that goes stale, and a stale
 * attribution is a broken one. The file is also what the installer shows
 * (`InfoBeforeFile` in releases/build.ps1), so there is exactly one text.
 *
 * Two candidate locations, in order, because the file sits in a different
 * place in the two ways this app runs:
 *   - packaged: releases/build.ps1 copies it next to `server.js`, i.e. one
 *     level up from `routes/api/`... which is `webapp/` in a source checkout
 *     too, so this candidate is the packaged one.
 *   - source:   the repo root, one level above `webapp/`.
 * Nothing is guessed beyond these two — a miss is a 404 with the paths tried,
 * not an empty page pretending the notices do not exist.
 */
const CANDIDATES = [
  path.join(__dirname, '..', '..', 'ACKNOWLEDGEMENTS.md'),
  path.join(__dirname, '..', '..', '..', 'ACKNOWLEDGEMENTS.md'),
];

function readNotices() {
  for (const file of CANDIDATES) {
    try {
      return { markdown: fs.readFileSync(file, 'utf8'), file };
    } catch {
      // Try the next candidate; only "none of them" is an error.
    }
  }
  const err = new Error(`ACKNOWLEDGEMENTS.md not found (looked in ${CANDIDATES.join(', ')})`);
  err.status = 404;
  throw err;
}

router.get('/about', handle(() => {
  const { markdown, file } = readNotices();
  // The version is read here rather than baked into the page: the footer and
  // this page are the two places a user checks what they are running.
  const pkg = require('../../package.json');
  return {
    name: pkg.name,
    version: pkg.version,
    dependencies: pkg.dependencies || {},
    node: process.version,
    markdown,
    source: file,
  };
}));

module.exports = router;
