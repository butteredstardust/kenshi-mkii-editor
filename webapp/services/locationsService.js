'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { readFile } = require('./kenshi/codec');
const { asText } = require('./kenshi/binary');
const paths = require('./pathService');
const gamedata = require('./gamedataService');

/**
 * Where the towns are, in world coordinates — the catalogue behind "teleport
 * the squad to a town".
 *
 * ===========================================================================
 * WHERE THIS DATA COMES FROM, AND WHY NOT THE OBVIOUS PLACES
 * ===========================================================================
 * A town is a type-13 gamedata record (Admag, The Hub, ...) but that record
 * holds only the town's *template* — radius, population, whether it's public.
 * It carries no position at all. The town's placement in the world is an
 * INSTANCE targeting that record, and those instances live in the `.level`
 * files under `<Kenshi>/data/newland/leveldata/<mod>/`.
 *
 * Three sources were checked before settling on that one:
 *
 *  1. `<Kenshi>/data/leveldata.level` — the obvious file, and the wrong one.
 *     It holds a single 20-instance townlist whose every entry has a SENTINEL
 *     height (y of -99 or 0) and whose positions do not agree with the world.
 *     It places "Traders edge" at (-3273, -99, 63366); the real one is at
 *     (48030, 1504, -41953), which is 8 units in y from where the player's own
 *     squad is standing in that town right now. Sentinel-height placements are
 *     therefore DROPPED (see `isPlaced`), not merely deprioritised — 22 of 403.
 *
 *  2. The save's own type-94 town-state records — 330 of them, named ("Town
 *     state Heng"), which looks ideal. But they carry only a zone-grid cell
 *     (`zzX0`/`zzY0`), and a cell is 4500 units square: standing in a town does
 *     not even reliably put you in that town's recorded cell. Worse, the
 *     naming is a different layer: the save calls the player's cell "Heng"
 *     while the placement data puts "Trader's Edge" there — and the game agrees
 *     the player is in the *region* Heng. Joining the two by name matched only
 *     188 of 255 with a consistent cell. Not usable for a teleport, which needs
 *     to land inside the walls.
 *
 *  3. `<Kenshi>/data/leveldata/*.zone` — no town placements at all (types
 *     30/35/41/83), and several use filetypes this codec doesn't read.
 *
 * VERIFICATION of the source that IS used, against the live save (three
 * independent towns where NPC squads name that town as their `basetown`, so
 * the squads' centroid is an honest "where is this town really"):
 *
 *     Traders edge      99 units from the placement
 *     Barren Village   394 units
 *     Bast             478 units
 *
 * — all well inside a town (a type-13 record's own `size radius` runs 350+),
 * and the player's own squad sits 520 units from the "Traders edge" placement.
 *
 * `- Copy` files are skipped: `leveldata - Copy.level` and
 * `leveldata - Copy (2).level` sit next to the real file in Newwworld's folder
 * and are the mod author's own backups. Including them triples every town in
 * that mod.
 */

const CACHE_FILE = path.join(__dirname, '..', '.cache', 'locations.json');
const CACHE_VERSION = 1;

// Two placements of the same name closer than this are the same town listed
// twice by different mods; further apart they are genuinely different places
// (this install has eight distinct "Cannibal Village" camps).
const SAME_PLACE = 2000;

const TOWN_TYPE = 13;

// The one faction sid that is a literal tag rather than a "<id>-<file>"
// stringID, so `gamedata.nameOf` cannot resolve it. Same caution as
// `bountyfac0`/`relationSID<n>` elsewhere in this codebase — do not assume
// every sid-shaped string resolves.
const FACTION_ALIASES = { defaultEmpireFactionSID: 'United Cities' };

let cached = null;

/** A placement with a sentinel height is not a real world position. See above. */
function isPlaced(pos) {
  return Array.isArray(pos) && pos.length === 3 && Number.isFinite(pos[1]) && pos[1] > 0;
}

function resolveFaction(sid) {
  if (!sid) return null;
  if (FACTION_ALIASES[sid]) return FACTION_ALIASES[sid];
  return gamedata.nameOf(sid, null);
}

/** Every `.level`/`.zone` file under the install's data directory. */
function levelFiles(root, depth = 0, out = []) {
  if (depth > 3) return out;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) { levelFiles(full, depth + 1, out); continue; }
    if (!/\.(zone|level)$/i.test(e.name)) continue;
    if (/ - Copy/i.test(e.name)) continue; // a mod author's backup, see header
    out.push(full);
  }
  return out;
}

/**
 * Town templates (type 13) with their faction, read straight from the data
 * files rather than the name index — the index caches name/type/slot but not
 * the `extra['faction']` row, and this is the only consumer that needs it.
 */
