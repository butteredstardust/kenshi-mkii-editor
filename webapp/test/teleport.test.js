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
const locations = require('../services/locationsService');
const recruits = require('../services/recruits');
const { readFile } = require('../services/kenshi/codec');

const scratchSave = fixture.scratchSave;

// From the FIXTURE, never `status(name)` — that resolves the name against the
// player's live save folder (see fixture.fixtureStatus()).
const playerSquad = fixture.fixtureSquad;

// ------------------------------------------------------------- catalogue --

test('the location catalogue only carries real world positions', (t) => {
  const all = locations.all();
  if (!all.length) return t.skip('no Kenshi install found');

  for (const l of all) {
    assert.ok(l.id && l.name && l.label, JSON.stringify(l));
    for (const k of ['x', 'y', 'z']) {
      assert.ok(Number.isFinite(l[k]), `${l.name}.${k} is not finite`);
    }
    // The sentinel-height placements in the root leveldata.level are dropped,
    // not merely deprioritised — they are a different, unusable list (see
    // services/locationsService.js).
    assert.ok(l.y > 0, `${l.name} has a sentinel height (${l.y})`);
  }

  const ids = all.map((l) => l.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'location ids must be unique');

  // Towns sharing a name must be genuinely different places, far enough apart
  // that they are not the same town listed twice by two mods.
  const byName = new Map();
  for (const l of all) {
    if (!byName.has(l.name)) byName.set(l.name, []);
    byName.get(l.name).push(l);
  }
  for (const [name, list] of byName) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const d = Math.hypot(list[i].x - list[j].x, list[i].z - list[j].z);
        assert.ok(d > locations.SAME_PLACE, `two "${name}" placements are only ${Math.round(d)} apart — should have been deduped`);
      }
    }
  }
});

test('catalogued town positions agree with where the save says those towns are', (t) => {
  const src = fixture.fixtureSave();
  if (!src || !locations.all().length) return t.skip('no save or no install');

  // Ground truth: NPC squads that name a town as their `basetown`. Their
  // centroid is an honest "where is this town really", independent of the
  // placement data this catalogue is built from.
  const world = readFile(fs.readFileSync(path.join(src.dir, 'quick.save')));
  const gamedata = require('../services/gamedataService');
  const { asText } = require('../services/kenshi/binary');
  const byTown = new Map();
  for (const r of world.records) {
    if (r.type !== saveService.T.SQUAD_META || !r.vec3.get('position')) continue;
    const bt = asText(r.strings.get('basetown') || '');
    const nm = bt ? gamedata.nameOf(bt, null) : null;
    if (!nm) continue;
    if (!byTown.has(nm)) byTown.set(nm, []);
    byTown.get(nm).push(r.vec3.get('position'));
  }

  // Only towns with a real garrison are usable as ground truth. A single squad
  // naming a town as home proves nothing about where that town is — it may be
  // halfway across the world on a job, and one in this save is: the lone squad
  // based at Telbooze is currently standing in Trader's Edge, 17.7 km away.
  // Three or more squads agreeing is a settlement, not a patrol.
  const GARRISON = 3;
  let checked = 0;
  for (const [town, list] of byTown) {
    if (list.length < GARRISON) continue;
    const loc = locations.findByName(town);
    if (!loc) continue;
    const cx = list.reduce((a, p) => a + p[0], 0) / list.length;
    const cz = list.reduce((a, p) => a + p[2], 0) / list.length;
    const d = Math.hypot(cx - loc.x, cz - loc.z);
    // 5000 units is comfortably "the same town" — the verified cases land
    // within 99, 394 and 871.
    assert.ok(d < 5000, `${town}: catalogue says ${Math.round(loc.x)},${Math.round(loc.z)} but its ${list.length} squads average ${Math.round(d)} away`);
    checked++;
  }
  assert.ok(checked > 0, 'no garrisoned town could be cross-checked against the save');
});

