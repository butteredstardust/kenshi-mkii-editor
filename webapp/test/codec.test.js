'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { readFile, writeFile } = require('../services/kenshi/codec');
const paths = require('../services/pathService');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

/**
 * The round trip is the whole safety argument for this editor: if we can read a
 * file and write back the identical bytes, we understand every field in it. Any
 * file that fails this must never be written to disk.
 */
function roundTrip(t, file) {
  if (!fs.existsSync(file)) return t.skip(`not present: ${file}`);
  const original = fs.readFileSync(file);
  const parsed = readFile(original);
  const rewritten = writeFile(parsed);
  assert.strictEqual(sha(rewritten), sha(original), `byte mismatch for ${path.basename(file)}`);
  return parsed;
}

test('quick.save round-trips byte-identically', (t) => {
  const save = paths.latestSave();
  if (!save) return t.skip('no Kenshi save found');
  const parsed = roundTrip(t, path.join(save.dir, 'quick.save'));
  if (!parsed) return;
  assert.strictEqual(parsed.header.fileType, 15);
  assert.ok(parsed.records.length > 0);
});

test('platoon files round-trip byte-identically', (t) => {
  const save = paths.latestSave();
  if (!save) return t.skip('no Kenshi save found');
  const dir = path.join(save.dir, 'platoon');
  if (!fs.existsSync(dir)) return t.skip('no platoon dir');
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.platoon'))) {
    roundTrip(t, path.join(dir, f));
  }
});

test('game data files round-trip byte-identically', (t) => {
  const data = paths.gameDataDir();
  if (!data) return t.skip('Kenshi install not found');
  for (const f of ['gamedata.base', 'rebirth.mod', 'Newwworld.mod', 'Dialogue.mod']) {
    roundTrip(t, path.join(data, f));
  }
});

test('records expose ordered, typed sections', (t) => {
  const save = paths.latestSave();
  if (!save) return t.skip('no Kenshi save found');
  const parsed = readFile(fs.readFileSync(path.join(save.dir, 'quick.save')));
  const gs = parsed.records.find((r) => r.type === 56);
  assert.ok(gs, 'game state record (type 56) present');
  assert.ok(gs.ints.has('player money'));
  assert.ok(gs.strings.has('pfaction name'));
  assert.ok(gs.vec3.get('pos').length === 3);
});
