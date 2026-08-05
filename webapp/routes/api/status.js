'use strict';

const express = require('express');
const { handle } = require('../lib/handler');
const paths = require('../../services/pathService');
const gamedata = require('../../services/gamedataService');
const mutation = require('../../services/mutationService');
const archetypes = require('../../services/archetypes');
const recruits = require('../../services/recruits');
const loadouts = require('../../services/loadouts');
const locations = require('../../services/locationsService');
const names = require('../../services/names');
const personalities = require('../../services/personalities');
const vendors = require('../../services/vendorsService');
const research = require('../../services/researchService');
const racesService = require('../../services/racesService');
const itemCatalog = require('../../services/itemCatalogService');
const itemSlots = require('../../services/itemSlots');

const router = express.Router();

router.get('/health', handle(async () => ({ ok: true })));

router.get('/status', handle(async () => {
  const saves = paths.listSaves();
  const gameRunning = mutation.gameIsRunning();
  return {
    saveRoot: paths.saveRoot(),
    installDir: paths.installDir(),
    workshopDir: paths.workshopDir(),
    saves,
    gameRunning,
    writable: !gameRunning && saves.length > 0,
    mutation: mutation.state(),
  };
}));

router.get('/gamedata', handle(async () => gamedata.indexStats()));
router.post('/gamedata/rebuild', handle(async () => { gamedata.rebuild(); return gamedata.indexStats(); }));

// Every typecode that can back an ITEM record. Six were established by sweeping
// all 123 files of a save (6103 items); the seventh, maps, never appears in
// this player's saves but has 39 live examples in the install's own level
// files. `kind` is the filter key the picker sends.
const ITEM_KINDS = [
  { kind: 'weapon', type: 2, label: 'Weapons' },
  { kind: 'armour', type: 3, label: 'Armour & clothing' },
  { kind: 'crossbow', type: 107, label: 'Crossbows' },
  { kind: 'backpack', type: 46, label: 'Backpacks' },
  { kind: 'limb', type: 111, label: 'Robotic limbs' },
  { kind: 'map', type: 102, label: 'Maps' },
  { kind: 'trade goods', type: 4, label: 'Trade goods & supplies' },
];
const ITEM_KIND_NAMES = Object.fromEntries(ITEM_KINDS.map((k) => [k.type, k.kind]));
const ITEM_KIND_TYPES = Object.fromEntries(ITEM_KINDS.map((k) => [k.kind, k.type]));

// Armour is 1646 of the ~2100 templates, so kind alone doesn't narrow it much —
// the body slot is what someone shopping for boots actually wants.
const ITEM_SLOT_FILTERS = ['head', 'shirt', 'armour', 'legs', 'boots', 'back', 'hip', 'belt', 'backpack_attach'];

const ITEMS_DEFAULT_LIMIT = 50;
const ITEMS_MAX_LIMIT = 500;

