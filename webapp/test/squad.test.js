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
const recruits = require('../services/recruits');
const characterFactory = require('../services/characterFactory');
const { readFile } = require('../services/kenshi/codec');
const { asText, fromText, byteLength } = require('../services/kenshi/binary');

/**
 * Squad-level mutations: rename a character, rename the player faction, add a
 * new member. Same discipline as test/mutation.test.js — every write goes
 * through mutationService against a COPY of a real save in a temp directory,
 * never the live one, and every rejection asserts the save is byte-identical
 * afterwards.
 */
const scratchSave = fixture.scratchSave;

/** First player squad file + first character in it, from the FIXTURE. */
function firstPlayerCharacter() {
  const st = fixture.fixtureStatus();
  if (!st) return null;
  const squad = st.squads.find((q) => q.characters.length);
  if (!squad) return null;
  return { platoonFile: squad.file, sid: squad.characters[0].sid, name: squad.characters[0].name, faction: st.world.faction };
}

/** Read one character back out of a save directory by (file, sid). */
function readCharacter(dir, platoonFile, sid) {
  const { characters } = saveService.readPlatoon(path.join(dir, 'platoon', platoonFile));
  return characters.find((c) => c.sid === sid) || null;
}

// ------------------------------------------------------------- encodeName --

test('encodeName round-trips non-ASCII text through latin1 and enforces its limits', () => {
  const { encoded, text } = saveService.encodeName('  Ōkami  ');
  assert.strictEqual(text, 'Ōkami', 'surrounding whitespace is trimmed');
  // The whole point of fromText(): asText() must give the original text back.
  assert.strictEqual(asText(encoded), 'Ōkami');
  assert.strictEqual(encoded, fromText('Ōkami'));
  assert.strictEqual(byteLength('Ōkami'), 6, 'two-byte Ō plus four ASCII');

  assert.throws(() => saveService.encodeName(''), /must not be empty/);
  assert.throws(() => saveService.encodeName('   '), /must not be empty/);
  assert.throws(() => saveService.encodeName(42), /must be a string/);
  assert.throws(() => saveService.encodeName('a\nb'), /control characters/);
  assert.throws(() => saveService.encodeName('a\u0000b'), /control characters/);
  assert.throws(() => saveService.encodeName('x'.repeat(64)), /at most 63 bytes/);
  assert.doesNotThrow(() => saveService.encodeName('x'.repeat(63)));
});

// -------------------------------------------------------- renameCharacter --

