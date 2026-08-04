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

const ITEM_KIND_NAMES = { 2: 'weapon', 3: 'armour', 4: 'trade goods' };
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
    };
  });

  return { total, limit, items };
}));

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

// "Roll a recruit" catalogue for the Add member panel. Editorial, not derived
// from game data — see services/recruits.js.
router.get('/recruits', handle(async () => recruits.catalogue()));

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
router.post('/locations/rebuild', handle(async () => { locations.rebuild(); return locations.stats(); }));

module.exports = router;
