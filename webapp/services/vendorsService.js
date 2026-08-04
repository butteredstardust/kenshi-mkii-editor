'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { readFile } = require('./kenshi/codec');
const { asText } = require('./kenshi/binary');
const gamedata = require('./gamedataService');
const locations = require('./locationsService');

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
 *         item template (2/3/4/46/107/111)
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
const CACHE_VERSION = 1;

const TOWN = 13;
const SQUAD = 52;
const VENDOR_LIST = 49;

// Categories on a town that name a resident/visiting squad.
const TOWN_SQUAD_CATS = ['residents', 'default resident', 'bar squads', 'roaming squads'];

// Categories on a vendor list that name something a player could be given.
// `blueprints`, `maps` and `weapon manufacturers` are deliberately absent —
// they point at tech (21), map (102) and company (51) records, which are real
// stock but not item templates this editor can mint.
const VENDOR_ITEM_CATS = ['items', 'weapons', 'clothing', 'armour blueprints', 'robotics', 'containers', 'crossbows', 'crossbow blueprints', 'trade goods', 'building materials'];

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
            // Only offer what this editor can actually mint — the same six
            // typecodes the item picker uses. A vendor list also names tech and
            // map records, which are stock but not addable.
            if (!tmpl || !gamedata.ITEM_TEMPLATE_TYPES.has(tmpl.type)) continue;
            count++;
            if (!items.has(templateSid)) {
              items.set(templateSid, {
                sid: templateSid, name: tmpl.name, type: tmpl.type, category: cat,
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

/** Every shop that stocks a given item template — the reverse lookup. */
function shopsCarrying(templateSid) {
  return all().filter((s) => s.items.some((i) => i.sid === templateSid))
    .map((s) => ({ id: s.id, faction: s.faction, town: s.town, shop: s.shop }));
}

module.exports = { all, find, tree, stats, rebuild, shopsCarrying, VENDOR_ITEM_CATS };
