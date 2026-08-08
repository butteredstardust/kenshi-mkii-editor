'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { readFile } = require('./kenshi/codec');
const { asText } = require('./kenshi/binary');
const paths = require('./pathService');

/**
 * Resolves stringIDs to human names.
 *
 * A save stores references as `"<id>-<originating file>"` — e.g.
 * `476-gamedata.base` or `98840-Azuchi.mod`. The originating file name is baked
 * in permanently and is NOT necessarily a file that still exists: vanilla data
 * was consolidated over the years, so `changes_otto.mod` and `Escapes.mod`
 * stringIDs live inside gamedata.base today. Resolution is therefore a lookup
 * across every data file, never a filename-to-path mapping.
 *
 * First definition wins. Load order would decide overrides in-game; for
 * display purposes the base definition is the stable answer.
 */

const CACHE_FILE = path.join(__dirname, '..', '.cache', 'nameindex.json');
const BASE_FILES = ['gamedata.base', 'Newwworld.mod', 'Dialogue.mod', 'rebirth.mod'];

// Bump when the cached index's per-entry shape changes, so a stale on-disk
// cache from before the change is rebuilt instead of silently serving
// entries missing the new field (see `slot` below, added for itemSlots.js;
// `stackable` added for the item picker, TODO.md 2.3; `itemFunction` and the
// two new top-level `materialIndex`/`weaponGrades` collections added for
// itemFactory.js, TODO.md 2.2(b)/(h)/(i)).
//
// 9: the weapon-grade ladder resolves its names AND its ranks in the game's
// own load order (last definition wins) instead of first-definition-wins. Both
// were wrong against the player's screen: "Edge Type 5" is "Edge Type 3" once
// the installed mods are applied, and all 11 re-defined grade pairs carry a
// different rank — the number this app writes into a weapon's `ints.level`.
//
// 8: `raceRuleIndex` — the `races` / `races exclude` rows that ARE Kenshi's
// racial armour restrictions (see raceRules() below).
//
// 7: typecode 102 (maps) is an item template, and `stackable` is now read
// wherever the field exists rather than only on type 4.
//
// 6: `dialoguePackages`/`playerDialoguePackages` on type-1 character templates
// (the character card's read-only dialogue status).
//
// 5: `partCoverage` per entry (bulk equip's fit warnings) and a stable `id` on
// every weapon-grade row.
const CACHE_VERSION = 9;

// Item-template typecodes (TODO.md 2.2(g)/2.3): 2 = weapon, 3 = armour,
// 4 = trade goods/consumable, 46 = backpack, 107 = crossbow. Type 42 is the
// save-side ITEM *instance* record, not a template, and must never appear here.
//
// 46 was added when bulk equip landed: 22 backpack templates exist in this
// install's data and the picker used to hide every one of them, which is why
// the equip scripts had to hand-roll a backpack record. All 42 live
// type-46-backed items confirm the minted shape (see itemFactory.js).
//
// 111 is the robotic limb — the class this list was missing when a user went
// looking for a "KLR Series Arm (left)" and found nothing. A full sweep of all
// 123 files in a live save (6103 ITEM records) settled the question: exactly
// six typecodes ever back an item, and these are they.
//
// 107 is the crossbow — a whole weapon class that was unreachable until the
// loadout work went looking for a ranged archetype and found "Ranger" sitting
// at a typecode nothing accepted.
// 102 is the map ("Map to Mongrel", "Ancient Military Documents"), added after
// a user asked why a vendor could sell something the editor could not add. It
// never appears in a save this player owns, but 39 live map items exist in the
// install's own `interiors.level` files, which is what its minted shape is
// copied from.
const ITEM_TEMPLATE_TYPES = new Set([2, 3, 4, 46, 107, 111, 102]);

let index = null;
let stats = null;
// sid -> string[] (union of extra['material'] targets across EVERY definition
// of that sid, not first-definition-wins — see build()'s comment and TODO.md
// 2.2(h)).
let materialIndex = null;
// Ordered, de-duplicated weapon grade ladder (TODO.md 2.2(i)) — see build().
let weaponGradeList = null;
let limbList = null;
// sid -> { only: string[], exclude: string[] } — Kenshi's own racial armour
// restrictions, unioned across every definition. See raceRules().
let raceRuleIndex = null;

