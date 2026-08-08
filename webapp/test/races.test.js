'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const paths = require('../services/pathService');
const fixture = require('./helpers/save-fixture');
const races = require('../services/racesService');
const saveService = require('../services/saveService');
const gamedata = require('../services/gamedataService');
const { readFile, writeFile } = require('../services/kenshi/codec');
const { asText } = require('../services/kenshi/binary');

/**
 * Races: the type-7 catalogue, and switching a character from one to another.
 *
 * The load-bearing claim this whole feature rests on is that a race's
 * `extra['combat anatomy']` IS the character's MEDICAL body plan — same body
 * parts, and `hit<n>` equal to the row's `v0`. That is falsifiable against every
 * character in a save, so the first test does exactly that, and it is the one to
 * look at first if a Kenshi or mod update breaks this feature.
 *
 * setRace() returns bytes rather than writing them (the setPlayerMoney
 * contract), so the write path is tested in memory without the mutation gate.
 */
const hasInstall = !!paths.installDir();
const save = fixture.fixtureSave();

const T = { SQUAD: 30, MEDICAL: 57, APPEARANCE: 66 };

/** Every character in the fixture, with its race row and MEDICAL record. */
function everyCharacter(dir) {
  const out = [];
  const pdir = path.join(dir, 'platoon');
  if (!fs.existsSync(pdir)) return out;
  for (const file of fs.readdirSync(pdir).filter((f) => f.endsWith('.platoon')).sort()) {
    let parsed;
    try { parsed = readFile(fs.readFileSync(path.join(pdir, file))); } catch { continue; }
    const bySid = new Map(parsed.records.map((r) => [r.sid, r]));
    const squad = parsed.records.find((r) => r.type === T.SQUAD);
    if (!squad) continue;
    for (const inst of squad.instances) {
      const states = inst.states.map((s) => bySid.get(s)).filter(Boolean);
      const appearance = states.find((r) => r.type === T.APPEARANCE);
      const medical = states.find((r) => r.type === T.MEDICAL);
      const row = appearance && (appearance.extra.get('race') || [])[0];
      if (!row || !row.target || !medical) continue;
      out.push({ file, sid: inst.id, raceSid: row.target, appearance, medical });
    }
  }
  return out;
}

/** A character's MEDICAL body plan as `[{ sid, hit, flesh }]`, slot order preserved. */
function planOf(medical) {
  const plan = [];
  for (let i = 0; medical.strings.has(`sid${i}`); i++) {
    plan.push({
      sid: asText(medical.strings.get(`sid${i}`)),
      hit: medical.floats.get(`hit${i}`),
      flesh: medical.floats.get(`flesh${i}`),
    });
  }
  return plan;
}

// ---------------------------------------------------------------- catalogue --

test('race names are resolved in LOAD ORDER, not first-definition-wins', { skip: !hasInstall && 'no Kenshi install found' }, () => {
  // This is the finding that made the feature worth building. Both sids are
  // defined ~20 times across this install's data; the base file calls them
  // "Human" and "Sundemon", and the running game — and the player, and the
  // wiki — use rebirth.mod's names.
  //
  // This test used to also assert that `gamedataService.nameOf()` still
  // returned the BASE name, as the contrast that made the point. It no longer
  // does, and that is the fix rather than a regression: the flat index resolves
  // display names in load order now too (483 of 62624 sids are renamed by a
  // later definition, and the grade ladder shipping "Edge Type 5" was the same
  // bug). So the two must now AGREE, which is what is asserted instead —
  // `racesService` remains the right call for a race because it also carries
  // the anatomy and the collision-suffixed label, not because it is the only
  // one that knows the name.
  const cases = [
    { sid: '17-gamedata.quack', resolved: 'Greenlander' },
    { sid: '18019-gamedata.base', resolved: 'Scorchlander' },
  ];
  for (const c of cases) {
    const race = races.raceBySid(c.sid);
    if (!race) continue; // a different install may not carry this sid at all
    assert.equal(race.name, c.resolved,
      `${c.sid}: load order should resolve this to "${c.resolved}", the name the game shows`);
    assert.equal(gamedata.nameOf(c.sid), race.name,
      `${c.sid}: the flat index resolves names in load order too now — the two must agree`);
    assert.ok(race.definitions > 1, `${c.sid}: expected several definitions, got ${race.definitions}`);
  }
});

