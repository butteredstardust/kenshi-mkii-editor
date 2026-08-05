'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const paths = require('../services/pathService');
const fixture = require('./helpers/save-fixture');
const blueprints = require('../services/blueprints');
const vendors = require('../services/vendorsService');
const gamedata = require('../services/gamedataService');
const itemFactory = require('../services/itemFactory');
const saveService = require('../services/saveService');
const mutation = require('../services/mutationService');
const research = require('../services/researchService');
const { readFile } = require('../services/kenshi/codec');
const { asText } = require('../services/kenshi/binary');

/**
 * Blueprints are items (services/blueprints.js).
 *
 * The claim these tests defend is narrow and falsifiable: a blueprint this
 * editor mints is shaped like one the game already wrote. The game's own
 * examples are the oracle — 876 of them across the install's level/zone files —
 * so the shape assertions below compare against records read off disk rather
 * than against a hardcoded expectation this file could have got wrong twice.
 */
const hasInstall = !!paths.installDir();

const RESEARCH_ITEM_FUNCTION = 11;

/** Every type-42 ITEM the install itself wrote with item function 11. */
let liveCache = null;
function liveBlueprintItems() {
  if (liveCache) return liveCache;
  liveCache = [];
  const install = paths.installDir();
  if (!install) return liveCache;
  const walk = (dir) => {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(level|zone)$/i.test(e.name)) {
        let parsed; try { parsed = readFile(fs.readFileSync(p)); } catch { continue; }
        for (const rec of parsed.records) {
          if (rec.type === 42 && rec.ints.get('item function') === RESEARCH_ITEM_FUNCTION) liveCache.push(rec);
        }
      }
    }
  };
  walk(path.join(install, 'data'));
  return liveCache;
}

// ------------------------------------------------------------- the oracle --

test('a live blueprint item carries its ledger entry in BOTH grade fields', (t) => {
  if (!hasInstall) return t.skip('no Kenshi install found');
  const live = liveBlueprintItems();
  assert.ok(live.length > 100, `only ${live.length} live blueprint items found — the sweep is not reaching the level files`);

  let withEntry = 0;
  for (const rec of live) {
    const mat = asText(rec.strings.get('material sid') || '');
    const comp = asText(rec.strings.get('company sid') || '');
    assert.strictEqual(mat, comp,
      `blueprint ${asText(rec.strings.get('base data sid'))} has material "${mat}" but company "${comp}"`);
    if (!mat) continue;
    withEntry++;
    // Two shapes and only two: a bare research tech, or "<itemTemplate>.TECH.N".
    const m = /^(.*)\.TECH\.(\d+)$/.exec(mat);
    const subjectSid = m ? m[1] : mat;
    const subject = gamedata.lookup(subjectSid);
    assert.ok(subject, `blueprint entry "${mat}" names nothing this install defines`);
    if (m) {
      assert.ok(gamedata.ITEM_TEMPLATE_TYPES.has(subject.type),
        `"${mat}" is suffixed .TECH but its subject is typecode ${subject.type}, not an item template`);
    } else {
      assert.strictEqual(subject.type, blueprints.RESEARCH_TECH,
        `unsuffixed blueprint entry "${mat}" is typecode ${subject.type}, not a research tech`);
    }
  }
  assert.ok(withEntry > 100, 'almost every live blueprint should name something');
});

test('every live blueprint is backed by a template this service recognises', (t) => {
  if (!hasInstall) return t.skip('no Kenshi install found');
  for (const rec of liveBlueprintItems()) {
    const base = asText(rec.strings.get('base data sid') || '');
    assert.ok(blueprints.isBlueprintTemplate(base),
      `the game uses "${base}" as a blueprint template but blueprints.templates() does not list it`);
  }
});

// ---------------------------------------------------------------- minting --

