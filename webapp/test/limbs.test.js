'use strict';

/**
 * `ints.limbs` — the encoding, and the write path over it.
 *
 * The encoding is four 2-bit fields over MEDICAL part slots 3,4,5,6 (0 own,
 * 1 lost, 2 robotic), derived from every MEDICAL record in every save on the
 * machine it was written on: 4995 records, 88 with the key, eight distinct
 * values, no field ever reading 3. `saveService.limbStateOf()` carries the
 * full derivation.
 *
 * The corpus itself cannot be a test — it is the player's saves, which the
 * suite is not allowed to read (test/helpers/save-fixture.js). So what is
 * pinned here is the encoding's own arithmetic against the observed values,
 * plus a real round trip through the mutation gate on a COPY of the fixture.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const saveService = require('../services/saveService');
const mutation = require('../services/mutationService');
const { readFile } = require('../services/kenshi/codec');
const fixture = require('./helpers/save-fixture');

const { LIMB_SLOTS, limbStateOf, encodeLimbs } = saveService;

// The eight values actually observed in the corpus, with what each decodes to.
// If a future Kenshi build writes something these do not explain, the decode
// is what has to be re-derived — this table is the record of what it was
// derived FROM.
const OBSERVED = [
  [1, ['lost', 'own', 'own', 'own'], 28],
  [4, ['own', 'lost', 'own', 'own'], 2],
  [5, ['lost', 'lost', 'own', 'own'], 2],
  [16, ['own', 'own', 'lost', 'own'], 29],
  [64, ['own', 'own', 'own', 'lost'], 23],
  [65, ['lost', 'own', 'own', 'lost'], 1],
  [68, ['own', 'lost', 'own', 'lost'], 2],
  [169, ['lost', 'robotic', 'robotic', 'robotic'], 1],
];

test('every value observed in the corpus decodes to one state per limb', () => {
  for (const [value, expected] of OBSERVED) {
    const got = [0, 1, 2, 3].map((k) => limbStateOf(value, k));
    assert.deepEqual(got, expected, `limbs=${value} (0b${value.toString(2).padStart(8, '0')})`);
    // No field may read the fourth, unexplained value — a wrong split would
    // produce one almost immediately, so this is the encoding's own canary.
    assert.ok(!got.includes('unknown'), `limbs=${value} decoded an undefined state`);
  }
});

test('encode is the exact inverse of decode', () => {
  for (const [value, expected] of OBSERVED) {
    const states = Object.fromEntries(LIMB_SLOTS.map((slot, k) => [slot, expected[k]]));
    assert.equal(encodeLimbs(states), value, `re-encoding ${expected.join('/')}`);
  }
  // The absent key and an all-own record are the same state, which is why
  // setLimbs() deletes rather than writing 0.
  assert.equal(encodeLimbs({}), 0);
  assert.deepEqual([0, 1, 2, 3].map((k) => limbStateOf(null, k)), ['own', 'own', 'own', 'own']);
});

test('encodeLimbs refuses a state it cannot write', () => {
  assert.throws(() => encodeLimbs({ 3: 'bionic' }), /must be one of/);
});

/** First player squad file + first character in it, from the FIXTURE. */
function firstPlayerCharacter() {
  const st = fixture.fixtureStatus();
  if (!st) return null;
  const squad = st.squads.find((q) => q.characters.length);
  if (!squad) return null;
  return { platoonFile: squad.file, sid: squad.characters[0].sid, name: squad.characters[0].name };
}

const medicalOf = (dir, relFile, sid) => {
  const parsed = readFile(fs.readFileSync(path.join(dir, relFile)));
  const chars = saveService.readPlatoon(path.join(dir, relFile)).characters;
  const c = chars.find((x) => x.sid === sid);
  return { parsed, medical: c ? c.medical : null };
};

test('setLimbs writes a prosthetic, and restoring every limb removes the key', async (t) => {
  const scratch = fixture.scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);
  const target = firstPlayerCharacter();
  if (!target) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('no player character found'); }
  const relFile = path.join('platoon', target.platoonFile);

  try {
    const start = medicalOf(scratch.dir, relFile, target.sid);
    assert.equal(start.medical.limbs, null, 'fixture character starts with no limbs key');
    for (const p of start.medical.parts) {
      assert.equal(p.limbState, LIMB_SLOTS.includes(p.index) ? 'own' : null,
        'a record with no key reads as four intact limbs, and non-limbs have no state at all');
    }

    // Lose the left arm, replace the right one — Beep's shape, which is the
    // case this feature exists for.
    const receipt = await mutation.mutate(scratch.dir, 'test: limbs',
      (staging) => saveService.setLimbs(staging, target.platoonFile, target.sid, {
        states: { 3: 'lost', 4: 'robotic' },
        flesh: { 3: -100 },
      }));
    assert.equal(receipt.changedFiles.length, 1);

    const after = medicalOf(scratch.dir, relFile, target.sid);
    // 'lost' in field 0 (=1) + 'robotic' in field 1 (=2<<2=8).
    assert.equal(after.medical.limbs, 9);
    const byIndex = new Map(after.medical.parts.map((p) => [p.index, p]));
    assert.equal(byIndex.get(3).limbState, 'lost');
    assert.equal(byIndex.get(4).limbState, 'robotic');
    assert.equal(byIndex.get(5).limbState, 'own');
    assert.equal(byIndex.get(6).limbState, 'own');
    assert.equal(Math.round(byIndex.get(3).current), -100, 'flesh went with the state');
    assert.equal(byIndex.get(4).current, start.medical.parts.find((p) => p.index === 4).current,
      'a limb whose flesh was not named is left exactly as it was');

    // Putting every limb back leaves a record shaped like one that never lost
    // any: the key is gone, not zeroed.
    await mutation.mutate(scratch.dir, 'test: limbs restored',
      (staging) => saveService.setLimbs(staging, target.platoonFile, target.sid, {
        states: { 3: 'own', 4: 'own' },
        flesh: { 3: 100 },
      }));
    const restored = medicalOf(scratch.dir, relFile, target.sid);
    assert.equal(restored.medical.limbs, null, 'all-own deletes the key rather than writing 0');
    // Straight off the record, not through the model: a `limbs: 0` would read
    // as null above too, and 0 is exactly what must NOT be on disk.
    const withKey = restored.parsed.records.filter((r) => r.type === 57 && r.ints.has('limbs'));
    assert.equal(withKey.length, 0, 'no medical record in the file carries a limbs key any more');
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
  }
});

