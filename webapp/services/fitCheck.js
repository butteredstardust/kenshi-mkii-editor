'use strict';

const gamedata = require('./gamedataService');

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
 *  2. EDITORIAL (a hint). A loadout may carry `raceNotes` — "boots and helmet
 *     are a poor fit on this race", "animal". That is a human's opinion copied
 *     out of the scripts this feature replaced, and it is labelled as such.
 *
 * What this deliberately does NOT claim: that a warning-free item WILL work.
 * Kenshi's real race/mesh restrictions are not in any field this editor has
 * identified (see TODO.md 1.5), so absence of a warning is absence of evidence.
 */

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
 * @param {string|null} ctx.raceName   the character's race display name
 * @param {Array<{races: string[], note: string}>} [ctx.raceNotes]  loadout hints
 * @returns {{ source: 'derived'|'editorial', text: string }[]}
 */
function warningsFor({ templateSid, itemName, partSids, raceName, raceNotes = [] }) {
  const out = [];

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

module.exports = { bodyPartSids, uncoveredParts, warningsFor };