test('a minted blueprint matches a live one field for field', (t) => {
  if (!hasInstall) return t.skip('no Kenshi install found');
  const live = liveBlueprintItems();
  const oracle = live.find((r) => asText(r.strings.get('material sid') || ''));
  assert.ok(oracle, 'no live blueprint with an entry to compare against');

  const templateSid = asText(oracle.strings.get('base data sid'));
  const teaches = asText(oracle.strings.get('material sid'));
  const { record, meta } = itemFactory.buildItemRecord(templateSid, {
    section: asText(oracle.strings.get('section')),
    teaches,
  });

  assert.ok(meta.blueprint, 'meta should report what the blueprint teaches');
  assert.strictEqual(meta.blueprint.teaches, teaches);

  // Same keys, same values. Key ORDER is load-bearing in this format but the
  // game itself writes two orders for these records (459 one way, 406 the
  // other), so the assertion is on content — order is covered by the round trip.
  for (const sectionName of ['strings', 'ints', 'floats', 'bools']) {
    assert.deepStrictEqual(
      new Set(record[sectionName].keys()), new Set(oracle[sectionName].keys()),
      `${sectionName} keys differ from the game's own blueprint`,
    );
    for (const [k, v] of record[sectionName]) {
      // `inventory x`/`y` are where the item sits in the owner's grid — a
      // property of the container it was found in, not of the item's kind.
      if (k === 'inventory x' || k === 'inventory y') continue;
      const expected = oracle[sectionName].get(k);
      assert.deepStrictEqual(typeof v === 'string' ? v : v, typeof expected === 'string' ? asText(expected) : expected,
        `${sectionName}.${k}`);
    }
  }
  assert.strictEqual(record.type, 42);
  assert.strictEqual(asText(record.name), asText(oracle.name));
});

test('"teaches" is refused on a template that is not a blueprint, and malformed entries are refused', (t) => {
  if (!hasInstall) return t.skip('no Kenshi install found');
  const armour = gamedata.itemTemplates().find((x) => x.type === 3);
  assert.throws(
    () => itemFactory.buildItemRecord(armour.sid, { section: 'main', teaches: '1887-gamedata.base' }),
    /not a blueprint item template/,
  );
  // An unsuffixed entry naming an ARMOUR is the exact mistake the vendor page
  // used to make — it must not be writable.
  assert.throws(
    () => itemFactory.buildItemRecord('BLUEPRINT_ITEM', { section: 'main', teaches: armour.sid }),
    /not a usable blueprint entry/,
  );
  assert.throws(
    () => itemFactory.buildItemRecord('BLUEPRINT_ITEM', { section: 'main', teaches: '' }),
    /non-empty/,
  );
});

// ---------------------------------------------------------------- vendors --

test('a blueprint shelf sells the blueprint, not its subject', (t) => {
  if (!hasInstall) return t.skip('no Kenshi install found');
  const rows = vendors.all().flatMap((s) => s.items.filter((i) => i.blueprint));
  assert.ok(rows.length > 0, 'no shop offers a blueprint — the shelves are being resolved as their subjects again');

  for (const row of rows) {
    assert.ok(vendors.BLUEPRINT_CATS.has(row.category), `${row.name} is a blueprint from shelf "${row.category}"`);
    assert.strictEqual(row.addable, true, `${row.name} is a blueprint but not addable`);
    assert.ok(blueprints.isBlueprintTemplate(row.blueprint.templateSid));
    assert.strictEqual(row.key, `blueprint|${row.sid}`);
    // What it teaches must be the SUBJECT, and the template must not be it.
    assert.notStrictEqual(row.blueprint.templateSid, row.sid);
    assert.ok(row.blueprint.teaches.startsWith(row.sid));
  }

  // The row key has to distinguish the two, because a shop really does sell
  // both: this install has shops listing one armour under `clothing` and under
  // `armour blueprints`.
  const both = vendors.all().some((s) => {
    const seen = new Map();
    for (const i of s.items) seen.set(i.sid, (seen.get(i.sid) || 0) + 1);
    return [...seen.values()].some((n) => n > 1);
  });
  assert.ok(both, 'expected at least one shop to sell a thing and its blueprint');
});

