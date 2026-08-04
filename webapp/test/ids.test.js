'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { readFile, writeFile } = require('../services/kenshi/codec');
const { nextRecordId, mintSid, addRecord, addInstance } = require('../services/kenshi/ids');
const paths = require('../services/pathService');
const fixture = require('./helpers/save-fixture');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

/**
 * Every test below either reads the live save read-only, or mutates a
 * `readFile()` result purely in memory and checks the bytes `writeFile()`
 * would produce — nothing here ever calls fs.writeFileSync against the live
 * save directory. No scratch copy is needed for that reason (contrast with
 * test/mutation.test.js, whose tests exercise mutationService and DO write
 * to a scratch copy).
 */
function roundTrip(t, file) {
  if (!fs.existsSync(file)) return t.skip(`not present: ${file}`);
  const original = fs.readFileSync(file);
  const parsed = readFile(original);
  const rewritten = writeFile(parsed);
  assert.strictEqual(sha(rewritten), sha(original), `byte mismatch for ${path.basename(file)}`);
  return parsed;
}

// (a) Regression guard: the codec change (patching header.nextId on write)
// must not perturb the no-op path — parse, write straight back, byte-identical.
test('writeFile() no-op path is still byte-identical after the nextId patch (platoon)', (t) => {
  const save = fixture.fixtureSave();
  if (!save) return t.skip(fixture.NO_FIXTURE);
  const dir = path.join(save.dir, 'platoon');
  if (!fs.existsSync(dir)) return t.skip('no platoon dir');
  const files = fs.readdirSync(dir).filter((n) => n.endsWith('.platoon'));
  if (!files.length) return t.skip('no .platoon files');
  const parsed = roundTrip(t, path.join(dir, files[0]));
  if (!parsed) return;
  assert.strictEqual(parsed.header.fileType, 15);
  assert.strictEqual(parsed.header.nextIdAt, 4);
});

test('writeFile() no-op path is still byte-identical after the nextId patch (quick.save)', (t) => {
  const save = fixture.fixtureSave();
  if (!save) return t.skip(fixture.NO_FIXTURE);
  roundTrip(t, path.join(save.dir, 'quick.save'));
});

/** Builds a minimal, well-formed record with all nine sections populated. */
function makeRecord({ type = 42, name = '0', modDataType = 0 } = {}) {
  return {
    instanceCount: 0,
    type,
    id: 0, // overwritten by addRecord
    name,
    sid: '', // overwritten by addRecord
    modDataType,
    bools: new Map([['death', false], ['in inventory', true]]),
    floats: new Map([['charges', 1], ['quality', 100]]),
    ints: new Map([['item function', 6], ['quantity', 1]]),
    vec3: new Map(),
    vec4: new Map(),
    strings: new Map([['section', 'main'], ['base data sid', '1-gamedata.base']]),
    filenames: new Map(),
    extra: new Map(),
    instances: [],
  };
}

