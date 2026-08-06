'use strict';

const gamedata = require('./gamedataService');
const itemSlots = require('./itemSlots');
// Race NAMES need load order — "Human"/"Sundemon" by first-definition-wins are
// "Greenlander"/"Scorchlander" to the running game and the player.
const races = require('./racesService');

/**
 * Named gear sets for "equip several characters at once".
 *
 * IMPORTANT, same caveat as services/archetypes.js and services/recruits.js:
 * **this is editorial data, not derived from a save.** It is a convenience
 * catalogue, safe to edit, re-balance or delete without re-deriving anything.
 * `validate()` (which the tests call) is the only hard constraint: every
 * `templateSid` must resolve to a real item template, and every `section` must
 * be one that template's kind can actually occupy per services/itemSlots.js.
 *
 * ===========================================================================
 * WHERE THE KITS COME FROM
 * ===========================================================================
 * The four original entries were the contents of four ad-hoc scripts. The rest
 * were read off the game's own NPCs: every character in the live save was
 * sorted by combat skill and their worn gear dumped, then the best-equipped
 * member of each of the 22 factions present. The patterns below are what
 * Kenshi itself puts on people, not invention:
 *
 *   - A full kit is FIVE armour pieces, not four: head, **shirt**, armour,
 *     legs, boots. The shirt slot is worn UNDER body armour and this catalogue
 *     originally missed it entirely — a Samurai Gate Sergeant wears a Chain
 *     Shirt beneath Empire Samurai Armour, a Shinobi Guard wears Blackened
 *     Chainmail under Black Rag Shirt.
 *   - Armour `level` tracks rank: a grunt is 20, a garrison soldier 40-60, an
 *     elite 80, a named character 95. Weapon grade tracks it too: Catun No.1
 *     around rank 30 for a grunt, Industrial 008 for a veteran, Edge Type 5
 *     for an elite.
 *   - Fighters carry a weapon on the `back` AND one on the `hip` once they are
 *     senior (the Gate Sergeant carries a Naginata and a Wakizashi).
 *   - Almost everyone carries a first aid kit and some cats.
 *
 * `raceNotes` carries per-race warnings. They are ONLY warning text: bulk equip
 * deliberately never skips a character (see saveService.equipMany) — everything
 * selected gets everything in the loadout, and anything the editor believes is
 * a poor fit is reported afterwards. Hard incompatibility (an item kind that
 * cannot occupy the requested slot at all) is still a refusal, and that check
 * lives in itemSlots.js, not here.
 *
 * ===========================================================================
 * `category` — the browsing spine, added when the catalogue grew past 66
 * ===========================================================================
 * Every entry now carries one `category` (see `CATEGORIES` above, an ordered
 * id/label list so the UI's picker groups by kit type — heavy-melee,
 * light-melee, ranged, stealth, support, trade, travel, starter, faction
 * uniforms, named/unique characters, animals — rather than alphabetising 130
 * labels into an unbrowsable list). `tags` is unchanged and still the
 * cross-cutting filter (meitou / weapon class / heavy-light) that
 * `services/recruits.js` and the Gear tab already key off; `category` is new
 * and additive, never a replacement. `validate()` refuses any entry whose
 * category is missing or outside `CATEGORIES`.
 *
 * The first 66 entries (the original four scripts, the "read off a live
 * save" kits, and the 29 Meitou wielders) were categorised after the fact,
 * by what each already was — a Meitou wielder or one of the nine other named
 * characters already in that block is `unique` regardless of its `tags`; a
 * kit that names a faction outright is `faction`; everything else follows its
 * existing `tags`.
 *
 * ===========================================================================
 * THE PART-2 EXPANSION (past entry 66) — same method, wider net
 * ===========================================================================
 * Grown from a fresh sweep of every type-1 CHARACTER template in this
 * install's gamedata with `ints['combat stats'] > 0` (see the sweep's own
 * header comment further down for the exact method and count on this
 * install — it is not the same install the 29 Meitou wielders were swept
 * from, so the raw counts differ; the resolution rules do not). New faction
 * and named-character entries were read the same way the Meitou block reads
 * them: `extra['clothing'|'weapons'|'inventory'|'race'|'faction']` and
 * `ints['armour grade']` on that template, unioned across every definition in
 * `data/mods.cfg` load order. The `animal` category is the one place this
 * sweep overturned something the file already claimed: `ANIMAL` above says an
 * animal "wears and carries nothing", which is FALSE for exactly two races —
 * `Garru Backpack`/`Bull Backpack` are real, race-whitelisted type-46
 * templates. See `PACK_ANIMAL` and the animal section below.
 */

// ---------------------------------------------------------------- grades --
// A melee weapon's grade is the (company, model) PAIR, so these are ladder row
// ids ("<companySid>|<modelSid>"). A bare model sid is ambiguous — 14 of this
// install's 24 model sids belong to two companies at once. Ordered worst to
// best; the rank is the ladder's own.
const GRADE = {
  rusted: '912-gamedata.base|914-gamedata.base', //   5  Rusted junk
  mid: '917-gamedata.base|925-gamedata.base', //     20  003
  catun1: '1057-gamedata.base|1058-gamedata.base', // 30  Catun No.1
  industrial: '927-gamedata.base|930-gamedata.base', // 40  Industrial 008
  catun4: '927-gamedata.base|1059-gamedata.base', //  50  Catun No.4
  mk5: '1163-gamedata.base|1063-gamedata.base', //    60  Mk V
  edge5: '1070-gamedata.base|1069-gamedata.base', //  80  Edge Type 5
  meitou: '52288-rebirth.mod|52293-rebirth.mod', //  100  Meitou
};

// ------------------------------------------------------------ item sids --
// Resolved from this install's data by name. `validate()` re-checks every one,
// so a mod that goes missing surfaces as a test failure and a `missing[]` on
// the catalogue row rather than a silent wrong item.
const I = {
  // heads
  azuchiHelm: '99176-Azuchi.mod', // Azuchi Blue Heavy Masked Helmet
  spikedHelm: '2203-gamedata.base',
  armouredHood: '2200-gamedata.base',
  stormgoggles: '55395-rebirth.mod',
  rattanHat: '2185-gamedata.base',
  samuraiHelm: '2145-gamedata.base',
  ancientHelm: '1533510-Newwworld.mod',
  maskedHelm: '2201-gamedata.base',
  karutaZukin: '2228-chris_r.mod',
  hachigane: '2224-chris_r.mod',
  mask1: '18029-small_changes_otto.mod',
  ninjaZukin: '2221-chris_r.mod',
  strawHat: '575-gamedata.base',
  dyedTurban: '54582-rebirth.mod',
  tagelmust: '2220-chris_r.mod',
  cap: '2167-gamedata.base',
  flaredHelm: '2198-gamedata.base',
  crabHelm: '64888-Newwworld.mod',
  ironHat: '2227-chris_r.mod',
  armouredFacePlates: '18962-gamedata.base',
  squareGoggles: '2168-gamedata.base',
  azuchiHelmet: '98838-Azuchi.mod', // Azuchi Blue Heavy Helmet (unmasked)
  holyFlameHelmet: '13-holy_lord_phoenix.mod',
  paladinHachigane: '2226-chris_r.mod',
  turban: '2219-chris_r.mod',
  // shirts (under body armour)
  chainShirt: '544-gamedata.base',
  blackChain: '2211-gamedata.base',
  leatherShirt: '1169-gamedata.base',
  darkLeatherShirt: '2214-gamedata.base',
  leatherVest: '2212-gamedata.base',
  whiteVest: '1167-gamedata.base',
  clothShirt: '1168-gamedata.base',
  turtleneck: '51643-rebirth.mod',
  gorilloPelt: '23-AntiquityPack.mod',
  bindings: '2326-gamedata.base', // Martial Artist Bindings
  blackChainShirt: '577-gamedata.base',
  leatherTurtleneck: '2213-gamedata.base',
  chainmail: '2210-gamedata.base',
  // body
  empireSamurai: '51708-rebirth.mod',
  samuraiArmour: '2122-gamedata.base',
  ancientArmour: '1533508-Newwworld.mod',
  azuchiArmour: '98840-Azuchi.mod',
  mercLeather: '2283-gamedata.base',
  mercPlate: '2148-gamedata.base',
  tradersLeathers: '2163-gamedata.base',
  longcoat: '2165-gamedata.base',
  assassinRags: '2154-gamedata.base',
  blackRagShirt: '42060-rebirth.mod',
  heartProtector: '2156-gamedata.base',
  dyedRagShirt: '51642-rebirth.mod',
  ragShirt: '2309-clothes_v1.mod',
  armouredRags: '42052-rebirth.mod',
  crabArmour: '64892-Newwworld.mod',
  dustcoat: '3061-gamedata.base',
  policeArmour: '2182-gamedata.base',
  drifterJacket: '2304-clothes_v1.mod',
  sleevelessLongcoat: '684-gamedata.base',
  dyedRobes: '51707-Dialogue.mod',
  gi: '564-gamedata.base',
  holyChestPlate: '2166-gamedata.base',
  // legs
  samuraiLegs: '2150-gamedata.base',
  ancientLegs: '1533511-Newwworld.mod',
  azuchiPants: '98905-Azuchi.mod',
  samuraiClothpants: '2159-gamedata.base',
  cargoReinforced: '1393-gamedata.base',
  cargoColored: '50391-rebirth.mod',
  ninjaPants: '2194-gamedata.base',
  drifterPants: '2305-clothes_v1.mod',
  halfpantsPadded: '554-gamedata.base',
  halfpantsColored: '1273-gamedata.base',
  stoutHessian: '18911-gamedata.base',
  hessianUniform: '2169-gamedata.base',
  ragLoincloth: '2308-clothes_v1.mod',
  ragSkirt: '42260-rebirth.mod',
  platedDrifterPants: '1532813-Newwworld.mod',
  hackStopperPants: '64907-Newwworld.mod',
  giPants: '2193-gamedata.base',
  monkPants: '2188-gamedata.base',
  dyedTrousers: '51746-Dialogue.mod',
  cargopants: '550-gamedata.base',
  // boots
  samuraiBoots: '549-gamedata.base',
  ancientBoots: '1533509-Newwworld.mod',
  azuchiBoots: '98908-Azuchi.mod',
  drifterBoots: '2306-clothes_v1.mod',
  platedLongboots: '556-gamedata.base',
  woodenSandals: '557-gamedata.base',
  shackles: 'SHACKLES',
  // animal-only backpacks — race-locked in the game's own data (see the
  // sweep header comment for the animal section below)
  garruBackpack: '4002-gamedata.base', // Garru Backpack — whitelisted to Garru only
  bullBackpack: '43948-rebirth.mod', // Bull Backpack — whitelisted to Bull only
  // melee
  katana: '476-gamedata.base',
  naginata: '52308-rebirth.mod',
  nodachi: '922-gamedata.base',
  wakizashi: '1020-gamedata.base',
  ninjaBlade: '924-gamedata.base',
  desertSabre: '52305-rebirth.mod',
  ringedSabre: '903-gamedata.base',
  foreignSabre: '52304-rebirth.mod',
  heavyJitte: '52290-rebirth.mod',
  jitte: '52303-rebirth.mod',
  spikedClub: '52297-rebirth.mod',
  heavyIronClub: '2110-gamedata.base',
  ironClub: '2064-gamedata.base',
  horseChopper: '475-gamedata.base',
  fragmentAxe: '477-gamedata.base',
  fallingSun: '52306-rebirth.mod',
  staff: '52302-rebirth.mod',
  plank: '902-gamedata.base',
  topper: '474-gamedata.base',
  flatTopper: '901-gamedata.base',
  polearm: '52301-rebirth.mod',
  longCleaver: '478-gamedata.base',
  fleshCleaver: '2606-gamedata.base',
  bullHornAxe: '56729-Dialogue.mod',
  ironClubRebirth: '52295-rebirth.mod', // "Iron Club" — a different sid from I.ironClub
  naginataKatana: '52309-rebirth.mod',
  // crossbows (typecode 107 — worn on the back, no manufacturer ladder)
  ranger: '66169-Newwworld.mod',
  eaglesCross: '66290-Newwworld.mod',
  junkbow: '95724-Dialogue.mod',
  springBat: '95764-rebirth.mod',
  // packs
  thievesPack: '46036-rebirth.mod',
  smallPack: '576-gamedata.base',
  mediumPack: '635-gamedata.base',
  largePack: '1012-gamedata.base',
  tradersPack: '45555-changes_otto.mod',
  // carried
  aidBasic: '209-gamedata.base',
  aidStandard: '515-gamedata.base',
  aidAdvanced: '1359-gamedata.base',
  roboticsKit: '18020-gamedata.base',
  skeletonKit: '97903-rebirth.mod',
  driedMeat: '42334-changes_otto.mod',
  foodcube: '43959-rebirth.mod',
  rationPack: '42337-changes_otto.mod',
  bread: '1946-gamedata.base',
  cats: '54546-Newwworld.mod',
  stringOfCats: '54549-Newwworld.mod',
  bolts: '95781-rebirth.mod',
  sleepingBag: '56645-rebirth.mod',
  splintKit: '1435-gamedata.base',
  waterJug: '12617-nodes_otto.mod',
  rum: '1015-gamedata.base',
  bloodrum: '43316-rebirth.mod',
  chewsticks: '43956-rebirth.mod',
  lantern: '47185-Dialogue.mod',
  food: '1016-gamedata.base',
  water: '1914-gamedata.base',
  boltsLong: '96000-Newwworld.mod',
  armourPlating: '2288-gamedata.base',
  chainmailSheets: '2289-gamedata.base',

  // ---------------------------------------------------------------------
  // The named Meitou wielders' own gear (see MEITOU_WIELDERS below). Every
  // sid here was read off that character's type-1 CHARACTER template in this
  // install, not chosen — the sweep is documented at the head of that block.
  // ---------------------------------------------------------------------
  // heads
  holyLordHelmet: '24-holy_lord_phoenix.mod',
  tenguHat: '14-tengu.mod',
  mask3: '18034-small_changes_otto.mod',
  bandana: '2222-chris_r.mod',
  kusariZukin: '2229-chris_r.mod',
  // shirts
  rustyChainShirt: '18018-small_changes_otto.mod',
  holyLordsChainmail: '12-holy_lord_phoenix.mod',
  blackClothShirt: '18917-gamedata.base',
  blackGorilloPelt: '10-GorilloScarf.mod',
  // body
  shekQueenChest: '10-esata.mod',
  holyLordsChestPlate: '10-holy_lord_phoenix.mod',
  tenguRobe: '10-tengu.mod',
  noblesRobe: '51663-Newwworld.mod',
  hackStopperJacket: '64906-Newwworld.mod',
  ninjaRags: '2151-gamedata.base',
  // legs
  crabTrousers: '64891-Newwworld.mod',
  shekQueenPants: '12-esata.mod',
  holyLordLegplates: '14-holy_lord_phoenix.mod',
  tenguPants: '12-tengu.mod',
  noblesTrousers: '51662-Newwworld.mod',
  ragLoinclothDyed: '64923-rebirth.mod',
  halfpantsRagged: '551-gamedata.base',
  // boots
  crabShoes: '64890-Newwworld.mod',
  shekQueenBoots: '14-esata.mod',
  holyLordsBoots: '11-holy_lord_phoenix.mod',
  tenguSandals: '13-tengu.mod',
  // melee — the six weapon classes the wielders cover
  combatCleaver: '52292-rebirth.mod',
  moonCleaver: '52300-rebirth.mod',
  paladinsCross: '52299-rebirth.mod',
  shortCleaver: '65260-rebirth.mod',
  exilePlank: '56728-Dialogue.mod',
  slimKatana: '923-gamedata.base', // vanilla's Guardless Katana; rebirth.mod renames it
  heavyPolearm: '52307-rebirth.mod',
  holedSabre: '52287-rebirth.mod',
  // carried
  splintAdvanced: '1436-gamedata.base',
  wrench: '43862-changes_otto.mod',
  luxuryGoods: '585-gamedata.base',
  ancientScienceBook: '43953-rebirth.mod',
  sake: '42310-changes_otto.mod',
  grog: '42311-changes_otto.mod',
  narcotics: '1230-gamedata.base',
  pearlCup: '42330-changes_otto.mod',
  holyFlame: '42322-changes_otto.mod',
};

