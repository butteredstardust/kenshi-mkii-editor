'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const paths = require('../services/pathService');
const fixture = require('./helpers/save-fixture');
const factions = require('../services/factionsService');
const mutation = require('../services/mutationService');
const { readFile } = require('../services/kenshi/codec');
const { asText } = require('../services/kenshi/binary');

/**
 * Faction relations (services/factionsService.js).
 *
 * The write is one float in one record, so the interesting assertions are about
 * IDENTITY (a faction record's own sid is a runtime handle; `gamedata stringID`
 * is the key) and about REFUSAL (this service never mints a relation key).
 */
const hasInstall = !!paths.installDir();

test('the gamedata faction catalogue resolves in load order', (t) => {
  if (!hasInstall) return t.skip('no Kenshi install found');
  const list = factions.catalogue();
  assert.ok(list.length > 50, `only ${list.length} type-10 factions`);
  for (const f of list) {
    assert.ok(f.sid && f.name, JSON.stringify(f));
    assert.strictEqual(typeof f.enemyAt, 'number');
    assert.strictEqual(typeof f.tradeAt, 'number');
  }
  const sids = list.map((f) => f.sid);
  assert.strictEqual(new Set(sids).size, sids.length, 'a sid is listed twice — definitions are not being merged');
});

test('every save faction record maps to a gamedata template, and exactly one is the player', (t) => {
  const src = fixture.fixtureSave();
  if (!src) return t.skip(fixture.NO_FIXTURE);

  const parsed = readFile(fs.readFileSync(path.join(src.dir, 'quick.save')));
  const recs = parsed.records.filter((r) => r.type === factions.FACTION);
  assert.ok(recs.length > 50, `only ${recs.length} faction records`);

  const gdSids = new Set();
  let rowless = 0;
  for (const rec of recs) {
    const gd = asText(rec.strings.get('gamedata stringID') || '');
    assert.ok(gd, `faction record ${rec.sid} has no gamedata stringID — identity would have to be guessed`);
    assert.ok(!gdSids.has(gd), `two faction records claim gamedata sid ${gd}`);
    gdSids.add(gd);
    // A record's OWN sid is a runtime handle and must never be used as identity.
    assert.match(rec.sid, /-INGAME$/);
    if (![...rec.strings.keys()].some((k) => /^relationSID\d+$/.test(k))) rowless++;
  }
  assert.strictEqual(rowless, 1, 'exactly one record (the player) should carry no relation rows');
});

test('relationsFor reports every faction, and every row has a relation float', (t) => {
  const src = fixture.fixtureSave();
  if (!src) return t.skip(fixture.NO_FIXTURE);
  if (!hasInstall) return t.skip('no Kenshi install found');

  const r = factions.relationsFor(src.dir);
  assert.strictEqual(r.factions.length, r.records - 1, 'everyone but the player should be listed');
  assert.strictEqual(r.counts.withRow, r.factions.length,
    'a faction with no row toward the player would be uneditable — none was ever observed');
  assert.ok(r.player.gamedataSid, 'no player faction resolved');
  assert.ok(r.player.name, 'the player faction has no name');

  for (const f of r.factions) {
    assert.strictEqual(typeof f.relation, 'number');
    assert.ok(f.relation >= -100 && f.relation <= 100, `${f.name} is at ${f.relation}`);
    assert.ok(f.editable);
    assert.ok(f.standing !== 'unknown', `${f.name} has no standing`);
  }
  // Counts must partition the factions that have a row, or the summary lies.
  const c = r.counts;
  assert.strictEqual(c.hostile + c.unfriendly + c.neutral + c.friendly + c.allied, c.withRow);
});

test('relations are directional, not a mirror', (t) => {
  const src = fixture.fixtureSave();
  if (!src) return t.skip(fixture.NO_FIXTURE);
  if (!hasInstall) return t.skip('no Kenshi install found');

  // Parse quick.save ONCE and hand it to every call — it is a 30 MB file and
  // this walks the whole 114x114 grid.
  const world = readFile(fs.readFileSync(path.join(src.dir, 'quick.save')));
  const r = factions.relationsFor(src.dir, world);
  const viewOf = new Map(r.factions.map((f) => [f.sid, factions.relationsOf(src.dir, f.sid, world)]));

  let pairs = 0; let asymmetric = 0;
  for (const f of r.factions) {
    const view = viewOf.get(f.sid);
    // Everyone carries a row for everyone, including themselves.
    assert.ok(view.relations.some((x) => x.isSelf), `${f.name} has no self row`);
    assert.strictEqual(view.relations.find((x) => x.isSelf).editable, false,
      'a faction\'s opinion of itself is not an edit this offers');
    for (const row of view.relations) {
      if (row.isSelf || row.isPlayer) continue;
      const backView = viewOf.get(row.sid);
      if (!backView) continue;
      const back = backView.relations.find((x) => x.sid === f.sid);
      if (!back) continue;
      pairs++;
      if (back.relation !== row.relation) asymmetric++;
    }
  }
  assert.ok(pairs > 100, 'not enough pairs sampled to say anything');
  assert.ok(asymmetric > 0,
    'no asymmetric pair found — if relations really were symmetric, editing one side would be a half-edit');
});

