'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { readFile, writeFile } = require('./kenshi/codec');
const { asText } = require('./kenshi/binary');
const { filesInLoadOrder } = require('./loadOrder');

/**
 * Faction relations: who hates you, and by how much.
 *
 * ===========================================================================
 * WHERE THEY LIVE
 * ===========================================================================
 * In `quick.save`, and nowhere else. Every save on this machine holds exactly
 * 114 typecode-37 FACTION records, all in `quick.save`, one per type-10 faction
 * template in gamedata — the counts match exactly, 114 to 114, in all four
 * saves checked.
 *
 * A faction record's own sid is a runtime handle (`19921-quick.save-INGAME`)
 * and is worthless across saves. The stable identity is
 * `strings['gamedata stringID']`, which every one of the 114 carries and which
 * points at the type-10 template. **That is the key for everything here** —
 * matching by the record's header `name` looks like it works and does not: the
 * player's own record is named whatever they renamed their squad to, and 7 of
 * the 114 carry a name that appears nowhere in gamedata.
 *
 * Each record then holds a triple per counterpart, indexed by an arbitrary `n`:
 *
 *   strings["relationSID<n>"]  the OTHER faction's gamedata stringID
 *   floats["relation<n>"]      -100..100, how THIS faction feels about them
 *   floats["trust<n>"]         0 in every relation toward the player
 *   floats["trustNeg<n>"]      likewise
 *
 * 12882 rows in the fixture save. The shape is exact: 113 factions carry 114
 * rows each — every faction in the game INCLUDING THEMSELVES — and the 114th,
 * the player, carries none. The self-row is real and is 100 on all 113 of them,
 * which is why `setRelations` refuses a change where `from === to`: there is
 * nothing there a player would want changed and every save agrees on the value.
 *
 * `relationSID<n>` is present on all 12882 rows and so is the matching
 * `relation<n>`: there are no half-rows. Which is what makes editing safe —
 * **nothing here ever mints a key.** A relation this editor can change is one
 * the file already has a slot for; anything else is refused rather than
 * invented.
 *
 * ===========================================================================
 * THE PLAYER IS THE ONE WITH NO ROWS
 * ===========================================================================
 * The player's faction record has **zero** `relationSID<n>` rows — it is the
 * only one of the 114 that does, in every save checked — and is also the only
 * one carrying `floats['global trust']` and an `extra['known']` category. Its
 * `gamedata stringID` is the Nameless template (`204-gamedata.base` here), and
 * its header name is the player's chosen squad name, matching GAME_STATE's
 * `pfaction name` (AGENTS.md §3).
 *
 * So **"my standing with the Holy Nation" is stored on the HOLY NATION's
 * record**, not on the player's. 113 of the 114 carry a row pointing back at
 * the player. Editing the player's own record would be editing the one record
 * that has nothing to say.
 *
 * ===========================================================================
 * RELATIONS ARE NOT SYMMETRIC
 * ===========================================================================
 * Of 11449 reciprocal pairs in the fixture save, 10991 agree and 458 do not —
 * the Flotsam Ninjas are at -100 with the Raptors while the Raptors are at 0
 * with them. So a relation is directional and this service treats it that way:
 * a change names `from` and `to` and touches exactly one float.
 *
 * ===========================================================================
 * THE THRESHOLDS ARE THE FACTION'S OWN
 * ===========================================================================
 * Rather than invent bands, the standing label is derived from two ints on the
 * faction's own type-10 template: `enemy classification` (-10 on 109 of the 114)
 * and `business relations` (-5 on 103). Those are the game's own numbers for
 * "attacks on sight" and "won't trade", and a mod that moves them moves the
 * label with them. The exact comparison the engine uses is NOT proven here, so
 * the UI always shows the raw relation value beside the label — the number is
 * the ground truth, the word is a reading of it.
 *
 * `extra['known']` on the player's record is which factions have actually been
 * met (33 of 113 in the fixture). It is reported and deliberately not editable:
 * adding a row there would be minting, and the relation slot exists either way.
 */

const CACHE_FILE = path.join(__dirname, '..', '.cache', 'factions.json');
const CACHE_VERSION = 1;

const FACTION_TEMPLATE = 10;
const FACTION = 37;
const GAME_STATE = 56;

// Fallbacks for a template that carries neither int — the modal values across
// this install's 114 templates (109/114 and 103/114 respectively).
const DEFAULT_ENEMY_AT = -10;
const DEFAULT_TRADE_AT = -5;

const MIN_RELATION = -100;
const MAX_RELATION = 100;

let cached = null;

