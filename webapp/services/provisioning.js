'use strict';

const gamedata = require('./gamedataService');
const loadouts = require('./loadouts');
const recruits = require('./recruits');
// Race NAMES need load order — "Skeleton" is one of the few race names that
// does NOT collide with a mod re-definition on this install, but resolving it
// through gamedata.nameOf() instead of racesService would be the same mistake
// AGENTS.md §3 documents for Greenlander/Scorchlander, so this file never does.
const races = require('./racesService');

/**
 * Decides what a brand-new recruit arrives WEARING and CARRYING, so
 * `saveService.addSquadMember()` can mint that gear into the same in-memory
 * parse as the character itself (ONE staged edit, per AGENTS.md §2 — a
 * failure must never leave a naked recruit).
 *
 * This is the single place two decisions live, both deliberately NOT
 * scattered across the loadout catalogue or the record-building code:
 *
 *   1. DEFAULT GRADES. A provisioned recruit's armour is always Specialist
 *      (`level` 80 — `public/modules/grades.mjs`'s own DEFAULT_ARMOUR_LEVEL)
 *      and a provisioned recruit's melee weapon is always Catun No.3, rank 40
 *      — the real manufacturer row `1057-gamedata.base|1060-gamedata.base`
 *      (Catun Scrapmaster), NOT `PLAYER_WEAPONS|1060-gamedata.base`
 *      ("Homemade"), which is the player-crafted variant of the same model
 *      and not a grade a game-spawned recruit would carry. These OVERRIDE
 *      whatever `level`/`gradeId` the chosen loadout entry carries — a
 *      loadout is a template for WHICH PIECES to give; the recruit's grade is
 *      a separate decision (see CATUN_NO_3 / ARMOUR_LEVEL below).
 *   2. CATS. A random 300-5000, as an inventory item stack (`I.cats`, the
 *      "Cats" template, type 4, stackable) — not player money.
 *
 * Everything else (which loadout fits an archetype/sub/tier, and the
 * medical-kit/food consumables layered on top) is editorial, exactly like
 * services/loadouts.js and services/recruits.js — safe to re-balance without
 * re-deriving anything from a save.
 */

// ---------------------------------------------------------------- grades --

// The pair (company sid, model sid) IS a weapon's grade (AGENTS.md §3) — a
// bare model sid is ambiguous, since 14 of this install's 24 model sids
// appear under two different companies. Catun No.3 (rank 40) is the row named
// in the task: `1057-gamedata.base` (Catun Scrapmaster) x
// `1060-gamedata.base`, deliberately NOT `PLAYER_WEAPONS|1060-gamedata.base`
// ("Homemade"), the player-crafted variant of the same model.
const CATUN_NO_3_GRADE_ID = '1057-gamedata.base|1060-gamedata.base';

// Specialist on the named armour-tier ladder — see public/modules/grades.mjs's
// DEFAULT_ARMOUR_LEVEL. Re-declared here (backend is CommonJS, that module is
// an ES module the browser loads) rather than imported; the two must be kept
// in sync by eye, which is why both comments cross-reference each other.
const PROVISION_ARMOUR_LEVEL = 80;

// ------------------------------------------------------------ consumables --

// Re-exported from loadouts.js's own I table rather than re-declared, per the
// task's explicit instruction not to duplicate the whole table. Only the sids
// this file actually reaches for are named below.
const { I } = loadouts;

const MEDICAL_KIT = { standard: I.aidStandard, robotics: I.roboticsKit };
// A couple of food items to round out a kit — picked from the existing I
// table, not invented sids.
const FOOD_ITEMS = [I.foodcube, I.rationPack, I.food, I.bread];
const CATS_TEMPLATE = I.cats;

const CATS_MIN = 300;
const CATS_MAX = 5000;

// -------------------------------------------------------- loadout picking --

// A tier's target power level, on the same 0-100 scale a loadout's own item
// `level`s and grade ranks use (services/loadouts.js's GRADE ladder, and
// services/recruits.js's TIERS). Used only to break a tie between several
// loadouts that otherwise match an archetype/sub — "which of these three
// katana kits fits a green recruit" — never to invent a new one.
const TIER_TARGET_LEVEL = { green: 20, capable: 40, veteran: 60, legend: 85 };

/**
 * A loadout's own rough power level: the mean `level` across its items that
 * carry one. Used only to rank matching loadouts against a tier's target —
 * see TIER_TARGET_LEVEL.
 */
function loadoutPowerLevel(loadout) {
  const levels = loadout.items.map((it) => it.level).filter((n) => typeof n === 'number');
  if (!levels.length) return 40; // no signal either way — treat as a middling kit
  return levels.reduce((a, b) => a + b, 0) / levels.length;
}