function dataFiles() {
  const out = [];
  const data = paths.gameDataDir();
  if (data) {
    for (const f of BASE_FILES) {
      const p = path.join(data, f);
      if (fs.existsSync(p)) out.push(p);
    }
    for (const f of fs.readdirSync(data)) {
      if (f.endsWith('.mod') && !BASE_FILES.includes(f)) out.push(path.join(data, f));
    }
  }
  const ws = paths.workshopDir();
  if (ws) {
    for (const id of fs.readdirSync(ws)) {
      const dir = path.join(ws, id);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.mod')) out.push(path.join(dir, f));
      }
    }
  }
  const install = paths.installDir();
  if (install && fs.existsSync(path.join(install, 'mods'))) {
    const root = path.join(install, 'mods');
    for (const d of fs.readdirSync(root)) {
      const dir = path.join(root, d);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.mod')) out.push(path.join(dir, f));
      }
    }
  }
  return out;
}

function build() {
  const map = new Map();
  // Union of extra['material'] targets across EVERY definition of a sid, not
  // just the first (TODO.md 2.2(h)): mods routinely re-define a vanilla
  // template purely to attach material rows, so a first-definition-wins index
  // (which is otherwise correct, and kept, for display names) would miss the
  // material candidate entirely. Collected in the same pass as `map` so the
  // whole index only ever needs one read of every data file.
  const materials = new Map(); // sid -> Set<string>
  // Racial armour restrictions. `extra['races']` is a WHITELIST (only these
  // races may wear it — the Hiver shirts) and `extra['races exclude']` is a
  // BLACKLIST (the helmet lists). Unioned across every definition for the same
  // reason as the material index: a mod that re-defines a vanilla helmet to add
  // one exclusion must not blank the exclusions the base file already stated.
  // See raceRules() for what these are and how far they can be trusted.
  const raceOnly = new Map(); // sid -> Set<raceSid>
  const raceExclude = new Map(); // sid -> Set<raceSid>
  // Weapon grade ladder rows (TODO.md 2.2(i)): every type-51 (company) record's
  // extra['weapon models'] category, one row per type-50 (grade) sid it offers,
  // with v0 as that grade's rank. Resolved to names after the full sweep, since
  // a type-50 record's own name may be defined in a file visited later than its
  // company's.
  const gradeRows = []; // { companySid, companyName, modelSid, rank, file }
  // Per-file names for the record types whose DISPLAY name the player sees
  // resolved in load order rather than first-definition-wins. Collected here,
  // in the one pass, and resolved against `data/mods.cfg` after it — see
  // `resolveInLoadOrder()` below for why this is not optional for grades.
  const gradeNames = new Map(); // sid -> Map<fileBasename, name>
  // Robotic limbs (type 111), for the Limbs page's "fit a prosthetic" picker.
  // Their `ints.slot` is 50/51/52/53 = left arm / right arm / left leg / right
  // leg, which lines up exactly with MEDICAL part slots 3/4/5/6 — and it is
  // collected per file for the same reason the grades are: 24 of this
  // install's 32 limb templates are defined more than once, and the FIRST
  // definition of several (Newwworld.mod's KLR Series, Economy and Stealth
  // limbs) carries no `slot` at all while a later one does. First-definition-
  // wins therefore reported "no slot" for a limb whose side the game knows.
  const limbDefs = new Map(); // sid -> Map<fileBasename, { name, slot, hp, hpMax, value }>
  const skipped = [];
  let files = 0;
  for (const file of dataFiles()) {
    let parsed;
    try {
      parsed = readFile(fs.readFileSync(file));
    } catch (err) {
      // Texture/mesh-only mods carry zero records and have no usable header;
      // they contribute no names, so skipping them is correct, not a failure.
      skipped.push({ file: path.basename(file), reason: err.message });
      continue;
    }
    files++;
    for (const rec of parsed.records) {
      if (!rec.sid) continue;

      if (!map.has(rec.sid)) {
        // `slot` is the gamedata TEMPLATE's own `ints.slot` field (present on
        // type 2/weapon and type 3/armour records; see services/itemSlots.js
        // for what it means and TODO.md 2.1 for the investigation). Cached
        // alongside name/type so item-compatibility checks never need to
        // re-open a data file at request time. `null` when the record has no
        // such field at all (common on mod-defined items — see itemSlots.js).
        const slot = rec.ints.has('slot') ? rec.ints.get('slot') : null;
        // `stackable` only exists on type-4 (trade goods) templates (TODO.md
        // 2.2(d)); type 2/3 templates carry no such field. Store `null` for
        // those rather than `false`, so callers can tell "not applicable"
        // from "confirmed non-stacking" — kept boolean-or-null to stay small
        // across ~62k cached entries.
        // Read wherever the field exists rather than on a typecode whitelist:
        // only types 4 (374 templates) and 102 (18) carry `ints.stackable` in
        // this install, and it is 1 on every one of them, so presence is the
        // real signal. `null` still means "the template has no such field",
        // which callers treat as not-applicable rather than as false.
        const stackable = rec.ints.has('stackable') ? !!rec.ints.get('stackable') : null;
        // `itemFunction` is only meaningful (and only cached) for type-4
        // templates — TODO.md 2.2(b): a minted type-4 item's `ints['item
        // function']` is copied straight from its template's own value (with
        // two observed exceptions, see itemFactory.js). Types 2/3 always mint
        // a fixed value (5/6) regardless of the template, so there's nothing
        // useful to cache for them here.
        const itemFunction = rec.type === 4 && rec.ints.has('item function') ? rec.ints.get('item function') : null;
        // `part coverage` rows name the body parts an armour piece covers, by
        // body-part stringID (e.g. "32-gamedata.quack" = Head on a helmet).
        // Cached so bulk equip can warn when an item covers a part the target
        // character's MEDICAL record doesn't have — the one race-fit signal
        // that is derived from data rather than editorial. Null when the
        // template has no such rows (everything that isn't armour).
        const coverRows = rec.extra.get('part coverage');
        const partCoverage = coverRows && coverRows.length
          ? coverRows.map((r) => r.target).filter(Boolean)
          : null;
        // Dialogue lives on the type-1 CHARACTER template, never in the save
        // (see saveService.dialogueOf). Cached so the character card can say
        // whether a character's origin template can talk to the player at all
        // — 169 of this install's 659 templates carry a player package.
        // Resolved to sids here and to names after the sweep, since a package
        // may be defined in a file visited later than the character.
        const dialogueSids = rec.type === 1
          ? (rec.extra.get('dialogue package') || []).map((r) => r.target).filter(Boolean) : null;
        const playerDialogueSids = rec.type === 1
          ? (rec.extra.get('dialogue package player') || []).map((r) => r.target).filter(Boolean) : null;
        map.set(rec.sid, {
          name: asText(rec.name), type: rec.type, slot, stackable, itemFunction, partCoverage,
          ...(dialogueSids && dialogueSids.length ? { dialogueSids } : {}),
          ...(playerDialogueSids && playerDialogueSids.length ? { playerDialogueSids } : {}),
        });
      }

      // Material union: collected from EVERY definition, first-definition-wins
      // rule deliberately does not apply here (see comment above `materials`).
      const materialRows = rec.extra.get('material');
      if (materialRows && materialRows.length) {
        let set = materials.get(rec.sid);
        if (!set) { set = new Set(); materials.set(rec.sid, set); }
        for (const row of materialRows) if (row.target) set.add(row.target);
      }

      // Racial armour restrictions, unioned across definitions (see above).
      for (const [category, into] of [['races', raceOnly], ['races exclude', raceExclude]]) {
        const rows = rec.extra.get(category);
        if (!rows || !rows.length) continue;
        let set = into.get(rec.sid);
        if (!set) { set = new Set(); into.set(rec.sid, set); }
        for (const row of rows) if (row.target) set.add(row.target);
      }

      // Weapon grade ladder: type-51 (company/manufacturer) records carry an
      // extra['weapon models'] category whose rows point at type-50 (grade)
      // sids, with v0 as the grade's rank.
      //
      // EVERY definition is kept, tagged with the file it came from, because
      // both halves of a grade row are re-stated by mods and the game obeys the
      // last one. Keeping only the first produced a ladder that disagreed with
      // the player's own game on both the name and the number.
      if (rec.type === 50 || rec.type === 51) {
        let byFile = gradeNames.get(rec.sid);
        if (!byFile) { byFile = new Map(); gradeNames.set(rec.sid, byFile); }
        byFile.set(path.basename(file), asText(rec.name));
      }
      if (rec.type === 111) {
        let byFile = limbDefs.get(rec.sid);
        if (!byFile) { byFile = new Map(); limbDefs.set(rec.sid, byFile); }
        byFile.set(path.basename(file), {
          name: asText(rec.name),
          slot: rec.ints.has('slot') ? rec.ints.get('slot') : null,
          // A limb's own HP band: `HP` at level 0, `HP 1` at the top of the
          // ladder — the same shape armour's stats scale over, which is what
          // makes an armour-style quality control the right control here.
          hp: rec.ints.has('HP') ? rec.ints.get('HP') : null,
          hpMax: rec.ints.has('HP 1') ? rec.ints.get('HP 1') : null,
          value: rec.ints.has('value') ? rec.ints.get('value') : null,
        });
      }
      if (rec.type === 51) {
        const modelRows = rec.extra.get('weapon models');
        if (modelRows) {
          for (const row of modelRows) {
            if (!row.target) continue;
            gradeRows.push({
              companySid: rec.sid,
              modelSid: row.target,
              rank: row.v0,
              file: path.basename(file),
            });
          }
        }
      }
    }
  }

  const materialIdx = new Map();
  for (const [sid, set] of materials) materialIdx.set(sid, [...set]);

  // One entry per template that restricts anything, so the index stays small:
  // 63 of this install's 2344 type-3 records carry a rule.
  const raceRuleIdx = new Map();
  for (const sid of new Set([...raceOnly.keys(), ...raceExclude.keys()])) {
    raceRuleIdx.set(sid, {
      only: [...(raceOnly.get(sid) || [])],
      exclude: [...(raceExclude.get(sid) || [])],
    });
  }

  // Resolve the dialogue-package sids collected above to display names, now
  // that every file has been read.
  for (const entry of map.values()) {
    if (entry.dialogueSids) {
      entry.dialoguePackages = entry.dialogueSids.map((s) => (map.get(s) || {}).name || s);
      delete entry.dialogueSids;
    }
    if (entry.playerDialogueSids) {
      entry.playerDialoguePackages = entry.playerDialogueSids.map((s) => (map.get(s) || {}).name || s);
      delete entry.playerDialogueSids;
    }
  }

  /*
   * The grade ladder, resolved in the game's own load order — LAST definition
   * wins, for the name and for the rank alike.
   *
   * This is the same trap race names fell into (AGENTS.md §3), and the ladder
   * was sitting in it. Two things were wrong, both reported by a player who
   * could see the difference on his own screen:
   *
   *  - The NAME. `1069-gamedata.base` is "Edge Type 5" in `gamedata.base` and
   *    "Edge Type 3" in `rebirth.mod` (and in three other installed mods);
   *    `1071-gamedata.base` is "Edge Type 4" then "Edge Type 2". The base
   *    names are why this app offered an "Edge Type 5" the game has never
   *    heard of, and no Edge Type 2 or 3 at all.
   *  - The RANK, which matters more, because `itemFactory.defaultLevelForGrade()`
   *    writes it into a weapon's `ints.level`. All 11 grade pairs that are
   *    defined more than once carry a DIFFERENT rank in `rebirth.mod`:
   *    "Homemade / Industrial 005" is 30 in base and 55 in the mod. First
   *    definition wins meant handing out weapons at the wrong level.
   *
   * A file that is not in the load order at all (an installed-but-inactive
   * workshop mod) keeps its place at the end of `filesInLoadOrder()`, which is
   * where `loadOrder.js` already puts unlisted files. A sid nothing in the
   * order defines falls back to the flat index, then to the raw sid — never
   * dropped, since it is still a usable value to write.
   */
  const orderRank = new Map();
  // Required HERE, not at module scope: `loadOrder` reads `dataFiles()` from
  // this module, so a top-level import would close a cycle.
  const { filesInLoadOrder } = require('./loadOrder');
  filesInLoadOrder().forEach((f, i) => orderRank.set(path.basename(f), i));
  const lastRank = (file) => (orderRank.has(file) ? orderRank.get(file) : -1);

  const nameInLoadOrder = (sid) => {
    const byFile = gradeNames.get(sid);
    if (!byFile) return (map.get(sid) || {}).name || sid;
    let best = null;
    for (const [file, name] of byFile) {
      if (best === null || lastRank(file) >= lastRank(best.file)) best = { file, name };
    }
    return best ? best.name : sid;
  };

  // One row per (companySid, modelSid) PAIR — `modelSid` alone is NOT a key:
  // 14 of this install's 24 model sids appear under two different companies
  // (1069-gamedata.base is both "Homemade" and "Edgewalkers"). Anything
  // selecting a grade must carry this `id`, or it is silently choosing
  // whichever row happens to sort first. See itemFactory.resolveGrade().
  const byPair = new Map();
  for (const row of gradeRows) {
    const key = `${row.companySid}|${row.modelSid}`;
    const held = byPair.get(key);
    if (!held || lastRank(row.file) >= lastRank(held.file)) byPair.set(key, row);
  }
  const grades = [];
  for (const [key, row] of byPair) {
    grades.push({
      id: key,
      companySid: row.companySid,
      companyName: nameInLoadOrder(row.companySid),
      modelSid: row.modelSid,
      modelName: nameInLoadOrder(row.modelSid),
      rank: row.rank,
    });
  }
  grades.sort((a, b) => a.rank - b.rank || a.modelName.localeCompare(b.modelName));

  /*
   * Robotic limbs, resolved the same way — last definition wins per FIELD it
   * actually carries, which is the rule the research tree already uses: a mod
   * re-stating a limb purely to change its mesh must not blank the `slot` the
   * base definition gave it, and a later definition that DOES carry a slot
   * must win. All 32 of this install's limb templates resolve to a slot this
   * way, eight per limb, where the flat index left 20 of them sideless.
   */
  const SLOT_TO_PART = new Map([[50, 3], [51, 4], [52, 5], [53, 6]]);
  const limbs = [];
  for (const [sid, byFile] of limbDefs) {
    const merged = { name: null, slot: null, hp: null, hpMax: null, value: null };
    const ordered = [...byFile.entries()].sort((a, b) => lastRank(a[0]) - lastRank(b[0]));
    for (const [, def] of ordered) {
      for (const key of Object.keys(merged)) {
        if (def[key] !== null && def[key] !== undefined) merged[key] = def[key];
      }
    }
    limbs.push({
      sid,
      name: merged.name || sid,
      slot: merged.slot,
      // The MEDICAL part index this limb fits, which is the whole point of
      // reading `slot`: 50..53 line up with parts 3..6 in body order.
      partIndex: SLOT_TO_PART.has(merged.slot) ? SLOT_TO_PART.get(merged.slot) : null,
      hp: merged.hp,
      hpMax: merged.hpMax,
      value: merged.value,
    });
  }
  limbs.sort((a, b) => (a.partIndex ?? 9) - (b.partIndex ?? 9) || a.name.localeCompare(b.name));

  stats = { files, skipped: skipped.length, stringIds: map.size, builtAt: new Date().toISOString() };
  return { map, materialIdx, grades, raceRuleIdx, limbs };
}

