'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { readFile } = require('./kenshi/codec');
const { asText } = require('./kenshi/binary');
const { filesInLoadOrder } = require('./loadOrder');

/**
 * Colour schemes: the type-55 gamedata catalogue, and which of them an armour
 * TEMPLATE says it can wear (TODO.md 3.1).
 *
 * ===========================================================================
 * WHERE A COLOUR LIVES
 * ===========================================================================
 * A save-side ITEM (42) record names its colour scheme in
 * `strings['color sid']` (lowercase, American spelling — confirmed against a
 * live save; empty string when unset, which is 6429 of 8300 records in the
 * fixture). A non-empty value is a **typecode-55** record's stringID —
 * `1266-gamedata.base` -> "white", `31-Armor List Tweaks.mod` -> "ALT Black
 * 5", `1367-gamedata.base` -> "super black". Each type-55 record carries
 * `ints['color 1']` and `ints['color 2']`, packed `0xRRGGBB` integers
 * (`16777215` is white, `0` is black) — the two halves of a two-tone scheme
 * (e.g. a coat's body and its trim).
 *
 * ===========================================================================
 * THE ALLOW-LIST IS ADVISORY, NOT A GATE
 * ===========================================================================
 * A type-3 armour TEMPLATE may carry an `extra['color']` category listing the
 * schemes it was authored with. Only 15 of this install's templates carry one
 * at all — the vast majority carry none, which per AGENTS.md §3's posture
 * (`itemSlots.js`, `fitCheck.js`) means "offer the whole catalogue and say
 * so", never "offer nothing". Exactly like the material index and the racial
 * `races`/`races exclude` rows, a template's list is UNIONED across every
 * definition of its sid, not first-definition-wins — a mod that re-defines a
 * template purely to attach one more colour row must not blank the ones the
 * base file already listed.
 *
 * **This never blocks a write.** The whole point of this editor is writing
 * combinations Kenshi's own UI will not offer (AGENTS.md §3) — a colour this
 * install has never indexed (a mod's scheme this player doesn't have loaded,
 * or one from a scheme table this sweep missed) is a WARNING on the receipt,
 * never a refusal.
 */

const CACHE_FILE = path.join(__dirname, '..', '.cache', 'colors.json');
const CACHE_VERSION = 1;

const COLOR_SCHEME = 55;
// The typecode whose `extra['color']` rows are the allow-list this file
// resolves. Armour (type 3) is the only kind observed carrying one.
const ARMOUR_TEMPLATE = 3;

let cached = null;

function hex(v) {
  if (v == null) return null;
  // Every observed value is a packed 0xRRGGBB (max 16777215), which fits an
  // int32 as read positive — `>>> 0` only guards a value this sweep never saw.
  return `#${(v >>> 0).toString(16).padStart(6, '0').toUpperCase()}`;
}

/**
 * Resolve every type-55 record, plus every type-3 template's own
 * `extra['color']` allow-list, in one pass of load order.
 *
 * Scalars: last definition that CARRIES a field wins (a mod attaching one
 * more colour row to a scheme must not blank the RGB values it never
 * mentions) — the same discipline `racesService`/`factionsService` use.
 * `extra['color']` rows are unioned across every definition (the material
 * index's rule), for the reason in the header comment.
 */