test('combat anatomy is unioned across definitions, not replaced', { skip: !hasInstall && 'no Kenshi install found' }, () => {
  // rebirth.mod re-defines Scorchlander carrying ONE anatomy row — Right Arm,
  // which is exactly the limb that makes a Scorchlander not a Greenlander.
  // Last-definition-replaces-the-list would give the race a one-limbed body.
  const scorch = races.raceBySid('18019-gamedata.base');
  const green = races.raceBySid('17-gamedata.quack');
  if (!scorch || !green) return;

  assert.equal(scorch.anatomy.length, 7, 'Scorchlander should have all seven parts, not just the overridden one');
  assert.equal(green.anatomy.length, 7);

  const armOf = (r) => r.anatomy.find((p) => p.sid === '29-gamedata.quack');
  assert.equal(armOf(green).hit, 40, 'Greenlander right arm comes from gamedata.base');
  assert.equal(armOf(scorch).hit, 60, "Scorchlander right arm comes from rebirth.mod's single-row override");

  // Everything the override did NOT mention must survive it.
  for (const part of green.anatomy) {
    if (part.sid === '29-gamedata.quack') continue;
    const other = scorch.anatomy.find((p) => p.sid === part.sid);
    assert.ok(other, `Scorchlander lost body part ${part.name}`);
    assert.equal(other.hit, part.hit, `${part.name} should be untouched by the Right Arm override`);
  }
});

test('an INT32_MAX anatomy row removes a body part rather than setting one', { skip: !hasInstall && 'no Kenshi install found' }, () => {
  // "Unofficial Patches for Kenshi.mod" re-defines Goat with four rows: two
  // forelegs at 100, and Left/Right Arm at 2147483647. Live goats have seven
  // parts — the base seven, minus the arms, plus the forelegs.
  const goat = races.raceBySid('3992-gamedata.base');
  if (!goat || goat.name !== 'Goat') return;
  assert.equal(goat.anatomy.length, 7, 'the sentinel rows should be dropped, not counted');
  const names = goat.anatomy.map((p) => p.name).sort();
  assert.ok(!names.includes('Left Arm') && !names.includes('Right Arm'),
    `a patched Goat should have no arms, got ${names.join(', ')}`);
  assert.ok(names.includes('Left Foreleg') && names.includes('Right Foreleg'));
  for (const part of goat.anatomy) {
    assert.notEqual(part.hit, races.REMOVED);
    assert.notEqual(part.max, races.REMOVED);
  }
});

test('a Left Foreleg can stand in for a Left Arm, and nothing can stand in for a Head', { skip: !hasInstall && 'no Kenshi install found' }, () => {
  // Same `body part type` and `collapse part`, same bones — they are the same
  // slot under two names, which is what lets a human->animal switch map.
  assert.equal(races.partsInterchangeable('28-gamedata.quack', '4019-gamedata.base'), true);
  assert.equal(races.partsInterchangeable('29-gamedata.quack', '4018-gamedata.base'), true);
  assert.equal(races.partsInterchangeable('28-gamedata.quack', '32-gamedata.quack'), false);
  assert.equal(races.partsInterchangeable('28-gamedata.quack', '4018-gamedata.base'), false,
    'a LEFT arm must not take a RIGHT foreleg — the collapse-part bitmask is what keeps the sides apart');
});

// -------------------------------------------------------------- the claim --

