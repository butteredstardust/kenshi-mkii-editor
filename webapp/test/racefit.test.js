'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const paths = require('../services/pathService');
const fixture = require('./helpers/save-fixture');
const saveService = require('../services/saveService');
const mutation = require('../services/mutationService');
const gamedata = require('../services/gamedataService');
const racesService = require('../services/racesService');
const fitCheck = require('../services/fitCheck');
const itemSlots = require('../services/itemSlots');

/**
 * Racial armour restrictions.
 *
 * The headline claim under test: Kenshi's own restrictions ARE in the data, as
 * `extra['races']` (a whitelist) and `extra['races exclude']` (a blacklist) on
 * the armour template — which is what closed the question AGENTS.md previously
 * recorded as open. Everything here also pins the second half of the contract:
 * a restriction WARNS and never refuses, because this editor's job is writing
 * things the game's own UI will not offer.
 */

const hasInstall = !!paths.installDir();

/** Resolve a template by name among a known sid list, skipping if absent. */
function bySid(sid) {
  const t = gamedata.lookup(sid);
  return t ? { sid, ...t } : null;
}

// Vanilla sids, stable across installs that still have gamedata.base.
const WOOL_HAT = '2164-gamedata.base'; // races: Greenlander, Scorchlander
const MASKED_HELMET = '2201-gamedata.base'; // races exclude: Shek, Hive, Skeleton
const CHAIN_SHIRT = '544-gamedata.base'; // races exclude: every Hive race
const KATANA = '476-gamedata.base'; // no rule at all

/** A race sid from this install's catalogue, by exact resolved name. */
function raceSid(name) {
  const hit = racesService.catalogue().find((r) => r.name === name);
  return hit ? hit.sid : null;
}

// ------------------------------------------------------------- the index --

test('an armour template carries the game\'s own race whitelist and blacklist', (t) => {
  if (!hasInstall) return t.skip('no Kenshi install found');
  if (!bySid(WOOL_HAT)) return t.skip('this install has no vanilla gamedata.base');

  const hat = gamedata.raceRules(WOOL_HAT);
  assert.ok(hat, 'Wool Hat should carry a rule');
  assert.ok(hat.only.length >= 2, 'Wool Hat is a whitelist (human races only)');
  assert.deepStrictEqual(hat.exclude, [], 'and states no blacklist');
  const names = hat.only.map((s) => racesService.nameOf(s, s));
  assert.ok(names.includes('Greenlander') && names.includes('Scorchlander'),
    `expected the human races, got ${names.join(', ')}`);

  const shirt = gamedata.raceRules(CHAIN_SHIRT);
  assert.ok(shirt, 'Chain Shirt should carry a rule');
  assert.deepStrictEqual(shirt.only, [], 'an ordinary shirt is a blacklist, not a whitelist');
  const excluded = shirt.exclude.map((s) => racesService.nameOf(s, s));
  assert.ok(excluded.every((n) => /hive/i.test(n)),
    `every excluded race should be a Hive one, got ${excluded.join(', ')}`);
  assert.ok(excluded.length >= 6, 'all the Hive races, not just one');

  // The overwhelming majority restrict nothing, and that must read as null
  // rather than as an empty restriction — "no rule" and "excluded from
  // everything" are not the same answer.
  assert.strictEqual(gamedata.raceRules(KATANA), null, 'a weapon has no racial rule');
  assert.strictEqual(gamedata.raceRules(''), null);
  assert.strictEqual(gamedata.raceRules('no-such-sid'), null);
});

