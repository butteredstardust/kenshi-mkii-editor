'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { readFile } = require('./kenshi/codec');
const { asText } = require('./kenshi/binary');
const { filesInLoadOrder } = require('./loadOrder');
const gamedata = require('./gamedataService');

/**
 * Races: the type-7 gamedata catalogue, and the body plan a race implies.
 *
 * ===========================================================================
 * WHERE A CHARACTER'S RACE ACTUALLY LIVES
 * ===========================================================================
 * In the APPEARANCE (66) record's `extra` section, category `"race"`, as a
 * single row whose `target` is the race's stringID. It is NOT a key in
 * bools/floats/ints/strings (docs/save-format.md §5). That one row is the whole
 * of the save's opinion about species — everything else a race implies is
 * derived from the type-7 record in gamedata.
 *
 * ===========================================================================
 * WHY THE NAME NEEDS LOAD ORDER (this is the headline finding)
 * ===========================================================================
 * `gamedataService` resolves names first-definition-wins, which for races is
 * actively misleading:
 *
 *   17-gamedata.quack    "Human"    in gamedata.base -> "Greenlander" in rebirth.mod
 *   18019-gamedata.base  "Sundemon" in gamedata.base -> "Scorchlander" in rebirth.mod
 *
 * Both are 20-definition sids. The player sees "Greenlander" and "Scorchlander"
 * in-game, so an editor calling them "Human" and "Sundemon" is naming something
 * the player cannot find. Race names are therefore resolved in the game's own
 * `data/mods.cfg` load order, last definition wins — the same rule, and the same
 * shared `loadOrder.js`, that `researchService` needed for tech names and
 * `repeats`.
 *
 * ===========================================================================
 * THE BODY PLAN: extra['combat anatomy'] IS the MEDICAL record's sid/hit rows
 * ===========================================================================
 * A type-7 race carries an `extra['combat anatomy']` category, one row per body
 * part, `target` = the part's stringID (a type-16 record), `v0` and `v1` two
 * numbers. Measured against every character in every save on this machine —
 * 3717 of them, 15 distinct races:
 *
 *   - the race's part SET equals the character's MEDICAL `sid<n>` set:  3717/3717
 *   - `hit<n>` equals that part's `v0`, exactly:                        3717/3717
 *   - `flesh<n>` never exceeds that part's `v1`:                        3678/3717
 *
 * So `v0` is `hit<n>` and `v1` is the part's undamaged maximum. The 39
 * `flesh > v1` exceptions are all Hive Worker Drones reading up to 125 against a
 * v1 of 75 — characters wearing ROBOTIC LIMBS, which is also where the
 * otherwise-uniform `hitmult<n>` stops being 1. `v1` is the natural cap, not a
 * hard one, which is why setRace() SCALES flesh rather than clamping it: a
 * clamp would quietly amputate a prosthetic's headroom.
 *
 * Two rules are needed to get that 3717/3717, and both were forced by the data:
 *
 * 1. UNION the rows across every definition, last-wins per part — do not let the
 *    last definition replace the list. `rebirth.mod` re-defines Scorchlander
 *    carrying ONE row (Right Arm 60/100, which is exactly what makes a
 *    Scorchlander not a Greenlander). Replace-the-list gives that race a
 *    one-limbed body and mismatches all 862 of them; union gives 7/7.
 *    This is the same rule as gamedataService's material index.
 *
 * 2. A row whose value is 2147483647 (INT32_MAX) is a REMOVAL marker, not a
 *    number. "Unofficial Patches for Kenshi.mod" re-defines Goat with four rows:
 *    Left/Right Foreleg at 100/100, and Left/Right Arm at 2147483647. Live goats
 *    have 7 parts — the base seven, minus the two arms, plus the two forelegs.
 *    Keeping the sentinel rows gives a 9-part plan that matches no goat in any
 *    save; dropping them matches all 20.
 *
 * ===========================================================================
 * THE MEDICAL SLOT ORDER IS FIXED, AND SLOTS SUBSTITUTE ACROSS RACES
 * ===========================================================================
 * Every one of the 15 races observed in a save uses the same seven slots in the
 * same order:
 *
 *   sid0 Head | sid1 Chest | sid2 Stomach | sid3 left upper limb
 *   sid4 right upper limb | sid5 Left Leg | sid6 Right Leg
 *
 * Slots 3 and 4 hold `Left Arm`/`Right Arm` on people and `Left
 * Foreleg`/`Right Foreleg` on animals — and those type-16 part records are
 * otherwise identical twins: same `body part type` (2), same `collapse part`
 * bitmask (4 and 2), same bone names (`Bip01 L UpperArm`/`Bip01 L Forearm`).
 * They are the same slot under two names, which is what lets a race switch map
 * one plan onto another positionally instead of guessing an ordering.
 *
 * `hitmult<n>`, `rig<n>`, `wear<n>` and `bandage<n>` are per-CHARACTER, not
 * per-race (1 / 0 / 0 on all but the prosthetic-wearers), so a race switch does
 * not touch them.
 */

