'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { readFile, writeFile } = require('./kenshi/codec');
const { asText, fromText } = require('./kenshi/binary');
const gamedata = require('./gamedataService');
// Base-then-mods.cfg-then-unlisted. Shared with racesService, which needs the
// same rule for exactly the same reason — see loadOrder.js.
const { filesInLoadOrder } = require('./loadOrder');

/**
 * Research: what the player has finished, and unlocking more of it.
 *
 * ===========================================================================
 * THE LEDGER
 * ===========================================================================
 * A save's entire research state is ONE type-21 record in `quick.save`. Nothing
 * else in the save mentions research at all — a sweep of every key, category and
 * instance in the file for /finish|research|tech/i returns this record and only
 * this record. It has no name, no instances and no extra rows:
 *
 *   floats: { "num finished": 6622, "num currents": 0 }
 *   strings: { "finished0": "<entry>", "finished1": "<entry>", ... }
 *
 * The `finished<N>` keys are contiguous 0..N-1 in every save checked, and
 * `num finished` always equals the key count. Their order WITHIN the file is
 * arbitrary (a save with 6622 entries has them thoroughly shuffled), so order
 * is not load-bearing here — but the codec still preserves it, and new entries
 * are appended rather than inserted, so a rewritten ledger stays byte-identical
 * apart from what was added.
 *
 * An entry is one of three shapes, and telling them apart is the whole job:
 *
 *   "2915-gamedata.base"        a finished TECH (the type-21 gamedata record)
 *   "2058-gamedata.base.4"      level 4 of a REPEATING tech (level 1 = bare sid)
 *   "66169-Newwworld.mod.TECH.1"  an unlocked ITEM blueprint, not a tech at all
 *
 * The `.N` form was confirmed, not guessed: all 14 base sids carrying one
 * resolve to a tech with `repeats > 0`, their `N` runs contiguously from 2, the
 * bare sid is always present too, and no tech with `repeats: 0` ever has one.
 *
 * The `.TECH.N` form points at an ITEM template (armour, crossbows, backpacks),
 * never at a tech. It is a separate ledger dimension — which craftables are
 * unlocked — and this service reports it but does not write it. The obvious
 * hypothesis, "a finished tech implies its enable-* items are listed", is FALSE:
 * 439 things named by a finished tech's `enable buildings`/`enable armour`/...
 * rows are absent from the ledger, and 6344 listed items are named by no tech.
 * Inventing a rule there would be guessing; unlocking a tech writes the tech.
 *
 * ===========================================================================
 * WHY LOAD ORDER MATTERS
 * ===========================================================================
 * 183 of this install's 199 techs are defined more than once — mods re-define
 * vanilla techs, and the LAST definition wins, exactly as Kenshi itself layers
 * them. First-definition-wins is not merely untidy, it is wrong: sid
 * `2058-gamedata.base` is "Weapon Smithing" with `repeats: 14` in gamedata.base
 * and "Basic Weapon Grades" with `repeats: 5` in rebirth.mod, and the live save
 * has levels up to exactly 5. 20 techs display a different NAME depending on
 * which rule you use.
 *
 * The order comes from `data/mods.cfg`, the game's own load order. A definition
 * only overrides a field it actually carries: a mod that re-defines a tech purely
 * to attach an `enable armour` row leaves `repeats` alone rather than clearing
 * it. `extra` rows are unioned across every definition, the same rule (and the
 * same reason) as gamedataService's material index.
 *
 * The invariant that proves the whole arrangement: every tech's resolved
 * `repeats` must be >= the highest level the live ledger records for it. Under
 * load-order resolution 194 of 194 pass; under first-definition-wins one fails.
 * `test/research.test.js` asserts it.
 */

const CACHE_FILE = path.join(__dirname, '..', '.cache', 'research.json');
// Keyed on the gamedata index version too: this cache bakes in names that come
// from there (what a tech unlocks), so a change to how names resolve must
// invalidate it.
const CACHE_VERSION = `1.${gamedata.INDEX_VERSION}`;

const TECH = 21;

// Categories on a tech naming something it makes available. Reported so the UI
// can say what a tech is FOR; never written to the ledger (see the header).
const UNLOCK_CATS = [
  'enable buildings', 'improve buildings', 'enable item', 'enable armour',
  'enable weapon type', 'enable weapon model', 'enable robotics', 'enable crossbow',
  'enable backpack', 'blueprint item',
];

