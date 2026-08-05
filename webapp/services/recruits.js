'use strict';

const archetypes = require('./archetypes');
const locations = require('./locationsService');
const loadouts = require('./loadouts');

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
 * carries at least four options so each reads as a real choice.
 *
 * `loadoutId` (optional) names the entry in services/loadouts.js that IS this
 * character's gear. It is a cross-reference, not a coupling: rolling a recruit
 * still only writes stats, and validate() checks the id resolves so a renamed
 * loadout surfaces as a test failure rather than a dead link in the UI.
 *
 * ===========================================================================
 * THE MEITOU WIELDERS
 * ===========================================================================
 * The 29 entries tagged `meitou: true` below are the named characters the game
 * hands a Meitou-grade weapon. Their `race`, `tier`, `archetype` and `sub` are
 * all read off their own type-1 CHARACTER template in this install, not chosen:
 *
 *   ints['combat stats']            -> tier   (<40 green, 40-59 capable,
 *                                              60-79 veteran, 80+ legend)
 *   extra['race'][0].target         -> race
 *   extra['weapons'][0].target      -> the weapon, whose type-2 template's
 *                                      ints['skill category'] IS the sub:
 *                                      0 katanas, 1 sabres, 2 blunt,
 *                                      3 heavy-weapons, 4 hackers, 8 polearms
 *
 * That last step is why four of them are `sub: 'hackers'` — see the note on
 * that sub in services/archetypes.js. It also corrected four entries that were
 * already in this file and had the weapon class wrong by eye: Savant wields a
 * Nodachi (katanas, not heavy weapons), Valamon and Longen both wield what this
 * install calls a Flat Topper (sabres — Longen was filed as a crossbow
 * marksman, and his template gives him combat 33, not 50).
 *
 * `group` is still editorial — it is a UI heading, and nothing in the data says
 * whether the Crab Queen reads as a soldier or a duellist.
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
  // sub corrected from 'blunt': his template's weapon is a Flat Topper, whose
  // `skill category` is 1 (Sabres).
  { id: 'valamon', name: 'Valamon', group: 'soldier', race: 'shek', archetype: 'soldier', sub: 'sabres', tier: 'legend',
    meitou: true, loadoutId: 'valamon',
    blurb: 'Shek heavy. Game data gives him combat 80, strength 40 and a Meitou longsword.',
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
    meitou: true, loadoutId: 'bugmaster-meitou',
    blurb: 'Combat 95 and a Meitou foreign sabre, wearing a loincloth.',
    where: ['Bad Teeth', 'The Hub'] },
  // sub corrected from 'heavy-weapons': a Nodachi's `skill category` is 0
  // (Katanas). tier stays legend — his template's combat stats are 75, but the
  // veteran band would understate a Meitou wielder the wiki calls a boss.
  { id: 'savant', name: 'Savant', group: 'duellist', race: 'sundemon', archetype: 'soldier', sub: 'katanas', tier: 'legend',
    meitou: true, loadoutId: 'savant-meitou',
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

  // =======================================================================
  // MEITOU WIELDERS — see the block comment at the head of this file for how
  // race / tier / sub were derived. Four more of them (Bugmaster, Savant,
  // Valamon, Longen) are already above, corrected in place.
  // =======================================================================

  // --------------------------------------------------------- blunt (cat 2) --
  { id: 'general-hat-12', name: 'General Hat-12', group: 'soldier', race: 'skeleton', archetype: 'soldier', sub: 'blunt', tier: 'legend',
    meitou: true, loadoutId: 'general-hat-12',
    blurb: 'Skeleton general of the Ashlands. Combat 80 and a Meitou heavy jitte.',
    where: ['Black Desert City', "World's End"] },
  { id: 'vault-warden', name: 'The Vault Warden', group: 'soldier', race: 'human', archetype: 'soldier', sub: 'blunt', tier: 'veteran',
    meitou: true, loadoutId: 'vault-warden',
    blurb: 'Full samurai plate and a Meitou jitte. Combat 70.',
    where: ['Heft', 'Sho-Battai'] },

  // ------------------------------------------------------- hackers (cat 4) --
  { id: 'king-gurgler', name: 'King Gurgler', group: 'outcast', race: 'fishman', archetype: 'soldier', sub: 'hackers', tier: 'capable',
    meitou: true, loadoutId: 'king-gurgler',
    blurb: 'Fishman king. Strength 90, no clothes, and a Meitou combat cleaver.',
    where: ['Port North', 'Black Scratch'] },
  { id: 'the-preacher', name: 'The Preacher', group: 'outcast', race: 'hive', archetype: 'soldier', sub: 'hackers', tier: 'capable',
    meitou: true, loadoutId: 'the-preacher',
    blurb: 'Hiver zealot in a kusari zukin, with a Meitou moon cleaver.',
    where: ['Mongrel', 'The Hub'] },
  { id: 'holy-lord-phoenix', name: 'Holy Lord Phoenix', group: 'soldier', race: 'human', archetype: 'soldier', sub: 'hackers', tier: 'legend',
    meitou: true, loadoutId: 'holy-lord-phoenix',
    blurb: "Combat 85 in his own plate, with a Meitou Paladin's Cross.",
    where: ['Blister Hill', 'Stack'] },
  { id: 'head-of-agriculture', name: 'Head of Agriculture', group: 'artisan', race: 'skeleton', archetype: 'soldier', sub: 'hackers', tier: 'veteran',
    meitou: true, loadoutId: 'head-of-agriculture',
    blurb: 'Carries an ancient science book and a Meitou short-cleaver.',
    where: ['Black Desert City', "World's End"] },

  // ------------------------------------------------- heavy weapons (cat 3) --
  { id: 'gorrillo', name: 'Gorrillo', group: 'outcast', race: 'human', archetype: 'soldier', sub: 'heavy-weapons', tier: 'capable',
    meitou: true, loadoutId: 'gorrillo',
    blurb: 'Strength 90 and a Meitou exile plank. Combat is only 45 — he swings it anyway.',
    where: ['The Hub', 'Squin'] },
  { id: 'mad-cat-lon', name: 'Mad Cat-Lon', group: 'soldier', race: 'skeleton', archetype: 'soldier', sub: 'heavy-weapons', tier: 'legend',
    meitou: true, loadoutId: 'mad-cat-lon',
    blurb: 'Combat 100, ranged 100, strength 85 — the highest numbers in the data, and a Meitou falling sun.',
    where: ['Black Desert City'] },
  { id: 'esata', name: 'Esata "The Stone Golem"', group: 'duellist', race: 'shek', archetype: 'soldier', sub: 'heavy-weapons', tier: 'legend',
    meitou: true, loadoutId: 'esata-stone-golem',
    blurb: 'The Shek queen. Combat 85, her own royal plate, and a Meitou fragment axe.',
    where: ['Admag', 'Squin'] },
  { id: 'mukai', name: 'Mukai The Mountain', group: 'soldier', race: 'shek', archetype: 'soldier', sub: 'heavy-weapons', tier: 'legend',
    meitou: true, loadoutId: 'mukai-the-mountain',
    blurb: 'Combat 80, a bandana, and a Meitou fragment axe.',
    where: ['Admag', 'Squin', 'Shark'] },

  // ------------------------------------------------------- katanas (cat 0) --
  { id: 'general-jang', name: 'General Jang', group: 'soldier', race: 'skeleton', archetype: 'soldier', sub: 'katanas', tier: 'legend',
    meitou: true, loadoutId: 'general-jang',
    blurb: 'Combat 85 in ancient samurai plate, with a Meitou guardless katana.',
    where: ['Black Desert City', "World's End"] },
  { id: 'emperor-tengu', name: 'Emperor Tengu', group: 'duellist', race: 'sundemon', archetype: 'soldier', sub: 'katanas', tier: 'veteran',
    meitou: true, loadoutId: 'emperor-tengu',
    blurb: 'Combat 60, strength 40, and a Meitou katana under the imperial robe.',
    where: ['Heft', 'Sho-Battai', 'Bark'] },
  { id: 'dimak', name: 'Dimak', group: 'shadow', race: 'shek', archetype: 'soldier', sub: 'katanas', tier: 'capable',
    meitou: true, loadoutId: 'dimak',
    blurb: 'Shek in ninja rags with a Meitou ninja blade. Combat 40.',
    where: ['Squin', 'The Hub'] },
  { id: 'rhinobot', name: 'Rhinobot', group: 'outcast', race: 'skeleton', archetype: 'soldier', sub: 'katanas', tier: 'legend',
    meitou: true, loadoutId: 'rhinobot',
    blurb: 'A P4 unit at combat 80, strength 80, swinging a Meitou topper.',
    where: ['Black Desert City', "World's End"] },
  { id: 'lady-kana', name: 'Lady Kana', group: 'shadow', race: 'sundemon', archetype: 'soldier', sub: 'katanas', tier: 'capable',
    meitou: true, loadoutId: 'lady-kana',
    blurb: "Noble's robes, a mask, luxury goods and a Meitou wakizashi.",
    where: ['Heft', 'Sho-Battai'] },
  { id: 'slave-mistress-grace', name: 'Slave Mistress Grace', group: 'shadow', race: 'sundemon', archetype: 'soldier', sub: 'katanas', tier: 'capable',
    meitou: true, loadoutId: 'slave-mistress-grace',
    blurb: 'Martial-artist bindings under noble robes, and a Meitou wakizashi.',
    where: ['Bark', 'Heft'] },
  { id: 'slave-mistress-ren', name: 'Slave Mistress Ren', group: 'shadow', race: 'sundemon', archetype: 'soldier', sub: 'katanas', tier: 'capable',
    meitou: true, loadoutId: 'slave-mistress-ren',
    blurb: "Grace's counterpart, with the same robes and the same Meitou wakizashi.",
    where: ['Bark', 'Heft'] },

  // ------------------------------------------------------ polearms (cat 8) --
  { id: 'screamer-the-false', name: 'Screamer the False', group: 'duellist', race: 'skeleton', archetype: 'soldier', sub: 'polearms', tier: 'capable',
    meitou: true, loadoutId: 'screamer-the-false',
    blurb: 'A Screamer MkI in armoured rags, with a Meitou heavy polearm.',
    where: ['Black Desert City', 'Mongrel'] },
  { id: 'crab-queen', name: 'Crab Queen', group: 'duellist', race: 'human', archetype: 'soldier', sub: 'polearms', tier: 'veteran',
    meitou: true, loadoutId: 'crab-queen',
    blurb: 'Combat 70 and strength 99, in the full crab shell, with a Meitou naginata.',
    where: ['Port North', 'Black Scratch'] },
  { id: 'queen-of-the-south', name: 'Queen of the South', group: 'outcast', race: 'hive', archetype: 'soldier', sub: 'polearms', tier: 'capable',
    meitou: true, loadoutId: 'queen-of-the-south',
    blurb: 'Southern Hive Queen. Strength 80, no armour at all, and a Meitou polearm.',
    where: ['Bark', 'Heft'] },
  { id: 'spider-foreman', name: 'Spider Foreman', group: 'outcast', race: 'skeleton', archetype: 'soldier', sub: 'polearms', tier: 'veteran',
    meitou: true, loadoutId: 'spider-foreman',
    blurb: 'Combat 75, nothing worn, and a Meitou staff.',
    where: ['Black Desert City', 'Mongrel'] },

  // -------------------------------------------------------- sabres (cat 1) --
  { id: 'eyegore', name: 'Eyegore', group: 'soldier', race: 'hive soldier', archetype: 'soldier', sub: 'sabres', tier: 'legend',
    meitou: true, loadoutId: 'eyegore',
    blurb: 'Combat 90 and strength 99 in Azuchi blue plate, with a Meitou desert sabre.',
    where: ['Heft', 'Bark'] },
  { id: 'ponk', name: 'Ponk', group: 'outcast', race: 'skeleton', archetype: 'soldier', sub: 'sabres', tier: 'capable',
    meitou: true, loadoutId: 'ponk',
    blurb: 'Armoured rags on a skeleton frame, with a Meitou holed sabre.',
    where: ['Black Desert City', 'Mongrel'] },
  { id: 'red-sabre-boss', name: 'Red Sabre Boss', group: 'outcast', race: 'human', archetype: 'soldier', sub: 'sabres', tier: 'capable',
    meitou: true, loadoutId: 'red-sabre-boss',
    blurb: 'Strength 70, a bandana, a Meitou horse chopper and a great many stolen cats.',
    where: ['Port North', 'Black Scratch'] },
  { id: 'longen', name: 'Longen', group: 'trader', race: 'sundemon', archetype: 'soldier', sub: 'sabres', tier: 'green',
    meitou: true, loadoutId: 'longen-meitou',
    blurb: 'Robed, fond of bloodrum, combat 33 — and carrying a Meitou longsword.',
    where: ['Flats Lagoon', 'Black Scratch'] },
  { id: 'elder', name: 'Elder', group: 'duellist', race: 'skeleton', archetype: 'soldier', sub: 'sabres', tier: 'veteran',
    meitou: true, loadoutId: 'elder',
    blurb: 'A P4 unit at combat 75, wearing nothing, with a Meitou ringed sabre.',
    where: ['Black Desert City', "World's End"] },
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
      meitou: !!r.meitou,
      // The gear set that IS this character, when there is one. Resolved to a
      // label here so the picker can offer "…and equip their kit" without a
      // second round trip; null when the recruit has no matching loadout.
      loadoutId: r.loadoutId || null,
      loadoutLabel: r.loadoutId ? (loadouts.find(r.loadoutId) || {}).label || null : null,
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
    // A dangling loadoutId would render as a recruit whose kit button does
    // nothing. Caught here so renaming a loadout fails the test suite instead.
    if (r.loadoutId && !loadouts.find(r.loadoutId)) {
      throw new Error(`recruit "${r.id}" names unknown loadout "${r.loadoutId}"`);
    }
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