test("a race's combat anatomy IS the body plan of every character of that race",
  { skip: (!hasInstall && 'no Kenshi install found') || (!save && fixture.NO_FIXTURE) }, () => {
    const chars = everyCharacter(save.dir);
    assert.ok(chars.length > 0, 'the fixture should contain characters');

    let checked = 0;
    const unresolved = [];
    for (const c of chars) {
      const race = races.raceBySid(c.raceSid);
      if (!race || !race.anatomy.length) { unresolved.push(c.raceSid); continue; }
      const plan = planOf(c.medical);
      const fromRace = new Set(race.anatomy.map((p) => p.sid));
      const fromSave = new Set(plan.map((p) => p.sid));

      assert.deepEqual([...fromSave].sort(), [...fromRace].sort(),
        `${c.file} ${c.sid} (${race.name}): the save's body parts and the race's combat anatomy disagree`);

      for (const slot of plan) {
        const part = race.anatomy.find((p) => p.sid === slot.sid);
        assert.equal(slot.hit, part.hit,
          `${c.file} ${c.sid} (${race.name}): hit for ${part.name} is ${slot.hit}, race says ${part.hit}`);
      }
      checked++;
    }
    assert.equal(unresolved.length, 0,
      `every race in a save should resolve to a body plan; these did not: ${[...new Set(unresolved)].join(', ')}`);
    assert.ok(checked > 0);
  });

// ------------------------------------------------------------- the write --

/** The first character in the fixture, and a race to switch it to. */
function subject() {
  const chars = everyCharacter(save.dir);
  const c = chars.find((x) => races.raceBySid(x.raceSid)?.anatomy.length === 7) || chars[0];
  return c;
}

test('setRace rewrites the race row and the body plan, and nothing else',
  { skip: (!hasInstall && 'no Kenshi install found') || (!save && fixture.NO_FIXTURE) }, () => {
    const c = subject();
    const from = races.raceBySid(c.raceSid);
    // Any other race with the same seven parts — Greenlander <-> Scorchlander is
    // the canonical case, but the fixture's own races are whatever it contains.
    const to = races.catalogue().find((r) => r.sid !== c.raceSid
      && r.anatomy.length === from.anatomy.length
      && r.anatomy.every((p) => from.anatomy.some((q) => q.sid === p.sid)));
    assert.ok(to, 'expected at least one race sharing this body plan');

    const before = readFile(fs.readFileSync(path.join(save.dir, 'platoon', c.file)));
    const res = saveService.setRace(save.dir, c.file, c.sid, to.sid);
    assert.equal(res.before.race.sid, c.raceSid);
    assert.equal(res.after.race.sid, to.sid);

    // Re-parse the produced bytes the way mutationService verifies them.
    const after = readFile(res.bytes);
    assert.ok(Buffer.compare(writeFile(after), res.bytes) === 0,
      'the produced bytes must re-parse and re-serialise identically');
    assert.equal(after.records.length, before.records.length, 'no record may be added or removed');

    // Exactly two records differ, and they are the two the doc comment names.
    const changed = [];
    for (let i = 0; i < after.records.length; i++) {
      const a = before.records[i];
      const b = after.records[i];
      if (JSON.stringify([...a.strings]) !== JSON.stringify([...b.strings])
        || JSON.stringify([...a.floats]) !== JSON.stringify([...b.floats])
        || JSON.stringify([...a.extra]) !== JSON.stringify([...b.extra])) changed.push(b.type);
    }
    assert.deepEqual(changed.sort(), [T.MEDICAL, T.APPEARANCE].sort(),
      `only the MEDICAL (57) and APPEARANCE (66) records should change, got types ${changed.join(', ')}`);

    // The new plan is the target race's.
    const bySid = new Map(after.records.map((r) => [r.sid, r]));
    const squad = after.records.find((r) => r.type === T.SQUAD);
    const inst = squad.instances.find((x) => x.id === c.sid);
    const states = inst.states.map((s) => bySid.get(s)).filter(Boolean);
    const medical = states.find((r) => r.type === T.MEDICAL);
    const appearance = states.find((r) => r.type === T.APPEARANCE);

    assert.equal((appearance.extra.get('race') || [])[0].target, to.sid);
    for (const slot of planOf(medical)) {
      const part = to.anatomy.find((p) => p.sid === slot.sid);
      assert.ok(part, `${slot.sid} is not a part of ${to.name}`);
      assert.equal(slot.hit, part.hit, `hit for ${part.name} should be the new race's`);
    }
  });