/**
 * The type-10 faction catalogue, resolved in the game's own load order.
 *
 * Last definition that CARRIES a field wins — the same discipline
 * `researchService` and `racesService` use, and needed for the same reason: a
 * mod re-defining a faction to attach one squad row must not blank the name and
 * thresholds it never mentioned.
 */
function build() {
  const factions = new Map();
  for (const file of filesInLoadOrder()) {
    let parsed;
    try { parsed = readFile(fs.readFileSync(file)); } catch { continue; }
    for (const rec of parsed.records) {
      if (rec.type !== FACTION_TEMPLATE || !rec.sid) continue;
      let f = factions.get(rec.sid);
      if (!f) {
        f = {
          sid: rec.sid, name: rec.sid, notReal: false,
          enemyAt: DEFAULT_ENEMY_AT, tradeAt: DEFAULT_TRADE_AT, definitions: 0,
        };
        factions.set(rec.sid, f);
      }
      f.definitions++;
      const nm = asText(rec.name); if (nm) f.name = nm;
      // `not real` marks the engine's utility factions — "DEBUG Always Allied
      // Faction" and friends, 41 of the 114. They have working relation rows
      // like everything else, so they are kept and flagged, not dropped.
      if (rec.bools.has('not real')) f.notReal = !!rec.bools.get('not real');
      if (rec.ints.has('enemy classification')) f.enemyAt = rec.ints.get('enemy classification');
      if (rec.ints.has('business relations')) f.tradeAt = rec.ints.get('business relations');
    }
  }
  const list = [...factions.values()].sort((a, b) => a.name.localeCompare(b.name));
  return {
    factions: list,
    stats: {
      factions: list.length,
      notReal: list.filter((f) => f.notReal).length,
      multiDefinition: list.filter((f) => f.definitions > 1).length,
      builtAt: new Date().toISOString(),
    },
  };
}