function build() {
  const schemes = new Map();
  const allowLists = new Map(); // armour template sid -> Set<scheme sid>

  for (const file of filesInLoadOrder()) {
    let parsed;
    try { parsed = readFile(fs.readFileSync(file)); } catch { continue; }

    for (const rec of parsed.records) {
      if (!rec.sid) continue;

      if (rec.type === COLOR_SCHEME) {
        let s = schemes.get(rec.sid);
        if (!s) { s = { sid: rec.sid, name: rec.sid, color1: null, color2: null, definitions: 0 }; schemes.set(rec.sid, s); }
        s.definitions++;
        const nm = asText(rec.name); if (nm) s.name = nm;
        if (rec.ints.has('color 1')) s.color1 = rec.ints.get('color 1');
        if (rec.ints.has('color 2')) s.color2 = rec.ints.get('color 2');
        continue;
      }

      if (rec.type !== ARMOUR_TEMPLATE) continue;
      const rows = rec.extra.get('color');
      if (!rows || !rows.length) continue;
      let set = allowLists.get(rec.sid);
      if (!set) { set = new Set(); allowLists.set(rec.sid, set); }
      for (const row of rows) if (row.target) set.add(row.target);
    }
  }

  const list = [...schemes.values()].map((s) => ({
    sid: s.sid,
    name: s.name,
    color1: s.color1,
    color2: s.color2,
    hex1: hex(s.color1),
    hex2: hex(s.color2),
    definitions: s.definitions,
  }));
  list.sort((a, b) => a.name.localeCompare(b.name));

  const allowIdx = new Map();
  for (const [sid, set] of allowLists) allowIdx.set(sid, [...set]);

  return {
    schemes: list,
    allowLists: allowIdx,
    stats: {
      schemes: list.length,
      templatesWithAllowList: allowIdx.size,
      multiDefinition: list.filter((s) => s.definitions > 1).length,
      builtAt: new Date().toISOString(),
    },
  };
}

function load() {
  if (cached) return cached;
  try {
    const disk = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (disk.version === CACHE_VERSION) {
      cached = { ...disk, allowLists: new Map(Object.entries(disk.allowLists || {})) };
      return cached;
    }
  } catch { /* no cache, or a stale one — rebuild */ }
  const built = build();
  cached = { version: CACHE_VERSION, schemes: built.schemes, allowLists: built.allowLists, stats: built.stats };
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({
      version: CACHE_VERSION,
      schemes: cached.schemes,
      allowLists: Object.fromEntries(cached.allowLists),
      stats: cached.stats,
    }));
  } catch { /* the cache is an optimisation, not a requirement */ }
  return cached;
}

function rebuild() {
  cached = null;
  try { fs.unlinkSync(CACHE_FILE); } catch { /* nothing cached */ }
  return load();
}

/** Every resolved colour scheme, name-ascending. */
function catalogue() { return load().schemes; }
function stats() { return load().stats; }

let bySidIdx = null;
function bySid(sid) {
  if (!bySidIdx) bySidIdx = new Map(catalogue().map((s) => [s.sid, s]));
  return bySidIdx.get(sid) || null;
}

/** A colour scheme's display name, or `fallback` (default `null`) on a miss. */
function nameOf(sid, fallback = null) {
  const s = sid ? bySid(sid) : null;
  return s ? s.name : fallback;
}

/** The scheme's primary swatch (`hex1`), or null on a miss. */
function hexOf(sid) {
  const s = sid ? bySid(sid) : null;
  return s ? s.hex1 : null;
}

/**
 * An armour template's colour allow-list, permissive per the header comment.
 *
 * `currentColorSid` (the item's OWN current value, may be `''`) is always
 * included in the result if non-empty — exactly the rule
 * `itemSlots.allowedSections()` follows for an item's current section, so a
 * colour already on a record can never become impossible to re-select.
 *
 * @returns {{ sids: string[], widened: boolean }} `widened` is true whenever
 *   the template carries no `extra['color']` rows at all (the common case —
 *   15 of this install's templates carry one), meaning the FULL catalogue was
 *   offered rather than a real restriction.
 */
function allowedColors(baseSid, currentColorSid) {
  load();
  const list = baseSid ? allowLists().get(baseSid) : null;
  let sids;
  let widened;
  if (list && list.length) {
    sids = list.slice();
    widened = false;
  } else {
    sids = catalogue().map((s) => s.sid);
    widened = true;
  }
  if (currentColorSid && !sids.includes(currentColorSid)) sids.push(currentColorSid);
  return { sids, widened };
}

function allowLists() { return load().allowLists; }

module.exports = {
  COLOR_SCHEME, ARMOUR_TEMPLATE,
  catalogue, stats, rebuild, bySid, nameOf, hexOf, allowedColors,
};
