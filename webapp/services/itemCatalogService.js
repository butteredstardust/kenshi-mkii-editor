'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Read-only enrichment layer over `data/items.canonical.json` (the wiki-sourced
 * item catalog built by `scripts/build-item-catalog.js`).
 *
 * IMPORTANT (see TODO.md 2.3): this must never be the SOURCE of an item list —
 * only ~18% of this install's item-typed stringIDs resolve in the catalog (mod
 * items are almost entirely absent), so anything catalog-driven would hide most
 * of a real inventory. The catalog only DECORATES a row that already came from
 * a save record, keyed by `stringId`. A miss is normal and silent — return
 * `null`, never throw, never fabricate a category/description.
 */

const FILE = path.join(__dirname, '..', 'data', 'items.canonical.json');

let bySid = null;

function load() {
  if (bySid) return bySid;
  bySid = new Map();
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    for (const item of Object.values(data.items || {})) {
      if (item.stringId) bySid.set(item.stringId, item);
    }
  } catch {
    // Catalog is an enrichment layer, not a requirement — a missing/unreadable
    // file just means every lookup() misses, same as any other unmatched item.
  }
  return bySid;
}

/** Look up a save item's `base data sid` in the catalog. Returns null on a miss. */
function lookup(stringId) {
  if (!stringId) return null;
  return load().get(stringId) || null;
}

module.exports = { lookup };