function load() {
  if (cached) return cached;
  try {
    const disk = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (disk.version === CACHE_VERSION) { cached = disk; return cached; }
  } catch { /* no cache, or a stale one — rebuild */ }
  cached = { version: CACHE_VERSION, ...build() };
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

function catalogue() { return load().factions; }
function stats() { return load().stats; }
function templateOf(sid) { return catalogue().find((f) => f.sid === sid) || null; }

// ---------------------------------------------------------------- reading --

/** Every `relationSID<n>` index on a faction record, as `n -> otherGamedataSid`. */
function rowIndex(rec) {
  const out = new Map();
  for (const [key, value] of rec.strings) {
    const m = /^relationSID(\d+)$/.exec(key);
    if (m) out.set(m[1], asText(value));
  }
  return out;
}

/**
 * Parse `quick.save` into the shape everything else here works on.
 *
 * `world` may be passed in by a caller that has already parsed it (the write
 * path does, so the file is read once per staged edit).
 */
function readFactions(saveDir, world = null) {
  const parsed = world || readFile(fs.readFileSync(path.join(saveDir, 'quick.save')));
  const gs = parsed.records.find((r) => r.type === GAME_STATE);
  const playerName = gs ? asText(gs.strings.get('pfaction name') || '') : '';

  const records = parsed.records.filter((r) => r.type === FACTION);
  if (!records.length) throw new Error('quick.save contains no faction records (type 37)');

  const byGamedataSid = new Map();
  for (const rec of records) {
    const gd = asText(rec.strings.get('gamedata stringID') || '');
    // A record with no gamedata link cannot be named or matched, and none was
    // ever observed — skip rather than guess an identity for it.
    if (gd) byGamedataSid.set(gd, rec);
  }

  // The player is the record with no outgoing relations. Cross-checked against
  // the header name, since that is the independent signal (AGENTS.md §3) and a
  // disagreement means this file is shaped differently from every save checked.
  const rowless = records.filter((r) => rowIndex(r).size === 0);
  let playerRec = rowless.length === 1 ? rowless[0] : null;
  if (!playerRec && playerName) playerRec = records.find((r) => asText(r.name) === playerName) || null;
  if (!playerRec) {
    throw new Error('cannot identify the player faction record in quick.save — '
      + `expected exactly one type-37 record with no relation rows, found ${rowless.length}`);
  }

  return { parsed, gs, playerName, records, byGamedataSid, playerRec };
}

/** Read one relation triple, or null if `from` has no row for `to`. */
function relationRow(fromRec, toGamedataSid) {
  for (const [n, sid] of rowIndex(fromRec)) {
    if (sid !== toGamedataSid) continue;
    return {
      n,
      relation: fromRec.floats.get(`relation${n}`),
      trust: fromRec.floats.get(`trust${n}`),
      trustNeg: fromRec.floats.get(`trustNeg${n}`),
    };
  }
  return null;
}

/**
 * A word for a relation value, read off the target faction's own thresholds.
 * The raw number always travels with it — see the header comment.
 */
function standingOf(relation, tmpl) {
  const enemyAt = tmpl ? tmpl.enemyAt : DEFAULT_ENEMY_AT;
  const tradeAt = tmpl ? tmpl.tradeAt : DEFAULT_TRADE_AT;
  if (relation == null) return 'unknown';
  if (relation <= enemyAt) return 'hostile';
  if (relation < tradeAt) return 'unfriendly';
  if (relation < 0) return 'wary';
  if (relation === 0) return 'neutral';
  if (relation >= 50) return 'allied';
  return 'friendly';
}

/**
 * Every faction's standing toward the player, for this save.
 *
 * Directional: `relation` is how THAT faction feels about the player, which is
 * the direction the game acts on and the only one the save records (the player
 * record has no rows at all).
 */
function relationsFor(saveDir, world = null) {
  const { parsed, playerName, byGamedataSid, playerRec } = readFactions(saveDir, world);
  const playerGd = asText(playerRec.strings.get('gamedata stringID') || '');

  const known = new Set((playerRec.extra.get('known') || []).map((r) => r.target).filter(Boolean));

  const factions = [];
  for (const [gd, rec] of byGamedataSid) {
    if (rec === playerRec) continue;
    const tmpl = templateOf(gd);
    const row = relationRow(rec, playerGd);
    factions.push({
      sid: gd,
      name: tmpl ? tmpl.name : asText(rec.name) || gd,
      saveName: asText(rec.name),
      notReal: tmpl ? tmpl.notReal : false,
      met: known.has(gd),
      enemyAt: tmpl ? tmpl.enemyAt : DEFAULT_ENEMY_AT,
      tradeAt: tmpl ? tmpl.tradeAt : DEFAULT_TRADE_AT,
      relation: row ? row.relation : null,
      trust: row ? row.trust : null,
      trustNeg: row ? row.trustNeg : null,
      standing: row ? standingOf(row.relation, tmpl) : 'no row',
      // A faction with no row toward the player cannot be edited without
      // minting a key, which this service refuses to do. Flagged so the UI can
      // say why rather than offering a control that always fails.
      editable: !!row,
    });
  }
  factions.sort((a, b) => a.name.localeCompare(b.name));

  const counted = factions.filter((f) => f.relation != null);
  return {
    player: {
      name: playerName || asText(playerRec.name),
      sid: playerRec.sid,
      gamedataSid: playerGd,
      gamedataName: (templateOf(playerGd) || {}).name || playerGd,
      globalTrust: playerRec.floats.has('global trust') ? playerRec.floats.get('global trust') : null,
      met: known.size,
    },
    factions,
    counts: {
      total: factions.length,
      withRow: counted.length,
      met: factions.filter((f) => f.met).length,
      notReal: factions.filter((f) => f.notReal).length,
      hostile: counted.filter((f) => f.standing === 'hostile').length,
      unfriendly: counted.filter((f) => f.standing === 'unfriendly' || f.standing === 'wary').length,
      neutral: counted.filter((f) => f.standing === 'neutral').length,
      friendly: counted.filter((f) => f.standing === 'friendly').length,
      allied: counted.filter((f) => f.standing === 'allied').length,
    },
    // `records !== factions.length + 1` would mean a faction record with no
    // gamedata link, which no save on this machine has. Reported rather than
    // asserted, so an unexpected save is visible instead of fatal.
    records: parsed.records.filter((r) => r.type === FACTION).length,
  };
}

/**
 * One faction's full outgoing relation list — how IT sees everyone else. The
 * drill-down behind "why is the Holy Nation fighting the Shek".
 */
function relationsOf(saveDir, gamedataSid, world = null) {
  const { byGamedataSid, playerRec } = readFactions(saveDir, world);
  const rec = byGamedataSid.get(gamedataSid);
  if (!rec) { const e = new Error(`this save has no faction record for "${gamedataSid}"`); e.status = 404; throw e; }
  const playerGd = asText(playerRec.strings.get('gamedata stringID') || '');

  const rows = [];
  for (const [n, otherGd] of rowIndex(rec)) {
    const tmpl = templateOf(otherGd);
    const relation = rec.floats.get(`relation${n}`);
    rows.push({
      sid: otherGd,
      name: tmpl ? tmpl.name : otherGd,
      notReal: tmpl ? tmpl.notReal : false,
      isPlayer: otherGd === playerGd,
      // Every faction carries a row for itself, 100 on all 113 in the fixture.
      // Shown for completeness, never editable — see the header comment.
      isSelf: otherGd === gamedataSid,
      relation,
      trust: rec.floats.get(`trust${n}`),
      trustNeg: rec.floats.get(`trustNeg${n}`),
      standing: standingOf(relation, tmpl),
      editable: rec.floats.has(`relation${n}`) && otherGd !== gamedataSid,
    });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));

  const tmpl = templateOf(gamedataSid);
  return {
    faction: {
      sid: gamedataSid,
      name: tmpl ? tmpl.name : asText(rec.name) || gamedataSid,
      saveName: asText(rec.name),
      notReal: tmpl ? tmpl.notReal : false,
      enemyAt: tmpl ? tmpl.enemyAt : DEFAULT_ENEMY_AT,
      tradeAt: tmpl ? tmpl.tradeAt : DEFAULT_TRADE_AT,
      prosperity: rec.floats.has('prosperity') ? rec.floats.get('prosperity') : null,
      rank: rec.ints.has('rank') ? rec.ints.get('rank') : null,
    },
    playerSid: playerGd,
    relations: rows,
  };
}