test('setRace scales wounds in proportion rather than clamping or healing them',
  { skip: (!hasInstall && 'no Kenshi install found') || (!save && fixture.NO_FIXTURE) }, () => {
    const c = subject();
    const from = races.raceBySid(c.raceSid);
    // A race whose parts have a DIFFERENT maximum, so there is a ratio to check.
    const to = races.catalogue().find((r) => r.sid !== c.raceSid
      && r.anatomy.length === from.anatomy.length
      && r.anatomy.every((p) => from.anatomy.some((q) => q.sid === p.sid))
      && r.anatomy.some((p) => p.max !== from.anatomy.find((q) => q.sid === p.sid).max));
    if (!to) return; // this fixture's races all share a maximum — nothing to check

    const beforePlan = planOf(c.medical);
    const res = saveService.setRace(save.dir, c.file, c.sid, to.sid);
    const after = readFile(res.bytes);
    const bySid = new Map(after.records.map((r) => [r.sid, r]));
    const squad = after.records.find((r) => r.type === T.SQUAD);
    const inst = squad.instances.find((x) => x.id === c.sid);
    const medical = inst.states.map((s) => bySid.get(s)).find((r) => r && r.type === T.MEDICAL);
    const afterPlan = planOf(medical);

    for (let i = 0; i < beforePlan.length; i++) {
      const oldMax = from.anatomy.find((p) => p.sid === beforePlan[i].sid).max;
      const newMax = to.anatomy.find((p) => p.sid === afterPlan[i].sid).max;
      const expected = (beforePlan[i].flesh * newMax) / oldMax;
      assert.ok(Math.abs(afterPlan[i].flesh - expected) < 0.01,
        `slot ${i}: flesh ${beforePlan[i].flesh} should scale ${oldMax}->${newMax} to ${expected}, got ${afterPlan[i].flesh}`);
    }
  });

test('setRace refuses a race it cannot describe, and a no-op',
  { skip: (!hasInstall && 'no Kenshi install found') || (!save && fixture.NO_FIXTURE) }, () => {
    const c = subject();
    const bytes = fs.readFileSync(path.join(save.dir, 'platoon', c.file));

    assert.throws(() => saveService.setRace(save.dir, c.file, c.sid, 'not-a-real-sid'),
      /no race with stringID/);
    assert.throws(() => saveService.setRace(save.dir, c.file, c.sid, c.raceSid),
      /already a/, 'switching to the race the character already is must be refused, not written');
    assert.throws(() => saveService.setRace(save.dir, c.file, c.sid, ''), /raceSid is required/);

    // A race with no combat anatomy anywhere is a hard refusal: there is no body
    // plan to write, and writing the race row alone would leave the MEDICAL
    // record describing a different species.
    const noPlan = races.catalogue().find((r) => r.anatomy.length === 0);
    if (noPlan) {
      assert.throws(() => saveService.setRace(save.dir, c.file, c.sid, noPlan.sid),
        /carries no combat anatomy/);
    }

    assert.ok(Buffer.compare(fs.readFileSync(path.join(save.dir, 'platoon', c.file)), bytes) === 0,
      'a refused switch must not have touched the file');
  });

test('a character read reports its race by the name the game uses',
  { skip: (!hasInstall && 'no Kenshi install found') || (!save && fixture.NO_FIXTURE) }, () => {
    const pdir = path.join(save.dir, 'platoon');
    const file = fs.readdirSync(pdir).find((f) => f.endsWith('.platoon'));
    const { characters } = saveService.readPlatoon(path.join(pdir, file));
    const withRace = characters.filter((c) => c.race);
    assert.ok(withRace.length > 0, 'characters should carry a race');
    for (const c of withRace) {
      assert.equal(c.race.name, races.nameOf(c.race.sid, c.race.sid));
      assert.equal(typeof c.race.switchable, 'boolean');
      // The bug this guards: reporting "Human" for a race the game calls
      // "Greenlander" makes the editor's own switch list unsearchable.
      if (c.race.sid === '17-gamedata.quack') assert.equal(c.race.name, 'Greenlander');
    }
  });
