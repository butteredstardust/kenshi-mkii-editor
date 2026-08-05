'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { readFile, writeFile } = require('./kenshi/codec');
const { asText, fromText, byteLength } = require('./kenshi/binary');
const paths = require('./pathService');
const gamedata = require('./gamedataService');
const races = require('./racesService');
const archetypes = require('./archetypes');
const personalities = require('./personalities');
const recruits = require('./recruits');
const itemCatalog = require('./itemCatalogService');
const itemSlots = require('./itemSlots');
const itemFactory = require('./itemFactory');
const characterFactory = require('./characterFactory');
const research = require('./researchService');
const blueprints = require('./blueprints');
const fitCheck = require('./fitCheck');
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
  // Per-squad metadata, one record in quick.save per .platoon file. Carries
  // `strings['faction name']`, `ints['char count']` and
  // `filenames['content file']` (the platoon path) — see playerSquadRecords().
  SQUAD_META: 34,
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
/**
 * A worn backpack holds its contents in its OWN inventory record, not in the
 * character's.
 *
 * The chain is one hop longer than it looks, and missing that hop is why this
 * editor showed no backpack contents at all despite 152 `backpack_content`
 * items sitting in the live save:
 *
 *   character
 *     -> INVENTORY (41)              the character's own
 *          -> ITEM (42)              the backpack itself, section backpack_attach
 *               -> instance -> INVENTORY (41)    the PACK's own container
 *                                 -> instances -> ITEM (42) x N, section backpack_content
 *
 * Verified on a live save: a Garru Backpack (sid 250) has exactly one instance
 * targeting sid 251, which is a type-41 record with 13 instances, every one of
 * them a type-42 item whose `section` is `backpack_content`. None of those 13
 * appear in the character's own inventory record, so nothing that reads only
 * the character's INVENTORY can ever see them.
 *
 * Returns the container's sid (so a future write can target it) and the
 * resolved contents.
 */
function packContentsOf(rec, bySid) {
  if (!bySid || !rec.instances.length) return { containerSid: null, contents: [] };
  for (const inst of rec.instances) {
    const container = bySid.get(inst.target);
    if (!container || container.type !== T.INVENTORY) continue;
    const contents = container.instances
      .map((ii) => bySid.get(ii.target))
      .filter((r) => r && r.type === T.ITEM)
      // One level only: a pack inside a pack is not a thing Kenshi does, and
      // recursing without a depth guard on save data is how you hang a request.
      .map((r) => itemOf(r));
    return { containerSid: container.sid, contents };
  }
  return { containerSid: null, contents: [] };
}

/**
 * What a blueprint item teaches, or null if it isn't one.
 *
 * Read-only: this editor writes a blueprint's subject when the item is minted
 * and never afterwards. `updateItem()` refuses `materialSid`/`gradeId` on
 * anything but a type-2 weapon, so the Gear row's grade control cannot reach
 * these two fields — which is what keeps a blueprint from being silently
 * repointed at something else by a UI meant for Meitou katanas.
 */
function blueprintOf(baseSid, strings) {
  if (!baseSid || !blueprints.isBlueprintTemplate(asText(baseSid))) return null;
  const teaches = asText(strings.get('material sid') || '');
  if (!teaches) return { teaches: '', subjectName: null, kind: null, resolved: false };
  try {
    const d = blueprints.describeEntry(teaches);
    return { teaches: d.teaches, subjectName: d.subjectName, kind: d.kind, resolved: d.resolved };
  } catch {
    // A blueprint the game wrote in a shape this editor does not recognise is
    // reported as-is rather than hidden — the save is the authority.
    return { teaches, subjectName: null, kind: null, resolved: false };
  }
}