// Backend for the future "Add item" picker (TODO.md 2.3). Driven entirely by
// gamedataService.itemTemplates() (typecodes {2,3,4} — see TODO.md 2.2(g),
// NOT 42, which is the save-side item *instance*, not a template).
// itemCatalogService only decorates a hit; a miss must stay silent (only
// ~18% of this install's item sids resolve in the wiki catalog, and a
// catalog-driven list would hide ~82% of the user's items, including
// everything their mods add).
router.get('/gamedata/items', handle(async (req) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
  let limit = Number.parseInt(req.query.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = ITEMS_DEFAULT_LIMIT;
  limit = Math.min(limit, ITEMS_MAX_LIMIT);

  let templates = gamedata.itemTemplates();
  if (q) templates = templates.filter((t) => t.name.toLowerCase().includes(q));

  // Category filters. `kind` is the typecode by another name; `slot` narrows on
  // where an item can actually be worn, which is resolved through
  // services/itemSlots.js so the picker and the write path can never disagree
  // about what fits where.
  const kind = typeof req.query.kind === 'string' ? req.query.kind.trim() : '';
  if (kind && ITEM_KIND_TYPES[kind] !== undefined) {
    templates = templates.filter((t) => t.type === ITEM_KIND_TYPES[kind]);
  }
  // The slot filter is deliberately STRICT. Only 184 of this install's 1646
  // armour templates carry a slot the editor can confirm; the other 1462 fall
  // through to itemSlots' permissive branch, which offers all five body slots
  // because hiding a legitimate one on a modded item is the worse error when
  // you are *placing* an item. For a *filter* that rule inverts: a "boots"
  // search that returns 1477 rows including every shirt is useless. So a
  // template matches only when its slot list is specific — one section, or the
  // two a melee weapon genuinely has (hip and back). Everything else stays
  // reachable through `kind` and the name search.
  const slot = typeof req.query.slot === 'string' ? req.query.slot.trim() : '';
  if (slot && ITEM_SLOT_FILTERS.includes(slot)) {
    templates = templates.filter((t) => {
      const equip = itemSlots.allowedSections(t.sid, null).sections
        .filter((s) => !itemSlots.BUCKET_SECTIONS.includes(s));
      return equip.length > 0 && equip.length <= 2 && equip.includes(slot);
    });
  }

  // Deterministic order: name, then sid, so the list is stable between calls
  // (two templates can share a display name).
  templates.sort((a, b) => {
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    if (a.sid !== b.sid) return a.sid < b.sid ? -1 : 1;
    return 0;
  });

  const total = templates.length;
  const items = templates.slice(0, limit).map((t) => {
    const cat = itemCatalog.lookup(t.sid);
    // Never recompute slot compatibility here — itemSlots.js is the single
    // source of truth (TODO.md 2.1). `currentSection` is null: this row is
    // not-yet-an-item, per TODO.md 2.2(f)'s "pass currentSection as null".
    const { sections: allowedSections, widened: slotsWidened } = itemSlots.allowedSections(t.sid, null);
    return {
      sid: t.sid,
      name: t.name,
      type: t.type,
      kind: ITEM_KIND_NAMES[t.type] || 'unknown',
      stackable: !!t.stackable,
      category: cat ? (cat.taxonomy && cat.taxonomy.group) || null : null,
      description: cat ? (cat.wiki && cat.wiki.description) || null : null,
      allowedSections,
      slotsWidened,
      // Kenshi's own racial armour restrictions for this template, or null when
      // it restricts nothing (the norm). Sent as sid+name pairs so the picker
      // can warn BEFORE the write — the client matches on the character's
      // `race.sid`, never on the name, because two races here share one name.
      raceRule: raceRuleRow(t.sid),
    };
  });

  // The filter vocabulary rides along with the results so the UI never
  // hardcodes a kind list that could drift from the server's.
  return {
    total,
    limit,
    items,
    kinds: ITEM_KINDS.map(({ kind: k, label }) => ({ kind: k, label })),
    slots: ITEM_SLOT_FILTERS,
  };
}));

/**
 * One template's racial restriction, resolved to `{ sid, name }` pairs, or null
 * when it has none.
 *
 * Race names come from racesService (load order), never `gamedata.nameOf` —
 * this install's `17-gamedata.quack` is "Human" by first-definition-wins and
 * "Greenlander" to the running game and the player. A restriction listing races
 * the player has never heard of is not a warning, it is a puzzle.
 */
function raceRuleRow(sid) {
  const rules = gamedata.raceRules(sid);
  if (!rules) return null;
  const pair = (s) => ({ sid: s, name: racesService.nameOf(s, s) });
  return { only: rules.only.map(pair), exclude: rules.exclude.map(pair) };
}

// The weapon grade ladder (TODO.md 2.2(i)), for the "Add item" picker's
// quality control when the selected template is a weapon (type 2). A weapon's
// grade is the (company sid, material sid) pair, NOT `ints.level` — the two
// correlate but do not match (rank === level on only 166 of 262 live weapons),
// so the UI must offer this list and `level` as two separate controls.
// `addItem` takes the chosen entry's `modelSid` as its `materialSid` option and
// resolves the company itself.
router.get('/gamedata/weapon-grades', handle(async () => ({
  grades: gamedata.weaponGrades(),
})));

// Non-mutating catalogue for the "train as archetype" UI dropdowns — the
// mapping lives once in services/archetypes.js, not duplicated client-side.
router.get('/archetypes', handle(async () => archetypes.catalogue()));

// The seven personality values the game actually uses, decoded from gamedata's
// type-26 records rather than guessed — see services/personalities.js.
router.get('/personalities', handle(async () => personalities.catalogue()));

// "Roll a recruit" catalogue for the Add member panel. Editorial, not derived
// from game data — see services/recruits.js.
router.get('/recruits', handle(async () => recruits.catalogue()));

