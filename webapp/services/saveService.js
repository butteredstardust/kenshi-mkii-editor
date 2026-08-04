'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { readFile, writeFile } = require('./kenshi/codec');
const { asText } = require('./kenshi/binary');
const paths = require('./pathService');
const gamedata = require('./gamedataService');
const archetypes = require('./archetypes');
const itemCatalog = require('./itemCatalogService');
const itemSlots = require('./itemSlots');
const itemFactory = require('./itemFactory');
const ids = require('./kenshi/ids');

/**
 * Domain model over a Kenshi save directory.
 *
 * A save is a directory, not a file:
 *   quick.save              world state, factions, town states, the player record
 *   platoon/<Faction>_<n>   squads: characters, stats, medical, inventories
 *   zone/*.zone             per-terrain-cell state (buildings, dropped items)
 *
 * The player's own squad lives in `platoon/<player faction>_*.platoon`, where
 * the faction name comes from the game-state record's `pfaction name`.
 *
 * ID ALLOCATION (Phase 0 investigation, see TODO.md for full evidence):
 * Record ids are scoped PER FILE, not global. Checked every filetype-15 file
 * (quick.save + every .platoon) in two saves: ids collide constantly across
 * files (e.g. id 619 named four different unrelated records across
 * quick.save and three platoons in one save) — there is no shared save-wide
 * counter, despite docs/save-format.md §1 saying so. Even `sid`
 * ("<id>-<originating file>") collides cross-file, because runtime-created
 * records almost all use the literal suffix "-INGAME" rather than the file's
 * own name, so `sid` is only unique within one file. Each file's header
 * `nextId` equals max(id) of that same file's own records exactly (margin 0
 * in all 46 file-instances checked) — not max+1 as the header comment
 * implies. A correct `nextRecordId(file)` must therefore read that file's
 * OWN `header.nextId`, hand out `nextId + 1`, and write `nextId + 1` back
 * into that file's header — never borrow/share a counter across files.
 * Ids are also EPHEMERAL: the game renumbers and reorders every record each
 * time it saves. Across two saves of one playthrough with identical per-file
 * record counts, no record kept its id and every file's `nextId` roughly
 * doubled (Nameless_0 30->60, The Holy Nation_1 723->1446), with irregular
 * per-record offsets. So an id is not identity and must never be persisted or
 * used as a cross-save key. Cross-references travel by `sid` instead
 * (an instance targets "26--INGAME", not a number), and `sid` embeds the id —
 * so anything minting a record must write the matching sid ("<newId>--INGAME")
 * and every reference to it in the same pass. A chosen id only has to stay
 * free within that one file until the player's next in-game save.
 * Untested: whether the game re-mints/rejects an id chosen this way on load.
 * Not implemented yet (Phase 2 work) — this is a comment only.
 */

// Record typecodes, named from the fields they carry.
const T = {
  SQUAD: 30,
  STATS: 25,
  CHAR_STATE: 36,
  MEDICAL: 57,
  INVENTORY: 41,
  ITEM: 42,
  APPEARANCE: 66,
  AI: 67,
  FACTION: 37,
  GAME_STATE: 56,
};

const BODY_SLOTS = 7;

// Documented equip/carry slot strings for `strings.section` on a type-42 ITEM
// record (TODO.md 2.1, guide-confirmed). `main` (general carry) and
// `backpack_content` (inside the pack) are buckets — many items can share one
// of those two at once. Every other value is a single-occupancy body/equip
// slot, which is what makes the "swap flips the previous occupant back to
// main" collision rule meaningful in the first place.
const ITEM_SLOTS = ['main', 'head', 'shirt', 'armour', 'legs', 'boots', 'back', 'hip', 'belt', 'backpack_attach', 'backpack_content'];
const ITEM_BUCKET_SLOTS = new Set(['main', 'backpack_content']);

function readSaveFile(dir, rel) {
  return readFile(fs.readFileSync(path.join(dir, rel)));
}

function gameStateOf(world) {
  const rec = world.records.find((r) => r.type === T.GAME_STATE);
  if (!rec) throw new Error('save contains no game-state record (type 56)');
  return rec;
}

/** World-level summary: faction, region, clock, money, squad counts. */
function worldSummary(world) {
  const gs = gameStateOf(world);
  const i = gs.ints; const s = gs.strings;
  return {
    faction: asText(s.get('pfaction name') || ''),
    region: asText(s.get('area') || ''),
    gameVersion: asText(s.get('version') || ''),
    day: i.get('time day') ?? null,
    hour: i.get('time hour') ?? null,
    minute: i.get('time minute') ?? null,
    money: i.get('player money') ?? null,
    squads: i.get('squads') ?? null,
    members: i.get('members') ?? null,
    cameraPos: gs.vec3.get('pos') || null,
  };
}

/**
 * `catalog` is decoration only — see itemCatalogService.js. Every other field
 * here comes straight off the save record; a catalog miss (the common case,
 * ~82% of this install's item-typed stringIDs — see TODO.md 2.3) must never
 * hide or alter anything the save itself says.
 *
 * `level` (ints.level) and `quality` (floats.quality) are two distinct fields
 * confirmed present on every sampled type-42 record (Phase 0, TODO.md) — do
 * not conflate them. TODO.md 3.4 has the quality/grade investigation this
 * editor did before shipping any quality UI: `level` is the FCS guide's named
 * "Level" tier for ARMOUR (5/20/40/60/80/95 = Prototype..Masterwork), backed
 * by this save's own data (every armour-typed item's `level` was one of
 * exactly {20,40,60,80}, a strict subset of that list; `quality` was a
 * constant 100 across every one of them, so it cannot be the varying grade
 * field). Weapon grade (e.g. "Meitou") is NOT controlled by `level` per the
 * guide — it's a company-sid/material-sid combination, which this editor does
 * not attempt to map (see setWeaponVariant's absence and TODO.md 3.4).
 */