function load() {
  if (index) return index;
  try {
    const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (cached.version !== CACHE_VERSION) throw new Error('stale cache version');
    index = new Map(Object.entries(cached.index));
    materialIndex = new Map(Object.entries(cached.materialIndex || {}));
    weaponGradeList = cached.weaponGrades || [];
    limbList = cached.limbs || [];
    raceRuleIndex = new Map(Object.entries(cached.raceRules || {}));
    stats = cached.stats;
    return index;
  } catch { /* no cache yet, or a stale/incompatible one — rebuild it */ }

  const built = build();
  index = built.map;
  materialIndex = built.materialIdx;
  weaponGradeList = built.grades;
  limbList = built.limbs;
  raceRuleIndex = built.raceRuleIdx;
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({
      version: CACHE_VERSION,
      stats,
      index: Object.fromEntries(index),
      materialIndex: Object.fromEntries(materialIndex),
      weaponGrades: weaponGradeList,
      limbs: limbList,
      raceRules: Object.fromEntries(raceRuleIndex),
    }));
  } catch { /* cache is an optimisation, not a requirement */ }
  return index;
}

function rebuild() {
  index = null;
  materialIndex = null;
  weaponGradeList = null;
  limbList = null;
  raceRuleIndex = null;
  try { fs.unlinkSync(CACHE_FILE); } catch { /* nothing cached */ }
  return load();
}

