'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const paths = require('../services/pathService');
const fixture = require('./helpers/save-fixture');
const saveService = require('../services/saveService');
const mutation = require('../services/mutationService');
const loadouts = require('../services/loadouts');
const gamedata = require('../services/gamedataService');
const { readFile } = require('../services/kenshi/codec');

/**
 * The two bulk edits to gear a squad ALREADY owns: `regradeMany()` (set every
 * worn piece of armour to a tier, every weapon to a grade) and `unequipMany()`
 * (move worn items back to Carried).
 *
 * Same discipline as the other mutation suites — every write goes through
 * mutationService against a COPY of the fixture save, never the live one, and
 * the record COUNT is asserted unchanged: neither of these may ever mint or
 * drop an item, which is the one way they could differ from equipMany().
 */
const scratchSave = fixture.scratchSave;

// From the FIXTURE directory, never `saveService.status(name)` — that resolves
// the name against the player's live save folder, so the characters picked here
// would come from a world the scratch copy has never contained. See
// fixture.fixtureStatus().
const playerSquad = fixture.fixtureSquad;

function readCharacter(dir, platoonFile, sid) {
  const { characters } = saveService.readPlatoon(path.join(dir, 'platoon', platoonFile));
  return characters.find((c) => c.sid === sid) || null;
}

const ITEM = saveService.T.ITEM;
const countItems = (parsed) => parsed.records.filter((r) => r.type === ITEM).length;

/** Targets that between them wear at least one item of `kindType`. */
function wearersOf(squad, kindType, limit = 3) {
  return squad.characters
    .filter((c) => (c.inventory || []).some((it) => it.kindType === kindType
      && !saveService.ITEM_BUCKET_SLOTS.has(it.section)))
    .slice(0, limit);
}

/**
 * A named armour tier at least one of `picked`'s worn armour is NOT already on.
 * The fixture is a real save whose squad may already be in masterwork plate, and
 * "set them all to what they already are" is correctly rejected by the mutation
 * gate as a no-op — so a test that hardcodes 95 asserts the player's taste in
 * armour rather than this function's behaviour.
 */
function unusedArmourTier(picked) {
  const worn = picked.flatMap((c) => (c.inventory || [])
    .filter((it) => it.kindType === 3 && !saveService.ITEM_BUCKET_SLOTS.has(it.section)));
  return [95, 80, 60, 40, 20, 5].find((lvl) => worn.some((it) => it.level !== lvl)) ?? null;
}

// ------------------------------------------------------------ validation --

test('regradeMany refuses an empty or nonsensical request before opening a file', () => {
  assert.throws(() => saveService.regradeMany('/nowhere', { targets: [{ file: 'a.platoon', sid: 'x' }] }),
    /at least one of armourLevel/);
  assert.throws(() => saveService.regradeMany('/nowhere', { targets: [], armourLevel: 95 }),
    /targets must be a non-empty array/);
  assert.throws(() => saveService.regradeMany('/nowhere', { targets: [{ file: 'a.platoon', sid: 'x' }], armourLevel: -1 }),
    /armourLevel must be a non-negative integer/);
  assert.throws(() => saveService.regradeMany('/nowhere', { targets: [{ file: 'a.platoon', sid: 'x' }], armourLevel: 12.5 }),
    /armourLevel must be a non-negative integer/);
  // A typo in a grade id must not quietly fall back to the lowest rung and hand
  // a whole squad "Totally rusted junk".
  assert.throws(() => saveService.regradeMany('/nowhere', { targets: [{ file: 'a.platoon', sid: 'x' }], weaponGradeId: 'nope|nope' }),
    /not a known weapon grade id/);
  // Unknown fields are rejected, not ignored — a misnamed one would report
  // success while changing nothing the caller asked for.
  assert.throws(() => saveService.regradeMany('/nowhere', { targets: [{ file: 'a.platoon', sid: 'x' }], armorLevel: 95 }),
    /unknown field\(s\) armorLevel/);
});