test('recruit locations resolve against the towns this install actually has', () => {
  for (const r of recruits.catalogue()) {
    assert.ok(Array.isArray(r.where), `${r.name} has no where[]`);
    assert.ok(Array.isArray(r.locations));
    assert.ok(Array.isArray(r.unresolvedLocations));
    assert.strictEqual(r.locations.length + r.unresolvedLocations.length, r.where.length,
      'every listed place is either resolved or reported unresolved — never silently dropped');
    for (const l of r.locations) assert.ok(locations.find(l.id), `${r.name} -> ${l.id} is not a real location id`);
    // Every recruit should be findable somewhere in this install, or the
    // "possible locations" mapping is not carrying its weight.
    assert.ok(r.locations.length > 0, `${r.name} resolves to nowhere in this install`);
  }
});

// -------------------------------------------------------------- teleport --

test('teleportSquad moves every character and the squad marker together', async (t) => {
  const squad = playerSquad();
  const dest = locations.all()[0];
  if (!squad || !dest) return t.skip('no player squad or no locations');
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);

  try {
    const relFile = path.join('platoon', squad.file);
    const before = readFile(fs.readFileSync(path.join(scratch.dir, relFile)));

    const receipt = await mutation.mutate(scratch.dir, 'test: teleport',
      (staging) => saveService.teleportSquad(staging, squad.file,
        { x: dest.x, y: dest.y, z: dest.z, label: dest.label }));

    assert.ok(receipt.changedFiles.includes(relFile));
    assert.ok(receipt.changedFiles.includes('quick.save'), 'the squad marker lives in quick.save and must move too');

    const after = readFile(fs.readFileSync(path.join(scratch.dir, relFile)));
    assert.strictEqual(after.records.length, before.records.length, 'a teleport adds no record');

    const { characters } = saveService.readPlatoon(path.join(scratch.dir, 'platoon', squad.file));
    assert.strictEqual(characters.length, squad.characters.length);
    for (const c of characters) {
      const d = Math.hypot(c.position[0] - dest.x, c.position[2] - dest.z);
      assert.ok(d <= 40, `${c.name} landed ${Math.round(d)} from the destination`);
      assert.strictEqual(Math.round(c.position[1]), Math.round(dest.y));
    }
    // Placed on a ring, not stacked on one point.
    const spots = new Set(characters.map((c) => `${c.position[0]},${c.position[2]}`));
    assert.strictEqual(spots.size, characters.length, 'characters must not be stacked at one exact point');

    const world = readFile(fs.readFileSync(path.join(scratch.dir, 'quick.save')));
    const meta = saveService.squadMetaFor(world, squad.file);
    assert.deepStrictEqual(
      meta.vec3.get('position').map((n) => Math.round(n)),
      [dest.x, dest.y, dest.z].map((n) => Math.round(n)),
    );
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

test('teleportSquad can move part of a squad, and rejects bad input byte-identically', async (t) => {
  const squad = playerSquad();
  const dest = locations.all()[0];
  if (!squad || squad.characters.length < 2 || !dest) return t.skip('need a squad of 2+ and a location');
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);

  try {
    const one = squad.characters[0];
    const other = squad.characters[1];
    await mutation.mutate(scratch.dir, 'test: partial teleport',
      (staging) => saveService.teleportSquad(staging, squad.file,
        { x: dest.x, y: dest.y, z: dest.z, sids: [one.sid] }));

    const { characters } = saveService.readPlatoon(path.join(scratch.dir, 'platoon', squad.file));
    const movedNow = characters.find((c) => c.sid === one.sid);
    const stayed = characters.find((c) => c.sid === other.sid);
    assert.ok(Math.hypot(movedNow.position[0] - dest.x, movedNow.position[2] - dest.z) <= 40);
    assert.deepStrictEqual(stayed.position.map(Math.round), other.position.map(Math.round),
      'a character not named in sids must not move');

    const before = backups.hashDir(scratch.dir);
    for (const [opts, pattern] of [
      [{ x: 'nope', y: 0, z: 0 }, /"x" must be a finite number/],
      [{ x: 1, y: NaN, z: 0 }, /"y" must be a finite number/],
      [{ x: 1, y: 1, z: 1, sids: [] }, /must be a non-empty array/],
      [{ x: 1, y: 1, z: 1, sids: ['not-a-real-sid'] }, /no character with sid/],
    ]) {
      await assert.rejects(
        mutation.mutate(scratch.dir, 'test: bad teleport',
          (staging) => saveService.teleportSquad(staging, squad.file, opts)),
        pattern,
      );
    }
    await assert.rejects(
      mutation.mutate(scratch.dir, 'test: path escape',
        (staging) => saveService.teleportSquad(staging, '../quick.save', { x: 1, y: 1, z: 1 })),
      /invalid platoon file name/,
    );
    assert.deepStrictEqual(backups.hashDir(scratch.dir), before);
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

// ------------------------------------------------------- backpack contents --

test('a worn backpack reports the contents of its own inventory record', (t) => {
  const src = fixture.fixtureSave();
  if (!src) return t.skip(fixture.NO_FIXTURE);
  const pdir = path.join(src.dir, 'platoon');
  if (!fs.existsSync(pdir)) return t.skip('no platoon directory');

  let packsSeen = 0;
  let withContents = 0;
  for (const f of fs.readdirSync(pdir).filter((n) => n.endsWith('.platoon'))) {
    const { characters } = saveService.readPlatoon(path.join(pdir, f));
    for (const c of characters) {
      for (const it of c.inventory) {
        assert.ok(Array.isArray(it.contents), 'every item reports a contents array');
        if (it.section !== 'backpack_attach') {
          assert.strictEqual(it.contents.length, 0, `${it.name} is not a pack but reports contents`);
          continue;
        }
        packsSeen++;
        if (!it.contents.length) continue;
        withContents++;
        assert.ok(it.containerSid, 'a pack with contents must name the container it read them from');
        for (const inner of it.contents) {
          assert.strictEqual(inner.section, 'backpack_content',
            'anything inside a pack is sectioned backpack_content');
          assert.ok(inner.sid && inner.name);
        }
      }
    }
  }
  if (!packsSeen) return t.skip('no character in this save wears a backpack');
  assert.ok(withContents > 0,
    'no pack reported contents — the second hop through the pack\'s own inventory record is not being followed');
});

// ------------------------------------------------------- names & recruits --

test('random names come from Kenshi\'s own name files', (t) => {
  const names = require('../services/names');
  const s = names.stats();
  if (!s.total) return t.skip('no Kenshi install / name files found');
  assert.ok(s.male > 0 && s.female > 0 && s.any > 0, `expected all three pools: ${JSON.stringify(s)}`);

  // Deterministic under an injected rng, same discipline as recruits.roll().
  assert.strictEqual(names.random({ rng: () => 0 }), names.random({ rng: () => 0 }));
  const n = names.random();
  assert.ok(n && typeof n === 'string' && n.trim() === n && !n.includes('\n'));

  // `avoid` must actually avoid.
  const first = names.random({ rng: () => 0 });
  assert.notStrictEqual(names.random({ rng: () => 0, avoid: [first] }), first);
  // Every name taken is not an error — it repeats rather than returning null.
  const pool = [];
  for (let i = 0; i < 400; i++) pool.push(names.random());
  assert.ok(pool.every(Boolean));
});

test('recruits are grouped, and every group offers a real choice', () => {
  assert.strictEqual(recruits.validate(), true);
  const rows = recruits.catalogue();
  assert.ok(rows.length >= 45, `expected 45+ recruits, got ${rows.length}`);

  const byGroup = new Map();
  for (const r of rows) {
    assert.ok(r.group && r.groupLabel, `${r.name} has no group`);
    byGroup.set(r.group, (byGroup.get(r.group) || 0) + 1);
  }
  assert.ok(byGroup.size >= 8, `expected 8+ groups, got ${byGroup.size}`);
  for (const [g, n] of byGroup) {
    assert.ok(n >= 4 && n <= 6, `group "${g}" has ${n} recruits; each should offer 4-5`);
  }

  // The groups the user asked for by name must exist.
  const labels = new Set(rows.map((r) => r.group));
  for (const g of ['explorer', 'trader', 'soldier', 'medic']) {
    assert.ok(labels.has(g), `no "${g}" group`);
  }

  // Races are matched as substrings against the save's own race names, so a
  // typo would silently fall back to the default race rather than erroring.
  const RACE_HINTS = ['human', 'shek', 'skeleton', 'sundemon', 'hive worker', 'hive soldier'];
  for (const r of rows) {
    assert.ok(RACE_HINTS.includes(r.race), `${r.name} has unrecognised race hint "${r.race}"`);
  }
});