test('every robotic limb template resolves to the body part it fits', () => {
  const limbs = require('../services/gamedataService').limbTemplates();
  if (!limbs.length) return; // no Kenshi install readable here
  // 50/51/52/53 = left arm / right arm / left leg / right leg, which is parts
  // 3/4/5/6 in MEDICAL order. A template whose side cannot be resolved would
  // be offered for the wrong limb, so none may be null.
  const sideless = limbs.filter((l) => l.partIndex === null);
  assert.deepEqual(sideless.map((l) => l.name), [],
    'a limb with no resolvable slot — check the load-order merge in gamedataService.build()');
  for (const l of limbs) {
    assert.ok(LIMB_SLOTS.includes(l.partIndex), `${l.name} -> part ${l.partIndex}`);
    assert.equal(l.partIndex, { 50: 3, 51: 4, 52: 5, 53: 6 }[l.slot]);
  }
});

test('fitting a prosthetic writes the state and the limb in one edit', async (t) => {
  const scratch = fixture.scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);
  const target = firstPlayerCharacter();
  if (!target) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('no player character found'); }
  const limbs = require('../services/gamedataService').limbTemplates();
  const leftArm = limbs.find((l) => l.partIndex === 3);
  if (!leftArm) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('no left-arm limb in this install'); }
  const relFile = path.join('platoon', target.platoonFile);

  try {
    const receipt = await mutation.mutate(scratch.dir, 'test: fit a limb',
      (staging) => saveService.setLimbs(staging, target.platoonFile, target.sid, {
        states: { 3: 'robotic' },
        install: { 3: { templateSid: leftArm.sid, level: 80 } },
      }));
    assert.equal(receipt.changedFiles.length, 1, 'the state and the item are ONE staged edit');

    const after = medicalOf(scratch.dir, relFile, target.sid);
    assert.equal(after.medical.parts.find((p) => p.index === 3).limbState, 'robotic');

    const chars = saveService.readPlatoon(path.join(scratch.dir, relFile)).characters;
    const inv = chars.find((c) => c.sid === target.sid).inventory || [];
    const fitted = inv.find((it) => it.base === leftArm.sid);
    assert.ok(fitted, `${leftArm.name} is in the character's inventory`);
    assert.equal(fitted.level, 80, 'the quality the caller chose');
    assert.equal(fitted.section, 'main', 'carried — no save has ever held one in an equip slot');
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
  }
});

test('a limb can only be fitted to the part it belongs to, and only to a prosthetic', async (t) => {
  const scratch = fixture.scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);
  const target = firstPlayerCharacter();
  if (!target) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('no player character found'); }
  const limbs = require('../services/gamedataService').limbTemplates();
  const leftArm = limbs.find((l) => l.partIndex === 3);
  if (!leftArm) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('no left-arm limb in this install'); }
  const relFile = path.join('platoon', target.platoonFile);

  try {
    const before = fs.readFileSync(path.join(scratch.dir, relFile));
    // A left arm onto the left leg.
    await assert.rejects(() => mutation.mutate(scratch.dir, 'test: wrong limb',
      (staging) => saveService.setLimbs(staging, target.platoonFile, target.sid, {
        states: { 5: 'robotic' }, install: { 5: { templateSid: leftArm.sid } },
      })), /fits part 3/);
    // A limb onto a part that is staying flesh and blood.
    await assert.rejects(() => mutation.mutate(scratch.dir, 'test: not robotic',
      (staging) => saveService.setLimbs(staging, target.platoonFile, target.sid, {
        states: { 3: 'lost' }, install: { 3: { templateSid: leftArm.sid } },
      })), /must be set to "robotic"/);
    // Something that is not a limb template at all.
    await assert.rejects(() => mutation.mutate(scratch.dir, 'test: not a limb',
      (staging) => saveService.setLimbs(staging, target.platoonFile, target.sid, {
        states: { 3: 'robotic' }, install: { 3: { templateSid: 'not-a-real-sid' } },
      })), /not a robotic limb template/);

    assert.ok(before.equals(fs.readFileSync(path.join(scratch.dir, relFile))),
      'every refusal left the platoon file byte-identical');
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
  }
});

test('setLimbs refuses a part that is not a limb, and writes nothing', async (t) => {
  const scratch = fixture.scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);
  const target = firstPlayerCharacter();
  if (!target) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('no player character found'); }
  const relFile = path.join('platoon', target.platoonFile);

  try {
    const before = fs.readFileSync(path.join(scratch.dir, relFile));
    for (const bad of [{ states: { 1: 'lost' } }, { states: { 3: 'gone' } }, {}]) {
      await assert.rejects(() => mutation.mutate(scratch.dir, 'test: bad limbs',
        (staging) => saveService.setLimbs(staging, target.platoonFile, target.sid, bad)));
    }
    assert.ok(before.equals(fs.readFileSync(path.join(scratch.dir, relFile))),
      'a refused edit leaves the platoon file byte-identical');
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
  }
});
