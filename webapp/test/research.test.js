'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const paths = require('../services/pathService');
const research = require('../services/researchService');
const { readFile } = require('../services/kenshi/codec');
const { asText } = require('../services/kenshi/binary');

/**
 * Research lives in ONE type-21 record in quick.save, and unlock() returns
 * bytes rather than writing them (the setPlayerMoney contract). That makes the
 * whole write path testable WITHOUT the mutation gate: compute the bytes,
 * re-parse them in memory, and assert on the result. These tests therefore run
 * even while Kenshi is open, and they never touch a save on disk.
 */
const hasInstall = !!paths.installDir();
const save = paths.latestSave();

const parseSave = (dir) => readFile(fs.readFileSync(path.join(dir, 'quick.save')));

test('the tech tree resolves in the game\'s own mod load order', (t) => {
  if (!hasInstall) return t.skip('no Kenshi install found');
  const all = research.catalogue();
  assert.ok(all.length > 100, `only ${all.length} techs resolved`);

  const sids = all.map((x) => x.sid);
  assert.strictEqual(new Set(sids).size, sids.length, 'tech sids must be unique');

  for (const tech of all) {
    assert.ok(tech.name && tech.name !== tech.sid, `${tech.sid} has no resolved name`);
    assert.ok(tech.category, `"${tech.name}" has no category`);
    assert.ok(tech.repeats >= 0 && Number.isInteger(tech.repeats), `"${tech.name}" repeats=${tech.repeats}`);
    // A requirement must be another tech, never a dangling sid — the tree is
    // rendered as a dependency graph and a broken edge would be invisible.
    for (const r of tech.requirements) {
      assert.ok(sids.includes(r.sid), `"${tech.name}" requires unknown tech ${r.sid}`);
      assert.ok(r.name && r.name !== r.sid, `requirement ${r.sid} has no name`);
    }
  }

  // Load order is not cosmetic: most techs are defined more than once.
  assert.ok(research.stats().multiDefinition > 50,
    'expected many multi-definition techs — is the load-order sweep actually running?');

  // mods.cfg drives it, base data first.
  const files = research.filesInLoadOrder();
  assert.ok(files.length > 1);
  assert.ok(!path.basename(files[0]).endsWith('.mod'), `base data must load first, got ${path.basename(files[0])}`);
});

test('FCS boilerplate is classified but kept out of the tree', (t) => {
  if (!hasInstall || !save) return t.skip('no install or save');
  // RESEARCH_TEMPLATE is the blank an FCS user copies to make a new tech: no
  // description, no cost, nothing to unlock, and a literal sid instead of the
  // `<id>-<file>` shape every authored record has. The game marks it finished
  // in every save. It must not appear as a researchable row, and it must not
  // fall through to "unrecognised" either.
  assert.ok(!research.catalogue().some((x) => x.sid === 'RESEARCH_TEMPLATE'),
    'RESEARCH_TEMPLATE is being offered as a researchable tech');
  const known = new Map(research.catalogue().map((x) => [x.sid, x]));
  assert.strictEqual(research.classify('RESEARCH_TEMPLATE', known).kind, 'reserved');
  assert.strictEqual(research.statusFor(save.dir).counts.reserved, 1);
  // Every other tech does have an authored sid.
  for (const tech of research.catalogue()) {
    assert.ok(tech.sid.includes('-'), `${tech.sid} looks like engine boilerplate, not a tech`);
  }
});

test('THE INVARIANT: a resolved tech can hold every level the save recorded for it', (t) => {
  if (!hasInstall || !save) return t.skip('no install or save');
  // This is what proves load-order resolution is right rather than merely
  // plausible. `repeats` is the number of levels a tech has; the ledger records
  // levels the player actually researched. If resolution picked the wrong
  // definition, a ledger level would exceed its tech's capacity. Under
  // first-definition-wins this fails on "Weapon Smithing"/"Basic Weapon
  // Grades" (repeats 14 vs 5) — see services/researchService.js.
  const st = research.statusFor(save.dir);
  for (const tech of st.techs) {
    assert.ok(tech.atLevel <= tech.maxLevel,
      `"${tech.name}" is at level ${tech.atLevel} but resolves to only ${tech.maxLevel} level(s)`);
  }
  assert.ok(st.counts.done > 0, 'no finished research at all — is the ledger being read?');
});