const CACHE_FILE = path.join(__dirname, '..', '.cache', 'races.json');
// 1: initial — load-order names, unioned anatomy, INT32_MAX removal sentinel.
// 2: `label`, which disambiguates the several races sharing a name.
const CACHE_VERSION = 2;

const RACE = 7;
const BODY_PART = 16;

/**
 * A `combat anatomy` value of INT32_MAX means "this race does not have this
 * part", written by a mod removing a part the base definition gave. See the
 * Goat case in the header comment.
 */
const REMOVED = 2147483647;

let cached = null;

/**
 * Resolve every type-7 record in load order.
 *
 * Scalars: last definition that CARRIES the field wins (a mod attaching one
 * anatomy row must not blank the mesh paths it never mentioned) — the same
 * discipline as researchService.build().
 */
function build() {
  const races = new Map();
  const parts = new Map();

  for (const file of filesInLoadOrder()) {
    let parsed;
    try { parsed = readFile(fs.readFileSync(file)); } catch { continue; }
    const from = path.basename(file);

    for (const rec of parsed.records) {
      if (!rec.sid) continue;

      if (rec.type === BODY_PART) {
        // Body parts are needed for display names and for the slot-substitution
        // check in planFor() — `body part type` + `collapse part` is what says a
        // Left Foreleg occupies a Left Arm's slot.
        let p = parts.get(rec.sid);
        if (!p) { p = { sid: rec.sid, name: rec.sid, partType: null, collapse: null }; parts.set(rec.sid, p); }
        const nm = asText(rec.name); if (nm) p.name = nm;
        if (rec.ints.has('body part type')) p.partType = rec.ints.get('body part type');
        if (rec.ints.has('collapse part')) p.collapse = rec.ints.get('collapse part');
        continue;
      }

      if (rec.type !== RACE) continue;

      let r = races.get(rec.sid);
      if (!r) {
        r = {
          sid: rec.sid, name: rec.sid, playable: false, isRobot: false, singleGender: false,
          editorLimits: '', anatomy: new Map(), definedIn: [],
        };
        races.set(rec.sid, r);
      }
      r.definedIn.push(from);

      const nm = asText(rec.name); if (nm) r.name = nm;
      if (rec.bools.has('playable')) r.playable = !!rec.bools.get('playable');
      if (rec.bools.has('is robot')) r.isRobot = !!rec.bools.get('is robot');
      if (rec.bools.has('single gender')) r.singleGender = !!rec.bools.get('single gender');
      // `editor limits` names the game's own slider-set XML
      // (editor_data_human.xml, editor_data_bone_people.xml, ...). It is the one
      // DERIVED signal for whether two races share an appearance-slider family,
      // which is what decides whether a switch keeps a face or loses one.
      const el = asText(rec.filenames.get('editor limits') || ''); if (el) r.editorLimits = el;

      // Union, last-wins per part. See rule 1 in the header comment.
      for (const row of rec.extra.get('combat anatomy') || []) {
        if (!row.target) continue;
        r.anatomy.set(row.target, { sid: row.target, hit: row.v0, max: row.v1 });
      }
    }
  }

  const list = [...races.values()].map((r) => {
    // Rule 2: drop removal sentinels AFTER the union, so a later definition can
    // both add a part and remove another.
    const anatomy = [...r.anatomy.values()]
      .filter((p) => p.hit !== REMOVED && p.max !== REMOVED)
      .map((p) => ({ ...p, name: (parts.get(p.sid) || {}).name || gamedata.nameOf(p.sid, p.sid) }));
    return {
      sid: r.sid,
      name: r.name,
      // Filled in after the sort, once name collisions are known — see below.
      label: r.name,
      playable: r.playable,
      isRobot: r.isRobot,
      singleGender: r.singleGender,
      editorLimits: r.editorLimits,
      // The slider family two races must share for a switch to keep the
      // character's face. Basename only — the full path is install-relative
      // noise, and a race with no `editor limits` at all (most animals) gets
      // null, which never compares equal to anything.
      appearanceFamily: r.editorLimits ? path.basename(r.editorLimits).toLowerCase() : null,
      anatomy,
      definitions: r.definedIn.length,
    };
  });

  list.sort((a, b) => a.name.localeCompare(b.name));

  // Race NAMES are not unique — this install has two distinct "Alpha Fishman"
  // records (`1532523-rebirth.mod` and `1532526-Newwworld Plus.mod`) and several
  // other mod-vs-mod collisions. A picker showing the same word twice gives the
  // user no way to tell which one they are choosing, so a colliding name is
  // suffixed with the file the sid originated in — the one thing that
  // distinguishes them. `name` stays the raw resolved name for matching and
  // reporting; `label` is what a UI shows.
  const nameCounts = new Map();
  for (const r of list) nameCounts.set(r.name, (nameCounts.get(r.name) || 0) + 1);
  for (const r of list) {
    const origin = r.sid.includes('-') ? r.sid.slice(r.sid.indexOf('-') + 1) : r.sid;
    r.label = nameCounts.get(r.name) > 1 ? `${r.name} (${origin})` : r.name;
  }

  const stats = {
    races: list.length,
    withAnatomy: list.filter((r) => r.anatomy.length).length,
    playable: list.filter((r) => r.playable).length,
    switchable: list.filter((r) => r.anatomy.length).length,
    bodyParts: parts.size,
    multiDefinition: list.filter((r) => r.definitions > 1).length,
    builtAt: new Date().toISOString(),
  };
  return { races: list, parts: [...parts.values()], stats };
}