test('setRelations writes exactly the floats named and refuses everything else', async (t) => {
  const src = fixture.fixtureSave();
  if (!src) return t.skip(fixture.NO_FIXTURE);
  if (!hasInstall) return t.skip('no Kenshi install found');

  const scratch = fixture.scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);
  try {
    const before = factions.relationsFor(scratch.dir);
    const player = before.player.gamedataSid;
    // Two real factions, deliberately not the engine utility ones.
    const targets = before.factions.filter((f) => !f.notReal).slice(0, 2);
    assert.strictEqual(targets.length, 2);

    const changes = targets.map((f, i) => ({ from: f.sid, to: player, relation: i === 0 ? 100 : -75 }));
    const result = await mutation.mutate(scratch.dir, 'test: set relations',
      (staging) => factions.setRelations(staging, changes));

    assert.deepStrictEqual(result.changedFiles, ['quick.save'],
      'a relation lives in quick.save and nowhere else');
    assert.strictEqual(result.rollbackStatus, 'not needed');
    const r = result.receipts[0];
    assert.strictEqual(r.changed.length, 2);
    assert.strictEqual(r.changed[0].after, 100);
    assert.strictEqual(r.changed[0].standing, 'allied');
    assert.strictEqual(r.changed[1].standing, 'hostile');

    // Read it back off disk, and confirm nothing ELSE moved.
    const after = factions.relationsFor(scratch.dir);
    assert.strictEqual(after.factions.find((f) => f.sid === targets[0].sid).relation, 100);
    assert.strictEqual(after.factions.find((f) => f.sid === targets[1].sid).relation, -75);
    const moved = after.factions.filter((f) => {
      const was = before.factions.find((x) => x.sid === f.sid);
      return was.relation !== f.relation;
    });
    assert.deepStrictEqual(moved.map((f) => f.sid).sort(), targets.map((f) => f.sid).sort(),
      'a relation moved that was never named');
    // Record and row counts are untouched — this edit mints nothing.
    assert.strictEqual(after.records, before.records);
    assert.strictEqual(after.counts.withRow, before.counts.withRow);

    // --- refusals ---
    const unchanged = fs.readFileSync(path.join(scratch.dir, 'quick.save'));
    const refuse = (changeList, re) => assert.throws(() => factions.setRelations(scratch.dir, changeList), re);
    refuse([{ from: targets[0].sid, to: player, relation: 250 }], /between -100 and 100/);
    refuse([{ from: targets[0].sid, to: targets[0].sid, relation: 0 }], /no relation with itself/);
    refuse([{ from: 'not-a-faction', to: player, relation: 0 }], /no faction record/);
    refuse([{ from: targets[0].sid, to: player, relation: '50' }], /must be a number/);
    refuse([
      { from: targets[0].sid, to: player, relation: 10 },
      { from: targets[0].sid, to: player, relation: 20 },
    ], /named twice/);
    refuse([], /no changes given/);
    assert.ok(unchanged.equals(fs.readFileSync(path.join(scratch.dir, 'quick.save'))),
      'a refused batch must leave the save byte-identical');
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

test('a validation failure inside a batch applies none of it', (t) => {
  const src = fixture.fixtureSave();
  if (!src) return t.skip(fixture.NO_FIXTURE);
  if (!hasInstall) return t.skip('no Kenshi install found');

  const before = factions.relationsFor(src.dir);
  const player = before.player.gamedataSid;
  const good = before.factions.find((f) => !f.notReal);

  // The first entry is valid, the second is not. Nothing may be written — the
  // service validates the whole batch before applying any of it, so the caller
  // never has to reason about a partially applied edit.
  assert.throws(() => factions.setRelations(src.dir, [
    { from: good.sid, to: player, relation: 42 },
    { from: good.sid, to: 'nope', relation: 0 },
  ]), /no relation row for/);

  // Read-only check: the fixture on disk is untouched (setRelations returns
  // bytes and never writes, but this is the assertion that says so).
  assert.strictEqual(factions.relationsFor(src.dir).factions.find((f) => f.sid === good.sid).relation,
    good.relation);
});
