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
 *
 * ===========================================================================
 * PART 2 EXPANSION — 75 to 139, thin groups first
 * ===========================================================================
 * The 64 entries added after the Meitou block (and the loadoutId now set on
 * seven of the original 75 — Seto, Tinfist, Moll, Dust King, Shryke,
 * Crumblejon, Bo, once services/loadouts.js grew a kit with their name on it)
 * came from the same 448-row sweep of this install's type-1 CHARACTER
 * templates that grounded the Meitou wielders above, not from a new one:
 * `combatStats` -> tier, `extra['race']` -> race (mapped onto this file's
 * existing short vocabulary — Greenlander -> human, Scorchlander -> sundemon,
 * every skeleton chassis -> skeleton, every Hive Prince -> hive), and every
 * combat sub resolved through the weapon's own `ints['skill category']`,
 * never guessed from a name.
 *
 * Two groups still fall short of the 12-entry target this pass aimed for,
 * and stay short on purpose rather than being padded to hit a number:
 *   - `medic` (10): nothing in the sweep reads as a field medic or a
 *     researcher. The five added are the only templates whose own name says
 *     "doctor" or "surgeon" — the rest of the pool is fighters.
 *   - `artisan` (9): outside three templates (Crabsmith, a Hive robotics
 *     trader, Flotsam Smith), nothing reads as a weapon-, armour- or
 *     bow-smith rather than a fighter who happens to be carrying a weapon.
 * `ranger` first "made target" by being read as "scout/hunter/tracker" rather
 * than "marksman", which is defensible — `group` is a UI heading and is
 * independent of `archetype` — but it produced a group of 12 in which 8 wielded
 * katanas, so picking "Rangers" for a crossbow user gave you one a third of the
 * time. Those eight moved to their own `hunter` group ("Hunters & scouts"), and
 * `ranger` was topped back up to 9 with openly invented marksmen.
 * The finding behind all of it stands and is the reason Rangers is the one
 * group with no derived entries at all: **not one of the 448 templates carries
 * a ranged weapon** — no crossbow, no turret. Nothing in this install's data
 * can ground a marksman's race or tier.
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
  // Split out of `ranger`. The expansion pass filed eight melee scouts and
  // bounty hunters under Rangers, on the reasoning that the group heading means
  // "scout" and is independent of `archetype`. It does read that way — but it
  // left a group of 12 in which 8 wielded katanas, so a user picking "Rangers"
  // for a crossbow got one two-thirds of the time. The underlying finding that
  // forced it stands and is worth keeping in view: **not one of the 448
  // CHARACTER templates in this install carries a ranged weapon**, so a
  // data-grounded marksman cannot be derived at all. Rangers is therefore the
  // one group that is honestly editorial end to end, and it says so.
  ['hunter', 'Hunters & scouts'],
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
    loadoutId: 'bandit-lord',
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
    loadoutId: 'martial-artist',
    blurb: 'Fights in martial-artist bindings and nothing else.',
    where: ['Blister Hill', 'Stack'] },
  { id: 'tinfist', name: 'Tinfist', group: 'duellist', race: 'skeleton', archetype: 'soldier', sub: 'unarmed', tier: 'legend',
    loadoutId: 'abolitionist',
    blurb: 'Abolitionist skeleton. Every combat stat in his record is 100.',
    where: ['Black Desert City', 'Mongrel', 'Flats Lagoon'] },
  { id: 'crumblejon', name: 'Crumblejon', group: 'duellist', race: 'human', archetype: 'soldier', sub: 'heavy-weapons', tier: 'green',
    loadoutId: 'hungry-bandit',
    blurb: 'Hungry bandit with a horse chopper and an axe.',
    where: ['The Hub', 'Waystation'] },

  // -------------------------------------------------------------- shadows --
  { id: 'moll', name: 'Moll', group: 'shadow', race: 'sundemon', archetype: 'shadow', sub: 'assassin', tier: 'legend',
    loadoutId: 'nightstalker',
    blurb: 'Combat 90 and stealth 90 — the best sneak in the data.',
    where: ['Mongrel', 'Black Desert City'] },
  { id: 'shryke', name: 'Shryke', group: 'shadow', race: 'sundemon', archetype: 'shadow', sub: 'assassin', tier: 'veteran',
    loadoutId: 'dust-runner',
    blurb: 'Stormgoggles and a polearm. Quiet, patient, behind you.',
    where: ['Mongrel', 'Black Desert City'] },
  { id: 'bo', name: 'Bo', group: 'shadow', race: 'sundemon', archetype: 'shadow', sub: 'assassin', tier: 'veteran',
    loadoutId: 'shinobi-thief',
    blurb: "Karuta zukin and assassin's rags, with a ninja blade.",
    where: ['The Hub', 'Bad Teeth'] },
  { id: 'miu', name: 'Miu', group: 'shadow', race: 'human', archetype: 'shadow', sub: 'burglar', tier: 'capable',
    blurb: 'Locks are a formality.',
    where: ['The Hub', 'Waystation'] },
  { id: 'sneak', name: 'Kiri', group: 'shadow', race: 'human', archetype: 'shadow', sub: 'burglar', tier: 'green',
    blurb: 'Nimble, unproven, and very interested in your lockpicks.',
    where: ['The Hub', 'Waystation'] },

  // -------------------------------------------------------------- rangers --
  // EVERY entry in this group is editorial, and uniquely so. Not one of the 448
  // type-1 CHARACTER templates in this install carries a ranged weapon — no
  // crossbow, no turret — so unlike every other group here, none of these
  // races or tiers could be read off game data. They are invented, plausibly,
  // and the `sub` values are still real archetype subs that train real skill
  // keys. If a future install DOES turn up crossbow-bearing templates, this is
  // the group to re-derive first.
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
  { id: 'eagle-eye', name: 'Renko', group: 'ranger', race: 'human', archetype: 'marksman', sub: 'crossbows', tier: 'legend',
    loadoutId: 'marksman-elite',
    blurb: 'Spends the whole fight on a roof and comes down when it is over.',
    where: ['Heft', 'Sho-Battai', 'Bark'] },
  { id: 'wall-shot', name: 'Otome', group: 'ranger', race: 'sundemon', archetype: 'marksman', sub: 'turrets', tier: 'veteran',
    blurb: 'Learned range on a wall turret and never lost the habit of leading a target.',
    where: ['Heft', 'Blister Hill'] },
  { id: 'dust-sniper', name: 'Kessa', group: 'ranger', race: 'sundemon', archetype: 'marksman', sub: 'crossbows', tier: 'veteran',
    blurb: 'Picks off the one at the back, on the theory that nobody misses him.',
    where: ['Squin', 'Admag'] },
  { id: 'drone-bow', name: 'Hum', group: 'ranger', race: 'hive worker', archetype: 'marksman', sub: 'crossbows', tier: 'capable',
    blurb: 'Reloads faster than anyone finds comfortable to watch.',
    where: ['Flats Lagoon', 'Sho-Battai'] },
  { id: 'bolt-hoarder', name: 'Pell', group: 'ranger', race: 'human', archetype: 'marksman', sub: 'crossbows', tier: 'green',
    blurb: 'More bolts than skill, and counting on the ratio holding.',
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

  // =======================================================================
  // PART 2 EXPANSION — grown from 75 to 150-ish, thin groups first.
  // =======================================================================
  // Every entry below names a real type-1 CHARACTER template from this
  // install's 448-row gamedata sweep (see the scratchpad JSON the sweep
  // wrote, and this file's own header for the exact derivation rule).
  // `race`/`tier`/`sub` are ALL read off that row, the same three fields the
  // header already documents for the Meitou wielders — never guessed:
  //
  //   combatStats -> tier (the same 4 bands used throughout this file)
  //   race        -> mapped onto this file's existing short race vocabulary
  //                  (Greenlander -> human, Scorchlander -> sundemon, every
  //                  skeleton chassis -> skeleton, every Hive Prince -> hive)
  //   weapons[0]  -> resolved through the type-2 template's own
  //                  `ints['skill category']`, exactly like the Meitou block
  //
  // `group`, `name` (several are the game's own generic template label,
  // cleaned up) and `blurb` stay editorial, as the header states. For the
  // non-combat archetypes (medic/craftsman/support) there is no data field
  // that names a "role" at all — the template carries a race, a tier and
  // sometimes a faction, nothing else — so `sub` there is a reasonable read
  // of the template's own name (a template called "Baker" trains as a cook,
  // not a farmer), not a weapon-class guess. That is a materially weaker
  // claim than the combat subs above, and it is why `medic` and `artisan`
  // still fall short of the 12-entry target below: this install's sweep
  // contains no template that reads as a field medic, a researcher, a
  // bow-smith or (found separately, see the file this expansion was written
  // against) a crossbow-armed marksman at all — not one of the 448 rows
  // carries a ranged weapon in its `weapons` list. `ranger` was rescued by
  // reading it as "scout/hunter/tracker" rather than "marksman", which the
  // group heading supports and the archetype field does not require; `medic`
  // and `artisan` had no equivalent honest escape hatch.
  //
  // `loadoutId` is set wherever the Part-2 loadout expansion (services/
  // loadouts.js) built a kit from this exact character's own template — the
  // named ones (Sir Testalot, Armour King, Yayoi, Dack, Arc, Experienced Man,
  // Elite Hunter, The Five Invincibles, Big Grim, No-Face, General Screamer,
  // Iyo, Finch) and the four generic gear sets that carry a character's own
  // name (Samurai Gate Sergeant, Empire Noble Guard, Samurai Captain,
  // Mercenary Heavy).

  // --------------------------------------------------------------- soldier --
  { id: 'samurai-elite', name: 'Samurai Elite', group: 'soldier', race: 'human', archetype: 'soldier', sub: 'katanas', tier: 'legend',
    blurb: 'Combat 85 in the game data, no name of his own — just the best the Empire fields.',
    where: ['Sho-Battai', 'Heft'] },
  { id: 'inquisitor-seta', name: 'High Inquisitor Seta', group: 'soldier', race: 'human', archetype: 'soldier', sub: 'katanas', tier: 'legend',
    blurb: 'Combat 80. Answers to the Holy Nation and nobody else.',
    where: ['Blister Hill', 'Stack'] },
  { id: 'samurai-gate-sergeant', name: 'Samurai Gate Sergeant', group: 'soldier', race: 'human', archetype: 'soldier', sub: 'katanas', tier: 'veteran',
    loadoutId: 'gate-sergeant',
    blurb: 'Combat 65. Runs a garrison gate and carries a naginata and a wakizashi to prove it.',
    where: ['Heft', 'Sho-Battai'] },
  { id: 'empire-noble-guard', name: 'Empire Noble Guard', group: 'soldier', race: 'human', archetype: 'soldier', sub: 'katanas', tier: 'veteran',
    loadoutId: 'noble-guard',
    blurb: 'Combat 60, a karuta zukin and Azuchi blue plate. Stands where nobles stand.',
    where: ['Blister Hill', 'Stack'] },
  { id: 'armour-king', name: 'Armour King', group: 'soldier', race: 'skeleton', archetype: 'soldier', sub: 'heavy-weapons', tier: 'legend',
    loadoutId: 'armour-king',
    blurb: 'Combat 95, grade-5 armour, a skeleton frame under Azuchi plate.',
    where: ['Black Desert City', 'Mongrel'] },

  // -------------------------------------------------------------- duellist --
  { id: 'samurai-captain', name: 'Samurai Captain', group: 'duellist', race: 'human', archetype: 'soldier', sub: 'katanas', tier: 'veteran',
    loadoutId: 'samurai-captain',
    blurb: 'Combat 70, chain shirt under samurai plate, a good katana.',
    where: ['Sho-Battai', 'Heft'] },
  { id: 'mercenary-heavy', name: 'Mercenary Heavy', group: 'duellist', race: 'human', archetype: 'soldier', sub: 'katanas', tier: 'capable',
    loadoutId: 'mercenary-heavy',
    blurb: 'Combat 40. Hired muscle in real armour, which is more than most hired muscle gets.',
    where: ['The Hub', 'Waystation'] },
  { id: 'anti-slaver-jonin', name: 'Anti-Slaver Jonin', group: 'duellist', race: 'human', archetype: 'soldier', sub: 'sabres', tier: 'legend',
    blurb: 'Combat 80. Free companies of ex-slaves do not send their weakest to the front.',
    where: ['Flats Lagoon', 'Black Scratch'] },
  { id: 'vigilante-chief', name: 'Vigilante Chief', group: 'duellist', race: 'human', archetype: 'soldier', sub: 'sabres', tier: 'veteran',
    blurb: 'Combat 60. Runs the watch in whatever town will have him.',
    where: ['The Hub', 'Bad Teeth'] },
  { id: 'sir-testalot', name: 'Sir Testalot', group: 'duellist', race: 'human', archetype: 'soldier', sub: 'sabres', tier: 'legend',
    loadoutId: 'sir-testalot',
    blurb: 'Combat 100 and a foreign sabre. Spiders faction, and does not lose duels.',
    where: ['The Hub', 'Bad Teeth'] },
  { id: 'arc', name: 'Arc', group: 'duellist', race: 'human', archetype: 'soldier', sub: 'sabres', tier: 'legend',
    loadoutId: 'arc',
    blurb: 'Combat 80. A karuta zukin, blackened chainmail, a ringed sabre.',
    where: ['Black Desert City', 'Mongrel'] },
  { id: 'big-grim', name: 'Big Grim', group: 'duellist', race: 'human', archetype: 'soldier', sub: 'sabres', tier: 'veteran',
    loadoutId: 'big-grim',
    blurb: 'Combat 70, square goggles, a ringed sabre. Lives up to the name in a fight.',
    where: ['The Hub', 'Waystation'] },

  // ---------------------------------------------------------------- shadow --
  { id: 'shinobi-guard', name: 'Shinobi Guard', group: 'shadow', race: 'human', archetype: 'soldier', sub: 'katanas', tier: 'veteran',
    loadoutId: 'shinobi-guard',
    blurb: 'Combat 65. A mask and blackened chainmail under rags, a ninja blade.',
    where: ['Mongrel', 'Black Desert City'] },
  { id: 'wandering-assassin', name: 'Wandering Assassin', group: 'shadow', race: 'human', archetype: 'soldier', sub: 'katanas', tier: 'capable',
    loadoutId: 'assassin',
    blurb: "Combat 50. No fixed employer, and every job looks the same to her.",
    where: ['Bad Teeth', 'The Hub'] },
  { id: 'ninja-guard', name: 'Ninja Guard', group: 'shadow', race: 'human', archetype: 'soldier', sub: 'katanas', tier: 'capable',
    blurb: 'Combat 55. Stands where he is told and is rarely seen doing it.',
    where: ['Squin', 'The Hub'] },
  { id: 'flotsam-ninja', name: 'Flotsam Ninja', group: 'shadow', race: 'human', archetype: 'soldier', sub: 'katanas', tier: 'capable',
    blurb: "Combat 43. Works the Flotsam Ninjas' patch and nowhere else.",
    where: ['Black Scratch', 'Port North'] },
  { id: 'yayoi', name: 'Yayoi', group: 'shadow', race: 'sundemon', archetype: 'soldier', sub: 'katanas', tier: 'legend',
    loadoutId: 'yayoi',
    blurb: "Combat 85. Dark leather under assassin's rags, a ninja blade.",
    where: ['Mongrel', 'Black Desert City'] },

  // ---------------------------------------------------------------- ranger --
  // Reads as scouts, hunters and trackers rather than marksmen: not one of
  // this install's 448 CHARACTER templates carries a ranged weapon in its
  // `weapons` list, so a data-grounded crossbow recruit does not exist to be
  // added. The existing four (marksman/crossbows, invented) are untouched.
  { id: 'elite-hunter', name: 'Elite Hunter', group: 'hunter', race: 'human', archetype: 'soldier', sub: 'katanas', tier: 'veteran',
    loadoutId: 'elite-hunter',
    blurb: 'Combat 75. Full Azuchi blue plate, a slim katana and a ninja blade on the hip.',
    where: ['Heft', 'Sho-Battai'] },
  { id: 'shek-scout', name: 'Shek Scout', group: 'hunter', race: 'shek', archetype: 'soldier', sub: 'heavy-weapons', tier: 'capable',
    blurb: 'Combat 50. Rides ahead of the Shek Kingdom column and reports back.',
    where: ['Admag', 'Squin'] },
  { id: 'samurai-scout', name: 'Samurai Scout', group: 'hunter', race: 'human', archetype: 'soldier', sub: 'katanas', tier: 'capable',
    blurb: 'Combat 50. Empire eyes past the border.',
    where: ['Sho-Battai', 'Heft'] },
  { id: 'legion-scout', name: 'Legion Scout', group: 'hunter', race: 'skeleton', archetype: 'soldier', sub: 'hackers', tier: 'capable',
    blurb: 'Combat 50. A Skeleton Log-Head chassis built for range, not endurance.',
    where: ['Black Desert City', "World's End"] },
  { id: 'cannibal-hunter-captain', name: 'Cannibal Hunter Captain', group: 'hunter', race: 'human', archetype: 'soldier', sub: 'sabres', tier: 'veteran',
    blurb: 'Combat 60. Leads a company paid to clear cannibal camps and nothing else.',
    where: ['Black Scratch', 'Port North'] },
  { id: 'noble-hunter', name: 'Noble Hunter', group: 'hunter', race: 'human', archetype: 'soldier', sub: 'hackers', tier: 'capable',
    blurb: 'Combat 50. Traders Guild muscle sent after whoever owes them.',
    where: ['Heft', 'Sho-Battai'] },
  { id: 'empire-bounty-hunter', name: 'Empire Bounty Hunter', group: 'hunter', race: 'human', archetype: 'soldier', sub: 'katanas', tier: 'capable',
    blurb: 'Combat 50. Works the Empire\'s bounty boards, katana first.',
    where: ['The Hub', 'Bad Teeth'] },
  { id: 'shek-bounty-hunter', name: 'Bounty Hunter Shek', group: 'hunter', race: 'shek', archetype: 'soldier', sub: 'katanas', tier: 'capable',
    blurb: "Combat 50. Tracks for coin, not for the Kingdom.",
    where: ['Squin', 'Admag'] },

  // ----------------------------------------------------- medics & scientists --
  // Short of the 12-entry target and staying that way: no template in this
  // sweep reads as a field medic or a researcher. These five are the only
  // rows whose own name says "doctor" or "surgeon".
  { id: 'skeleton-doctor', name: 'Skeleton Doctor', group: 'medic', race: 'skeleton', archetype: 'medic', sub: 'doctor', tier: 'capable',
    blurb: 'Combat 50 — carries a katana as often as a scalpel — a P4 unit that patches people up.',
    where: ['Black Desert City', 'Mongrel'] },
  { id: 'field-doctor', name: 'Doctor', group: 'medic', race: 'human', archetype: 'medic', sub: 'doctor', tier: 'green',
    blurb: 'Combat 13. Not much of a fighter, which is rather the point.',
    where: ['The Hub', 'Waystation'] },
  { id: 'surgeon', name: 'Surgeon', group: 'medic', race: 'human', archetype: 'medic', sub: 'doctor', tier: 'green',
    blurb: 'Combat 13. Steadier hands than the Doctor, no better bedside manner.',
    where: ['Flats Lagoon', 'Black Scratch'] },
  { id: 'plastic-surgeon', name: 'Guild Plastic Surgeon', group: 'medic', race: 'human', archetype: 'medic', sub: 'doctor', tier: 'green',
    blurb: 'Combat 15. Fixes faces for people who need a new one.',
    where: ['Heft', 'Sho-Battai'] },
  { id: 'undertaker', name: 'Undertaker', group: 'medic', race: 'human', archetype: 'medic', sub: 'doctor', tier: 'capable',
    blurb: 'Combat 40. Gets called when the Doctor and the Surgeon both failed.',
    where: ['Black Desert City', 'Mongrel'] },

  // ------------------------------------------------------------- artisans --
  // Short of the 12-entry target: outside the three rows below, nothing in
  // the sweep reads as a weapon-, armour- or bow-smith rather than a fighter
  // who happens to carry one.
  { id: 'crabsmith', name: 'Crabsmith', group: 'artisan', race: 'human', archetype: 'craftsman', sub: 'armour-smith', tier: 'capable',
    blurb: 'Combat 50. Builds the crab shells the Crabmen wear into battle.',
    where: ['Port North', 'Black Scratch'] },
  { id: 'hive-robotics-trader', name: 'Hive Robotics Trader', group: 'artisan', race: 'hive', archetype: 'craftsman', sub: 'robotics', tier: 'capable',
    blurb: "Combat 50. Deals in robotics parts most of the Hive can't use itself.",
    where: ['Bark', 'Heft'] },
  { id: 'flotsam-smith', name: 'Flotsam Smith', group: 'artisan', race: 'human', archetype: 'craftsman', sub: 'weapon-smith', tier: 'green',
    blurb: 'Combat 25. Forges for whoever the Flotsam Ninjas send his way.',
    where: ['Black Scratch', 'Port North'] },

  // -------------------------------------------------------------- traders --
  { id: 'caravan-trader-boss', name: 'Caravan Trader Boss', group: 'trader', race: 'human', archetype: 'support', sub: 'survivalist', tier: 'capable',
    blurb: 'Combat 50. Runs a caravan and is not shy about the club on his hip.',
    where: ['Heft', 'Bark'] },
  { id: 'hive-caravan-boss', name: 'Hive Caravan Boss', group: 'trader', race: 'hive', archetype: 'support', sub: 'survivalist', tier: 'capable',
    blurb: 'Combat 50. A Hive Prince who found there was more money in trade than war.',
    where: ['Bark', 'Heft'] },
  { id: 'bookshop-trader', name: 'Bookshop Trader', group: 'trader', race: 'skeleton', archetype: 'support', sub: 'survivalist', tier: 'capable',
    blurb: 'Combat 40. A P4 unit who deals in books nobody else wants to carry.',
    where: ['Sho-Battai', 'Heft'] },
  { id: 'uc-armour-trader', name: 'UC Armour Trader', group: 'trader', race: 'human', archetype: 'support', sub: 'survivalist', tier: 'green',
    blurb: 'Combat 35. Sells United Cities plate out of the back of a cart.',
    where: ['The Hub', 'Bad Teeth'] },
  { id: 'ronin-weapon-trader', name: 'Ronin Weapon Trader', group: 'trader', race: 'human', archetype: 'support', sub: 'survivalist', tier: 'green',
    blurb: 'Combat 30. Sells the blades masterless swordsmen no longer need.',
    where: ['The Hub', 'Waystation'] },
  { id: 'shinobi-trader', name: 'Shinobi Trader', group: 'trader', race: 'human', archetype: 'shadow', sub: 'burglar', tier: 'green',
    blurb: "Combat 30. Fences whatever the actual thieves bring back.",
    where: ['Mongrel', 'Black Desert City'] },
  { id: 'stone-camp-trader', name: 'Stone Camp Trader', group: 'trader', race: 'human', archetype: 'support', sub: 'survivalist', tier: 'green',
    blurb: 'Combat 20. Trades out of a stone camp, not a stall.',
    where: ['Flats Lagoon', 'Black Scratch'] },

  // ------------------------------------------------------------ explorers --
  { id: 'skeleton-drifter', name: 'Skeleton Drifter', group: 'explorer', race: 'skeleton', archetype: 'support', sub: 'survivalist', tier: 'veteran',
    blurb: 'Combat 70. Old chassis, no fixed destination.',
    where: ['Black Desert City', "World's End"] },
  { id: 'wandering-nomad', name: 'Nomad', group: 'explorer', race: 'human', archetype: 'support', sub: 'survivalist', tier: 'capable',
    blurb: 'Combat 40. Follows the herds, not the roads.',
    where: ['Bark', 'Heft'] },
  { id: 'animal-trader', name: 'Nomad Animal Trader', group: 'explorer', race: 'human', archetype: 'support', sub: 'survivalist', tier: 'capable',
    blurb: 'Combat 40. Buys and sells pack animals between towns that need them.',
    where: ['Bark', 'Sho-Battai'] },
  { id: 'human-drifter', name: 'Drifter', group: 'explorer', race: 'human', archetype: 'support', sub: 'survivalist', tier: 'capable',
    blurb: 'Combat 48. Goes where the work is, and the work is rarely good.',
    where: ['The Hub', 'Waystation'] },
  { id: 'karate-drifter', name: 'Karate Drifter', group: 'explorer', race: 'human', archetype: 'soldier', sub: 'unarmed', tier: 'green',
    blurb: 'Combat 30. Wanders with nothing but his hands.',
    where: ['Squin', 'The Hub'] },
  { id: 'flotsam-refugee', name: 'Flotsam Refugee', group: 'explorer', race: 'human', archetype: 'support', sub: 'survivalist', tier: 'green',
    blurb: 'Combat 10. Washed up in Flotsam with nothing and is still there.',
    where: ['Black Scratch', 'Port North'] },
  { id: 'traveller', name: 'Traveller', group: 'explorer', race: 'human', archetype: 'support', sub: 'survivalist', tier: 'green',
    blurb: 'Combat 10. Between somewhere and somewhere else.',
    where: ['Flats Lagoon', 'Bark'] },
  { id: 'suspicious-settler', name: 'Suspicious Settler', group: 'explorer', race: 'human', archetype: 'support', sub: 'survivalist', tier: 'green',
    blurb: "Combat 5. Won't say what he's running from.",
    where: ['The Hub', 'Waystation'] },
  { id: 'experienced-man', name: 'Experienced Man', group: 'explorer', race: 'human', archetype: 'soldier', sub: 'katanas', tier: 'legend',
    loadoutId: 'experienced-man',
    blurb: 'Combat 80. An iron hat, blackened chainmail, rations for a long road.',
    where: ['Heft', 'Sho-Battai'] },
  { id: 'iyo', name: 'Iyo', group: 'explorer', race: 'skeleton', archetype: 'soldier', sub: 'unarmed', tier: 'capable',
    loadoutId: 'iyo',
    blurb: 'Combat 50. Adventurers Guild, a P4 unit, unarmed by choice.',
    where: ['The Hub', 'Waystation'] },
  { id: 'finch', name: 'Finch', group: 'explorer', race: 'hive', archetype: 'soldier', sub: 'unarmed', tier: 'green',
    loadoutId: 'finch',
    blurb: 'Combat 20. A Hive Prince who joined the Adventurers Guild instead of a hive.',
    where: ['The Hub', 'Squin'] },

  // ------------------------------------------------------------ labourers --
  { id: 'holy-farm-leader', name: 'Holy Farm Leader', group: 'labourer', race: 'human', archetype: 'support', sub: 'farmer', tier: 'green',
    blurb: 'Combat 10. Runs a Holy Nation farm and answers to the Prophet for the harvest.',
    where: ['The Hub', 'Bad Teeth'] },
  { id: 'holy-farmer-wife', name: 'Holy Farmer Wife', group: 'labourer', race: 'human', archetype: 'support', sub: 'farmer', tier: 'green',
    blurb: 'Combat 10. Works the same field, keeps the books.',
    where: ['Blister Hill', 'Stack'] },
  { id: 'armed-farmer', name: 'Farmer', group: 'labourer', race: 'human', archetype: 'support', sub: 'farmer', tier: 'green',
    blurb: 'Combat 18. Keeps a cleaver by the door for the wildlife.',
    where: ['The Hub', 'Squin'] },
  { id: 'baker', name: 'Baker', group: 'labourer', race: 'human', archetype: 'support', sub: 'cook', tier: 'green',
    blurb: "Combat 20. Bread first, everything else second.",
    where: ['The Hub', 'Stack'] },
  { id: 'peasant-farmer', name: 'Peasant Farmer', group: 'labourer', race: 'human', archetype: 'support', sub: 'farmer', tier: 'green',
    blurb: 'Combat 12. Works someone else\'s land for a share of it.',
    where: ['Stack', 'Bad Teeth'] },
  { id: 'outlaw-farmer', name: 'Outlaw Farmer', group: 'labourer', race: 'human', archetype: 'support', sub: 'farmer', tier: 'green',
    blurb: "Combat 12. Farms when it's safe, steals when it isn't.",
    where: ['The Hub', 'Waystation'] },
  { id: 'empire-peasant', name: 'Empire Peasant', group: 'labourer', race: 'human', archetype: 'support', sub: 'farmer', tier: 'green',
    blurb: 'Combat 12. Empire Peasants, tied to the land they work.',
    where: ['Sho-Battai', 'Heft'] },
  { id: 'displaced-peasant', name: 'Displaced Peasant', group: 'labourer', race: 'human', archetype: 'support', sub: 'farmer', tier: 'green',
    blurb: 'Combat 12. Empire Peasants who lost the land and kept the trade.',
    where: ['Heft', 'Sho-Battai'] },

  // ------------------------------------------------------------- outcasts --
  { id: 'dack', name: 'Dack', group: 'outcast', race: 'skeleton', archetype: 'soldier', sub: 'hackers', tier: 'legend',
    loadoutId: 'dack',
    blurb: 'Combat 80. A dustcoat and nothing else, a Moon Cleaver.',
    where: ['Black Desert City', 'Mongrel'] },
  { id: 'five-invincibles', name: 'The Five Invincibles', group: 'outcast', race: 'human', archetype: 'soldier', sub: 'heavy-weapons', tier: 'veteran',
    loadoutId: 'the-five-invincibles',
    blurb: 'Combat 75. Armoured face plates and a fragment axe. There are not five of them.',
    where: ['Black Desert City', 'Mongrel'] },
  { id: 'armour-kings-thrall', name: "Armour King's Thrall", group: 'outcast', race: 'skeleton', archetype: 'soldier', sub: 'hackers', tier: 'legend',
    loadoutId: 'armour-kings-thrall',
    blurb: 'Combat 90, no armour of its own — it carries spare plating instead of wearing it.',
    where: ['Black Desert City', 'Mongrel'] },
  { id: 'general-screamer-true', name: 'General Screamer (The True)', group: 'outcast', race: 'skeleton', archetype: 'soldier', sub: 'polearms', tier: 'legend',
    loadoutId: 'general-screamer-true',
    blurb: 'Combat 80. A Screamer MkII, not to be confused with the False one.',
    where: ['Black Desert City', 'Mongrel'] },
  { id: 'no-face', name: 'No-Face', group: 'outcast', race: 'sundemon', archetype: 'soldier', sub: 'blunt', tier: 'veteran',
    loadoutId: 'no-face',
    blurb: 'Combat 70. A dyed rag shirt, an iron club, and no name anyone will give you.',
    where: ['Flats Lagoon', 'Black Scratch'] },
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
    const { main, sub, skills } = archetypes.resolveSkills(r.archetype, r.sub);
    const spread = tier(r.tier);
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
      // Display order from GROUPS, so the Recruits page can order 144 rows
      // without depending on the order they happen to be authored in.
      groupIndex: (() => {
        const i = GROUPS.findIndex(([g]) => g === r.group);
        return i === -1 ? GROUPS.length : i;
      })(),
      archetype: r.archetype,
      sub: r.sub,
      archetypeLabel: main.label,
      subLabel: sub.label,
      // The skill keys this recruit trains (main ∪ sub) and the numbers their
      // tier will actually write, so the Recruits page can show what picking
      // this row does instead of only naming the archetype. `archRange` applies
      // to `skills`, `otherRange` to everything else, `attribute` to str/dex/etc.
      skills,
      tier: r.tier,
      tierLabel: spread.label,
      tierSpread: {
        attribute: spread.attribute,
        archRange: spread.archRange,
        otherRange: spread.otherRange,
      },
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
  // Every group must offer a real choice. The target is 12 (see the header's
  // "PART 2 EXPANSION" note); `medic` (10) and `artisan` (9) fall short of it
  // on purpose — this install's gamedata sweep has no template that reads as
  // a field medic, a researcher, a bow-smith or a ranged-weapon marksman, and
  // inventing one would put vibes back into a field this file works hard to
  // keep grounded. The floor here is set below THEIR count, not below 12, so
  // a future edit that quietly shrinks a group still fails loudly.
  for (const [g, label] of GROUPS) {
    const n = counts.get(g) || 0;
    if (n < 8) throw new Error(`group "${label}" has only ${n} recruit(s); each should offer at least 8`);
  }
  return true;
}

module.exports = { RECRUITS, TIERS, GROUPS, tier, find, roll, catalogue, validate, groupLabel };