/**
 * Which of services/loadouts.js's `category`/`tags` fields fit an
 * archetype/sub pair. Editorial, and openly so — this is the same kind of
 * judgement call services/recruits.js's `group` field already makes, just
 * applied to gear instead of a UI heading.
 *
 * Each entry returns `{ categoryAny, tagsAny }`; either half may be omitted.
 * `defaultLoadoutFor()` tries the full filter first, then relaxes to
 * `categoryAny` alone if nothing matches — a "soldier/hackers" recruit should
 * still land on SOME heavy-melee kit rather than get no gear at all just
 * because no kit happens to be tagged `hackers` specifically.
 */
const ARCHETYPE_LOADOUT_HINTS = {
  soldier: (sub) => ({
    categoryAny: ['heavy-melee', 'light-melee', 'faction', 'unique', 'starter'],
    tagsAny: sub ? [sub] : undefined,
  }),
  marksman: () => ({ categoryAny: ['ranged'] }),
  shadow: () => ({ categoryAny: ['stealth'] }),
  medic: () => ({ categoryAny: ['support'] }),
  craftsman: () => ({ categoryAny: ['support', 'trade'] }),
  support: (sub) => (sub === 'survivalist'
    ? { categoryAny: ['travel', 'trade'] }
    : { categoryAny: ['trade', 'starter', 'travel'] }),
};

/**
 * Resolve a default loadout id for a recruit shape, or null when nothing in
 * the catalogue is even a plausible fit (e.g. an archetype this file has no
 * hint for at all).
 *
 * Resolution order:
 *   1. A services/recruits.js entry naming this exact (archetype, sub) with a
 *      `loadoutId` of its own ALWAYS wins — 56+ of that catalogue's entries
 *      carry one, because it IS that character's own gear (read off gamedata,
 *      not guessed), and a tier match is preferred but not required.
 *   2. Otherwise, match services/loadouts.js's `category`/`tags` against the
 *      archetype/sub via ARCHETYPE_LOADOUT_HINTS, then pick among the matches
 *      whose average item `level` is closest to the tier's target.
 *   3. null if nothing matches at all — the caller provisions with no
 *      loadout (still gets the consumables/cats layer).
 */
function defaultLoadoutFor({ archetype, sub, tier } = {}) {
  const recruitHit = recruits.RECRUITS.find((r) => r.archetype === archetype && r.sub === sub
    && r.loadoutId && r.tier === tier)
    || recruits.RECRUITS.find((r) => r.archetype === archetype && r.sub === sub && r.loadoutId);
  if (recruitHit) return recruitHit.loadoutId;

  const hintFn = ARCHETYPE_LOADOUT_HINTS[archetype];
  if (!hintFn) return null;
  const hint = hintFn(sub) || {};

  const matches = (requireTags) => loadouts.LOADOUTS.filter((l) => {
    if (hint.categoryAny && !hint.categoryAny.includes(l.category)) return false;
    if (requireTags && hint.tagsAny && !hint.tagsAny.some((t) => (l.tags || []).includes(t))) return false;
    return true;
  });

  let candidates = matches(true);
  if (!candidates.length) candidates = matches(false); // relax the tag filter, keep the category
  if (!candidates.length) return null;

  const target = TIER_TARGET_LEVEL[tier] ?? 40;
  candidates = [...candidates].sort((a, b) => Math.abs(loadoutPowerLevel(a) - target)
    - Math.abs(loadoutPowerLevel(b) - target));
  return candidates[0].id;
}

// ------------------------------------------------------------------ merge --

/**
 * Add `item` to `list`, keyed by `templateSid` — the "do not double up" rule.
 * If the template is already present: `replace` overwrites the existing
 * entry's `level`/`quantity`/`gradeId` with the new one's (the cats stack,
 * which must always land on the freshly-rolled amount); otherwise the
 * existing entry is left alone (medical kits/food — a loadout that already
 * packs a first-aid kit does not need a second one stacked on top).
 */
function mergeItem(list, item, { replace = false } = {}) {
  const hit = list.find((it) => it.templateSid === item.templateSid);
  if (!hit) { list.push({ ...item }); return; }
  if (replace) Object.assign(hit, item);
}

