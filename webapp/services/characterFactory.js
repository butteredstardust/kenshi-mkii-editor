'use strict';

const { fromText } = require('./kenshi/binary');

/**
 * Builds the record cluster for a NEW squad member, the way itemFactory.js
 * builds a new ITEM record. saveService.addSquadMember() owns the save-directory
 * work (finding a donor, minting ids, updating counts); everything about what a
 * character's records must *look like* lives here.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS CLONES A DONOR RATHER THAN BUILDING FROM A TEMPLATE
 * ---------------------------------------------------------------------------
 * A character is not one record. It is a SQUAD (30) instance pointing at six
 * state records — CHAR_STATE (36), AI (67), INVENTORY (41), MEDICAL (57),
 * STATS (25) and APPEARANCE (66) — and their contents are race-dependent in
 * ways this editor has NOT derived:
 *
 *   - MEDICAL carries a per-race body plan: `hit<n>`/`flesh<n>`/`sid<n>` for
 *     each body part, where `sid<n>` names the part ("32-gamedata.quack" =
 *     Head). Get the plan wrong and hit detection breaks (TODO.md 1.5).
 *   - APPEARANCE carries race-specific slider keys (a Hive record has
 *     `stick_wide_jaw`/`stick_long_horns` keys a Human record does not) and
 *     the race itself lives in the `extra` section, category "race", as a
 *     single row whose `target` is the race stringID — not in any of the
 *     key/value Maps (Phase 0 finding).
 *   - STATS carries whatever skill float keys that race/character actually has.
 *
 * Synthesising all of that from a gamedata race template (typecode 7) would
 * mean deriving the game's own character-instantiation rules. Cloning an
 * existing character of the requested race takes every one of those structures
 * from data the game itself wrote, and reduces the problem to "which fields
 * identify a character rather than describe its species" — a much smaller,
 * checkable list, which is the whole of `sanitiseState()`/`healMedical()`
 * below. The race is never rewritten: the donor is chosen BY race, so
 * `extra['race']` and the body plan are consistent by construction.
 *
 * Two of the six are minted outright rather than cloned, because their shape is
 * trivial and measured:
 *   - AI (67): 280 of the 282 AI records in the sampled live save are exactly
 *     `{ bools: { jobs } }` with the record name "ai" and nothing else. The two
 *     exceptions carry a `tjob0`/`pjob0` handle pointing at a specific job
 *     target — precisely the thing a new character must NOT inherit.
 *   - INVENTORY (41): every sampled one is empty in all nine sections; it is a
 *     pure container whose `instances` point at ITEM (42) records. A new member
 *     starts with nothing, so it is minted with zero instances and gear is
 *     added afterwards through the existing Gear page.
 */

// The six state-record typecodes a character instance points at. Order is not
// significant to the parser, but the donor's own order is preserved on write
// (see buildStateRecords) rather than imposing one of ours.
const REQUIRED_STATE_TYPES = [36, 67, 41, 57, 25, 66];

const T = { STATS: 25, SQUAD: 30, CHAR_STATE: 36, INVENTORY: 41, MEDICAL: 57, AI: 67, APPEARANCE: 66 };

const BODY_SLOTS = 7;

/**
 * Bounty field families on CHAR_STATE (Phase 0 finding): `ints.amount<n>`,
 * `ints.bountyexp<n>`, `ints.claim<n>`, `ints.crimes<n>` and
 * `strings.bountyfac<n>`. A cloned donor could be a wanted Cannibal; the new
 * recruit must not inherit a price on their head.
 */
const BOUNTY_INT_KEYS = /^(amount|bountyexp|claim|crimes)\d+$/;
const BOUNTY_STRING_KEYS = /^bountyfac\d+$/;

/** Deep copy of a parsed record, minus identity (`id`/`sid` are stamped on append). */
function cloneRecord(rec) {
  const copyMap = (m) => new Map(m);
  return {
    instanceCount: rec.instanceCount,
    type: rec.type,
    name: rec.name,
    modDataType: rec.modDataType,
    bools: copyMap(rec.bools),
    floats: copyMap(rec.floats),
    ints: copyMap(rec.ints),
    vec3: new Map([...rec.vec3].map(([k, v]) => [k, [...v]])),
    vec4: new Map([...rec.vec4].map(([k, v]) => [k, [...v]])),
    strings: copyMap(rec.strings),
    filenames: copyMap(rec.filenames),
    extra: new Map([...rec.extra].map(([k, rows]) => [k, rows.map((r) => ({ ...r }))])),
    instances: rec.instances.map((i) => ({
      id: i.id, target: i.target, pos: [...i.pos], rot: [...i.rot], states: [...i.states],
    })),
  };
}

/**
 * Strip the donor's identity and affiliation off a cloned CHAR_STATE (36).
 *
 * Everything touched here is a key already present on a live record — nothing
 * is minted, matching the discipline in setStats()/updateItem(). `is leader` is
 * forced false because a squad has exactly one leader and the donor may have
 * been theirs; `slavestate` is zeroed because a cloned slave would arrive
 * already owned.
 */
function sanitiseState(rec, { name, ownerFactionSid }) {
  rec.strings.set('name', fromText(name));
  if (ownerFactionSid !== undefined && rec.strings.has('owner faction ID')) {
    rec.strings.set('owner faction ID', ownerFactionSid);
  }
  if (rec.bools.has('is leader')) rec.bools.set('is leader', false);
  if (rec.ints.has('slavestate')) rec.ints.set('slavestate', 0);

  const cleared = [];
  for (const key of [...rec.ints.keys()]) {
    if (BOUNTY_INT_KEYS.test(key)) { rec.ints.delete(key); cleared.push(key); }
  }
  for (const key of [...rec.strings.keys()]) {
    if (BOUNTY_STRING_KEYS.test(key)) { rec.strings.delete(key); cleared.push(key); }
  }
  return { clearedBountyKeys: cleared };
}

