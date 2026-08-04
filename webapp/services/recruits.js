'use strict';

const archetypes = require('./archetypes');
const locations = require('./locationsService');

/**
 * "Roll a recruit": a catalogue of ready-made squad members in the spirit of
 * the wiki's Unique Recruits page (https://kenshi.fandom.com/wiki/Unique_Recruits).
 *
 * IMPORTANT, same caveat as services/archetypes.js: **none of this is derived
 * from game data.** It is this editor's own editorial list — a name, a race
 * preference, a specialisation and a power tier — written so that "surprise me"
 * produces a character with a coherent identity instead of a bag of random
 * numbers. Nothing here is claimed to reproduce a real unique recruit's canon
 * stats, and no wiki data is read at runtime; changing, re-balancing or
 * deleting an entry breaks nothing.
 *
 * Two hard constraints:
 *   - `archetype`/`sub` must name a real pair in services/archetypes.js
 *     (validated by `validate()` below, which the tests call).
 *   - `race` is a PREFERENCE, expressed as a substring matched case-
 *     insensitively against the race names actually present in the save being
 *     edited. A save that has no Shek in it simply falls back to whatever race
 *     the caller selected — the roll never fails because of a missing race, and
 *     it never invents a race that isn't in the save (see
 *     saveService.availableRaces()).
 *
 * Power tiers set the stat spread that saveService.addSquadMember() writes.
 * They deliberately span "raw" to "already a legend", because that spread is
 * what makes the wiki's list interesting — Beep is not Tinfist.
 *
 * `where` lists the towns the wiki's "possible locations" put that recruit in.
 * Like `race`, it is a HINT, resolved at request time against the towns this
 * install actually has (services/locationsService.js) — a heavily modded world
 * renames and moves towns, and several vanilla names (Squin, Mourn, Stoat) do
 * not exist as placed towns here at all. A name that doesn't resolve is
 * reported as unresolved rather than dropped or guessed at, and it never stops
 * the recruit being usable: `where` decides where the "take me there" teleport
 * would go, nothing more.
 */

const TIERS = {
  green: { label: 'Green', attribute: 20, archRange: [20, 45], otherRange: [5, 20] },
  capable: { label: 'Capable', attribute: 35, archRange: [35, 65], otherRange: [10, 30] },
  veteran: { label: 'Veteran', attribute: 50, archRange: [55, 80], otherRange: [15, 40] },
  legend: { label: 'Legend', attribute: 70, archRange: [75, 95], otherRange: [25, 50] },
};