function itemOf(rec) {
  const s = rec.strings;
  const baseSid = s.get('base data sid');
  const cat = itemCatalog.lookup(baseSid);
  const section = asText(s.get('section') || '');
  const { sections: allowedSections, widened: slotsWidened } = itemSlots.allowedSections(baseSid, section);
  return {
    sid: rec.sid,
    base: asText(baseSid || ''),
    name: gamedata.nameOf(baseSid),
    material: gamedata.nameOf(s.get('material sid'), ''),
    // Weapon grade: the named tier a player recognises ("Meitou") is the
    // (company sid, material sid) pair, not `level` (TODO.md 2.2(i)). Raw
    // `materialSid` is surfaced so the Gear row's grade <select> can preselect
    // the item's current entry; null for non-weapons, which have no ladder.
    materialSid: asText(s.get('material sid') || ''),
    // Whether the template can stack at all — decides whether the Gear row
    // offers a quantity control (TODO.md 2.2(d)). Not derivable client-side.
    stackable: !!(gamedata.lookup(baseSid) || {}).stackable,
    kindType: (gamedata.lookup(baseSid) || {}).type ?? null,
    section,
    quantity: rec.ints.get('quantity') ?? 1,
    quality: rec.floats.get('quality') ?? null,
    level: rec.ints.get('level') ?? null,
    inInventory: rec.bools.get('in inventory') ?? null,
    // Which `section` slots this item may legitimately move into (TODO.md
    // 2.1) — the UI must render exactly these <option>s, never all of
    // ITEM_SLOTS, and never recompute this itself (see services/itemSlots.js).
    allowedSections,
    // True when the item's kind couldn't be resolved/mapped at all, so the
    // FULL slot list was offered rather than a real restriction — the UI
    // surfaces this once so the user knows the editor can't vouch for
    // compatibility here.
    slotsWidened,
    catalog: cat ? {
      category: cat.taxonomy?.group || (cat.taxonomy?.categories || [])[0] || null,
      description: cat.wiki?.description || null,
    } : null,
  };
}

/**
 * Body-part health.
 *
 * `flesh<n>` is the current value and `sid<n>` names the part. There is also a
 * `hit<n>` field that looks like a maximum but is not trustworthy as one —
 * undamaged arms read 100 against a `hit` of 80, and a bonedog's hind legs read
 * 70.7 against 50. Both are reported raw; `damaged` is judged against the
 * character's own highest intact part, which is unambiguous.
 */
function medicalOf(rec) {
  if (!rec) return null;
  const f = rec.floats; const b = rec.bools;
  const parts = [];
  for (let i = 0; i < BODY_SLOTS; i++) {
    if (!f.has(`hit${i}`)) continue;
    parts.push({
      part: gamedata.nameOf(rec.strings.get(`sid${i}`), `part ${i}`),
      current: f.get(`flesh${i}`),
      hitField: f.get(`hit${i}`),
      bandage: f.get(`bandage${i}`) || 0,
      stun: f.get(`stun${i}`) || 0,
      rig: f.get(`rig${i}`) ?? null,
      wear: f.get(`wear${i}`) ?? null,
    });
  }
  const intact = Math.max(0, ...parts.map((p) => p.current));
  for (const p of parts) {
    p.percentOfIntact = intact > 0 ? Math.round((p.current / intact) * 100) : null;
  }
  return {
    dead: b.get('dead') ?? false,
    unconscious: b.get('unconcious') ?? false,   // the game's own spelling
    coma: b.get('coma') ?? false,
    incapacitated: b.get('incapacitated') ?? false,
    blood: f.get('blood') ?? null,
    bleeding: f.get('bleeding') ?? 0,
    fed: f.get('fed') ?? null,
    hunger: f.get('hung') ?? null,
    // Raw bitmask, not decoded (see restoreLimbs()'s comment) — surfaced only
    // so the UI can tell whether there's anything for restoreLimbs() to clear.
    limbs: rec.ints.get('limbs') ?? null,
    parts,
  };
}

const ATTRIBUTES = ['strength', 'dexterity', 'toughness2', 'perception'];

function statsOf(rec) {
  if (!rec) return null;
  const f = rec.floats;
  const attributes = {};
  for (const a of ATTRIBUTES) attributes[a === 'toughness2' ? 'toughness' : a] = f.get(a) ?? 0;
  const skills = [];
  for (const [k, v] of f) {
    if (k === 'xp' || k === 'free attribute points' || ATTRIBUTES.includes(k)) continue;
    skills.push({ skill: k, level: v });
  }
  skills.sort((a, b) => b.level - a.level);
  return { attributes, skills, xp: f.get('xp') ?? 0, freePoints: f.get('free attribute points') ?? 0 };
}

/** Characters in one platoon file, resolved through the squad record. */
function readPlatoon(file) {
  const parsed = readFile(fs.readFileSync(file));
  const bySid = new Map(parsed.records.map((r) => [r.sid, r]));
  const squad = parsed.records.find((r) => r.type === T.SQUAD);
  const characters = [];

  for (const inst of squad ? squad.instances : []) {
    const states = inst.states.map((s) => bySid.get(s)).filter(Boolean);
    const pick = (type) => states.find((r) => r.type === type) || null;
    const state = pick(T.CHAR_STATE);
    const bag = pick(T.INVENTORY);

    characters.push({
      sid: inst.id,
      name: asText(state ? (state.strings.get('name') || '') : ''),
      origin: gamedata.nameOf(inst.target),
      isLeader: state ? (state.bools.get('is leader') ?? false) : false,
      personality: state ? state.ints.get('personality') ?? null : null,
      age: state ? state.floats.get('age') ?? null : null,
      position: inst.pos,
      medical: medicalOf(pick(T.MEDICAL)),
      stats: statsOf(pick(T.STATS)),
      inventory: bag
        ? bag.instances.map((ii) => bySid.get(ii.target)).filter(Boolean).map(itemOf)
        : [],
    });
  }

  return { file: path.basename(file), parsed, characters };
}

/**
 * Resolve `(saveDir, platoonFile, characterSid)` to the parsed platoon file
 * plus that character's squad instance and state records.
 *
 * Shared by every per-character mutation (see TODO.md's "Character-scoped
 * route namespace" cross-cutting task) so each one doesn't reinvent the
 * squad -> instance -> states lookup that `readPlatoon()` already does for
 * reads. `relFile` is the path to hand back to `mutationService` (relative to
 * `saveDir`, e.g. `platoon/Foo_1.platoon`) — that's what `changedFiles` and
 * the staged-write path both key off.
 */
