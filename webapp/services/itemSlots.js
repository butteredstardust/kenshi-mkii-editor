'use strict';

const fs = require('node:fs');
const path = require('node:path');

const gamedata = require('./gamedataService');

/**
 * Single source of truth for "which `strings.section` values is a type-42
 * ITEM record allowed to move into" (TODO.md 2.1). Used by both
 * `saveService.setItemSection()` (server-side enforcement) and the Gear tab's
 * `allowedSections` payload (UI option list) — the UI must never duplicate
 * this logic.
 *
 * === Investigation result (TODO.md 2.1 "is there an authoritative slot
 * field?") ===
 *
 * YES, for armour. Every type-3 (armour) gamedata TEMPLATE record carries its
 * own `ints.slot` integer (parsed straight off `gamedata.base`/mod files,
 * same codec used everywhere else). Resolving every one of the 1648 type-42
 * ITEM records in the live save through its `base data sid` and
 * cross-tabulating the template's `slot` against the item's own observed
 * `section` found an exact, zero-exception 1:1 mapping:
 *
 *   slot 3 -> head    (86 live items, all slot 3)
 *   slot 5 -> armour  (229 live items, all slot 5)
 *   slot 6 -> legs    (236 live items, all slot 6)
 *   slot 8 -> shirt   (126 live items, all slot 8)
 *   slot 9 -> boots   (205 live items, all slot 9)
 *
 * This field is NOT reliable for type-2 (weapons): it exists there too, but
 * is 0 on every single sampled weapon template (19/19 in gamedata.base,
 * 27/47 in rebirth.mod) and carries no disambiguating information — the SAME
 * weapon template (Katana, sid 476-gamedata.base) was observed equipped in
 * BOTH `hip` and `back` on different live item instances, so `slot` cannot
 * and does not decide hip vs back for weapons. It is therefore only trusted
 * for type-3 records here; type-2/type-4 use the typecode fallback below.
 *
 * The field is also not universal: gamedata.base has it on 100% of its own
 * type-2/type-3 records, but bundled overhaul mods omit it on most of theirs
 * (rebirth.mod: 29/131 type-3, 27/47 type-2; Newwworld.mod: 19/30 type-3).
 * Absence is the common case for modded content, not an edge case — every
 * path below falls through to a permissive rule, never to "no slots".
 *
 * === Resolution order (per TODO.md 2.1) ===
 *
 *  1. type-3 template's own `ints.slot`, if present and one of the mapped
 *     values above (ARMOUR_SLOT_MAP) -> that one specific section.
 *  2. Otherwise, for type-3 only, the one-save observational fallback in
 *     `data/itemSlotObservations.json` (generated from the SAME live-save
 *     sweep, for templates whose `slot` field was absent/unmapped but every
 *     live instance still agreed on one section) -> that one section.
 *  3. Otherwise the typecode-level set (TYPECODE_SECTIONS) for a
 *     known typecode (2, 3, 4).
 *  4. Otherwise (typecode unresolved, or resolved to something with no rule
 *     here) -> PERMISSIVE: every documented section. Hiding a legitimate slot
 *     on a modded item this editor has never seen is worse than occasionally
 *     offering an invalid one (this install is heavily modded).
 *
 * Always, on top of whichever base set above: the two storage buckets
 * (`main`, `backpack_content`) are added, and the item's OWN current section
 * is added if it isn't already in the set — otherwise an item sitting in an
 * unexpected slot would become impossible to move out of, misrepresenting
 * what the save actually allows.
 */

// type-3 (armour) template `ints.slot` -> the single `strings.section` it
// belongs in. Only values confirmed by the live-save cross-tabulation above
// are listed; an unrecognised slot int (e.g. 14, seen on a couple of goggle
// items in gamedata.base but never cross-tabulated against a live item, since
// none were equipped in this save) falls through to the type-3 typecode set
// rather than guessing a section for it.
const ARMOUR_SLOT_MAP = new Map([
  [3, 'head'],
  [5, 'armour'],
  [6, 'legs'],
  [8, 'shirt'],
  [9, 'boots'],
]);