const RECRUITS = [
  { id: 'ruka', name: 'Ruka', race: 'shek', archetype: 'soldier', sub: 'unarmed', tier: 'veteran',
    blurb: 'Shek brawler who settles arguments with her hands.',
    where: ["Squin", "Shark", "The Hub"] },
  { id: 'sanda', name: 'Sanda', race: 'shek', archetype: 'soldier', sub: 'heavy-weapons', tier: 'veteran',
    blurb: 'Swings something far too large for the room.',
    where: ["Admag", "Squin"] },
  { id: 'hamut', name: 'Hamut', race: 'shek', archetype: 'soldier', sub: 'blunt', tier: 'capable',
    blurb: 'Bar-fight veteran, more scar tissue than sense.',
    where: ["Squin", "Admag"] },
  { id: 'seto', name: 'Seto', race: 'human', archetype: 'soldier', sub: 'katanas', tier: 'veteran',
    blurb: 'Disgraced noble, immaculate footwork.',
    where: ["Blister Hill", "Stack", "Bad Teeth"] },
  { id: 'green', name: 'Green', race: 'human', archetype: 'soldier', sub: 'sabres', tier: 'capable',
    blurb: 'Drifter with a sabre and no fixed address.',
    where: ["The Hub", "Squin"] },
  { id: 'izumi', name: 'Izumi', race: 'human', archetype: 'marksman', sub: 'crossbows', tier: 'veteran',
    blurb: 'Puts a bolt through things at an unkind distance.',
    where: ["Heft", "Stoat", "Sho-Battai"] },
  { id: 'miu', name: 'Miu', race: 'human', archetype: 'shadow', sub: 'burglar', tier: 'capable',
    blurb: 'Locks are a formality.',
    where: ["The Hub", "Squin", "Waystation"] },
  { id: 'shryke', name: 'Shryke', race: 'human', archetype: 'shadow', sub: 'assassin', tier: 'veteran',
    blurb: 'Quiet, patient, and behind you.',
    where: ["Mongrel", "Black Desert City"] },
  { id: 'crumblejon', name: 'Crumblejon', race: 'human', archetype: 'soldier', sub: 'blunt', tier: 'green',
    blurb: 'Hungry bandit with big plans and small skills.',
    where: ["The Hub", "Squin", "Waystation"] },
  { id: 'hobbs', name: 'Hobbs', race: 'human', archetype: 'soldier', sub: 'polearms', tier: 'green',
    blurb: 'Willing. That is the whole pitch.',
    where: ["The Hub", "Squin"] },
  { id: 'bo', name: 'Bo', race: 'human', archetype: 'craftsman', sub: 'weapon-smith', tier: 'capable',
    blurb: 'Would rather be at a forge than in a fight.',
    where: ["The Hub", "Bad Teeth", "Squin"] },
  { id: 'ells', name: 'Ells', race: 'human', archetype: 'medic', sub: 'field-medic', tier: 'capable',
    blurb: 'Carries more bandages than food.',
    where: ["The Hub", "Waystation", "Squin"] },
  { id: 'savant', name: 'Savant', race: 'skeleton', archetype: 'medic', sub: 'researcher', tier: 'veteran',
    blurb: 'Ancient, curious, and unsettlingly well-read.',
    where: ["Black Desert City", "Mongrel", "World's End"] },
  { id: 'agnu', name: 'Agnu', race: 'skeleton', archetype: 'soldier', sub: 'heavy-weapons', tier: 'legend',
    blurb: 'Something the Deadlands did not finish rusting.',
    where: ["Black Desert City", "Mongrel"] },
  { id: 'tinfist', name: 'Tinfist', race: 'skeleton', archetype: 'soldier', sub: 'unarmed', tier: 'legend',
    blurb: 'Abolitionist. Punches above everyone else\'s weight.',
    where: ["Black Desert City", "Mongrel", "Flats Lagoon"] },
  { id: 'burn', name: 'Burn', race: 'human', archetype: 'soldier', sub: 'katanas', tier: 'legend',
    blurb: 'Runs a rebellion out of a swamp.',
    where: ["Mourn", "Black Desert City"] },
  { id: 'beep', name: 'Beep', race: 'hive', archetype: 'support', sub: 'survivalist', tier: 'green',
    blurb: 'Enthusiastic. Extremely enthusiastic.',
    where: ["The Hub", "Squin", "Waystation"] },
  { id: 'suki', name: 'Suki', race: 'hive', archetype: 'marksman', sub: 'crossbows', tier: 'capable',
    blurb: 'Drone who took to crossbows with alarming speed.',
    where: ["Flats Lagoon", "Sho-Battai", "Heft"] },
  { id: 'nadia', name: 'Nadia', race: 'human', archetype: 'support', sub: 'farmer', tier: 'green',
    blurb: 'Wants a field, some water, and to be left alone.',
    where: ["The Hub", "Bad Teeth", "Squin"] },
  { id: 'ozu', name: 'Ozu', race: 'human', archetype: 'craftsman', sub: 'robotics', tier: 'veteran',
    blurb: 'Talks to machines. They mostly answer.',
    where: ["Black Desert City", "World's End", "Flats Lagoon"] },
];

function tier(id) {
  const t = TIERS[id];
  if (!t) throw new Error(`unknown power tier "${id}"`);
  return t;
}

function find(id) {
  return RECRUITS.find((r) => r.id === id) || null;
}

/**
 * Pick one at random. `rng` is injectable so tests are deterministic — the same
 * discipline as saveService.trainCharacter().
 */
function roll(rng = Math.random) {
  return RECRUITS[Math.floor(rng() * RECRUITS.length)];
}

/**
 * Catalogue for the UI. Carries the resolved tier label and the archetype's
 * human labels so the client never has to join three tables to render a row.
 */
function catalogue() {
  return RECRUITS.map((r) => {
    const { main, sub } = archetypes.resolveSkills(r.archetype, r.sub);
    // `where` names are resolved against THIS install's towns, so the UI can
    // offer "take me there" only for places that actually exist here. A name
    // that doesn't resolve is reported, not hidden: on a heavily modded world
    // several vanilla towns (Squin, Mourn, Stoat) are simply absent, and
    // silently dropping them would misrepresent the wiki's list as agreeing
    // with the install.
    const found = [];
    const unresolved = [];
    for (const name of r.where || []) {
      const hit = locations.findByName(name);
      if (hit) found.push({ name, id: hit.id, label: hit.label, faction: hit.faction });
      else unresolved.push(name);
    }
    return {
      id: r.id,
      name: r.name,
      race: r.race,
      blurb: r.blurb,
      archetype: r.archetype,
      sub: r.sub,
      archetypeLabel: main.label,
      subLabel: sub.label,
      tier: r.tier,
      tierLabel: tier(r.tier).label,
      where: r.where || [],
      locations: found,
      unresolvedLocations: unresolved,
    };
  });
}

/** Throws if any entry names an archetype/sub/tier that doesn't exist. */
function validate() {
  for (const r of RECRUITS) {
    archetypes.resolveSkills(r.archetype, r.sub); // throws on an unknown pair
    tier(r.tier);
    if (!r.id || !r.name) throw new Error(`recruit entry missing id/name: ${JSON.stringify(r)}`);
  }
  const ids = RECRUITS.map((r) => r.id);
  if (new Set(ids).size !== ids.length) throw new Error('duplicate recruit id');
  return true;
}

module.exports = { RECRUITS, TIERS, tier, find, roll, catalogue, validate };
