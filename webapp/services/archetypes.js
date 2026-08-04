'use strict';

/**
 * "Train as archetype" catalogue: a gameplay convenience for saveService.trainCharacter().
 *
 * IMPORTANT: unlike the field names elsewhere in services/, this mapping is
 * NOT derived from game data. It is this editor's own editorial judgement
 * about which skills belong to which playstyle, so it is safe to tweak,
 * rename or re-balance without re-deriving anything from a save. The only
 * hard constraint is that every skill key listed here must be one of the
 * real on-disk float keys documented in docs/save-format.md /
 * saveService.js (see the STATS record comment) — trainCharacter() still
 * defends against unknown keys itself (skips anything absent from a given
 * character's own record, e.g. a non-human), but this file should never
 * invent a key that doesn't exist on a live save to begin with.
 *
 * Shape: { id, label, skills: [...], subs: [{ id, label, skills: [...] }] }
 * "skills" on the main entry are shared across every sub-archetype; the
 * effective archetype-skill set for training is the union of main.skills and
 * the chosen sub.skills (duplicates are harmless — it's a Set at use time).
 */

const ARCHETYPES = [
  {
    id: 'soldier',
    label: 'Soldier',
    skills: ['attack', 'defence', 'dodge', 'mass combat', 'warrior spirit', 'endurance', 'athletics'],
    subs: [
      { id: 'katanas', label: 'Katanas', skills: ['katana'] },
      { id: 'sabres', label: 'Sabres', skills: ['sabres'] },
      { id: 'blunt', label: 'Blunt', skills: ['blunt'] },
      { id: 'polearms', label: 'Polearms', skills: ['poles'] },
      { id: 'heavy-weapons', label: 'Heavy weapons', skills: ['heavy weapons'] },
      { id: 'unarmed', label: 'Unarmed / martial arts', skills: ['unarmed'] },
    ],
  },
  {
    id: 'marksman',
    label: 'Marksman',
    // "perception-ish" per the brief means the attribute (perception, already
    // always set to 45 by trainCharacter) — the closest ranged SKILL fit is
    // arrow defence (avoiding incoming fire) alongside the weapon skill itself.
    skills: ['bow', 'arrow defence', 'athletics', 'dodge'],
    subs: [
      { id: 'crossbows', label: 'Crossbows', skills: ['bow'] },
      { id: 'turrets', label: 'Turrets', skills: ['turrets'] },
    ],
  },
  {
    id: 'shadow',
    label: 'Shadow',
    skills: ['stealth', 'athletics', 'dodge', 'climbing', 'tracking', 'bluff', 'swimming'],
    subs: [
      { id: 'assassin', label: 'Assassin', skills: ['assassin', 'stealth'] },
      { id: 'burglar', label: 'Burglar', skills: ['thievery', 'lockpicking'] },
    ],
  },
  {
    id: 'craftsman',
    label: 'Craftsman',
    skills: ['engineer', 'labouring', 'science'],
    subs: [
      { id: 'armour-smith', label: 'Armour smith', skills: ['armour smith'] },
      { id: 'weapon-smith', label: 'Weapon smith', skills: ['weapon smith'] },
      { id: 'bow-smith', label: 'Bow smith', skills: ['bow smith'] },
      { id: 'robotics', label: 'Robotics', skills: ['robotics'] },
    ],
  },
  {
    id: 'medic',
    label: 'Medic / Scientist',
    skills: ['science', 'ff'],
    subs: [
      { id: 'field-medic', label: 'Field medic', skills: ['medic', 'ff'] },
      { id: 'doctor', label: 'Doctor', skills: ['doctor', 'medic'] },
      { id: 'researcher', label: 'Researcher', skills: ['hackers', 'science'] },
    ],
  },
  {
    id: 'support',
    label: 'Support',
    // Catch-all for the skills the other mains don't touch: farming, cooking,
    // survival. Not a combat/craft archetype at all — a base-running/travel
    // convenience, kept as its own main so those three keys have a home.
    skills: ['labouring'],
    subs: [
      { id: 'farmer', label: 'Farmer', skills: ['farming'] },
      { id: 'cook', label: 'Cook', skills: ['cooking'] },
      { id: 'survivalist', label: 'Survivalist', skills: ['survival', 'tracking'] },
    ],
  },
];

function findMain(archetypeId) {
  return ARCHETYPES.find((a) => a.id === archetypeId) || null;
}

function findSub(main, subId) {
  return main ? main.subs.find((s) => s.id === subId) || null : null;
}

/** Resolve (archetypeId, subId) to a deduped array of archetype skill keys, or throw. */
function resolveSkills(archetypeId, subId) {
  const main = findMain(archetypeId);
  if (!main) throw new Error(`unknown archetype "${archetypeId}"`);
  const sub = findSub(main, subId);
  if (!sub) throw new Error(`unknown sub-archetype "${subId}" for archetype "${archetypeId}"`);
  return { main, sub, skills: [...new Set([...main.skills, ...sub.skills])] };
}

/** Catalogue for the UI: id/label tree only, no skill lists needed client-side. */
function catalogue() {
  return ARCHETYPES.map((a) => ({
    id: a.id,
    label: a.label,
    subs: a.subs.map((s) => ({ id: s.id, label: s.label })),
  }));
}

module.exports = { ARCHETYPES, findMain, findSub, resolveSkills, catalogue };
