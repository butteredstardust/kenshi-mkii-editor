'use strict';

/**
 * Guards the item catalog under `webapp/data/`.
 *
 * These are data-integrity checks, not a round trip — nothing here reads or
 * writes a save. The point is that `items.canonical.json` stays structurally
 * sound and `item-map-audit.json` stays honest: a stale audit that claims a
 * match rate the canonical file does not actually have is worse than no audit,
 * because Phase 2.2 will trust these stringIDs.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const read = (name) => JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'));

const canonical = read('items.canonical.json');
const audit = read('item-map-audit.json');
const snapshot = read('wiki-items.snapshot.json');
const overrides = read('item-overrides.json');

const entries = Object.entries(canonical.items);

test('canonical file parses and is versioned', () => {
  assert.equal(typeof canonical.schemaVersion, 'number');
  assert.ok(canonical.schemaVersion >= 1);
  assert.ok(canonical.generatedAt, 'generatedAt is required');
  assert.ok(!Number.isNaN(Date.parse(canonical.generatedAt)));
  assert.ok(entries.length > 0, 'catalog is empty');
});

test('snapshot carries its provenance and licence', () => {
  assert.equal(typeof snapshot.schemaVersion, 'number');
  assert.ok(snapshot.fetchedAt);
  assert.ok(snapshot.sourceUrl);
  assert.equal(snapshot.license, 'CC BY-SA 3.0');
  assert.ok(Array.isArray(snapshot.items));
});

test('overrides file is a versioned object map', () => {
  assert.equal(typeof overrides.schemaVersion, 'number');
  assert.equal(typeof overrides.items, 'object');
  assert.ok(overrides.items !== null && !Array.isArray(overrides.items));
});

test('every entry has a non-empty displayName', () => {
  for (const [id, item] of entries) {
    assert.equal(typeof item.displayName, 'string', `${id}: displayName must be a string`);
    assert.ok(item.displayName.trim().length > 0, `${id}: displayName is empty`);
  }
});

test('every entry has an explicit stringId key (null allowed, never a guess)', () => {
  for (const [id, item] of entries) {
    assert.ok('stringId' in item, `${id}: missing stringId key`);
    assert.ok(
      item.stringId === null || (typeof item.stringId === 'string' && item.stringId.length > 0),
      `${id}: stringId must be a non-empty string or null, got ${JSON.stringify(item.stringId)}`
    );
    assert.ok('matchMethod' in item, `${id}: missing matchMethod`);
    if (item.stringId === null) {
      assert.equal(item.matchMethod, 'unmatched', `${id}: null stringId must report matchMethod "unmatched"`);
    }
  }
});

test('ids are unique and self-consistent', () => {
  const seen = new Set();
  for (const [id, item] of entries) {
    assert.ok(!seen.has(id), `duplicate id ${id}`);
    seen.add(id);
    assert.equal(item.id, id, `${id}: item.id disagrees with its key`);
  }
  assert.equal(seen.size, entries.length);
});

test('no stringId is claimed by two different items', () => {
  const byStringId = new Map();
  for (const [id, item] of entries) {
    if (!item.stringId) continue;
    const prev = byStringId.get(item.stringId);
    assert.equal(prev, undefined, `${item.stringId} claimed by both ${prev} and ${id}`);
    byStringId.set(item.stringId, id);
  }
});

test('audit is versioned and points at the same generation', () => {
  assert.equal(typeof audit.schemaVersion, 'number');
  assert.equal(audit.generatedAt, canonical.generatedAt, 'audit is stale — regenerate the catalog');
  assert.equal(typeof audit.counts, 'object');
});

test('audit counts match the canonical file contents', () => {
  const items = entries.map(([, i]) => i);
  const count = (fn) => items.filter(fn).length;

  assert.equal(audit.counts.canonicalItems, items.length, 'canonicalItems');
  assert.equal(audit.counts.matched, count((i) => i.stringId), 'matched');
  assert.equal(audit.counts.unmatched, count((i) => !i.stringId), 'unmatched');
  assert.equal(audit.counts.byWikiStringId, count((i) => i.matchMethod === 'wiki-string-id'), 'byWikiStringId');
  assert.equal(audit.counts.exact, count((i) => i.matchMethod === 'exact'), 'exact');
  assert.equal(audit.counts.normalised, count((i) => i.matchMethod === 'normalised'), 'normalised');
  assert.equal(audit.counts.override, count((i) => i.matchMethod === 'override'), 'override');
  assert.equal(
    audit.counts.withDescription,
    count((i) => i.wiki && i.wiki.description),
    'withDescription'
  );
  assert.equal(audit.counts.withImage, count((i) => i.wiki && i.wiki.imageFile), 'withImage');
  assert.equal(audit.counts.wikiSnapshotPages, snapshot.items.length, 'wikiSnapshotPages');

  assert.equal(
    audit.counts.matched + audit.counts.unmatched,
    items.length,
    'matched + unmatched must equal the catalog size'
  );
  assert.equal(
    audit.counts.byWikiStringId + audit.counts.exact + audit.counts.normalised + audit.counts.override,
    audit.counts.matched,
    'match methods must sum to the matched count'
  );
  assert.equal(
    audit.counts.matchRatePercent,
    Number(((audit.counts.matched / items.length) * 100).toFixed(1)),
    'matchRatePercent is not derived from the current counts'
  );
});

test('audit lists the actual unmatched items, not a summary', () => {
  const unmatched = entries.filter(([, i]) => !i.stringId).map(([id]) => id).sort();
  const listed = audit.unmatchedWikiItems.map((u) => u.id).sort();
  assert.deepEqual(listed, unmatched, 'unmatchedWikiItems does not match the canonical file');
  assert.equal(audit.counts.gamedataUnmatched, audit.gamedataUnmatchedNames.length);
});

test('every canonical item came from the snapshot or an override', () => {
  const pages = new Set(snapshot.items.map((i) => i.page));
  const overridden = new Set(Object.keys(overrides.items || {}));
  for (const [id, item] of entries) {
    assert.ok(
      pages.has(item.wiki && item.wiki.page ? item.wiki.page : null) || overridden.has(id),
      `${id}: not traceable to the snapshot or to item-overrides.json`
    );
  }
});