function resolveCharacter(saveDir, platoonFile, characterSid) {
  // `platoonFile` arrives straight off the URL (`:file`). Express percent-decodes
  // route params, so without this a crafted `..%2F..%2Fquick.save` would escape
  // the save directory — and `relFile` is a *write* target handed to
  // mutationService. Only a bare `<name>.platoon` basename is ever legitimate.
  if (typeof platoonFile !== 'string'
    || !/^[^/\\]+\.platoon$/.test(platoonFile)
    || platoonFile.includes('..')) {
    throw new Error(`invalid platoon file name "${platoonFile}"`);
  }
  const relFile = path.join('platoon', platoonFile);
  const abs = path.join(saveDir, relFile);
  if (!fs.existsSync(abs)) throw new Error(`no platoon file "${platoonFile}" in this save`);

  const parsed = readFile(fs.readFileSync(abs));
  const bySid = new Map(parsed.records.map((r) => [r.sid, r]));
  const squad = parsed.records.find((r) => r.type === T.SQUAD);
  if (!squad) throw new Error(`${platoonFile}: no squad record (type 30)`);

  const inst = squad.instances.find((i) => i.id === characterSid);
  if (!inst) throw new Error(`${platoonFile}: no character with sid "${characterSid}"`);

  const states = inst.states.map((s) => bySid.get(s)).filter(Boolean);
  const pick = (type) => states.find((r) => r.type === type) || null;

  return {
    relFile,
    parsed,
    bySid,
    squad,
    instance: inst,
    records: {
      stats: pick(T.STATS),
      medical: pick(T.MEDICAL),
      state: pick(T.CHAR_STATE),
      inventory: pick(T.INVENTORY),
    },
  };
}

function playerPlatoonFiles(dir, faction) {
  const pdir = path.join(dir, 'platoon');
  if (!faction || !fs.existsSync(pdir)) return [];
  return fs.readdirSync(pdir)
    .filter((f) => f.startsWith(`${faction}_`) && f.endsWith('.platoon'))
    .sort()
    .map((f) => path.join(pdir, f));
}

/** Full read-only status for one save directory. */
function status(saveName) {
  const save = saveName ? paths.findSave(saveName) : paths.latestSave();
  if (!save) throw new Error(saveName ? `no save named "${saveName}"` : 'no Kenshi saves found');

  const world = readSaveFile(save.dir, 'quick.save');
  const summary = worldSummary(world);
  const squads = playerPlatoonFiles(save.dir, summary.faction).map((f) => {
    const { characters } = readPlatoon(f);
    return { file: path.basename(f), characters };
  });

  return {
    save: { name: save.name, dir: save.dir, savedAt: save.savedAt },
    world: summary,
    recordCount: world.records.length,
    squads,
  };
}

/**
 * Set the player's cat balance.
 *
 * Deliberately the only mutation wired up so far: it is a single int in a
 * single record, so it exercises the whole read -> edit -> verify -> install
 * pipeline with the smallest possible blast radius. Returns the new bytes;
 * installing them is mutationService's job, never this function's.
 */
function setPlayerMoney(saveDir, amount) {
  if (!Number.isInteger(amount) || amount < 0 || amount > 2147483647) {
    throw new Error('money must be an integer between 0 and 2147483647');
  }
  const world = readSaveFile(saveDir, 'quick.save');
  const gs = gameStateOf(world);
  const before = gs.ints.get('player money');
  gs.ints.set('player money', amount);
  return {
    file: 'quick.save',
    bytes: writeFile(world),
    before,
    after: amount,
  };
}

/**
 * Set one or more stats (attributes/skills) on a character's STATS (type 25)
 * record, in a single staged edit.
 *
 * This is the bulk primitive; `setStat()` below is just this called with a
 * one-entry map. mutationService.mutate() rejects a no-op edit and treats
 * each `action()` call as one staged edit against one pre-edit snapshot, so
 * N sequential single-stat calls would each re-open the mutation gate (and
 * each but the last would race the others' before/after hashes) — a bulk
 * form done in one record read/write is the correct primitive, per TODO.md
 * 1.1's explicit "prefer the latter" note.
 *
 * Every key in `stats` must already exist in the record's `floats` Map —
 * this never mints a new float key, since we don't have confirmation the
 * game reads an arbitrary new stat name (see TODO.md Phase 0 STATS
 * findings). The FCS guide explicitly warns that stats above 100 "can bug
 * out," so >100 is rejected for everything. The lower bound differs by kind:
 * a live Cannibal's STATS record has attributes that are all positive, but
 * *skills* the character never trained sit at small negatives (observed:
 * thievery=-3.41, weapon smith=-1.94, dodge=-0.46, stealth=-0.25 — this is
 * the game's own data, not corruption). So attributes stay clamped to 0..100
 * and skills allow -100..100 — do not "fix" skills back to >= 0.
 *
 * @param {string} saveDir
 * @param {string} platoonFile   e.g. "Nameless_0.platoon" (no "platoon/" prefix)
 * @param {string} characterSid  the squad instance's id, e.g. "26--INGAME"
 * @param {Record<string, number>|Map<string, number>} stats
 */
function setStats(saveDir, platoonFile, characterSid, stats) {
  const entries = stats instanceof Map ? [...stats.entries()] : Object.entries(stats || {});
  if (entries.length === 0) throw new Error('setStats: no stats given');

  const { relFile, parsed, records } = resolveCharacter(saveDir, platoonFile, characterSid);
  const rec = records.stats;
  if (!rec) throw new Error(`${platoonFile}: character "${characterSid}" has no STATS record (type 25)`);

  // Validate every entry before touching the record (AGENTS.md §4). A throw
  // mid-loop would discard this in-memory parse anyway, but keeping the two
  // passes separate means a partially-valid request can never produce a
  // partially-edited record for some later caller to hand onward.
  const checked = [];
  for (const [statKey, rawValue] of entries) {
    if (!rec.floats.has(statKey)) {
      throw new Error(`unknown stat "${statKey}" — not present in this character's STATS record`);
    }
    const value = Number(rawValue);
    if (!Number.isFinite(value)) throw new Error(`stat "${statKey}": value must be a finite number`);
    const isAttribute = ATTRIBUTES.includes(statKey);
    const min = isAttribute ? 0 : -100;
    if (value < min) throw new Error(`stat "${statKey}": value must not be less than ${min}`);
    if (value > 100) throw new Error(`stat "${statKey}": value must not exceed 100 (values above 100 can bug out)`);
    checked.push([statKey, value]);
  }

  const before = {};
  for (const [statKey, value] of checked) {
    before[statKey] = rec.floats.get(statKey);
    rec.floats.set(statKey, value);
  }

  return {
    file: relFile,
    bytes: writeFile(parsed),
    before,
    after: Object.fromEntries(entries.map(([k]) => [k, rec.floats.get(k)])),
  };
}