test('a research tech is addable through a blueprint shelf and nowhere else', (t) => {
  if (!hasInstall) return t.skip('no Kenshi install found');
  for (const shop of vendors.all()) {
    for (const it of shop.items) {
      if (it.type !== blueprints.RESEARCH_TECH) continue;
      assert.strictEqual(it.addable, !!it.blueprint,
        `research tech "${it.name}" on shelf "${it.category}" is addable=${it.addable}`);
    }
  }
});

// ------------------------------------------------------------ the write --

test('adding a blueprint writes a real item and warns when the save already knows it', async (t) => {
  if (!hasInstall) return t.skip('no Kenshi install found');
  const src = fixture.fixtureSave();
  if (!src) return t.skip(fixture.NO_FIXTURE);
  // From the FIXTURE, not `status(src.name)` — that resolves the name against
  // the live save folder while the write below goes to a copy of the fixture.
  const squad = fixture.fixtureSquad();
  if (!squad) return t.skip('fixture save has no player squad');
  const target = squad.characters[0];

  const scratch = fixture.scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);
  try {
    const relFile = path.join('platoon', squad.file);

    // Pick a tech this save has ALREADY finished, so the duplicate warning is
    // exercised on real data rather than a constructed case.
    const world = readFile(fs.readFileSync(path.join(scratch.dir, 'quick.save')));
    const entries = research.entriesOf(research.ledgerRecord(world));
    const knownTech = entries.find((e) => {
      if (/\.TECH\.\d+$/.test(e)) return false;
      const bare = e.replace(/\.\d+$/, '');
      const rec = gamedata.lookup(bare);
      return rec && rec.type === blueprints.RESEARCH_TECH;
    });
    assert.ok(knownTech, 'fixture save has finished no research at all');
    const bp = blueprints.forSubject(knownTech.replace(/\.\d+$/, ''));
    assert.ok(bp, `${knownTech} should be blueprintable`);

    const result = await mutation.mutate(scratch.dir, 'test: add blueprint',
      (staging) => saveService.addItem(staging, squad.file, target.sid, bp.templateSid,
        { section: 'main', teaches: bp.teaches }));

    assert.deepStrictEqual(result.changedFiles, [relFile]);
    const receipt = result.receipts[0];
    assert.strictEqual(receipt.item.blueprint.teaches, bp.teaches);
    assert.ok(receipt.warnings.some((w) => /already finished/.test(w)),
      `expected an "already finished" warning, got ${JSON.stringify(receipt.warnings)}`);

    // The item really is on the character, with the subject in both fields.
    const { characters } = saveService.readPlatoon(path.join(scratch.dir, relFile));
    const me = characters.find((c) => c.sid === target.sid);
    assert.ok(me.inventory.some((i) => i.sid === receipt.item.sid),
      'the blueprint is not in the character inventory after the write');

    const parsed = readFile(fs.readFileSync(path.join(scratch.dir, relFile)));
    const rec = parsed.records.find((r) => r.sid === receipt.item.sid);
    assert.ok(rec, 'minted record not found in the platoon file');
    assert.strictEqual(asText(rec.strings.get('material sid')), bp.teaches);
    assert.strictEqual(asText(rec.strings.get('company sid')), bp.teaches);
    assert.strictEqual(asText(rec.strings.get('base data sid')), bp.templateSid);
    assert.strictEqual(rec.ints.get('item function'), RESEARCH_ITEM_FUNCTION);

    // Adding a blueprint must NOT touch the research ledger — the object is the
    // edit; clicking it in game is what finishes the tech.
    const worldAfter = readFile(fs.readFileSync(path.join(scratch.dir, 'quick.save')));
    assert.strictEqual(research.entriesOf(research.ledgerRecord(worldAfter)).length, entries.length);
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});
