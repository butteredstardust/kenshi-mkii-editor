'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { readFile } = require('./kenshi/codec');
const { asText } = require('./kenshi/binary');
const gamedata = require('./gamedataService');
const locations = require('./locationsService');
const blueprints = require('./blueprints');

/**
 * Who sells what, and where.
 *
 * ===========================================================================
 * THE CHAIN
 * ===========================================================================
 * Vendor stock is not in the save — it is generated at runtime from a chain of
 * gamedata records, and every link was traced against a user's own example
 * ("KLR Series Arm (left), robotics shop, Black Desert City"):
 *
 *   town (13)  --extra['residents' | 'bar squads' | ...]-->
 *     squad (52)  --extra['vendors']-->
 *       vendor list (49)  --extra['items'|'weapons'|'clothing'|'robotics'|...]-->
 *         item template (2/3/4/46/102/107/111)
 *
 * EVERY row is listed, addable or not. Dropping the ones this editor can't mint
 * made the page lie about what a shop sells — and hid a real gap: `maps` was
 * filtered out as "not an item", when a type-102 map is very much an item (39
 * live ones sit in the install's own interiors.level files). Only research tech
 * (21) and weapon manufacturers (51) genuinely are not objects; they are shown
 * dimmed with the reason. See whyNotAddable().
 *
 * The example resolves exactly: Black Desert City lists a resident squad
 * "Robotics shop (black desert)", whose vendor list "Robotics limb vendor
 * (best)" carries the KLR arms. 234 of this install's 428 towns have at least
 * one vendor squad, 898 shop squads in total.
 *
 * THE UNION RULE. Extra rows are collected across EVERY definition of a sid,
 * not first-definition-wins — the same rule (and the same reason) as
 * gamedataService's material index. Black Desert City's first definition
 * carries only `extra['faction']`; its residents, including the robotics shop,
 * are attached by a later one. First-definition-wins reports the city as having
 * no shops at all.
 *
 * WHAT "REGION" MEANS HERE. Kenshi's biome regions are type-95 records (The
 * Swamp, Ashlands, Border Zone, ...) but **nothing links a town to one** —
 * regions reference `nests`, factions reference `biomes`, and neither gives
 * town -> region. The save knows a region for a position (`map area sid` on a
 * squad record) but only for places the player has been. So the top level here
 * is the town's FACTION, which is real, complete, and how Kenshi territory
 * actually divides. It is labelled "Faction" in the UI, not "Region", because
 * calling it a region would be a claim the data does not support.
 */

const CACHE_FILE = path.join(__dirname, '..', '.cache', 'vendors.json');
// 1: initial — every row listed, addable or not.
// 2: blueprint shelves resolve to the BLUEPRINT ITEM rather than to their
//    subject, so rows carry `key`/`blueprint` and a research tech is addable.
// Keyed on the gamedata index version too: this cache bakes in names that
// come from there, so a change to how names resolve must invalidate it.
const CACHE_VERSION = `2.${gamedata.INDEX_VERSION}`;

const TOWN = 13;
const SQUAD = 52;
const VENDOR_LIST = 49;

// Categories on a town that name a resident/visiting squad.
const TOWN_SQUAD_CATS = ['residents', 'default resident', 'bar squads', 'roaming squads'];

// Every category on a vendor list that names a THING, addable or not. The page
// lists all of them: hiding a row because this editor can't mint it makes the
// shop look like it doesn't sell it, which is worse than saying "sold here,
// can't be added, and here's why".
const VENDOR_ITEM_CATS = ['items', 'weapons', 'clothing', 'armour blueprints', 'robotics', 'containers', 'crossbows', 'crossbow blueprints', 'trade goods', 'building materials', 'maps', 'blueprints', 'weapon manufacturers'];

/**
 * The shelves that sell a BLUEPRINT of the thing they name, rather than the
 * thing itself.
 *
 * This distinction was missing and it made the page wrong in both directions.
 * `blueprints` points at type-21 research techs, which were dimmed as "not a
 * carryable item" — but a blueprint is very much carryable, and 238 live
 * blueprint items name a bare tech sid exactly like these rows do.
 * `armour blueprints` and `crossbow blueprints` point at ordinary type-3/107
 * item templates, and the page cheerfully offered to add the armour — when what
 * the shop sells is the blueprint for it. See services/blueprints.js.
 *
 * A shop can list the same template on two shelves (a Sleeveless Longcoat under
 * both `clothing` and `armour blueprints`), so the row key carries the shelf
 * kind — keying on the template sid alone silently dropped one of the two.
 */
