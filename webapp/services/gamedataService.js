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
// 5: `partCoverage` per entry (bulk equip's fit warnings) and a stable `id` on
// every weapon-grade row.
const CACHE_VERSION = 5;

// Item-template typecodes (TODO.md 2.2(g)/2.3): 2 = weapon, 3 = armour,
// 4 = trade goods/consumable, 46 = backpack, 107 = crossbow. Type 42 is the
// save-side ITEM *instance* record, not a template, and must never appear here.
//
// 46 was added when bulk equip landed: 22 backpack templates exist in this
// install's data and the picker used to hide every one of them, which is why
// the equip scripts had to hand-roll a backpack record. All 42 live
// type-46-backed items confirm the minted shape (see itemFactory.js).
//
// 107 is the crossbow — a whole weapon class that was unreachable until the
// loadout work went looking for a ranged archetype and found "Ranger" sitting
// at a typecode nothing accepted.
const ITEM_TEMPLATE_TYPES = new Set([2, 3, 4, 46, 107]);

let index = null;
let stats = null;
// sid -> string[] (union of extra['material'] targets across EVERY definition
// of that sid, not first-definition-wins — see build()'s comment and TODO.md
// 2.2(h)).
let materialIndex = null;
// Ordered, de-duplicated weapon grade ladder (TODO.md 2.2(i)) — see build().
let weaponGradeList = null;

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
  // Weapon grade ladder rows (TODO.md 2.2(i)): every type-51 (company) record's
  // extra['weapon models'] category, one row per type-50 (grade) sid it offers,
  // with v0 as that grade's rank. Resolved to names after the full sweep, since
  // a type-50 record's own name may be defined in a file visited later than its
  // company's.
  const gradeRows = []; // { companySid, companyName, modelSid, rank }
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
        const stackable = rec.type === 4 ? !!(rec.ints.has('stackable') && rec.ints.get('stackable')) : null;
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
        map.set(rec.sid, { name: asText(rec.name), type: rec.type, slot, stackable, itemFunction, partCoverage });
      }

      // Material union: collected from EVERY definition, first-definition-wins
      // rule deliberately does not apply here (see comment above `materials`).
      const materialRows = rec.extra.get('material');
      if (materialRows && materialRows.length) {
        let set = materials.get(rec.sid);
        if (!set) { set = new Set(); materials.set(rec.sid, set); }
        for (const row of materialRows) if (row.target) set.add(row.target);
      }

      // Weapon grade ladder: type-51 (company/manufacturer) records carry an
      // extra['weapon models'] category whose rows point at type-50 (grade)
      // sids, with v0 as the grade's rank.
      if (rec.type === 51) {
        const modelRows = rec.extra.get('weapon models');
        if (modelRows) {
          for (const row of modelRows) {
            if (!row.target) continue;
            gradeRows.push({ companySid: rec.sid, companyName: asText(rec.name), modelSid: row.target, rank: row.v0 });
          }
        }
      }
    }
  }

  const materialIdx = new Map();
  for (const [sid, set] of materials) materialIdx.set(sid, [...set]);

  // De-dupe by (companySid, modelSid) — the same pair can appear more than
  // once across data files (e.g. a mod re-stating a vanilla company's row).
  // Resolve modelName from `map` now that the whole sweep is complete; a
  // model sid that never resolves (never seen as any record's own sid) falls
  // back to the raw sid rather than being dropped, since it's still a usable
  // value to write even without a display name.
  const seenGrades = new Set();
  const grades = [];
  for (const row of gradeRows) {
    const key = `${row.companySid}|${row.modelSid}`;
    if (seenGrades.has(key)) continue;
    seenGrades.add(key);
    const modelEntry = map.get(row.modelSid);
    grades.push({
      // The (company, model) PAIR is the grade — `modelSid` alone is NOT a key:
      // 14 of this install's 24 model sids appear under two different companies
      // (1069-gamedata.base is both "Homemade" and "Edgewalkers"). Anything
      // selecting a grade must carry this `id`, or it is silently choosing
      // whichever row happens to sort first. See itemFactory.resolveGrade().
      id: key,
      companySid: row.companySid,
      companyName: row.companyName,
      modelSid: row.modelSid,
      modelName: modelEntry ? modelEntry.name : row.modelSid,
      rank: row.rank,
    });
  }
  grades.sort((a, b) => a.rank - b.rank);

  stats = { files, skipped: skipped.length, stringIds: map.size, builtAt: new Date().toISOString() };
  return { map, materialIdx, grades };
}

function load() {
  if (index) return index;
  try {
    const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (cached.version !== CACHE_VERSION) throw new Error('stale cache version');
    index = new Map(Object.entries(cached.index));
    materialIndex = new Map(Object.entries(cached.materialIndex || {}));
    weaponGradeList = cached.weaponGrades || [];
    stats = cached.stats;
    return index;
  } catch { /* no cache yet, or a stale/incompatible one — rebuild it */ }

  const built = build();
  index = built.map;
  materialIndex = built.materialIdx;
  weaponGradeList = built.grades;
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({
      version: CACHE_VERSION,
      stats,
      index: Object.fromEntries(index),
      materialIndex: Object.fromEntries(materialIndex),
      weaponGrades: weaponGradeList,
    }));
  } catch { /* cache is an optimisation, not a requirement */ }
  return index;
}

function rebuild() {
  index = null;
  materialIndex = null;
  weaponGradeList = null;
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

module.exports = {
  nameOf, lookup, rebuild, indexStats, dataFiles, itemTemplates,
  materialCandidates, weaponGrades,
};
