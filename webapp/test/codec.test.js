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

test('a signalling NaN float survives the round trip', (t) => {
  // Kenshi writes NaN floats into saves (hundreds per quick.save, nearly all in
  // a type-108 spatial cache's instance positions). A float32 -> double ->
  // float32 trip through a JS number preserves a NaN's sign and payload but
  // SETS the quiet bit, so a signalling NaN came back one bit different and the
  // round trip above failed on nothing but that. Caught when the player's own
  // autosaves started carrying them mid-session.
  // The bits have to arrive from DISK for this to test anything: a NaN built in
  // JS has already lost the distinction before the codec ever sees it. So write
  // a file with a marker float, patch the marker's bytes to the pattern under
  // test, then read that back and write it out again.
  const MARKER = 0x3f8ccccd; // 1.1f — a value the surrounding structure can't contain
  const build = () => {
    const rec = { instanceCount: 0, type: 1, id: 1, name: '', sid: 'x', modDataType: 0,
      bools: new Map(), floats: new Map([['f', 1.1]]), ints: new Map(),
      vec3: new Map(), vec4: new Map(), strings: new Map(), filenames: new Map(),
      extra: new Map(), instances: [] };
    const headerRaw = Buffer.alloc(12);
    headerRaw.writeInt32LE(15, 0); // filetype 15 — otherwise re-reading throws
    return writeFile({ header: { fileType: 15, nextId: 1, count: 1, countAt: 8, nextIdAt: 4, recordsAt: 12 },
      headerRaw, records: [rec], tail: Buffer.alloc(0), size: 256 });
  };

  const survives = (bits) => {
    const onDisk = Buffer.from(build());
    let at = -1;
    for (let i = 0; i + 4 <= onDisk.length; i++) if (onDisk.readUInt32LE(i) === MARKER) { at = i; break; }
    assert.notStrictEqual(at, -1, 'marker float not found — the test fixture is wrong');
    onDisk.writeUInt32LE(bits, at);
    const rewritten = writeFile(readFile(onDisk));
    return rewritten.equals(onDisk);
  };

  // 0xffbf1409: sign 1, exponent all ones, quiet bit CLEAR — a signalling NaN,
  // and the exact pattern found in the save that failed.
  assert.ok(survives(0xffbf1409), 'a signalling NaN was quieted by the round trip');
  assert.ok(survives(0xffff1409), 'a quiet NaN did not survive the round trip');
  assert.ok(survives(0x7f800000), 'positive infinity did not survive the round trip');
  assert.ok(survives(0x3f800000), '1.0 did not survive the round trip');
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