// (b) addRecord: count +1, round-trips identically (sections + key order),
// nextId increased, new id collides with nothing pre-existing.
test('addRecord mints a record that round-trips and does not collide', (t) => {
  const save = fixture.fixtureSave();
  if (!save) return t.skip(fixture.NO_FIXTURE);
  const dir = path.join(save.dir, 'platoon');
  if (!fs.existsSync(dir)) return t.skip('no platoon dir');
  const files = fs.readdirSync(dir).filter((n) => n.endsWith('.platoon'));
  if (!files.length) return t.skip('no .platoon files');

  const filePath = path.join(dir, files[0]);
  const original = readFile(fs.readFileSync(filePath));
  const beforeCount = original.records.length;
  const beforeNextId = original.header.nextId;
  const existingIds = new Set(original.records.map((r) => r.id));

  const rec = makeRecord();
  const returned = addRecord(original, rec);
  assert.strictEqual(returned, rec, 'addRecord returns the same record it appended');

  assert.strictEqual(original.header.nextId, beforeNextId + 1);
  assert.strictEqual(rec.id, beforeNextId + 1);
  assert.strictEqual(rec.sid, `${rec.id}--INGAME`);
  assert.ok(!existingIds.has(rec.id), 'minted id must not collide with any pre-existing id in this file');

  const bytes = writeFile(original);
  const reparsed = readFile(bytes);

  assert.strictEqual(reparsed.records.length, beforeCount + 1);
  assert.strictEqual(reparsed.header.nextId, beforeNextId + 1);

  const found = reparsed.records.find((r) => r.id === rec.id && r.sid === rec.sid);
  assert.ok(found, 'minted record must be present after round trip');

  // Every section's entries AND key order must survive, not just size.
  for (const section of ['bools', 'floats', 'ints', 'vec3', 'vec4', 'strings', 'filenames']) {
    assert.deepStrictEqual([...found[section].entries()], [...rec[section].entries()], `section ${section} mismatch`);
  }
  assert.deepStrictEqual([...found.extra.entries()], [...rec.extra.entries()]);
  assert.deepStrictEqual(found.instances, rec.instances);
  assert.strictEqual(found.type, rec.type);
  assert.strictEqual(found.name, rec.name);
  assert.strictEqual(found.modDataType, rec.modDataType);
  assert.strictEqual(found.instanceCount, rec.instanceCount);

  // No id collision anywhere in the re-parsed file either.
  const ids = reparsed.records.map((r) => r.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'no duplicate ids after mint + round trip');
});

test('addRecord rejects a malformed record before appending', (t) => {
  const save = fixture.fixtureSave();
  if (!save) return t.skip(fixture.NO_FIXTURE);
  const dir = path.join(save.dir, 'platoon');
  if (!fs.existsSync(dir)) return t.skip('no platoon dir');
  const files = fs.readdirSync(dir).filter((n) => n.endsWith('.platoon'));
  if (!files.length) return t.skip('no .platoon files');

  const original = readFile(fs.readFileSync(path.join(dir, files[0])));
  const beforeCount = original.records.length;
  const beforeNextId = original.header.nextId;

  const badSectionType = makeRecord();
  badSectionType.bools = {}; // not a Map
  assert.throws(() => addRecord(original, badSectionType), /must be a Map/);

  const badInstanceCount = makeRecord();
  badInstanceCount.instanceCount = 3; // instances.length is 0
  assert.throws(() => addRecord(original, badInstanceCount), /instanceCount/);

  // A malformed record must fail before mutating file state.
  assert.strictEqual(original.records.length, beforeCount);
  assert.strictEqual(original.header.nextId, beforeNextId);
});

// (c) addInstance: bumps instances.length and instanceCount together,
// survives write/re-parse, ordinal id does not collide.
test('addInstance bumps instanceCount in lockstep and survives round trip', (t) => {
  const save = fixture.fixtureSave();
  if (!save) return t.skip(fixture.NO_FIXTURE);
  const dir = path.join(save.dir, 'platoon');
  if (!fs.existsSync(dir)) return t.skip('no platoon dir');
  const files = fs.readdirSync(dir).filter((n) => n.endsWith('.platoon'));

  let target = null;
  let parsed = null;
  for (const f of files) {
    const p = readFile(fs.readFileSync(path.join(dir, f)));
    const inv = p.records.find((r) => r.type === 41 && r.instances.length > 0);
    if (inv) { target = inv; parsed = p; break; }
  }
  if (!target) return t.skip('no INVENTORY (41) record with existing instances found');

  const beforeLen = target.instances.length;
  const existingInstanceIds = new Set(target.instances.map((i) => i.id));

  const newItemSid = '99999--INGAME'; // synthetic target, doesn't need to resolve for this test
  const inst = addInstance(target, newItemSid);

  assert.strictEqual(target.instances.length, beforeLen + 1);
  assert.strictEqual(target.instanceCount, target.instances.length);
  assert.ok(!existingInstanceIds.has(inst.id), 'minted ordinal must not collide with existing instance ids');
  assert.deepStrictEqual(inst.pos, [0, 0, 0]);
  assert.deepStrictEqual(inst.rot, [1, 0, 0, 0]);
  assert.deepStrictEqual(inst.states, []);
  assert.strictEqual(inst.target, newItemSid);

  const bytes = writeFile(parsed);
  const reparsed = readFile(bytes);
  const foundContainer = reparsed.records.find((r) => r.id === target.id && r.type === 41);
  assert.ok(foundContainer, 'container record must still be present');
  assert.strictEqual(foundContainer.instances.length, beforeLen + 1);
  assert.strictEqual(foundContainer.instanceCount, foundContainer.instances.length);
  const foundInst = foundContainer.instances.find((i) => i.id === inst.id && i.target === newItemSid);
  assert.ok(foundInst, 'minted instance must round-trip');
});