/**
 * Bring a cloned MEDICAL (57) record to full health.
 *
 * "Full" is the character's own highest `flesh<n>`, never `hit<n>` — AGENTS.md
 * §3 and this codebase's healPart()/revive() both treat `hit<n>` as an
 * untrustworthy maximum (an undamaged arm reads 100 against a hit of 80). The
 * donor was chosen for being healthy, so its own highest part is a real
 * undamaged value for that race.
 *
 * `blood` is deliberately LEFT ALONE. Its scale is not understood: across 282
 * live MEDICAL records it ranges from -67.8 to 183.2, so there is no defensible
 * "full" to write. Picking a healthy donor is what keeps this sane, and
 * addSquadMember() reports the value it inherited.
 */
function healMedical(rec) {
  const current = [];
  for (let i = 0; i < BODY_SLOTS; i++) {
    if (rec.floats.has(`hit${i}`)) current.push(rec.floats.get(`flesh${i}`) ?? 0);
  }
  const full = Math.max(0, ...current);
  for (let i = 0; i < BODY_SLOTS; i++) {
    if (!rec.floats.has(`hit${i}`)) continue;
    rec.floats.set(`flesh${i}`, full);
    if (rec.floats.has(`bandage${i}`)) rec.floats.set(`bandage${i}`, 0);
    if (rec.floats.has(`stun${i}`)) rec.floats.set(`stun${i}`, 0);
  }
  for (const [key, value] of [['bleeding', 0], ['KO', 0], ['hung', 0]]) {
    if (rec.floats.has(key)) rec.floats.set(key, value);
  }
  for (const key of ['dead', 'coma', 'unconcious', 'incapacitated']) { // the game's own spelling
    if (rec.bools.has(key)) rec.bools.set(key, false);
  }
  // Same treatment as restoreLimbs(): delete the key rather than interpret a
  // bitmask this editor has not decoded.
  const hadLimbs = rec.ints.has('limbs');
  rec.ints.delete('limbs');
  return { fleshFull: full, clearedLimbs: hadLimbs, blood: rec.floats.get('blood') ?? null };
}

/** A fresh AI (67) record. See the header comment for why this is minted, not cloned. */
function buildAiRecord() {
  return {
    instanceCount: 0,
    type: T.AI,
    name: 'ai',
    modDataType: 0,
    bools: new Map([['jobs', true]]),
    floats: new Map(),
    ints: new Map(),
    vec3: new Map(),
    vec4: new Map(),
    strings: new Map(),
    filenames: new Map(),
    extra: new Map(),
    instances: [],
  };
}

/** A fresh, empty INVENTORY (41) container. */
function buildInventoryRecord() {
  return {
    instanceCount: 0,
    type: T.INVENTORY,
    name: '0',
    modDataType: 0,
    bools: new Map(),
    floats: new Map(),
    ints: new Map(),
    vec3: new Map(),
    vec4: new Map(),
    strings: new Map(),
    filenames: new Map(),
    extra: new Map(),
    instances: [],
  };
}

/**
 * Build the six state records for a new member from `donorStates` — the donor
 * instance's state records, in the donor instance's own order.
 *
 * Returns records in that SAME order, index-aligned, so the caller can mint ids
 * for them and rebuild the new instance's `states` array positionally without
 * having to know which slot means what.
 *
 * @param {object[]} donorStates  parsed records (must include all six typecodes)
 * @param {object}   opts
 * @param {string}   opts.name              display name, as UTF-8 text
 * @param {string}   [opts.ownerFactionSid] target squad's faction stringID
 * @param {function} [opts.applyStats]      (statsRecord) => void, called on the
 *   cloned STATS record; saveService owns the stat-spread logic so training and
 *   recruiting can't drift apart.
 */
function buildStateRecords(donorStates, { name, ownerFactionSid, applyStats } = {}) {
  if (!name || typeof name !== 'string') throw new Error('buildStateRecords: name is required');

  const present = new Set(donorStates.map((r) => r.type));
  const missing = REQUIRED_STATE_TYPES.filter((t) => !present.has(t));
  if (missing.length) {
    throw new Error(`donor character is missing state record type(s) ${missing.join(', ')} — cannot clone it`);
  }

  const meta = {};
  const records = donorStates.map((donor) => {
    switch (donor.type) {
      case T.AI: return buildAiRecord();
      case T.INVENTORY: return buildInventoryRecord();
      case T.CHAR_STATE: {
        const rec = cloneRecord(donor);
        Object.assign(meta, sanitiseState(rec, { name, ownerFactionSid }));
        return rec;
      }
      case T.MEDICAL: {
        const rec = cloneRecord(donor);
        meta.medical = healMedical(rec);
        return rec;
      }
      case T.STATS: {
        const rec = cloneRecord(donor);
        // The record header `name` on a STATS record carries the character's
        // name for a player character ("Dai") and the origin template's name
        // for an untouched NPC ("Cannibal"). Writing the new name matches what
        // the game does for a named character and what the FCS guide advises.
        rec.name = fromText(name);
        if (applyStats) meta.stats = applyStats(rec);
        return rec;
      }
      default:
        // APPEARANCE (66), and defensively anything else the donor carries:
        // copied verbatim. This is the record that makes the new member the
        // requested race, and nothing in it identifies the donor.
        return cloneRecord(donor);
    }
  });

  return { records, meta };
}

module.exports = {
  T, REQUIRED_STATE_TYPES, BODY_SLOTS,
  cloneRecord, sanitiseState, healMedical,
  buildAiRecord, buildInventoryRecord, buildStateRecords,
};
