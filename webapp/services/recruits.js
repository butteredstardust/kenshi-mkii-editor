'use strict';

const archetypes = require('./archetypes');
const locations = require('./locationsService');

/**
 * "Roll a recruit": ready-made squad members, grouped by the role they fill.
 *
 * IMPORTANT, same caveat as services/archetypes.js and services/loadouts.js:
 * **this is editorial data, not derived from a save.** It decides what a
 * recruit is *called* and what stat spread they get; nothing here is read at
 * write time except through addSquadMember's normal validation. Changing,
 * re-balancing or deleting an entry breaks nothing.
 *
 * WHAT *IS* GROUNDED IN GAME DATA: the `race`, `tier` and `where` of every
 * entry that names a real Kenshi character. Those came from the game's own
 * type-1 character records, which carry `ints['combat stats']`,
 * `extra['race']`, `extra['clothing']` and `extra['weapons']` — so:
 *
 *     Tinfist      Skeleton   combat/stealth/unarmed/strength all 100
 *     Bugmaster    Human      combat 95, a Cross-grade (Meitou) foreign sabre
 *     Moll         Sundemon   combat 90, stealth 90, ninja blade
 *     Valamon      Shek       combat 80, strength 40
 *     Savant       Sundemon   combat 75, strength 35, Meitou nodachi
 *     Dust King    Human      combat 45
 *     Seto         Shek       combat 35, martial-artist bindings, no blade
 *     Crumblejon   Human      combat 30, horse chopper and fragment axe
 *
 * Several races here corrected an earlier guess: Green is a Hive Worker Drone,
 * not a human; Shryke, Savant, Moll and Bo are Sundemons; Seto and Ells are
 * Shek. The tiers follow the `combat stats` column rather than vibes.
 *
 * `where` lists the towns the wiki's "possible locations" put them in, resolved
 * at request time against the towns this install actually has. Like `race` it
 * is a HINT: a heavily modded world renames and moves towns, and several
 * vanilla names (Squin, Mourn, Stoat) do not exist here at all. A name that
 * doesn't resolve is reported as unresolved rather than dropped or guessed at.
 *
 * `group` is the archetype heading the UI files a recruit under. Every group
 * carries four or five options so each reads as a real choice.
 */

const TIERS = {
  green: { label: 'Green', attribute: 20, archRange: [20, 45], otherRange: [5, 20] },
  capable: { label: 'Capable', attribute: 35, archRange: [35, 65], otherRange: [10, 30] },
  veteran: { label: 'Veteran', attribute: 50, archRange: [55, 80], otherRange: [15, 40] },
  legend: { label: 'Legend', attribute: 70, archRange: [75, 95], otherRange: [25, 50] },
};

// Display order for the UI's grouped picker.
const GROUPS = [
  ['soldier', 'Soldiers'],
  ['duellist', 'Duellists'],
  ['shadow', 'Shadows'],
  ['ranger', 'Rangers'],
  ['medic', 'Medics & scientists'],
  ['artisan', 'Artisans'],
  ['trader', 'Traders'],
  ['explorer', 'Explorers'],
  ['labourer', 'Labourers'],
  ['outcast', 'Outcasts'],
];