// ------------------------------------------------------------- shorthand --
const head = (sid, level) => ({ templateSid: sid, section: 'head', level });
const shirt = (sid, level) => ({ templateSid: sid, section: 'shirt', level });
const body = (sid, level) => ({ templateSid: sid, section: 'armour', level });
const legs = (sid, level) => ({ templateSid: sid, section: 'legs', level });
const boots = (sid, level) => ({ templateSid: sid, section: 'boots', level });
const back = (sid, level, gradeId) => ({ templateSid: sid, section: 'back', level, ...(gradeId ? { gradeId } : {}) });
const hip = (sid, level, gradeId) => ({ templateSid: sid, section: 'hip', level, ...(gradeId ? { gradeId } : {}) });
const pack = (sid) => ({ templateSid: sid, section: 'backpack_attach' });
const carry = (sid, quantity = 1) => ({ templateSid: sid, section: 'main', quantity });

// A Meitou weapon carries no explicit `level`: the grade decides it. See
// itemFactory.defaultLevelForGrade() — the ladder row's own rank (100 for
// Meitou) is written into `ints.level`, so naming the grade is the whole
// choice, exactly as a player states it.
const meitouBack = (sid) => ({ templateSid: sid, section: 'back', gradeId: GRADE.meitou });
const meitouHip = (sid) => ({ templateSid: sid, section: 'hip', gradeId: GRADE.meitou });

/**
 * FCS `armour grade` (1-5 on a type-1 CHARACTER template) -> this catalogue's
 * `level` ladder. That int is the game's own statement of how good the armour
 * it spawns on that character is, so it is what decides the tier here rather
 * than a per-entry guess. Templates that carry no `armour grade` at all (Dimak,
 * Emperor Tengu, Holy Lord Phoenix, Longen, King Gurgler, The Preacher, Queen
 * of the South) fall to 60 — this file's own editorial choice for "named
 * character, grade unstated", flagged here rather than hidden in 27 literals.
 */
const ARMOUR_GRADE_LEVEL = { 1: 20, 2: 40, 3: 60, 4: 80, 5: 95 };
const gradeLevel = (armourGrade) => ARMOUR_GRADE_LEVEL[armourGrade] ?? 60;

const ANIMAL = { races: ['Dog1', 'Bull', 'Garru', 'Goat', 'Bonedog', 'Beak Thing', 'Skimmer'], note: 'animal — wears and carries nothing' };
const NO_FEET = { races: ['Skeleton', 'Hive'], note: 'boots and helmet are a poor fit on this race' };
// Most of the wielders below are machines or hivers wearing what the game
// actually puts on them, so the usual "this race has no boot slot" caution
// applies to the kit as a whole rather than to one piece.
const ROBOT = { races: ['Skeleton', 'P4 Unit', 'Screamer'], note: 'built for a skeleton frame — a fleshed race can wear it, but it was measured for a machine' };
// NOT what ANIMAL above claims for these two: `Garru Backpack`/`Bull Backpack`
// are real type-46 templates, each whitelisted (extra['races']) to exactly one
// race. A pack animal in this data DOES wear something — the ANIMAL note above
// is wrong for Bull/Garru specifically, right for the other five. See the
// "ANIMAL LOADOUTS" section below for the evidence.
const PACK_ANIMAL = { races: ['Bull', 'Garru'], note: 'a beast of burden — the game gives it a race-locked backpack template and nothing else; no weapon or armour slot is ever populated for it' };

/**
 * Display order for the UI's category picker (TODO.md-style "GROUPS" list —
 * an id/label pair array so the frontend renders headings in this fixed
 * order rather than alphabetising). `tags` stays the cross-cutting filter
 * (meitou / weapon class / heavy-light); `category` is the primary spine.
 */
const CATEGORIES = [
  ['heavy-melee', 'Heavy melee'],
  ['light-melee', 'Light melee'],
  ['ranged', 'Ranged'],
  ['stealth', 'Stealth'],
  ['support', 'Support (medic / engineer)'],
  ['trade', 'Trade'],
  ['travel', 'Travel'],
  ['starter', 'Starter'],
  ['faction', 'Faction uniforms'],
  ['unique', 'Named characters'],
  ['animal', 'Animals'],
];
const CATEGORY_IDS = new Set(CATEGORIES.map(([id]) => id));

