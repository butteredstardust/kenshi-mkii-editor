'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const paths = require('../services/pathService');
const backups = require('../services/backupService');
const saveService = require('../services/saveService');
const mutation = require('../services/mutationService');
const loadouts = require('../services/loadouts');
const fitCheck = require('../services/fitCheck');
const itemFactory = require('../services/itemFactory');
const gamedata = require('../services/gamedataService');
const itemSlots = require('../services/itemSlots');
const { readFile } = require('../services/kenshi/codec');
const { asText } = require('../services/kenshi/binary');

/**
 * Bulk equip. Same discipline as the other mutation suites — every write goes
 * through mutationService against a COPY of a real save in a temp directory,
 * never the live one, and every rejection asserts the save is byte-identical
 * afterwards.
 */
function scratchSave() {
  const src = paths.latestSave();
  if (!src) return null;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kenshi-mkii-test-'));
  const dir = path.join(root, src.name);
  backups.copyDir(src.dir, dir);
  paths.setOverrides({ backupRoot: path.join(root, 'backups') });
  return { root, dir };
}

/** The player squad's file plus its characters, from the live save. */
function playerSquad() {
  const src = paths.latestSave();
  if (!src) return null;
  const st = saveService.status(src.name);
  const squad = st.squads.find((q) => q.characters.length);
  return squad || null;
}

const ITEM = saveService.T.ITEM;
const countItems = (parsed) => parsed.records.filter((r) => r.type === ITEM).length;

// ------------------------------------------------------------- catalogues --

test('every loadout resolves and every section is legal for its item kind', () => {
  const result = loadouts.validate();
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.unresolved, [],
    'a loadout names a template this install cannot resolve — check the mod is still installed');

  const rows = loadouts.catalogue();
  assert.ok(rows.length > 0);
  for (const l of rows) {
    assert.ok(l.id && l.label && l.items.length, JSON.stringify(l));
    assert.deepStrictEqual(l.missing, [], `${l.id} has unresolvable items`);
  }
});

// -------------------------------------------------- typecode 46 (backpack) --

test('backpack templates (typecode 46) are offered and mint a live-shaped record', (t) => {
  const backpacks = gamedata.itemTemplates().filter((x) => x.type === 46);
  if (!backpacks.length) return t.skip('no typecode-46 templates in this install');

  // Slot rule: all 42 live type-46-backed items sit in backpack_attach.
  const { sections, widened } = itemSlots.allowedSections(backpacks[0].sid, null);
  assert.ok(sections.includes('backpack_attach'));
  assert.strictEqual(widened, false, 'type 46 is a known kind now, not the permissive fallback');

  const { record } = itemFactory.buildItemRecord(backpacks[0].sid, { section: 'backpack_attach' });
  assert.strictEqual(record.type, ITEM);
  assert.strictEqual(record.name, '0');
  assert.strictEqual(record.ints.get('item function'), 4);
  assert.strictEqual(record.ints.get('level'), 0);
  assert.strictEqual(record.floats.get('quality'), 100);
  assert.strictEqual(record.floats.get('charges'), 1);
  assert.strictEqual(record.strings.get('company sid'), '');
  // No `uniform` key: confirmed absent on every live backpack item.
  assert.ok(!record.strings.has('uniform'), 'a backpack must not carry a "uniform" key');
  assert.deepStrictEqual(
    [...record.strings.keys()],
    ['color sid', 'material sid', 'company sid', 'section', 'base data sid'],
    'key order is load-bearing in this format',
  );
});

// -------------------------------------------------- weapon grade (company) --