test('unequipMany refuses a slot that is not an equip slot', () => {
  const target = [{ file: 'a.platoon', sid: 'x' }];
  assert.throws(() => saveService.unequipMany('/nowhere', { targets: target, sections: ['main'] }),
    /"main" is not an equip slot/);
  assert.throws(() => saveService.unequipMany('/nowhere', { targets: target, sections: ['nonsense'] }),
    /"nonsense" is not an equip slot/);
  assert.throws(() => saveService.unequipMany('/nowhere', { targets: target, sections: [] }),
    /sections, if given, must be a non-empty array/);
  assert.throws(() => saveService.unequipMany('/nowhere', { targets: target, slots: ['head'] }),
    /unknown field\(s\) slots/);
  // The two buckets are exactly the sections EQUIP_SECTIONS excludes.
  assert.deepStrictEqual(
    saveService.ITEM_SLOTS.filter((s) => !saveService.EQUIP_SECTIONS.includes(s)),
    ['main', 'backpack_content'],
  );
});

// ----------------------------------------------------------- regradeMany --

test('regradeMany sets every worn armour to one tier, in ONE staged edit', async (t) => {
  const squad = playerSquad();
  if (!squad) return t.skip('no player squad');
  const picked = wearersOf(squad, 3);
  if (!picked.length) return t.skip('nobody in the fixture wears armour');
  const tier = unusedArmourTier(picked);
  if (tier === null) return t.skip('every worn armour in the fixture is already on every tier');
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);

  try {
    const relFile = path.join('platoon', squad.file);
    const before = readFile(fs.readFileSync(path.join(scratch.dir, relFile)));

    const receipt = await mutation.mutate(scratch.dir, 'test: one armour tier',
      (staging) => saveService.regradeMany(staging, {
        targets: picked.map((c) => ({ file: squad.file, sid: c.sid })),
        armourLevel: tier,
      }));

    assert.deepStrictEqual(receipt.changedFiles, [relFile]);
    assert.strictEqual(receipt.rollbackStatus, 'not needed');

    const after = readFile(fs.readFileSync(path.join(scratch.dir, relFile)));
    // The whole point: this edits records, it never mints or drops one.
    assert.strictEqual(countItems(after), countItems(before), 'no item added or removed');
    assert.strictEqual(after.records.length, before.records.length);
    assert.strictEqual(after.header.nextId, before.header.nextId, 'no id minted');

    const r = receipt.receipts[0];
    assert.strictEqual(r.charactersTouched, picked.length);
    assert.ok(r.itemsChanged > 0);

    for (const c of picked) {
      const now = readCharacter(scratch.dir, squad.file, c.sid);
      const worn = now.inventory.filter((it) => !saveService.ITEM_BUCKET_SLOTS.has(it.section));
      for (const it of worn) {
        if (it.kindType === 3) assert.strictEqual(it.level, tier, `${it.name} should be on the requested tier`);
        // Nothing else was in scope, so nothing else moved tier.
        const was = c.inventory.find((o) => o.sid === it.sid);
        if (was && it.kindType !== 3) assert.strictEqual(it.level, was.level, `${it.name} is not armour and must be untouched`);
      }
      // Carried items are out of scope by default.
      for (const it of now.inventory.filter((x) => saveService.ITEM_BUCKET_SLOTS.has(x.section))) {
        const was = c.inventory.find((o) => o.sid === it.sid);
        if (was) assert.strictEqual(it.level, was.level, 'a carried item must not be touched without includeCarried');
      }
    }
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

test('regradeMany writes a weapon grade as the (company, material) PAIR, and brings its level with it', async (t) => {
  const squad = playerSquad();
  if (!squad) return t.skip('no player squad');
  const picked = wearersOf(squad, 2);
  if (!picked.length) return t.skip('nobody in the fixture carries a weapon in a weapon slot');
  const grades = gamedata.weaponGrades();
  if (!grades.length) return t.skip('this install has no weapon grade ladder');
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);

  // The grade must be one whose rank differs from what the weapons are already
  // on, or this asserts nothing: an earlier version of this test picked Edge
  // Type 5 (rank 80) against a fixture whose weapons were already at level 80,
  // so it passed identically whether the level moved with the grade or not.
  const worn = picked.flatMap((c) => (c.inventory || [])
    .filter((it) => it.kindType === 2 && !saveService.ITEM_BUCKET_SLOTS.has(it.section)));
  const target = [...grades].sort((a, b) => b.rank - a.rank)
    .find((g) => worn.some((it) => it.level !== g.rank));
  if (!target) return t.skip('every worn weapon already sits on every rank this ladder has');

  try {
    const receipt = await mutation.mutate(scratch.dir, 'test: regrade weapons',
      (staging) => saveService.regradeMany(staging, {
        targets: picked.map((c) => ({ file: squad.file, sid: c.sid })),
        weaponGradeId: target.id,
      }));

    assert.strictEqual(receipt.receipts[0].grade.id, target.id);
    // The receipt says the level came from the grade rather than the caller —
    // the UI no longer offers a Weapon Level box, so this is what it reports.
    assert.strictEqual(receipt.receipts[0].weaponLevelFromGrade, true);
    assert.strictEqual(receipt.receipts[0].weaponLevel, target.rank);

    for (const c of picked) {
      const now = readCharacter(scratch.dir, squad.file, c.sid);
      for (const it of now.inventory.filter((x) => !saveService.ITEM_BUCKET_SLOTS.has(x.section))) {
        const was = c.inventory.find((o) => o.sid === it.sid);
        if (it.kindType === 2) {
          assert.strictEqual(it.gradeId, target.id, `${it.name} should carry the whole pair`);
          assert.strictEqual(it.materialSid, target.modelSid);
          assert.strictEqual(it.companySid, target.companySid);
          // `level` and the pair are still two independent FIELDS; what changed
          // is that a grade chosen without a level now supplies one, from the
          // ladder row's own rank. See itemFactory.defaultLevelForGrade().
          assert.strictEqual(it.level, target.rank,
            `${it.name} should sit at the grade's own rank`);
        } else if (was) {
          assert.strictEqual(it.materialSid, was.materialSid, `${it.name} is not a weapon and must keep its material`);
          // A crossbow (107) takes a level but has no manufacturer ladder, so a
          // grade says nothing about it and must not move it.
          if (it.kindType === 107) assert.strictEqual(it.level, was.level, `${it.name} has no grade ladder`);
        }
      }
    }
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

test('an explicit weaponLevel still wins over the one the grade implies', async (t) => {
  const squad = playerSquad();
  if (!squad) return t.skip('no player squad');
  const picked = wearersOf(squad, 2, 1);
  if (!picked.length) return t.skip('nobody in the fixture carries a weapon in a weapon slot');
  const grades = gamedata.weaponGrades();
  const target = grades.find((g) => g.id === loadouts.GRADE.meitou)
    || [...grades].sort((a, b) => b.rank - a.rank)[0];
  if (!target) return t.skip('this install has no weapon grade ladder');
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);

  // Deliberately NOT the grade's rank: the two fields stay independent, and a
  // caller that names a level is not overruled by the grade it chose alongside.
  const explicit = target.rank === 7 ? 9 : 7;

  try {
    const receipt = await mutation.mutate(scratch.dir, 'test: grade plus explicit level',
      (staging) => saveService.regradeMany(staging, {
        targets: picked.map((c) => ({ file: squad.file, sid: c.sid })),
        weaponGradeId: target.id,
        weaponLevel: explicit,
      }));

    assert.strictEqual(receipt.receipts[0].weaponLevelFromGrade, false);
    assert.strictEqual(receipt.receipts[0].weaponLevel, explicit);

    for (const c of picked) {
      const now = readCharacter(scratch.dir, squad.file, c.sid);
      for (const it of now.inventory.filter((x) => x.kindType === 2
        && !saveService.ITEM_BUCKET_SLOTS.has(x.section))) {
        assert.strictEqual(it.level, explicit, `${it.name} should keep the level the caller named`);
        assert.strictEqual(it.gradeId, target.id);
      }
    }
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

test('regradeMany reports no-op as the mutation gate rejecting it, never as success', async (t) => {
  const squad = playerSquad();
  if (!squad) return t.skip('no player squad');
  const picked = wearersOf(squad, 3, 1);
  if (!picked.length) return t.skip('nobody in the fixture wears armour');
  const tier = unusedArmourTier(picked);
  if (tier === null) return t.skip('every worn armour in the fixture is already on every tier');
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);

  try {
    const targets = picked.map((c) => ({ file: squad.file, sid: c.sid }));
    await mutation.mutate(scratch.dir, 'test: first pass',
      (staging) => saveService.regradeMany(staging, { targets, armourLevel: tier }));
    // Second identical pass changes nothing, so there is nothing to write.
    await assert.rejects(
      mutation.mutate(scratch.dir, 'test: second pass',
        (staging) => saveService.regradeMany(staging, { targets, armourLevel: tier })),
      /edit produced no change/,
    );
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

// ----------------------------------------------------------- unequipMany --

test('unequipMany strips every worn item to Carried and moves no record', async (t) => {
  const squad = playerSquad();
  if (!squad) return t.skip('no player squad');
  const picked = squad.characters
    .filter((c) => (c.inventory || []).some((it) => !saveService.ITEM_BUCKET_SLOTS.has(it.section)))
    .slice(0, 3);
  if (!picked.length) return t.skip('nobody in the fixture has anything equipped');
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);

  try {
    const relFile = path.join('platoon', squad.file);
    const before = readFile(fs.readFileSync(path.join(scratch.dir, relFile)));

    const receipt = await mutation.mutate(scratch.dir, 'test: strip',
      (staging) => saveService.unequipMany(staging, {
        targets: picked.map((c) => ({ file: squad.file, sid: c.sid })),
      }));

    const after = readFile(fs.readFileSync(path.join(scratch.dir, relFile)));
    assert.strictEqual(countItems(after), countItems(before), 'unequip never adds or drops an item');
    assert.strictEqual(after.header.nextId, before.header.nextId);

    const r = receipt.receipts[0];
    assert.strictEqual(r.charactersTouched, picked.length);
    assert.ok(r.itemsMoved > 0);

    for (const c of picked) {
      const now = readCharacter(scratch.dir, squad.file, c.sid);
      assert.strictEqual(now.inventory.filter((it) => !saveService.ITEM_BUCKET_SLOTS.has(it.section)).length, 0,
        `${now.name} should have nothing equipped`);
      // Every item still belongs to them; the count is what proves nothing was
      // "unequipped" by deletion.
      assert.strictEqual(now.inventory.length, c.inventory.length);
      for (const m of r.characters.find((x) => x.sid === c.sid).moved) {
        assert.strictEqual(m.to, 'main');
      }
    }
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

test('unequipMany with a section filter takes off that slot and nothing else', async (t) => {
  const squad = playerSquad();
  if (!squad) return t.skip('no player squad');
  // A slot at least two characters are wearing something in, so this is
  // genuinely the "one item, many characters" case.
  const bySlot = new Map();
  for (const c of squad.characters) {
    for (const it of c.inventory || []) {
      if (saveService.ITEM_BUCKET_SLOTS.has(it.section)) continue;
      if (!bySlot.has(it.section)) bySlot.set(it.section, []);
      bySlot.get(it.section).push(c);
    }
  }
  const hit = [...bySlot.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  if (!hit) return t.skip('nobody in the fixture has anything equipped');
  const [slot, wearers] = hit;
  const picked = wearers.slice(0, 4);
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);

  try {
    await mutation.mutate(scratch.dir, `test: unequip ${slot}`,
      (staging) => saveService.unequipMany(staging, {
        targets: picked.map((c) => ({ file: squad.file, sid: c.sid })),
        sections: [slot],
      }));

    for (const c of picked) {
      const now = readCharacter(scratch.dir, squad.file, c.sid);
      assert.strictEqual(now.inventory.filter((it) => it.section === slot).length, 0,
        `${now.name} should have an empty ${slot}`);
      // Every other slot is exactly as it was.
      for (const was of c.inventory) {
        if (was.section === slot || saveService.ITEM_BUCKET_SLOTS.has(was.section)) continue;
        const still = now.inventory.find((it) => it.sid === was.sid);
        assert.strictEqual(still.section, was.section, `${was.name} must stay in ${was.section}`);
      }
    }
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

test('unequipMany with itemSids touches exactly that one item', async (t) => {
  const squad = playerSquad();
  if (!squad) return t.skip('no player squad');
  const owner = squad.characters.find((c) => (c.inventory || [])
    .filter((it) => !saveService.ITEM_BUCKET_SLOTS.has(it.section)).length >= 2);
  if (!owner) return t.skip('nobody in the fixture wears two items');
  const one = owner.inventory.find((it) => !saveService.ITEM_BUCKET_SLOTS.has(it.section));
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);

  try {
    const receipt = await mutation.mutate(scratch.dir, 'test: unequip one',
      (staging) => saveService.unequipMany(staging, {
        targets: [{ file: squad.file, sid: owner.sid }],
        itemSids: [one.sid],
      }));

    assert.strictEqual(receipt.receipts[0].itemsMoved, 1);
    const now = readCharacter(scratch.dir, squad.file, owner.sid);
    assert.strictEqual(now.inventory.find((it) => it.sid === one.sid).section, 'main');
    for (const was of owner.inventory) {
      if (was.sid === one.sid) continue;
      assert.strictEqual(now.inventory.find((it) => it.sid === was.sid).section, was.section);
    }
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});