const BLUEPRINT_CATS = new Set(['blueprints', 'armour blueprints', 'crossbow blueprints']);

/**
 * Why a given vendor row can't be turned into an item, or null if it can.
 *
 * Only ONE case survives now, and it was checked rather than assumed:
 *
 *  - **51, weapon manufacturer.** "Truth Two" carries `blunt damage mod`,
 *    `price mod` and `extra['weapon models']`. It is the grade company — this
 *    editor already models it as the weapon grade ladder. A vendor listing one
 *    means "stocks weapons of that make", not "sells this object".
 *
 * Type 21 (research tech) used to be listed here with "not a carryable item —
 * buy the book that unlocks it". That reasoning was right about the tech and
 * wrong about the row: the shelf sells a blueprint FOR the tech, which is an
 * object, and it is now minted as one (see BLUEPRINT_CATS).
 */
function whyNotAddable(type) {
  if (type === 51) return 'a weapon manufacturer, not an object — it sets the grade of weapons sold here';
  if (type === 21) return 'research tech listed outside a blueprint shelf — nothing here sells it as an object';
  return 'not an item template this editor can mint';
}

let cached = null;

/**
 * One sweep of every data file, collecting names/types plus the UNION of extra
 * rows per sid. This is the expensive part (~62k records) and why the built
 * result is cached to disk.
 */
function sweep() {
  const names = new Map(); // sid -> { name, type }
  const extras = new Map(); // sid -> Map<category, Set<targetSid>>
  for (const file of gamedata.dataFiles()) {
    let parsed;
    try { parsed = readFile(fs.readFileSync(file)); } catch { continue; }
    for (const rec of parsed.records) {
      if (!rec.sid) continue;
      if (!names.has(rec.sid)) names.set(rec.sid, { name: asText(rec.name), type: rec.type });
      if (!rec.extra.size) continue;
      let m = extras.get(rec.sid);
      if (!m) { m = new Map(); extras.set(rec.sid, m); }
      for (const [cat, rows] of rec.extra) {
        let set = m.get(cat);
        if (!set) { set = new Set(); m.set(cat, set); }
        for (const row of rows) if (row.target) set.add(row.target);
      }
    }
  }
  return { names, extras };
}