/** Resolve a stringID to its name, falling back to the raw stringID. */
function nameOf(sid, fallback) {
  if (!sid) return fallback ?? '';
  const hit = load().get(sid);
  return hit ? hit.name : (fallback ?? sid);
}

function lookup(sid) { return load().get(sid) || null; }
function indexStats() { load(); return stats; }

/**
 * Union of `extra['material']` targets across every definition of `sid`
 * (TODO.md 2.2(h)) — NOT first-definition-wins. Used by itemFactory.js to
 * default a minted type-3/4 item's `material sid` to the first candidate.
 * Empty array when the sid has no material rows anywhere (the norm for type-2
 * weapons, which use the grade ladder below instead).
 * @returns {string[]}
 */
function materialCandidates(sid) {
  if (!sid) return [];
  load();
  return materialIndex.get(sid) || [];
}

/**
 * The full weapon grade ladder (TODO.md 2.2(i)): every (company, model) pair
 * recoverable from type-51 `extra['weapon models']` rows, de-duplicated and
 * ordered by rank ascending (`v0`, lowest/worst first). A weapon's "grade" in
 * the FCS/wiki sense is this (company sid, material sid) pair, not `level`.
 * @returns {{companySid: string, companyName: string, modelSid: string, modelName: string, rank: number}[]}
 */