/**
 * Resolve the item list a new recruit should arrive with, plus the cats
 * stack and any warnings — everything `saveService.addSquadMember()` needs
 * to mint gear into the SAME in-memory parse as the character itself.
 *
 * @param {object} opts
 * @param {string} opts.archetype
 * @param {string} opts.sub
 * @param {string} [opts.tier='capable']
 * @param {string} [opts.loadoutId]  overrides defaultLoadoutFor() entirely;
 *   an id that does not resolve is a caller error (thrown), not a warning —
 *   the same discipline routes/api/saves.js already applies to `loadoutId` on
 *   the bulk-equip route.
 * @param {object[]} [opts.items]  extra items on top of the loadout, same
 *   shape as a loadout entry (`{ templateSid, section, level?, gradeId?,
 *   quantity? }`); merged in by templateSid, replacing a loadout entry of the
 *   same template.
 * @param {string} [opts.raceSid]  the new recruit's race, so the medical kit
 *   and food can be chosen correctly for a Skeleton. Resolved through
 *   services/racesService.js, never gamedata.nameOf (AGENTS.md §3).
 * @param {function} [opts.rng=Math.random]  injectable, like
 *   addSquadMember()'s own rng — the whole reason this takes one rather than
 *   calling Math.random() directly.
 * @returns {{
 *   loadoutId: string|null, loadoutLabel: string|null,
 *   items: Array<{templateSid:string, section:string, level?:number,
 *     gradeId?:string, quantity?:number}>,
 *   cats: number, warnings: string[],
 * }}
 */
function provisionFor({
  archetype, sub, tier = 'capable', loadoutId, items: extras, raceSid, rng = Math.random,
} = {}) {
  const warnings = [];

  let resolvedLoadoutId = loadoutId;
  if (resolvedLoadoutId === undefined) resolvedLoadoutId = defaultLoadoutFor({ archetype, sub, tier });

  let loadout = null;
  if (resolvedLoadoutId) {
    loadout = loadouts.find(resolvedLoadoutId);
    if (!loadout) throw new Error(`unknown loadout "${resolvedLoadoutId}"`);
  }

  const list = [];
  for (const it of loadout ? loadout.items : []) mergeItem(list, it);
  for (const it of extras || []) {
    if (!it || typeof it.templateSid !== 'string' || !it.templateSid || typeof it.section !== 'string' || !it.section) {
      throw new Error('provisionFor: every entry in "items" needs a templateSid and a section');
    }
    mergeItem(list, it, { replace: true });
  }

  // --- default grades: overriding whatever the loadout/caller items carried,
  //     for armour and melee weapons only (AGENTS.md §3: a crossbow has no
  //     manufacturer ladder, and this override is explicitly about grades). ---
  for (const it of list) {
    const tmpl = gamedata.lookup(it.templateSid);
    if (!tmpl) {
      warnings.push(`"${it.templateSid}" does not resolve to any item template in this install — it will be skipped`);
      continue;
    }
    if (tmpl.type === 3 || tmpl.type === 107) {
      // Armour (3) and crossbows (107) both express quality as `ints.level`, so
      // Specialist means the same thing on each. A crossbow is here rather than
      // in the branch below because it has **no manufacturer ladder** — it must
      // be refused a grade (AGENTS.md §3), which would otherwise leave a
      // marksman's bow sitting at whatever tier the source loadout happened to
      // pick while every piece of their armour jumped to 80.
      it.level = PROVISION_ARMOUR_LEVEL;
    } else if (tmpl.type === 2) {
      it.gradeId = CATUN_NO_3_GRADE_ID;
      delete it.level; // the grade's own rank supplies it (itemFactory.defaultLevelForGrade)
    }
  }
  const resolvable = list.filter((it) => gamedata.lookup(it.templateSid));

  // --- race-aware consumables ---
  const raceName = raceSid ? races.nameOf(raceSid, raceSid) : null;
  const isSkeleton = !!raceName && /skeleton/i.test(raceName);

  mergeItem(resolvable, {
    templateSid: isSkeleton ? MEDICAL_KIT.robotics : MEDICAL_KIT.standard,
    section: 'main',
    quantity: 2,
  });

  if (isSkeleton) {
    warnings.push(`${raceName} does not eat — no food was added to this kit`);
  } else {
    for (const sid of FOOD_ITEMS.slice(0, 2)) {
      mergeItem(resolvable, { templateSid: sid, section: 'main', quantity: 1 });
    }
  }

  // --- cats ---
  const cats = CATS_MIN + Math.floor(rng() * (CATS_MAX - CATS_MIN + 1));
  mergeItem(resolvable, { templateSid: CATS_TEMPLATE, section: 'main', quantity: cats }, { replace: true });

  return {
    loadoutId: resolvedLoadoutId || null,
    loadoutLabel: loadout ? loadout.label : null,
    items: resolvable,
    cats,
    warnings,
  };
}

module.exports = {
  I,
  CATUN_NO_3_GRADE_ID,
  PROVISION_ARMOUR_LEVEL,
  defaultLoadoutFor,
  provisionFor,
};