function build() {
  const { names, extras } = sweep();
  const rowsOf = (sid, cat) => [...((extras.get(sid) || new Map()).get(cat) || [])];
  const nameOf = (sid) => (names.get(sid) || {}).name || sid;

  const shops = [];
  for (const [townSid, town] of names) {
    if (town.type !== TOWN) continue;

    // Position/faction come from the placement catalogue, which is the thing
    // that already knows where a town actually is (and drops the ones with no
    // real placement).
    const placed = locations.findByName(town.name);

    const squadSids = new Set(TOWN_SQUAD_CATS.flatMap((c) => rowsOf(townSid, c)));
    for (const squadSid of squadSids) {
      if ((names.get(squadSid) || {}).type !== SQUAD) continue;
      const vendorSids = rowsOf(squadSid, 'vendors').filter((v) => (names.get(v) || {}).type === VENDOR_LIST);
      if (!vendorSids.length) continue;

      const items = new Map(); // templateSid -> row
      const stockLists = [];
      for (const vSid of vendorSids) {
        const catMap = extras.get(vSid) || new Map();
        let count = 0;
        for (const cat of VENDOR_ITEM_CATS) {
          for (const templateSid of (catMap.get(cat) || [])) {
            const tmpl = gamedata.lookup(templateSid);
            if (!tmpl) continue; // a row pointing at a record no installed mod defines
            count++;
            // A blueprint shelf sells the blueprint, not its subject — so the
            // row is keyed and minted as a different object even when the
            // subject also sits on an ordinary shelf in the same shop.
            const bp = BLUEPRINT_CATS.has(cat) ? blueprints.forSubject(templateSid) : null;
            const key = bp ? `blueprint|${templateSid}` : templateSid;
            const addable = bp ? true : gamedata.ITEM_TEMPLATE_TYPES.has(tmpl.type);
            if (!items.has(key)) {
              items.set(key, {
                key,
                sid: templateSid,
                name: bp ? `${bp.templateName}: ${tmpl.name}` : tmpl.name,
                type: tmpl.type,
                category: cat,
                addable,
                ...(bp ? {
                  blueprint: {
                    templateSid: bp.templateSid,
                    templateName: bp.templateName,
                    teaches: bp.teaches,
                    subjectName: bp.subjectName,
                    kind: bp.kind,
                  },
                } : {}),
                ...(addable ? {} : { reason: whyNotAddable(tmpl.type) }),
              });
            }
          }
        }
        stockLists.push({ sid: vSid, name: nameOf(vSid), items: count });
      }
      if (!items.size) continue;

      shops.push({
        id: `${townSid}|${squadSid}`,
        town: town.name,
        townSid,
        faction: placed ? placed.faction : null,
        locationId: placed ? placed.id : null,
        shop: nameOf(squadSid),
        squadSid,
        lists: stockLists,
        items: [...items.values()].sort((a, b) => a.name.localeCompare(b.name)),
      });
    }
  }

  shops.sort((a, b) => (a.faction || 'zzz').localeCompare(b.faction || 'zzz')
    || a.town.localeCompare(b.town) || a.shop.localeCompare(b.shop));

  const stats = {
    shops: shops.length,
    // Keyed by `key`, not `sid`: a blueprint and its subject are two distinct
    // things a shop can sell and they share a template sid.
    addableItems: new Set(shops.flatMap((s) => s.items.filter((i) => i.addable).map((i) => i.key))).size,
    nonAddableItems: new Set(shops.flatMap((s) => s.items.filter((i) => !i.addable).map((i) => i.key))).size,
    blueprints: new Set(shops.flatMap((s) => s.items.filter((i) => i.blueprint).map((i) => i.key))).size,
    towns: new Set(shops.map((s) => s.town)).size,
    factions: new Set(shops.map((s) => s.faction).filter(Boolean)).size,
    placedTowns: new Set(shops.filter((s) => s.locationId).map((s) => s.town)).size,
    builtAt: new Date().toISOString(),
  };
  return { shops, stats };
}

function load() {
  if (cached) return cached;
  try {
    const disk = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (disk.version === CACHE_VERSION) { cached = disk; return cached; }
  } catch { /* no cache, or a stale one — rebuild */ }
  const built = build();
  cached = { version: CACHE_VERSION, ...built };
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cached));
  } catch { /* the cache is an optimisation, not a requirement */ }
  return cached;
}

function rebuild() {
  cached = null;
  try { fs.unlinkSync(CACHE_FILE); } catch { /* nothing cached */ }
  return load();
}

function all() { return load().shops; }
function stats() { return load().stats; }
function find(id) { return all().find((s) => s.id === id) || null; }

/**
 * Faction -> town -> shop, for the drill-down. Contents are NOT included: the
 * tree is sent to the browser whole (about 900 shops) and the item lists would
 * multiply that several times over for rows nobody has opened yet.
 */
function tree() {
  const byFaction = new Map();
  for (const s of all()) {
    const fac = s.faction || 'Unaligned';
    if (!byFaction.has(fac)) byFaction.set(fac, new Map());
    const towns = byFaction.get(fac);
    if (!towns.has(s.town)) towns.set(s.town, []);
    towns.get(s.town).push({ id: s.id, shop: s.shop, items: s.items.length, locationId: s.locationId });
  }
  return [...byFaction.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([faction, towns]) => ({
      faction,
      towns: [...towns.entries()].sort((a, b) => a[0].localeCompare(b[0]))
        .map(([town, list]) => ({ town, shops: list.sort((x, y) => x.shop.localeCompare(y.shop)) })),
    }));
}

/**
 * Every shop that stocks a given item template — the reverse lookup. Matches on
 * `sid`, so it finds a shop selling the thing AND a shop selling its blueprint;
 * both are places you can go and come back with something.
 */
function shopsCarrying(templateSid) {
  return all().filter((s) => s.items.some((i) => i.sid === templateSid))
    .map((s) => ({ id: s.id, faction: s.faction, town: s.town, shop: s.shop }));
}

module.exports = { all, find, tree, stats, rebuild, shopsCarrying, VENDOR_ITEM_CATS, BLUEPRINT_CATS };