/** Single-stat convenience wrapper over setStats(). */
function setStat(saveDir, platoonFile, characterSid, statKey, value) {
  return setStats(saveDir, platoonFile, characterSid, { [statKey]: value });
}

/**
 * "Train as archetype": one staged edit that sets a coherent stat spread
 * instead of the caller typing ~42 numbers by hand. See services/archetypes.js
 * for the (editorial, not save-derived) main/sub skill mapping.
 *
 * - All 4 attributes -> 45.
 * - Archetype skills (main + sub, deduped) -> random 45-95.
 * - Every other skill actually present on THIS character's STATS record ->
 *   random 15-40.
 *
 * Only ever writes keys already present in `rec.floats` (iterating the Map
 * directly, never a hardcoded key list), so a non-human character with a
 * smaller skill set — or a modded character with extra ones — is handled
 * correctly without minting a new float key.
 *
 * `mode: 'raise'` (default) never lowers an existing value: writes
 * Math.max(current, rolled). `mode: 'set'` writes the rolled value
 * regardless, for an explicit hard overwrite. `rng` defaults to Math.random
 * but is injectable for deterministic tests — never called outside this one
 * closure.
 */
function trainCharacter(saveDir, platoonFile, characterSid, { archetype, sub, mode = 'raise', rng = Math.random } = {}) {
  if (mode !== 'raise' && mode !== 'set') throw new Error('mode must be "raise" or "set"');
  // Resolve (and thus validate) the archetype/sub BEFORE touching the record,
  // so an unknown id is rejected without reading or parsing anything.
  const { skills: archetypeSkills } = archetypes.resolveSkills(archetype, sub);
  const archetypeSet = new Set(archetypeSkills);

  const { relFile, parsed, records } = resolveCharacter(saveDir, platoonFile, characterSid);
  const rec = records.stats;
  if (!rec) throw new Error(`${platoonFile}: character "${characterSid}" has no STATS record (type 25)`);

  const round1 = (v) => Math.round(v * 10) / 10;
  const roll = (min, max) => round1(min + rng() * (max - min));

  const before = {};
  const after = {};
  let changedCount = 0;

  const applyOne = (key, rolled) => {
    const cur = rec.floats.get(key);
    before[key] = cur;
    const value = mode === 'raise' ? Math.max(cur, rolled) : rolled;
    rec.floats.set(key, value);
    after[key] = value;
    if (value !== cur) changedCount += 1;
  };

  for (const a of ATTRIBUTES) {
    if (!rec.floats.has(a)) continue; // e.g. a non-human character missing an attribute
    applyOne(a, 45);
  }

  for (const key of rec.floats.keys()) {
    if (key === 'xp' || key === 'free attribute points' || ATTRIBUTES.includes(key)) continue;
    const isArchetypeSkill = archetypeSet.has(key);
    const [min, max] = isArchetypeSkill ? [45, 95] : [15, 40];
    applyOne(key, roll(min, max));
  }

  return {
    file: relFile,
    bytes: writeFile(parsed),
    before,
    after,
    changedCount,
  };
}

/**
 * Shared implementation for healPart()/damagePart() (Phase 1.2). Sets
 * `flesh<n>` on a character's MEDICAL record and, by default, zeroes
 * `bandage<n>`/`stun<n>` for that part ("to fully heal" per the guide) —
 * callers can pass explicit non-negative `bandage`/`stun` instead if they
 * want to leave some of either in place.
 *
 * `flesh: 'full'` resolves to `Math.max(...allParts.current)` computed at
 * write time from THIS record's own parts — never `hit<n>`, which
 * AGENTS.md/TODO.md both document as an untrustworthy maximum (undamaged
 * arms have been observed reading 100 against a hit of 80).
 *
 * `allowNegative` distinguishes healing (flesh clamped >= 0) from the
 * documented negative-of-max limb-loss mechanic (damagePart(), Phase 1.2's
 * lowest-priority task) — same shape, different clamp, so the validation and
 * record-mutation logic live in one place instead of two copies drifting.
 */
function setPartHealth(saveDir, platoonFile, sid, partIndex, { flesh, bandage = 0, stun = 0 } = {}, { allowNegative = false } = {}) {
  const n = Number(partIndex);
  if (!Number.isInteger(n) || n < 0 || n >= BODY_SLOTS) {
    throw new Error(`partIndex must be an integer between 0 and ${BODY_SLOTS - 1}`);
  }
  const { relFile, parsed, records } = resolveCharacter(saveDir, platoonFile, sid);
  const rec = records.medical;
  if (!rec) throw new Error(`${platoonFile}: character "${sid}" has no MEDICAL record (type 57)`);
  if (!rec.floats.has(`hit${n}`)) throw new Error(`${platoonFile}: character "${sid}" has no body part ${n}`);

  let fleshValue;
  if (flesh === 'full') {
    if (allowNegative) throw new Error('"full" is not valid for damagePart — supply an explicit negative value');
    const allCurrent = [];
    for (let i = 0; i < BODY_SLOTS; i++) {
      if (rec.floats.has(`hit${i}`)) allCurrent.push(rec.floats.get(`flesh${i}`) ?? 0);
    }
    fleshValue = Math.max(0, ...allCurrent);
  } else {
    fleshValue = Number(flesh);
    if (!Number.isFinite(fleshValue)) throw new Error('flesh must be a finite number or "full"');
  }
  if (!allowNegative && fleshValue < 0) {
    throw new Error('flesh must not be negative (use damagePart for the documented limb-loss mechanic)');
  }

  const bandageValue = Number(bandage);
  const stunValue = Number(stun);
  if (!Number.isFinite(bandageValue) || bandageValue < 0) throw new Error('bandage must be a non-negative finite number');
  if (!Number.isFinite(stunValue) || stunValue < 0) throw new Error('stun must be a non-negative finite number');

  const before = {
    flesh: rec.floats.get(`flesh${n}`),
    bandage: rec.floats.get(`bandage${n}`),
    stun: rec.floats.get(`stun${n}`),
  };
  rec.floats.set(`flesh${n}`, fleshValue);
  rec.floats.set(`bandage${n}`, bandageValue);
  rec.floats.set(`stun${n}`, stunValue);

  return {
    file: relFile,
    bytes: writeFile(parsed),
    before,
    after: { flesh: fleshValue, bandage: bandageValue, stun: stunValue },
  };
}

