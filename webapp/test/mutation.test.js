'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const paths = require('../services/pathService');
const fixture = require('./helpers/save-fixture');
const backups = require('../services/backupService');
const saveService = require('../services/saveService');
const mutation = require('../services/mutationService');
const itemSlots = require('../services/itemSlots');
const gamedata = require('../services/gamedataService');
const { readFile, writeFile } = require('../services/kenshi/codec');
const { asText } = require('../services/kenshi/binary');

/**
 * The write pipeline is exercised against a COPY of the test fixture in a temp
 * directory — never the player's live save, and never the fixture itself.
 * Backup root is redirected for the same reason.
 */
const scratchSave = fixture.scratchSave;

// ------------------------------------------------------- the gate's scope --

test('the game-running gate protects live saves, and only live saves', (t) => {
  const root = paths.saveRoot();
  if (!root) return t.skip('no Kenshi save root on this machine');

  // Anything under the real save root is live and stays gated, whatever else
  // is true. This is the half that must never regress: relaxing the gate is
  // only safe because it cannot possibly apply to a save Kenshi owns.
  assert.strictEqual(mutation.isLiveSaveDir(root), true);
  assert.strictEqual(mutation.isLiveSaveDir(path.join(root, 'autosave1')), true);
  assert.strictEqual(mutation.isLiveSaveDir(path.join(root, 'a', 'b')), true);
  for (const live of paths.listSaves()) {
    assert.strictEqual(mutation.isLiveSaveDir(live.dir), true, `${live.dir} must be gated`);
  }

  // The fixture and the temp copies made from it are not saves the game knows
  // about, so they are not gated — which is what lets the write suite run while
  // the player is playing.
  assert.strictEqual(mutation.isLiveSaveDir(fixture.fixtureRoot()), false);
  assert.strictEqual(mutation.isLiveSaveDir(os.tmpdir()), false);

  // A path that merely LOOKS like the save root from outside is not inside it.
  assert.strictEqual(mutation.isLiveSaveDir(`${root}-elsewhere`), false);
  assert.strictEqual(mutation.isLiveSaveDir(path.join(root, '..', 'somewhere-else')), false);
  return undefined;
});

test('the fixture lives outside the Kenshi save root', (t) => {
  // If the fixture were ever created inside the save root, every write test
  // would be aimed at something Kenshi owns.
  const f = fixture.fixtureSave();
  if (!f) return t.skip(fixture.NO_FIXTURE);
  assert.strictEqual(mutation.isLiveSaveDir(f.dir), false, `fixture is inside the live save root: ${f.dir}`);
  return undefined;
});

test('a mutation touches only the files it reports, leaving the rest byte-identical', async (t) => {
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);
  try {
    const before = backups.hashDir(scratch.dir);
    const receipt = await mutation.mutate(scratch.dir, 'test: scope of a write',
      (staging) => saveService.setPlayerMoney(staging, 4242));
    const after = backups.hashDir(scratch.dir);

    assert.deepStrictEqual(receipt.changedFiles, ['quick.save']);
    const actuallyChanged = Object.keys(after).filter((k) => after[k] !== before[k]);
    assert.deepStrictEqual(actuallyChanged, ['quick.save'],
      'a write altered files it did not report');
    assert.deepStrictEqual(Object.keys(after).sort(), Object.keys(before).sort(),
      'a write added or removed files in the save directory');

    // With a full fixture the check above covers the 210 zone/ files as well —
    // the reason `make-fixture.js` keeps them by default. A `--slim` fixture
    // still proves the property, just over fewer files, so this only asserts
    // the coverage it was actually given.
    const untouched = Object.keys(before).filter((k) => k !== 'quick.save');
    const info = fixture.fixtureInfo() || {};
    assert.ok(untouched.length > 0, 'nothing else in the save to prove was left alone');
    if (!info.slim) {
      assert.ok(untouched.length > 100,
        `a full fixture should have hundreds of other files, saw ${untouched.length}`);
    }
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
  }
  return undefined;
});