// Typecode-level fallback sections. Evidence: swept all 1648 type-42 ITEM
// records in the live save, resolved each through gamedata, tallied which
// `section` each actually occupies (TODO.md 2.1):
//   type 2 (weapons):     back×206  hip×56
//   type 3 (armour):      legs×236  armour×229  boots×205  shirt×126  head×86
//   type 4 (trade goods): main×503
// (type 4's list is empty here deliberately — main/backpack_content are added
// unconditionally below as buckets, so "no extra equip slots" is correct.)
// Type 46 (backpack) added later, from the same sweep: all 42 live
// type-46-backed items sit in `backpack_attach`, zero exceptions. Before this
// it fell through to the permissive branch, so it worked but offered all 11
// slots and reported `widened: true`.
//
// Type 107 (crossbow) resolved later still. It first looked ambiguous — its 7
// live items split 6 `back` / 1 `backpack_content` — but the outlier is a
// crossbow being CARRIED in a pack, and `backpack_content` is a bucket every
// item may sit in, not a competing equip slot. Every one that is actually
// equipped is on the back, which is also where Kenshi wears a crossbow.
// Type 111 (robotic limb) gets NO equip section: all 11 live ones sit in
// `backpack_content`, i.e. carried. A limb is not worn from the inventory — you
// carry it and have it fitted at a bench, after which it lives in the
// character's limb data rather than as an item. The buckets added below are the
// whole of its legitimate list.
const TYPECODE_SECTIONS = new Map([
  [2, ['hip', 'back']],
  [3, ['head', 'shirt', 'armour', 'legs', 'boots']],
  [4, []],
  [46, ['backpack_attach']],
  [107, ['back']],
  [111, []],
  // Type 102 (map) is carried, never worn: all 39 live map items in the
  // install's own level files sit in `backpack_content`.
  [102, []],
]);

// Type-4 (trade goods) `ints.slot` -> section, the same trick ARMOUR_SLOT_MAP
// plays for armour. Only slot 14 is mapped: it is the money belts ("1,000c",
// "10,000c", "100,000c") and every one of the six live type-4 items sitting in
// `belt` is one of them. Slot 7 is ordinary carried goods and slot 12 is the
// two lanterns, neither of which was ever observed in an equip slot.
const TRADE_SLOT_MAP = new Map([[14, 'belt']]);

// Legitimate for every item regardless of kind — general carry and pack
// storage, never a body/equip slot.
const BUCKET_SECTIONS = ['main', 'backpack_content'];

// Every documented slot string (TODO.md 2.1 / AGENTS.md §5), in the order the
// UI should render them. Also the permissive fallback set.
const ALL_SECTIONS = ['main', 'head', 'shirt', 'armour', 'legs', 'boots', 'back', 'hip', 'belt', 'backpack_attach', 'backpack_content'];

const OBSERVATIONS_FILE = path.join(__dirname, '..', 'data', 'itemSlotObservations.json');
let observations = null;
function loadObservations() {
  if (observations) return observations;
  observations = new Map();
  try {
    const data = JSON.parse(fs.readFileSync(OBSERVATIONS_FILE, 'utf8'));
    for (const [sid, section] of Object.entries(data.observations || {})) observations.set(sid, section);
  } catch { /* observational fallback is an enrichment, not a requirement */ }
  return observations;
}

/**
 * @param {string|null|undefined} baseSid  the item's `strings.get('base data sid')`
 * @param {string} currentSection  the item's OWN current `strings.section` —
 *   always included in the result (see file comment).
 * @returns {{ sections: string[], widened: boolean }} `widened` is true only
 *   when the item's kind could not be resolved/mapped at all, i.e. the FULL
 *   permissive slot list was offered — callers should surface this once so
 *   the user knows the editor can't vouch for compatibility here.
 */
function allowedSections(baseSid, currentSection) {
  const tmpl = baseSid ? gamedata.lookup(baseSid) : null;
  let base;
  let widened = false;

  if (tmpl && tmpl.type === 3 && tmpl.slot != null && ARMOUR_SLOT_MAP.has(tmpl.slot)) {
    base = [ARMOUR_SLOT_MAP.get(tmpl.slot)];
  } else if (tmpl && tmpl.type === 4 && tmpl.slot != null && TRADE_SLOT_MAP.has(tmpl.slot)) {
    base = [TRADE_SLOT_MAP.get(tmpl.slot)];
  } else if (tmpl && tmpl.type === 3 && baseSid && loadObservations().has(baseSid)) {
    base = [loadObservations().get(baseSid)];
  } else if (tmpl && TYPECODE_SECTIONS.has(tmpl.type)) {
    base = TYPECODE_SECTIONS.get(tmpl.type).slice();
  } else {
    base = ALL_SECTIONS.slice();
    widened = true;
  }

  const set = new Set(base);
  for (const b of BUCKET_SECTIONS) set.add(b);
  if (currentSection) set.add(currentSection);

  const sections = ALL_SECTIONS.filter((s) => set.has(s));
  if (currentSection && !sections.includes(currentSection)) sections.push(currentSection);

  return { sections, widened };
}

/** True if `targetSection` is one of `baseSid`'s allowed sections. */
function isAllowed(baseSid, currentSection, targetSection) {
  return allowedSections(baseSid, currentSection).sections.includes(targetSection);
}

module.exports = {
  ARMOUR_SLOT_MAP, TRADE_SLOT_MAP, TYPECODE_SECTIONS, BUCKET_SECTIONS, ALL_SECTIONS,
  allowedSections, isAllowed,
};