test('renameCharacter writes the CHAR_STATE name and the STATS record name', async (t) => {
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);
  const target = firstPlayerCharacter();
  if (!target) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('no player character found'); }

  try {
    const relFile = path.join('platoon', target.platoonFile);
    const before = readFile(fs.readFileSync(path.join(scratch.dir, relFile)));

    const receipt = await mutation.mutate(scratch.dir, 'test: rename',
      (staging) => saveService.renameCharacter(staging, target.platoonFile, target.sid, 'Ōkami'));

    assert.deepStrictEqual(receipt.changedFiles, [relFile], 'a rename touches exactly one file');

    const after = readFile(fs.readFileSync(path.join(scratch.dir, relFile)));
    assert.strictEqual(after.records.length, before.records.length, 'no record added or removed');

    const c = readCharacter(scratch.dir, target.platoonFile, target.sid);
    assert.strictEqual(c.name, 'Ōkami', 'the non-ASCII name survives the latin1 round trip');

    const { records } = saveService.resolveCharacter(scratch.dir, target.platoonFile, target.sid);
    assert.strictEqual(asText(records.stats.name), 'Ōkami', 'the STATS record header name follows the rename');
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

test('renameCharacter rejects an empty, over-long or unchanged name, save byte-identical', async (t) => {
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);
  const target = firstPlayerCharacter();
  if (!target) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('no player character found'); }

  try {
    const before = backups.hashDir(scratch.dir);
    for (const [value, pattern] of [
      ['', /must not be empty/],
      ['x'.repeat(64), /at most 63 bytes/],
      ['bad\nname', /control characters/],
      [target.name, /already named/],
    ]) {
      await assert.rejects(
        mutation.mutate(scratch.dir, 'test: bad rename',
          (staging) => saveService.renameCharacter(staging, target.platoonFile, target.sid, value)),
        pattern,
      );
    }
    assert.deepStrictEqual(backups.hashDir(scratch.dir), before);
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

// ----------------------------------------------------- renamePlayerFaction --

test('renamePlayerFaction rewrites the game state, every squad record and the faction record', async (t) => {
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);
  const target = firstPlayerCharacter();
  if (!target) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('no player character found'); }

  try {
    const oldName = target.faction;
    const before = readFile(fs.readFileSync(path.join(scratch.dir, 'quick.save')));
    const squadsBefore = saveService.playerSquadRecords(before, oldName).length;
    assert.ok(squadsBefore > 0, 'the live save must have at least one player squad record to test with');

    const receipt = await mutation.mutate(scratch.dir, 'test: rename faction',
      (staging) => saveService.renamePlayerFaction(staging, 'The Wolves'));

    assert.deepStrictEqual(receipt.changedFiles, ['quick.save'], 'no platoon file is rewritten by a rename');

    const after = readFile(fs.readFileSync(path.join(scratch.dir, 'quick.save')));
    assert.strictEqual(after.records.length, before.records.length);

    const gs = after.records.find((r) => r.type === saveService.T.GAME_STATE);
    assert.strictEqual(asText(gs.strings.get('pfaction name')), 'The Wolves');
    assert.strictEqual(saveService.playerSquadRecords(after, oldName).length, 0, 'no squad record keeps the old name');
    assert.strictEqual(saveService.playerSquadRecords(after, 'The Wolves').length, squadsBefore);
    assert.strictEqual(
      after.records.filter((r) => r.type === saveService.T.FACTION && asText(r.name) === 'The Wolves').length, 1,
      'the player faction record is renamed too',
    );

    // The whole reason playerPlatoonFiles() resolves through the type-34
    // records: the files are still called <OldFaction>_<n>.platoon on disk, and
    // a prefix match would now find nothing.
    const files = saveService.playerPlatoonFiles(scratch.dir, 'The Wolves');
    assert.ok(files.length > 0, 'the renamed faction still resolves to its platoon files');
    assert.ok(path.basename(files[0]).startsWith(`${oldName}_`), 'filenames are deliberately left alone');

    const st = saveService.status(path.basename(scratch.dir));
    assert.ok(st, 'status() still works — but it reads the LIVE save, so only the shape matters here');
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

test('renamePlayerFaction rejects an unchanged or invalid name, save byte-identical', async (t) => {
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);
  const target = firstPlayerCharacter();
  if (!target) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('no player character found'); }

  try {
    const before = backups.hashDir(scratch.dir);
    for (const [value, pattern] of [
      [target.faction, /already named/],
      ['', /must not be empty/],
      ['x'.repeat(64), /at most 63 bytes/],
    ]) {
      await assert.rejects(
        mutation.mutate(scratch.dir, 'test: bad faction rename',
          (staging) => saveService.renamePlayerFaction(staging, value)),
        pattern,
      );
    }
    assert.deepStrictEqual(backups.hashDir(scratch.dir), before);
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

// ---------------------------------------------------------- availableRaces --

test('availableRaces only lists races this save can supply a living donor for', (t) => {
  const src = fixture.fixtureSave();
  if (!src) return t.skip(fixture.NO_FIXTURE);

  const races = saveService.availableRaces(src.dir);
  assert.ok(races.length > 0, 'a save with characters in it must offer at least one race');
  for (const r of races) {
    assert.ok(r.donors > 0, `${r.name} is listed but has no usable donor`);
    assert.ok(r.count >= r.donors);
    assert.match(r.sid, /-/, 'a race sid is a "<id>-<file>" stringID');
  }
  for (let i = 1; i < races.length; i++) {
    assert.ok(races[i - 1].donors >= races[i].donors, 'most donors first');
  }
  const def = saveService.defaultRace(races);
  assert.ok(races.includes(def), 'the default is one of the offered races');
});

test('defaultRace prefers Greenlander, then Human, then the most populous race', () => {
  const g = { sid: 'a', name: 'Greenlander', count: 1 };
  const h = { sid: 'b', name: 'Human', count: 5 };
  const s = { sid: 'c', name: 'Shek', count: 9 };
  assert.strictEqual(saveService.defaultRace([s, h, g]), g);
  assert.strictEqual(saveService.defaultRace([s, h]), h);
  assert.strictEqual(saveService.defaultRace([s]), s);
  assert.strictEqual(saveService.defaultRace([]), null);
});

// ---------------------------------------------------------------- recruits --

test('every recruit names a real archetype, sub-archetype and power tier', () => {
  assert.strictEqual(recruits.validate(), true);
  const rows = recruits.catalogue();
  assert.ok(rows.length > 0);
  for (const r of rows) {
    assert.ok(r.name && r.archetypeLabel && r.subLabel && r.tierLabel, JSON.stringify(r));
  }
  // roll() is deterministic under an injected rng, like trainCharacter's.
  assert.strictEqual(recruits.roll(() => 0).id, recruits.RECRUITS[0].id);
  assert.strictEqual(recruits.roll(() => 0.999).id, recruits.RECRUITS[recruits.RECRUITS.length - 1].id);
});

// --------------------------------------------------------- addSquadMember --

/** A deterministic rng so a rolled stat spread is reproducible. */
function seededRng(seed = 1) {
  let s = seed;
  return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
}

test('addSquadMember mints a whole character across two files and round-trips', async (t) => {
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);
  const target = firstPlayerCharacter();
  if (!target) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('no player character found'); }

  try {
    const relFile = path.join('platoon', target.platoonFile);
    const before = readFile(fs.readFileSync(path.join(scratch.dir, relFile)));
    const worldBefore = readFile(fs.readFileSync(path.join(scratch.dir, 'quick.save')));
    const squadBefore = before.records.find((r) => r.type === saveService.T.SQUAD);
    const membersBefore = worldBefore.records
      .find((r) => r.type === saveService.T.GAME_STATE).ints.get('members');
    const metaBefore = saveService.squadMetaFor(worldBefore, target.platoonFile);

    const race = saveService.defaultRace(saveService.availableRaces(scratch.dir));
    const receipt = await mutation.mutate(scratch.dir, 'test: add member',
      (staging) => saveService.addSquadMember(staging, target.platoonFile, {
        name: 'Ruka', raceSid: race.sid, archetype: 'soldier', sub: 'unarmed', tier: 'veteran', rng: seededRng(),
      }));

    // Two files, one edit — this is the only mutation in the app that does this.
    assert.deepStrictEqual([...receipt.changedFiles].sort(), ['quick.save', relFile].sort());

    const after = readFile(fs.readFileSync(path.join(scratch.dir, relFile)));
    assert.strictEqual(after.records.length, before.records.length + 6,
      'six state records: CHAR_STATE, AI, INVENTORY, MEDICAL, STATS, APPEARANCE');
    assert.strictEqual(after.header.nextId, before.header.nextId + 7,
      'seven ids: six records plus the squad instance handle');

    // Ids and sids must stay unique within the file — the whole reason
    // nextRecordId() hands out header.nextId + 1 and bumps the header.
    const ids = after.records.map((r) => r.id);
    assert.strictEqual(new Set(ids).size, ids.length, 'no duplicate record id');
    const sids = after.records.map((r) => r.sid);
    assert.strictEqual(new Set(sids).size, sids.length, 'no duplicate record sid');

    const squadAfter = after.records.find((r) => r.type === saveService.T.SQUAD);
    assert.strictEqual(squadAfter.instances.length, squadBefore.instances.length + 1);
    assert.strictEqual(squadAfter.ints.get('char count'), squadBefore.ints.get('char count') + 1);
    // 23 of 25 live squad records carry instanceCount 0 against real instances;
    // addInstance() must leave a disagreeing count exactly as it found it.
    assert.strictEqual(squadAfter.instanceCount, squadBefore.instanceCount,
      'a squad record whose instanceCount already disagreed is not "corrected"');
    const handles = squadAfter.instances.map((i) => i.id);
    assert.strictEqual(new Set(handles).size, handles.length, 'no duplicate instance handle');
    assert.ok(!sids.includes(handles[handles.length - 1]),
      'a character instance handle is not any record\'s sid');

    // The new member reads back as a complete, healthy, empty-handed character.
    const c = readCharacter(scratch.dir, target.platoonFile, receipt.receipts[0].character.sid);
    assert.ok(c, 'the new member resolves through the normal squad -> instance -> states path');
    assert.strictEqual(c.name, 'Ruka');
    assert.strictEqual(c.isLeader, false, 'a new member never arrives as the squad leader');
    assert.strictEqual(c.inventory.length, 0, 'a new member carries nothing');
    assert.strictEqual(c.medical.dead, false);
    assert.strictEqual(c.medical.coma, false);
    assert.strictEqual(c.medical.incapacitated, false);
    assert.strictEqual(c.medical.limbs, null, 'the undecoded limbs bitmask is cleared, not copied');
    assert.ok(c.medical.parts.length > 0, 'the donor\'s body plan came across');
    for (const p of c.medical.parts) {
      assert.strictEqual(p.percentOfIntact, 100, `${p.part} should be undamaged`);
      assert.strictEqual(p.bandage, 0);
      assert.strictEqual(p.stun, 0);
    }
    // Veteran tier: attributes flat 50, archetype skills 55-80, others 15-40.
    for (const v of Object.values(c.stats.attributes)) assert.strictEqual(v, 50);
    const unarmed = c.stats.skills.find((s) => s.skill === 'unarmed');
    assert.ok(unarmed.level >= 55 && unarmed.level <= 80, `unarmed rolled ${unarmed.level}`);

    // Its APPEARANCE record still declares the requested race.
    const ctx = saveService.resolveCharacter(scratch.dir, target.platoonFile, c.sid);
    const appearance = ctx.instance.states.map((s) => ctx.bySid.get(s))
      .find((r) => r && r.type === saveService.T.APPEARANCE);
    assert.strictEqual(appearance.extra.get('race')[0].target, race.sid);

    // No bounty survived the clone.
    const stateRec = ctx.records.state;
    for (const key of stateRec.ints.keys()) assert.doesNotMatch(key, /^(amount|bountyexp|claim|crimes)\d+$/);
    for (const key of stateRec.strings.keys()) assert.doesNotMatch(key, /^bountyfac\d+$/);

    // quick.save's two counters moved in lockstep with the platoon's.
    const worldAfter = readFile(fs.readFileSync(path.join(scratch.dir, 'quick.save')));
    assert.strictEqual(worldAfter.records.length, worldBefore.records.length, 'quick.save gains no record');
    assert.strictEqual(
      worldAfter.records.find((r) => r.type === saveService.T.GAME_STATE).ints.get('members'),
      membersBefore + 1,
    );
    const metaAfter = saveService.squadMetaFor(worldAfter, target.platoonFile);
    assert.strictEqual(metaAfter.ints.get('char count'), metaBefore.ints.get('char count') + 1);
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

test('addSquadMember rejects a bad name, unknown archetype, unknown tier and unavailable race, save byte-identical', async (t) => {
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);
  const target = firstPlayerCharacter();
  if (!target) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('no player character found'); }

  try {
    const race = saveService.defaultRace(saveService.availableRaces(scratch.dir));
    const base = { name: 'Ruka', raceSid: race.sid, archetype: 'soldier', sub: 'unarmed' };
    const before = backups.hashDir(scratch.dir);

    for (const [patch, pattern] of [
      [{ name: '' }, /must not be empty/],
      [{ name: 'x'.repeat(64) }, /at most 63 bytes/],
      [{ archetype: 'wizard' }, /unknown archetype/],
      [{ sub: 'fireballs' }, /unknown sub-archetype/],
      [{ tier: 'godlike' }, /unknown power tier/],
      [{ raceSid: '' }, /raceSid must be a non-empty string/],
      [{ raceSid: '99999-not-a-real.mod' }, /no healthy .* character exists/],
    ]) {
      await assert.rejects(
        mutation.mutate(scratch.dir, 'test: bad add',
          (staging) => saveService.addSquadMember(staging, target.platoonFile, { ...base, ...patch })),
        pattern,
        JSON.stringify(patch),
      );
    }
    // An invalid platoon file must be rejected before anything is written —
    // `:file` comes straight off the URL (see resolveSquad's path guard).
    await assert.rejects(
      mutation.mutate(scratch.dir, 'test: path escape',
        (staging) => saveService.addSquadMember(staging, '../quick.save', base)),
      /invalid platoon file name/,
    );

    assert.deepStrictEqual(backups.hashDir(scratch.dir), before);
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

test('characterFactory refuses a donor missing any of the six state records', () => {
  const src = fixture.fixtureSave();
  if (!src) return;
  assert.throws(
    () => characterFactory.buildStateRecords([], { name: 'Nobody' }),
    /missing state record type/,
  );
  assert.throws(
    () => characterFactory.buildStateRecords([], {}),
    /name is required/,
  );
});

// ----------------------------------------------------- personality/dialogue --

test('the personality integers decode to the seven traits the game uses', () => {
  const personalities = require('../services/personalities');
  const rows = personalities.catalogue();
  assert.strictEqual(rows.length, 7);
  // Decoded from gamedata's type-26 records, each single-trait record's
  // `always` tag naming its value. Pinned here because it is derived, not
  // editorial — if it ever changes, the evidence must change with it.
  assert.deepStrictEqual(
    Object.fromEntries(rows.map((p) => [p.value, p.label])),
    { 1: 'Honorable', 2: 'Traitorous', 5: 'Smart', 6: 'Dumb', 9: 'Brave', 10: 'Fearful', 14: 'Crazy' },
  );
  assert.strictEqual(personalities.label(9), 'Brave');
  assert.strictEqual(personalities.label(3), 'unknown (3)');
  assert.strictEqual(personalities.label(null), 'none');
  assert.ok(personalities.isKnown(14) && !personalities.isKnown(11));
});

test('every personality in the live save is one of the seven', (t) => {
  const src = fixture.fixtureSave();
  if (!src) return t.skip(fixture.NO_FIXTURE);
  const personalities = require('../services/personalities');
  const pdir = path.join(src.dir, 'platoon');
  if (!fs.existsSync(pdir)) return t.skip('no platoon directory');

  const seen = new Set();
  for (const f of fs.readdirSync(pdir).filter((n) => n.endsWith('.platoon'))) {
    const { characters } = saveService.readPlatoon(path.join(pdir, f));
    for (const c of characters) if (c.personality != null) seen.add(c.personality);
  }
  assert.ok(seen.size > 0, 'no personalities found');
  // The decisive evidence for the mapping: gamedata's "Random" personality
  // record lists exactly these seven as its `common` tags, and the game writes
  // no others. If a save ever shows an eighth, the decode is incomplete.
  for (const v of seen) {
    assert.ok(personalities.isKnown(v), `personality ${v} occurs in the save but is not decoded`);
  }
});

test('setPersonality writes one int and refuses the values the game never uses', async (t) => {
  const scratch = scratchSave();
  if (!scratch) return t.skip(fixture.NO_FIXTURE);
  const target = firstPlayerCharacter();
  if (!target) { fs.rmSync(scratch.root, { recursive: true, force: true }); return t.skip('no player character found'); }

  try {
    const relFile = path.join('platoon', target.platoonFile);
    const before = readFile(fs.readFileSync(path.join(scratch.dir, relFile)));
    const current = saveService.resolveCharacter(scratch.dir, target.platoonFile, target.sid)
      .records.state.ints.get('personality');
    const next = current === 14 ? 9 : 14;

    const receipt = await mutation.mutate(scratch.dir, 'test: personality',
      (staging) => saveService.setPersonality(staging, target.platoonFile, target.sid, next));
    assert.deepStrictEqual(receipt.changedFiles, [relFile]);

    const after = readFile(fs.readFileSync(path.join(scratch.dir, relFile)));
    assert.strictEqual(after.records.length, before.records.length);
    const { records } = saveService.resolveCharacter(scratch.dir, target.platoonFile, target.sid);
    assert.strictEqual(records.state.ints.get('personality'), next);
    // Exactly one int changed — no other key touched, order preserved.
    assert.deepStrictEqual([...records.state.ints.keys()],
      [...before.records.find((r) => r.sid === records.state.sid).ints.keys()]);

    const hashes = backups.hashDir(scratch.dir);
    for (const [value, pattern] of [[3, /not one of the values/], [11, /not one of the values/], [next, /already/]]) {
      await assert.rejects(
        mutation.mutate(scratch.dir, 'test: bad personality',
          (staging) => saveService.setPersonality(staging, target.platoonFile, target.sid, value)),
        pattern,
      );
    }
    assert.deepStrictEqual(backups.hashDir(scratch.dir), hashes);
  } finally {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    paths.setOverrides({});
  }
});

test('dialogue is reported from the origin template and is never writable', (t) => {
  const squad = fixture.fixtureSquad();
  if (!squad) return t.skip('no player squad');

  // The investigation result this encodes: a CHAR_STATE record carries NO
  // dialogue reference of any kind. Dialogue hangs off the type-1 character
  // template in gamedata, reached through the squad instance's `target`. So the
  // editor reports it and offers no setter — and there must not be one.
  assert.strictEqual(typeof saveService.setPersonality, 'function');
  assert.strictEqual(saveService.setDialogue, undefined,
    'dialogue is not writable from a save; do not add a setter without new evidence');

  for (const c of squad.characters) {
    if (!c.dialogue) continue; // origin is not a character template (an animal)
    assert.strictEqual(typeof c.dialogue.template, 'string');
    assert.ok(Array.isArray(c.dialogue.packages) && Array.isArray(c.dialogue.playerPackages));
    assert.strictEqual(c.dialogue.talksToPlayer, c.dialogue.playerPackages.length > 0);
  }
  // And confirm the save side really is empty of dialogue, rather than us
  // simply not having looked: no CHAR_STATE string key mentions it.
  const src = fixture.fixtureSave();
  const pdir = path.join(src.dir, 'platoon');
  for (const f of fs.readdirSync(pdir).filter((n) => n.endsWith('.platoon'))) {
    const parsed = readFile(fs.readFileSync(path.join(pdir, f)));
    for (const r of parsed.records) {
      if (r.type !== saveService.T.CHAR_STATE) continue;
      for (const k of r.strings.keys()) {
        assert.doesNotMatch(k, /dialog|voice|package/i,
          `CHAR_STATE carries "${k}" — dialogue may be save-side after all, re-investigate`);
      }
    }
  }
});