test('every ledger entry classifies — nothing is silently ignored', (t) => {
  if (!hasInstall || !save) return t.skip('no install or save');
  for (const s of paths.listSaves()) {
    const st = research.statusFor(s.dir);
    assert.strictEqual(st.counts.unknown, 0,
      `${s.name} has ${st.counts.unknown} unrecognised ledger entries`);
    // The three shapes must account for every row exactly once.
    const rec = research.ledgerRecord(parseSave(s.dir));
    const entries = research.entriesOf(rec);
    assert.strictEqual(entries.length, st.counts.entries);
    assert.strictEqual(new Set(entries).size, entries.length, `${s.name} has duplicate ledger entries`);
    // `num finished` is the count, and the keys are contiguous.
    assert.strictEqual(rec.floats.get('num finished'), entries.length,
      `${s.name}: "num finished" disagrees with the number of finished<N> keys`);
    const idx = [...rec.strings.keys()].map((k) => Number(k.slice('finished'.length))).sort((a, b) => a - b);
    assert.deepStrictEqual(idx, idx.map((_, i) => i), `${s.name}: finished<N> keys are not contiguous from 0`);
  }
});

test('a `.N` suffix only ever means a repeat level', (t) => {
  if (!hasInstall || !save) return t.skip('no install or save');
  const known = new Map(research.catalogue().map((x) => [x.sid, x]));
  const rec = research.ledgerRecord(parseSave(save.dir));
  let levelled = 0;
  for (const entry of research.entriesOf(rec)) {
    const c = research.classify(entry, known);
    if (c.kind !== 'tech' || c.level === 1) continue;
    levelled++;
    const tech = known.get(c.sid);
    assert.ok(tech.repeats > 0,
      `"${tech.name}" has a level-${c.level} entry but repeats=0 — the .N reading is wrong`);
    assert.ok(c.level >= 2 && c.level <= tech.repeats);
  }
  assert.ok(levelled > 0, 'expected at least one repeat-level entry in this save');
});

test('a `.TECH.N` entry is an item blueprint, never a tech', (t) => {
  if (!hasInstall || !save) return t.skip('no install or save');
  const known = new Map(research.catalogue().map((x) => [x.sid, x]));
  const rec = research.ledgerRecord(parseSave(save.dir));
  let blueprints = 0;
  for (const entry of research.entriesOf(rec)) {
    const c = research.classify(entry, known);
    if (c.kind !== 'blueprint') continue;
    blueprints++;
    assert.ok(!known.has(c.sid), `${entry} strips to a real tech — the .TECH.N reading is wrong`);
  }
  assert.strictEqual(blueprints, research.statusFor(save.dir).counts.blueprints);
});

test('unlock() appends without disturbing a single existing entry', (t) => {
  if (!hasInstall || !save) return t.skip('no install or save');
  const before = research.statusFor(save.dir);
  const target = before.techs.find((x) => !x.done);
  if (!target) return t.skip('this save has finished everything');

  const res = research.unlock(save.dir, { sids: [target.sid] });
  const after = readFile(res.bytes);
  const rec = research.ledgerRecord(after);
  const entries = research.entriesOf(rec);

  // Everything that was there is still there, in the same order.
  const original = research.entriesOf(research.ledgerRecord(parseSave(save.dir)));
  assert.deepStrictEqual(entries.slice(0, original.length), original,
    'unlock() reordered or rewrote existing ledger entries');
  assert.strictEqual(entries.length, original.length + res.added.length);
  assert.strictEqual(rec.floats.get('num finished'), entries.length);
  assert.strictEqual(new Set(entries).size, entries.length, 'unlock() introduced a duplicate');

  // The record's own shape is untouched: no new sections, no instances.
  assert.strictEqual(rec.extra.size, 0);
  assert.strictEqual(rec.instances.length, 0);
  assert.strictEqual(rec.ints.size, 0);
  assert.deepStrictEqual([...rec.floats.keys()], ['num finished', 'num currents']);
  assert.strictEqual(rec.floats.get('num currents'), 0);

  // ...and the tech now reads back as done.
  const st = research.statusFor(save.dir, after);
  assert.ok(st.techs.find((x) => x.sid === target.sid).done);
  assert.strictEqual(st.counts.done, before.counts.done + res.added.filter((a) => a.level === 1).length);
  // Untouched dimensions stay untouched.
  assert.strictEqual(st.counts.blueprints, before.counts.blueprints);
  assert.strictEqual(st.counts.unknown, 0);

  // The save on disk was never written to — unlock() only returns bytes.
  assert.deepStrictEqual(research.entriesOf(research.ledgerRecord(parseSave(save.dir))), original);
});

