'use strict';

const gamedata = require('./gamedataService');
const itemSlots = require('./itemSlots');

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

const ANIMAL = { races: ['Dog1', 'Bull', 'Garru', 'Goat', 'Bonedog', 'Beak Thing', 'Skimmer'], note: 'animal — wears and carries nothing' };
const NO_FEET = { races: ['Skeleton', 'Hive'], note: 'boots and helmet are a poor fit on this race' };

const LOADOUTS = [
  // ------------------------------------------------------------ heavy melee --
  {
    id: 'ancient-samurai',
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
    label: 'Thieves Backpack',
    description: 'One Thieves Backpack, worn.',
    tags: ['pack'],
    items: [pack(I.thievesPack)],
    raceNotes: [ANIMAL],
  },
  {
    id: 'full-kit',
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
      return {
        templateSid: it.templateSid,
        section: it.section,
        level: it.level ?? null,
        gradeId: it.gradeId ?? null,
        quantity: it.quantity ?? 1,
        name: tmpl ? tmpl.name : null,
        type: tmpl ? tmpl.type : null,
      };
    });
    return {
      id: l.id,
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

module.exports = { LOADOUTS, GRADE, find, catalogue, validate };
