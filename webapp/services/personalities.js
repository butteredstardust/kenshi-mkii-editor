'use strict';

/**
 * The `ints.personality` value on a CHAR_STATE (36) record, decoded.
 *
 * Unlike services/archetypes.js and services/recruits.js, this is **NOT
 * editorial** — it is derived from the game's own data and cross-checked, and
 * the mapping should only change if that evidence turns out to be wrong.
 *
 * === HOW IT WAS DERIVED ===
 *
 * A character's personality is stored in the save as a single small integer.
 * Gamedata carries 31 type-26 "personality" records, each holding four integer
 * lists — `tags always<n>`, `tags common<n>`, `tags never<n>`, `tags rare<n>`.
 * Those lists draw on the same vocabulary as the save's int, and several of the
 * records describe exactly ONE trait, which pins the value:
 *
 *     record "Honorable"       always = [1]
 *     record "Traitorous"      always = [2]
 *     record "Smart Doc Type"  always = [5]     and "Not smart"  never = [5]
 *     record "Dumb"            always = [6]
 *     record "Brave"           always = [9]     and "Ronin Rebel/Brave" too
 *     record "Fearful"         always = [10]    and "Not fearful" never = [10]
 *     record "Crazy"           always = [14]
 *
 * Four independent cross-checks, all exact:
 *
 *     "dumb honorable brave"                     always = [6, 1, 9]
 *     "Ninja Neutral - brave, hon, crazy, trait" common = [1, 9, 14, 2]
 *     "Traitorous brave crazy"                   common = [2, 9, 14]
 *     "Not honourable"                           common = [2,5,6,9,10,14]  (all seven but 1)
 *
 * And the decisive one: the record literally named **"Random"** lists
 * `common = [1, 2, 5, 6, 9, 10, 14]` — exactly, and only, the seven values that
 * occur across all 555 characters in a live save. So these seven are the
 * complete working set, which independently confirms the FCS guide's warning
 * that other values are unimplemented: 7, 11 and 12 appear only inside the
 * "bandit types" record and never on a real character.
 */

// int -> { label, note }. Ordered as the UI should list them.
const PERSONALITIES = [
  { value: 9, label: 'Brave', note: 'Stands and fights.' },
  { value: 10, label: 'Fearful', note: 'Runs early and often.' },
  { value: 1, label: 'Honorable', note: 'Will not kick someone who is down.' },
  { value: 2, label: 'Traitorous', note: 'Will turn on allies.' },
  { value: 5, label: 'Smart', note: 'The doctor/scientist temperament.' },
  { value: 6, label: 'Dumb', note: 'The opposite of Smart.' },
  { value: 14, label: 'Crazy', note: 'Unpredictable; never also Fearful.' },
];

const BY_VALUE = new Map(PERSONALITIES.map((p) => [p.value, p]));

/**
 * Values the game itself ever writes. Anything else is accepted by the editor
 * only with an explicit override, because the guide warns unimplemented
 * personalities do nothing and this save's 555 characters use no others.
 */
const KNOWN_VALUES = PERSONALITIES.map((p) => p.value);

function label(value) {
  const hit = BY_VALUE.get(value);
  return hit ? hit.label : (value == null ? 'none' : `unknown (${value})`);
}

function isKnown(value) { return BY_VALUE.has(value); }

function catalogue() {
  return PERSONALITIES.map((p) => ({ ...p }));
}

module.exports = { PERSONALITIES, KNOWN_VALUES, label, isKnown, catalogue };