function itemOf(rec, bySid = null) {
  const s = rec.strings;
  const baseSid = s.get('base data sid');
  const cat = itemCatalog.lookup(baseSid);
  const section = asText(s.get('section') || '');
  const { sections: allowedSections, widened: slotsWidened } = itemSlots.allowedSections(baseSid, section);
  const pack = packContentsOf(rec, bySid);
  return {
    sid: rec.sid,
    // Non-empty only for a container (a backpack) — see packContentsOf().
    contents: pack.contents,
    containerSid: pack.containerSid,
    base: asText(baseSid || ''),
    name: gamedata.nameOf(baseSid),
    material: gamedata.nameOf(s.get('material sid'), ''),
    // Weapon grade: the named tier a player recognises ("Meitou") is the
    // (company sid, material sid) pair, not `level` (TODO.md 2.2(i)). Raw
    // `materialSid` is surfaced so the Gear row's grade <select> can preselect
    // the item's current entry; null for non-weapons, which have no ladder.
    materialSid: asText(s.get('material sid') || ''),
    // The grade is the (company, material) PAIR — `materialSid` alone is
    // ambiguous (14 of 24 model sids belong to two companies). This composite
    // is what the Gear row's grade <select> matches its options against, and
    // what it sends back; see gamedataService.weaponGrades().
    gradeId: `${asText(s.get('company sid') || '')}|${asText(s.get('material sid') || '')}`,
    companySid: asText(s.get('company sid') || ''),
    // A BLUEPRINT carries the research-ledger entry it grants in those same two
    // fields (services/blueprints.js). Reported separately so the Gear row can
    // say what a stack of identical-looking "Blueprints" actually unlocks —
    // without it, five blueprints read as five copies of one item. Null for
    // everything that is not a blueprint, which is every other item.
    blueprint: blueprintOf(baseSid, s),
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

/**
 * A character's race, off the APPEARANCE (66) record.
 *
 * The race is NOT a key in `bools`/`floats`/`ints`/`strings` — it lives in the
 * record's `extra` section, category `"race"`, as a single row whose `target`
 * is the race stringID (docs/save-format.md §5, Phase 0 finding). Returns null
 * for a character with no appearance record or no race row.
 */
function raceOf(appearanceRec) {
  if (!appearanceRec) return null;
  const row = (appearanceRec.extra.get('race') || [])[0];
  if (!row || !row.target) return null;
  // The name comes from racesService, NOT gamedata.nameOf: race names are
  // routinely overridden by a mod later in the load order, and this install's
  // `17-gamedata.quack` is "Human" by first-definition-wins and "Greenlander" by
  // the rule the running game uses. See racesService.js.
  const resolved = races.raceBySid(row.target);
  const name = races.nameOf(row.target, row.target);
  // The wiki's per-race armour SLOT table, resolved once here so the UI never
  // has to re-implement "which races have a boots slot" (services/fitCheck.js
  // owns it, and labels it editorial — see that file for the measurement).
  // `armourSlots: null` means "no known slot restriction", not "no slots".
  const slotRule = fitCheck.raceSlotRule(name);
  return {
    sid: row.target,
    name,
    armourSlots: slotRule ? slotRule.slots : null,
    slotRuleLabel: slotRule ? slotRule.label : null,
    playable: resolved ? resolved.playable : null,
    // Null for a race with no `combat anatomy` anywhere in gamedata — the UI
    // shows those but cannot offer them as a switch target (see setRace()).
    switchable: resolved ? resolved.anatomy.length > 0 : false,
  };
}

/**
 * What a squad instance's `target` template says about this character's
 * dialogue — reported, never written.
 *
 * INVESTIGATION RESULT (the "can we enable dialogue?" question): **no, not from
 * the save.** A CHAR_STATE record carries no dialogue reference of any kind.
 * Across all 555 characters in a live save there are exactly four distinct
 * CHAR_STATE string-key shapes — `name, owner faction ID, sheath` plus optional
 * `bountyfac<n>` — and none of them names a dialogue package, a personality
 * record, or a voice.
 *
 * Dialogue is attached to the type-1 CHARACTER TEMPLATE in gamedata, as
 * `extra['dialogue package']` (what the character says to the world) and
 * `extra['dialogue package player']` (what it says to the player — the marker
 * of a talkable/recruitable character; 169 of this install's 659 templates
 * have one). The only thing the save stores is which template a character came
 * from: the squad instance's `target`.
 *
 * That makes the template's dialogue status worth SHOWING — it explains why
 * the characters from a "start- Homeless" game start have no dialogue at all
 * while a cloned "Lost drone" carries "Player HIVER Ronin" — but it does not
 * make dialogue editable. Repointing `target` at a talkative template is one
 * string edit, but that field is the character's whole origin (race template,
 * stats, gear rules, dialogue), and whether the game re-reads dialogue from it
 * for an already-spawned character is untestable offline. Not offered.
 */
function dialogueOf(targetSid) {
  const tmpl = targetSid ? gamedata.lookup(targetSid) : null;
  if (!tmpl || tmpl.type !== 1) return null;
  return {
    template: tmpl.name,
    packages: tmpl.dialoguePackages || [],
    playerPackages: tmpl.playerDialoguePackages || [],
    talksToPlayer: !!(tmpl.playerDialoguePackages || []).length,
  };
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
    const race = raceOf(pick(T.APPEARANCE));
    const partSids = fitCheck.bodyPartSids(pick(T.MEDICAL), BODY_SLOTS);

    /**
     * Why an owned item's fit warnings are attached HERE and not in itemOf():
     * itemOf() sees the item record and nothing else, and "can this race wear
     * this" needs the owner. Resolving it once per (character, item) on the
     * read keeps the whole question server-side — the Gear page would otherwise
     * have to re-implement Kenshi's restriction rules in the browser to put a
     * badge on a helmet a Shek is already wearing.
     */
    const withFit = (it) => ({
      ...it,
      fitWarnings: it.base
        ? fitCheck.warningsFor({
          templateSid: it.base,
          itemName: it.name,
          section: it.section,
          partSids,
          raceSid: race ? race.sid : null,
          raceName: race ? race.name : null,
        })
        : [],
    });

    characters.push({
      sid: inst.id,
      name: asText(state ? (state.strings.get('name') || '') : ''),
      origin: gamedata.nameOf(inst.target),
      isLeader: state ? (state.bools.get('is leader') ?? false) : false,
      personality: state ? state.ints.get('personality') ?? null : null,
      personalityLabel: personalities.label(state ? state.ints.get('personality') : null),
      // What the squad instance's `target` template says about this character's
      // dialogue. READ-ONLY and deliberately so: dialogue is attached to the
      // type-1 template in gamedata, never to anything in the save, so there is
      // nothing here to write. See dialogueOf().
      dialogue: dialogueOf(inst.target),
      age: state ? state.floats.get('age') ?? null : null,
      // Carried on every character read so nothing downstream has to re-scan
      // every platoon file just to learn a race (which is what the equip
      // scripts this feature replaced had to do).
      race,
      position: inst.pos,
      medical: medicalOf(pick(T.MEDICAL)),
      stats: statsOf(pick(T.STATS)),
      inventory: bag
        ? bag.instances.map((ii) => bySid.get(ii.target)).filter(Boolean)
          .map((r) => withFit(itemOf(r, bySid)))
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
      // The record that carries `extra['race']` — the save's only statement of
      // what species a character is. See setRace().
      appearance: pick(T.APPEARANCE),
    },
  };
}

/**
 * The quick.save SQUAD_META (34) records belonging to `faction`.
 *
 * One type-34 record exists per `.platoon` file in the save, keyed to it by
 * `filenames['content file']` (e.g. "platoon/Nameless_0.platoon") and tagged
 * with `strings['faction name']`. This is the authoritative squad list; the
 * `<Faction>_<n>.platoon` filename convention is a consequence of it, not the
 * other way round.
 */
function playerSquadRecords(world, faction) {
  if (!faction) return [];
  return world.records.filter((r) => r.type === T.SQUAD_META
    && asText(r.strings.get('faction name') || '') === faction);
}

/**
 * Absolute paths of the player faction's `.platoon` files.
 *
 * Resolved through quick.save's SQUAD_META records rather than by matching the
 * `<Faction>_<n>.platoon` filename prefix. That matters because
 * renamePlayerFaction() exists: renaming the faction rewrites the display name
 * in quick.save but deliberately does NOT rename files on disk (a platoon
 * file's name is baked into its own record sid, `platoon stringID` and
 * `content file`, and mutationService installs files, it does not move them).
 * A prefix match would report "no player squad" the moment the user renamed
 * their faction. The prefix scan survives only as a fallback for a save whose
 * type-34 records don't name a content file.
 *
 * `world` is optional; it is passed in by callers that have already parsed
 * quick.save so the file isn't read twice.
 */
function playerPlatoonFiles(dir, faction, world = null) {
  const pdir = path.join(dir, 'platoon');
  if (!faction || !fs.existsSync(pdir)) return [];

  const parsed = world || readSaveFile(dir, 'quick.save');
  const out = [];
  for (const rec of playerSquadRecords(parsed, faction)) {
    const rel = asText(rec.filenames.get('content file') || '');
    const m = /^platoon[/\\]([^/\\]+\.platoon)$/.exec(rel);
    if (!m) continue; // e.g. a dead squad whose content file is the bare "platoon/"
    const abs = path.join(pdir, m[1]);
    if (fs.existsSync(abs) && !out.includes(abs)) out.push(abs);
  }
  if (out.length) return out.sort();

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
  const squads = playerPlatoonFiles(save.dir, summary.faction, world).map((f) => {
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

  const { relFile, parsed, records } = resolveCharacter(saveDir, platoonFile, characterSid);
  const rec = records.stats;
  if (!rec) throw new Error(`${platoonFile}: character "${characterSid}" has no STATS record (type 25)`);

  const result = applyStatSpread(rec, { archetypeSkills, mode, rng });

  return {
    file: relFile,
    bytes: writeFile(parsed),
    ...result,
  };
}

/**
 * Write a coherent stat spread across a STATS (25) record: attributes to a flat
 * value, the archetype's own skills rolled in one band and every other skill in
 * a lower one.
 *
 * Extracted so "Train as archetype" and "Add squad member" produce stats the
 * same way — a recruit rolled as a Veteran Soldier and a character trained as a
 * Soldier should differ in tier, not in method. The ranges are parameters
 * precisely because addSquadMember() varies them by power tier
 * (services/recruits.js); trainCharacter()'s defaults are the values it has
 * always used.
 *
 * Only ever writes keys already present in `rec.floats` (iterating the Map
 * directly, never a hardcoded key list), so a non-human character with a
 * smaller skill set — or a modded one with extra keys — is handled without
 * minting a float key the game may not read.
 *
 * `mode: 'raise'` never lowers an existing value; `'set'` overwrites.
 */
function applyStatSpread(rec, {
  archetypeSkills = [],
  attribute = 45,
  archRange = [45, 95],
  otherRange = [15, 40],
  mode = 'raise',
  rng = Math.random,
} = {}) {
  const archetypeSet = new Set(archetypeSkills);
  const round1 = (v) => Math.round(v * 10) / 10;
  const roll = ([min, max]) => round1(min + rng() * (max - min));

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
    applyOne(a, attribute);
  }

  for (const key of rec.floats.keys()) {
    if (key === 'xp' || key === 'free attribute points' || ATTRIBUTES.includes(key)) continue;
    applyOne(key, roll(archetypeSet.has(key) ? archRange : otherRange));
  }

  return { before, after, changedCount };
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
const UPDATE_ITEM_FIELDS = new Set(['section', 'level', 'quality', 'quantity', 'materialSid', 'gradeId']);

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
  const { section, level, quality, quantity, materialSid, gradeId } = opts;
  if (section === undefined && level === undefined && quality === undefined
    && quantity === undefined && materialSid === undefined && gradeId === undefined) {
    throw new Error('updateItem: provide at least one of section, level, quality, quantity, materialSid, gradeId');
  }

  const ctx = resolveCharacterItem(saveDir, platoonFile, characterSid, itemSid);
  const {
    relFile, parsed, bag, bySid, itemRec,
  } = ctx;

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
  //
  // `gradeId` ("<companySid>|<modelSid>") is the unambiguous key and what the
  // UI sends; bare `materialSid` names only the model and can match two ladder
  // rows (14 of 24 model sids do), so itemFactory.resolveGrade() pins it to the
  // lowest-ranked one. Either way the pair is written together.
  let grade = null;
  if (materialSid !== undefined || gradeId !== undefined) {
    for (const [key, value] of Object.entries({ materialSid, gradeId })) {
      if (value !== undefined && (typeof value !== 'string' || !value)) {
        throw new Error(`${key} must be a non-empty string`);
      }
    }
    const tmpl = gamedata.lookup(baseSid);
    if (!tmpl || tmpl.type !== 2) {
      throw new Error(`"${itemName}" is not a weapon — grade only applies to weapons`);
    }
    grade = itemFactory.resolveGrade({ gradeId, materialSid });
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
      grade: grade ? { id: grade.id, modelName: grade.modelName, companyName: grade.companyName, rank: grade.rank } : null,
      displacedSid: displaced ? displaced.sid : null,
      displacedSection: displaced ? 'main' : null,
    },
    // Moving an item INTO a slot is equipping it, so it gets the same advisory
    // race check the add and bulk paths do. Only on a section change: re-grading
    // a helmet the character was already wearing tells them nothing new.
    fitWarnings: section === undefined ? [] : (() => {
      const race = raceOf(ctx.records.appearance);
      return fitCheck.warningsFor({
        templateSid: asText(baseSid || ''),
        itemName,
        section,
        partSids: fitCheck.bodyPartSids(ctx.records.medical, BODY_SLOTS),
        raceSid: race ? race.sid : null,
        raceName: race ? race.name : null,
      });
    })(),
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
// `teaches` is the blueprint case: a blueprint item's subject rides in the same
// two string fields a weapon's grade uses, so it is listed here for the same
// reason — a misnamed option must fail loudly rather than mint a blank
// blueprint that teaches nothing (see services/blueprints.js).
const ADD_ITEM_OPTIONS = new Set(['quantity', 'section', 'level', 'materialSid', 'companySid', 'gradeId', 'teaches']);

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
  // The supported set lives in itemFactory, which is what actually mints the
  // record — a second hardcoded copy here is how backpacks, crossbows and
  // robotic limbs each became addable everywhere EXCEPT this route.
  if (!itemFactory.TEMPLATE_TYPES.includes(tmpl.type)) {
    throw new Error(`template "${templateSid}" (${tmpl.name}) is typecode ${tmpl.type}, not an item template (${itemFactory.TEMPLATE_TYPES.join('/')}) — see TODO.md 2.2(g)`);
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

  // Race fit, on the single-item path too. It never refuses (AGENTS.md §3), but
  // bulk equip reporting "a Shek cannot wear this helmet" while the per-character
  // Add item said nothing was the kind of asymmetry that makes a user trust
  // neither. Computed BEFORE the mint so the receipt describes the write.
  const race = raceOf(records.appearance);
  const fitWarnings = fitCheck.warningsFor({
    templateSid,
    itemName: tmpl.name,
    section,
    partSids: fitCheck.bodyPartSids(records.medical, BODY_SLOTS),
    raceSid: race ? race.sid : null,
    raceName: race ? race.name : null,
  });

  const { record, meta } = itemFactory.buildItemRecord(templateSid, {
    section,
    level: opts.level,
    quantity,
    gradeId: opts.gradeId,
    materialSid: opts.materialSid,
    companySid: opts.companySid,
    ...(opts.teaches === undefined ? {} : { teaches: opts.teaches }),
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
      blueprint: meta.blueprint,
    },
    displaced: displaced ? { sid: displaced.sid, section: 'main' } : null,
    warnings: [
      ...(meta.blueprint ? blueprintWarnings(saveDir, meta.blueprint) : []),
      ...fitWarnings.map((w) => w.text),
    ],
    fitWarnings,
  };
}

/**
 * Advisory notes for a blueprint that is about to be added. Never blocks —
 * handing someone a duplicate blueprint is a wasted item, not a corrupt save,
 * and the ledger is the only thing that knows, so the user has no other way to
 * find out.
 *
 * Reads quick.save out of the SAME directory the item is being written into,
 * which under the mutation gate is the staging copy — so the check sees exactly
 * the state this write lands on.
 */
function blueprintWarnings(saveDir, blueprint) {
  const out = [];
  if (!blueprint.resolved) {
    out.push(`No installed mod defines "${blueprint.subjectSid}" — the blueprint will be added, `
      + 'but nothing in this install says what it unlocks.');
  }
  try {
    const world = readSaveFile(saveDir, 'quick.save');
    const entries = new Set(research.entriesOf(research.ledgerRecord(world)));
    if (entries.has(blueprint.teaches)) {
      out.push(`This save has already finished "${blueprint.subjectName || blueprint.subjectSid}" — `
        + 'the blueprint will still appear in the inventory, but using it grants nothing.');
    }
  } catch { /* the ledger is a courtesy check; a save without one is not an error here */ }
  return out;
}

// ---------------------------------------------------------------- naming --

// Names are length-prefixed byte strings with no documented cap. 63 UTF-8 bytes
// is this editor's own conservative choice (TODO.md 1.3 proposed it): long
// enough for any realistic name, short enough that the game's UI will not have
// to truncate something the user cannot see they typed.
const MAX_NAME_BYTES = 63;

/**
 * Validate and encode user-supplied display text for a record string field.
 *
 * Returns the latin1-carried form the codec writes. Rejects control characters
 * outright — a newline or NUL inside a name is not something the game's UI can
 * render back, and NUL in particular would be invisible in every readback this
 * editor performs, so it must never reach a save.
 */
function encodeName(text, label = 'name') {
  if (typeof text !== 'string') throw new Error(`${label} must be a string`);
  const trimmed = text.trim();
  if (!trimmed) throw new Error(`${label} must not be empty`);
  for (const ch of trimmed) {
    const code = ch.codePointAt(0);
    if (code < 0x20 || code === 0x7f) throw new Error(`${label} must not contain control characters`);
  }
  const bytes = byteLength(trimmed);
  if (bytes > MAX_NAME_BYTES) {
    throw new Error(`${label} must be at most ${MAX_NAME_BYTES} bytes (this one is ${bytes})`);
  }
  return { text: trimmed, encoded: fromText(trimmed), bytes };
}

/**
 * Rename a character: `strings.name` on the CHAR_STATE (36) record.
 *
 * The STATS (25) record's own header `name` is written too. That field is not a
 * Map entry and is not a per-character field in general — on an untouched NPC
 * it holds the origin template's name ("Cannibal", shared by every character
 * spawned from it) — but on a character the player has actually named, the game
 * itself writes the character's name there (a live player character's STATS
 * record reads "Dai"). Writing it keeps a renamed character consistent with how
 * the game stores its own, and matches the FCS guide's "also update the name on
 * the STATS entry" advice.
 */
function renameCharacter(saveDir, platoonFile, characterSid, newName) {
  const { text, encoded } = encodeName(newName, 'name');

  const { relFile, parsed, records } = resolveCharacter(saveDir, platoonFile, characterSid);
  const state = records.state;
  if (!state) throw new Error(`${platoonFile}: character "${characterSid}" has no CHAR_STATE record (type 36)`);
  if (!state.strings.has('name')) throw new Error(`${platoonFile}: character "${characterSid}" has no "name" string field`);

  const before = asText(state.strings.get('name') || '');
  if (before === text) throw new Error(`this character is already named "${text}"`);

  state.strings.set('name', encoded);
  const statsRec = records.stats;
  const statsBefore = statsRec ? asText(statsRec.name) : null;
  if (statsRec) statsRec.name = encoded;

  return {
    file: relFile,
    bytes: writeFile(parsed),
    before: { name: before, statsRecordName: statsBefore },
    after: { name: text, statsRecordName: statsRec ? text : null },
  };
}

/**
 * Set `ints.personality` on a character's CHAR_STATE (36) record.
 *
 * See services/personalities.js for how the seven working values were decoded
 * from gamedata's type-26 records. `allowUnknown` exists because the guide
 * warns other values are unimplemented rather than harmful — the editor
 * defaults to refusing them, but does not pretend to know they are impossible.
 *
 * Never mints the key: a character whose record has no `personality` int is
 * left alone, same discipline as setStats().
 */
function setPersonality(saveDir, platoonFile, characterSid, value, { allowUnknown = false } = {}) {
  const v = Number(value);
  if (!Number.isInteger(v)) throw new Error('personality must be an integer');
  if (!allowUnknown && !personalities.isKnown(v)) {
    throw new Error(
      `personality ${v} is not one of the values the game uses `
      + `(${personalities.KNOWN_VALUES.join(', ')}) — the others are unimplemented in vanilla`,
    );
  }

  const { relFile, parsed, records } = resolveCharacter(saveDir, platoonFile, characterSid);
  const rec = records.state;
  if (!rec) throw new Error(`${platoonFile}: character "${characterSid}" has no CHAR_STATE record (type 36)`);
  if (!rec.ints.has('personality')) {
    throw new Error(`${platoonFile}: character "${characterSid}" has no "personality" int field`);
  }

  const before = rec.ints.get('personality');
  if (before === v) throw new Error(`this character's personality is already ${personalities.label(v)}`);
  rec.ints.set('personality', v);

  return {
    file: relFile,
    bytes: writeFile(parsed),
    before: { personality: before, label: personalities.label(before) },
    after: { personality: v, label: personalities.label(v) },
  };
}

// ------------------------------------------------------------------ race --

/**
 * Work out how a character's MEDICAL body plan maps onto another race's, slot
 * by slot, without ever reordering it.
 *
 * The character's existing plan defines the slots (`sid0..sidN`, a fixed order
 * every race in every save on this machine agrees on — see racesService.js).
 * Each slot is filled from the target race's anatomy:
 *
 *   1. by matching stringID, which is what happens for all seven slots on any
 *      humanoid-to-humanoid switch (Greenlander -> Scorchlander, Skeleton P4 ->
 *      Soldierbot: same seven parts, different `hit`/`max` numbers);
 *   2. failing that, by `racesService.partsInterchangeable()` — same `body part
 *      type` and `collapse part` — which is how a Left Foreleg lands in a Left
 *      Arm's slot on a human -> animal switch.
 *
 * Matching by stringID FIRST is what keeps Chest and Stomach apart: those two
 * type-16 records are interchangeable by rule 2 (both `body part type` 0,
 * both `collapse part` 1), but every race names them identically, so rule 2
 * never has to choose between them. If some race ever did, the leftover pass
 * below walks slots in order and takes the first unclaimed candidate, and the
 * caller is told via `refusals` when nothing fits at all.
 *
 * Throws nothing: an unmappable plan comes back with `ok: false` and reasons,
 * so both the preview and the write can report the same thing.
 */
function mapBodyPlan(medicalRec, targetRace) {
  const slots = [];
  for (let i = 0; medicalRec.strings.has(`sid${i}`); i++) {
    slots.push({
      index: i,
      sid: asText(medicalRec.strings.get(`sid${i}`)),
      hit: medicalRec.floats.get(`hit${i}`) ?? null,
      flesh: medicalRec.floats.get(`flesh${i}`) ?? null,
    });
  }

  const pool = targetRace.anatomy.map((p) => ({ ...p, taken: false }));
  const refusals = [];

  for (const slot of slots) {
    let hit = pool.find((p) => !p.taken && p.sid === slot.sid);
    if (!hit) hit = pool.find((p) => !p.taken && races.partsInterchangeable(slot.sid, p.sid));
    if (hit) { hit.taken = true; slot.to = hit; } else {
      refusals.push(`slot ${slot.index} (${races.partBySid(slot.sid)?.name || slot.sid}) has no counterpart in ${targetRace.name}`);
    }
  }

  const unused = pool.filter((p) => !p.taken);
  if (unused.length) {
    refusals.push(`${targetRace.name} has ${unused.length} body part(s) this character has no slot for `
      + `(${unused.map((p) => p.name).join(', ')})`);
  }

  return { ok: refusals.length === 0, slots, refusals };
}

/**
 * Describe what switching `characterSid` to `raceSid` would do — the same
 * computation `setRace()` performs, minus the write.
 *
 * Every difficulty this feature has is ADVISORY, in the house style
 * (`services/fitCheck.js`, AGENTS.md §3 "race compatibility is advisory"). The
 * only hard refusals are the two that would produce a save this editor cannot
 * describe: a target race with no `combat anatomy` at all, and a body plan that
 * does not map (see mapBodyPlan).
 */
function previewRaceChange(medicalRec, appearanceRec, fromRaceSid, raceSid) {
  const target = races.raceBySid(raceSid);
  if (!target) throw new Error(`no race with stringID "${raceSid}" in this install's data`);
  if (!target.anatomy.length) {
    throw new Error(
      `"${target.name}" carries no combat anatomy in any of its ${target.definitions} definition(s), `
      + 'so this editor cannot work out the body plan to write. Switching to it would leave the '
      + "character's MEDICAL record describing a different species.",
    );
  }
  if (fromRaceSid === raceSid) throw new Error(`this character is already a ${target.name}`);

  const from = races.raceBySid(fromRaceSid);
  const plan = mapBodyPlan(medicalRec, target);
  if (!plan.ok) {
    throw new Error(
      `cannot map a ${from ? from.name : fromRaceSid} body onto a ${target.name}: ${plan.refusals.join('; ')}`,
    );
  }

  // Advisory only — none of these block the write.
  const warnings = [];
  const fromFamily = from ? from.appearanceFamily : null;
  if (!fromFamily || !target.appearanceFamily || fromFamily !== target.appearanceFamily) {
    warnings.push(
      `${from ? from.name : 'this character'} and ${target.name} use different appearance slider sets `
      + `(${fromFamily || 'none'} vs ${target.appearanceFamily || 'none'}). The face and body sliders are `
      + 'kept as they are — the game applies the ones the new race understands and ignores the rest, so '
      + 'expect the character to look different.',
    );
  }
  if (!target.playable) {
    warnings.push(`${target.name} is not flagged playable in gamedata. The game still renders it, but it is `
      + 'not a race the character creator offers.');
  }
  const changedParts = plan.slots.filter((s) => s.to.sid !== s.sid);
  if (changedParts.length) {
    warnings.push(`${changedParts.length} body part(s) are replaced outright: `
      + changedParts.map((s) => `${races.partBySid(s.sid)?.name || s.sid} -> ${s.to.name}`).join(', '));
  }
  const appearanceRows = appearanceRec ? (appearanceRec.extra.get('race') || []).length : 0;
  if (appearanceRows > 1) {
    warnings.push(`this character's APPEARANCE record carries ${appearanceRows} race rows; only the first is `
      + 'rewritten, which is the one every read path uses.');
  }

  return {
    from: from ? { sid: from.sid, name: from.name } : { sid: fromRaceSid, name: fromRaceSid },
    to: { sid: target.sid, name: target.name },
    plan,
    warnings,
    parts: plan.slots.map((s) => ({
      index: s.index,
      from: { sid: s.sid, name: races.partBySid(s.sid)?.name || s.sid, hit: s.hit, flesh: s.flesh },
      to: { sid: s.to.sid, name: s.to.name, hit: s.to.hit, max: s.to.max },
    })),
  };
}

/**
 * Change a character's race.
 *
 * TWO records are rewritten, and they are the only two a race is written into:
 *
 *   APPEARANCE (66)  `extra['race']` row 0 `target` -> the new race's stringID.
 *                    This is the save's entire statement of species.
 *   MEDICAL (57)     `sid<n>` and `hit<n>` -> the new race's `combat anatomy`,
 *                    slot for slot (mapBodyPlan), and `flesh<n>` SCALED by the
 *                    ratio of the two parts' maxima.
 *
 * Why scale `flesh<n>` rather than clamp or refill it: `v1` is a race's natural
 * maximum, not a hard ceiling — 39 live Hive Worker Drones read up to 125
 * against a v1 of 75 because they are wearing robotic limbs, and those are the
 * same characters whose `hitmult<n>` stops being 1. Clamping would silently
 * confiscate a prosthetic; refilling would turn a race switch into a free heal.
 * Scaling by `newMax / oldMax` keeps a half-severed arm half-severed and a
 * prosthetic proportionally over-strength, which is the only choice that
 * preserves what the player actually has.
 *
 * Deliberately NOT touched:
 *   - `hitmult<n>`/`rig<n>`/`wear<n>`/`bandage<n>`/`stun<n>` — measured
 *     per-character, not per-race (1/0/0 on everyone without prosthetics).
 *   - The APPEARANCE sliders. They are the character's face. A cross-family
 *     switch is warned about, not sanitised: deleting slider keys the new race
 *     might not read would destroy a face this editor cannot rebuild, and
 *     nothing in the data says the game minds extra keys.
 *   - The squad instance's `target` (the type-1 origin template). It names where
 *     the character CAME from — race template, stats, gear rules and dialogue —
 *     and repointing it is a different, untestable edit (see dialogueOf()).
 *   - STATS. A race's `stats good`/`stats bad` rows are hiring-time hints, not a
 *     running modifier; nothing in a save records them per character.
 */
function setRace(saveDir, platoonFile, characterSid, raceSid) {
  if (typeof raceSid !== 'string' || !raceSid.trim()) throw new Error('raceSid is required');

  const { relFile, parsed, records } = resolveCharacter(saveDir, platoonFile, characterSid);
  const appearance = records.appearance;
  const medical = records.medical;
  if (!appearance) {
    throw new Error(`${platoonFile}: character "${characterSid}" has no APPEARANCE record (type 66), `
      + 'which is the only place a race is stored');
  }
  if (!medical) {
    throw new Error(`${platoonFile}: character "${characterSid}" has no MEDICAL record (type 57)`);
  }
  const raceRows = appearance.extra.get('race') || [];
  if (!raceRows.length || !raceRows[0].target) {
    throw new Error(`${platoonFile}: character "${characterSid}" has no race row in its APPEARANCE record`);
  }

  const fromSid = raceRows[0].target;
  const preview = previewRaceChange(medical, appearance, fromSid, raceSid);

  // 1. The race itself. Only `target` moves — `v0`/`v1`/`v2` are left exactly as
  //    the game wrote them, since nothing here has decoded what they mean.
  raceRows[0].target = raceSid;

  // 2. The body plan, in place, slot by slot.
  const partsChanged = [];
  for (const slot of preview.plan.slots) {
    const before = {
      sid: slot.sid,
      hit: medical.floats.get(`hit${slot.index}`) ?? null,
      flesh: medical.floats.get(`flesh${slot.index}`) ?? null,
    };
    medical.strings.set(`sid${slot.index}`, fromText(slot.to.sid));
    if (medical.floats.has(`hit${slot.index}`)) medical.floats.set(`hit${slot.index}`, slot.to.hit);

    // Scale flesh by the ratio of the two maxima. A zero or missing old maximum
    // gives no ratio to scale by, so the value is left alone rather than
    // divided by zero into a NaN — and a NaN written into a save is exactly the
    // thing docs/save-format.md §2 warns costs a byte-identical round trip.
    const oldRace = races.raceBySid(fromSid);
    const oldPart = oldRace ? oldRace.anatomy.find((p) => p.sid === slot.sid) : null;
    const oldMax = oldPart ? oldPart.max : null;
    if (medical.floats.has(`flesh${slot.index}`) && oldMax && slot.to.max) {
      const scaled = (medical.floats.get(`flesh${slot.index}`) * slot.to.max) / oldMax;
      if (Number.isFinite(scaled)) medical.floats.set(`flesh${slot.index}`, scaled);
    }
    partsChanged.push({
      index: slot.index,
      before,
      after: {
        sid: slot.to.sid,
        name: slot.to.name,
        hit: medical.floats.get(`hit${slot.index}`) ?? null,
        flesh: medical.floats.get(`flesh${slot.index}`) ?? null,
        max: slot.to.max,
      },
    });
  }

  return {
    file: relFile,
    bytes: writeFile(parsed),
    before: { race: preview.from },
    after: { race: preview.to },
    parts: partsChanged,
    warnings: preview.warnings,
  };
}

/**
 * Rename the player faction — the name shown on the squad, and the only
 * squad-level name a Kenshi save actually stores.
 *
 * There is NO per-squad display-name field. A full sweep of a live save
 * (quick.save + all 23 `.platoon` files) for any string key or value resembling
 * a squad name found exactly three places the player's chosen name is written:
 *
 *   1. GAME_STATE (56) `strings['pfaction name']` — the canonical one.
 *   2. Every SQUAD_META (34) record of that faction, `strings['faction name']`.
 *   3. The player's FACTION (37) record's header `name`.
 *
 * All three are rewritten together, because leaving any of them behind would
 * make the save internally inconsistent about who the player is (and this
 * editor's own squad lookup keys off 1 matching 2 — see playerPlatoonFiles()).
 *
 * What is deliberately NOT touched: the SQUAD_META record's `sid`, header
 * `name`, `strings['platoon stringID']` and `filenames['content file']`, and
 * the `.platoon` filenames themselves. Those four are one identity —
 * "Nameless_0" — and renaming them would mean renaming files on disk, which
 * mutationService cannot do (it installs changed file *contents*; it never
 * moves, creates or deletes a path). A squad whose file is still called
 * `Nameless_0.platoon` after the faction becomes "The Wolves" is cosmetically
 * odd in the save folder and completely correct in the game.
 */
function renamePlayerFaction(saveDir, newName) {
  const { text, encoded } = encodeName(newName, 'faction name');

  const world = readSaveFile(saveDir, 'quick.save');
  const gs = gameStateOf(world);
  const before = asText(gs.strings.get('pfaction name') || '');
  if (!gs.strings.has('pfaction name')) {
    throw new Error('this save\'s game-state record has no "pfaction name" field');
  }
  if (before === text) throw new Error(`the player faction is already named "${text}"`);

  const squadRecords = playerSquadRecords(world, before);
  gs.strings.set('pfaction name', encoded);
  for (const rec of squadRecords) rec.strings.set('faction name', encoded);

  // The FACTION (37) record is identified by its header name matching the old
  // faction name. Only renamed when that is unambiguous — two factions sharing
  // a display name would make "which one is the player's" a guess, and a wrong
  // guess would rename an unrelated faction.
  const factionMatches = world.records.filter((r) => r.type === T.FACTION && asText(r.name) === before);
  const renamedFactionRecord = factionMatches.length === 1;
  if (renamedFactionRecord) factionMatches[0].name = encoded;

  return {
    file: 'quick.save',
    bytes: writeFile(world),
    before: { name: before },
    after: {
      name: text,
      squadRecords: squadRecords.map((r) => asText(r.sid)),
      renamedFactionRecord,
      factionRecordMatches: factionMatches.length,
    },
  };
}

// ------------------------------------------------------- new squad member --

/**
 * Read every character cluster in a save's platoon files, tagged with its race.
 *
 * The race lives in the APPEARANCE (66) record's `extra` section, category
 * "race", as a single row whose `target` is the race stringID — not in any
 * key/value Map (Phase 0 finding, see TODO.md 1.5). This is the donor pool
 * addSquadMember() clones from and the source of the race list the UI offers:
 * the editor only ever offers races it can actually produce from this save.
 */
function scanCharacters(saveDir) {
  const pdir = path.join(saveDir, 'platoon');
  if (!fs.existsSync(pdir)) return [];
  const out = [];
  for (const file of fs.readdirSync(pdir).filter((f) => f.endsWith('.platoon')).sort()) {
    let parsed;
    try {
      parsed = readFile(fs.readFileSync(path.join(pdir, file)));
    } catch {
      continue; // an unparseable platoon is not a donor; status() would surface it
    }
    const bySid = new Map(parsed.records.map((r) => [r.sid, r]));
    const squad = parsed.records.find((r) => r.type === T.SQUAD);
    if (!squad) continue;
    for (const inst of squad.instances) {
      const states = inst.states.map((s) => bySid.get(s)).filter(Boolean);
      const pick = (type) => states.find((r) => r.type === type) || null;
      const appearance = pick(T.APPEARANCE);
      if (!appearance) continue;
      const raceRow = (appearance.extra.get('race') || [])[0];
      if (!raceRow || !raceRow.target) continue;
      out.push({
        file, parsed, instance: inst, states,
        raceSid: raceRow.target,
        state: pick(T.CHAR_STATE),
        medical: pick(T.MEDICAL),
      });
    }
  }
  return out;
}

/**
 * Rank a candidate donor by how healthy it is. Higher is better; `null` means
 * "not a usable donor at all".
 *
 * This matters because a clone inherits the donor's MEDICAL record wholesale.
 * healMedical() resets flesh/stun/bandage/KO and the death flags, but `blood`
 * has no defensible "full" value to write (it ranges -67.8 to 183.2 across a
 * live save), so the only way to avoid handing the player a recruit who
 * immediately bleeds out is to clone someone who is already fine.
 */
function donorScore(candidate) {
  const m = candidate.medical;
  if (!m) return null;
  if (m.bools.get('dead') || m.bools.get('coma') || m.bools.get('incapacitated')) return null;
  const flesh = [];
  for (let i = 0; i < BODY_SLOTS; i++) {
    if (m.floats.has(`hit${i}`)) flesh.push(m.floats.get(`flesh${i}`) ?? 0);
  }
  if (!flesh.length) return null;
  const max = Math.max(...flesh);
  if (max <= 0) return null;
  const worstRatio = Math.min(...flesh) / max;
  const blood = m.floats.get('blood') ?? 0;
  if (blood <= 0) return null;
  // Intactness dominates; blood breaks ties. Both are only ever compared
  // against other candidates, so the absolute scale is unimportant.
  return worstRatio * 1000 + Math.min(blood, 100);
}

/** Races this save can actually supply a donor for, most-populous first. */
function availableRaces(saveDir) {
  const byRace = new Map();
  for (const c of scanCharacters(saveDir)) {
    let entry = byRace.get(c.raceSid);
    if (!entry) {
      entry = { sid: c.raceSid, name: races.nameOf(c.raceSid, c.raceSid), count: 0, donors: 0 };
      byRace.set(c.raceSid, entry);
    }
    entry.count += 1;
    if (donorScore(c) !== null) entry.donors += 1;
  }
  // Sorted by donor count, not head count: `donors` is the number the UI shows
  // and the only one that says anything about whether this race is a good bet
  // to recruit. `count` breaks ties.
  return [...byRace.values()]
    .filter((r) => r.donors > 0)
    .sort((a, b) => (b.donors - a.donors) || (b.count - a.count));
}

/**
 * Pick the race to preselect in the UI.
 *
 * "Greenlander" is the requested default, but it is a name this install's data
 * may not use at all — the human race in this save resolves to the name
 * "Human" (`17-gamedata.quack`), because vanilla data was consolidated over the
 * years and the Greenlander/Scorchlander split is not how every install's
 * records are named. So the default is resolved by preference order against
 * whatever the save actually contains, and falls back to the most populous
 * race rather than to nothing.
 */
const DEFAULT_RACE_PREFERENCE = [/^greenlander$/i, /greenlander/i, /^human$/i, /human/i];

function defaultRace(races) {
  for (const pattern of DEFAULT_RACE_PREFERENCE) {
    const hit = races.find((r) => pattern.test(r.name));
    if (hit) return hit;
  }
  return races[0] || null;
}

/** Resolve a platoon file to its parsed contents plus its SQUAD (30) record. */
function resolveSquad(saveDir, platoonFile) {
  if (typeof platoonFile !== 'string'
    || !/^[^/\\]+\.platoon$/.test(platoonFile)
    || platoonFile.includes('..')) {
    throw new Error(`invalid platoon file name "${platoonFile}"`);
  }
  const relFile = path.join('platoon', platoonFile);
  const abs = path.join(saveDir, relFile);
  if (!fs.existsSync(abs)) throw new Error(`no platoon file "${platoonFile}" in this save`);

  const parsed = readFile(fs.readFileSync(abs));
  const squad = parsed.records.find((r) => r.type === T.SQUAD);
  if (!squad) throw new Error(`${platoonFile}: no squad record (type 30)`);
  return { relFile, parsed, squad };
}

/** The quick.save SQUAD_META (34) record describing one platoon file, or null. */
function squadMetaFor(world, platoonFile) {
  const wanted = `platoon/${platoonFile}`;
  return world.records.find((r) => r.type === T.SQUAD_META
    && asText(r.filenames.get('content file') || '').replace(/\\/g, '/') === wanted) || null;
}

/**
 * Add a brand-new member to a squad — the largest mutation in this editor, and
 * the only one that writes two files.
 *
 * The new character is CLONED from an existing character of the requested race
 * somewhere in this same save; see services/characterFactory.js for why that is
 * the only responsible way to produce a race-correct MEDICAL body plan and
 * APPEARANCE record without deriving the game's own character-instantiation
 * rules. The donor is picked for health, never for identity: its name, faction,
 * leader flag, bounties, wounds and inventory are all discarded.
 *
 * Ids: seven are minted from this platoon file's own header `nextId` — six
 * state records plus one more for the squad instance's handle id. That
 * seventh is not a typo: a character instance's `id` is sid-shaped
 * ("32--INGAME") and, across all 282 character instances of a live save, is
 * never any record's sid — the ids they consume appear as exact gaps in each
 * file's record-id sequence. See services/kenshi/ids.js.
 *
 * Counts kept in lockstep, all three of which the game maintains itself:
 *   - the SQUAD (30) record's `ints['char count']`
 *   - the quick.save SQUAD_META (34) record's `ints['char count']`
 *   - GAME_STATE (56) `ints.members`
 * `instanceCount` on the SQUAD record is deliberately NOT touched — 23 of 25
 * live squad records carry 0 against 2-19 real instances, so ids.addInstance()
 * only keeps it in lockstep where the file already did (AGENTS.md §3).
 *
 * @param {string} saveDir
 * @param {string} platoonFile           e.g. "Nameless_0.platoon"
 * @param {object} opts
 * @param {string} opts.name             display name for the new member
 * @param {string} opts.raceSid          a race stringID from availableRaces()
 * @param {string} opts.archetype        archetype id (services/archetypes.js)
 * @param {string} opts.sub              sub-archetype id
 * @param {string} [opts.tier='capable'] power tier id (services/recruits.js)
 * @param {function} [opts.rng]          injectable for deterministic tests
 */
function addSquadMember(saveDir, platoonFile, {
  name, raceSid, archetype, sub, tier = 'capable', rng = Math.random,
} = {}) {
  // Validate everything cheap and everything that can throw on bad input BEFORE
  // parsing a 4 MB save (same discipline as addItem()).
  const { text: charName, encoded } = encodeName(name, 'name');
  const { skills: archetypeSkills, main, sub: subEntry } = archetypes.resolveSkills(archetype, sub);
  const spread = recruits.tier(tier);
  if (typeof raceSid !== 'string' || !raceSid) throw new Error('raceSid must be a non-empty string');

  const { relFile, parsed, squad } = resolveSquad(saveDir, platoonFile);

  // --- pick a donor -------------------------------------------------------
  const candidates = scanCharacters(saveDir)
    .filter((c) => c.raceSid === raceSid)
    .map((c) => ({ c, score: donorScore(c) }))
    .filter((x) => x.score !== null);
  if (!candidates.length) {
    const raceName = gamedata.nameOf(raceSid, raceSid);
    throw new Error(
      `no healthy ${raceName} character exists anywhere in this save to model a new member on. `
      + 'This editor builds a new character by cloning one of that race out of the save itself '
      + '(that is the only way to get a correct per-race body plan and appearance record), so a '
      + 'race with no living example in the save cannot be recruited.',
    );
  }
  // Preference order: (1) anyone undamaged enough that the choice between them
  // is cosmetic, (2) among those, a donor already in the target platoon, (3)
  // health. Ordering health above locality would routinely clone an NPC out of
  // another faction's squad just because they were 1% less bruised than the
  // player's own character of the same race — and the clone inherits the
  // donor's origin template, which is what the roster shows as "origin".
  const HEALTHY = 900; // donorScore(): every part within 90% of the best one
  candidates.sort((a, b) => (Number(b.score >= HEALTHY) - Number(a.score >= HEALTHY))
    || (Number(b.c.file === platoonFile) - Number(a.c.file === platoonFile))
    || (b.score - a.score));
  const donor = candidates[0].c;

  // --- affiliation --------------------------------------------------------
  const world = readSaveFile(saveDir, 'quick.save');
  const meta = squadMetaFor(world, platoonFile);
  let ownerFactionSid = meta ? asText(meta.strings.get('faction stringID') || '') : '';
  if (!ownerFactionSid) {
    // Fall back to what an existing member of this same squad carries.
    const bySid = new Map(parsed.records.map((r) => [r.sid, r]));
    for (const inst of squad.instances) {
      const st = inst.states.map((s) => bySid.get(s)).find((r) => r && r.type === T.CHAR_STATE);
      const owner = st ? asText(st.strings.get('owner faction ID') || '') : '';
      if (owner) { ownerFactionSid = owner; break; }
    }
  }

  // --- build the six state records ---------------------------------------
  const { records: newStates, meta: buildMeta } = characterFactory.buildStateRecords(donor.states, {
    name: charName,
    ownerFactionSid: ownerFactionSid || undefined,
    applyStats: (statsRec) => applyStatSpread(statsRec, {
      archetypeSkills,
      attribute: spread.attribute,
      archRange: spread.archRange,
      otherRange: spread.otherRange,
      mode: 'set',
      rng,
    }),
  });

  // --- mint identities ----------------------------------------------------
  for (const rec of newStates) ids.addRecord(parsed, rec);
  const handleSid = ids.mintSid(ids.nextRecordId(parsed));

  // Spawn on top of an existing member so the new character lands wherever the
  // squad currently is, rather than at the squad's last recorded map position
  // (which can be stale) or at the world origin.
  const anchor = squad.instances[0] || null;
  const pos = anchor ? [...anchor.pos] : [...((meta && meta.vec3.get('position')) || [0, 0, 0])];
  const rot = anchor ? [...anchor.rot] : [1, 0, 0, 0];

  ids.addInstance(squad, donor.instance.target, {
    id: handleSid,
    pos,
    rot,
    states: newStates.map((r) => r.sid),
  });

  // Incremented, not recomputed from `instances.length`: if the file's own two
  // numbers already disagree, that disagreement is the game's, and "correcting"
  // it would be this editor inventing a value (the same reasoning
  // ids.addInstance() applies to `instanceCount`).
  const squadCountBefore = squad.ints.get('char count');
  if (squad.ints.has('char count')) squad.ints.set('char count', squadCountBefore + 1);

  // --- quick.save side ----------------------------------------------------
  const gs = gameStateOf(world);
  const metaCountBefore = meta ? meta.ints.get('char count') : null;
  if (meta && meta.ints.has('char count')) meta.ints.set('char count', metaCountBefore + 1);
  const membersBefore = gs.ints.get('members');
  if (gs.ints.has('members')) gs.ints.set('members', membersBefore + 1);

  const receipt = {
    character: {
      sid: handleSid,
      name: charName,
      nameBytes: encoded.length,
      raceSid,
      raceName: gamedata.nameOf(raceSid, raceSid),
      origin: gamedata.nameOf(donor.instance.target, donor.instance.target),
      archetype: main.label,
      sub: subEntry.label,
      tier,
      position: pos,
      stateSids: newStates.map((r) => r.sid),
    },
    donor: {
      file: donor.file,
      sid: donor.instance.id,
      name: donor.state ? asText(donor.state.strings.get('name') || '') : '',
      inheritedBlood: buildMeta.medical ? buildMeta.medical.blood : null,
    },
    counts: {
      squadCharCount: { before: squadCountBefore ?? null, after: squad.ints.get('char count') ?? null },
      squadMetaCharCount: { before: metaCountBefore, after: meta ? meta.ints.get('char count') ?? null : null },
      worldMembers: { before: membersBefore ?? null, after: gs.ints.get('members') ?? null },
    },
    clearedBountyKeys: buildMeta.clearedBountyKeys || [],
  };

  // Two files, one staged edit — mutationService verifies and installs both or
  // neither, which is the whole reason it accepts an array.
  return [
    { file: relFile, bytes: writeFile(parsed), ...receipt },
    { file: 'quick.save', bytes: writeFile(world) },
  ];
}

// ------------------------------------------------------------- teleport --

// Characters are placed on a ring rather than all on one point. The game will
// push overlapping bodies apart on load anyway, but a squad that arrives as a
// neat circle reads as intentional, and it keeps anyone from being buried
// inside a building's collision at the exact town centre. 30 units is small
// against a town: a type-13 town's own `size radius` starts at 350, and the
// player's squad currently sits 520 units from its town's centre.
const TELEPORT_RING = 30;

/**
 * Move characters to a world position — the squad (30) record's instance `pos`,
 * NOT a field inside any state record (TODO.md 1.4).
 *
 * Writes two files, like addSquadMember(): the platoon, and `quick.save` so the
 * squad's own SQUAD_META (34) map position follows its members. Leaving the
 * type-34 position behind would put the squad's map marker in one place and its
 * characters in another.
 *
 * `y` is the terrain height recorded with the town placement
 * (services/locationsService.js). It is not re-derived from the heightmap —
 * this editor does not read terrain — so on a slope the game settles the
 * characters itself. Off-map or underground coordinates can strand a squad;
 * the caller is trusted, and the UI only offers catalogued towns.
 *
 * @param {string} saveDir
 * @param {string} platoonFile
 * @param {object} opts
 * @param {number} opts.x
 * @param {number} opts.y
 * @param {number} opts.z
 * @param {string[]} [opts.sids]  which characters; default every one in the squad
 * @param {string} [opts.label]   destination name, for the receipt only
 */
function teleportSquad(saveDir, platoonFile, { x, y, z, sids, label = null } = {}) {
  for (const [key, value] of Object.entries({ x, y, z })) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`teleport: "${key}" must be a finite number`);
    }
  }

  const { relFile, parsed, squad } = resolveSquad(saveDir, platoonFile);
  if (!squad.instances.length) throw new Error(`${platoonFile}: this squad has no characters`);

  let targets = squad.instances;
  if (sids !== undefined) {
    if (!Array.isArray(sids) || !sids.length) throw new Error('teleport: sids, if given, must be a non-empty array');
    const wanted = new Set(sids);
    targets = squad.instances.filter((i) => wanted.has(i.id));
    const missing = sids.filter((s) => !squad.instances.some((i) => i.id === s));
    if (missing.length) throw new Error(`${platoonFile}: no character with sid ${missing.join(', ')}`);
  }

  const bySid = new Map(parsed.records.map((r) => [r.sid, r]));
  const nameOfInstance = (inst) => {
    const st = inst.states.map((s) => bySid.get(s)).find((r) => r && r.type === T.CHAR_STATE);
    return asText(st ? (st.strings.get('name') || '') : '');
  };

  const moved = targets.map((inst, i) => {
    const angle = (2 * Math.PI * i) / targets.length;
    const to = [
      x + Math.cos(angle) * TELEPORT_RING,
      y,
      z + Math.sin(angle) * TELEPORT_RING,
    ];
    const from = [...inst.pos];
    inst.pos = to;
    return { sid: inst.id, name: nameOfInstance(inst), from, to };
  });

  // The squad's own marker in quick.save follows its members.
  const world = readSaveFile(saveDir, 'quick.save');
  const meta = squadMetaFor(world, platoonFile);
  let metaBefore = null;
  if (meta && meta.vec3.has('position')) {
    metaBefore = [...meta.vec3.get('position')];
    meta.vec3.set('position', [x, y, z]);
  }

  const results = [{
    file: relFile,
    bytes: writeFile(parsed),
    destination: { label, x, y, z },
    moved,
    movedCount: moved.length,
    squadMarker: { before: metaBefore, after: metaBefore ? [x, y, z] : null },
  }];
  // Only write quick.save if it actually changed — mutationService rejects a
  // no-op edit, and a squad whose type-34 record has no position (or is already
  // there) should not drag an unchanged file into `changedFiles`.
  if (metaBefore && (metaBefore[0] !== x || metaBefore[1] !== y || metaBefore[2] !== z)) {
    results.push({ file: 'quick.save', bytes: writeFile(world) });
  }
  return results;
}

// ----------------------------------------------------------- bulk equip --

// Every field an `items[]` entry may carry. Rejected rather than ignored, same
// reasoning as ADD_ITEM_OPTIONS: a misnamed grade field would quietly mint a
// "Totally rusted junk" weapon across a whole squad and still report success.
const EQUIP_ITEM_FIELDS = new Set(['templateSid', 'section', 'quantity', 'level', 'gradeId', 'materialSid', 'companySid']);

/**
 * Give every character in `targets` every item in `items`, in ONE staged edit.
 *
 * This is the bulk sibling of addItem(), and the reason it exists rather than
 * "just call addItem N times": mutationService.mutate() treats each call as one
 * staged edit against one pre-edit snapshot and takes one backup, so equipping
 * 8 characters with 6 items each through the single-item route means 48 gate
 * passes, 48 backups, and 47 intermediate on-disk states nobody asked for. One
 * call means one backup and all-or-nothing installation.
 *
 * `targets` may span platoon files; each file is parsed once, mutated once, and
 * returned as its own `{ file, bytes }`. mutate() already accepts an array and
 * verifies every entry before installing any of them.
 *
 * COMPATIBILITY POLICY — deliberate, and not the same for both kinds:
 *   - KIND vs SLOT (a shirt into `hip`) is a hard refusal, validated up front
 *     via itemSlots.allowedSections(), the same single source of truth
 *     addItem()/updateItem() use.
 *   - RACE fit (plate boots on a hiver) NEVER blocks. Every selected character
 *     gets every item; services/fitCheck.js produces advisory warnings that ride
 *     along in the receipt. Kenshi's real race restrictions are not in any field
 *     this editor has identified (TODO.md 1.5), so refusing on suspicion would
 *     be inventing a rule.
 *
 * @param {string} saveDir
 * @param {object} opts
 * @param {{file: string, sid: string}[]} opts.targets
 * @param {object[]} opts.items      see EQUIP_ITEM_FIELDS
 * @param {Array<{races: string[], note: string}>} [opts.raceNotes]  advisory only
 * @param {boolean} [opts.skipIfSlotFilled=false]  don't give a character a
 *   second item in a single-occupancy slot they already occupy (this is what
 *   the backpack script did); off by default so the default behaviour matches
 *   the Gear page's existing "moving into an occupied slot displaces the
 *   current occupant to main" rule.
 */
function equipMany(saveDir, { targets, items, raceNotes = [], skipIfSlotFilled = false } = {}) {
  if (!Array.isArray(targets) || !targets.length) throw new Error('equipMany: targets must be a non-empty array');
  if (!Array.isArray(items) || !items.length) throw new Error('equipMany: items must be a non-empty array');

  // ---- validate every item ONCE, before touching any file (AGENTS.md §4) ----
  const checked = items.map((raw, i) => {
    if (!raw || typeof raw !== 'object') throw new Error(`equipMany: items[${i}] must be an object`);
    const unknown = Object.keys(raw).filter((k) => !EQUIP_ITEM_FIELDS.has(k));
    if (unknown.length) {
      throw new Error(`equipMany: items[${i}] has unknown field(s) ${unknown.join(', ')} — supported: ${[...EQUIP_ITEM_FIELDS].join(', ')}`);
    }
    const { templateSid, section, quantity = 1 } = raw;
    if (typeof templateSid !== 'string' || !templateSid) throw new Error(`equipMany: items[${i}].templateSid is required`);
    if (typeof section !== 'string' || !section) throw new Error(`equipMany: items[${i}].section is required`);
    if (!Number.isInteger(quantity) || quantity < 1) throw new Error(`equipMany: items[${i}].quantity must be a positive integer`);

    const tmpl = gamedata.lookup(templateSid);
    if (!tmpl) throw new Error(`unresolvable item template sid "${templateSid}"`);
    if (!itemFactory.TEMPLATE_TYPES.includes(tmpl.type)) {
      throw new Error(`template "${templateSid}" (${tmpl.name}) is typecode ${tmpl.type}, not an item template (${itemFactory.TEMPLATE_TYPES.join('/')})`);
    }
    if (quantity > 1 && !tmpl.stackable) {
      throw new Error(`"${tmpl.name}" is not stackable — quantity must be 1`);
    }
    const { sections: allowed } = itemSlots.allowedSections(templateSid, null);
    if (!allowed.includes(section)) {
      throw new Error(`"${tmpl.name}" cannot be added into slot "${section}" — allowed slots: ${allowed.join(', ')}`);
    }
    return { ...raw, quantity, name: tmpl.name, type: tmpl.type };
  });

  // ---- group targets by platoon file so each file is parsed exactly once ----
  const byFile = new Map();
  for (const t of targets) {
    if (!t || typeof t.file !== 'string' || typeof t.sid !== 'string') {
      throw new Error('equipMany: every target needs a "file" and a "sid"');
    }
    if (!byFile.has(t.file)) byFile.set(t.file, []);
    if (!byFile.get(t.file).some((s) => s === t.sid)) byFile.get(t.file).push(t.sid);
  }

  const results = [];
  const characters = [];
  let addedCount = 0;

  for (const [platoonFile, sids] of byFile) {
    const { relFile, parsed, squad } = resolveSquad(saveDir, platoonFile);
    const bySid = new Map(parsed.records.map((r) => [r.sid, r]));

    for (const sid of sids) {
      const inst = squad.instances.find((i) => i.id === sid);
      if (!inst) throw new Error(`${platoonFile}: no character with sid "${sid}"`);
      const states = inst.states.map((s) => bySid.get(s)).filter(Boolean);
      const pick = (type) => states.find((r) => r.type === type) || null;
      const bag = pick(T.INVENTORY);
      if (!bag) throw new Error(`${platoonFile}: character "${sid}" has no INVENTORY record (type 41)`);

      const stateRec = pick(T.CHAR_STATE);
      const race = raceOf(pick(T.APPEARANCE));
      const partSids = fitCheck.bodyPartSids(pick(T.MEDICAL), BODY_SLOTS);

      const entry = {
        file: platoonFile,
        sid,
        name: asText(stateRec ? (stateRec.strings.get('name') || '') : ''),
        race: race ? race.name : null,
        added: [],
        skipped: [],
        displaced: [],
        warnings: [],
      };

      for (const item of checked) {
        // `skipIfSlotFilled` only makes sense for a single-occupancy slot —
        // `main` and `backpack_content` are buckets that legitimately hold many
        // items, so "already filled" is never true for them.
        if (skipIfSlotFilled && !ITEM_BUCKET_SLOTS.has(item.section)) {
          const occupied = bag.instances.some((ii) => {
            const other = bySid.get(ii.target);
            return other && other.type === T.ITEM
              && asText(other.strings.get('section') || '') === item.section;
          });
          if (occupied) {
            entry.skipped.push({ name: item.name, section: item.section, reason: 'slot already filled' });
            continue;
          }
        }

        const { record, meta } = itemFactory.buildItemRecord(item.templateSid, {
          section: item.section,
          level: item.level,
          quantity: item.quantity,
          gradeId: item.gradeId,
          materialSid: item.materialSid,
          companySid: item.companySid,
        });

        // The SAME displacement helper setItemSection()/addItem() use — this
        // rule must never grow a second copy. excludeSid is null: the new
        // record has no sid until addRecord() stamps one.
        const displaced = displaceIntoSlot(bag, bySid, null, item.section);
        if (displaced) {
          entry.displaced.push({
            sid: displaced.sid,
            name: gamedata.nameOf(displaced.strings.get('base data sid'), 'item'),
            section: 'main',
          });
        }

        ids.addRecord(parsed, record);
        ids.addInstance(bag, record.sid);
        bySid.set(record.sid, record);
        addedCount += 1;

        entry.added.push({
          sid: record.sid,
          name: meta.templateName,
          section: item.section,
          level: record.ints.get('level'),
          grade: meta.grade ? { id: meta.grade.id, modelName: meta.grade.modelName, companyName: meta.grade.companyName } : null,
        });

        entry.warnings.push(...fitCheck.warningsFor({
          templateSid: item.templateSid,
          itemName: item.name,
          section: item.section,
          partSids,
          // The race's stringID, not just its name: the game's own restriction
          // rows name races by sid, and two races in this install share a name.
          raceSid: race ? race.sid : null,
          raceName: entry.race,
          raceNotes,
        }));
      }

      // A loadout's race note is about the character, not about each item, so
      // it would otherwise repeat once per item — six identical "animal" lines
      // for a bonedog. Dedupe by text; the derived per-item warnings already
      // name their item and so stay distinct.
      const seen = new Set();
      entry.warnings = entry.warnings.filter((w) => !seen.has(w.text) && seen.add(w.text));

      characters.push(entry);
    }

    results.push({ file: relFile, bytes: writeFile(parsed) });
  }

  // The receipt rides on the first file's result; mutate() surfaces every
  // result's non-`bytes` fields under `receipts`.
  results[0] = {
    ...results[0],
    characters,
    itemsAdded: addedCount,
    charactersTouched: characters.length,
    filesTouched: results.length,
    warnings: characters.flatMap((c) => c.warnings.map((w) => ({ character: c.name, ...w }))),
  };

  return results;
}

// ------------------------------------------------- bulk edits to gear owned --

/**
 * The sections that mean "worn", i.e. everything that is not one of the two
 * storage buckets. Derived from ITEM_SLOTS/ITEM_BUCKET_SLOTS rather than
 * restated, so a new slot can never be added to one list and forgotten in the
 * other.
 */
const EQUIP_SECTIONS = ITEM_SLOTS.filter((s) => !ITEM_BUCKET_SLOTS.has(s));

/**
 * Walk every target character once, grouped by platoon file so each file is
 * parsed and serialised exactly once.
 *
 * This is the shared skeleton of the two bulk edits below, and the reason both
 * are ONE staged edit: `mutationService.mutate()` treats each call as one edit
 * against one snapshot and takes one backup, so "set 12 characters' armour to
 * masterwork" through the per-item route would be a backup per item.
 * `equipMany()` predates this helper and keeps its own copy of the loop because
 * it also needs the SQUAD instance's other state records (race, body plan) for
 * fit checking; nothing here needs those.
 *
 * @param {function} perCharacter  called with `{ file, sid, name, bag, bySid }`,
 *   mutates records in place and returns the receipt entry for that character.
 */
function bulkOverTargets(saveDir, targets, perCharacter) {
  if (!Array.isArray(targets) || !targets.length) throw new Error('targets must be a non-empty array');

  const byFile = new Map();
  for (const t of targets) {
    if (!t || typeof t.file !== 'string' || typeof t.sid !== 'string') {
      throw new Error('every target needs a "file" and a "sid"');
    }
    if (!byFile.has(t.file)) byFile.set(t.file, []);
    if (!byFile.get(t.file).includes(t.sid)) byFile.get(t.file).push(t.sid);
  }

  const results = [];
  const characters = [];
  for (const [platoonFile, sids] of byFile) {
    const { relFile, parsed, squad } = resolveSquad(saveDir, platoonFile);
    const bySid = new Map(parsed.records.map((r) => [r.sid, r]));

    for (const sid of sids) {
      const inst = squad.instances.find((i) => i.id === sid);
      if (!inst) throw new Error(`${platoonFile}: no character with sid "${sid}"`);
      const states = inst.states.map((s) => bySid.get(s)).filter(Boolean);
      const bag = states.find((r) => r.type === T.INVENTORY);
      if (!bag) throw new Error(`${platoonFile}: character "${sid}" has no INVENTORY record (type 41)`);
      const stateRec = states.find((r) => r.type === T.CHAR_STATE);
      characters.push(perCharacter({
        file: platoonFile,
        sid,
        name: asText(stateRec ? (stateRec.strings.get('name') || '') : ''),
        bag,
        bySid,
      }));
    }

    results.push({ file: relFile, bytes: writeFile(parsed) });
  }

  return { results, characters };
}

/**
 * Every type-42 ITEM record a character actually holds.
 *
 * `includePackContents` follows the one extra hop a worn backpack adds — a pack
 * keeps its contents in its OWN inventory record, not the character's (see
 * packContentsOf()). One level only, same depth guard and same reason.
 */
function inventoryItemsOf(bag, bySid, { includePackContents = false } = {}) {
  const out = [];
  for (const inst of bag.instances) {
    const rec = bySid.get(inst.target);
    if (!rec || rec.type !== T.ITEM) continue;
    out.push(rec);
    if (!includePackContents) continue;
    for (const pi of rec.instances) {
      const container = bySid.get(pi.target);
      if (!container || container.type !== T.INVENTORY) continue;
      for (const ci of container.instances) {
        const inner = bySid.get(ci.target);
        if (inner && inner.type === T.ITEM) out.push(inner);
      }
    }
  }
  return out;
}

const REGRADE_FIELDS = new Set([
  'targets', 'armourLevel', 'weaponGradeId', 'weaponLevel', 'includeCarried', 'includePackContents',
]);

// Which template typecodes each of the two quality controls applies to.
// Armour's quality IS `ints.level` on the named tier ladder (5/20/40/60/80/95 =
// Prototype..Masterwork — see itemOf()'s comment). A weapon's recognisable
// grade is the (company sid, material sid) PAIR and `level` is a separate
// field, so the two are set independently and never inferred from each other.
// Type 107 (crossbow) has a `level` that varies exactly like a melee weapon's
// but no manufacturer ladder at all, so it follows `weaponLevel` and is left
// out of the grade pass — `itemFactory.resolveGrade` would refuse it anyway.
const ARMOUR_LEVEL_TYPES = new Set([3]);
const WEAPON_LEVEL_TYPES = new Set([2, 107]);
const WEAPON_GRADE_TYPES = new Set([2]);

/**
 * Re-grade the gear a set of characters ALREADY OWN, in one staged edit:
 * "select these eight, set every piece of armour to Masterwork and every weapon
 * to Edge Type 5".
 *
 * This is the bulk sibling of `updateItem()`, and the counterpart to
 * `equipMany()`: equipMany mints new items, this one edits what is already
 * there. Nothing is added, removed or moved — only `ints.level` and the
 * `material sid`/`company sid` grade pair are touched, and only on records that
 * already carry those keys (the same "never mint a key" discipline setStats()
 * follows).
 *
 * SCOPE. By default only WORN items are touched, because "set all my armour to
 * masterwork" means the armour they are wearing, not the three spare shirts in
 * the pack. `includeCarried` widens it to the character's `main`/
 * `backpack_content` items and `includePackContents` follows the extra hop into
 * a worn backpack's own record.
 *
 * An item whose template cannot be resolved is left alone rather than guessed
 * at — the same rule itemSlots.js follows in reverse: it never LOCKS an
 * unknown kind, and this never EDITS one.
 *
 * @param {string} saveDir
 * @param {object} opts
 * @param {{file: string, sid: string}[]} opts.targets
 * @param {number} [opts.armourLevel]     tier for type-3 items, e.g. 95 (Masterwork)
 * @param {string} [opts.weaponGradeId]   "<companySid>|<modelSid>" from gamedataService.weaponGrades()
 * @param {number} [opts.weaponLevel]     `ints.level` for type-2/107 items (separate from the grade)
 * @param {boolean} [opts.includeCarried=false]
 * @param {boolean} [opts.includePackContents=false]
 */
function regradeMany(saveDir, opts = {}) {
  const unknown = Object.keys(opts).filter((k) => !REGRADE_FIELDS.has(k));
  if (unknown.length) {
    throw new Error(`regradeMany: unknown field(s) ${unknown.join(', ')} — supported: ${[...REGRADE_FIELDS].join(', ')}`);
  }
  const {
    targets, armourLevel, weaponGradeId, weaponLevel,
    includeCarried = false, includePackContents = false,
  } = opts;

  if (armourLevel === undefined && weaponGradeId === undefined && weaponLevel === undefined) {
    throw new Error('regradeMany: provide at least one of armourLevel, weaponGradeId, weaponLevel');
  }

  // ---- validate everything before touching a file (AGENTS.md §4) ----
  const asLevel = (value, label) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0) throw new Error(`${label} must be a non-negative integer`);
    return n;
  };
  const armour = armourLevel === undefined ? null : asLevel(armourLevel, 'armourLevel');
  const wLevel = weaponLevel === undefined ? null : asLevel(weaponLevel, 'weaponLevel');

  let grade = null;
  if (weaponGradeId !== undefined) {
    if (typeof weaponGradeId !== 'string' || !weaponGradeId) {
      throw new Error('weaponGradeId must be a non-empty string');
    }
    // Throws on an unknown id rather than defaulting to the lowest rung — a
    // typo must not silently hand a whole squad "Totally rusted junk".
    grade = itemFactory.resolveGrade({ gradeId: weaponGradeId });
  }

  let changedCount = 0;

  const { results, characters } = bulkOverTargets(saveDir, targets, ({ file, sid, name, bag, bySid }) => {
    const entry = { file, sid, name, changed: [], skipped: 0 };

    for (const rec of inventoryItemsOf(bag, bySid, { includePackContents })) {
      const section = asText(rec.strings.get('section') || '');
      if (!includeCarried && ITEM_BUCKET_SLOTS.has(section)) continue;

      const baseSid = rec.strings.get('base data sid');
      const tmpl = gamedata.lookup(baseSid);
      if (!tmpl) { entry.skipped += 1; continue; }

      const before = {
        level: rec.ints.get('level') ?? null,
        materialSid: asText(rec.strings.get('material sid') || ''),
        companySid: asText(rec.strings.get('company sid') || ''),
      };
      let touched = false;

      const wantLevel = (armour !== null && ARMOUR_LEVEL_TYPES.has(tmpl.type)) ? armour
        : (wLevel !== null && WEAPON_LEVEL_TYPES.has(tmpl.type)) ? wLevel
          : null;
      if (wantLevel !== null && rec.ints.has('level') && rec.ints.get('level') !== wantLevel) {
        rec.ints.set('level', wantLevel);
        touched = true;
      }

      if (grade && WEAPON_GRADE_TYPES.has(tmpl.type)
        && (before.materialSid !== grade.modelSid || before.companySid !== grade.companySid)) {
        // Written together, never one without the other — the PAIR is the grade.
        rec.strings.set('material sid', grade.modelSid);
        rec.strings.set('company sid', grade.companySid);
        touched = true;
      }

      if (!touched) continue;
      changedCount += 1;
      entry.changed.push({
        sid: rec.sid,
        name: gamedata.nameOf(baseSid, asText(baseSid || rec.sid)),
        kindType: tmpl.type,
        section,
        before,
        after: {
          level: rec.ints.get('level') ?? null,
          materialSid: asText(rec.strings.get('material sid') || ''),
          companySid: asText(rec.strings.get('company sid') || ''),
        },
      });
    }

    return entry;
  });

  results[0] = {
    ...results[0],
    characters,
    itemsChanged: changedCount,
    charactersTouched: characters.length,
    filesTouched: results.length,
    armourLevel: armour,
    weaponLevel: wLevel,
    grade: grade ? {
      id: grade.id, modelName: grade.modelName, companyName: grade.companyName, rank: grade.rank,
    } : null,
    scope: { includeCarried: !!includeCarried, includePackContents: !!includePackContents },
  };

  return results;
}