/**
 * Heal a body part: set `flesh<n>` (clamped >= 0, or 'full') and zero
 * `bandage<n>`/`stun<n>` by default. See setPartHealth() for the shared
 * logic and TODO.md Phase 1.2 for the field derivation.
 */
function healPart(saveDir, platoonFile, sid, partIndex, opts) {
  return setPartHealth(saveDir, platoonFile, sid, partIndex, opts, { allowNegative: false });
}

/**
 * Limb loss (destructive, Phase 1.2's lowest-priority task): same shape as
 * healPart() but with no lower clamp, allowing the documented
 * negative-of-max mechanic (a live sample character was observed with
 * flesh0: -10.3 and flesh5: -83.6 after losing limbs). The route/UI layer
 * must gate this behind an explicit confirmation — this function performs no
 * in-game-behavior validation, since actual limb loss also depends on the
 * game's own "limb loss frequency" setting, which is out of scope for an
 * offline editor.
 */
function damagePart(saveDir, platoonFile, sid, partIndex, opts) {
  return setPartHealth(saveDir, platoonFile, sid, partIndex, opts, { allowNegative: true });
}

/**
 * Set hunger/fed floats on a character's MEDICAL record, independently
 * settable (either key may be omitted to leave it untouched).
 *
 * `hung` clamps to 0..3 — the guide's documented scale. `fed` clamps to
 * 0..10 — the guide documents NO cap for `fed`; 10 is this editor's own
 * generous choice, not a value derived from the save format.
 */
function setHunger(saveDir, platoonFile, sid, { hung, fed } = {}) {
  if (hung === undefined && fed === undefined) throw new Error('setHunger: provide hung and/or fed');

  const { relFile, parsed, records } = resolveCharacter(saveDir, platoonFile, sid);
  const rec = records.medical;
  if (!rec) throw new Error(`${platoonFile}: character "${sid}" has no MEDICAL record (type 57)`);

  let hungValue;
  let fedValue;
  if (hung !== undefined) {
    hungValue = Number(hung);
    if (!Number.isFinite(hungValue)) throw new Error('hung must be a finite number');
    if (hungValue < 0 || hungValue > 3) throw new Error('hung must be between 0 and 3');
  }
  if (fed !== undefined) {
    fedValue = Number(fed);
    if (!Number.isFinite(fedValue)) throw new Error('fed must be a finite number');
    if (fedValue < 0 || fedValue > 10) throw new Error('fed must be between 0 and 10 (this editor\'s own cap, see comment above)');
  }

  const before = { hung: rec.floats.get('hung'), fed: rec.floats.get('fed') };
  if (hungValue !== undefined) rec.floats.set('hung', hungValue);
  if (fedValue !== undefined) rec.floats.set('fed', fedValue);

  return {
    file: relFile,
    bytes: writeFile(parsed),
    before,
    after: { hung: rec.floats.get('hung'), fed: rec.floats.get('fed') },
  };
}

/**
 * Revive: clear death/KO/coma flags AND raise any dangerously low flesh<n>
 * in the SAME write. The guide's explicit warning is that HP data overrides
 * KO/death flags on load — clearing the flags alone would leave the
 * character primed to die again the instant the save reloads, so this must
 * never be split into a flags-only mutation (and the UI must not offer raw
 * flag toggles standalone).
 *
 * `minFleshPercent` is a floor relative to the character's OWN highest
 * current `flesh<n>` at write time — the same "own highest intact part"
 * definition medicalOf()/healPart() use, never `hit<n>` (AGENTS.md §3).
 */
function revive(saveDir, platoonFile, sid, { minFleshPercent = 50 } = {}) {
  const floor = Number(minFleshPercent);
  if (!Number.isFinite(floor) || floor <= 0 || floor > 100) {
    throw new Error('minFleshPercent must be a finite number between 0 (exclusive) and 100');
  }

  const { relFile, parsed, records } = resolveCharacter(saveDir, platoonFile, sid);
  const rec = records.medical;
  if (!rec) throw new Error(`${platoonFile}: character "${sid}" has no MEDICAL record (type 57)`);

  const allCurrent = [];
  for (let i = 0; i < BODY_SLOTS; i++) {
    if (rec.floats.has(`hit${i}`)) allCurrent.push(rec.floats.get(`flesh${i}`) ?? 0);
  }
  const maxFlesh = Math.max(0, ...allCurrent);
  // The floor is a percentage of the character's own highest intact part —
  // `hit<n>` is not a trustworthy maximum (AGENTS.md §3), so it is never the
  // reference. That baseline degenerates when nothing is intact: on a heavily
  // destroyed character every part can be at or below zero, making the floor ~0,
  // which would clear the death flags while leaving HP lethal — precisely the
  // "dies again on reload" trap this function exists to avoid. There is no
  // trustworthy maximum to fall back on, so refuse rather than half-revive and
  // let the caller heal explicit parts first.
  if (maxFlesh <= 0) {
    throw new Error(
      'cannot revive: this character has no intact body part to measure a safe '
      + 'health floor against. Heal at least one part explicitly first, then revive.',
    );
  }
  const fleshFloor = maxFlesh * (floor / 100);

  const before = {
    dead: rec.bools.get('dead'),
    coma: rec.bools.get('coma'),
    incapacitated: rec.bools.get('incapacitated'),
    unconscious: rec.bools.get('unconcious'), // the game's own spelling
    KO: rec.floats.get('KO'),
  };

  const raisedParts = [];
  for (let i = 0; i < BODY_SLOTS; i++) {
    if (!rec.floats.has(`hit${i}`)) continue;
    const cur = rec.floats.get(`flesh${i}`) ?? 0;
    if (cur < fleshFloor) {
      rec.floats.set(`flesh${i}`, fleshFloor);
      raisedParts.push(i);
    }
  }

  rec.bools.set('dead', false);
  rec.bools.set('coma', false);
  rec.bools.set('incapacitated', false);
  rec.bools.set('unconcious', false);
  rec.floats.set('KO', 0);

  return {
    file: relFile,
    bytes: writeFile(parsed),
    before,
    after: {
      dead: false, coma: false, incapacitated: false, unconscious: false, KO: 0,
      fleshFloor, raisedParts,
    },
  };
}