const RECRUITS = [
  // ------------------------------------------------------------- soldiers --
  { id: 'valamon', name: 'Valamon', group: 'soldier', race: 'shek', archetype: 'soldier', sub: 'blunt', tier: 'legend',
    blurb: 'Shek heavy. Game data gives him combat 80 and strength 40.',
    where: ['Admag', 'Squin'] },
  { id: 'dust-king', name: 'Dust King', group: 'soldier', race: 'human', archetype: 'soldier', sub: 'katanas', tier: 'veteran',
    blurb: 'Bandit lord in a spiked helmet and a heart protector.',
    where: ['The Hub', 'Bad Teeth'] },
  { id: 'sanda', name: 'Sanda', group: 'soldier', race: 'shek', archetype: 'soldier', sub: 'heavy-weapons', tier: 'veteran',
    blurb: 'Swings something far too large for the room.',
    where: ['Admag', 'Squin'] },
  { id: 'hamut', name: 'Hamut', group: 'soldier', race: 'human', archetype: 'soldier', sub: 'blunt', tier: 'capable',
    blurb: 'Bar-fight veteran, more scar tissue than sense.',
    where: ['Squin', 'Admag'] },
  { id: 'hobbs', name: 'Hobbs', group: 'soldier', race: 'human', archetype: 'soldier', sub: 'polearms', tier: 'green',
    blurb: 'Willing. That is the whole pitch.',
    where: ['The Hub', 'Squin'] },

  // ------------------------------------------------------------ duellists --
  { id: 'bugmaster', name: 'Bugmaster', group: 'duellist', race: 'human', archetype: 'soldier', sub: 'sabres', tier: 'legend',
    blurb: 'Combat 95 and a Meitou-grade sabre, wearing a loincloth.',
    where: ['Bad Teeth', 'The Hub'] },
  { id: 'savant', name: 'Savant', group: 'duellist', race: 'sundemon', archetype: 'soldier', sub: 'heavy-weapons', tier: 'legend',
    blurb: 'Combat 75 and a Meitou nodachi under police armour.',
    where: ['Black Desert City', 'Mongrel', "World's End"] },
  { id: 'seto', name: 'Seto', group: 'duellist', race: 'shek', archetype: 'soldier', sub: 'unarmed', tier: 'capable',
    blurb: 'Fights in martial-artist bindings and nothing else.',
    where: ['Blister Hill', 'Stack'] },
  { id: 'tinfist', name: 'Tinfist', group: 'duellist', race: 'skeleton', archetype: 'soldier', sub: 'unarmed', tier: 'legend',
    blurb: 'Abolitionist skeleton. Every combat stat in his record is 100.',
    where: ['Black Desert City', 'Mongrel', 'Flats Lagoon'] },
  { id: 'crumblejon', name: 'Crumblejon', group: 'duellist', race: 'human', archetype: 'soldier', sub: 'heavy-weapons', tier: 'green',
    blurb: 'Hungry bandit with a horse chopper and an axe.',
    where: ['The Hub', 'Waystation'] },

  // -------------------------------------------------------------- shadows --
  { id: 'moll', name: 'Moll', group: 'shadow', race: 'sundemon', archetype: 'shadow', sub: 'assassin', tier: 'legend',
    blurb: 'Combat 90 and stealth 90 — the best sneak in the data.',
    where: ['Mongrel', 'Black Desert City'] },
  { id: 'shryke', name: 'Shryke', group: 'shadow', race: 'sundemon', archetype: 'shadow', sub: 'assassin', tier: 'veteran',
    blurb: 'Stormgoggles and a polearm. Quiet, patient, behind you.',
    where: ['Mongrel', 'Black Desert City'] },
  { id: 'bo', name: 'Bo', group: 'shadow', race: 'sundemon', archetype: 'shadow', sub: 'assassin', tier: 'veteran',
    blurb: "Karuta zukin and assassin's rags, with a ninja blade.",
    where: ['The Hub', 'Bad Teeth'] },
  { id: 'miu', name: 'Miu', group: 'shadow', race: 'human', archetype: 'shadow', sub: 'burglar', tier: 'capable',
    blurb: 'Locks are a formality.',
    where: ['The Hub', 'Waystation'] },
  { id: 'sneak', name: 'Kiri', group: 'shadow', race: 'human', archetype: 'shadow', sub: 'burglar', tier: 'green',
    blurb: 'Nimble, unproven, and very interested in your lockpicks.',
    where: ['The Hub', 'Waystation'] },

  // -------------------------------------------------------------- rangers --
  { id: 'izumi', name: 'Izumi', group: 'ranger', race: 'human', archetype: 'marksman', sub: 'crossbows', tier: 'veteran',
    blurb: 'Puts a bolt through things at an unkind distance.',
    where: ['Heft', 'Sho-Battai'] },
  { id: 'suki', name: 'Suki', group: 'ranger', race: 'hive worker', archetype: 'marksman', sub: 'crossbows', tier: 'capable',
    blurb: 'Drone who took to crossbows with alarming speed.',
    where: ['Flats Lagoon', 'Sho-Battai', 'Heft'] },
  { id: 'longen', name: 'Longen', group: 'ranger', race: 'human', archetype: 'marksman', sub: 'crossbows', tier: 'veteran',
    blurb: 'Robed marksman with a taste for bloodrum.',
    where: ['Flats Lagoon', 'Black Scratch'] },
  { id: 'turret-hand', name: 'Nagi', group: 'ranger', race: 'human', archetype: 'marksman', sub: 'turrets', tier: 'capable',
    blurb: 'Would rather be behind a mounted crossbow than in front of one.',
    where: ['Heft', 'Bark'] },
  { id: 'fresh-bow', name: 'Tako', group: 'ranger', race: 'human', archetype: 'marksman', sub: 'crossbows', tier: 'green',
    blurb: 'Owns a junkbow and most of his fingers.',
    where: ['The Hub', 'Waystation'] },

  // ---------------------------------------------------- medics & scientists --
  { id: 'ells', name: 'Ells', group: 'medic', race: 'shek', archetype: 'medic', sub: 'field-medic', tier: 'capable',
    blurb: 'Carries more bandages than food. And some rum.',
    where: ['The Hub', 'Waystation'] },
  { id: 'ray', name: 'Ray', group: 'medic', race: 'hive soldier', archetype: 'medic', sub: 'field-medic', tier: 'green',
    blurb: 'Freed drone, still in shackles when you find him.',
    where: ['Bark', 'Heft'] },
  { id: 'doctor', name: 'Chiyo', group: 'medic', race: 'human', archetype: 'medic', sub: 'doctor', tier: 'veteran',
    blurb: 'Can put a limb back on and make it hold.',
    where: ['Black Scratch', 'Flats Lagoon'] },
  { id: 'researcher', name: 'Kenji', group: 'medic', race: 'human', archetype: 'medic', sub: 'researcher', tier: 'veteran',
    blurb: 'Reads ancient science books faster than he reads a room.',
    where: ['Black Desert City', "World's End"] },
  { id: 'ozu', name: 'Ozu', group: 'medic', race: 'human', archetype: 'medic', sub: 'researcher', tier: 'veteran',
    blurb: 'Talks to machines. They mostly answer.',
    where: ['Black Desert City', "World's End", 'Flats Lagoon'] },

  // ------------------------------------------------------------- artisans --
  { id: 'weapon-smith', name: 'Bo-Fu', group: 'artisan', race: 'human', archetype: 'craftsman', sub: 'weapon-smith', tier: 'veteran',
    blurb: 'Would rather be at a forge than in a fight.',
    where: ['The Hub', 'Bad Teeth'] },
  { id: 'armour-smith', name: 'Sato', group: 'artisan', race: 'human', archetype: 'craftsman', sub: 'armour-smith', tier: 'veteran',
    blurb: 'Hammers plate all day and complains about the ore.',
    where: ['Stack', 'Blister Hill'] },
  { id: 'bow-smith', name: 'Mura', group: 'artisan', race: 'human', archetype: 'craftsman', sub: 'bow-smith', tier: 'capable',
    blurb: 'Fussy about draw weight. Rightly so.',
    where: ['Heft', 'Sho-Battai'] },
  { id: 'robotics', name: 'Cog', group: 'artisan', race: 'skeleton', archetype: 'craftsman', sub: 'robotics', tier: 'veteran',
    blurb: 'A machine that repairs machines, including itself.',
    where: ['Black Desert City', 'Mongrel'] },
  { id: 'apprentice', name: 'Nutto', group: 'artisan', race: 'human', archetype: 'craftsman', sub: 'weapon-smith', tier: 'green',
    blurb: 'Keen, clumsy, and cheap.',
    where: ['The Hub', 'Waystation'] },

  // -------------------------------------------------------------- traders --
  { id: 'bayan', name: 'Bayan', group: 'trader', race: 'human', archetype: 'support', sub: 'survivalist', tier: 'capable',
    blurb: "Trader's leathers and a nose for a margin.",
    where: ['Bark', 'Heft'] },
  { id: 'caravan-boss', name: 'Miyo', group: 'trader', race: 'shek', archetype: 'support', sub: 'survivalist', tier: 'veteran',
    blurb: 'Runs a caravan and expects you to keep up.',
    where: ['Heft', 'Bark', 'Sho-Battai'] },
  { id: 'haggler', name: 'Sui', group: 'trader', race: 'human', archetype: 'shadow', sub: 'burglar', tier: 'capable',
    blurb: 'Buys low. Sells high. Occasionally buys nothing at all.',
    where: ['Flats Lagoon', 'Black Scratch'] },
  { id: 'smuggler', name: 'Feck', group: 'trader', race: 'human', archetype: 'shadow', sub: 'burglar', tier: 'veteran',
    blurb: 'Knows which gate guards look the other way.',
    where: ['The Hub', 'Bad Teeth'] },
  { id: 'porter', name: 'Cott', group: 'trader', race: 'hive worker', archetype: 'support', sub: 'survivalist', tier: 'green',
    blurb: 'Will carry anything, for a while.',
    where: ['The Hub', 'Waystation'] },

  // ------------------------------------------------------------ explorers --
  { id: 'green', name: 'Green', group: 'explorer', race: 'hive worker', archetype: 'shadow', sub: 'burglar', tier: 'capable',
    blurb: 'Worker drone in rags, a long way from the hive.',
    where: ['The Hub', 'Squin'] },
  { id: 'ruka', name: 'Ruka', group: 'explorer', race: 'shek', archetype: 'soldier', sub: 'unarmed', tier: 'veteran',
    blurb: 'Shek brawler who settles arguments with her hands.',
    where: ['Squin', 'Shark', 'The Hub'] },
  { id: 'scout', name: 'Squint', group: 'explorer', race: 'human', archetype: 'shadow', sub: 'burglar', tier: 'capable',
    blurb: 'Walks further in a day than most do in three.',
    where: ['The Hub', 'Waystation'] },
  { id: 'nomad', name: 'Tsau', group: 'explorer', race: 'human', archetype: 'support', sub: 'survivalist', tier: 'veteran',
    blurb: 'Reads dust storms the way others read weather.',
    where: ['Flats Lagoon', 'Bark'] },
  { id: 'swimmer', name: 'Fuu', group: 'explorer', race: 'human', archetype: 'shadow', sub: 'burglar', tier: 'green',
    blurb: 'Fast over water and fences alike.',
    where: ['Black Scratch', 'Port North'] },

  // ------------------------------------------------------------ labourers --
  { id: 'nadia', name: 'Nadia', group: 'labourer', race: 'human', archetype: 'support', sub: 'farmer', tier: 'green',
    blurb: 'Wants a field, some water, and to be left alone.',
    where: ['The Hub', 'Bad Teeth'] },
  { id: 'cook', name: 'Gohan', group: 'labourer', race: 'human', archetype: 'support', sub: 'cook', tier: 'capable',
    blurb: 'Turns foul raw meat into something people will eat.',
    where: ['The Hub', 'Stack'] },
  { id: 'miner', name: 'Grit', group: 'labourer', race: 'shek', archetype: 'support', sub: 'farmer', tier: 'capable',
    blurb: 'Swings a pick all day without complaint.',
    where: ['Stack', 'Bad Teeth'] },
  { id: 'hive-worker', name: 'Buzz', group: 'labourer', race: 'hive worker', archetype: 'support', sub: 'farmer', tier: 'green',
    blurb: 'Tireless, uncomplaining, faintly unsettling.',
    where: ['The Hub', 'Squin'] },
  { id: 'foreman', name: 'Masaru', group: 'labourer', race: 'human', archetype: 'craftsman', sub: 'armour-smith', tier: 'veteran',
    blurb: 'Runs a workshop and keeps everyone else on task.',
    where: ['Stack', 'Blister Hill'] },

  // ------------------------------------------------------------- outcasts --
  { id: 'burn', name: 'Burn', group: 'outcast', race: 'human', archetype: 'soldier', sub: 'katanas', tier: 'legend',
    blurb: 'Runs a rebellion out of a swamp, dressed in armoured rags.',
    where: ['Black Desert City'] },
  { id: 'agnu', name: 'Agnu', group: 'outcast', race: 'skeleton', archetype: 'soldier', sub: 'heavy-weapons', tier: 'legend',
    blurb: 'Something the Deadlands did not finish rusting.',
    where: ['Black Desert City', 'Mongrel'] },
  { id: 'beep', name: 'Beep', group: 'outcast', race: 'hive soldier', archetype: 'support', sub: 'survivalist', tier: 'green',
    blurb: 'Enthusiastic. Extremely enthusiastic. Owns a loincloth.',
    where: ['The Hub', 'Waystation'] },
  { id: 'slave', name: 'Taji', group: 'outcast', race: 'human', archetype: 'support', sub: 'farmer', tier: 'green',
    blurb: 'Still in shackles. Will need everything.',
    where: ['Bark', 'Heft'] },
  { id: 'cannibal', name: 'Skinner', group: 'outcast', race: 'human', archetype: 'soldier', sub: 'blunt', tier: 'capable',
    blurb: 'Best not to ask what he ate last week.',
    where: ['The Hub', 'Bad Teeth'] },
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

function groupLabel(id) {
  const hit = GROUPS.find(([g]) => g === id);
  return hit ? hit[1] : 'Other';
}

/**
 * Catalogue for the UI. Carries the resolved tier and archetype labels, the
 * group heading, and the recruit's `where` towns resolved against this
 * install — so the client never has to join four tables to render a row.
 */
function catalogue() {
  return RECRUITS.map((r) => {
    const { main, sub } = archetypes.resolveSkills(r.archetype, r.sub);
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
      group: r.group,
      groupLabel: groupLabel(r.group),
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

/** Throws if any entry names an archetype/sub/tier/group that doesn't exist. */
function validate() {
  const ids = RECRUITS.map((r) => r.id);
  if (new Set(ids).size !== ids.length) throw new Error('duplicate recruit id');

  const known = new Set(GROUPS.map(([g]) => g));
  const counts = new Map();
  for (const r of RECRUITS) {
    archetypes.resolveSkills(r.archetype, r.sub); // throws on an unknown pair
    tier(r.tier);
    if (!r.id || !r.name) throw new Error(`recruit entry missing id/name: ${JSON.stringify(r)}`);
    if (!known.has(r.group)) throw new Error(`recruit "${r.id}" is in unknown group "${r.group}"`);
    counts.set(r.group, (counts.get(r.group) || 0) + 1);
  }
  // Every group must offer a real choice, not one lonely option.
  for (const [g, label] of GROUPS) {
    const n = counts.get(g) || 0;
    if (n < 4) throw new Error(`group "${label}" has only ${n} recruit(s); each should offer 4-5`);
  }
  return true;
}

module.exports = { RECRUITS, TIERS, GROUPS, tier, find, roll, catalogue, validate, groupLabel };