test('a grade is the (company, model) PAIR — gradeId resolves it exactly', () => {
  const grades = gamedata.weaponGrades();
  assert.ok(grades.length > 0);
  for (const g of grades) assert.strictEqual(g.id, `${g.companySid}|${g.modelSid}`);

  // The whole reason gradeId exists: a model sid alone can name two rows.
  const byModel = new Map();
  for (const g of grades) byModel.set(g.modelSid, [...(byModel.get(g.modelSid) || []), g]);
  const ambiguous = [...byModel.values()].find((rows) => rows.length > 1);
  if (ambiguous) {
    const highest = [...ambiguous].sort((a, b) => b.rank - a.rank)[0];
    assert.strictEqual(itemFactory.resolveGrade({ gradeId: highest.id }).companySid, highest.companySid,
      'gradeId must pin the exact company');
    // Unqualified materialSid is documented as "lowest rank wins" — pinned so a
    // change to that rule is a deliberate one, not a silent drift.
    const lowest = [...ambiguous].sort((a, b) => (a.rank - b.rank)
      || (a.companySid < b.companySid ? -1 : 1))[0];
    assert.strictEqual(itemFactory.resolveGrade({ materialSid: lowest.modelSid }).companySid, lowest.companySid);
    // Naming a company that isn't on that model's ladder is an error, not a
    // silently different manufacturer.
    assert.throws(() => itemFactory.resolveGrade({ materialSid: lowest.modelSid, companySid: 'NOT_A_COMPANY' }),
      /does not match any ladder entry/);
  }
  assert.throws(() => itemFactory.resolveGrade({ gradeId: 'nope|nope' }), /not a known weapon grade id/);
});

// -------------------------------------------------------------- fitCheck --

test('fitCheck warns only about parts a character actually lacks', () => {
  const helmet = loadouts.find('ancient-samurai').items.find((i) => i.section === 'head');
  const coverage = gamedata.lookup(helmet.templateSid).partCoverage;
  assert.ok(coverage && coverage.length, 'the helmet template should carry part coverage rows');

  // A character with the covered part: no derived warning.
  assert.deepStrictEqual(fitCheck.uncoveredParts(helmet.templateSid, new Set(coverage)), []);
  // A character without it: warned, by name.
  const missing = fitCheck.uncoveredParts(helmet.templateSid, new Set(['something-else']));
  assert.strictEqual(missing.length, coverage.length);

  // No coverage rows (a weapon) is never a warning on its own.
  const katana = loadouts.find('player-weapons').items[0];
  assert.deepStrictEqual(fitCheck.uncoveredParts(katana.templateSid, new Set(['x'])), []);

  // Editorial race notes are matched case-insensitively on a substring.
  const notes = [{ races: ['Dog1'], note: 'animal' }];
  const w = fitCheck.warningsFor({ templateSid: katana.templateSid, itemName: 'Katana', partSids: new Set(), raceName: 'Dog1', raceNotes: notes });
  assert.strictEqual(w.length, 1);
  assert.strictEqual(w[0].source, 'editorial');
  assert.strictEqual(
    fitCheck.warningsFor({ templateSid: katana.templateSid, itemName: 'Katana', partSids: new Set(), raceName: 'Human', raceNotes: notes }).length,
    0,
  );
});

// ------------------------------------------------------------- equipMany --