const LOADOUTS = [
  // ------------------------------------------------------------ heavy melee --
  {
    id: 'ancient-samurai',
    category: 'heavy-melee',
    label: 'Ancient Samurai',
    description: 'The masterwork plate set, level 95. The heaviest armour in the catalogue.',
    tags: ['heavy', 'armour'],
    items: [
      head(I.ancientHelm, 95), shirt(I.chainShirt, 80), body(I.ancientArmour, 95),
      legs(I.ancientLegs, 95), boots(I.ancientBoots, 95),
      carry(I.aidAdvanced, 3),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'gate-sergeant',
    category: 'faction',
    label: 'Samurai Gate Sergeant',
    description: 'What the United Cities puts on a garrison sergeant: full Empire plate, naginata and a wakizashi.',
    tags: ['heavy', 'full'],
    items: [
      head(I.azuchiHelm, 80), shirt(I.chainShirt, 80), body(I.empireSamurai, 95),
      legs(I.samuraiLegs, 95), boots(I.samuraiBoots, 80),
      back(I.naginata, 55, GRADE.mk5), hip(I.wakizashi, 50, GRADE.catun4),
      pack(I.mediumPack), carry(I.aidStandard, 3), carry(I.stringOfCats, 2),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'samurai-captain',
    category: 'heavy-melee',
    label: 'Samurai Captain',
    description: 'Chain shirt under samurai plate, Azuchi boots, a good katana.',
    tags: ['heavy', 'full'],
    items: [
      head(I.samuraiHelm, 60), shirt(I.chainShirt, 60), body(I.samuraiArmour, 80),
      legs(I.samuraiLegs, 80), boots(I.azuchiBoots, 80),
      back(I.katana, 60, GRADE.industrial),
      carry(I.aidStandard, 2), carry(I.stringOfCats, 5),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'noble-guard',
    category: 'faction',
    label: 'Empire Noble Guard',
    description: 'Karuta zukin and blackened chainmail under Azuchi blue plate, with a nodachi.',
    tags: ['heavy', 'full'],
    items: [
      head(I.karutaZukin, 40), shirt(I.blackChain, 40), body(I.azuchiArmour, 60),
      legs(I.azuchiPants, 60), boots(I.samuraiBoots, 40),
      back(I.nodachi, 60, GRADE.industrial),
      carry(I.aidBasic, 2), carry(I.stringOfCats, 2),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'mercenary-heavy',
    category: 'heavy-melee',
    label: 'Mercenary Heavy',
    description: 'Hachigane, samurai plate and a nodachi — a hired blade with real armour.',
    tags: ['heavy'],
    items: [
      head(I.hachigane, 40), shirt(I.leatherShirt, 40), body(I.samuraiArmour, 40),
      legs(I.samuraiLegs, 40), boots(I.samuraiBoots, 40),
      back(I.nodachi, 40, GRADE.catun1),
      carry(I.aidBasic, 2), carry(I.stringOfCats, 1),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'crab-champion',
    category: 'heavy-melee',
    label: 'Crab Champion',
    description: 'Crab helmet and shell over a falling sun. Heavy, and unmistakable.',
    tags: ['heavy'],
    items: [
      head(I.crabHelm, 60), shirt(I.leatherShirt, 60), body(I.crabArmour, 60),
      legs(I.samuraiLegs, 60), boots(I.platedLongboots, 60),
      back(I.fallingSun, 60, GRADE.mk5),
      carry(I.aidStandard, 2),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },

  // ----------------------------------------------------------- light melee --
  {
    id: 'shinobi-guard',
    category: 'stealth',
    label: 'Shinobi Guard',
    description: 'Mask and blackened chainmail under rags, drifter boots, a ninja blade.',
    tags: ['light', 'stealth'],
    items: [
      head(I.mask1, 40), shirt(I.blackChain, 40), body(I.blackRagShirt, 40),
      legs(I.drifterPants, 40), boots(I.drifterBoots, 40),
      back(I.ninjaBlade, 40, GRADE.catun1),
      carry(I.aidBasic, 2), carry(I.cats, 65),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'assassin',
    category: 'stealth',
    label: 'Assassin',
    description: "Ninja zukin, assassin's rags and a wakizashi. Quiet and lightly armoured.",
    tags: ['light', 'stealth'],
    items: [
      head(I.ninjaZukin, 40), shirt(I.turtleneck, 40), body(I.assassinRags, 60),
      legs(I.ninjaPants, 60), boots(I.woodenSandals, 40),
      hip(I.wakizashi, 50, GRADE.catun4),
      carry(I.aidBasic, 2), carry(I.cats, 100),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'bounty-hunter',
    category: 'light-melee',
    label: 'Bounty Hunter',
    description: 'Mercenary leathers, reinforced cargopants, a desert sabre and plenty of bandages.',
    tags: ['light', 'full'],
    items: [
      head(I.mask1, 40), shirt(I.leatherShirt, 40), body(I.mercLeather, 60),
      legs(I.cargoReinforced, 60), boots(I.drifterBoots, 60),
      back(I.desertSabre, 55, GRADE.mk5),
      pack(I.smallPack), carry(I.aidStandard, 4), carry(I.cats, 100),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'manhunter',
    category: 'light-melee',
    label: 'Manhunter',
    description: 'Masked helmet, mercenary plate and a club — kit for taking people alive.',
    tags: ['blunt'],
    items: [
      head(I.maskedHelm, 20), shirt(I.leatherVest, 20), body(I.mercPlate, 20),
      legs(I.samuraiClothpants, 20), boots(I.platedLongboots, 20),
      hip(I.spikedClub, 20, GRADE.mid),
      carry(I.aidBasic, 2), carry(I.cats, 40),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'police-chief',
    category: 'light-melee',
    label: 'Police Chief',
    description: 'Empire samurai armour over dark leather, and a heavy jitte for cracking heads.',
    tags: ['blunt', 'full'],
    items: [
      head(I.flaredHelm, 40), shirt(I.darkLeatherShirt, 40), body(I.empireSamurai, 40),
      legs(I.samuraiClothpants, 40), boots(I.drifterBoots, 40),
      back(I.heavyJitte, 60, GRADE.industrial),
      carry(I.aidStandard, 2), carry(I.roboticsKit, 1), carry(I.stringOfCats, 2),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'brute',
    category: 'heavy-melee',
    label: 'Brute',
    description: 'A horse chopper and enough plate to survive swinging it.',
    tags: ['heavy', 'blunt'],
    items: [
      head(I.maskedHelm, 60), shirt(I.chainShirt, 60), body(I.mercPlate, 60),
      legs(I.samuraiLegs, 60), boots(I.platedLongboots, 60),
      back(I.horseChopper, 50, GRADE.catun4), hip(I.heavyIronClub, 40, GRADE.catun1),
      carry(I.aidStandard, 3),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'martial-artist',
    category: 'unique',
    label: 'Martial Artist',
    description: 'Wrapped hands and gi pants, no weapon at all. What Seto actually wears.',
    tags: ['light', 'unarmed'],
    items: [
      shirt(I.bindings, 40), body(I.dyedRagShirt, 40),
      legs(I.giPants, 40), boots(I.platedLongboots, 40),
      carry(I.aidStandard, 2), carry(I.foodcube, 4),
    ],
    raceNotes: [ANIMAL],
  },
  {
    id: 'abolitionist',
    category: 'unique',
    label: 'Abolitionist',
    description: "Tinfist's kit: a dustcoat, plated pants, repair kits and no weapon.",
    tags: ['light', 'unarmed', 'legendary'],
    items: [
      body(I.dustcoat, 80), legs(I.platedDrifterPants, 80), boots(I.drifterBoots, 80),
      pack(I.mediumPack), carry(I.roboticsKit, 5), carry(I.aidAdvanced, 5),
    ],
    raceNotes: [ANIMAL],
  },
  {
    id: 'nightstalker',
    category: 'unique',
    label: 'Nightstalker',
    description: "Moll's kit: assassin's rags over dark leather, and a good ninja blade.",
    tags: ['light', 'stealth'],
    items: [
      head(I.armouredHood, 60), shirt(I.darkLeatherShirt, 60), body(I.assassinRags, 60),
      legs(I.drifterPants, 60), boots(I.drifterBoots, 60),
      back(I.ninjaBlade, 60, GRADE.industrial),
      carry(I.aidAdvanced, 3),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'ronin',
    category: 'unique',
    label: 'Ronin',
    description: "Savant's kit: police armour and a Meitou nodachi.",
    tags: ['heavy', 'legendary', 'full'],
    items: [
      head(I.rattanHat, 60), shirt(I.darkLeatherShirt, 60), body(I.policeArmour, 80),
      legs(I.drifterPants, 60), boots(I.platedLongboots, 60),
      back(I.nodachi, 80, GRADE.meitou),
      carry(I.aidAdvanced, 3), carry(I.chewsticks, 4),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'bandit-lord',
    category: 'unique',
    label: 'Bandit Lord',
    description: "The Dust King's kit: spiked helmet, heart protector, samurai legplates.",
    tags: ['heavy', 'full'],
    items: [
      head(I.spikedHelm, 40), shirt(I.darkLeatherShirt, 40), body(I.heartProtector, 40),
      legs(I.samuraiLegs, 40), boots(I.samuraiBoots, 40),
      back(I.fragmentAxe, 40, GRADE.industrial),
      carry(I.aidStandard, 2), carry(I.rum, 2),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'dust-runner',
    category: 'unique',
    label: 'Dust Runner',
    description: "Shryke's kit: stormgoggles, mercenary leathers and a polearm.",
    tags: ['light', 'travel', 'full'],
    items: [
      head(I.stormgoggles, 60), shirt(I.blackChainShirt, 60), body(I.mercLeather, 60),
      legs(I.stoutHessian, 60), boots(I.drifterBoots, 60),
      back(I.polearm, 55, GRADE.mk5),
      pack(I.smallPack), carry(I.chewsticks, 4), carry(I.lantern, 1), carry(I.waterJug, 2),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'robed-scholar',
    category: 'unique',
    label: 'Robed Scholar',
    description: "Longen's kit: dyed robes, a lantern and something strong to drink.",
    tags: ['support'],
    items: [
      body(I.dyedRobes, 40), legs(I.dyedTrousers, 40), boots(I.woodenSandals, 40),
      pack(I.mediumPack), carry(I.bloodrum, 3), carry(I.lantern, 1), carry(I.aidStandard, 2),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'hungry-bandit',
    category: 'starter',
    label: 'Hungry Bandit',
    description: "Crumblejon's kit: a drifter's jacket, a horse chopper and an axe.",
    tags: ['starter'],
    items: [
      shirt(I.bindings, 20), body(I.drifterJacket, 20),
      legs(I.drifterPants, 20), boots(I.drifterBoots, 20),
      back(I.horseChopper, 20, GRADE.mid), hip(I.fragmentAxe, 20, GRADE.mid),
      carry(I.bread, 4), carry(I.aidBasic, 1),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'shinobi-thief',
    category: 'unique',
    label: 'Shinobi Thief',
    description: "Bo's kit: karuta zukin and assassin's rags, with a ninja blade.",
    tags: ['light', 'stealth', 'full'],
    items: [
      head(I.karutaZukin, 40), shirt(I.darkLeatherShirt, 40), body(I.assassinRags, 40),
      legs(I.ninjaPants, 40), boots(I.drifterBoots, 40),
      back(I.ninjaBlade, 40, GRADE.catun1),
      carry(I.rationPack, 4), carry(I.waterJug, 2), carry(I.aidBasic, 2),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },

  // ---------------------------------------------------------------- ranged --
  {
    id: 'crossbow-ranger',
    category: 'ranged',
    label: 'Crossbow Ranger',
    description: 'A Ranger crossbow, a sidearm and a stack of bolts.',
    tags: ['ranged', 'full'],
    items: [
      head(I.dyedTurban, 40), shirt(I.leatherShirt, 40), body(I.tradersLeathers, 40),
      legs(I.hessianUniform, 40), boots(I.platedLongboots, 40),
      back(I.ranger, 40), hip(I.heavyIronClub, 30, GRADE.catun1),
      pack(I.smallPack), carry(I.bolts, 40), carry(I.aidStandard, 2),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'marksman-elite',
    category: 'ranged',
    label: 'Elite Marksman',
    description: "An Eagle's Cross, heavy armour to survive the reload, and a deep bolt supply.",
    tags: ['ranged', 'full'],
    items: [
      head(I.azuchiHelm, 60), shirt(I.chainShirt, 60), body(I.samuraiArmour, 60),
      legs(I.samuraiLegs, 60), boots(I.samuraiBoots, 60),
      back(I.eaglesCross, 60), hip(I.wakizashi, 50, GRADE.catun4),
      pack(I.mediumPack), carry(I.bolts, 80), carry(I.aidStandard, 4),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },

  // --------------------------------------------------------------- support --
  {
    id: 'field-medic',
    category: 'support',
    label: 'Field Medic',
    description: 'Light armour, a big pack, and every kind of medical kit in quantity.',
    tags: ['support', 'full'],
    items: [
      head(I.cap, 40), shirt(I.leatherShirt, 40), body(I.longcoat, 40),
      legs(I.cargoColored, 40), boots(I.drifterBoots, 40),
      hip(I.jitte, 30, GRADE.catun1),
      pack(I.largePack),
      carry(I.aidAdvanced, 10), carry(I.aidStandard, 10), carry(I.skeletonKit, 5),
      carry(I.roboticsKit, 5),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'skeleton-engineer',
    category: 'support',
    label: 'Skeleton Engineer',
    description: 'Rags, a ninja blade and a case of repair kits — kit for a machine that mends machines.',
    tags: ['support'],
    items: [
      body(I.dyedRagShirt, 40), legs(I.samuraiClothpants, 40),
      hip(I.ninjaBlade, 55, GRADE.mk5),
      pack(I.mediumPack), carry(I.roboticsKit, 10), carry(I.skeletonKit, 10),
    ],
    raceNotes: [ANIMAL],
  },
  {
    id: 'caravan-trader',
    category: 'trade',
    label: 'Caravan Trader',
    description: "Trader's leathers, a wooden pack and a great deal of money.",
    tags: ['trade', 'full'],
    items: [
      head(I.cap, 40), shirt(I.leatherVest, 40), body(I.tradersLeathers, 60),
      legs(I.halfpantsPadded, 60), boots(I.woodenSandals, 60),
      hip(I.flatTopper, 40, GRADE.catun1),
      pack(I.tradersPack),
      carry(I.stringOfCats, 40), carry(I.aidStandard, 2), carry(I.driedMeat, 6),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'pack-mule',
    category: 'trade',
    label: 'Pack Mule',
    description: 'The biggest pack and nothing else worth carrying. For hauling.',
    tags: ['trade'],
    items: [
      shirt(I.clothShirt, 20), body(I.tradersLeathers, 20),
      legs(I.halfpantsPadded, 20), boots(I.woodenSandals, 20),
      pack(I.largePack), carry(I.driedMeat, 10), carry(I.aidBasic, 4),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'explorer',
    category: 'travel',
    label: 'Explorer',
    description: 'Longcoat, plated boots, a sleeping bag and food for a long walk.',
    tags: ['travel', 'full'],
    items: [
      head(I.dyedTurban, 40), shirt(I.leatherVest, 40), body(I.longcoat, 60),
      legs(I.cargoColored, 60), boots(I.platedLongboots, 60),
      back(I.topper, 30, GRADE.catun1),
      pack(I.mediumPack),
      carry(I.sleepingBag, 1), carry(I.driedMeat, 8), carry(I.aidStandard, 4),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'desert-nomad',
    category: 'travel',
    label: 'Desert Nomad',
    description: 'Tagelmust and a gorillo pelt against the sun, with a staff.',
    tags: ['travel'],
    items: [
      head(I.tagelmust, 40), shirt(I.gorilloPelt, 40), body(I.dyedRagShirt, 40),
      legs(I.stoutHessian, 40), boots(I.woodenSandals, 40),
      back(I.staff, 20, GRADE.mid),
      carry(I.bread, 6), carry(I.aidBasic, 2),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },

  // --------------------------------------------------------------- starter --
  {
    id: 'drifter',
    category: 'starter',
    label: 'Drifter',
    description: 'A longcoat and a topper. Unremarkable, and that is the point.',
    tags: ['starter'],
    items: [
      head(I.dyedTurban, 20), shirt(I.leatherVest, 20), body(I.longcoat, 40),
      legs(I.cargoColored, 40), boots(I.platedLongboots, 40),
      back(I.topper, 20, GRADE.mid),
      carry(I.aidBasic, 2),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'outlaw-swordsman',
    category: 'starter',
    label: 'Outlaw Swordsman',
    description: 'Straw hat, a heart protector and a rusty horse chopper. Early-game kit.',
    tags: ['starter'],
    items: [
      head(I.strawHat, 20), shirt(I.whiteVest, 20), body(I.heartProtector, 20),
      legs(I.halfpantsColored, 20), boots(I.woodenSandals, 20),
      back(I.horseChopper, 10, GRADE.rusted),
      carry(I.aidBasic, 1), carry(I.cats, 20),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'farmer',
    category: 'starter',
    label: 'Farmer',
    description: 'Straw hat, vest and sandals. No weapon, no armour.',
    tags: ['starter', 'civilian'],
    items: [
      head(I.strawHat, 20), shirt(I.whiteVest, 20), body(I.ragShirt, 20),
      legs(I.ragLoincloth, 20), boots(I.woodenSandals, 20),
      carry(I.bread, 4),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'escaped-slave',
    category: 'starter',
    label: 'Escaped Slave',
    description: 'Rags and shackles, a plank for a weapon. The bottom of the ladder.',
    tags: ['starter', 'civilian'],
    items: [
      body(I.ragShirt, 5), legs(I.ragLoincloth, 5), boots(I.shackles, 5),
      hip(I.plank, 5, GRADE.rusted),
    ],
    raceNotes: [ANIMAL],
  },

  // ------------------------------------------------------------- legendary --
  {
    id: 'meitou-champion',
    category: 'heavy-melee',
    label: 'Meitou Champion',
    description: 'Masterwork plate and a Meitou katana — the best grade the ladder has.',
    tags: ['heavy', 'legendary', 'full'],
    items: [
      head(I.ancientHelm, 95), shirt(I.chainShirt, 95), body(I.ancientArmour, 95),
      legs(I.ancientLegs, 95), boots(I.ancientBoots, 95),
      back(I.naginata, 95, GRADE.meitou), hip(I.katana, 95, GRADE.meitou),
      pack(I.thievesPack), carry(I.aidAdvanced, 5),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },

  // ------------------------------------- the original four (from the scripts) --
  {
    id: 'player-weapons',
    category: 'heavy-melee',
    label: 'Katana + naginata',
    description: 'Edge Type 5 katana on the hip and naginata on the back, level 80.',
    tags: ['weapons'],
    items: [
      hip(I.katana, 80, 'PLAYER_WEAPONS|1069-gamedata.base'),
      back(I.naginata, 80, 'PLAYER_WEAPONS|1069-gamedata.base'),
    ],
    raceNotes: [{ races: ['Dog1', 'Bull', 'Garru', 'Goat', 'Bonedog'], note: 'animal — carries nothing' }],
  },
  {
    id: 'thieves-backpack',
    category: 'stealth',
    label: 'Thieves Backpack',
    description: 'One Thieves Backpack, worn.',
    tags: ['pack'],
    items: [pack(I.thievesPack)],
    raceNotes: [ANIMAL],
  },
  {
    id: 'full-kit',
    category: 'heavy-melee',
    label: 'Ancient Samurai + weapons',
    description: 'The Ancient Samurai set and both Edge Type 5 weapons together.',
    tags: ['heavy', 'full'],
    items: [
      head(I.ancientHelm, 95), shirt(I.chainShirt, 80), body(I.ancientArmour, 95),
      legs(I.ancientLegs, 95), boots(I.ancientBoots, 95),
      hip(I.katana, 80, GRADE.edge5), back(I.naginata, 80, GRADE.edge5),
      pack(I.thievesPack), carry(I.aidAdvanced, 3),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },

  // =========================================================================
  // MEITOU WIELDERS — the 27 named characters the game gives a Meitou weapon
  // =========================================================================
  //
  // WHERE THESE COME FROM, and how far to trust them. Unlike the kits above
  // (read off *live save* NPCs, i.e. whatever gear a spawn happened to roll),
  // every entry below was read off that character's own **type-1 CHARACTER
  // TEMPLATE** in this install's gamedata, resolved across every definition of
  // the sid in `data/mods.cfg` load order — the same union-across-definitions
  // rule the material index and the race rules use, and for the same reason: a
  // mod that re-defines a character purely to swap one garment must not blank
  // the rest of the outfit.
  //
  //   extra['clothing'] -> every armour piece, by template sid
  //   extra['weapons']  -> the weapon, by template sid
  //   extra['inventory']-> what they carry
  //   extra['race']     -> the race, for `raceNotes`
  //   ints['armour grade'] / ints['combat stats'] -> the tier
  //
  // Two things this does NOT claim:
  //   - The template lists what a spawn MAY wear, with `v1` as a percentage
  //     weight; a row weighted 2147483647 is FCS's "removed by a later
  //     definition" sentinel (the same INT32_MAX marker race anatomy uses) and
  //     is excluded here. Where a character's list offers alternatives, the
  //     highest-weighted definition-final row is the one taken.
  //   - The Meitou grade is not on the character record either. It comes from
  //     `extra['weapon level']`, which points at the manufacturer ladder; every
  //     entry here is built for the top rung deliberately, because "the Meitou
  //     wielders" is what the set is for.
  //
  // Grouped by the weapon's own **`ints['skill category']`** on the type-2
  // template — the game's weapon-class field, not this file's opinion:
  // 0 Katanas, 1 Sabres, 2 Blunt, 3 Heavy weapons, 4 Hackers, 8 Polearms.
  // Those are the `tags` below, so the UI's grouped picker files them the way
  // the player thinks of them.

  // ---------------------------------------------------------------- blunt --
  {
    id: 'general-hat-12',
    category: 'unique',
    label: 'General Hat-12',
    description: 'Skeleton general of the Ashlands in armoured rags, with a Meitou heavy jitte.',
    tags: ['meitou', 'blunt', 'legendary'],
    items: [
      shirt(I.blackChainShirt, gradeLevel(5)), body(I.armouredRags, gradeLevel(5)),
      legs(I.ragSkirt, gradeLevel(5)),
      meitouBack(I.heavyJitte),
      carry(I.wrench, 1), carry(I.roboticsKit, 2),
    ],
    raceNotes: [ROBOT, ANIMAL],
  },
  {
    id: 'vault-warden',
    category: 'unique',
    label: 'The Vault Warden',
    description: 'Full samurai plate over a chain shirt, and a Meitou jitte for taking people alive.',
    tags: ['meitou', 'blunt'],
    items: [
      shirt(I.chainShirt, gradeLevel(3)), body(I.samuraiArmour, gradeLevel(3)),
      legs(I.samuraiLegs, gradeLevel(3)), boots(I.samuraiBoots, gradeLevel(3)),
      meitouBack(I.jitte),
      carry(I.aidAdvanced, 1), carry(I.wrench, 1), carry(I.cats, 417),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },

  // -------------------------------------------------------------- hackers --
  {
    id: 'king-gurgler',
    category: 'unique',
    label: 'King Gurgler',
    description: 'The fishman king wears nothing at all and swings a Meitou combat cleaver.',
    tags: ['meitou', 'hackers', 'unarmoured'],
    items: [meitouHip(I.combatCleaver)],
    raceNotes: [ANIMAL],
  },
  {
    id: 'the-preacher',
    category: 'unique',
    label: 'The Preacher',
    description: 'Hiver zealot in a kusari zukin with a Meitou moon cleaver and a purse of cats.',
    tags: ['meitou', 'hackers', 'light'],
    items: [
      head(I.kusariZukin, gradeLevel(null)),
      meitouBack(I.moonCleaver),
      carry(I.cats, 47), carry(I.stringOfCats, 72),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'holy-lord-phoenix',
    category: 'unique',
    label: 'Holy Lord Phoenix',
    description: "The Holy Nation's Phoenix: his own helmet, chest plate, chainmail and legplates, and a Meitou Paladin's Cross.",
    tags: ['meitou', 'hackers', 'heavy', 'full'],
    items: [
      head(I.holyLordHelmet, gradeLevel(null)), shirt(I.holyLordsChainmail, gradeLevel(null)),
      body(I.holyLordsChestPlate, gradeLevel(null)), legs(I.holyLordLegplates, gradeLevel(null)),
      boots(I.holyLordsBoots, gradeLevel(null)),
      meitouBack(I.paladinsCross),
      carry(I.holyFlame, 1), carry(I.stringOfCats, 335),
      carry(I.aidAdvanced, 1), carry(I.splintAdvanced, 1),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'head-of-agriculture',
    category: 'unique',
    label: 'Head of Agriculture',
    description: 'A skeleton in a dyed loincloth, a Meitou short-cleaver and an ancient science book.',
    tags: ['meitou', 'hackers', 'light'],
    items: [
      legs(I.ragLoinclothDyed, gradeLevel(4)),
      meitouHip(I.shortCleaver),
      carry(I.roboticsKit, 1), carry(I.ancientScienceBook, 1),
    ],
    raceNotes: [ROBOT, ANIMAL],
  },

  // -------------------------------------------------------- heavy weapons --
  {
    id: 'gorrillo',
    category: 'unique',
    label: 'Gorrillo',
    description: 'Mercenary leathers over a rusty chain shirt, ragged halfpants, and a Meitou exile plank.',
    tags: ['meitou', 'heavy-weapons', 'heavy'],
    items: [
      shirt(I.rustyChainShirt, gradeLevel(4)), body(I.mercLeather, gradeLevel(4)),
      legs(I.halfpantsRagged, gradeLevel(4)), boots(I.samuraiBoots, gradeLevel(4)),
      meitouBack(I.exilePlank),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'mad-cat-lon',
    category: 'unique',
    label: 'Mad Cat-Lon',
    description: 'Ancient samurai plate and a Meitou falling sun. Combat 100 in the game data — the hardest thing in Kenshi.',
    tags: ['meitou', 'heavy-weapons', 'heavy', 'legendary'],
    items: [
      body(I.ancientArmour, gradeLevel(4)), legs(I.ancientLegs, gradeLevel(4)),
      meitouBack(I.fallingSun),
      carry(I.wrench, 1), carry(I.roboticsKit, 3),
    ],
    raceNotes: [ROBOT, ANIMAL],
  },
  {
    id: 'esata-stone-golem',
    category: 'unique',
    label: 'Esata "The Stone Golem"',
    description: 'The Shek queen: her own chest, pants and boots over blackened chainmail, with a Meitou fragment axe.',
    tags: ['meitou', 'heavy-weapons', 'heavy'],
    items: [
      shirt(I.blackGorilloPelt, gradeLevel(5)), body(I.shekQueenChest, gradeLevel(5)),
      legs(I.shekQueenPants, gradeLevel(5)), boots(I.shekQueenBoots, gradeLevel(5)),
      meitouBack(I.fragmentAxe),
      carry(I.stringOfCats, 286),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'mukai-the-mountain',
    category: 'unique',
    label: 'Mukai The Mountain',
    description: 'A bandana, samurai legplates, plated longboots and a Meitou fragment axe.',
    tags: ['meitou', 'heavy-weapons', 'heavy'],
    items: [
      head(I.bandana, gradeLevel(5)), legs(I.samuraiLegs, gradeLevel(5)),
      boots(I.platedLongboots, gradeLevel(5)),
      meitouBack(I.fragmentAxe),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },

  // -------------------------------------------------------------- katanas --
  {
    id: 'general-jang',
    category: 'unique',
    label: 'General Jang',
    description: 'Ancient samurai plate and a Meitou guardless katana (this install calls it the Slim Katana).',
    tags: ['meitou', 'katanas', 'heavy'],
    items: [
      body(I.ancientArmour, gradeLevel(4)), legs(I.ancientLegs, gradeLevel(4)),
      meitouBack(I.slimKatana),
      carry(I.wrench, 1),
    ],
    raceNotes: [ROBOT, ANIMAL],
  },
  {
    id: 'emperor-tengu',
    category: 'unique',
    label: 'Emperor Tengu',
    description: "The Emperor's robe, hat, pants and jade sandals over a blackened chain shirt, with a Meitou katana.",
    tags: ['meitou', 'katanas', 'light', 'full'],
    items: [
      head(I.tenguHat, gradeLevel(null)), shirt(I.blackChainShirt, gradeLevel(null)),
      body(I.tenguRobe, gradeLevel(null)), legs(I.tenguPants, gradeLevel(null)),
      boots(I.tenguSandals, gradeLevel(null)),
      meitouHip(I.katana),
      carry(I.stringOfCats, 369), carry(I.aidAdvanced, 1), carry(I.luxuryGoods, 1),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'dimak',
    category: 'unique',
    label: 'Dimak',
    description: 'Shek in ninja rags and wooden sandals, with a Meitou ninja blade.',
    tags: ['meitou', 'katanas', 'light', 'stealth'],
    items: [
      body(I.ninjaRags, gradeLevel(null)), legs(I.drifterPants, gradeLevel(null)),
      boots(I.woodenSandals, gradeLevel(null)),
      meitouBack(I.ninjaBlade),
      carry(I.cats, 83), carry(I.stringOfCats, 9),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'savant-meitou',
    category: 'unique',
    label: 'Savant',
    description: "Savant's own kit, exactly as the game defines it: police armour over dark leather, and a Meitou nodachi.",
    tags: ['meitou', 'katanas', 'heavy', 'legendary'],
    items: [
      shirt(I.darkLeatherShirt, gradeLevel(4)), body(I.policeArmour, gradeLevel(4)),
      legs(I.drifterPants, gradeLevel(4)), boots(I.platedLongboots, gradeLevel(4)),
      meitouBack(I.nodachi),
      carry(I.aidAdvanced, 1), carry(I.roboticsKit, 1),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'rhinobot',
    category: 'unique',
    label: 'Rhinobot',
    description: 'A P4 unit in armoured rags with a Meitou topper.',
    tags: ['meitou', 'katanas', 'light'],
    items: [
      body(I.armouredRags, gradeLevel(4)), legs(I.ragSkirt, gradeLevel(4)),
      meitouBack(I.topper),
      carry(I.wrench, 1),
    ],
    raceNotes: [ROBOT, ANIMAL],
  },
  {
    id: 'lady-kana',
    category: 'unique',
    label: 'Lady Kana',
    description: "Noble's robe and trousers over a dyed turtleneck, a mask, and a Meitou wakizashi.",
    tags: ['meitou', 'katanas', 'light', 'full'],
    items: [
      head(I.mask3, gradeLevel(4)), shirt(I.turtleneck, gradeLevel(4)),
      body(I.noblesRobe, gradeLevel(4)), legs(I.noblesTrousers, gradeLevel(4)),
      boots(I.drifterBoots, gradeLevel(4)),
      meitouHip(I.wakizashi),
      carry(I.aidAdvanced, 1), carry(I.luxuryGoods, 1), carry(I.narcotics, 1), carry(I.grog, 1),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'slave-mistress-grace',
    category: 'unique',
    label: 'Slave Mistress Grace',
    description: "Noble's robes over martial-artist bindings, and a Meitou wakizashi.",
    tags: ['meitou', 'katanas', 'light'],
    items: [
      shirt(I.bindings, gradeLevel(4)), body(I.noblesRobe, gradeLevel(4)),
      legs(I.noblesTrousers, gradeLevel(4)), boots(I.drifterBoots, gradeLevel(4)),
      meitouHip(I.wakizashi),
      carry(I.stringOfCats, 9), carry(I.aidAdvanced, 1), carry(I.luxuryGoods, 1), carry(I.narcotics, 1),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'slave-mistress-ren',
    category: 'unique',
    label: 'Slave Mistress Ren',
    description: "Grace's counterpart — the same noble's robes, no bindings, the same Meitou wakizashi.",
    tags: ['meitou', 'katanas', 'light'],
    items: [
      body(I.noblesRobe, gradeLevel(4)), legs(I.noblesTrousers, gradeLevel(4)),
      boots(I.drifterBoots, gradeLevel(4)),
      meitouHip(I.wakizashi),
      carry(I.stringOfCats, 11), carry(I.aidAdvanced, 1), carry(I.luxuryGoods, 1), carry(I.grog, 1),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },

  // ------------------------------------------------------------- polearms --
  {
    id: 'screamer-the-false',
    category: 'unique',
    label: 'Screamer the False',
    description: 'Armoured rags and a Meitou heavy polearm, on a Screamer MkI frame.',
    tags: ['meitou', 'polearms', 'light'],
    items: [
      body(I.armouredRags, gradeLevel(3)), legs(I.ragSkirt, gradeLevel(3)),
      meitouBack(I.heavyPolearm),
      carry(I.roboticsKit, 1),
    ],
    raceNotes: [ROBOT, ANIMAL],
  },
  {
    id: 'crab-queen',
    category: 'unique',
    label: 'Crab Queen',
    description: 'The full crab shell — armour, trousers and shoes over a rusty chain shirt — with a Meitou naginata.',
    tags: ['meitou', 'polearms', 'heavy'],
    items: [
      shirt(I.rustyChainShirt, gradeLevel(4)), body(I.crabArmour, gradeLevel(4)),
      legs(I.crabTrousers, gradeLevel(4)), boots(I.crabShoes, gradeLevel(4)),
      meitouBack(I.naginata),
      carry(I.stringOfCats, 80), carry(I.aidBasic, 1),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'queen-of-the-south',
    category: 'unique',
    label: 'Queen of the South',
    description: 'The southern Hive Queen wears nothing and carries a Meitou polearm.',
    tags: ['meitou', 'polearms', 'unarmoured'],
    items: [meitouBack(I.polearm)],
    raceNotes: [ANIMAL],
  },
  {
    id: 'spider-foreman',
    category: 'unique',
    label: 'Spider Foreman',
    description: 'An unarmoured Screamer MkI with a Meitou staff.',
    tags: ['meitou', 'polearms', 'unarmoured'],
    items: [meitouBack(I.staff)],
    raceNotes: [ROBOT, ANIMAL],
  },

  // --------------------------------------------------------------- sabres --
  {
    id: 'eyegore',
    category: 'unique',
    label: 'Eyegore',
    description: 'Azuchi blue heavy plate and a Meitou desert sabre. Strength 99 in the game data.',
    tags: ['meitou', 'sabres', 'heavy', 'legendary'],
    items: [
      body(I.azuchiArmour, gradeLevel(4)), legs(I.azuchiPants, gradeLevel(4)),
      meitouBack(I.desertSabre),
      carry(I.pearlCup, 2), carry(I.sake, 1), carry(I.aidBasic, 1),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'bugmaster-meitou',
    category: 'unique',
    label: 'Bugmaster',
    description: 'Combat 95 and a Meitou foreign sabre, wearing a rag loincloth and nothing else.',
    tags: ['meitou', 'sabres', 'legendary', 'unarmoured'],
    items: [
      legs(I.ragLoincloth, gradeLevel(1)),
      meitouBack(I.foreignSabre),
      carry(I.aidBasic, 1),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'ponk',
    category: 'unique',
    label: 'Ponk',
    description: 'Armoured rags on a skeleton frame, with a Meitou holed sabre.',
    tags: ['meitou', 'sabres', 'light'],
    items: [
      body(I.armouredRags, gradeLevel(3)), legs(I.ragSkirt, gradeLevel(3)),
      meitouBack(I.holedSabre),
      carry(I.roboticsKit, 1),
    ],
    raceNotes: [ROBOT, ANIMAL],
  },
  {
    id: 'red-sabre-boss',
    category: 'unique',
    label: 'Red Sabre Boss',
    description: 'Bandana and armoured rags, a Meitou horse chopper, and someone else’s cats.',
    tags: ['meitou', 'sabres', 'light'],
    items: [
      head(I.bandana, gradeLevel(3)), body(I.armouredRags, gradeLevel(3)),
      legs(I.ragSkirt, gradeLevel(3)), boots(I.drifterBoots, gradeLevel(3)),
      meitouBack(I.horseChopper),
      carry(I.cats, 197), carry(I.sake, 1), carry(I.aidBasic, 1),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'longen-meitou',
    category: 'unique',
    label: 'Longen',
    description: "Longen's dyed robes and a Meitou longsword (this install calls it the Flat Topper).",
    tags: ['meitou', 'sabres', 'support'],
    items: [
      body(I.dyedRobes, gradeLevel(null)), legs(I.dyedTrousers, gradeLevel(null)),
      boots(I.drifterBoots, gradeLevel(null)),
      meitouHip(I.flatTopper),
      carry(I.bloodrum, 1),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'valamon',
    category: 'unique',
    label: 'Valamon',
    description: 'Hack stopper jacket and pants over a black cloth shirt, a Meitou longsword on the hip and a plank on the back.',
    tags: ['meitou', 'sabres', 'heavy'],
    items: [
      shirt(I.blackClothShirt, gradeLevel(4)), body(I.hackStopperJacket, gradeLevel(4)),
      legs(I.hackStopperPants, gradeLevel(4)), boots(I.samuraiBoots, gradeLevel(4)),
      meitouHip(I.flatTopper), meitouBack(I.plank),
      carry(I.cats, 277), carry(I.stringOfCats, 55),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'elder',
    category: 'unique',
    label: 'Elder',
    description: 'A P4 unit with nothing on and a Meitou ringed sabre.',
    tags: ['meitou', 'sabres', 'unarmoured'],
    items: [
      meitouBack(I.ringedSabre),
      carry(I.roboticsKit, 1),
    ],
    raceNotes: [ROBOT, ANIMAL],
  },

  // =========================================================================
  // PART 2 EXPANSION — the same method, widened past the Meitou wielders
  // =========================================================================
  //
  // Every entry from here down was read off a type-1 CHARACTER TEMPLATE in
  // this install's gamedata, exactly like the Meitou block above: resolved in
  // `data/mods.cfg` load order, `extra` rows unioned across every definition
  // of the sid, armour tier taken from the template's own `ints['armour
  // grade']` through `gradeLevel()`, never guessed. The sweep covered every
  // template with `ints['combat stats'] > 0` (448 on this install after load
  // -order resolution — see the header comment's own count, which was taken
  // on a different install/mod-set and does not match this one; the method is
  // identical, only the numbers differ machine to machine).
  //
  // Two kinds of new entry:
  //   - FACTION / generic rank kits: a template's own `extra['faction']` row
  //     names the faction outright (Shek Kingdom, Traders Guild, Slave
  //     Traders, ...). Where a template offers several equally-weighted
  //     alternatives per slot, the first is taken and the rest are not a
  //     documented choice — the same caveat the Meitou header states for
  //     "MAY wear" lists.
  //   - Further named characters: real individuals with a small, unambiguous
  //     clothing/weapon list, not already covered by the Meitou set.
  //
  // ANIMAL LOADOUTS close a question the file previously answered wrong: the
  // `ANIMAL` note above claims an animal "wears and carries nothing", and that
  // is false for exactly two races. `Garru Backpack` (4002-gamedata.base) and
  // `Bull Backpack` (43948-rebirth.mod) are real type-46 templates, each
  // whitelisted via `extra['races']` to one race and nothing else — the game
  // DOES put something on a pack animal, just never armour or a weapon. See
  // `PACK_ANIMAL` above.

  // --------------------------------------------------------------- ranged --
  {
    id: 'junkbow-scavenger',
    category: 'ranged',
    label: 'Junkbow Scavenger',
    description: 'A Junkbow held together with hope, and an iron club for when it jams.',
    tags: ['ranged', 'starter'],
    items: [
      head(I.dyedTurban, 20), shirt(I.leatherShirt, 20), body(I.drifterJacket, 20),
      legs(I.cargoColored, 20), boots(I.drifterBoots, 20),
      back(I.junkbow, 20), hip(I.ironClub, 20, GRADE.mid),
      carry(I.bolts, 20), carry(I.aidBasic, 2),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'spring-bat-sniper',
    category: 'ranged',
    label: 'Spring-Bat Sniper',
    description: 'A Spring-Bat crossbow, mercenary leathers to survive closing the distance, and a deep bolt reserve.',
    tags: ['ranged', 'full'],
    items: [
      head(I.stormgoggles, 60), shirt(I.chainShirt, 60), body(I.mercLeather, 60),
      legs(I.cargoReinforced, 60), boots(I.platedLongboots, 60),
      back(I.springBat, 60), hip(I.wakizashi, 50, GRADE.catun4),
      pack(I.mediumPack), carry(I.boltsLong, 60), carry(I.aidStandard, 3),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'crossbow-skirmisher',
    category: 'ranged',
    label: 'Crossbow Skirmisher',
    description: 'Light enough to reposition between shots: a Ranger crossbow backed by a desert sabre, not the Elite Marksman’s plate.',
    tags: ['ranged', 'light'],
    items: [
      head(I.cap, 40), shirt(I.leatherVest, 40), body(I.tradersLeathers, 40),
      legs(I.halfpantsPadded, 40), boots(I.woodenSandals, 40),
      back(I.ranger, 40), hip(I.desertSabre, 40, GRADE.catun1),
      carry(I.bolts, 30), carry(I.aidStandard, 2),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },

  // -------------------------------------------------------------- stealth --
  {
    id: 'swamp-ninja',
    category: 'stealth',
    label: 'Swamp Ninja',
    description: "What the Swamp Ninjas gang puts on a Jonin: dyed rags under cargopants, a slim katana.",
    tags: ['stealth', 'light', 'katanas'],
    items: [
      shirt(I.leatherTurtleneck, 20), body(I.dyedRagShirt, 20),
      legs(I.cargoColored, 20), boots(I.platedLongboots, 20),
      back(I.slimKatana, 20, GRADE.mid),
      carry(I.aidBasic, 2), carry(I.cats, 30),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'jonin-elite',
    category: 'stealth',
    label: 'Jonin Elite',
    description: "A Hunters Guild Jonin's own kit: dark leather under armoured rags, a ninja blade.",
    tags: ['stealth', 'light', 'katanas'],
    items: [
      shirt(I.darkLeatherShirt, 60), body(I.armouredRags, 60),
      legs(I.samuraiClothpants, 60), boots(I.drifterBoots, 60),
      back(I.ninjaBlade, 60, GRADE.industrial),
      carry(I.aidBasic, 2), carry(I.stringOfCats, 3),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },

  // ------------------------------------------------------------- support --
  {
    id: 'combat-medic',
    category: 'support',
    label: 'Combat Medic',
    description: "A longcoat over reinforced cargopants, a polearm for when the front line reaches the aid station, and a deep medical reserve.",
    tags: ['support', 'full'],
    items: [
      head(I.cap, 60), shirt(I.leatherShirt, 60), body(I.longcoat, 60),
      legs(I.cargoReinforced, 60), boots(I.drifterBoots, 60),
      back(I.polearm, 55, GRADE.mk5),
      pack(I.largePack),
      carry(I.aidAdvanced, 8), carry(I.splintAdvanced, 5), carry(I.aidStandard, 5),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'field-mechanic',
    category: 'support',
    label: 'Field Mechanic',
    description: 'A drifter’s outfit, a spiked club for trouble, and enough robotics kits to rebuild a squad of skeletons on the road.',
    tags: ['support', 'full'],
    items: [
      head(I.armouredHood, 40), shirt(I.leatherShirt, 40), body(I.longcoat, 40),
      legs(I.cargoColored, 40), boots(I.drifterBoots, 40),
      hip(I.spikedClub, 30, GRADE.catun1),
      pack(I.mediumPack), carry(I.roboticsKit, 8), carry(I.wrench, 2),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'camp-doctor',
    category: 'support',
    label: 'Camp Doctor',
    description: 'Dyed robes and nothing sharp — stays behind the line and empties a huge medical reserve into whoever needs it.',
    tags: ['support', 'unarmed'],
    items: [
      body(I.dyedRobes, 40), legs(I.dyedTrousers, 40), boots(I.woodenSandals, 40),
      pack(I.largePack),
      carry(I.aidAdvanced, 15), carry(I.splintKit, 10), carry(I.chewsticks, 5),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },

  // ---------------------------------------------------------------- trade --
  {
    id: 'wandering-merchant',
    category: 'trade',
    label: 'Wandering Merchant',
    description: 'A dyed turban and a longcoat, a Trader’s Pack full of luxury goods, and a club for the one bandit who tries anyway.',
    tags: ['trade', 'full'],
    items: [
      head(I.dyedTurban, 40), shirt(I.leatherVest, 40), body(I.longcoat, 40),
      legs(I.cargoColored, 40), boots(I.woodenSandals, 40),
      hip(I.flatTopper, 20, GRADE.mid),
      pack(I.tradersPack), carry(I.luxuryGoods, 3), carry(I.stringOfCats, 20), carry(I.aidStandard, 2),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'black-market-dealer',
    category: 'trade',
    label: 'Black Market Dealer',
    description: 'Dyed robes, a purse worth robbing, and a pack of narcotics and grog for a trade the Traders Guild does not license.',
    tags: ['trade', 'unarmed'],
    items: [
      body(I.dyedRobes, 40), legs(I.dyedTrousers, 40), boots(I.woodenSandals, 40),
      pack(I.mediumPack), carry(I.narcotics, 5), carry(I.sake, 2), carry(I.cats, 100),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'cargo-hauler',
    category: 'trade',
    label: 'Cargo Hauler',
    description: 'Plain cloth and a huge pack, loaded with raw armour plating and chainmail sheets — the actual freight, not the finished goods.',
    tags: ['trade'],
    items: [
      shirt(I.clothShirt, 20), body(I.tradersLeathers, 20),
      legs(I.halfpantsPadded, 20), boots(I.woodenSandals, 20),
      pack(I.largePack), carry(I.armourPlating, 5), carry(I.chainmailSheets, 5), carry(I.driedMeat, 6),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },

  // --------------------------------------------------------------- travel --
  {
    id: 'wasteland-scout',
    category: 'travel',
    label: 'Wasteland Scout',
    description: 'Stormgoggles against the dust, a staff, and enough food and water to cross open desert alone.',
    tags: ['travel', 'light'],
    items: [
      head(I.stormgoggles, 40), shirt(I.blackChainShirt, 40), body(I.mercLeather, 40),
      legs(I.stoutHessian, 40), boots(I.drifterBoots, 40),
      back(I.staff, 20, GRADE.mid),
      pack(I.smallPack), carry(I.waterJug, 3), carry(I.food, 4), carry(I.aidStandard, 2),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'long-hauler',
    category: 'travel',
    label: 'Long Hauler',
    description: 'Heavier travel gear than the Explorer: a sleeping bag and rations for weeks on the road, no weapon at all.',
    // Not `full`: deliberately no helmet and no shirt. This is road gear, and
    // `full` means all five armour slots dressed (test/equip.test.js asserts it).
    tags: ['travel', 'unarmed'],
    items: [
      body(I.longcoat, 60), legs(I.cargoReinforced, 60), boots(I.platedLongboots, 60),
      pack(I.largePack), carry(I.sleepingBag, 1), carry(I.food, 10), carry(I.water, 6), carry(I.aidAdvanced, 2),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'caravan-outrider',
    category: 'travel',
    label: 'Caravan Outrider',
    description: "Trader's leathers and a Hessian uniform, a polearm to keep raiders off the wagons.",
    tags: ['travel', 'full', 'polearms'],
    items: [
      head(I.dyedTurban, 40), shirt(I.leatherVest, 40), body(I.tradersLeathers, 60),
      legs(I.hessianUniform, 60), boots(I.drifterBoots, 60),
      back(I.polearm, 55, GRADE.mk5),
      pack(I.mediumPack), carry(I.waterJug, 2), carry(I.driedMeat, 6), carry(I.aidStandard, 2),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },

  // ---------------------------------------------------------- light melee --
  {
    id: 'duelist',
    category: 'light-melee',
    label: 'Duelist',
    description: 'Assassin’s rags and a bandana — no shield of armour, just a ringed sabre and confidence.',
    tags: ['light', 'sabres'],
    items: [
      head(I.bandana, 40), shirt(I.darkLeatherShirt, 40), body(I.assassinRags, 40),
      legs(I.drifterPants, 40), boots(I.drifterBoots, 40),
      hip(I.ringedSabre, 50, GRADE.catun4),
      carry(I.aidStandard, 2), carry(I.cats, 50),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'brawler',
    category: 'light-melee',
    label: 'Brawler',
    description: 'Wrapped hands and a dyed rag shirt, but unlike the Martial Artist this one keeps an iron club on the hip.',
    tags: ['light', 'blunt'],
    items: [
      shirt(I.bindings, 20), body(I.dyedRagShirt, 20),
      legs(I.giPants, 20), boots(I.woodenSandals, 20),
      hip(I.ironClub, 20, GRADE.mid),
      carry(I.aidBasic, 2),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },

  // -------------------------------------------------------------- faction --
  {
    id: 'shek-warrior',
    category: 'faction',
    label: 'Shek Warrior',
    description: 'The Shek Kingdom’s common fighter: bindings, samurai legplates, plated longboots, and a plank.',
    tags: ['faction', 'light'],
    items: [
      shirt(I.bindings, 20), legs(I.samuraiLegs, 20), boots(I.platedLongboots, 20),
      hip(I.plank, 20, GRADE.mid),
      carry(I.aidBasic, 1), carry(I.cats, 20),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'shek-hundred-guardian',
    category: 'faction',
    label: 'Shek Hundred Guardian',
    description: "The Shek Kingdom's elite: samurai armour over bindings, legplates, plated longboots — still just a plank.",
    tags: ['faction', 'heavy'],
    items: [
      shirt(I.bindings, 40), body(I.samuraiArmour, 40),
      legs(I.samuraiLegs, 40), boots(I.platedLongboots, 40),
      hip(I.plank, 40, GRADE.catun1),
      carry(I.aidBasic, 2), carry(I.stringOfCats, 2),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'holy-nation-paladin',
    category: 'faction',
    label: 'Holy Nation Paladin',
    description: "The Holy Nation's own inquisitor kit: hachigane, chain shirt and a holy chest plate, a Paladin's Cross and a horse chopper.",
    tags: ['faction', 'heavy', 'full'],
    items: [
      head(I.paladinHachigane, 60), shirt(I.chainShirt, 60), body(I.holyChestPlate, 60),
      legs(I.stoutHessian, 60), boots(I.platedLongboots, 60),
      back(I.paladinsCross, 60, GRADE.industrial), hip(I.horseChopper, 50, GRADE.catun1),
      carry(I.stringOfCats, 5), carry(I.aidBasic, 2),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'holy-nation-citizen',
    category: 'faction',
    label: 'Holy Nation Citizen',
    description: 'A Holy Nation civilian: dyed robes and trousers, wooden sandals, no weapon — the ordinary look under Prophet law.',
    tags: ['faction', 'civilian'],
    items: [
      body(I.dyedRobes, 20), legs(I.dyedTrousers, 20), boots(I.woodenSandals, 20),
      carry(I.cats, 10),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'traders-guild-noble',
    category: 'faction',
    label: 'Traders Guild Noble',
    description: "A Noble Hunter's own kit: stormgoggles, blackened chainmail, a noble's robe and trousers, a flat topper.",
    tags: ['faction', 'light'],
    items: [
      head(I.stormgoggles, 80), shirt(I.blackChain, 80), body(I.noblesRobe, 80),
      legs(I.noblesTrousers, 80), boots(I.woodenSandals, 80),
      hip(I.flatTopper, 60, GRADE.catun4),
      carry(I.stringOfCats, 10), carry(I.aidAdvanced, 1), carry(I.boltsLong, 20),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'traders-guild-slave-master',
    category: 'faction',
    label: 'Traders Guild Slave Master',
    description: "A Slave Master's own kit: the same noble's robe and trousers as the Noble Hunter, but for running a slave market rather than escorting caravans.",
    tags: ['faction', 'light'],
    items: [
      body(I.noblesRobe, 80), legs(I.noblesTrousers, 80), boots(I.woodenSandals, 80),
      hip(I.flatTopper, 60, GRADE.catun4),
      carry(I.stringOfCats, 10), carry(I.aidAdvanced, 1), carry(I.luxuryGoods, 1), carry(I.narcotics, 1),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'slave-traders-boss',
    category: 'faction',
    label: 'Slave Traders Boss',
    description: 'A Slaver Boss’s own kit: dyed turban and robes over a black cloth shirt, a heavy iron club and a spare on the hip.',
    tags: ['faction', 'blunt'],
    items: [
      head(I.dyedTurban, 40), shirt(I.blackClothShirt, 40), body(I.dyedRobes, 40),
      legs(I.dyedTrousers, 40), boots(I.platedLongboots, 40),
      back(I.heavyIronClub, 40, GRADE.catun1), hip(I.ironClubRebirth, 30, GRADE.mid),
      carry(I.cats, 20), carry(I.stringOfCats, 5), carry(I.aidStandard, 1), carry(I.splintKit, 1),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'slave-traders-grunt',
    category: 'faction',
    label: 'Slave Traders Grunt',
    description: "A Slaver's own kit: a turban, trader's leathers and an iron club — the escort a slave caravan actually travels with.",
    tags: ['faction', 'blunt'],
    items: [
      head(I.dyedTurban, 20), shirt(I.blackClothShirt, 20), body(I.tradersLeathers, 20),
      legs(I.samuraiClothpants, 20), boots(I.platedLongboots, 20),
      hip(I.ironClubRebirth, 20, GRADE.mid),
      pack(I.smallPack), carry(I.aidStandard, 1), carry(I.splintKit, 1),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'swampers-gate-guard',
    category: 'faction',
    label: 'Swampers Gate Guard',
    description: "A Swamper Gate Guard's own kit: a rattan hat, longcoat and reinforced cargopants, a naginata katana and a holed sabre on the hip.",
    tags: ['faction', 'heavy', 'full'],
    items: [
      head(I.rattanHat, 80), shirt(I.clothShirt, 80), body(I.longcoat, 80),
      legs(I.cargoReinforced, 80), boots(I.drifterBoots, 80),
      back(I.naginataKatana, 60, GRADE.catun4), hip(I.holedSabre, 50, GRADE.catun1),
      carry(I.splintKit, 1), carry(I.aidStandard, 1), carry(I.cats, 10), carry(I.bolts, 10),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'cannibal-chief',
    category: 'faction',
    label: 'Cannibal Chief',
    description: 'What the Cannibals actually wear: nothing. An iron club, a long cleaver on the back, and a first aid kit for after.',
    tags: ['faction', 'unarmoured', 'blunt'],
    items: [
      hip(I.ironClub, 20, GRADE.mid), back(I.longCleaver, 15, GRADE.rusted),
      carry(I.aidBasic, 1),
    ],
    raceNotes: [ANIMAL],
  },
  {
    id: 'white-eyebrow',
    category: 'faction',
    label: 'White Eyebrow Clansman',
    description: 'A bandana and a gi over a chain shirt, a long cleaver — the White Eyebrow Clan’s own look.',
    tags: ['faction', 'light'],
    items: [
      head(I.bandana, 20), shirt(I.chainShirt, 20), body(I.gi, 20), legs(I.giPants, 20),
      back(I.longCleaver, 20, GRADE.mid),
      carry(I.cats, 10),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'red-sabre-grunt',
    category: 'faction',
    label: 'Red Sabre Grunt',
    description: 'A bandana and mercenary leather armour, an ordinary horse chopper — the rank and file the Boss commands.',
    tags: ['faction', 'heavy'],
    items: [
      head(I.bandana, 20), body(I.mercLeather, 20), legs(I.cargoColored, 20), boots(I.drifterBoots, 20),
      hip(I.horseChopper, 15, GRADE.rusted),
      carry(I.cats, 15), carry(I.aidBasic, 1),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'kral-schosen',
    category: 'faction',
    label: "Kral's Chosen",
    description: "One of Kral's Chosen: a kusari zukin, ninja rags, samurai legplates — a Shek honour guard.",
    tags: ['faction', 'light'],
    items: [
      head(I.kusariZukin, 20), shirt(I.bindings, 20), body(I.ninjaRags, 20),
      legs(I.samuraiLegs, 20), boots(I.platedLongboots, 20),
      hip(I.plank, 20, GRADE.mid),
      carry(I.cats, 10), carry(I.aidBasic, 1),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'hive-prince',
    category: 'faction',
    label: 'Hive Prince',
    description: 'A Hive Prince wears nothing at all and carries a long cleaver — Hive royalty, not a soldier.',
    tags: ['faction', 'unarmoured', 'blunt'],
    items: [
      hip(I.longCleaver, 40, GRADE.catun1),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },

  // --------------------------------------------------------------- unique --
  {
    id: 'sir-testalot',
    category: 'unique',
    label: 'Sir Testalot',
    description: "Sir Testalot's own kit: assassin's rags over drifter's pants, a foreign sabre. Combat 100 in the game data.",
    tags: ['light', 'sabres', 'legendary'],
    items: [
      body(I.assassinRags, 40), legs(I.drifterPants, 40),
      back(I.foreignSabre, 40, GRADE.catun1),
      carry(I.aidBasic, 1),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'armour-king',
    category: 'unique',
    label: 'Armour King',
    description: "The Armour King's own kit: Azuchi blue heavy plate, a Falling Sun. Skeleton-built, grade 5.",
    tags: ['heavy', 'legendary'],
    items: [
      body(I.azuchiArmour, 95), legs(I.azuchiPants, 95),
      back(I.fallingSun, 80, GRADE.edge5),
      carry(I.stringOfCats, 1), carry(I.roboticsKit, 2),
    ],
    raceNotes: [ROBOT, ANIMAL],
  },
  {
    id: 'armour-kings-thrall',
    category: 'unique',
    label: "Armour King's Thrall",
    description: 'A Skeleton No-Head unit, unarmoured, carrying a long cleaver and its own spare plating.',
    tags: ['heavy-weapons', 'unarmoured'],
    items: [
      back(I.longCleaver, 80, GRADE.catun4),
      carry(I.armourPlating, 1), carry(I.chainmailSheets, 1),
    ],
    raceNotes: [ANIMAL],
  },
  {
    id: 'yayoi',
    category: 'unique',
    label: 'Yayoi',
    description: "Yayoi's own kit: dark leather under assassin's rags, plated longboots, a ninja blade.",
    tags: ['light', 'katanas'],
    items: [
      shirt(I.darkLeatherShirt, 80), body(I.assassinRags, 80),
      legs(I.drifterPants, 80), boots(I.platedLongboots, 80),
      back(I.ninjaBlade, 80, GRADE.catun4),
      carry(I.aidAdvanced, 1),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'dack',
    category: 'unique',
    label: 'Dack',
    description: "Dack's own kit: a dustcoat and nothing else, a Moon Cleaver.",
    tags: ['heavy-weapons', 'light'],
    items: [
      body(I.dustcoat, 40),
      back(I.moonCleaver, 40, GRADE.catun1),
      carry(I.wrench, 1),
    ],
    raceNotes: [ROBOT, ANIMAL],
  },
  {
    id: 'arc',
    category: 'unique',
    label: 'Arc',
    description: "Arc's own kit: a karuta zukin, blackened chainmail and armoured rags, a ringed sabre.",
    tags: ['light', 'sabres'],
    items: [
      head(I.karutaZukin, 60), shirt(I.blackChain, 60), body(I.armouredRags, 60),
      legs(I.drifterPants, 60), boots(I.drifterBoots, 60),
      back(I.ringedSabre, 60, GRADE.industrial),
      carry(I.stringOfCats, 2), carry(I.aidBasic, 1),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'experienced-man',
    category: 'unique',
    label: 'Experienced Man',
    description: "The Experienced Man's own kit: an iron hat and blackened chainmail, a topper on the back and a wakizashi on the hip, rations for the road.",
    // Not `full`: the chainmail IS the torso here, worn in the `shirt` slot
    // with nothing over it, so the `armour` slot is empty by design.
    tags: ['light', 'katanas'],
    items: [
      head(I.ironHat, 95), shirt(I.blackChain, 95),
      legs(I.halfpantsPadded, 95), boots(I.platedLongboots, 95),
      back(I.topper, 55, GRADE.mk5), hip(I.wakizashi, 50, GRADE.catun4),
      carry(I.aidBasic, 1), carry(I.bread, 2), carry(I.food, 2), carry(I.water, 2),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'elite-hunter',
    category: 'unique',
    label: 'Elite Hunter',
    description: "The Elite Hunter's own kit: full Azuchi blue plate, a slim katana on the back and a ninja blade on the hip.",
    tags: ['heavy', 'katanas', 'full'],
    items: [
      head(I.azuchiHelmet, 60), shirt(I.chainShirt, 60), body(I.azuchiArmour, 60),
      legs(I.azuchiPants, 60), boots(I.azuchiBoots, 60),
      back(I.slimKatana, 60, GRADE.industrial), hip(I.ninjaBlade, 55, GRADE.mk5),
      carry(I.stringOfCats, 2), carry(I.aidBasic, 1),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'the-five-invincibles',
    category: 'unique',
    label: 'The Five Invincibles',
    description: "The Five Invincibles' own kit: armoured face plates, blackened chainmail and armoured rags, a Fragment Axe.",
    tags: ['heavy-weapons', 'heavy'],
    items: [
      head(I.armouredFacePlates, 80), shirt(I.blackChain, 80), body(I.armouredRags, 80),
      legs(I.samuraiLegs, 80), boots(I.samuraiBoots, 80),
      back(I.fragmentAxe, 80, GRADE.catun4),
      carry(I.stringOfCats, 2), carry(I.aidBasic, 1),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'big-grim',
    category: 'unique',
    label: 'Big Grim',
    description: "Big Grim's own kit: square goggles, a leather vest and sleeveless longcoat, a ringed sabre.",
    tags: ['light', 'sabres'],
    items: [
      head(I.squareGoggles, 60), shirt(I.leatherVest, 60), body(I.sleevelessLongcoat, 60),
      legs(I.drifterPants, 60), boots(I.drifterBoots, 60),
      back(I.ringedSabre, 60, GRADE.industrial),
      carry(I.splintKit, 1), carry(I.aidStandard, 1), carry(I.stringOfCats, 1),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'no-face',
    category: 'unique',
    label: 'No-Face',
    description: "No-Face's own kit: a dyed rag shirt and dyed loincloth, wooden sandals, an iron club and a flat topper.",
    tags: ['sabres', 'blunt', 'light'],
    items: [
      body(I.dyedRagShirt, 60), legs(I.ragLoinclothDyed, 60), boots(I.woodenSandals, 60),
      back(I.flatTopper, 55, GRADE.catun1), hip(I.ironClubRebirth, 60, GRADE.industrial),
      carry(I.aidStandard, 1), carry(I.driedMeat, 2),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'general-screamer-true',
    category: 'unique',
    label: 'General Screamer (The True)',
    description: 'A Skeleton MKII Screamer in armoured rags, wielding a Naginata Katana. Not the same character as Screamer the False.',
    tags: ['polearms', 'heavy-weapons', 'light'],
    items: [
      body(I.armouredRags, 95), legs(I.ragSkirt, 95),
      back(I.naginataKatana, 80, GRADE.edge5),
      carry(I.wrench, 1),
    ],
    raceNotes: [ROBOT, ANIMAL],
  },
  {
    id: 'iyo',
    category: 'unique',
    label: 'Iyo',
    description: "A P4 Unit of the Adventurers Guild, in a leather shirt and monk pants, unarmed.",
    tags: ['light', 'unarmed'],
    items: [
      shirt(I.leatherShirt, 20), legs(I.monkPants, 20),
    ],
    raceNotes: [ROBOT, ANIMAL],
  },
  {
    id: 'finch',
    category: 'unique',
    label: 'Finch',
    description: "A Hive Prince of the Adventurers Guild, in square goggles, a leather shirt and monk pants, unarmed.",
    tags: ['light', 'unarmed'],
    items: [
      head(I.squareGoggles, 20), shirt(I.leatherShirt, 20), legs(I.monkPants, 20),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },

  // --------------------------------------------------------------- animal --
  // Not editorial guesswork: `Bull Backpack`/`Garru Backpack` are real type-46
  // templates in this install's gamedata, each `extra['races']`-whitelisted to
  // exactly one race (see PACK_ANIMAL above). No armour or weapon template
  // anywhere in this install's data is race-restricted TO an animal, which is
  // why these two are packs and nothing else — that is the honest limit of
  // what the game itself puts on a pack animal, not a shortfall in the sweep.
  {
    id: 'pack-bull',
    category: 'animal',
    label: 'Pack Bull',
    description: 'A Bull Backpack — whitelisted by the game to Bull alone — loaded with dried meat for a caravan run.',
    tags: ['animal', 'trade'],
    items: [
      pack(I.bullBackpack), carry(I.driedMeat, 10), carry(I.aidBasic, 2),
    ],
    raceNotes: [PACK_ANIMAL],
  },
  {
    id: 'pack-garru',
    category: 'animal',
    label: 'Pack Garru',
    description: 'A Garru Backpack — whitelisted by the game to Garru alone — loaded with food and water for a desert crossing.',
    tags: ['animal', 'travel'],
    items: [
      pack(I.garruBackpack), carry(I.food, 6), carry(I.water, 4),
    ],
    raceNotes: [PACK_ANIMAL],
  },
  {
    id: 'beast-of-burden',
    category: 'animal',
    label: 'Beast of Burden',
    description: 'A plain Small Backpack for any other animal in the squad — no race-locked template exists for it in this install’s data, so this is a guess the game itself does not make.',
    tags: ['animal'],
    items: [
      pack(I.smallPack), carry(I.driedMeat, 4),
    ],
    raceNotes: [ANIMAL],
  },

  // =========================================================================
  // PART 3 — topping up the thin categories (light-melee, ranged, stealth,
  // support, trade, travel, starter all sat at exactly 5)
  // =========================================================================
  // Every item sid below is already in the `I` table above, resolved and
  // validated by the two expansions before this one — no new sid was added
  // for this pass, so there is nothing new to mis-resolve. These are NOT read
  // off a character template the way the Meitou/Part-2 loadouts are; they are
  // the same kind of entry the original four scripts and the "read off a live
  // NPC" kits are — an editorial combination of gear this install's data is
  // already known to support, built for variety within a thin bucket rather
  // than to represent one specific person. `validate()` still holds the only
  // hard line: every templateSid resolves and every section is one that
  // template's kind can actually occupy.

  // ----------------------------------------------------------- light melee --
  {
    id: 'saber-duelist',
    category: 'light-melee',
    label: 'Sabre Duelist',
    description: 'A rattan hat and trader\'s leathers, light enough to keep footwork, with a ringed sabre.',
    tags: ['light', 'sabres'],
    items: [
      head(I.rattanHat, 40), shirt(I.leatherVest, 40), body(I.tradersLeathers, 40),
      legs(I.halfpantsPadded, 40), boots(I.woodenSandals, 40),
      hip(I.ringedSabre, 40, GRADE.mid),
      carry(I.aidStandard, 2),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'topper-skirmisher',
    category: 'light-melee',
    label: 'Topper Skirmisher',
    description: 'A dyed turban and longcoat, a topper on the back for whoever closes the distance first.',
    tags: ['light', 'katanas'],
    items: [
      head(I.dyedTurban, 40), shirt(I.leatherShirt, 40), body(I.longcoat, 40),
      legs(I.cargoColored, 40), boots(I.drifterBoots, 40),
      back(I.topper, 40, GRADE.catun1),
      carry(I.aidStandard, 2),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'quarterstaff-wanderer',
    category: 'light-melee',
    label: 'Quarterstaff Wanderer',
    description: 'Bindings and a dyed rag shirt, a staff — the lightest polearm kit in the catalogue.',
    tags: ['light', 'polearms'],
    items: [
      shirt(I.bindings, 20), body(I.dyedRagShirt, 20),
      legs(I.stoutHessian, 20), boots(I.woodenSandals, 20),
      back(I.staff, 20, GRADE.mid),
      carry(I.aidBasic, 2),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'club-enforcer',
    category: 'light-melee',
    label: 'Club Enforcer',
    description: 'Plain cloth and trader\'s leathers, an iron club for people who need a lesson, not a burial.',
    tags: ['light', 'blunt'],
    items: [
      head(I.cap, 20), shirt(I.clothShirt, 20), body(I.tradersLeathers, 20),
      legs(I.halfpantsColored, 20), boots(I.woodenSandals, 20),
      hip(I.ironClub, 20, GRADE.mid),
      carry(I.aidBasic, 1),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'flat-topper-rogue',
    category: 'light-melee',
    label: 'Flat Topper Rogue',
    description: 'A dyed turban and longcoat over cargopants, a flat topper on the hip.',
    tags: ['light', 'sabres', 'full'],
    items: [
      head(I.dyedTurban, 40), shirt(I.leatherVest, 40), body(I.longcoat, 40),
      legs(I.cargoColored, 40), boots(I.drifterBoots, 40),
      hip(I.flatTopper, 40, GRADE.catun1),
      carry(I.aidStandard, 2),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },

  // ---------------------------------------------------------------- ranged --
  {
    id: 'crossbow-rookie',
    category: 'ranged',
    label: 'Crossbow Rookie',
    description: 'A Junkbow and whatever was cheap to wear with it. Barely enough bolts to matter.',
    tags: ['ranged', 'starter'],
    items: [
      head(I.dyedTurban, 10), shirt(I.clothShirt, 10),
      legs(I.halfpantsColored, 10), boots(I.woodenSandals, 10),
      back(I.junkbow, 10),
      carry(I.bolts, 10),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'crossbow-veteran',
    category: 'ranged',
    label: 'Crossbow Veteran',
    description: 'Full samurai plate under a Ranger crossbow — survives the reload the Crossbow Ranger risks.',
    tags: ['ranged', 'full'],
    items: [
      head(I.samuraiHelm, 60), shirt(I.chainShirt, 60), body(I.samuraiArmour, 60),
      legs(I.samuraiLegs, 60), boots(I.samuraiBoots, 60),
      back(I.ranger, 60), hip(I.jitte, 50, GRADE.catun4),
      pack(I.mediumPack), carry(I.bolts, 60), carry(I.aidStandard, 3),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'spring-bat-scout',
    category: 'ranged',
    label: 'Spring-Bat Scout',
    description: 'Trader\'s leathers and a Spring-Bat crossbow, light enough to keep moving between shots.',
    tags: ['ranged', 'light'],
    items: [
      head(I.dyedTurban, 40), shirt(I.leatherVest, 40), body(I.tradersLeathers, 40),
      legs(I.halfpantsPadded, 40), boots(I.woodenSandals, 40),
      back(I.springBat, 40),
      carry(I.boltsLong, 40), carry(I.aidStandard, 2),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'eagles-cross-guard',
    category: 'ranged',
    label: "Eagle's Cross Guard",
    description: "Flared helmet and mercenary plate — heavier than the Elite Marksman's kit, built to hold a position rather than snipe from one.",
    tags: ['ranged', 'heavy', 'full'],
    items: [
      head(I.flaredHelm, 80), shirt(I.darkLeatherShirt, 80), body(I.mercPlate, 80),
      legs(I.samuraiClothpants, 80), boots(I.platedLongboots, 80),
      back(I.eaglesCross, 80), hip(I.heavyIronClub, 60, GRADE.catun4),
      carry(I.bolts, 80), carry(I.aidAdvanced, 4),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'junkbow-desperado',
    category: 'ranged',
    label: 'Junkbow Desperado',
    description: "A drifter's jacket, a rusted iron club for backup, a Junkbow held together with hope. Rougher than the Junkbow Scavenger.",
    tags: ['ranged', 'starter'],
    items: [
      shirt(I.bindings, 20), body(I.drifterJacket, 20),
      legs(I.cargoColored, 20), boots(I.drifterBoots, 20),
      back(I.junkbow, 20), hip(I.ironClub, 15, GRADE.rusted),
      carry(I.bolts, 15),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },

  // -------------------------------------------------------------- stealth --
  {
    id: 'cat-burglar',
    category: 'stealth',
    label: 'Cat Burglar',
    description: 'A mask, a dyed rag shirt and ninja pants — no weapon at all, just a Thieves Backpack for whatever isn\'t nailed down.',
    tags: ['stealth', 'light', 'unarmed'],
    items: [
      head(I.mask1, 40), shirt(I.leatherTurtleneck, 40), body(I.dyedRagShirt, 40),
      legs(I.ninjaPants, 40), boots(I.woodenSandals, 40),
      pack(I.thievesPack), carry(I.aidBasic, 1),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'shadow-blade',
    category: 'stealth',
    label: 'Shadow Blade',
    description: "A ninja zukin over dark leather and assassin's rags, a ninja blade on the back.",
    tags: ['stealth', 'light', 'katanas'],
    items: [
      head(I.ninjaZukin, 60), shirt(I.darkLeatherShirt, 60), body(I.assassinRags, 60),
      legs(I.drifterPants, 60), boots(I.drifterBoots, 60),
      back(I.ninjaBlade, 60, GRADE.industrial),
      carry(I.aidStandard, 2),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'silent-staff',
    category: 'stealth',
    label: 'Silent Staff',
    description: 'An armoured hood and black rag shirt, a staff for keeping distance rather than closing it.',
    tags: ['stealth', 'light', 'polearms'],
    items: [
      head(I.armouredHood, 40), shirt(I.turtleneck, 40), body(I.blackRagShirt, 40),
      legs(I.ninjaPants, 40), boots(I.woodenSandals, 40),
      back(I.staff, 30, GRADE.catun1),
      carry(I.aidBasic, 2),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'rooftop-runner',
    category: 'stealth',
    label: 'Rooftop Runner',
    description: 'Nothing but a leather turtleneck and drifter\'s pants, no weapon, a Small Backpack for the climb down.',
    tags: ['stealth', 'light', 'unarmed'],
    items: [
      shirt(I.leatherTurtleneck, 20), body(I.dyedRagShirt, 20),
      legs(I.drifterPants, 20), boots(I.drifterBoots, 20),
      pack(I.smallPack), carry(I.aidBasic, 1),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'blackened-infiltrator',
    category: 'stealth',
    label: 'Blackened Infiltrator',
    description: 'A mask and blackened chainmail under black rags, a wakizashi on the hip.',
    tags: ['stealth', 'light', 'katanas'],
    items: [
      head(I.mask1, 60), shirt(I.blackChain, 60), body(I.blackRagShirt, 60),
      legs(I.ninjaPants, 60), boots(I.drifterBoots, 60),
      hip(I.wakizashi, 55, GRADE.mk5),
      carry(I.aidAdvanced, 2),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },

  // --------------------------------------------------------------- support --
  {
    id: 'trauma-medic',
    category: 'support',
    label: 'Trauma Medic',
    description: 'Heavier than the Field Medic: a longcoat over reinforced cargopants, a spiked club, and a huge advanced-kit reserve.',
    tags: ['support', 'full'],
    items: [
      head(I.cap, 60), shirt(I.leatherVest, 60), body(I.longcoat, 60),
      legs(I.cargoReinforced, 60), boots(I.drifterBoots, 60),
      hip(I.spikedClub, 40, GRADE.catun1),
      pack(I.largePack), carry(I.aidAdvanced, 12), carry(I.splintAdvanced, 6),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'robotics-tech',
    category: 'support',
    label: 'Robotics Tech',
    description: 'A dyed rag shirt and cloth pants, no weapon — a dozen robotics repair kits and a wrench say what this character is for.',
    tags: ['support', 'unarmed'],
    items: [
      body(I.dyedRagShirt, 40), legs(I.samuraiClothpants, 40),
      pack(I.mediumPack), carry(I.roboticsKit, 12), carry(I.wrench, 3),
    ],
    raceNotes: [ANIMAL],
  },
  {
    id: 'triage-nurse',
    category: 'support',
    label: 'Triage Nurse',
    description: 'Plain cloth, no armour worth the name, a Small Backpack loaded with standard kits and splints.',
    tags: ['support', 'light'],
    items: [
      shirt(I.clothShirt, 20), body(I.ragShirt, 20),
      legs(I.halfpantsColored, 20), boots(I.woodenSandals, 20),
      pack(I.smallPack), carry(I.aidStandard, 10), carry(I.splintKit, 6),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'skeleton-medic',
    category: 'support',
    label: 'Skeleton Medic',
    description: 'Armoured rags, a robotics and skeleton repair kit reserve for keeping the squad\'s machines running.',
    tags: ['support'],
    items: [
      body(I.armouredRags, 60), legs(I.ragSkirt, 60),
      pack(I.mediumPack), carry(I.skeletonKit, 10), carry(I.roboticsKit, 6),
    ],
    raceNotes: [ANIMAL],
  },
  {
    id: 'combat-engineer',
    category: 'support',
    label: 'Combat Engineer',
    description: 'An armoured hood and mercenary leathers, an iron club for trouble and a pack of tools for after.',
    tags: ['support', 'full'],
    items: [
      head(I.armouredHood, 60), shirt(I.leatherShirt, 60), body(I.mercLeather, 60),
      legs(I.cargoReinforced, 60), boots(I.drifterBoots, 60),
      hip(I.ironClub, 40, GRADE.mid),
      pack(I.mediumPack), carry(I.wrench, 4), carry(I.roboticsKit, 4),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },

  // ----------------------------------------------------------------- trade --
  {
    id: 'spice-runner',
    category: 'trade',
    label: 'Spice Runner',
    description: 'Dyed robes and a Trader\'s Pack of narcotics and luxury goods — the trade the Traders Guild does not put its name to.',
    tags: ['trade'],
    items: [
      head(I.dyedTurban, 40), body(I.dyedRobes, 40),
      legs(I.dyedTrousers, 40), boots(I.woodenSandals, 40),
      pack(I.tradersPack), carry(I.narcotics, 4), carry(I.luxuryGoods, 2), carry(I.cats, 50),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'grain-hauler',
    category: 'trade',
    label: 'Grain Hauler',
    description: 'Rags and a huge pack of bread and food — the freight that keeps a town fed, not the goods that make it rich.',
    tags: ['trade'],
    items: [
      shirt(I.clothShirt, 20), body(I.ragShirt, 20),
      legs(I.ragLoincloth, 20), boots(I.woodenSandals, 20),
      pack(I.largePack), carry(I.bread, 20), carry(I.food, 10),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'weapons-dealer',
    category: 'trade',
    label: 'Weapons Dealer',
    description: 'A cap and a longcoat, a horse chopper for demonstrations, a pack of cats for the till.',
    tags: ['trade', 'sabres'],
    items: [
      head(I.cap, 40), body(I.longcoat, 40),
      legs(I.halfpantsPadded, 40), boots(I.woodenSandals, 40),
      hip(I.horseChopper, 30, GRADE.catun1),
      pack(I.mediumPack), carry(I.stringOfCats, 20),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'armour-dealer',
    category: 'trade',
    label: 'Armour Dealer',
    description: "Trader's leathers and a huge pack of raw armour plating and chainmail sheets — sells the material, not the finished piece.",
    tags: ['trade'],
    items: [
      shirt(I.leatherVest, 20), body(I.tradersLeathers, 20),
      legs(I.halfpantsPadded, 20), boots(I.woodenSandals, 20),
      pack(I.largePack), carry(I.armourPlating, 8), carry(I.chainmailSheets, 8),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'liquor-runner',
    category: 'trade',
    label: 'Liquor Runner',
    description: 'Dyed robes and a pack of rum, bloodrum, sake and grog — every drink this install\'s data has a sid for.',
    tags: ['trade'],
    items: [
      body(I.dyedRobes, 20), legs(I.dyedTrousers, 20), boots(I.woodenSandals, 20),
      pack(I.mediumPack), carry(I.rum, 5), carry(I.bloodrum, 3), carry(I.sake, 3), carry(I.grog, 3),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },

  // ---------------------------------------------------------------- travel --
  {
    id: 'desert-crosser',
    category: 'travel',
    label: 'Desert Crosser',
    description: 'A tagelmust and gorillo pelt against the sun, a huge pack of water and food for open desert.',
    tags: ['travel'],
    items: [
      head(I.tagelmust, 40), shirt(I.gorilloPelt, 40), body(I.dyedRagShirt, 40),
      legs(I.stoutHessian, 40), boots(I.woodenSandals, 40),
      pack(I.largePack), carry(I.waterJug, 4), carry(I.food, 8),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'mountain-trekker',
    category: 'travel',
    label: 'Mountain Trekker',
    description: 'A longcoat and reinforced cargopants over plated longboots, a topper on the back, a sleeping bag for the cold.',
    tags: ['travel', 'katanas'],
    items: [
      head(I.dyedTurban, 60), shirt(I.leatherVest, 60), body(I.longcoat, 60),
      legs(I.cargoReinforced, 60), boots(I.platedLongboots, 60),
      back(I.topper, 40, GRADE.catun1),
      pack(I.mediumPack), carry(I.sleepingBag, 1), carry(I.driedMeat, 6),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'river-wanderer',
    category: 'travel',
    label: 'River Wanderer',
    description: "Plain cloth and trader's leathers, no weapon, a Small Backpack of water and bread for following the water.",
    tags: ['travel', 'unarmed'],
    items: [
      shirt(I.clothShirt, 20), body(I.tradersLeathers, 20),
      legs(I.halfpantsPadded, 20), boots(I.woodenSandals, 20),
      pack(I.smallPack), carry(I.waterJug, 2), carry(I.bread, 4),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'caravan-scout',
    category: 'travel',
    label: 'Caravan Scout',
    description: 'Stormgoggles and mercenary leathers, a polearm for keeping raiders off the wagons while riding ahead of them.',
    tags: ['travel', 'polearms'],
    items: [
      head(I.stormgoggles, 40), shirt(I.blackChainShirt, 40), body(I.mercLeather, 40),
      legs(I.stoutHessian, 40), boots(I.drifterBoots, 40),
      back(I.polearm, 40, GRADE.mid),
      pack(I.smallPack), carry(I.waterJug, 2), carry(I.aidStandard, 2),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'lantern-bearer',
    category: 'travel',
    label: 'Lantern Bearer',
    description: 'A dyed turban and longcoat, a lantern and a ration pack for travelling after dark.',
    tags: ['travel', 'unarmed'],
    items: [
      head(I.dyedTurban, 20), body(I.longcoat, 20),
      legs(I.cargoColored, 20), boots(I.drifterBoots, 20),
      pack(I.mediumPack), carry(I.lantern, 1), carry(I.rationPack, 4), carry(I.waterJug, 2),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },

  // --------------------------------------------------------------- starter --
  {
    id: 'bare-fists',
    category: 'starter',
    label: 'Bare Fists',
    description: 'Rags and sandals, no weapon at all — the absolute floor, one step above the Escaped Slave.',
    tags: ['starter', 'unarmed'],
    items: [
      body(I.ragShirt, 5), legs(I.ragLoincloth, 5), boots(I.woodenSandals, 5),
      carry(I.bread, 2),
    ],
    raceNotes: [ANIMAL],
  },
  {
    id: 'rookie-swordsman',
    category: 'starter',
    label: 'Rookie Swordsman',
    description: 'Plain cloth and a white vest, a rusted iron club — cheaper than the Outlaw Swordsman\'s horse chopper.',
    tags: ['starter', 'blunt'],
    items: [
      shirt(I.clothShirt, 10), body(I.ragShirt, 10),
      legs(I.halfpantsColored, 10), boots(I.woodenSandals, 10),
      hip(I.ironClub, 10, GRADE.rusted),
      carry(I.aidBasic, 1),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'wandering-beggar',
    category: 'starter',
    label: 'Wandering Beggar',
    description: 'A loincloth and sandals. Nothing else — not even the Farmer\'s shirt.',
    tags: ['starter', 'civilian', 'unarmed'],
    items: [
      legs(I.ragLoincloth, 5), boots(I.woodenSandals, 5),
      carry(I.bread, 1),
    ],
    raceNotes: [ANIMAL],
  },
  {
    id: 'fresh-recruit',
    category: 'starter',
    label: 'Fresh Recruit',
    description: 'A cap and plain cloth, a rusted plank for a weapon — barely trained, barely equipped.',
    tags: ['starter', 'heavy-weapons'],
    items: [
      head(I.cap, 10), shirt(I.clothShirt, 10),
      legs(I.halfpantsColored, 10), boots(I.woodenSandals, 10),
      hip(I.plank, 10, GRADE.rusted),
      carry(I.aidBasic, 1),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
  {
    id: 'roadside-scavenger',
    category: 'starter',
    label: 'Roadside Scavenger',
    description: 'Rags on rags, a rusted plank on the back — whatever this one owns, it found by the road.',
    tags: ['starter', 'heavy-weapons'],
    items: [
      shirt(I.whiteVest, 5), body(I.ragShirt, 10),
      legs(I.ragLoincloth, 10), boots(I.woodenSandals, 10),
      back(I.plank, 10, GRADE.rusted),
      carry(I.bread, 2),
    ],
    raceNotes: [NO_FEET, ANIMAL],
  },
];

function find(id) {
  return LOADOUTS.find((l) => l.id === id) || null;
}

/**
 * Catalogue for the UI, with each item's resolved name and kind so the client
 * can show what a loadout contains without looking anything up itself.
 * `missing` lists any templateSid this install's data cannot resolve — a
 * loadout referencing a mod the user has since removed still renders, clearly
 * marked, rather than vanishing or throwing.
 */
function catalogue() {
  return LOADOUTS.map((l) => {
    const items = l.items.map((it) => {
      const tmpl = gamedata.lookup(it.templateSid);
      const rules = gamedata.raceRules(it.templateSid);
      return {
        templateSid: it.templateSid,
        section: it.section,
        level: it.level ?? null,
        gradeId: it.gradeId ?? null,
        quantity: it.quantity ?? 1,
        name: tmpl ? tmpl.name : null,
        type: tmpl ? tmpl.type : null,
        // Kenshi's own racial restriction for this piece, so the bulk panel can
        // say "three of these eight cannot wear the helmet" BEFORE the write
        // rather than only in the receipt afterwards. Race names resolve through
        // racesService (load order), never gamedata.nameOf — see raceRules().
        raceRule: rules ? {
          only: rules.only.map((s) => ({ sid: s, name: races.nameOf(s, s) })),
          exclude: rules.exclude.map((s) => ({ sid: s, name: races.nameOf(s, s) })),
        } : null,
      };
    });
    const categoryIndex = CATEGORIES.findIndex(([c]) => c === l.category);
    return {
      id: l.id,
      category: l.category,
      // Resolved here so the Loadouts page can group and order 148 rows without
      // a second request for CATEGORIES. `categoryIndex` is the display order
      // from CATEGORIES, not the array order — an entry filed out of sequence
      // still lands under the right heading.
      categoryLabel: categoryIndex === -1 ? 'Other' : CATEGORIES[categoryIndex][1],
      categoryIndex: categoryIndex === -1 ? CATEGORIES.length : categoryIndex,
      label: l.label,
      description: l.description,
      tags: l.tags || [],
      items,
      raceNotes: l.raceNotes || [],
      missing: items.filter((it) => !it.name).map((it) => it.templateSid),
    };
  });
}

/**
 * Throws if any entry is malformed or names a section its template's kind
 * cannot occupy. An unresolvable templateSid is NOT fatal — this install's mod
 * set is not the only one these ids could be checked against — but it is
 * returned so a test can report it.
 * @returns {{ ok: true, unresolved: string[] }}
 */
function validate() {
  const ids = LOADOUTS.map((l) => l.id);
  if (new Set(ids).size !== ids.length) throw new Error('duplicate loadout id');

  const unresolved = [];
  for (const l of LOADOUTS) {
    if (!l.id || !l.label) throw new Error(`loadout missing id/label: ${JSON.stringify(l)}`);
    if (!l.category || !CATEGORY_IDS.has(l.category)) {
      throw new Error(`loadout "${l.id}" has no valid category (got ${JSON.stringify(l.category)})`);
    }
    if (!Array.isArray(l.items) || !l.items.length) throw new Error(`loadout "${l.id}" has no items`);

    // A slot can hold one thing. A loadout that lists two helmets would have
    // the second silently displace the first to `main` at write time, which is
    // never what the author meant.
    const singles = l.items.filter((it) => it.section !== 'main' && it.section !== 'backpack_content');
    const bySection = new Set();
    for (const it of singles) {
      if (bySection.has(it.section)) throw new Error(`loadout "${l.id}" fills "${it.section}" twice`);
      bySection.add(it.section);
    }

    for (const it of l.items) {
      if (!it.templateSid || !it.section) {
        throw new Error(`loadout "${l.id}": every item needs templateSid and section`);
      }
      const tmpl = gamedata.lookup(it.templateSid);
      if (!tmpl) { unresolved.push(it.templateSid); continue; }
      if ((it.quantity ?? 1) > 1 && !tmpl.stackable) {
        throw new Error(`loadout "${l.id}": "${tmpl.name}" is not stackable but asks for ${it.quantity}`);
      }
      if (it.gradeId && tmpl.type !== 2) {
        throw new Error(`loadout "${l.id}": "${tmpl.name}" is typecode ${tmpl.type}, which has no weapon grade`);
      }
      const { sections } = itemSlots.allowedSections(it.templateSid, null);
      if (!sections.includes(it.section)) {
        throw new Error(
          `loadout "${l.id}": "${tmpl.name}" cannot occupy section "${it.section}" `
          + `(allowed: ${sections.join(', ')})`,
        );
      }
    }
  }
  return { ok: true, unresolved };
}

// `I` is exported so services/provisioning.js can reach for a handful of the
// same item sids (medical kits, food, cats) without re-declaring its own copy
// of this table — see that file's header comment.
module.exports = { LOADOUTS, GRADE, I, CATEGORIES, find, catalogue, validate };