// ---------------------------------------------------------------- writing --

/**
 * Set one or more relations, in ONE staged edit.
 *
 * Follows `saveService.setPlayerMoney()`'s reference shape: computes and returns
 * `{ file, bytes, ... }` and never touches the live directory — installing bytes
 * is `mutationService`'s job alone.
 *
 * Every change is directional and names both ends by gamedata stringID:
 * `{ from, to, relation }`. **A change is only applied to a `relation<n>` float
 * that already exists**, matched through `from`'s own `relationSID<n>` row for
 * `to`. There is no path here that adds a key: every faction already carries a
 * row for every other, so a missing one means this save is shaped differently
 * from any observed, and inventing the slot would be a guess written to disk.
 *
 * All changes are validated BEFORE any is applied, so a bad entry in a batch
 * cannot leave a half-applied edit for the gate to reject on a hash diff.
 *
 * @param {string} saveDir
 * @param {{from: string, to: string, relation: number}[]} changes
 */
function setRelations(saveDir, changes) {
  if (!Array.isArray(changes) || !changes.length) {
    throw new Error('setRelations: no changes given');
  }

  const { parsed, byGamedataSid } = readFactions(saveDir);

  const planned = [];
  const seen = new Set();
  for (const change of changes) {
    const { from, to, relation } = change || {};
    for (const [key, value] of Object.entries({ from, to })) {
      if (typeof value !== 'string' || !value) {
        throw new Error(`each change needs "${key}" (a faction gamedata stringID)`);
      }
    }
    if (from === to) throw new Error(`a faction has no relation with itself ("${from}")`);
    if (typeof relation !== 'number' || !Number.isFinite(relation)) {
      throw new Error(`relation for ${from} -> ${to} must be a number`);
    }
    if (relation < MIN_RELATION || relation > MAX_RELATION) {
      throw new Error(`relation must be between ${MIN_RELATION} and ${MAX_RELATION} (got ${relation})`);
    }
    const pairKey = `${from} ${to}`;
    if (seen.has(pairKey)) throw new Error(`${from} -> ${to} is named twice in one request`);
    seen.add(pairKey);

    const rec = byGamedataSid.get(from);
    if (!rec) throw new Error(`this save has no faction record for "${from}"`);
    const row = relationRow(rec, to);
    if (!row) {
      throw new Error(`"${(templateOf(from) || {}).name || from}" has no relation row for `
        + `"${(templateOf(to) || {}).name || to}" — this editor never mints one (see services/factionsService.js)`);
    }
    if (!rec.floats.has(`relation${row.n}`)) {
      throw new Error(`relation row ${row.n} on "${from}" has no relation float to set`);
    }
    planned.push({ rec, row, from, to, relation });
  }

  const applied = [];
  for (const p of planned) {
    const before = p.rec.floats.get(`relation${p.row.n}`);
    p.rec.floats.set(`relation${p.row.n}`, p.relation);
    applied.push({
      from: p.from,
      fromName: (templateOf(p.from) || {}).name || p.from,
      to: p.to,
      toName: (templateOf(p.to) || {}).name || p.to,
      before,
      after: p.relation,
      standing: standingOf(p.relation, templateOf(p.to)),
    });
  }

  return { file: 'quick.save', bytes: writeFile(parsed), changed: applied };
}

module.exports = {
  catalogue, stats, rebuild, templateOf,
  relationsFor, relationsOf, setRelations, standingOf, readFactions, relationRow,
  FACTION, FACTION_TEMPLATE, MIN_RELATION, MAX_RELATION,
};
