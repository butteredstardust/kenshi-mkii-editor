'use strict';

const gamedata = require('./gamedataService');

/**
 * Blueprints: the shop item that teaches something, and what it teaches.
 *
 * ===========================================================================
 * A BLUEPRINT IS AN ITEM. THE THING IT TEACHES IS NOT.
 * ===========================================================================
 * This editor used to refuse blueprints twice over, and both refusals were
 * wrong in the same way — they confused the blueprint with its subject:
 *
 *  - A vendor row under `blueprints` points at a **type-21 research tech**, and
 *    the Vendors page dimmed it as "research tech, not a carryable item".
 *  - A vendor row under `armour blueprints` points at a **type-3 armour**, and
 *    the page offered to add the armour itself — which is not what that shelf
 *    sells.
 *
 * In game a blueprint is bought like anything else, sits in the inventory, and
 * disappears when clicked. It is a real item, and it is not the tech and not
 * the armour. It is a **separate type-4 template** whose two grade-shaped
 * string fields carry the research-ledger entry it grants.
 *
 * ===========================================================================
 * THE EVIDENCE
 * ===========================================================================
 * Swept every type-42 ITEM record reachable on this machine — 46119 of them
 * across 1662 files (the install's `data/`, its level and zone files, and every
 * save). Zero are backed by a type-21 template, which is why a save-only sweep
 * concluded blueprints were not items; the same mistake maps made (AGENTS.md
 * §3). But 876 carry `ints['item function'] === 11`, the FCS "_Research"
 * function, and every one of them is a blueprint:
 *
 *   876/876   `material sid` === `company sid`
 *   865/876   that pair is a research-ledger entry; 11 are blank
 *
 * Broken down by what the entry names — the identical three-shape vocabulary
 * `researchService` already documents for the ledger's `finished<N>` keys:
 *
 *   608  "<type-3 armour sid>.TECH.1"    e.g. 2210-gamedata.base.TECH.1
 *   238  "<type-21 tech sid>"  (bare)    e.g. 2263-gamedata.base
 *    19  "<type-107 crossbow sid>.TECH.1"
 *
 * That closes a loop AGENTS.md left open: a `.TECH.N` ledger row is "an
 * unlocked item blueprint", and this is the object that writes one.
 *
 * The four blueprint templates in this install, all type 4 / item function 11 /
 * `stackable`, `level` 0, `quality` 1, weight 0:
 *
 *   BLUEPRINT_ITEM         "Blueprints"          gamedata.base — used for all three shapes
 *   BLUEPRINT_ITEM_ARMOUR  "Blueprints (armour)" rebirth.mod   — type-3 subjects only
 *   BLUEPRINT_ITEM_GEAR    "Blueprints (gear)"   rebirth.mod   — type-107 subjects only
 *   2223-gamedata.base     "Blueprints large"    gamedata.base — never observed in use
 *
 * BLUEPRINT_ITEM is the one that appears against every subject kind, so it is
 * the fallback whenever a themed variant is missing (it lives in gamedata.base;
 * the other two come from a mod and may not be installed).
 *
 * ===========================================================================
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ===========================================================================
 * It does not write the research ledger. Adding a blueprint to an inventory
 * gives the player the object; clicking it in game is what marks the entry
 * finished. Doing both would be inventing a rule — and the ledger already has
 * its own honest editor in `researchService.unlock()`.
 */

// FCS item function for the "_Research" category. Every blueprint item carries
// it, and nothing else in this install's type-4 templates does.
const RESEARCH_ITEM_FUNCTION = 11;

// A `.TECH.N` ledger entry's N. Every one of the 627 live blueprint items that
// carries a suffixed entry uses 1 — no blueprint item was ever observed
// granting level 2 of anything, and repeat levels are a tech-ledger concept
// (`<sid>.4`), a different suffix shape entirely.
const BLUEPRINT_LEVEL = 1;

const RESEARCH_TECH = 21;

// Preferred blueprint template per subject typecode, most specific first. The
// preference is cosmetic — the templates differ only by icon colour and
// inventory footprint — but it is what the game's own data does, so a blueprint
// this editor adds looks like one the player bought.
const PREFERRED_TEMPLATE = new Map([
  [3, ['BLUEPRINT_ITEM_ARMOUR', 'BLUEPRINT_ITEM']],
  [107, ['BLUEPRINT_ITEM_GEAR', 'BLUEPRINT_ITEM']],
  [RESEARCH_TECH, ['BLUEPRINT_ITEM']],
]);