// A pool of plausible names, straight from Kenshi's own namesM/F/MF.txt — the
// files the game itself draws NPC names from. Fetched once and used to
// pre-fill the "Add member" name field, so a new character is never called
// nothing. `?count=` caps at 200.
router.get('/names', handle(async (req) => {
  const asked = Number.parseInt(req.query.count, 10);
  const count = Math.min(Number.isFinite(asked) && asked > 0 ? asked : 40, 200);
  const out = [];
  for (let i = 0; i < count; i++) {
    const n = names.random({ avoid: out });
    if (!n) break; // this install has no name files
    out.push(n);
  }
  return { names: out, pools: names.stats() };
}));

// Named gear sets for bulk equip. Editorial too (services/loadouts.js), and
// each row carries its items already resolved to names/kinds so the client
// never looks a template up itself.
router.get('/loadouts', handle(async () => loadouts.catalogue()));

// Town positions for the teleport picker. Derived from the install's own
// `.level` placement data, not from the save — see services/locationsService.js
// for why the obvious sources (the root leveldata.level, the save's type-94
// town states) are both wrong for this.
router.get('/locations', handle(async () => ({
  locations: locations.all(),
  stats: locations.stats(),
})));
// Who sells what, and where. Built from gamedata's town -> squad -> vendor
// list -> item chain (services/vendorsService.js), not from the save — shop
// stock is generated at runtime and is not stored.
router.get('/vendors', handle(async () => ({ tree: vendors.tree(), stats: vendors.stats() })));

// One shop's contents. Kept off the tree because ~900 shops' item lists is a
// lot to send for rows nobody has opened.
router.get('/vendors/:id', handle(async (req) => {
  const shop = vendors.find(req.params.id);
  if (!shop) { const e = new Error(`unknown shop "${req.params.id}"`); e.status = 404; throw e; }
  return shop;
}));

// The reverse lookup: which shops stock this template?
router.get('/vendors-carrying/:sid', handle(async (req) => ({
  templateSid: req.params.sid,
  shops: vendors.shopsCarrying(req.params.sid),
})));

router.post('/vendors/rebuild', handle(async () => { vendors.rebuild(); return vendors.stats(); }));

router.post('/locations/rebuild', handle(async () => { locations.rebuild(); return locations.stats(); }));

// The research tech tree, resolved from gamedata in the game's own mod load
// order (services/researchService.js). Save-independent: what a save has
// FINISHED comes from GET /saves/:name/research.
router.get('/research', handle(async () => ({ techs: research.catalogue(), stats: research.stats() })));

router.post('/research/rebuild', handle(async () => { research.rebuild(); return research.stats(); }));

// The race catalogue: every type-7 gamedata record, resolved in the game's own
// mod load order (services/racesService.js). Load order is not a nicety here —
// first-definition-wins calls `17-gamedata.quack` "Human" where the running
// game, and the player, call it "Greenlander".
//
// `switchable` is the subset PUT .../characters/:sid/race can target: a race
// needs `combat anatomy` for this editor to know the body plan to write.
// `?q=` filters by name substring, `?playable=1` to the character-creator races.
router.get('/races', handle(async (req) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
  const playableOnly = req.query.playable === '1' || req.query.playable === 'true';
  const rows = racesService.catalogue().filter((r) => {
    if (playableOnly && !r.playable) return false;
    if (q && !r.name.toLowerCase().includes(q)) return false;
    return true;
  });
  return {
    races: rows.map((r) => ({
      sid: r.sid,
      name: r.name,
      // What to show in a picker: `name`, suffixed with the originating file
      // where two races share a name (this install has two "Alpha Fishman").
      label: r.label,
      playable: r.playable,
      isRobot: r.isRobot,
      // Two races sharing this share an appearance slider set, so a switch
      // between them keeps the character's face. Derived from the race's own
      // `editor limits` XML, not from a hand-written family list.
      appearanceFamily: r.appearanceFamily,
      switchable: r.anatomy.length > 0,
      parts: r.anatomy.length,
      anatomy: r.anatomy,
      definitions: r.definitions,
    })),
    stats: racesService.stats(),
  };
}));

router.post('/races/rebuild', handle(async () => { racesService.rebuild(); return racesService.stats(); }));

module.exports = router;