/**
 * Delete `ints.limbs` if present — no attempt is made to interpret individual
 * bits (the bit-to-body-part encoding is NOT decoded, see TODO.md Phase 0:
 * a comatose Cannibal was observed with `ints.limbs: 16` but which bit maps
 * to which lost part was not determined from a single sample). The FCS
 * guide's "delete the left side, not the right side" almost certainly refers
 * to the FCS UI's key column vs. value column — i.e. delete the key itself,
 * which is exactly what this does and requires no bitmask knowledge.
 *
 * A no-op (key absent) is left to mutationService.mutate()'s existing
 * "edit produced no change" rejection — that is correct behavior here (there
 * is nothing to restore), not a bug to special-case around.
 */
function restoreLimbs(saveDir, platoonFile, sid) {
  const { relFile, parsed, records } = resolveCharacter(saveDir, platoonFile, sid);
  const rec = records.medical;
  if (!rec) throw new Error(`${platoonFile}: character "${sid}" has no MEDICAL record (type 57)`);

  const before = rec.ints.get('limbs') ?? null;
  rec.ints.delete('limbs');

  return { file: relFile, bytes: writeFile(parsed), before, after: rec.ints.get('limbs') ?? null };
}

/**
 * Resolve `(saveDir, platoonFile, characterSid, itemSid)` to that character's
 * INVENTORY record plus the target ITEM record — and confirm the item
 * actually belongs to THIS character, not some other character's inventory in
 * the same platoon file (TODO.md 2.1's explicit validation requirement).
 * Shared by setItemSection()/setItemQuality() so the ownership check can't
 * drift between them.
 */
function resolveCharacterItem(saveDir, platoonFile, characterSid, itemSid) {
  const ctx = resolveCharacter(saveDir, platoonFile, characterSid);
  const bag = ctx.records.inventory;
  if (!bag) throw new Error(`${platoonFile}: character "${characterSid}" has no INVENTORY record (type 41)`);

  const owns = bag.instances.some((ii) => ii.target === itemSid);
  if (!owns) throw new Error(`item "${itemSid}" is not in character "${characterSid}"'s inventory`);

  const itemRec = ctx.bySid.get(itemSid);
  if (!itemRec || itemRec.type !== T.ITEM) throw new Error(`item "${itemSid}" is not an ITEM record (type 42)`);

  return { ...ctx, bag, itemRec };
}

/**
 * Shared collision/displacement rule (TODO.md 2.1's "the point of this
 * function" comment, and TODO.md 2.2(f)'s explicit instruction to reuse it
 * rather than duplicate it): if `targetSection` is a single-occupancy slot
 * (i.e. NOT in ITEM_BUCKET_SLOTS) and some OTHER item already in `bag`
 * occupies it, flips that item's `section` back to `main` and returns it.
 * Returns `null` when `targetSection` is a bucket or nothing occupies it.
 *
 * `excludeSid` is the sid of the item being moved, so it never displaces
 * itself — pass `null` when adding a brand-new item that isn't in `bag` yet
 * (addItem()'s case: the new record's sid doesn't exist until after this
 * runs).
 *
 * Shared by setItemSection() and addItem() — this is the one place the
 * collision rule lives; it must never grow a second copy.
 */
function displaceIntoSlot(bag, bySid, excludeSid, targetSection) {
  if (ITEM_BUCKET_SLOTS.has(targetSection)) return null;
  for (const inst of bag.instances) {
    if (inst.target === excludeSid) continue;
    const other = bySid.get(inst.target);
    if (other && other.type === T.ITEM && asText(other.strings.get('section') || '') === targetSection) {
      other.strings.set('section', 'main');
      return other; // single-occupancy slot — at most one prior occupant can exist
    }
  }
  return null;
}

/**
 * Change an item's equip slot (`strings.section` on type 42), TODO.md 2.1.
 *
 * The collision rule is the point of this function: moving an item into a
 * slot another item of the SAME character already occupies must flip that
 * other item's section back to `main` in the SAME write, or the save ends up
 * with two items claiming one slot. `main` and `backpack_content` are buckets
 * (see ITEM_BUCKET_SLOTS) — many items legitimately share either at once, so
 * moving into one of those two never displaces anything. See
 * displaceIntoSlot() for the shared implementation (also used by addItem()).
 *
 * Race compatibility (e.g. a shirt on a hiver) is explicitly NOT validated
 * here — the save edit succeeds either way; the UI carries that caveat as a
 * one-time hint, per TODO.md 2.1.
 *
 * Kind compatibility (a shirt cannot go in a weapon slot) IS validated here,
 * via services/itemSlots.js — the same module the UI reads its `<option>`
 * list from, so the two can never drift apart. Per TODO.md 2.1's explicit
 * rule, this only ever RESTRICTS a move when the item's kind is actually
 * known (a resolvable gamedata template with a typecode this editor has
 * rules for); an unknown/unmapped kind is permitted into any documented slot
 * rather than risk locking a modded item the editor has never seen.
 */
function setItemSection(saveDir, platoonFile, characterSid, itemSid, targetSection) {
  return updateItem(saveDir, platoonFile, characterSid, itemSid, { section: targetSection });
}

// Every field updateItem() understands. Unknown keys are rejected rather than
// ignored, for the same reason addItem() rejects them: silently dropping a
// misnamed field would write a *different* item than the caller asked for and
// still report success.
const UPDATE_ITEM_FIELDS = new Set(['section', 'level', 'quality', 'quantity', 'materialSid']);

/**
 * Set any combination of an item's slot, level, quality and quantity in ONE
 * staged edit.
 *
 * This is the primitive; `setItemSection()` and `setItemQuality()` are thin
 * wrappers so their routes and tests keep working. Combining matters, and is
 * not just a convenience: `mutationService.mutate()` treats each call as one
 * staged edit against one pre-edit snapshot and creates one backup, so a UI
 * row that changes slot AND quantity would otherwise need two sequential
 * writes, each re-opening the mutation gate, with the save briefly in a state
 * the user never asked for if the second failed.
 *
 * Every field is optional and independently settable (same shape as
 * setHunger()); omitting one leaves it untouched. All validation happens
 * before ANY mutation, so a partially-valid request can never produce a
 * partially-edited record.
 *
 * `quantity` is the field the Gear UI was missing entirely — it could only be
 * set when the item was first created. Per TODO.md 2.2(d), a quantity above 1
 * is rejected unless the item's gamedata template is stackable; no maximum is
 * documented anywhere in the data (live stacks run to 100), so there is no
 * upper clamp.
 */