test('setPlayerMoney writes, verifies and reports a receipt', async (t) => {
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);

  try {
    const receipt = await mutation.mutate(scratch.dir, 'test: set money',
      (staging) => saveService.setPlayerMoney(staging, 12345));

    assert.deepStrictEqual(receipt.changedFiles, ['quick.save']);
    assert.strictEqual(receipt.rollbackStatus, 'not needed');
    assert.notStrictEqual(receipt.beforeHashes['quick.save'], receipt.afterHashes['quick.save']);

    const after = readFile(fs.readFileSync(path.join(scratch.dir, 'quick.save')));
    const gs = after.records.find((r) => r.type === saveService.T.GAME_STATE);
    assert.strictEqual(gs.ints.get('player money'), 12345);

    // The edit must change exactly one field: same record count, same order.
    const original = readFile(fs.readFileSync(path.join(fixture.fixtureSave().dir, 'quick.save')));
    assert.strictEqual(after.records.length, original.records.length);
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

/** Find a platoon file + character sid that has a STATS record, from a live save. */
function findStatsCharacter() {
  const src = fixture.fixtureSave();
  if (!src) return null;
  const pdir = path.join(src.dir, 'platoon');
  if (!fs.existsSync(pdir)) return null;
  for (const f of fs.readdirSync(pdir).filter((n) => n.endsWith('.platoon')).sort()) {
    const { characters } = saveService.readPlatoon(path.join(pdir, f));
    const c = characters.find((ch) => ch.stats && ch.stats.skills && ch.stats.skills.length > 0);
    if (c) return { platoonFile: f, sid: c.sid };
  }
  return null;
}

test('setStats sets a single stat and round-trips', async (t) => {
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);
  const target = findStatsCharacter();
  if (!target) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('no character with a STATS record found'); }

  try {
    const relFile = path.join('platoon', target.platoonFile);
    const before = readFile(fs.readFileSync(path.join(scratch.dir, relFile)));

    const receipt = await mutation.mutate(scratch.dir, 'test: set strength',
      (staging) => saveService.setStat(staging, target.platoonFile, target.sid, 'strength', 75));

    assert.deepStrictEqual(receipt.changedFiles, [relFile]);
    assert.strictEqual(receipt.rollbackStatus, 'not needed');

    const after = readFile(fs.readFileSync(path.join(scratch.dir, relFile)));
    assert.strictEqual(after.records.length, before.records.length);

    const { records } = saveService.resolveCharacter(scratch.dir, target.platoonFile, target.sid);
    assert.strictEqual(records.stats.floats.get('strength'), 75);
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

test('setStats rejects out-of-range and unknown stat keys without touching the save', async (t) => {
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);
  const target = findStatsCharacter();
  if (!target) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('no character with a STATS record found'); }

  try {
    const before = backups.hashDir(scratch.dir);

    await assert.rejects(
      mutation.mutate(scratch.dir, 'test: stat too high',
        (staging) => saveService.setStat(staging, target.platoonFile, target.sid, 'strength', 150)),
      /must not exceed 100/,
    );
    await assert.rejects(
      mutation.mutate(scratch.dir, 'test: negative attribute',
        (staging) => saveService.setStat(staging, target.platoonFile, target.sid, 'strength', -1)),
      /must not be less than 0/,
    );
    await assert.rejects(
      mutation.mutate(scratch.dir, 'test: unknown stat',
        (staging) => saveService.setStat(staging, target.platoonFile, target.sid, 'not_a_real_stat_key', 10)),
      /unknown stat/,
    );

    assert.deepStrictEqual(backups.hashDir(scratch.dir), before);
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

test('resolveCharacter rejects a platoon file name that escapes the save directory', (t) => {
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);

  try {
    // `:file` is percent-decoded by Express, so these are all reachable from a
    // request URL. relFile is a write target — none may resolve outside saveDir.
    for (const bad of ['../quick.save', '../../quick.save', 'platoon/../../quick.save',
      '..\\quick.save', '/etc/passwd', 'quick.save']) {
      assert.throws(
        () => saveService.resolveCharacter(scratch.dir, bad, 'whatever'),
        /invalid platoon file name/,
        `expected rejection for ${bad}`,
      );
    }
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

test('setStats bulk form sets 3+ stats in one call and preserves key order', async (t) => {
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);
  const target = findStatsCharacter();
  if (!target) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('no character with a STATS record found'); }

  try {
    const { records: beforeRecs } = saveService.resolveCharacter(scratch.dir, target.platoonFile, target.sid);
    const beforeKeys = [...beforeRecs.stats.floats.keys()];
    // Use real keys already present on the record so we don't mint a new one.
    const [k1, k2, k3] = beforeKeys.filter((k) => k !== 'xp' && k !== 'free attribute points').slice(0, 3);
    assert.ok(k1 && k2 && k3, 'expected at least 3 float keys on the STATS record');

    const receipt = await mutation.mutate(scratch.dir, 'test: bulk stats',
      (staging) => saveService.setStats(staging, target.platoonFile, target.sid, { [k1]: 11, [k2]: 22, [k3]: 33 }));

    assert.deepStrictEqual(receipt.changedFiles, [path.join('platoon', target.platoonFile)]);

    const { records: afterRecs } = saveService.resolveCharacter(scratch.dir, target.platoonFile, target.sid);
    assert.strictEqual(afterRecs.stats.floats.get(k1), 11);
    assert.strictEqual(afterRecs.stats.floats.get(k2), 22);
    assert.strictEqual(afterRecs.stats.floats.get(k3), 33);

    // Key insertion order must be unchanged — only values differ.
    assert.deepStrictEqual([...afterRecs.stats.floats.keys()], beforeKeys);
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

test('setStats allows a negative skill value but still rejects a negative attribute', async (t) => {
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);
  const target = findStatsCharacter();
  if (!target) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('no character with a STATS record found'); }

  try {
    const { records } = saveService.resolveCharacter(scratch.dir, target.platoonFile, target.sid);
    if (!records.stats.floats.has('thievery')) {
      fs.rmSync(scratch.root, { recursive: true, force: true });
      return t.skip('character has no "thievery" float key');
    }

    // Skill: a negative value is real, observed game data (untrained skills
    // sit slightly below 0) and must round-trip.
    const receipt = await mutation.mutate(scratch.dir, 'test: negative skill',
      (staging) => saveService.setStat(staging, target.platoonFile, target.sid, 'thievery', -3.5));
    assert.strictEqual(receipt.rollbackStatus, 'not needed');
    const after = saveService.resolveCharacter(scratch.dir, target.platoonFile, target.sid);
    assert.strictEqual(after.records.stats.floats.get('thievery'), -3.5);

    // Attribute: negative is still rejected, and the save is left byte-identical.
    const beforeHash = backups.hashDir(scratch.dir);
    await assert.rejects(
      mutation.mutate(scratch.dir, 'test: negative attribute after skill edit',
        (staging) => saveService.setStat(staging, target.platoonFile, target.sid, 'strength', -1)),
      /must not be less than 0/,
    );
    assert.deepStrictEqual(backups.hashDir(scratch.dir), beforeHash);

    // >100 stays rejected for both kinds.
    await assert.rejects(
      mutation.mutate(scratch.dir, 'test: skill too high',
        (staging) => saveService.setStat(staging, target.platoonFile, target.sid, 'thievery', 150)),
      /must not exceed 100/,
    );
    await assert.rejects(
      mutation.mutate(scratch.dir, 'test: attribute too high',
        (staging) => saveService.setStat(staging, target.platoonFile, target.sid, 'strength', 150)),
      /must not exceed 100/,
    );
    assert.deepStrictEqual(backups.hashDir(scratch.dir), beforeHash);
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

/** Find a platoon file + character sid that has a MEDICAL record with at least one body part. */
function findMedicalCharacter() {
  const src = fixture.fixtureSave();
  if (!src) return null;
  const pdir = path.join(src.dir, 'platoon');
  if (!fs.existsSync(pdir)) return null;
  for (const f of fs.readdirSync(pdir).filter((n) => n.endsWith('.platoon')).sort()) {
    const { characters } = saveService.readPlatoon(path.join(pdir, f));
    const c = characters.find((ch) => ch.medical && ch.medical.parts && ch.medical.parts.length > 0);
    if (c) return { platoonFile: f, sid: c.sid };
  }
  return null;
}

/** The Phase 0 investigation found a comatose Cannibal with ints.limbs: 16 and
 * negative flesh in Cannibals_1.platoon — check there first for the
 * dead/coma/limbs fixtures the revive and restore-limbs tests need. */
function findCannibalsFile() {
  const src = fixture.fixtureSave();
  if (!src) return null;
  const p = path.join(src.dir, 'platoon', 'Cannibals_1.platoon');
  return fs.existsSync(p) ? p : null;
}

test('healPart sets flesh<n> and zeroes bandage/stun, leaving sid<n>/hit<n> untouched', async (t) => {
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);
  const target = findMedicalCharacter();
  if (!target) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('no character with a MEDICAL record found'); }

  try {
    const relFile = path.join('platoon', target.platoonFile);
    const before = saveService.resolveCharacter(scratch.dir, target.platoonFile, target.sid);
    const rec = before.records.medical;
    let n = 0;
    for (; n < saveService.BODY_SLOTS; n++) if (rec.floats.has(`hit${n}`)) break;
    const beforeSid = rec.strings.get(`sid${n}`);
    const beforeHit = rec.floats.get(`hit${n}`);

    const receipt = await mutation.mutate(scratch.dir, 'test: heal part',
      (staging) => saveService.healPart(staging, target.platoonFile, target.sid, n, { flesh: 42, bandage: 3, stun: 1 }));

    assert.deepStrictEqual(receipt.changedFiles, [relFile]);
    assert.strictEqual(receipt.rollbackStatus, 'not needed');

    const after = saveService.resolveCharacter(scratch.dir, target.platoonFile, target.sid);
    const arec = after.records.medical;
    assert.strictEqual(arec.floats.get(`flesh${n}`), 42);
    assert.strictEqual(arec.floats.get(`bandage${n}`), 3);
    assert.strictEqual(arec.floats.get(`stun${n}`), 1);
    // Adjacent fields on the same part, and the record shape, are untouched.
    assert.strictEqual(arec.strings.get(`sid${n}`), beforeSid);
    assert.strictEqual(arec.floats.get(`hit${n}`), beforeHit);
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

test('healPart "full" sets flesh to the max of the character\'s own parts, never hit<n>', async (t) => {
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);
  const target = findMedicalCharacter();
  if (!target) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('no character with a MEDICAL record found'); }

  try {
    const before = saveService.resolveCharacter(scratch.dir, target.platoonFile, target.sid);
    const rec = before.records.medical;
    let n = 0;
    for (; n < saveService.BODY_SLOTS; n++) if (rec.floats.has(`hit${n}`)) break;
    const allCurrent = [];
    for (let i = 0; i < saveService.BODY_SLOTS; i++) if (rec.floats.has(`hit${i}`)) allCurrent.push(rec.floats.get(`flesh${i}`) ?? 0);
    const expectedMax = Math.max(0, ...allCurrent);

    // Wound the part first, so this asserts a real heal rather than depending
    // on the live save happening to contain a damaged character. On a fully
    // healed squad "set flesh to the max of my own parts" is a genuine no-op
    // and the mutation gate rightly rejects it — which used to fail this test
    // for reasons that had nothing to do with healPart().
    await mutation.mutate(scratch.dir, 'test: wound a part first',
      (staging) => saveService.damagePart(staging, target.platoonFile, target.sid, n, { flesh: expectedMax / 4 }));

    await mutation.mutate(scratch.dir, 'test: full heal',
      (staging) => saveService.healPart(staging, target.platoonFile, target.sid, n, { flesh: 'full' }));

    const after = saveService.resolveCharacter(scratch.dir, target.platoonFile, target.sid);
    assert.strictEqual(after.records.medical.floats.get(`flesh${n}`), expectedMax);
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

test('damagePart allows a negative flesh value (documented limb-loss mechanic) and round-trips', async (t) => {
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);
  const target = findMedicalCharacter();
  if (!target) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('no character with a MEDICAL record found'); }

  try {
    const rec = saveService.resolveCharacter(scratch.dir, target.platoonFile, target.sid).records.medical;
    let n = 0;
    for (; n < saveService.BODY_SLOTS; n++) if (rec.floats.has(`hit${n}`)) break;

    const receipt = await mutation.mutate(scratch.dir, 'test: damage part (limb loss)',
      (staging) => saveService.damagePart(staging, target.platoonFile, target.sid, n, { flesh: -83.6 }));
    assert.strictEqual(receipt.rollbackStatus, 'not needed');

    const after = saveService.resolveCharacter(scratch.dir, target.platoonFile, target.sid).records.medical;
    // Stored as a 32-bit float, so compare with the tolerance that implies
    // rather than exact equality (matches the codec's own float precision).
    assert.ok(Math.abs(after.floats.get(`flesh${n}`) - -83.6) < 1e-4, `expected ~-83.6, got ${after.floats.get(`flesh${n}`)}`);

    // healPart must still reject negative values — the clamp difference is
    // the only thing distinguishing the two functions.
    await assert.rejects(
      mutation.mutate(scratch.dir, 'test: healPart rejects negative',
        (staging) => saveService.healPart(staging, target.platoonFile, target.sid, n, { flesh: -1 })),
      /must not be negative/,
    );
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

test('setHunger sets hung and fed independently, in both directions', async (t) => {
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);
  const target = findMedicalCharacter();
  if (!target) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('no character with a MEDICAL record found'); }

  try {
    const before = saveService.resolveCharacter(scratch.dir, target.platoonFile, target.sid).records.medical;
    const originalFed = before.floats.get('fed');

    // Set only hung; fed must stay untouched.
    await mutation.mutate(scratch.dir, 'test: set hung only',
      (staging) => saveService.setHunger(staging, target.platoonFile, target.sid, { hung: 1.5 }));
    let mid = saveService.resolveCharacter(scratch.dir, target.platoonFile, target.sid).records.medical;
    assert.strictEqual(mid.floats.get('hung'), 1.5);
    assert.strictEqual(mid.floats.get('fed'), originalFed);

    // Now set only fed; hung must stay at the value from the previous write.
    await mutation.mutate(scratch.dir, 'test: set fed only',
      (staging) => saveService.setHunger(staging, target.platoonFile, target.sid, { fed: 7 }));
    const after = saveService.resolveCharacter(scratch.dir, target.platoonFile, target.sid).records.medical;
    assert.strictEqual(after.floats.get('fed'), 7);
    assert.strictEqual(after.floats.get('hung'), 1.5);
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

test('revive clears flags and raises lethal flesh in one combined mutation', async (t) => {
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);

  const cannibalsPath = findCannibalsFile();
  let target = null;
  let usedFixture = 'live';
  if (cannibalsPath) {
    const { characters } = saveService.readPlatoon(cannibalsPath);
    const c = characters.find((ch) => ch.medical && (ch.medical.dead || ch.medical.coma || ch.medical.incapacitated));
    if (c) target = { platoonFile: 'Cannibals_1.platoon', sid: c.sid };
  }

  try {
    if (!target) {
      // No dead/comatose character available in this save — build one
      // synthetically in the scratch copy rather than skip silently, per the
      // task's explicit instruction.
      usedFixture = 'synthetic';
      const found = findMedicalCharacter();
      if (!found) { return t.skip('no character with a MEDICAL record found at all'); }
      target = found;
      const abs = path.join(scratch.dir, 'platoon', target.platoonFile);
      // NB: mutate and write the SAME parse — `records` points into `parsed`.
      // Reading a second, independent parse here would silently discard every
      // edit below and leave the fixture unbuilt.
      const { parsed, records } = saveService.resolveCharacter(scratch.dir, target.platoonFile, target.sid);
      records.medical.bools.set('dead', true);
      records.medical.bools.set('coma', true);
      records.medical.floats.set('KO', 9999);
      // Force at least one part to a lethal-looking value below any floor.
      let n = 0;
      for (; n < saveService.BODY_SLOTS; n++) if (records.medical.floats.has(`hit${n}`)) break;
      records.medical.floats.set(`flesh${n}`, -50);
      fs.writeFileSync(abs, writeFile(parsed));
    }

    const receipt = await mutation.mutate(scratch.dir, `test: revive (${usedFixture} fixture)`,
      (staging) => saveService.revive(staging, target.platoonFile, target.sid, { minFleshPercent: 50 }));

    assert.strictEqual(receipt.rollbackStatus, 'not needed');
    const after = saveService.resolveCharacter(scratch.dir, target.platoonFile, target.sid).records.medical;
    assert.strictEqual(after.bools.get('dead'), false);
    assert.strictEqual(after.bools.get('coma'), false);
    assert.strictEqual(after.bools.get('incapacitated'), false);
    assert.strictEqual(after.bools.get('unconcious'), false);
    assert.strictEqual(after.floats.get('KO'), 0);

    // Flesh must have been raised in the SAME write — no part below the floor.
    let maxFlesh = 0;
    for (let i = 0; i < saveService.BODY_SLOTS; i++) if (after.floats.has(`hit${i}`)) maxFlesh = Math.max(maxFlesh, after.floats.get(`flesh${i}`));
    const floor = maxFlesh * 0.5;
    for (let i = 0; i < saveService.BODY_SLOTS; i++) {
      if (!after.floats.has(`hit${i}`)) continue;
      assert.ok(after.floats.get(`flesh${i}`) >= floor - 1e-9, `part ${i} flesh below floor after revive`);
    }
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

test('revive refuses a character with no intact part rather than half-reviving it', async (t) => {
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);
  const target = findMedicalCharacter();
  if (!target) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('no character with a MEDICAL record found'); }

  try {
    // Synthetic fixture: drive every body part to or below zero, so there is no
    // intact part to measure a floor against. Clearing the death flags here
    // would leave HP lethal and the character would die again on reload.
    const abs = path.join(scratch.dir, 'platoon', target.platoonFile);
    // NB: mutate and write the SAME parse — `records` points into `parsed`.
    const { parsed, records } = saveService.resolveCharacter(scratch.dir, target.platoonFile, target.sid);
    records.medical.bools.set('dead', true);
    for (let i = 0; i < saveService.BODY_SLOTS; i++) {
      if (records.medical.floats.has(`hit${i}`)) records.medical.floats.set(`flesh${i}`, -10);
    }
    fs.writeFileSync(abs, writeFile(parsed));

    const before = backups.hashDir(scratch.dir);
    await assert.rejects(
      mutation.mutate(scratch.dir, 'test: revive with no intact part',
        (staging) => saveService.revive(staging, target.platoonFile, target.sid)),
      /no intact body part/,
    );
    // The refusal must leave the save untouched.
    assert.deepStrictEqual(backups.hashDir(scratch.dir), before);
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

test('restoreLimbs deletes ints.limbs, preserving remaining key order', async (t) => {
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);

  const cannibalsPath = findCannibalsFile();
  let target = null;
  let usedFixture = 'live';
  if (cannibalsPath) {
    const { characters } = saveService.readPlatoon(cannibalsPath);
    const c = characters.find((ch) => ch.medical && ch.medical.limbs != null);
    if (c) target = { platoonFile: 'Cannibals_1.platoon', sid: c.sid };
  }

  try {
    if (!target) {
      // No character with a limbs key in the sample save — build one
      // synthetically rather than skip silently.
      usedFixture = 'synthetic';
      const found = findMedicalCharacter();
      if (!found) { return t.skip('no character with a MEDICAL record found at all'); }
      target = found;
      const abs = path.join(scratch.dir, 'platoon', target.platoonFile);
      // NB: mutate and write the SAME parse — `records` points into `parsed`.
      const { parsed, records } = saveService.resolveCharacter(scratch.dir, target.platoonFile, target.sid);
      records.medical.ints.set('limbs', 16);
      fs.writeFileSync(abs, writeFile(parsed));
    }

    const { records: beforeRecs } = saveService.resolveCharacter(scratch.dir, target.platoonFile, target.sid);
    const beforeIntKeys = [...beforeRecs.medical.ints.keys()].filter((k) => k !== 'limbs');
    assert.ok(beforeRecs.medical.ints.has('limbs'), 'fixture must have ints.limbs before the test');

    const receipt = await mutation.mutate(scratch.dir, `test: restore limbs (${usedFixture} fixture)`,
      (staging) => saveService.restoreLimbs(staging, target.platoonFile, target.sid));

    assert.strictEqual(receipt.rollbackStatus, 'not needed');
    const after = saveService.resolveCharacter(scratch.dir, target.platoonFile, target.sid).records.medical;
    assert.strictEqual(after.ints.has('limbs'), false);
    assert.deepStrictEqual([...after.ints.keys()], beforeIntKeys);
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

test('restoreLimbs is rejected as a no-op when the character has no limbs key', async (t) => {
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);
  const target = findMedicalCharacter();
  if (!target) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('no character with a MEDICAL record found'); }

  try {
    const rec = saveService.resolveCharacter(scratch.dir, target.platoonFile, target.sid).records.medical;
    if (rec.ints.has('limbs')) { return t.skip('this character unexpectedly already has a limbs key'); }

    await assert.rejects(
      mutation.mutate(scratch.dir, 'test: restore limbs no-op',
        (staging) => saveService.restoreLimbs(staging, target.platoonFile, target.sid)),
      /produced no change/,
    );
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

test('trainCharacter sets attributes to 45 and rolls archetype/other skills into their bands', async (t) => {
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);
  const target = findStatsCharacter();
  if (!target) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('no character with a STATS record found'); }

  try {
    const relFile = path.join('platoon', target.platoonFile);
    const before = readFile(fs.readFileSync(path.join(scratch.dir, relFile)));

    // `mode: 'set'` on purpose: the bands below are what the roll produces, and
    // the default 'raise' mode writes Math.max(current, rolled), so a character
    // who already had a high skill would blow the "15-40" assertion for reasons
    // that are the point of raise mode, not a bug. Raise semantics have their
    // own test immediately below.
    const receipt = await mutation.mutate(scratch.dir, 'test: train soldier/katanas',
      (staging) => saveService.trainCharacter(staging, target.platoonFile, target.sid,
        { archetype: 'soldier', sub: 'katanas', mode: 'set', rng: () => 0.5 }));

    assert.deepStrictEqual(receipt.changedFiles, [relFile]);
    assert.strictEqual(receipt.rollbackStatus, 'not needed');

    const after = readFile(fs.readFileSync(path.join(scratch.dir, relFile)));
    assert.strictEqual(after.records.length, before.records.length);

    const { records } = saveService.resolveCharacter(scratch.dir, target.platoonFile, target.sid);
    const f = records.stats.floats;

    for (const a of ['strength', 'dexterity', 'toughness2', 'perception']) {
      if (f.has(a)) assert.ok(f.get(a) >= 45, `attribute ${a} expected >= 45, got ${f.get(a)}`);
    }

    const archetypeSkills = new Set([
      'attack', 'defence', 'dodge', 'mass combat', 'warrior spirit', 'endurance', 'athletics', 'katana',
    ]);
    for (const [key, value] of f) {
      if (key === 'xp' || key === 'free attribute points') continue;
      if (['strength', 'dexterity', 'toughness2', 'perception'].includes(key)) continue;
      if (archetypeSkills.has(key)) {
        assert.ok(value >= 45 && value <= 95, `archetype skill ${key} expected 45-95, got ${value}`);
      } else {
        assert.ok(value >= 15 && value <= 40, `secondary skill ${key} expected 15-40, got ${value}`);
      }
    }
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

test('trainCharacter mode "raise" never lowers an existing stat', async (t) => {
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);
  const target = findStatsCharacter();
  if (!target) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('no character with a STATS record found'); }

  try {
    // NB: mutate and write the SAME parse — `records` points into `parsed`.
    // Reading a second independent parse would silently discard the edit.
    const { parsed, records } = saveService.resolveCharacter(scratch.dir, target.platoonFile, target.sid);
    if (!records.stats.floats.has('katana')) {
      fs.rmSync(scratch.root, { recursive: true, force: true });
      return t.skip('character has no "katana" float key');
    }
    records.stats.floats.set('katana', 99);
    const abs = path.join(scratch.dir, 'platoon', target.platoonFile);
    fs.writeFileSync(abs, writeFile(parsed));

    await mutation.mutate(scratch.dir, 'test: train raise mode',
      (staging) => saveService.trainCharacter(staging, target.platoonFile, target.sid,
        { archetype: 'soldier', sub: 'katanas', mode: 'raise', rng: () => 0.5 }));

    const after = saveService.resolveCharacter(scratch.dir, target.platoonFile, target.sid);
    assert.strictEqual(after.records.stats.floats.get('katana'), 99);
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

test('trainCharacter rejects an unknown archetype/sub id and leaves the save byte-identical', async (t) => {
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);
  const target = findStatsCharacter();
  if (!target) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('no character with a STATS record found'); }

  try {
    const before = backups.hashDir(scratch.dir);

    await assert.rejects(
      mutation.mutate(scratch.dir, 'test: unknown archetype',
        (staging) => saveService.trainCharacter(staging, target.platoonFile, target.sid,
          { archetype: 'not_a_real_archetype', sub: 'katanas', rng: () => 0.5 })),
      /unknown archetype/,
    );
    await assert.rejects(
      mutation.mutate(scratch.dir, 'test: unknown sub',
        (staging) => saveService.trainCharacter(staging, target.platoonFile, target.sid,
          { archetype: 'soldier', sub: 'not_a_real_sub', rng: () => 0.5 })),
      /unknown sub-archetype/,
    );

    assert.deepStrictEqual(backups.hashDir(scratch.dir), before);
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

/** Find a platoon file + character sid with 2+ ITEM (type 42) records in inventory. */
function findGearCharacter() {
  const src = fixture.fixtureSave();
  if (!src) return null;
  const pdir = path.join(src.dir, 'platoon');
  if (!fs.existsSync(pdir)) return null;
  for (const f of fs.readdirSync(pdir).filter((n) => n.endsWith('.platoon')).sort()) {
    const { characters } = saveService.readPlatoon(path.join(pdir, f));
    const c = characters.find((ch) => ch.inventory && ch.inventory.length >= 2);
    if (c) return { platoonFile: f, sid: c.sid };
  }
  return null;
}

/**
 * Find (platoonFile, characterSid, itemSid) for an inventory item whose
 * resolved gamedata TEMPLATE typecode is `desiredType` (2=weapon, 3=armour,
 * 4=trade goods — see services/itemSlots.js), optionally also matching a
 * specific currently-observed `section`. Used by the item-compatibility
 * tests below (TODO.md 2.1).
 */
function findItemOfType(desiredType, sectionEquals) {
  const src = fixture.fixtureSave();
  if (!src) return null;
  const pdir = path.join(src.dir, 'platoon');
  if (!fs.existsSync(pdir)) return null;
  for (const f of fs.readdirSync(pdir).filter((n) => n.endsWith('.platoon')).sort()) {
    const { characters } = saveService.readPlatoon(path.join(pdir, f));
    for (const ch of characters) {
      for (const it of ch.inventory || []) {
        const tmpl = gamedata.lookup(it.base);
        if (!tmpl || tmpl.type !== desiredType) continue;
        if (sectionEquals !== undefined && it.section !== sectionEquals) continue;
        return { platoonFile: f, sid: ch.sid, itemSid: it.sid };
      }
    }
  }
  return null;
}

test('setItemSection rejects a weapon moving into shirt, save byte-identical', async (t) => {
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);
  const target = findItemOfType(2);
  if (!target) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('no weapon-type (typecode 2) item found in this save'); }

  try {
    const before = backups.hashDir(scratch.dir);
    await assert.rejects(
      mutation.mutate(scratch.dir, 'test: weapon into shirt',
        (staging) => saveService.setItemSection(staging, target.platoonFile, target.sid, target.itemSid, 'shirt')),
      /cannot move into slot/,
    );
    assert.deepStrictEqual(backups.hashDir(scratch.dir), before);
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

test('setItemSection rejects armour moving into hip, save byte-identical', async (t) => {
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);
  const target = findItemOfType(3);
  if (!target) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('no armour-type (typecode 3) item found in this save'); }

  try {
    const before = backups.hashDir(scratch.dir);
    await assert.rejects(
      mutation.mutate(scratch.dir, 'test: armour into hip',
        (staging) => saveService.setItemSection(staging, target.platoonFile, target.sid, target.itemSid, 'hip')),
      /cannot move into slot/,
    );
    assert.deepStrictEqual(backups.hashDir(scratch.dir), before);
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

test('setItemSection allows a shirt-compatible item to move from main and from backpack_content into shirt', async (t) => {
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);
  // An item currently equipped in `shirt` is, by construction, allowed into
  // `shirt` — this is the case TODO.md 2.1 explicitly calls out as "must keep
  // working": a shirt sitting in inventory or a backpack must still be
  // movable into the character's shirt slot.
  const target = findItemOfType(3, 'shirt');
  if (!target) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('no item currently in the shirt slot found in this save'); }

  try {
    for (const startSection of ['main', 'backpack_content']) {
      // NB: mutate and write the SAME parse — `records` points into `parsed`.
      const { parsed, bySid } = saveService.resolveCharacter(scratch.dir, target.platoonFile, target.sid);
      bySid.get(target.itemSid).strings.set('section', startSection);
      fs.writeFileSync(path.join(scratch.dir, 'platoon', target.platoonFile), writeFile(parsed));

      const receipt = await mutation.mutate(scratch.dir, `test: ${startSection} -> shirt`,
        (staging) => saveService.setItemSection(staging, target.platoonFile, target.sid, target.itemSid, 'shirt'));
      assert.strictEqual(receipt.rollbackStatus, 'not needed');

      const after = saveService.resolveCharacter(scratch.dir, target.platoonFile, target.sid);
      assert.strictEqual(after.bySid.get(target.itemSid).strings.get('section'), 'shirt', `expected shirt after moving from ${startSection}`);
    }
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

test('setItemSection permits an item of unresolved kind into any documented slot (permissive fallback)', async (t) => {
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);
  const target = findGearCharacter();
  if (!target) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('no character with 2+ inventory items found'); }

  try {
    // NB: mutate and write the SAME parse — `records`/`bySid` point into `parsed`.
    const { parsed, records, bySid } = saveService.resolveCharacter(scratch.dir, target.platoonFile, target.sid);
    const itemSid = records.inventory.instances.map((ii) => ii.target).find((s) => { const r = bySid.get(s); return r && r.type === saveService.T.ITEM; });
    if (!itemSid) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('character has no item records'); }
    const itemRec = bySid.get(itemSid);
    // Corrupt the template reference so gamedataService.lookup() cannot
    // resolve it — this is the "unknown/unmapped typecode" case TODO.md 2.1
    // requires to stay permissive (never lock a modded item this editor has
    // never seen out of every slot).
    itemRec.strings.set('base data sid', '999999999-not-a-real-file.mod');
    itemRec.strings.set('section', 'main');
    fs.writeFileSync(path.join(scratch.dir, 'platoon', target.platoonFile), writeFile(parsed));

    const receipt = await mutation.mutate(scratch.dir, 'test: unresolved kind into hip',
      (staging) => saveService.setItemSection(staging, target.platoonFile, target.sid, itemSid, 'hip'));
    assert.strictEqual(receipt.rollbackStatus, 'not needed');

    const after = saveService.resolveCharacter(scratch.dir, target.platoonFile, target.sid);
    assert.strictEqual(after.bySid.get(itemSid).strings.get('section'), 'hip');
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

test('itemSlots.allowedSections always includes the item\'s own current section', (t) => {
  // 476-gamedata.base is Katana, a confirmed type-2 weapon template (TODO.md
  // 2.1's investigation dump) — its normal allowed set is hip/back/buckets,
  // which does NOT include "shirt". A current section of "shirt" must still
  // appear in the result, or an item stuck in an unexpected slot would become
  // impossible to move out of.
  const katanaSid = '476-gamedata.base';
  const tmpl = gamedata.lookup(katanaSid);
  if (!tmpl || tmpl.type !== 2) return t.skip('gamedata.base not resolvable on this machine (see AGENTS.md known paths)');

  const { sections } = itemSlots.allowedSections(katanaSid, 'shirt');
  assert.ok(sections.includes('shirt'), 'the item\'s own current section must always be included');
  assert.ok(sections.includes('hip') && sections.includes('back'), 'the normal typecode-2 slots must still be present');
  assert.ok(sections.includes('main') && sections.includes('backpack_content'), 'the storage buckets must still be present');
});

test('setItemSection moves an item into an empty slot, changing only that item', async (t) => {
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);
  const target = findGearCharacter();
  if (!target) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('no character with 2+ inventory items found'); }

  try {
    const relFile = path.join('platoon', target.platoonFile);
    const before = readFile(fs.readFileSync(path.join(scratch.dir, relFile)));

    const { bySid, records } = saveService.resolveCharacter(scratch.dir, target.platoonFile, target.sid);
    const itemSids = records.inventory.instances
      .map((ii) => ii.target)
      .filter((s) => { const r = bySid.get(s); return r && r.type === saveService.T.ITEM; });
    if (!itemSids.length) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('character has no item records'); }

    const usedSections = new Set(itemSids.map((s) => bySid.get(s).strings.get('section')));

    // Pick the first item/slot pair where the slot is BOTH unoccupied on this
    // character AND actually allowed for that item's kind (TODO.md 2.1 —
    // setItemSection() now enforces kind compatibility, so an arbitrary
    // unused slot is no longer guaranteed to be a legal move for an
    // arbitrary item).
    let itemSid = null; let targetSection = null;
    for (const s of itemSids) {
      const rec = bySid.get(s);
      const { sections } = itemSlots.allowedSections(rec.strings.get('base data sid'), asText(rec.strings.get('section') || ''));
      const candidate = sections.find((sec) => !itemSlots.BUCKET_SECTIONS.includes(sec) && !usedSections.has(sec));
      if (candidate) { itemSid = s; targetSection = candidate; break; }
    }
    if (!itemSid) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('no item/unused-slot pair is both available and compatible on this character'); }

    const otherSectionsBefore = new Map(itemSids.filter((s) => s !== itemSid).map((s) => [s, bySid.get(s).strings.get('section')]));

    const receipt = await mutation.mutate(scratch.dir, 'test: move item to empty slot',
      (staging) => saveService.setItemSection(staging, target.platoonFile, target.sid, itemSid, targetSection));

    assert.deepStrictEqual(receipt.changedFiles, [relFile]);
    assert.strictEqual(receipt.rollbackStatus, 'not needed');

    const after = readFile(fs.readFileSync(path.join(scratch.dir, relFile)));
    assert.strictEqual(after.records.length, before.records.length);

    const afterCtx = saveService.resolveCharacter(scratch.dir, target.platoonFile, target.sid);
    assert.strictEqual(afterCtx.bySid.get(itemSid).strings.get('section'), targetSection);

    // No other item's section changed.
    for (const [s, sectionBefore] of otherSectionsBefore) {
      assert.strictEqual(afterCtx.bySid.get(s).strings.get('section'), sectionBefore, `unexpected section change on ${s}`);
    }
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

test('setItemSection swaps into an occupied slot and flips the previous occupant back to main', async (t) => {
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);
  const target = findGearCharacter();
  if (!target) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('no character with 2+ inventory items found'); }

  try {
    const abs = path.join(scratch.dir, 'platoon', target.platoonFile);
    // NB: mutate and write the SAME parse — `records`/`bySid` point into `parsed`.
    const { parsed, records, bySid } = saveService.resolveCharacter(scratch.dir, target.platoonFile, target.sid);
    const itemSids = records.inventory.instances
      .map((ii) => ii.target)
      .filter((s) => { const r = bySid.get(s); return r && r.type === saveService.T.ITEM; });
    if (itemSids.length < 2) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('character has fewer than 2 item records'); }

    // The mover must actually be ALLOWED into a single-occupancy slot for the
    // collision/swap-back-to-main mechanic under test to apply at all now that
    // setItemSection() enforces kind compatibility (TODO.md 2.1) — pick the
    // first item whose allowedSections includes a non-bucket slot, and use
    // THAT slot as the collision target, rather than the fixed 'head'/'shirt'
    // this test used before compatibility existed (which happened to hit a
    // weapon on the live sample save and would now be correctly rejected).
    let moverSid = null; let targetSlot = null;
    for (const s of itemSids) {
      const rec = bySid.get(s);
      const { sections } = itemSlots.allowedSections(rec.strings.get('base data sid'), asText(rec.strings.get('section') || ''));
      const exclusive = sections.filter((sec) => !itemSlots.BUCKET_SECTIONS.includes(sec));
      if (exclusive.length) { moverSid = s; targetSlot = exclusive[0]; break; }
    }
    if (!moverSid) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('no item on this character is allowed into any single-occupancy slot'); }
    const occupantSid = itemSids.find((s) => s !== moverSid);
    const restSids = itemSids.filter((s) => s !== moverSid && s !== occupantSid);

    const mover = bySid.get(moverSid);
    const occupant = bySid.get(occupantSid);
    // Force a deterministic fixture: occupant holds the target slot, mover holds a different one.
    occupant.strings.set('section', targetSlot);
    mover.strings.set('section', 'main');
    const restSectionsBefore = new Map(restSids.map((s) => [s, bySid.get(s).strings.get('section')]));
    fs.writeFileSync(abs, writeFile(parsed));

    const beforeQty = { mover: mover.ints.get('quantity'), occupant: occupant.ints.get('quantity') };
    const beforeQuality = { mover: mover.floats.get('quality'), occupant: occupant.floats.get('quality') };

    const receipt = await mutation.mutate(scratch.dir, 'test: swap item into occupied slot',
      (staging) => saveService.setItemSection(staging, target.platoonFile, target.sid, moverSid, targetSlot));
    assert.strictEqual(receipt.rollbackStatus, 'not needed');

    const after = saveService.resolveCharacter(scratch.dir, target.platoonFile, target.sid);
    const afterMover = after.bySid.get(moverSid);
    const afterOccupant = after.bySid.get(occupantSid);
    assert.strictEqual(afterMover.strings.get('section'), targetSlot);
    assert.strictEqual(afterOccupant.strings.get('section'), 'main');

    // Exactly the two `section` strings changed — nothing else on either record.
    assert.strictEqual(afterMover.ints.get('quantity'), beforeQty.mover);
    assert.strictEqual(afterOccupant.ints.get('quantity'), beforeQty.occupant);
    assert.strictEqual(afterMover.floats.get('quality'), beforeQuality.mover);
    assert.strictEqual(afterOccupant.floats.get('quality'), beforeQuality.occupant);

    // And no other item on the character changed section.
    for (const [s, sectionBefore] of restSectionsBefore) {
      assert.strictEqual(after.bySid.get(s).strings.get('section'), sectionBefore, `unexpected section change on ${s}`);
    }
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

test('setItemSection rejects an invalid slot string and leaves the save byte-identical', async (t) => {
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);
  const target = findGearCharacter();
  if (!target) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('no character with 2+ inventory items found'); }

  try {
    const { records } = saveService.resolveCharacter(scratch.dir, target.platoonFile, target.sid);
    const itemSid = records.inventory.instances[0].target;

    const before = backups.hashDir(scratch.dir);
    await assert.rejects(
      mutation.mutate(scratch.dir, 'test: invalid section',
        (staging) => saveService.setItemSection(staging, target.platoonFile, target.sid, itemSid, 'not_a_real_slot')),
      /must be one of/,
    );
    assert.deepStrictEqual(backups.hashDir(scratch.dir), before);
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

test('setItemQuality sets level and quality on an item independently', async (t) => {
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);
  const target = findGearCharacter();
  if (!target) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('no character with 2+ inventory items found'); }

  try {
    const { records, bySid } = saveService.resolveCharacter(scratch.dir, target.platoonFile, target.sid);
    const itemSid = records.inventory.instances
      .map((ii) => ii.target)
      .find((s) => { const r = bySid.get(s); return r && r.ints.has('level') && r.floats.has('quality'); });
    if (!itemSid) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('no item with both level and quality fields found'); }

    // Set only level; quality must stay untouched.
    await mutation.mutate(scratch.dir, 'test: set item level',
      (staging) => saveService.setItemQuality(staging, target.platoonFile, target.sid, itemSid, { level: 60 }));
    let mid = saveService.resolveCharacter(scratch.dir, target.platoonFile, target.sid).bySid.get(itemSid);
    assert.strictEqual(mid.ints.get('level'), 60);
    const qualityAfterFirstWrite = mid.floats.get('quality');

    // Now set only quality; level must stay at the value from the previous write.
    await mutation.mutate(scratch.dir, 'test: set item quality',
      (staging) => saveService.setItemQuality(staging, target.platoonFile, target.sid, itemSid, { quality: 42 }));
    const after = saveService.resolveCharacter(scratch.dir, target.platoonFile, target.sid).bySid.get(itemSid);
    assert.strictEqual(after.floats.get('quality'), 42);
    assert.strictEqual(after.ints.get('level'), 60);
    assert.notStrictEqual(qualityAfterFirstWrite, undefined);
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

test('setItemSection rejects an item that does not belong to the given character', async (t) => {
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);
  const target = findGearCharacter();
  if (!target) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('no character with 2+ inventory items found'); }

  try {
    const before = backups.hashDir(scratch.dir);
    await assert.rejects(
      mutation.mutate(scratch.dir, 'test: item not owned',
        (staging) => saveService.setItemSection(staging, target.platoonFile, target.sid, 'not-a-real-sid--INGAME', 'head')),
      /not in character/,
    );
    assert.deepStrictEqual(backups.hashDir(scratch.dir), before);
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

/**
 * Find a gamedata item TEMPLATE of `type` (2/3/4) whose itemSlots resolution
 * is non-permissive (`widened: false`) and includes `section` — used so the
 * addItem() tests below exercise a real, non-fallback compatibility rule
 * rather than an arbitrary/unmapped one. Optionally require `stackable`.
 */
function findAddableTemplate(type, section, { stackable } = {}) {
  const templates = gamedata.itemTemplates().filter((t) => t.type === type);
  for (const t of templates) {
    if (stackable !== undefined && !!t.stackable !== stackable) continue;
    const { sections, widened } = itemSlots.allowedSections(t.sid, null);
    if (widened) continue;
    if (sections.includes(section)) return t;
  }
  return null;
}

test('addItem adds a new item to a character\'s inventory and round-trips', async (t) => {
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);
  const target = findGearCharacter();
  if (!target) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('no character with 2+ inventory items found'); }
  const tmpl = findAddableTemplate(4, 'main');
  if (!tmpl) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('no non-permissive type-4 template resolving to "main" found'); }

  try {
    const relFile = path.join('platoon', target.platoonFile);
    const beforeFile = readFile(fs.readFileSync(path.join(scratch.dir, relFile)));
    const { records: beforeRecords } = saveService.resolveCharacter(scratch.dir, target.platoonFile, target.sid);
    const bagSid = beforeRecords.inventory.sid;
    const beforeIds = new Set(beforeFile.records.map((r) => r.id));
    const beforeInstanceCount = beforeRecords.inventory.instances.length;

    const receipt = await mutation.mutate(scratch.dir, 'test: add item',
      (staging) => saveService.addItem(staging, target.platoonFile, target.sid, tmpl.sid, { section: 'main', quantity: 1 }));

    assert.deepStrictEqual(receipt.changedFiles, [relFile]);
    assert.strictEqual(receipt.rollbackStatus, 'not needed');
    const itemReceipt = receipt.receipts[0].item;
    assert.strictEqual(itemReceipt.templateSid, tmpl.sid);
    assert.strictEqual(itemReceipt.section, 'main');
    assert.strictEqual(itemReceipt.quantity, 1);

    const afterFile = readFile(fs.readFileSync(path.join(scratch.dir, relFile)));
    assert.strictEqual(afterFile.records.length, beforeFile.records.length + 1);

    // Every record except the touched INVENTORY record and the newly-appended
    // one is byte-for-byte identical to before — this also covers "every
    // OTHER character's inventory is untouched", since their INVENTORY/
    // CHAR_STATE/etc. records are ordinary entries in this same list.
    for (let i = 0; i < beforeFile.records.length; i++) {
      if (beforeFile.records[i].sid === bagSid) continue;
      assert.deepStrictEqual(afterFile.records[i], beforeFile.records[i], `record at index ${i} (sid ${beforeFile.records[i].sid}) unexpectedly changed`);
    }

    const newRec = afterFile.records[afterFile.records.length - 1];
    assert.strictEqual(newRec.type, saveService.T.ITEM);
    assert.strictEqual(asText(newRec.strings.get('base data sid')), tmpl.sid);
    assert.strictEqual(asText(newRec.strings.get('section')), 'main');
    assert.strictEqual(newRec.ints.get('quantity'), 1);
    assert.strictEqual(newRec.sid, itemReceipt.sid);
    assert.ok(!beforeIds.has(newRec.id), 'minted id collides with an existing id in this file');
    assert.ok(afterFile.header.nextId > beforeFile.header.nextId, 'header nextId did not advance');

    // The touched INVENTORY record: instanceCount matches instances.length,
    // and readPlatoon() now reports the item with correct fields.
    const { records: afterRecords } = saveService.resolveCharacter(scratch.dir, target.platoonFile, target.sid);
    assert.strictEqual(afterRecords.inventory.instanceCount, afterRecords.inventory.instances.length);
    assert.strictEqual(afterRecords.inventory.instances.length, beforeInstanceCount + 1);

    const { characters } = saveService.readPlatoon(path.join(scratch.dir, relFile));
    const character = characters.find((c) => c.sid === target.sid);
    const added = character.inventory.find((it) => it.sid === newRec.sid);
    assert.ok(added, 'readPlatoon() did not report the newly-added item');
    assert.strictEqual(added.base, tmpl.sid);
    assert.strictEqual(added.section, 'main');
    assert.strictEqual(added.quantity, 1);
    assert.strictEqual(added.level, 0);
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

test('addItem allows quantity > 1 on a stackable template and rejects it on a non-stackable one', async (t) => {
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);
  const target = findGearCharacter();
  if (!target) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('no character with 2+ inventory items found'); }
  const stackableTmpl = findAddableTemplate(4, 'main', { stackable: true });
  const weaponTmpl = findAddableTemplate(2, 'hip') || findAddableTemplate(2, 'back');
  if (!stackableTmpl || !weaponTmpl) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('no stackable type-4 or weapon template found'); }

  try {
    const receipt = await mutation.mutate(scratch.dir, 'test: add stackable item x5',
      (staging) => saveService.addItem(staging, target.platoonFile, target.sid, stackableTmpl.sid, { section: 'main', quantity: 5 }));
    assert.strictEqual(receipt.receipts[0].item.quantity, 5);

    const before = backups.hashDir(scratch.dir);
    await assert.rejects(
      mutation.mutate(scratch.dir, 'test: add non-stackable item x5',
        (staging) => saveService.addItem(staging, target.platoonFile, target.sid, weaponTmpl.sid,
          { section: itemSlots.allowedSections(weaponTmpl.sid, null).sections.find((s) => s !== 'main' && s !== 'backpack_content'), quantity: 5 })),
      /not stackable/,
    );
    assert.deepStrictEqual(backups.hashDir(scratch.dir), before);
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

test('addItem rejects an unresolvable template sid, save byte-identical', async (t) => {
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);
  const target = findGearCharacter();
  if (!target) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('no character with 2+ inventory items found'); }

  try {
    const before = backups.hashDir(scratch.dir);
    await assert.rejects(
      mutation.mutate(scratch.dir, 'test: add unresolvable template',
        (staging) => saveService.addItem(staging, target.platoonFile, target.sid, '999999999-not-a-real-file.mod', { section: 'main' })),
      /unresolvable item template/,
    );
    assert.deepStrictEqual(backups.hashDir(scratch.dir), before);
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

test('addItem rejects a template of the wrong typecode (not 2/3/4), save byte-identical', async (t) => {
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);
  const target = findGearCharacter();
  if (!target) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('no character with 2+ inventory items found'); }
  const grades = gamedata.weaponGrades();
  if (!grades.length) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('no weapon-grade ladder resolvable on this install'); }
  const companySid = grades[0].companySid; // a type-51 record — wrong typecode for an item template

  try {
    const before = backups.hashDir(scratch.dir);
    await assert.rejects(
      mutation.mutate(scratch.dir, 'test: add wrong-typecode template',
        (staging) => saveService.addItem(staging, target.platoonFile, target.sid, companySid, { section: 'main' })),
      /not an item template/,
    );
    assert.deepStrictEqual(backups.hashDir(scratch.dir), before);
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

// A weapon's grade is selected via `materialSid` (the grade IS the type-50
// material record). A caller reaching for an intuitive-but-wrong `grade:` key
// must not be silently ignored — that would quietly mint the default lowest
// grade ("Totally rusted junk") instead of the one asked for, and the save
// would look successfully written. Regression guard for exactly that.
test('addItem rejects an unknown option instead of silently ignoring it', async (t) => {
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);
  const target = findGearCharacter();
  if (!target) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('no character with 2+ inventory items found'); }
  const weaponTmpl = findAddableTemplate(2, 'hip') || findAddableTemplate(2, 'back');
  if (!weaponTmpl) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('no weapon template found'); }

  try {
    const before = backups.hashDir(scratch.dir);
    await assert.rejects(
      mutation.mutate(scratch.dir, 'test: add item with a misnamed grade option',
        (staging) => saveService.addItem(staging, target.platoonFile, target.sid, weaponTmpl.sid,
          { section: weaponTmpl.section, grade: 'whatever-grade-sid' })),
      /unknown option\(s\) grade/,
    );
    assert.deepStrictEqual(backups.hashDir(scratch.dir), before);
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

test('addItem rejects a section incompatible with the item\'s kind, save byte-identical', async (t) => {
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);
  const target = findGearCharacter();
  if (!target) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('no character with 2+ inventory items found'); }
  const weaponTmpl = findAddableTemplate(2, 'hip') || findAddableTemplate(2, 'back');
  if (!weaponTmpl) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('no weapon template found'); }

  try {
    const before = backups.hashDir(scratch.dir);
    await assert.rejects(
      mutation.mutate(scratch.dir, 'test: add weapon into head',
        (staging) => saveService.addItem(staging, target.platoonFile, target.sid, weaponTmpl.sid, { section: 'head' })),
      /cannot be added into slot/,
    );
    assert.deepStrictEqual(backups.hashDir(scratch.dir), before);
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

test('addItem rejects quantity 0, negative and non-integer, save byte-identical', async (t) => {
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);
  const target = findGearCharacter();
  if (!target) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('no character with 2+ inventory items found'); }
  const tmpl = findAddableTemplate(4, 'main');
  if (!tmpl) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('no non-permissive type-4 template resolving to "main" found'); }

  try {
    const before = backups.hashDir(scratch.dir);
    for (const bad of [0, -1, 1.5]) {
      await assert.rejects(
        mutation.mutate(scratch.dir, `test: add item quantity ${bad}`,
          (staging) => saveService.addItem(staging, target.platoonFile, target.sid, tmpl.sid, { section: 'main', quantity: bad })),
        /positive integer/,
        `expected rejection for quantity ${bad}`,
      );
    }
    assert.deepStrictEqual(backups.hashDir(scratch.dir), before);
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

test('addItem into an occupied single-occupancy slot displaces the prior occupant to main', async (t) => {
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);
  const target = findGearCharacter();
  if (!target) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('no character with 2+ inventory items found'); }
  const tmpl = findAddableTemplate(3, 'head');
  if (!tmpl) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('no non-permissive type-3 template resolving to "head" found'); }

  try {
    const abs = path.join(scratch.dir, 'platoon', target.platoonFile);
    // NB: mutate and write the SAME parse — `records`/`bySid` point into `parsed`.
    const { parsed, records, bySid } = saveService.resolveCharacter(scratch.dir, target.platoonFile, target.sid);
    const itemSids = records.inventory.instances
      .map((ii) => ii.target)
      .filter((s) => { const r = bySid.get(s); return r && r.type === saveService.T.ITEM; });
    if (!itemSids.length) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('character has no item records'); }
    const occupantSid = itemSids[0];
    const occupant = bySid.get(occupantSid);
    occupant.strings.set('section', 'head');
    fs.writeFileSync(abs, writeFile(parsed));

    const receipt = await mutation.mutate(scratch.dir, 'test: add item displaces occupant',
      (staging) => saveService.addItem(staging, target.platoonFile, target.sid, tmpl.sid, { section: 'head' }));
    assert.strictEqual(receipt.rollbackStatus, 'not needed');
    assert.deepStrictEqual(receipt.receipts[0].displaced, { sid: occupantSid, section: 'main' });

    const after = saveService.resolveCharacter(scratch.dir, target.platoonFile, target.sid);
    assert.strictEqual(asText(after.bySid.get(occupantSid).strings.get('section')), 'main');
    const newItemSid = receipt.receipts[0].item.sid;
    assert.strictEqual(asText(after.bySid.get(newItemSid).strings.get('section')), 'head');
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

test('a rejected edit leaves the save untouched', async (t) => {
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);

  try {
    const before = backups.hashDir(scratch.dir);
    await assert.rejects(
      mutation.mutate(scratch.dir, 'test: invalid money',
        (staging) => saveService.setPlayerMoney(staging, -5)),
      /integer between/,
    );
    assert.deepStrictEqual(backups.hashDir(scratch.dir), before);
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

// ---------------------------------------------------------- updateItem ----
//
// The Gear row's single "Apply" button calls this: slot, level, quality and
// quantity in ONE staged edit. `quantity` in particular had no mutation at all
// before — it could only be set when an item was first created, so the Gear
// page showed it as read-only text and "quantity didn't work".

test('updateItem sets quantity on a stackable item', async (t) => {
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);
  const found = findItemOfType(4); // trade goods: the stackable typecode
  if (!found) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('no trade-goods item found'); }

  try {
    const result = await mutation.mutate(scratch.dir, 'test: set quantity',
      (staging) => saveService.updateItem(staging, found.platoonFile, found.sid, found.itemSid, { quantity: 42 }));
    assert.deepStrictEqual(result.changedFiles, [path.join('platoon', found.platoonFile)]);

    const { bySid } = saveService.resolveCharacter(scratch.dir, found.platoonFile, found.sid);
    assert.strictEqual(bySid.get(found.itemSid).ints.get('quantity'), 42);
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

test('updateItem rejects quantity > 1 on a non-stackable item, save byte-identical', async (t) => {
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);
  const found = findItemOfType(2) || findItemOfType(3); // weapons/armour never stack
  if (!found) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('no weapon/armour item found'); }

  try {
    const before = backups.hashDir(scratch.dir);
    await assert.rejects(
      mutation.mutate(scratch.dir, 'test: stack a weapon',
        (staging) => saveService.updateItem(staging, found.platoonFile, found.sid, found.itemSid, { quantity: 5 })),
      /not stackable/,
    );
    assert.deepStrictEqual(backups.hashDir(scratch.dir), before);
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

test('updateItem rejects quantity 0, negative and non-integer, save byte-identical', async (t) => {
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);
  const found = findItemOfType(4);
  if (!found) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('no trade-goods item found'); }

  try {
    const before = backups.hashDir(scratch.dir);
    for (const bad of [0, -3, 2.5]) {
      await assert.rejects(
        mutation.mutate(scratch.dir, `test: quantity ${bad}`,
          (staging) => saveService.updateItem(staging, found.platoonFile, found.sid, found.itemSid, { quantity: bad })),
        /quantity must be a positive integer/,
      );
    }
    assert.deepStrictEqual(backups.hashDir(scratch.dir), before);
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

// The reason updateItem exists rather than the UI firing two requests: one
// mutation-gate pass, one backup, and no intermediate state on disk.
test('updateItem applies slot, level and quantity together in ONE staged edit', async (t) => {
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);
  const found = findItemOfType(4);
  if (!found) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('no trade-goods item found'); }

  try {
    const result = await mutation.mutate(scratch.dir, 'test: combined item edit',
      (staging) => saveService.updateItem(staging, found.platoonFile, found.sid, found.itemSid,
        { section: 'backpack_content', level: 7, quantity: 9 }));

    // ONE file touched, ONE backup, one receipt — not three separate writes.
    assert.deepStrictEqual(result.changedFiles, [path.join('platoon', found.platoonFile)]);
    assert.strictEqual(result.receipts.length, 1);

    const { bySid } = saveService.resolveCharacter(scratch.dir, found.platoonFile, found.sid);
    const rec = bySid.get(found.itemSid);
    assert.strictEqual(rec.strings.get('section'), 'backpack_content');
    assert.strictEqual(rec.ints.get('level'), 7);
    assert.strictEqual(rec.ints.get('quantity'), 9);
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

test('updateItem rejects an unknown field and an empty patch, save byte-identical', async (t) => {
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);
  const found = findItemOfType(4);
  if (!found) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('no trade-goods item found'); }

  try {
    const before = backups.hashDir(scratch.dir);
    await assert.rejects(
      mutation.mutate(scratch.dir, 'test: unknown field',
        (staging) => saveService.updateItem(staging, found.platoonFile, found.sid, found.itemSid, { qty: 5 })),
      /unknown field\(s\) qty/,
    );
    await assert.rejects(
      mutation.mutate(scratch.dir, 'test: empty patch',
        (staging) => saveService.updateItem(staging, found.platoonFile, found.sid, found.itemSid, {})),
      /provide at least one of/,
    );
    assert.deepStrictEqual(backups.hashDir(scratch.dir), before);
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

// Being able to choose "Meitou" when CREATING a weapon but not when editing
// one is the asymmetry that made the Gear page confusing. Grade is the
// (company sid, material sid) pair, and the two must move together.
test('updateItem re-grades a weapon, writing material and company sid together', async (t) => {
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);
  const found = findItemOfType(2);
  const grades = gamedata.weaponGrades();
  if (!found || !grades.length) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('no weapon item or no grade ladder'); }
  const top = grades[grades.length - 1];

  try {
    await mutation.mutate(scratch.dir, 'test: re-grade weapon',
      (staging) => saveService.updateItem(staging, found.platoonFile, found.sid, found.itemSid, { materialSid: top.modelSid }));

    const { bySid } = saveService.resolveCharacter(scratch.dir, found.platoonFile, found.sid);
    const rec = bySid.get(found.itemSid);
    assert.strictEqual(rec.strings.get('material sid'), top.modelSid);
    assert.strictEqual(rec.strings.get('company sid'), top.companySid, 'company sid must move with material sid');
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

test('updateItem takes a weapon\'s level from the grade, and an explicit level still wins', async (t) => {
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);
  const found = findItemOfType(2);
  const grades = gamedata.weaponGrades();
  if (!found || !grades.length) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('no weapon item or no grade ladder'); }

  // The Gear row's Grade select is the only weapon-quality control the UI has
  // now; there is no Weapon Level box to fill in beside it, so choosing a grade
  // has to write the level too or every re-graded weapon keeps a stale one.
  const { bySid: before } = saveService.resolveCharacter(scratch.dir, found.platoonFile, found.sid);
  const startLevel = before.get(found.itemSid).ints.get('level');
  const target = [...grades].sort((a, b) => b.rank - a.rank).find((g) => g.rank !== startLevel);
  if (!target) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('no grade whose rank differs from this weapon\'s level'); }

  try {
    const receipt = await mutation.mutate(scratch.dir, 'test: grade implies level',
      (staging) => saveService.updateItem(staging, found.platoonFile, found.sid, found.itemSid,
        { gradeId: target.id }));

    assert.strictEqual(receipt.receipts[0].after.levelFromGrade, true);
    const { bySid } = saveService.resolveCharacter(scratch.dir, found.platoonFile, found.sid);
    const rec = bySid.get(found.itemSid);
    assert.strictEqual(rec.ints.get('level'), target.rank, 'level should follow the grade\'s rank');
    assert.strictEqual(rec.strings.get('material sid'), target.modelSid);
    assert.strictEqual(rec.strings.get('company sid'), target.companySid);

    // Naming a level in the same call keeps the two fields independent — the
    // "More" panel's raw box, which is the one place a level is still typed.
    const other = [...grades].sort((a, b) => a.rank - b.rank).find((g) => g.id !== target.id);
    const receipt2 = await mutation.mutate(scratch.dir, 'test: grade plus explicit level',
      (staging) => saveService.updateItem(staging, found.platoonFile, found.sid, found.itemSid,
        { gradeId: other.id, level: 3 }));
    assert.strictEqual(receipt2.receipts[0].after.levelFromGrade, false);
    const { bySid: after2 } = saveService.resolveCharacter(scratch.dir, found.platoonFile, found.sid);
    assert.strictEqual(after2.get(found.itemSid).ints.get('level'), 3);
    assert.strictEqual(after2.get(found.itemSid).strings.get('company sid'), other.companySid);
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

test('updateItem rejects a grade on a non-weapon and an unknown grade sid, save byte-identical', async (t) => {
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);
  const armour = findItemOfType(3);
  const weapon = findItemOfType(2);
  if (!armour || !weapon) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('need one armour and one weapon item'); }

  try {
    const before = backups.hashDir(scratch.dir);
    await assert.rejects(
      mutation.mutate(scratch.dir, 'test: grade an armour',
        (staging) => saveService.updateItem(staging, armour.platoonFile, armour.sid, armour.itemSid, { materialSid: '913-gamedata.base' })),
      /is not a weapon/,
    );
    await assert.rejects(
      mutation.mutate(scratch.dir, 'test: bogus grade',
        (staging) => saveService.updateItem(staging, weapon.platoonFile, weapon.sid, weapon.itemSid, { materialSid: 'not-a-real-grade' })),
      /is not a known weapon grade/,
    );
    assert.deepStrictEqual(backups.hashDir(scratch.dir), before);
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

// ------------------------------------------------------------- restoring --

/**
 * Restore replaces a whole save directory, which makes it the most destructive
 * operation here — and it was the one write path with no gate on it at all. It
 * also used to delete the save before copying the backup in, so a failure in
 * between left the player with neither.
 */
test('restore puts a backup back over the save it came from', (t) => {
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);
  try {
    const before = backups.hashDir(scratch.dir);
    const backup = backups.create(scratch.dir, 'test: restore');

    fs.writeFileSync(path.join(scratch.dir, 'quick.save'), Buffer.from('clobbered', 'latin1'));
    assert.notDeepStrictEqual(backups.hashDir(scratch.dir), before);

    const receipt = backups.restore(backup.id);
    assert.strictEqual(receipt.restored, backup.id);
    assert.deepStrictEqual(backups.hashDir(scratch.dir), before, 'restore must reproduce the save exactly');
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

/**
 * The list payload is not the manifest.
 *
 * A manifest carries one SHA-256 per file of a whole save directory — 447 of
 * them here — and `GET /api/backups` was serialising all of it for every
 * backup: 1.5 MB of JSON to draw a 37-row table with no hash column in it. The
 * hashes still exist and restore() still verifies against them; they are just
 * not list data. If this fails, the Backups page is shipping megabytes again.
 */
test('a backup summary carries the file count, not the hashes', (t) => {
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);
  try {
    const manifest = backups.create(scratch.dir, 'test: summary');
    const files = Object.keys(manifest.hashes).length;
    assert.ok(files > 0, 'fixture should have files to hash');

    const summary = backups.summary(manifest);
    assert.strictEqual(summary.hashes, undefined, 'a summary must not carry the hash map');
    assert.strictEqual(summary.files, files);
    for (const key of ['id', 'label', 'saveName', 'createdAt']) {
      assert.strictEqual(summary[key], manifest[key], `summary lost ${key}`);
    }
    // The whole point: the summary is a fraction of the manifest's size.
    assert.ok(JSON.stringify(summary).length * 20 < JSON.stringify(manifest).length,
      'summary should be at least 20x smaller than the manifest');

    // And restore still has what it needs, read from disk rather than the list.
    assert.deepStrictEqual(backups.read(manifest.id).hashes, manifest.hashes);
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

test('a corrupt backup is refused, and the save it would have overwritten is untouched', (t) => {
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);
  try {
    const before = backups.hashDir(scratch.dir);
    const backup = backups.create(scratch.dir, 'test: corrupt');

    // Tamper with the backup's copy, not its manifest: the manifest hashes are
    // what prove the backup is still the save it claims to be.
    const inBackup = path.join(paths.backupRoot(), backup.id, 'save', 'quick.save');
    fs.writeFileSync(inBackup, Buffer.concat([fs.readFileSync(inBackup), Buffer.from([0])]));

    assert.throws(() => backups.restore(backup.id), /is corrupt/);
    assert.deepStrictEqual(backups.hashDir(scratch.dir), before, 'a refused restore must not touch the save');
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

test('restore leaves no staging directory beside the save', (t) => {
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);
  try {
    const backup = backups.create(scratch.dir, 'test: staging cleanup');
    backups.restore(backup.id);

    const siblings = fs.readdirSync(path.dirname(scratch.dir));
    const strays = siblings.filter((n) => n.startsWith('.restoring-') || n.startsWith('.replaced-'));
    assert.deepStrictEqual(strays, [], `restore left staging directories behind: ${strays.join(', ')}`);
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

/** Captures the error a synchronous call throws, so its `status` can be checked. */
function thrown(fn) {
  try { fn(); } catch (err) { return err; }
  return assert.fail('expected a throw, got none');
}

test('restoreBackup refuses an unknown backup id with 404', () => {
  const err = thrown(() => mutation.restoreBackup('no-such-backup-id'));
  assert.match(err.message, /no such backup/);
  assert.strictEqual(err.status, 404);
});

/**
 * A restore racing an in-flight edit would swap the directory out from under a
 * mutate() that has already hashed it, so the same one-at-a-time lock that
 * stops two edits overlapping has to cover restores too.
 */
test('restoreBackup refuses while an edit is in progress', async (t) => {
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);
  const backup = backups.create(scratch.dir, 'test: concurrency');
  let seen = null;
  try {
    await mutation.mutate(scratch.dir, 'test: hold the lock', (staging) => {
      seen = thrown(() => mutation.restoreBackup(backup.id));
      return saveService.setPlayerMoney(staging, 424242);
    });
    assert.match(seen.message, /another edit is in progress/);
    assert.strictEqual(seen.status, 409);
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

test('a dot-prefixed directory in the save root is never offered as a save', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kenshi-mkii-saveroot-'));
  try {
    for (const name of ['realsave', '.restoring-realsave-abc']) {
      fs.mkdirSync(path.join(root, name));
      fs.writeFileSync(path.join(root, name, 'quick.save'), Buffer.alloc(8));
    }
    paths.setOverrides({ saveRoot: root });
    assert.deepStrictEqual(paths.listSaves().map((s) => s.name), ['realsave']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});
