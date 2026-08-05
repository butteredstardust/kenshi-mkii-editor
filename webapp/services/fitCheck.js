'use strict';

const gamedata = require('./gamedataService');
const races = require('./racesService');

/**
 * "Will this item actually suit this character?" — advisory only.
 *
 * Nothing here ever blocks a write. Bulk equip applies every item to every
 * selected character by design; this exists so the receipt can say which of
 * those the editor thinks were a bad idea. Hard incompatibility — an item kind
 * that cannot occupy the requested `section` at all — is a different question,
 * is a real refusal, and lives in services/itemSlots.js.
 *
 * Two signals, and they are not equal:
 *
 *  1. DERIVED (trustworthy). A type-3 armour template carries an
 *     `extra['part coverage']` category naming the body parts it covers, by
 *     body-part stringID — an Ancient Samurai Helmet covers `32-gamedata.quack`
 *     (Head), its boots cover `30`/`31-gamedata.quack` (the feet). A character's
 *     MEDICAL (57) record lists the parts it actually has as `sid<n>`. An item
 *     covering a part the character does not have is provably a poor fit, with
 *     no editorial judgement involved. Cached as `partCoverage` on the gamedata
 *     index (gamedataService.js, CACHE_VERSION 5).
 *
 *  2. DERIVED (trustworthy, and the answer to "which races can wear this").
 *     `extra['races']` / `extra['races exclude']` on the armour template ARE
 *     Kenshi's racial armour restrictions — see gamedataService.raceRules().
 *     A whitelist means only those races may wear it (the Hiver shirts); a
 *     blacklist names the races that may not (every ordinary shirt excludes all
 *     nine Hive races; Masked/Visored/Spiked helmets exclude Shek and Hive
 *     Workers). Mod-aware, per item, and it reproduces the wiki's restriction
 *     lists exactly.
 *
 *  3. EDITORIAL (a hint). Two kinds, both labelled as opinion:
 *     - a loadout's `raceNotes` ("boots and helmet are a poor fit on this
 *       race", "animal"), copied out of the scripts this feature replaced;
 *     - RACE_SLOT_RULES below, the wiki's per-race "slot disabled" table
 *       (a Skeleton has no shirt, head or footwear slot; nothing but a human or
 *       a Shek wears boots). Nothing in a type-7 race record expresses that, so
 *       unlike (2) it is not derived from the game's data.
 *
 * NOTHING HERE BLOCKS A WRITE, including (2). Kenshi enforces these rules in
 * its own UI; a save file will happily hold a Wool Hat on a Skeleton, and this
 * editor exists to write things the game's UI will not offer. The user is told
 * what the game thinks and then decides. See AGENTS.md §3 "Race compatibility
 * is advisory, never enforced".
 *
 * What this deliberately does NOT claim: that a warning-free item WILL work.
 * A template carrying no race rows restricts nothing *that the data states* —
 * absence of a rule is absence of evidence, not proof of a good fit.
 */

/**
 * The wiki's per-race armour SLOT table (Races → Racial Armour Restrictions),
 * as the set of slots each race family has at all. EDITORIAL: unlike the
 * per-item rules above this is not in any field of a type-7 race record.
 *
 * Measured against this machine's own saves before being encoded, and the
 * measurement is why it warns rather than refuses: across 3923 characters, Hive
 * Soldier Drones wore a head item 0 times and boots 0 times, Hive Workers and
 * Princes boots 0 times — all matching — but Skeletons showed 17 head, 14 shirt
 * and 17 boots against a table that says all three are disabled. Every one of
 * those characters was in a player `.platoon` file, i.e. gear a player (quite
 * possibly using this editor) put there, so the sample cannot falsify the
 * table — and equally cannot confirm it. Hence: a hint, clearly sourced.
 */
const ALL_ARMOUR_SLOTS = ['head', 'shirt', 'armour', 'legs', 'boots'];
const RACE_SLOT_RULES = [
  {
    family: 'skeleton',
    label: 'Skeletons',
    // Skeleton, P4 Unit, Soldierbot, Screamer, the MKII variants — every
    // machine race the catalogue names.
    match: /skeleton|p4 unit|soldierbot|screamer|log-head|no-head/i,
    slots: ['armour', 'legs'],
  },
  {
    family: 'hive-soldier',
    label: 'Hive Soldier Drones',
    match: /hive soldier|deadhive soldier/i,
    slots: ['shirt', 'armour', 'legs'],
  },
  {
    family: 'hive-worker',
    label: 'Hive Worker Drones',
    match: /hive worker|deadhive worker/i,
    slots: ['head', 'shirt', 'armour', 'legs'],
  },
  {
    family: 'hive-prince',
    label: 'Hive Princes',
    match: /hive prince|deadhive prince|hive queen|hive tall head/i,
    slots: ['head', 'shirt', 'armour', 'legs'],
  },
];

/** Which RACE_SLOT_RULES row a race name falls under, or null for everyone else. */
function raceSlotRule(raceName) {
  if (!raceName) return null;
  return RACE_SLOT_RULES.find((r) => r.match.test(raceName)) || null;
}