test('the rule reproduces the wiki: hive shirts are the ONLY shirts a hiver can wear', (t) => {
  if (!hasInstall) return t.skip('no Kenshi install found');
  const worker = raceSid('Hive Worker Drone');
  const green = raceSid('Greenlander');
  if (!worker || !green || !bySid(CHAIN_SHIRT)) return t.skip('this install lacks the vanilla races/items');

  // An ordinary shirt: refused for the hiver, fine for the human.
  assert.strictEqual(fitCheck.raceRuleCheck(CHAIN_SHIRT, worker).blocked, true);
  assert.strictEqual(fitCheck.raceRuleCheck(CHAIN_SHIRT, worker).reason, 'exclude');
  assert.strictEqual(fitCheck.raceRuleCheck(CHAIN_SHIRT, green).blocked, false);

  // A Hive shirt: exactly the other way round. Found by rule shape rather than
  // by name, so a differently-named mod shirt still exercises this.
  const hiveShirt = gamedata.itemTemplates()
    .filter((tm) => tm.type === 3)
    .map((tm) => ({ tm, rule: gamedata.raceRules(tm.sid) }))
    .find(({ tm, rule }) => rule && rule.only.includes(worker)
      && itemSlots.allowedSections(tm.sid, null).sections.includes('shirt'));
  if (!hiveShirt) return t.skip('this install has no hive-only shirt');

  assert.strictEqual(fitCheck.raceRuleCheck(hiveShirt.tm.sid, worker).blocked, false);
  const forHuman = fitCheck.raceRuleCheck(hiveShirt.tm.sid, green);
  assert.strictEqual(forHuman.blocked, true);
  assert.strictEqual(forHuman.reason, 'only');
});

test('a helmet the wiki says Shek cannot wear names the Shek in its own data', (t) => {
  if (!hasInstall) return t.skip('no Kenshi install found');
  const shek = raceSid('Shek');
  if (!shek || !bySid(MASKED_HELMET)) return t.skip('this install lacks Shek or the vanilla helmet');
  assert.strictEqual(fitCheck.raceRuleCheck(MASKED_HELMET, shek).blocked, true,
    'the wiki lists Masked Helmet among the helmets Shek cannot wear');
});

test('no race sid means the rule is reported but nothing is claimed about anyone', (t) => {
  if (!hasInstall || !bySid(WOOL_HAT)) return t.skip('no vanilla gamedata');
  const check = fitCheck.raceRuleCheck(WOOL_HAT, null);
  assert.strictEqual(check.blocked, false, 'an unresolvable race must never produce a verdict');
  assert.ok(check.only.length, 'but the rule itself is still reported');
});

// ------------------------------------------------------ the editorial half --

test('the wiki slot table classifies this install\'s races and only restricts armour slots', () => {
  const rows = fitCheck.RACE_SLOT_RULES;
  assert.ok(rows.length >= 4);
  for (const r of rows) {
    assert.ok(r.slots.every((s) => fitCheck.ALL_ARMOUR_SLOTS.includes(s)),
      `${r.family} names a slot outside the armour table`);
    assert.ok(r.slots.includes('armour') && r.slots.includes('legs'),
      'every race in the table keeps body armour and legwear');
  }

  // The three claims the wiki makes that this install's own saves confirmed:
  // Hive Soldiers have no head slot, no race in the table has a boots slot, and
  // a Skeleton has neither shirt nor head.
  const soldier = fitCheck.raceSlotRule('Hive Soldier Drone');
  assert.ok(soldier && !soldier.slots.includes('head'));
  assert.ok(rows.every((r) => !r.slots.includes('boots')));
  const skeleton = fitCheck.raceSlotRule('Skeleton');
  assert.ok(skeleton && !skeleton.slots.includes('shirt') && !skeleton.slots.includes('head'));

  // Everyone else is unrestricted — the table must not catch a human.
  for (const name of ['Greenlander', 'Scorchlander', 'Shek', 'Bonedog']) {
    assert.strictEqual(fitCheck.raceSlotRule(name), null, `${name} has no slot restriction`);
  }

  // A slot warning is EDITORIAL and must say so: it is the one part of this
  // feature not derived from the game's data.
  const w = fitCheck.raceWarnings({
    templateSid: CHAIN_SHIRT, itemName: 'Chain Shirt', section: 'shirt',
    raceSid: null, raceName: 'Skeleton',
  });
  assert.strictEqual(w.length, 1);
  assert.strictEqual(w[0].source, 'editorial');
});

test('a weapon slot is never flagged by the armour slot table', () => {
  assert.deepStrictEqual(
    fitCheck.raceWarnings({
      templateSid: KATANA, itemName: 'Katana', section: 'hip', raceSid: null, raceName: 'Skeleton',
    }),
    [],
    'the wiki table covers armour slots only — a skeleton carries weapons like anyone else',
  );
});