function updateItem(saveDir, platoonFile, characterSid, itemSid, opts = {}) {
  const unknown = Object.keys(opts).filter((k) => !UPDATE_ITEM_FIELDS.has(k));
  if (unknown.length) {
    throw new Error(`updateItem: unknown field(s) ${unknown.join(', ')} — supported: ${[...UPDATE_ITEM_FIELDS].join(', ')}`);
  }
  const { section, level, quality, quantity, materialSid } = opts;
  if (section === undefined && level === undefined && quality === undefined
    && quantity === undefined && materialSid === undefined) {
    throw new Error('updateItem: provide at least one of section, level, quality, quantity, materialSid');
  }

  const { relFile, parsed, bag, bySid, itemRec } = resolveCharacterItem(saveDir, platoonFile, characterSid, itemSid);

  const currentSection = asText(itemRec.strings.get('section') || '');
  const baseSid = itemRec.strings.get('base data sid');
  const itemName = gamedata.nameOf(baseSid, asText(baseSid || itemSid));

  // ---- validate everything before touching the record (AGENTS.md §4) ----
  if (section !== undefined) {
    if (!ITEM_SLOTS.includes(section)) {
      throw new Error(`section must be one of: ${ITEM_SLOTS.join(', ')}`);
    }
    const { sections: allowed } = itemSlots.allowedSections(baseSid, currentSection);
    if (!allowed.includes(section)) {
      throw new Error(`"${itemName}" cannot move into slot "${section}" — allowed slots: ${allowed.join(', ')}`);
    }
  }

  let levelValue;
  if (level !== undefined) {
    if (!itemRec.ints.has('level')) throw new Error(`item "${itemSid}" has no "level" int field`);
    levelValue = Number(level);
    if (!Number.isInteger(levelValue) || levelValue < 0) throw new Error('level must be a non-negative integer');
  }

  let qualityValue;
  if (quality !== undefined) {
    if (!itemRec.floats.has('quality')) throw new Error(`item "${itemSid}" has no "quality" float field`);
    qualityValue = Number(quality);
    if (!Number.isFinite(qualityValue) || qualityValue < 0) throw new Error('quality must be a non-negative finite number');
  }

  let quantityValue;
  if (quantity !== undefined) {
    if (!itemRec.ints.has('quantity')) throw new Error(`item "${itemSid}" has no "quantity" int field`);
    quantityValue = Number(quantity);
    if (!Number.isInteger(quantityValue) || quantityValue < 1) throw new Error('quantity must be a positive integer');
    if (quantityValue > 1) {
      // The template, not the item record, is what says whether stacking is
      // legal — an unresolvable template is left permissive, matching how
      // itemSlots.js treats a kind it cannot identify rather than locking a
      // modded item this editor has never seen.
      const tmpl = gamedata.lookup(baseSid);
      if (tmpl && !tmpl.stackable) {
        throw new Error(`"${itemName}" is not stackable (see TODO.md 2.2(d)) — quantity must be 1`);
      }
    }
  }

  // Weapon grade: the named tier a player actually recognises ("Meitou") is
  // the (company sid, material sid) PAIR, not `level` — TODO.md 2.2(i). The
  // caller picks a ladder entry by its type-50 model sid and the company is
  // resolved from it, so the two can never be written out of step. Offered
  // here as well as in addItem() because being able to choose Meitou when
  // creating a weapon but not when editing one is exactly the sort of
  // asymmetry that makes this page confusing.
  let grade = null;
  if (materialSid !== undefined) {
    if (typeof materialSid !== 'string' || !materialSid) {
      throw new Error('materialSid must be a non-empty string (a weapon grade type-50 sid)');
    }
    const tmpl = gamedata.lookup(baseSid);
    if (!tmpl || tmpl.type !== 2) {
      throw new Error(`"${itemName}" is not a weapon — grade (materialSid) only applies to weapons`);
    }
    grade = gamedata.weaponGrades().find((g) => g.modelSid === materialSid);
    if (!grade) throw new Error(`"${materialSid}" is not a known weapon grade (type-50) sid`);
  }

  // ---- apply ----
  const before = {
    section: currentSection,
    level: itemRec.ints.get('level') ?? null,
    quality: itemRec.floats.get('quality') ?? null,
    quantity: itemRec.ints.get('quantity') ?? null,
    materialSid: asText(itemRec.strings.get('material sid') || ''),
    companySid: asText(itemRec.strings.get('company sid') || ''),
    displacedSid: null,
    displacedSection: null,
  };

  let displaced = null;
  if (section !== undefined) {
    // Displaced item's "before" section is trivially `section` itself — that's
    // the definition of occupying the slot we're moving into — so it's safe to
    // read after displaceIntoSlot() has already flipped it.
    displaced = displaceIntoSlot(bag, bySid, itemSid, section);
    before.displacedSid = displaced ? displaced.sid : null;
    before.displacedSection = displaced ? section : null;
    itemRec.strings.set('section', section);
  }
  if (levelValue !== undefined) itemRec.ints.set('level', levelValue);
  if (qualityValue !== undefined) itemRec.floats.set('quality', qualityValue);
  if (quantityValue !== undefined) itemRec.ints.set('quantity', quantityValue);
  if (grade) {
    // Both keys already exist on every live type-42 record (TODO.md 2.2(a)),
    // so this never mints a new key — and they are written together, never
    // one without the other.
    itemRec.strings.set('material sid', grade.modelSid);
    itemRec.strings.set('company sid', grade.companySid);
  }

  return {
    file: relFile,
    bytes: writeFile(parsed),
    before,
    after: {
      name: itemName,
      section: asText(itemRec.strings.get('section') || ''),
      level: itemRec.ints.get('level') ?? null,
      quality: itemRec.floats.get('quality') ?? null,
      quantity: itemRec.ints.get('quantity') ?? null,
      materialSid: asText(itemRec.strings.get('material sid') || ''),
      companySid: asText(itemRec.strings.get('company sid') || ''),
      grade: grade ? { modelName: grade.modelName, companyName: grade.companyName, rank: grade.rank } : null,
      displacedSid: displaced ? displaced.sid : null,
      displacedSection: displaced ? 'main' : null,
    },
  };
}

/**
 * Set `ints.level` and/or `floats.quality` on an item, independently
 * (either may be omitted to leave the other untouched, same shape as
 * setHunger()). See itemOf()'s comment and TODO.md 3.4 for the investigation
 * behind these two fields — both must already exist on the record (same
 * "never mint a new key" discipline as setStats()); neither is clamped to a
 * specific range beyond non-negative, since the FCS guide documents stats
 * continuing to improve beyond named vanilla tiers.
 */