test('addInstance defaults, overrides, and ordinal fallback behave as specified', () => {
  const container = { instances: [], instanceCount: 0 };
  const a = addInstance(container, 'a-sid');
  assert.strictEqual(a.id, '1');
  const b = addInstance(container, 'b-sid');
  assert.strictEqual(b.id, '2');
  assert.strictEqual(container.instanceCount, 2);

  // Non-numeric existing id falls back to instances.length + 1.
  const weird = { instances: [{ id: 'abc', target: 't', pos: [0, 0, 0], rot: [1, 0, 0, 0], states: [] }], instanceCount: 1 };
  const c = addInstance(weird, 'c-sid');
  assert.strictEqual(c.id, '2'); // instances.length (1) + 1, not "abc"+1

  // Sparse numeric ids: max + 1, not length + 1.
  const sparse = {
    instances: [
      { id: '1', target: 't', pos: [0, 0, 0], rot: [1, 0, 0, 0], states: [] },
      { id: '5', target: 't', pos: [0, 0, 0], rot: [1, 0, 0, 0], states: [] },
    ],
    instanceCount: 2,
  };
  const d = addInstance(sparse, 'd-sid');
  assert.strictEqual(d.id, '6');

  // opts overrides.
  const overridden = addInstance({ instances: [], instanceCount: 0 }, 'x-sid', {
    pos: [1, 2, 3], rot: [0, 0, 0, 1], states: ['some-sid'],
  });
  assert.deepStrictEqual(overridden.pos, [1, 2, 3]);
  assert.deepStrictEqual(overridden.rot, [0, 0, 0, 1]);
  assert.deepStrictEqual(overridden.states, ['some-sid']);
});

test('mintSid produces the "<id>--INGAME" double-dash form', () => {
  assert.strictEqual(mintSid(619), '619--INGAME');
  assert.strictEqual(mintSid('7'), '7--INGAME');
});

// (d) nextRecordId throws on filetype 16/17.
test('nextRecordId throws on mod files (filetype 16/17), which have no nextId', (t) => {
  const dataDir = paths.gameDataDir();
  if (!dataDir) return t.skip('Kenshi install not found');
  const candidates = ['rebirth.mod', 'Newwworld.mod', 'Dialogue.mod'];
  const found = candidates.find((f) => fs.existsSync(path.join(dataDir, f)));
  if (!found) return t.skip('no .mod file found in gamedata dir');

  const parsed = readFile(fs.readFileSync(path.join(dataDir, found)));
  assert.ok(parsed.header.fileType === 16 || parsed.header.fileType === 17);
  assert.throws(() => nextRecordId(parsed), /only filetype 15/);
});

test('addRecord also throws on mod files', (t) => {
  const dataDir = paths.gameDataDir();
  if (!dataDir) return t.skip('Kenshi install not found');
  const candidates = ['rebirth.mod', 'Newwworld.mod', 'Dialogue.mod'];
  const found = candidates.find((f) => fs.existsSync(path.join(dataDir, f)));
  if (!found) return t.skip('no .mod file found in gamedata dir');

  const parsed = readFile(fs.readFileSync(path.join(dataDir, found)));
  assert.throws(() => addRecord(parsed, makeRecord()), /only filetype 15/);
});