test('equipMany gives every target every item in ONE staged edit', async (t) => {
  if (mutation.gameIsRunning()) return t.skip('Kenshi is running');
  const squad = playerSquad();
  if (!squad || squad.characters.length < 2) return t.skip('need a player squad of at least 2');
  const scratch = scratchSave();
  if (!scratch) return t.skip('no Kenshi save found');

  try {
    const relFile = path.join('platoon', squad.file);
    const before = readFile(fs.readFileSync(path.join(scratch.dir, relFile)));
    const picked = squad.characters.slice(0, 3);
    const loadout = loadouts.find('ancient-samurai');
    const expected = picked.length * loadout.items.length;

    const receipt = await mutation.mutate(scratch.dir, 'test: bulk equip',
      (staging) => saveService.equipMany(staging, {
        targets: picked.map((c) => ({ file: squad.file, sid: c.sid })),
        items: loadout.items,
        raceNotes: loadout.raceNotes,
      }));

    assert.deepStrictEqual(receipt.changedFiles, [relFile]);
    assert.strictEqual(receipt.rollbackStatus, 'not needed');

    const after = readFile(fs.readFileSync(path.join(scratch.dir, relFile)));
    assert.strictEqual(countItems(after), countItems(before) + expected,
      'one type-42 record per (character, item) pair');
    assert.strictEqual(after.records.length, before.records.length + expected);
    // One id per minted record, handed out from this file's own counter.
    assert.strictEqual(after.header.nextId, before.header.nextId + expected);

    const ids = after.records.map((r) => r.id);
    assert.strictEqual(new Set(ids).size, ids.length, 'no duplicate record id');
    const sids = after.records.map((r) => r.sid);
    assert.strictEqual(new Set(sids).size, sids.length, 'no duplicate record sid');

    const r = receipt.receipts[0];
    assert.strictEqual(r.itemsAdded, expected);
    assert.strictEqual(r.charactersTouched, picked.length);
    assert.strictEqual(r.filesTouched, 1);

    // Every item reads back on the right character in the right slot.
    for (const c of picked) {
      const now = readCharacter(scratch.dir, squad.file, c.sid);
      for (const item of loadout.items) {
        const worn = now.inventory.filter((it) => it.section === item.section);
        assert.ok(worn.some((it) => it.base === item.templateSid),
          `${now.name} should have ${item.templateSid} in ${item.section}`);
      }
    }

    // An INVENTORY record keeps instanceCount in lockstep (41 agrees on all
    // 282 live records — unlike SQUAD, which does not).
    for (const rec of after.records) {
      if (rec.type === saveService.T.INVENTORY) {
        assert.strictEqual(rec.instanceCount, rec.instances.length);
      }
    }
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

/** Read one character back out of a save directory by (file, sid). */
function readCharacter(dir, platoonFile, sid) {
  const { characters } = saveService.readPlatoon(path.join(dir, 'platoon', platoonFile));
  return characters.find((c) => c.sid === sid) || null;
}

test('equipMany displaces a prior occupant, and skipIfSlotFilled leaves it alone instead', async (t) => {
  if (mutation.gameIsRunning()) return t.skip('Kenshi is running');
  const squad = playerSquad();
  if (!squad) return t.skip('no player squad');
  const scratch = scratchSave();
  if (!scratch) return t.skip('no Kenshi save found');

  try {
    const target = { file: squad.file, sid: squad.characters[0].sid };
    const items = loadouts.find('ancient-samurai').items.slice(0, 1); // one body-armour slot

    // First pass fills the slot.
    await mutation.mutate(scratch.dir, 'test: fill slot',
      (staging) => saveService.equipMany(staging, { targets: [target], items }));
    const afterFirst = readCharacter(scratch.dir, squad.file, target.sid);
    const inSlot = afterFirst.inventory.filter((it) => it.section === items[0].section);
    assert.strictEqual(inSlot.length, 1, 'exactly one item occupies a single-occupancy slot');

    // Second pass displaces the occupant back to `main` — the same rule the
    // Gear page's single-item control follows.
    const second = await mutation.mutate(scratch.dir, 'test: displace',
      (staging) => saveService.equipMany(staging, { targets: [target], items }));
    assert.strictEqual(second.receipts[0].characters[0].displaced.length, 1);
    const afterSecond = readCharacter(scratch.dir, squad.file, target.sid);
    assert.strictEqual(afterSecond.inventory.filter((it) => it.section === items[0].section).length, 1,
      'still exactly one occupant — the old one moved to main, it was not left in place');

    // Third pass with skipIfSlotFilled adds nothing at all, so the mutation
    // gate rejects it as a no-op. That IS the correct outcome: there is nothing
    // to write.
    await assert.rejects(
      mutation.mutate(scratch.dir, 'test: skip filled',
        (staging) => saveService.equipMany(staging, { targets: [target], items, skipIfSlotFilled: true })),
      /edit produced no change/,
    );
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

test('equipMany warns about a bad race fit but never refuses on it', async (t) => {
  if (mutation.gameIsRunning()) return t.skip('Kenshi is running');
  const squad = playerSquad();
  if (!squad) return t.skip('no player squad');
  // Someone whose body plan genuinely lacks a part the samurai set covers.
  const loadout = loadouts.find('ancient-samurai');
  const odd = squad.characters.find((c) => {
    const parts = new Set((c.medical?.parts || []).map((p) => p.part));
    return loadout.items.some((it) => {
      const cov = gamedata.lookup(it.templateSid)?.partCoverage || [];
      return cov.some((p) => !parts.has(gamedata.nameOf(p, p)));
    });
  });
  if (!odd) return t.skip('no character in this save has a mismatched body plan');
  const scratch = scratchSave();
  if (!scratch) return t.skip('no Kenshi save found');

  try {
    const receipt = await mutation.mutate(scratch.dir, 'test: warn not refuse',
      (staging) => saveService.equipMany(staging, {
        targets: [{ file: squad.file, sid: odd.sid }],
        items: loadout.items,
        raceNotes: loadout.raceNotes,
      }));

    const entry = receipt.receipts[0].characters[0];
    assert.strictEqual(entry.added.length, loadout.items.length,
      'a poor fit is reported, never withheld — every item is still written');
    assert.ok(entry.warnings.length > 0, 'the poor fit should be reported');
    assert.ok(entry.warnings.some((w) => w.source === 'derived'),
      'the body-plan mismatch is the derived (data-backed) warning');
    // Deduped: a per-character race note must not repeat once per item.
    const texts = entry.warnings.map((w) => w.text);
    assert.strictEqual(new Set(texts).size, texts.length, 'warnings must be deduped');
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

test('equipMany rejects a bad request and leaves the save byte-identical', async (t) => {
  if (mutation.gameIsRunning()) return t.skip('Kenshi is running');
  const squad = playerSquad();
  if (!squad) return t.skip('no player squad');
  const scratch = scratchSave();
  if (!scratch) return t.skip('no Kenshi save found');

  try {
    const targets = [{ file: squad.file, sid: squad.characters[0].sid }];
    const before = backups.hashDir(scratch.dir);

    const cases = [
      [{ targets: [], items: [{ templateSid: 'x', section: 'main' }] }, /targets must be a non-empty array/],
      [{ targets, items: [] }, /items must be a non-empty array/],
      [{ targets, items: [{ section: 'main' }] }, /templateSid is required/],
      [{ targets, items: [{ templateSid: 'nope-nope.mod', section: 'main' }] }, /unresolvable item template sid/],
      [{ targets, items: [{ templateSid: 'x', section: 'main', bogus: 1 }] }, /unknown field/],
      // A shirt cannot occupy a weapon slot: KIND vs SLOT stays a hard refusal,
      // unlike race fit.
      [{ targets, items: [{ templateSid: loadouts.find('ancient-samurai').items[0].templateSid, section: 'hip' }] },
        /cannot be added into slot/],
      [{ targets, items: [{ templateSid: loadouts.find('ancient-samurai').items[0].templateSid, section: 'armour', quantity: 3 }] },
        /not stackable/],
      [{ targets: [{ file: '../quick.save', sid: 'x' }], items: loadouts.find('thieves-backpack').items },
        /invalid platoon file name/],
      [{ targets: [{ file: squad.file, sid: 'no-such-character' }], items: loadouts.find('thieves-backpack').items },
        /no character with sid/],
    ];

    for (const [opts, pattern] of cases) {
      await assert.rejects(
        mutation.mutate(scratch.dir, 'test: bad bulk equip',
          (staging) => saveService.equipMany(staging, opts)),
        pattern,
        JSON.stringify(opts).slice(0, 120),
      );
    }
    assert.deepStrictEqual(backups.hashDir(scratch.dir), before);
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

test('a character read carries its race, so nothing has to re-scan the save for one', (t) => {
  const squad = playerSquad();
  if (!squad) return t.skip('no player squad');
  for (const c of squad.characters) {
    if (!c.race) continue; // a character with no appearance record is allowed to have none
    assert.ok(c.race.sid && c.race.name, `${c.name} has a malformed race: ${JSON.stringify(c.race)}`);
    assert.match(c.race.sid, /-/, 'a race sid is a "<id>-<file>" stringID');
  }
  assert.ok(squad.characters.some((c) => c.race), 'no character reported a race at all');
});

test('a weapon minted with a gradeId carries that exact company/material pair', async (t) => {
  if (mutation.gameIsRunning()) return t.skip('Kenshi is running');
  const squad = playerSquad();
  if (!squad) return t.skip('no player squad');
  const weapons = loadouts.find('player-weapons');
  const grade = gamedata.weaponGrades().find((g) => g.id === weapons.items[0].gradeId);
  if (!grade) return t.skip('this install has no such grade');
  const scratch = scratchSave();
  if (!scratch) return t.skip('no Kenshi save found');

  try {
    await mutation.mutate(scratch.dir, 'test: graded weapon',
      (staging) => saveService.equipMany(staging, {
        targets: [{ file: squad.file, sid: squad.characters[0].sid }],
        items: [weapons.items[0]],
      }));

    const c = readCharacter(scratch.dir, squad.file, squad.characters[0].sid);
    const worn = c.inventory.find((it) => it.base === weapons.items[0].templateSid
      && it.section === weapons.items[0].section);
    assert.ok(worn, 'the weapon should be in its slot');
    assert.strictEqual(worn.materialSid, grade.modelSid);
    assert.strictEqual(worn.companySid, grade.companySid,
      'the company must be the one named by the gradeId, not whichever row sorted first');
    assert.strictEqual(worn.gradeId, grade.id);
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

test('equipMany spans platoon files, writing each one once', async (t) => {
  if (mutation.gameIsRunning()) return t.skip('Kenshi is running');
  const src = paths.latestSave();
  if (!src) return t.skip('no Kenshi save found');

  // Any two platoon files, not just the PLAYER's — equipMany targets are
  // (file, sid) pairs and it does not care whose squad they are. A save with
  // only one player squad would otherwise never exercise the multi-file path,
  // which is the whole reason this function returns an array.
  const pdir = path.join(src.dir, 'platoon');
  if (!fs.existsSync(pdir)) return t.skip('this save has no platoon directory');
  const candidates = [];
  for (const f of fs.readdirSync(pdir).filter((n) => n.endsWith('.platoon')).sort()) {
    const { characters } = saveService.readPlatoon(path.join(pdir, f));
    const c = characters.find((x) => x.inventory);
    if (c) candidates.push({ file: f, sid: c.sid });
    if (candidates.length === 2) break;
  }
  if (candidates.length < 2) return t.skip('need two platoon files with characters');

  const scratch = scratchSave();
  if (!scratch) return t.skip('no Kenshi save found');

  try {
    const targets = candidates;
    const receipt = await mutation.mutate(scratch.dir, 'test: cross-file equip',
      (staging) => saveService.equipMany(staging, {
        targets, items: loadouts.find('thieves-backpack').items,
      }));

    assert.strictEqual(receipt.changedFiles.length, 2, 'both platoon files are written');
    assert.strictEqual(receipt.receipts[0].filesTouched, 2);
    for (const t2 of targets) {
      assert.ok(receipt.changedFiles.includes(path.join('platoon', t2.file)));
    }
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

test('asText is never needed to read back a name written by equipMany receipts', (t) => {
  // Guards the receipt boundary: names in a receipt are display text, already
  // decoded, so a UI must never have to call asText() on them.
  const squad = playerSquad();
  if (!squad) return t.skip('no player squad');
  for (const c of squad.characters) {
    assert.strictEqual(c.name, asText(c.name), `${c.name} is not already display text`);
  }
});