function weaponGrades() {
  load();
  return weaponGradeList;
}

/**
 * Every gamedata TEMPLATE entry whose typecode is an item template (2, 3 or
 * 4 — see `ITEM_TEMPLATE_TYPES`, TODO.md 2.2(g)). Backs the item picker
 * (`GET /api/gamedata/items`); this is the source of the list, never
 * `itemCatalogService`, which only decorates a hit (TODO.md 2.3).
 * @returns {{ sid: string, name: string, type: number, slot: number|null, stackable: boolean|null }[]}
 */
function itemTemplates() {
  const idx = load();
  const out = [];
  for (const [sid, entry] of idx) {
    if (ITEM_TEMPLATE_TYPES.has(entry.type)) out.push({ sid, ...entry });
  }
  return out;
}

/**
 * Kenshi's OWN racial armour restrictions for one template, or null when it
 * restricts nothing (the overwhelming majority — 63 of this install's 2344
 * type-3 armour records carry a rule).
 *
 *   `only`    — `extra['races']`, a WHITELIST: no other race may wear it. This
 *               is the Hiver shirts ("Hiver Chain Shirt", "Leather Hive Vest",
 *               "Rusted Hive Shirt") and the four hats the wiki lists as
 *               human-only (Wool Hat, Cap, Hachigane, Side-Angle Hachigane).
 *   `exclude` — `extra['races exclude']`, a BLACKLIST: every ordinary shirt
 *               excludes all nine Hive races, and the helmets Shek and Hive
 *               Workers cannot wear name them here (Masked/Visored/Spiked/
 *               Flared Helmet, Karuta/Kusari Zukin, Crab Helmet, Tin Can...).
 *
 * Both sides are unioned across every definition of the sid, exactly like the
 * material index and for the same reason: a mod re-defining a vanilla helmet to
 * attach one exclusion must not blank the ones the base file already stated.
 * "Paladin's Heavy Hachigane" is the case that shows it — one definition
 * carries the whitelist and another the blacklist.
 *
 * This is DERIVED data, and it closes a question AGENTS.md previously recorded
 * as open ("Kenshi's real race/mesh restrictions are not in any field this
 * editor has identified"). It reproduces the wiki's per-item restriction lists
 * exactly. What it does NOT carry is the wiki's per-race "slot disabled" rows
 * (a Skeleton having no shirt slot at all) — nothing in a type-7 race record
 * expresses that, so that half stays editorial, in services/fitCheck.js.
 *
 * @returns {{ only: string[], exclude: string[] } | null} race stringIDs
 */
function raceRules(sid) {
  if (!sid) return null;
  load();
  return raceRuleIndex.get(sid) || null;
}

/**
 * The robotic limbs this install offers, each already resolved to the MEDICAL
 * part it fits (`partIndex` 3..6) via its own `ints.slot` (50..53). See
 * build()'s comment for why this cannot be read off the flat index.
 */
function limbTemplates() {
  load();
  return limbList || [];
}

module.exports = {
  nameOf, lookup, rebuild, indexStats, dataFiles, itemTemplates, ITEM_TEMPLATE_TYPES,
  materialCandidates, weaponGrades, raceRules, limbTemplates,
};