function setItemQuality(saveDir, platoonFile, characterSid, itemSid, { level, quality } = {}) {
  if (level === undefined && quality === undefined) throw new Error('setItemQuality: provide level and/or quality');
  return updateItem(saveDir, platoonFile, characterSid, itemSid, { level, quality });
}

/**
 * Add a new item to a character's inventory (TODO.md 2.2, the headline
 * feature the rest of 2.2 exists to unblock). `templateSid` is a gamedata
 * TEMPLATE sid (typecode 2/3/4 — never 42, see TODO.md 2.2(g)).
 *
 * Follows setPlayerMoney()'s reference shape: computes and returns
 * `{ file, bytes, ... }`; never touches the live save directory itself
 * (mutationService's job alone).
 *
 * Steps, per TODO.md 2.2:
 *   1. Resolve the character and its INVENTORY (41) record via
 *      resolveCharacter() (same helper every other per-character mutation
 *      uses).
 *   2. Resolve+validate the template via gamedataService — must exist and be
 *      typecode 2/3/4.
 *   3. Validate `quantity`: positive integer, and > 1 rejected unless the
 *      template is stackable (2.2(d)). No upper bound — nothing in the data
 *      documents a maximum; observed live stacks run to 100.
 *   4. Validate `section` via itemSlots.allowedSections(templateSid, null)
 *      (2.2(f)) — the exact same source of truth setItemSection() uses, no
 *      second compatibility path.
 *   5. Build the type-42 record via itemFactory.buildItemRecord() (2.2(a)/(b)
 *      shape knowledge lives there, not here).
 *   6. Displace a prior occupant of a single-occupancy target slot back to
 *      `main`, via the SAME displaceIntoSlot() helper setItemSection() uses
 *      (2.2(f)'s explicit "share that logic, don't duplicate it").
 *   7. Mint the record's identity and append it (ids.addRecord), then append
 *      an instance to the INVENTORY record pointing at it (ids.addInstance) —
 *      both bump the file's header `nextId` / the record's `instanceCount` in
 *      the same in-memory parse this function then serialises.
 *
 * @param {string} saveDir
 * @param {string} platoonFile
 * @param {string} characterSid
 * @param {string} templateSid
 * @param {object} opts
 * @param {number} [opts.quantity=1]
 * @param {string} opts.section
 * @param {number} [opts.level]         type 2/3 only, see itemFactory.js
 * @param {string} [opts.materialSid]   type 2: a grade (type-50) sid; type 3/4: explicit material sid override
 * @param {string} [opts.companySid]    type 2 only, must match materialSid's ladder entry if both given
 */
// Every option addItem() understands. Anything else is rejected rather than
// ignored: the options that pick a weapon's grade are easy to misname (the
// grade is chosen via `materialSid`, since the grade IS the type-50 material —
// passing a plausible-looking `grade: <sid>` instead would otherwise be
// silently dropped and quietly mint a "Totally rusted junk" weapon rather than
// the Meitou the caller asked for). A wrong item written into a save is not the
// kind of mistake that should fail silently.
const ADD_ITEM_OPTIONS = new Set(['quantity', 'section', 'level', 'materialSid', 'companySid']);

function addItem(saveDir, platoonFile, characterSid, templateSid, opts = {}) {
  const unknown = Object.keys(opts).filter((k) => !ADD_ITEM_OPTIONS.has(k));
  if (unknown.length) {
    throw new Error(`addItem: unknown option(s) ${unknown.join(', ')} — supported: ${[...ADD_ITEM_OPTIONS].join(', ')} (a weapon's grade is chosen via materialSid)`);
  }

  const { quantity = 1, section } = opts;

  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new Error('quantity must be a positive integer');
  }

  const tmpl = gamedata.lookup(templateSid);
  if (!tmpl) throw new Error(`unresolvable item template sid "${templateSid}"`);
  if (![2, 3, 4].includes(tmpl.type)) {
    throw new Error(`template "${templateSid}" (${tmpl.name}) is typecode ${tmpl.type}, not an item template (2/3/4) — see TODO.md 2.2(g)`);
  }

  if (quantity > 1 && !tmpl.stackable) {
    throw new Error(`"${tmpl.name}" is not stackable (see TODO.md 2.2(d)) — quantity must be 1`);
  }

  const { sections: allowedForKind } = itemSlots.allowedSections(templateSid, null);
  if (!allowedForKind.includes(section)) {
    throw new Error(`"${tmpl.name}" cannot be added into slot "${section}" — allowed slots: ${allowedForKind.join(', ')}`);
  }

  const { relFile, parsed, bySid, records } = resolveCharacter(saveDir, platoonFile, characterSid);
  const bag = records.inventory;
  if (!bag) throw new Error(`${platoonFile}: character "${characterSid}" has no INVENTORY record (type 41)`);

  const { record, meta } = itemFactory.buildItemRecord(templateSid, {
    section,
    level: opts.level,
    quantity,
    materialSid: opts.materialSid,
    companySid: opts.companySid,
  });

  // Same collision rule as setItemSection() — adding into an occupied
  // single-occupancy slot must displace the prior occupant back to `main` in
  // this SAME write. excludeSid is null: the new item has no sid yet and
  // cannot already be in `bag`.
  const displaced = displaceIntoSlot(bag, bySid, null, section);

  ids.addRecord(parsed, record); // stamps record.id/record.sid, appends to parsed.records
  ids.addInstance(bag, record.sid); // appends to bag.instances, bumps bag.instanceCount
  bySid.set(record.sid, record);

  return {
    file: relFile,
    bytes: writeFile(parsed),
    item: {
      sid: record.sid,
      templateSid,
      name: meta.templateName,
      section,
      quantity,
      level: record.ints.get('level'),
      materialSid: record.strings.get('material sid'),
      materialName: gamedata.nameOf(record.strings.get('material sid'), ''),
      companySid: record.strings.get('company sid'),
      companyName: gamedata.nameOf(record.strings.get('company sid'), ''),
      grade: meta.grade,
    },
    displaced: displaced ? { sid: displaced.sid, section: 'main' } : null,
  };
}

module.exports = {
  T, BODY_SLOTS, ITEM_SLOTS, ITEM_BUCKET_SLOTS, status, worldSummary, readPlatoon, setPlayerMoney, gameStateOf,
  resolveCharacter, setStats, setStat, trainCharacter,
  healPart, damagePart, setHunger, revive, restoreLimbs,
  setItemSection, setItemQuality, updateItem, addItem,
};