const UNEQUIP_FIELDS = new Set(['targets', 'sections', 'templateSids', 'itemSids']);

/**
 * Unequip: move worn items back to `main` (Carried), for one character or for
 * a whole selection, in ONE staged edit.
 *
 * Three filters, all optional and ANDed together, which between them cover the
 * three things a player actually asks for:
 *   - nothing given         -> "strip them", every worn item
 *   - `sections`            -> "take everyone's helmet off"  (one slot, many characters)
 *   - `templateSids`        -> "take that specific item off whoever is wearing one"
 *   - `itemSids`            -> one exact item record (the per-row Unequip button's case,
 *                              though a single row can equally use updateItem())
 *
 * The destination is always `main` and is deliberately not configurable.
 * `backpack_content` is the other bucket, but a `backpack_content` item lives in
 * the PACK's own inventory record — writing that section onto an item sitting in
 * the character's own record would describe a location the save does not have.
 *
 * Only the character's OWN inventory is walked: something already inside a pack
 * is not equipped, so there is nothing there to take off.
 */
function unequipMany(saveDir, opts = {}) {
  const unknown = Object.keys(opts).filter((k) => !UNEQUIP_FIELDS.has(k));
  if (unknown.length) {
    throw new Error(`unequipMany: unknown field(s) ${unknown.join(', ')} — supported: ${[...UNEQUIP_FIELDS].join(', ')}`);
  }
  const { targets, sections, templateSids, itemSids } = opts;

  const asStringSet = (value, label) => {
    if (value === undefined) return null;
    if (!Array.isArray(value) || !value.length) throw new Error(`${label}, if given, must be a non-empty array`);
    if (value.some((s) => typeof s !== 'string' || !s)) {
      throw new Error(`every entry in ${label} must be a non-empty string`);
    }
    return new Set(value);
  };

  let wanted = new Set(EQUIP_SECTIONS);
  if (sections !== undefined) {
    const given = asStringSet(sections, 'sections');
    for (const s of given) {
      if (!EQUIP_SECTIONS.includes(s)) {
        throw new Error(`"${s}" is not an equip slot — one of: ${EQUIP_SECTIONS.join(', ')}`);
      }
    }
    wanted = given;
  }
  const wantedTemplates = asStringSet(templateSids, 'templateSids');
  const wantedItems = asStringSet(itemSids, 'itemSids');

  let movedCount = 0;

  const { results, characters } = bulkOverTargets(saveDir, targets, ({ file, sid, name, bag, bySid }) => {
    const entry = { file, sid, name, moved: [] };

    for (const rec of inventoryItemsOf(bag, bySid)) {
      const section = asText(rec.strings.get('section') || '');
      if (!wanted.has(section)) continue;
      const baseSid = asText(rec.strings.get('base data sid') || '');
      if (wantedTemplates && !wantedTemplates.has(baseSid)) continue;
      if (wantedItems && !wantedItems.has(rec.sid)) continue;

      rec.strings.set('section', 'main');
      movedCount += 1;
      entry.moved.push({
        sid: rec.sid,
        name: gamedata.nameOf(baseSid, baseSid || rec.sid),
        from: section,
        to: 'main',
      });
    }

    return entry;
  });

  results[0] = {
    ...results[0],
    characters,
    itemsMoved: movedCount,
    charactersTouched: characters.length,
    filesTouched: results.length,
    sections: [...wanted],
  };

  return results;
}

module.exports = {
  T, BODY_SLOTS, ITEM_SLOTS, ITEM_BUCKET_SLOTS, EQUIP_SECTIONS, status, worldSummary, readPlatoon, setPlayerMoney, gameStateOf,
  raceOf, equipMany, regradeMany, unequipMany, teleportSquad,
  playerPlatoonFiles, playerSquadRecords, scanCharacters, availableRaces, defaultRace,
  resolveSquad, squadMetaFor, encodeName, MAX_NAME_BYTES,
  renameCharacter, renamePlayerFaction, addSquadMember, applyStatSpread, setPersonality, dialogueOf,
  setRace, previewRaceChange, mapBodyPlan,
  resolveCharacter, setStats, setStat, trainCharacter,
  healPart, damagePart, setHunger, revive, restoreLimbs,
  setItemSection, setItemQuality, updateItem, addItem,
};