function townTemplates() {
  const byId = new Map();
  for (const file of gamedata.dataFiles()) {
    let parsed;
    try { parsed = readFile(fs.readFileSync(file)); } catch { continue; }
    for (const rec of parsed.records) {
      if (rec.type !== TOWN_TYPE || !rec.sid) continue;
      const row = (rec.extra.get('faction') || [])[0];
      const faction = row && row.target ? row.target : null;
      const existing = byId.get(rec.sid);
      // First definition wins for the name (matching gamedataService), but a
      // later definition that actually names a faction beats one that doesn't —
      // mods routinely re-state a vanilla town purely to attach a faction.
      if (!existing) byId.set(rec.sid, { name: asText(rec.name), faction });
      else if (!existing.faction && faction) existing.faction = faction;
    }
  }
  return byId;
}

function build() {
  const install = paths.installDir();
  if (!install) return { locations: [], stats: { files: 0, placements: 0, dropped: 0 } };
  const dataDir = path.join(install, 'data');

  const templates = townTemplates();
  const raw = [];
  let files = 0;
  let dropped = 0;

  for (const file of levelFiles(dataDir)) {
    let parsed;
    try { parsed = readFile(fs.readFileSync(file)); } catch { continue; } // filetype 10/13 zones
    files++;
    for (const rec of parsed.records) {
      for (const inst of rec.instances) {
        const tmpl = templates.get(inst.target);
        if (!tmpl) continue;
        if (!isPlaced(inst.pos)) { dropped++; continue; }
        raw.push({
          sid: inst.target,
          name: tmpl.name,
          faction: resolveFaction(tmpl.faction),
          pos: inst.pos.map((n) => Math.round(n * 100) / 100),
          source: path.relative(dataDir, file).replace(/\\/g, '/'),
        });
      }
    }
  }

  // Collapse duplicates of the same town placed by more than one file, keeping
  // genuinely separate places of the same name (see SAME_PLACE).
  const groups = new Map();
  for (const p of raw) {
    const key = p.name.toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    const bucket = groups.get(key);
    const near = bucket.find((b) => Math.hypot(b.pos[0] - p.pos[0], b.pos[2] - p.pos[2]) <= SAME_PLACE);
    if (near) continue;
    bucket.push(p);
  }

  // A stable id per placement. Several towns share a name and are different
  // places, so the name alone cannot key a selection — but nor can
  // `slug + index`: this install has both "Trade outpost" (placed twice, so it
  // wants `trade-outpost-2`) and a separate town literally named "Trade outpost
  // 2" (which slugs to the same thing). Uniqueness is enforced here rather than
  // assumed, so a selection can never resolve to the wrong town.
  const used = new Set();
  const uniqueId = (want) => {
    let id = want;
    for (let n = 2; used.has(id); n++) id = `${want}--${n}`;
    used.add(id);
    return id;
  };

  const locations = [];
  for (const bucket of groups.values()) {
    bucket.sort((a, b) => a.pos[0] - b.pos[0] || a.pos[2] - b.pos[2]);
    bucket.forEach((p, i) => {
      const slug = p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      locations.push({
        id: uniqueId(`${slug}${bucket.length > 1 ? `-${i + 1}` : ''}`),
        name: p.name,
        label: bucket.length > 1 ? `${p.name} (${i + 1} of ${bucket.length})` : p.name,
        faction: p.faction,
        x: p.pos[0],
        y: p.pos[1],
        z: p.pos[2],
        source: p.source,
      });
    });
  }

  locations.sort((a, b) => a.name.localeCompare(b.name) || a.x - b.x);
  return { locations, stats: { files, placements: raw.length, dropped, distinct: groups.size, builtAt: new Date().toISOString() } };
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

/** @returns {{id, name, label, faction, x, y, z, source}[]} */
function all() { return load().locations; }
function stats() { return load().stats; }
function find(id) { return all().find((l) => l.id === id) || null; }

/**
 * Resolve a human location NAME (as a wiki page or a recruit entry writes it)
 * against this install's actual towns. Case-insensitive, exact name first, then
 * a substring match — a heavily modded install renames and moves towns, so a
 * name from any external list is a hint, never a guarantee. Returns null rather
 * than guessing wildly.
 */
function findByName(name) {
  if (!name) return null;
  const list = all();
  const want = String(name).toLowerCase();
  return list.find((l) => l.name.toLowerCase() === want)
    || list.find((l) => l.name.toLowerCase().includes(want))
    || null;
}

module.exports = { all, find, findByName, stats, rebuild, isPlaced, SAME_PLACE };