test('unlocking a repeating tech writes the bare sid plus every level below', (t) => {
  if (!hasInstall || !save) return t.skip('no install or save');
  const tech = research.catalogue().find((x) => x.repeats >= 3);
  if (!tech) return t.skip('no repeating tech in this install');
  const st = research.statusFor(save.dir);
  const live = st.techs.find((x) => x.sid === tech.sid);
  if (live.maxed) {
    // Already maxed here, so prove the shape on the fresh save instead.
    const fresh = paths.listSaves().find((s) => research.statusFor(s.dir).counts.done <= 1);
    if (!fresh) return t.skip('no save with this tech unresearched');
    const res = research.unlock(fresh.dir, { sids: [tech.sid], withRequirements: false });
    const got = res.added.map((a) => a.entry).sort();
    const want = [tech.sid, ...Array.from({ length: tech.repeats - 1 }, (_, i) => `${tech.sid}.${i + 2}`)].sort();
    return assert.deepStrictEqual(got, want);
  }
  const res = research.unlock(save.dir, { sids: [tech.sid], withRequirements: false });
  for (const a of res.added) assert.ok(a.level >= 1 && a.level <= tech.repeats);
  return assert.strictEqual(res.added[res.added.length - 1].level, tech.repeats, 'did not reach the top level');
});

test('`levels` caps a repeating tech, and out-of-range is rejected', (t) => {
  if (!hasInstall || !save) return t.skip('no install or save');
  const fresh = paths.listSaves().find((s) => research.statusFor(s.dir).counts.done <= 1);
  const tech = research.catalogue().find((x) => x.repeats >= 3 && !x.requirements.length);
  if (!fresh || !tech) return t.skip('needs a fresh save and an unconditioned repeating tech');

  const res = research.unlock(fresh.dir, { sids: [tech.sid], levels: { [tech.sid]: 2 }, withRequirements: false });
  assert.deepStrictEqual(res.added.map((a) => a.entry), [tech.sid, `${tech.sid}.2`]);

  assert.throws(() => research.unlock(fresh.dir, { sids: [tech.sid], levels: { [tech.sid]: tech.repeats + 1 } }),
    /levels 1\.\./);
  return assert.throws(() => research.unlock(fresh.dir, { sids: [tech.sid], levels: { [tech.sid]: 0 } }), /levels 1\.\./);
});

test('withRequirements pulls in unfinished prerequisites, and off leaves them', (t) => {
  if (!hasInstall) return t.skip('no Kenshi install found');
  const fresh = paths.listSaves().find((s) => research.statusFor(s.dir).counts.done <= 1);
  const tech = research.catalogue().find((x) => x.requirements.length && x.repeats === 0);
  if (!fresh || !tech) return t.skip('needs a fresh save and a tech with requirements');

  const withReqs = research.unlock(fresh.dir, { sids: [tech.sid], withRequirements: true });
  const without = research.unlock(fresh.dir, { sids: [tech.sid], withRequirements: false });
  assert.deepStrictEqual(without.added.map((a) => a.entry), [tech.sid]);
  assert.ok(withReqs.added.length > without.added.length, 'requirements were not pulled in');
  for (const r of tech.requirements) {
    assert.ok(withReqs.added.some((a) => a.sid === r.sid), `prerequisite "${r.name}" was not included`);
  }
  // And the resulting save has no tech marked done while a prerequisite is not.
  const st = research.statusFor(fresh.dir, readFile(withReqs.bytes));
  const done = st.techs.find((x) => x.sid === tech.sid);
  assert.ok(done.done && done.blockedBy.length === 0, `"${tech.name}" is done but still blocked by ${done.blockedBy}`);
});

test('unlock() rejects rather than writing a no-op or a bad sid', (t) => {
  if (!hasInstall || !save) return t.skip('no install or save');
  const st = research.statusFor(save.dir);
  const maxed = st.techs.find((x) => x.maxed);
  assert.throws(() => research.unlock(save.dir, { sids: [] }), /no research techs given/);
  assert.throws(() => research.unlock(save.dir, { sids: ['not-a-real-sid'] }), /unknown research tech/);
  if (maxed) assert.throws(() => research.unlock(save.dir, { sids: [maxed.sid] }), /already finished/);
});

test('the ledger is the only research state in the save', (t) => {
  if (!save) return t.skip('no save found');
  // If some other record also tracked research, unlocking would be half a fix.
  // Nothing else in quick.save mentions it — this is what makes a one-record
  // edit the complete operation.
  const world = parseSave(save.dir);
  const others = [];
  for (const rec of world.records) {
    if (rec.type === 21) continue;
    for (const k of [...rec.strings.keys(), ...rec.ints.keys(), ...rec.floats.keys(), ...rec.extra.keys()]) {
      if (/finish|research|tech/i.test(k)) { others.push(`type ${rec.type} ${k}`); break; }
    }
  }
  assert.deepStrictEqual(others, [], `other records also hold research state: ${others.join(', ')}`);
  assert.strictEqual(world.records.filter((r) => r.type === 21).length, 1);
  // ...and the record carries no name, which is why it is found by type.
  assert.strictEqual(asText(research.ledgerRecord(world).name), '0');
});