function load() {
  if (cached) return cached;
  try {
    const disk = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (disk.version === CACHE_VERSION) { cached = disk; return cached; }
  } catch { /* no cache, or a stale one — rebuild */ }
  cached = { version: CACHE_VERSION, ...build() };
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cached));
  } catch { /* the cache is an optimisation, not a requirement */ }
  return cached;
}

function rebuild() {
  cached = null;
  try { fs.unlinkSync(CACHE_FILE); } catch { /* nothing cached */ }
  return load();
}

/** Every resolved race, name-ascending. */
function catalogue() { return load().races; }
function stats() { return load().stats; }

let bySid = null;
function raceBySid(sid) {
  if (!bySid) bySid = new Map(catalogue().map((r) => [r.sid, r]));
  return bySid.get(sid) || null;
}

let partIndex = null;
function partBySid(sid) {
  if (!partIndex) partIndex = new Map(load().parts.map((p) => [p.sid, p]));
  return partIndex.get(sid) || null;
}

/**
 * A race's display name, resolved in LOAD ORDER — "Greenlander", not "Human".
 *
 * Falls back to `gamedataService.nameOf()` for a sid that is not a type-7
 * record at all, so a caller can hand this any race row's target without
 * checking first.
 */
function nameOf(sid, fallback) {
  const r = sid ? raceBySid(sid) : null;
  if (r) return r.name;
  return gamedata.nameOf(sid, fallback);
}

/**
 * Can `part` stand in for `slot`'s current occupant?
 *
 * Same stringID is the easy yes. Otherwise the two type-16 records must agree on
 * `body part type` AND `collapse part` — which is precisely how `Left Foreleg`
 * qualifies as a `Left Arm` (both type 2, both collapse 4, same bones) while
 * nothing qualifies as a Head. Anything else is refused rather than guessed.
 */
function partsInterchangeable(aSid, bSid) {
  if (aSid === bSid) return true;
  const a = partBySid(aSid);
  const b = partBySid(bSid);
  if (!a || !b) return false;
  if (a.partType === null || a.collapse === null) return false;
  return a.partType === b.partType && a.collapse === b.collapse;
}

module.exports = {
  REMOVED, RACE, BODY_PART,
  catalogue, stats, rebuild, raceBySid, partBySid, nameOf, partsInterchangeable,
};