let cached = null;

/**
 * Engine-reserved boilerplate, not an authored record.
 *
 * Every record a person actually wrote has a `<numericId>-<sourceFile>` sid.
 * The handful that don't are Kenshi's own fixtures — `RESEARCH_TEMPLATE`,
 * `PLAYER_WEAPONS`, `FISTS`, `blank squad` and 19 others across all of
 * gamedata. `RESEARCH_TEMPLATE` is the only type-21 one: the blank an FCS user
 * copies to make a new tech, with no description, no cost and nothing to
 * unlock. The game marks it finished in every save, so it is still CLASSIFIED
 * (otherwise it would show up as an unrecognised ledger entry) — it is just
 * kept out of the tech tree, where a row called "RESEARCH_TEMPLATE" would be
 * noise the player can neither research nor use.
 */
function isReserved(sid) { return !sid.includes('-'); }

/** Resolve every type-21 tech: scalars last-definition-wins, extra rows unioned. */
function build() {
  const techs = new Map();
  for (const file of filesInLoadOrder()) {
    let parsed;
    try { parsed = readFile(fs.readFileSync(file)); } catch { continue; }
    const from = path.basename(file);
    for (const rec of parsed.records) {
      if (rec.type !== TECH || !rec.sid) continue;
      let t = techs.get(rec.sid);
      if (!t) {
        t = { sid: rec.sid, name: rec.sid, category: '', description: '',
          level: 0, time: 0, money: 0, repeats: 0, blueprintOnly: false,
          extra: new Map(), definedIn: [] };
        techs.set(rec.sid, t);
      }
      t.definedIn.push(from);
      // Only a definition that CARRIES a field overrides it — a mod attaching
      // one extra row must not blank out the scalars it never mentioned.
      const nm = asText(rec.name);
      if (nm) t.name = nm;
      if (rec.ints.has('level')) t.level = rec.ints.get('level');
      if (rec.ints.has('time')) t.time = rec.ints.get('time');
      if (rec.ints.has('money')) t.money = rec.ints.get('money');
      if (rec.ints.has('repeats')) t.repeats = rec.ints.get('repeats');
      if (rec.strings.has('category')) t.category = asText(rec.strings.get('category'));
      if (rec.strings.has('description')) t.description = asText(rec.strings.get('description'));
      if (rec.bools.has('blueprint only')) t.blueprintOnly = !!rec.bools.get('blueprint only');
      for (const [cat, rows] of rec.extra) {
        let set = t.extra.get(cat);
        if (!set) { set = new Map(); t.extra.set(cat, set); }
        for (const row of rows) if (row.target && !set.has(row.target)) set.set(row.target, row.v0);
      }
    }
  }

  const nameOf = (sid) => (gamedata.lookup(sid) || {}).name || sid;
  const list = [...techs.values()].filter((t) => !isReserved(t.sid)).map((t) => {
    const reqs = [...(t.extra.get('requirements') || new Map()).keys()];
    const cost = [...(t.extra.get('cost') || new Map())].map(([sid, v0]) => ({
      sid, name: nameOf(sid), count: v0,
    }));
    const unlocks = [];
    for (const cat of UNLOCK_CATS) {
      for (const sid of (t.extra.get(cat) || new Map()).keys()) {
        unlocks.push({ sid, name: nameOf(sid), category: cat });
      }
    }
    return {
      sid: t.sid,
      name: t.name,
      category: t.category || 'Uncategorised',
      description: t.description,
      level: t.level,
      time: t.time,
      money: t.money,
      // `repeats` is the number of LEVELS this tech has: level 1 is the bare
      // sid, levels 2..repeats are the `.N` entries. 0 means it is researched
      // once and has no levels.
      repeats: t.repeats,
      blueprintOnly: t.blueprintOnly,
      requirements: reqs.map((sid) => ({ sid, name: (techs.get(sid) || {}).name || sid })),
      cost,
      unlocks,
      definitions: t.definedIn.length,
    };
  });

  // Requirements first, then the game's own ordering signals: tech level, then
  // name. A tree the player reads top-to-bottom should never list a tech above
  // something it depends on.
  list.sort((a, b) => a.category.localeCompare(b.category) || a.level - b.level
    || a.name.localeCompare(b.name));

  const stats = {
    techs: list.length,
    categories: new Set(list.map((t) => t.category)).size,
    repeatable: list.filter((t) => t.repeats > 0).length,
    blueprintOnly: list.filter((t) => t.blueprintOnly).length,
    withRequirements: list.filter((t) => t.requirements.length).length,
    multiDefinition: list.filter((t) => t.definitions > 1).length,
    builtAt: new Date().toISOString(),
  };
  return { techs: list, stats };
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

function catalogue() { return load().techs; }
function stats() { return load().stats; }
function techBySid(sid) { return catalogue().find((t) => t.sid === sid) || null; }

// ---------------------------------------------------------------------------
// Reading a save's ledger
// ---------------------------------------------------------------------------

/** The one type-21 record in a parsed quick.save. Throws if it isn't there. */
function ledgerRecord(world) {
  const recs = world.records.filter((r) => r.type === TECH);
  if (recs.length !== 1) {
    throw new Error(`expected exactly 1 research record in quick.save, found ${recs.length}`);
  }
  return recs[0];
}

/** Raw entries, in file order. */
function entriesOf(rec) {
  const out = [];
  for (const [key, value] of rec.strings) {
    if (!/^finished\d+$/.test(key)) continue;
    out.push(asText(value));
  }
  return out;
}

/**
 * Classify one ledger entry. `known` is the tech catalogue, needed to tell
 * "<sid>.4" (level 4 of a repeating tech) from a sid that merely ends in a dot
 * and a digit — the suffix is only a level if stripping it yields a real tech.
 */
function classify(entry, known) {
  if (/\.TECH\.\d+$/.test(entry)) return { kind: 'blueprint', sid: entry.replace(/\.TECH\.\d+$/, ''), level: null };
  const m = /^(.*)\.(\d+)$/.exec(entry);
  if (m && known.has(m[1])) return { kind: 'tech', sid: m[1], level: Number(m[2]) };
  if (known.has(entry)) return { kind: 'tech', sid: entry, level: 1 };
  // Recognised, deliberately not a tech — see isReserved().
  if (isReserved(m ? m[1] : entry)) return { kind: 'reserved', sid: m ? m[1] : entry, level: null };
  return { kind: 'unknown', sid: entry, level: null };
}

/**
 * What this save has researched, joined onto the catalogue.
 *
 * `world` may be passed in by a caller that has already parsed quick.save.
 */
function statusFor(saveDir, world = null) {
  const parsed = world || readFile(fs.readFileSync(path.join(saveDir, 'quick.save')));
  const rec = ledgerRecord(parsed);
  const all = catalogue();
  const known = new Map(all.map((t) => [t.sid, t]));

  const levels = new Map(); // techSid -> highest level finished
  let blueprints = 0;
  let reserved = 0;
  const unknown = [];
  for (const entry of entriesOf(rec)) {
    const c = classify(entry, known);
    if (c.kind === 'tech') levels.set(c.sid, Math.max(levels.get(c.sid) || 0, c.level));
    else if (c.kind === 'blueprint') blueprints++;
    else if (c.kind === 'reserved') reserved++;
    else unknown.push(entry);
  }

  const techs = all.map((t) => {
    const level = levels.get(t.sid) || 0;
    const maxLevel = t.repeats > 0 ? t.repeats : 1;
    return {
      ...t,
      done: level > 0,
      level: t.level, // tech tier, kept as-is
      atLevel: level,
      maxLevel,
      maxed: level >= maxLevel,
      // A tech whose own requirements are unfinished: still writable (the ledger
      // has no ordering rule), but worth showing, and what `withRequirements`
      // exists to fix.
      blockedBy: t.requirements.filter((r) => !(levels.get(r.sid) > 0)).map((r) => r.name),
    };
  });

  return {
    techs,
    counts: {
      total: all.length,
      done: techs.filter((t) => t.done).length,
      maxed: techs.filter((t) => t.maxed).length,
      // Repeat levels beyond level 1 that this save has banked.
      extraLevels: [...levels.entries()].reduce((n, [, lv]) => n + Math.max(0, lv - 1), 0),
      // The other ledger dimension: unlocked craftable blueprints. Reported
      // because it is most of the ledger (6391 of 6622 entries in this save)
      // and hiding it would make "6622 finished" look inexplicable.
      blueprints,
      // Engine boilerplate the game marks finished (RESEARCH_TEMPLATE) —
      // recognised so it never masquerades as an unrecognised entry.
      reserved,
      unknown: unknown.length,
      entries: entriesOf(rec).length,
    },
    byCategory: [...techs.reduce((m, t) => {
      const c = m.get(t.category) || { category: t.category, total: 0, done: 0 };
      c.total++; if (t.done) c.done++;
      m.set(t.category, c);
      return m;
    }, new Map()).values()].sort((a, b) => a.category.localeCompare(b.category)),
  };
}

// ---------------------------------------------------------------------------
// Unlocking
// ---------------------------------------------------------------------------

/**
 * Collect the ledger entries a set of techs needs, including the levels below a
 * requested one and (optionally) unfinished prerequisites.
 */
function plan(sids, { levels = {}, withRequirements = true } = {}, known, have) {
  const wanted = new Map(); // techSid -> level to reach
  const add = (sid, depth) => {
    const t = known.get(sid);
    if (!t) throw new Error(`unknown research tech "${sid}"`);
    const cap = t.repeats > 0 ? t.repeats : 1;
    const asked = Number.isInteger(levels[sid]) ? levels[sid] : cap;
    if (asked < 1 || asked > cap) {
      throw new Error(`"${t.name}" has levels 1..${cap}; ${asked} is out of range`);
    }
    const prev = wanted.get(sid) || 0;
    if (asked > prev) wanted.set(sid, asked);
    if (!withRequirements || depth > 64) return;
    for (const r of t.requirements) if (!(have.get(r.sid) > 0)) add(r.sid, depth + 1);
  };
  for (const sid of sids) add(sid, 0);

  const entries = [];
  for (const [sid, level] of wanted) {
    for (let n = 1; n <= level; n++) {
      if ((have.get(sid) || 0) >= n) continue; // already banked
      entries.push({ entry: n === 1 ? sid : `${sid}.${n}`, sid, level: n, name: known.get(sid).name });
    }
  }
  return entries;
}

/**
 * Mark research finished. Returns the new bytes; installing them is
 * mutationService's job, never this function's (the setPlayerMoney contract).
 *
 * Appends `finished<N>` keys and bumps `num finished`. It never rewrites or
 * reorders an existing entry, so everything already in the ledger — including
 * the 6391 blueprint entries this service deliberately does not model — comes
 * back out byte-identical.
 *
 * @param {string} saveDir
 * @param {object} opts
 * @param {string[]} opts.sids            tech sids to finish
 * @param {Record<string,number>} [opts.levels]  per-sid level to reach (default: max)
 * @param {boolean} [opts.withRequirements=true] also finish unfinished prerequisites
 */
function unlock(saveDir, { sids, levels = {}, withRequirements = true } = {}) {
  const list = Array.isArray(sids) ? sids.filter(Boolean) : [];
  if (!list.length) throw new Error('unlock: no research techs given');

  const world = readFile(fs.readFileSync(path.join(saveDir, 'quick.save')));
  const rec = ledgerRecord(world);
  const known = new Map(catalogue().map((t) => [t.sid, t]));

  const existing = entriesOf(rec);
  const seen = new Set(existing);
  const have = new Map();
  for (const e of existing) {
    const c = classify(e, known);
    if (c.kind === 'tech') have.set(c.sid, Math.max(have.get(c.sid) || 0, c.level));
  }

  const planned = plan(list, { levels, withRequirements }, known, have);
  const added = planned.filter((p) => !seen.has(p.entry));
  if (!added.length) {
    throw new Error('nothing to unlock — every requested tech and level is already finished');
  }

  // Append at the next free index. The keys are contiguous 0..n-1 in every save
  // checked, and `num finished` is the count, so the next index is the count.
  let next = existing.length;
  for (const a of added) {
    rec.strings.set(`finished${next}`, fromText(a.entry));
    seen.add(a.entry);
    next++;
  }
  rec.floats.set('num finished', next);

  return {
    file: 'quick.save',
    bytes: writeFile(world),
    before: existing.length,
    after: next,
    added: added.map((a) => ({ sid: a.sid, name: a.name, level: a.level, entry: a.entry })),
    requested: list.length,
  };
}

module.exports = {
  catalogue, stats, rebuild, techBySid, statusFor, unlock,
  // exported for tests: the ledger's read side, independent of any save on disk
  ledgerRecord, entriesOf, classify, filesInLoadOrder, UNLOCK_CATS,
};