// ---------------------------------------------------------- never a block --

function playerSquad() { return fixture.fixtureSquad(); }

test('an excluded item is still written, and the receipt says why it was a bad idea', async (t) => {
  if (!hasInstall) return t.skip('no Kenshi install found');
  const squad = playerSquad();
  if (!squad) return t.skip('no player squad');
  if (!bySid(CHAIN_SHIRT)) return t.skip('this install has no vanilla Chain Shirt');

  // Someone the game's own data says cannot wear an ordinary shirt.
  const rule = gamedata.raceRules(CHAIN_SHIRT);
  const target = squad.characters.find((c) => c.race && rule.exclude.includes(c.race.sid));
  if (!target) return t.skip('nobody in the fixture is of an excluded race');

  const scratch = fixture.scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);

  try {
    const receipt = await mutation.mutate(scratch.dir, 'test: equip an excluded shirt',
      (staging) => saveService.equipMany(staging, {
        targets: [{ file: squad.file, sid: target.sid }],
        items: [{ templateSid: CHAIN_SHIRT, section: 'shirt' }],
      }));

    // Written — a warning is not a refusal (AGENTS.md §3).
    const { characters } = saveService.readPlatoon(path.join(scratch.dir, 'platoon', squad.file));
    const now = characters.find((c) => c.sid === target.sid);
    assert.ok(now.inventory.some((it) => it.base === CHAIN_SHIRT && it.section === 'shirt'),
      'the item must be written despite the restriction');

    // ...and reported, as DERIVED rather than as an opinion.
    const warnings = receipt.receipts[0].characters[0].warnings;
    const derived = warnings.filter((w) => w.source === 'derived' && /cannot be worn/i.test(w.text));
    assert.strictEqual(derived.length, 1, `expected one derived race warning, got ${JSON.stringify(warnings)}`);

    // The same warning rides on the item when it is read back, so gear that is
    // already on the wrong character is visible without re-equipping it.
    const worn = now.inventory.find((it) => it.base === CHAIN_SHIRT);
    assert.ok((worn.fitWarnings || []).some((w) => w.source === 'derived'),
      'an owned item carries its own fit warnings');
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

test('addItem reports race fit on the single-item path too, and still writes', async (t) => {
  if (!hasInstall) return t.skip('no Kenshi install found');
  const squad = playerSquad();
  if (!squad) return t.skip('no player squad');
  if (!bySid(WOOL_HAT)) return t.skip('this install has no vanilla Wool Hat');

  const rule = gamedata.raceRules(WOOL_HAT);
  const target = squad.characters.find((c) => c.race && !rule.only.includes(c.race.sid));
  if (!target) return t.skip('everyone in the fixture is a human race');

  const scratch = fixture.scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);

  try {
    const receipt = await mutation.mutate(scratch.dir, 'test: add a restricted hat',
      (staging) => saveService.addItem(staging, squad.file, target.sid, WOOL_HAT, { section: 'head' }));

    const r = receipt.receipts[0];
    assert.ok(r.fitWarnings.some((w) => w.source === 'derived' && /can only be worn/i.test(w.text)),
      `expected a whitelist warning, got ${JSON.stringify(r.fitWarnings)}`);
    // The same text also rides in `warnings`, which is the field the receipt UI
    // has always rendered — a new field alone would have been invisible.
    assert.ok(r.warnings.some((w) => /can only be worn/i.test(w)));
    assert.strictEqual(r.item.section, 'head', 'and the item is written anyway');
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

test('an unrestricted item on any race produces no race warning at all', (t) => {
  if (!hasInstall || !bySid(KATANA)) return t.skip('no vanilla gamedata');
  for (const name of ['Greenlander', 'Shek', 'Skeleton', 'Hive Soldier Drone']) {
    const sid = raceSid(name);
    if (!sid) continue;
    assert.deepStrictEqual(
      fitCheck.raceWarnings({ templateSid: KATANA, itemName: 'Katana', section: 'hip', raceSid: sid, raceName: name }),
      [],
      `${name} should be free to carry a katana`,
    );
  }
});