let templateCache = null;

/**
 * Every blueprint item template this install defines, in the order a fallback
 * should consider them (the two `gamedata.base` ones first, so a missing mod
 * never leaves this with nothing).
 */
function templates() {
  if (templateCache) return templateCache;
  templateCache = gamedata.itemTemplates()
    .filter((t) => t.type === 4 && t.itemFunction === RESEARCH_ITEM_FUNCTION)
    .map((t) => ({ sid: t.sid, name: t.name }))
    .sort((a, b) => a.sid.localeCompare(b.sid));
  return templateCache;
}

/** True if `sid` names one of this install's blueprint item templates. */
function isBlueprintTemplate(sid) {
  return templates().some((t) => t.sid === sid);
}

function pickTemplate(subjectType) {
  const all = templates();
  if (!all.length) return null;
  for (const sid of PREFERRED_TEMPLATE.get(subjectType) || ['BLUEPRINT_ITEM']) {
    const hit = all.find((t) => t.sid === sid);
    if (hit) return hit;
  }
  return all[0];
}

/**
 * The research-ledger entry a blueprint for `subjectSid` grants.
 *
 * Two shapes, both measured (see the header): a research tech is named bare,
 * anything else is named with a `.TECH.1` suffix. The suffixed form was
 * observed only for type-3 (armour) and type-107 (crossbow) subjects — the two
 * kinds this install's vendors actually sell blueprints for — but the suffix is
 * plainly "a blueprint for this item template" rather than anything armour- or
 * crossbow-specific, so every item typecode is accepted under it.
 */
function entryFor(subjectSid, subjectType) {
  if (subjectType === RESEARCH_TECH) return subjectSid;
  return `${subjectSid}.TECH.${BLUEPRINT_LEVEL}`;
}

/**
 * Everything needed to mint a blueprint for `subjectSid`, or null if that sid
 * is not something a blueprint can name.
 *
 * @returns {{ subjectSid, subjectName, subjectType, teaches, templateSid,
 *   templateName, kind: 'tech'|'item' }|null}
 */
function forSubject(subjectSid) {
  const subject = gamedata.lookup(subjectSid);
  if (!subject) return null;
  const isTech = subject.type === RESEARCH_TECH;
  if (!isTech && !gamedata.ITEM_TEMPLATE_TYPES.has(subject.type)) return null;
  const tmpl = pickTemplate(subject.type);
  if (!tmpl) return null;
  return {
    subjectSid,
    subjectName: subject.name,
    subjectType: subject.type,
    teaches: entryFor(subjectSid, subject.type),
    templateSid: tmpl.sid,
    templateName: tmpl.name,
    kind: isTech ? 'tech' : 'item',
  };
}

/**
 * Validate a caller-supplied `teaches` string.
 *
 * Deliberately strict about the *shape* and permissive about the subject: the
 * ledger is a flat list of strings the game writes and reads, and a mod can
 * name a record this index does not resolve. So an unresolvable subject is
 * reported as a warning, not a refusal — the same posture race fit takes
 * (AGENTS.md §3) — but a string that is not one of the two shapes is refused
 * outright, since writing a malformed entry teaches nothing and cannot be
 * noticed in game.
 */
function describeEntry(teaches) {
  if (typeof teaches !== 'string' || !teaches.trim()) {
    throw new Error('teaches must be a non-empty research-ledger entry string');
  }
  if (/[\x00-\x1f]/.test(teaches)) throw new Error('teaches must not contain control characters');
  const m = /^(.*)\.TECH\.(\d+)$/.exec(teaches);
  const subjectSid = m ? m[1] : teaches;
  const subject = gamedata.lookup(subjectSid);
  if (!m && (!subject || subject.type !== RESEARCH_TECH)) {
    throw new Error(
      `"${teaches}" is not a usable blueprint entry — an unsuffixed entry must name a `
      + `research tech (typecode ${RESEARCH_TECH}); an item blueprint is written "<templateSid>.TECH.1"`,
    );
  }
  return {
    teaches,
    subjectSid,
    subjectName: subject ? subject.name : null,
    subjectType: subject ? subject.type : null,
    kind: m ? 'item' : 'tech',
    resolved: !!subject,
  };
}

module.exports = {
  RESEARCH_ITEM_FUNCTION, RESEARCH_TECH, BLUEPRINT_LEVEL,
  templates, isBlueprintTemplate, forSubject, entryFor, describeEntry,
};