/**
 * Does the game's own data forbid `raceSid` from wearing `templateSid`?
 *
 * @returns {{ blocked: boolean, reason: 'only'|'exclude'|null, only: string[], exclude: string[] }}
 *   `only`/`exclude` are race NAMES, resolved through racesService (load order
 *   — a race's name is one of the few things gamedata.nameOf gets wrong).
 */
function raceRuleCheck(templateSid, raceSid) {
  const rules = gamedata.raceRules(templateSid);
  const empty = { blocked: false, reason: null, only: [], exclude: [] };
  if (!rules) return empty;

  const name = (s) => races.nameOf(s, s);
  const out = {
    blocked: false,
    reason: null,
    only: rules.only.map(name),
    exclude: rules.exclude.map(name),
  };
  // No race to check against (an unresolvable APPEARANCE row) — report the
  // rule, claim nothing about this character.
  if (!raceSid) return out;

  if (rules.exclude.includes(raceSid)) { out.blocked = true; out.reason = 'exclude'; }
  else if (rules.only.length && !rules.only.includes(raceSid)) { out.blocked = true; out.reason = 'only'; }
  return out;
}

/**
 * Every reason this (item, slot, race) combination looks wrong, worst first.
 * Advisory — see the file header. `section` may be omitted when the caller only
 * cares about the per-item rule.
 *
 * @returns {{ source: 'derived'|'editorial', text: string }[]}
 */
function raceWarnings({ templateSid, itemName, section, raceSid, raceName }) {
  const out = [];
  const label = itemName || gamedata.nameOf(templateSid, templateSid);
  const who = raceName || 'this character';

  const rule = raceRuleCheck(templateSid, raceSid);
  if (rule.blocked) {
    // A whitelist can name all nine Hive races; spelling every one of them into
    // a receipt line buries the sentence that matters.
    const named = rule.only.slice(0, 3).join(', ')
      + (rule.only.length > 3 ? ` and ${rule.only.length - 3} more` : '');
    out.push({
      source: 'derived',
      text: rule.reason === 'only'
        ? `${label} can only be worn by ${named} — ${who} is not one`
        : `${label} cannot be worn by ${who}: the game's data excludes that race`,
    });
  }

  const slotRule = raceSlotRule(raceName);
  if (slotRule && section && ALL_ARMOUR_SLOTS.includes(section) && !slotRule.slots.includes(section)) {
    out.push({
      source: 'editorial',
      text: `${slotRule.label} have no ${section} slot in game, so ${label} will not be worn (wiki)`,
    });
  }

  return out;
}

/** The body-part stringIDs a character actually has, off its MEDICAL record. */
function bodyPartSids(medicalRec, bodySlots = 7) {
  const out = new Set();
  if (!medicalRec) return out;
  for (let i = 0; i < bodySlots; i++) {
    const sid = medicalRec.strings.get(`sid${i}`);
    if (sid) out.add(sid);
  }
  return out;
}

/**
 * @param {string} templateSid
 * @param {Set<string>} partSids  from bodyPartSids()
 * @returns {string[]} names of covered parts this character does not have
 */
function uncoveredParts(templateSid, partSids) {
  const tmpl = gamedata.lookup(templateSid);
  const coverage = tmpl && tmpl.partCoverage;
  // No coverage rows (weapons, trade goods, backpacks, or an unresolvable
  // template) means nothing to check — never a warning by itself.
  if (!coverage || !coverage.length || !partSids.size) return [];
  return coverage
    .filter((p) => !partSids.has(p))
    .map((p) => gamedata.nameOf(p, p));
}

/**
 * Warnings for one (character, item) pair.
 *
 * @param {object} ctx
 * @param {string} ctx.templateSid
 * @param {string} ctx.itemName
 * @param {Set<string>} ctx.partSids   the character's own body-part sids
 * @param {string|null} ctx.raceSid    the character's race stringID
 * @param {string|null} ctx.raceName   the character's race display name
 * @param {string} [ctx.section]       the slot the item is going into
 * @param {Array<{races: string[], note: string}>} [ctx.raceNotes]  loadout hints
 * @returns {{ source: 'derived'|'editorial', text: string }[]}
 */
function warningsFor({ templateSid, itemName, partSids, raceSid, raceName, section, raceNotes = [] }) {
  const out = [];

  // The game's own racial restrictions first: they are the most specific thing
  // known about this exact pairing, and the reason a user reaches for a warning.
  out.push(...raceWarnings({ templateSid, itemName, section, raceSid, raceName }));

  const missing = uncoveredParts(templateSid, partSids);
  if (missing.length) {
    out.push({
      source: 'derived',
      text: `${itemName} covers ${missing.join(' and ')}, which this character does not have`,
    });
  }

  if (raceName) {
    for (const note of raceNotes) {
      if ((note.races || []).some((r) => raceName.toLowerCase().includes(r.toLowerCase()))) {
        out.push({ source: 'editorial', text: `${raceName}: ${note.note}` });
      }
    }
  }

  return out;
}

module.exports = {
  bodyPartSids, uncoveredParts, warningsFor,
  raceRuleCheck, raceWarnings, raceSlotRule, RACE_SLOT_RULES, ALL_ARMOUR_SLOTS,
};
