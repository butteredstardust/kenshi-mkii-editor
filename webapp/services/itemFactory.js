'use strict';

const gamedata = require('./gamedataService');
const blueprints = require('./blueprints');

/**
 * Builds a fully-formed type-42 ITEM record for a given item TEMPLATE sid
 * (typecode 2 weapon / 3 armour / 4 trade goods). This is where TODO.md
 * 2.2(a)/(b)'s shape knowledge lives, kept out of saveService.js.
 *
 * Every section key order and default value below is a measured fact from a
 * read-only sweep of a live save (1648 type-42 records, 62624 gamedata
 * templates — see TODO.md 2.2's "Investigation complete" block). Do not add,
 * remove or reorder a key without updating that investigation; key order is
 * load-bearing in this format (AGENTS.md §3).
 *
 * Returns `{ record, meta }`:
 *   - `record` is shaped exactly like codec.js's readRecord() output (the
 *     nine section Maps + `instances` array, plus `instanceCount`/`name`/
 *     `modDataType`/`type`) MINUS identity (`id`/`sid`) — ids.addRecord()
 *     stamps those on append.
 *   - `meta` is caller-facing information for a receipt (template name/type,
 *     and — for weapons — which grade ladder entry was used and whether it
 *     was defaulted). Never written to disk.
 */

// Template typecodes this can mint an ITEM record for: 2 weapon, 3 armour,
// 4 trade goods, 46 backpack, 107 crossbow, 111 robotic limb, 102 map. Never
// 42 — that IS the item instance (2.2(g)).
const TEMPLATE_TYPES = [2, 3, 4, 46, 107, 111, 102];

// Robotic limbs (type 111) are the one kind with extra float keys: all 11 live
// ones carry `wear`, `stun` and `dam` ahead of the usual `charges`/`quality`,
// and key order is load-bearing in this format (AGENTS.md §3). They are the
// limb's own condition; a fresh one is 0.
const LIMB_FLOATS = ['wear', 'stun', 'dam'];

// 2.2(a): the two `strings` key orders differ only by whether `uniform` is
// present. Confirmed present for template types 2 (weapon), 3 (armour) and 107
// (crossbow — all 7 live ones carry it), and absent for 4 and, from the
// type-46 sweep, for backpacks: all 42 live backpack items carry exactly
// `color sid, material sid, company sid, section, base data sid`, no `uniform`.
function isEquippableTemplateType(type) {
  // Types 4 (trade goods), 46 (backpack) and 102 (map) carry no `uniform` key —
  // confirmed on every live example of each.
  return type !== 4 && type !== 46 && type !== 102;
}

/**
 * Resolve a caller's grade choice to exactly one ladder row.
 *
 * `gradeId` ("<companySid>|<modelSid>", from gamedataService.weaponGrades()) is
 * the correct key and the only unambiguous one. `materialSid` is kept working
 * because it is the older API, but it names a MODEL, not a grade: 14 of this
 * install's 24 model sids belong to two companies at once, so it can match more
 * than one row. When it does, this picks the lowest-ranked match — deliberately
 * the least generous reading — and the caller can pass `companySid` to say
 * which one it actually meant. Passing a `companySid` that doesn't match throws
 * rather than quietly writing a different manufacturer.
 */
function resolveGrade({ gradeId, materialSid, companySid }) {
  const grades = gamedata.weaponGrades();

  if (gradeId) {
    const hit = grades.find((g) => g.id === gradeId);
    if (!hit) throw new Error(`"${gradeId}" is not a known weapon grade id`);
    if (companySid && companySid !== hit.companySid) {
      throw new Error(`companySid "${companySid}" does not match grade "${gradeId}" (company is "${hit.companySid}")`);
    }
    return hit;
  }

  const matches = grades.filter((g) => g.modelSid === materialSid);
  if (!matches.length) throw new Error(`"${materialSid}" is not a known weapon grade (type-50) sid`);
  if (companySid) {
    const exact = matches.find((g) => g.companySid === companySid);
    if (!exact) {
      throw new Error(
        `companySid "${companySid}" does not match any ladder entry for materialSid "${materialSid}" `
        + `(available: ${matches.map((g) => g.companySid).join(', ')})`,
      );
    }
    return exact;
  }
  // Ambiguous and unqualified: lowest rank wins, then lowest company sid, so
  // the choice is at least deterministic across runs and cache rebuilds.
  return [...matches].sort((a, b) => (a.rank - b.rank)
    || (a.companySid < b.companySid ? -1 : a.companySid > b.companySid ? 1 : 0))[0];
}

/**
 * @param {string} templateSid  a gamedata TEMPLATE sid (typecode 2/3/4/46)
 * @param {object} opts
 * @param {string} opts.section     required — validated by the caller via
 *   itemSlots.allowedSections(templateSid, null) (2.2(f)); not re-validated here.
 * @param {number} [opts.level]     type 2/3 only; types 4 and 46 always mint 0
 *   and ignore this (2.2(e)).
 * @param {number} [opts.quantity=1]  written as-is; stackability is validated
 *   by the caller (2.2(d)).
 * @param {string} [opts.gradeId]   type 2 only: "<companySid>|<modelSid>" from
 *   gamedataService.weaponGrades(). The unambiguous way to name a grade —
 *   prefer it over materialSid. See resolveGrade().
 * @param {string} [opts.materialSid]  type 2: a type-50 MODEL sid, which can
 *   match more than one ladder row (see resolveGrade()); type 3/4/46: an
 *   explicit `material sid` override, bypassing the union-of-definitions
 *   default (2.2(h)).
 * @param {string} [opts.companySid]  type 2 only: disambiguates an ambiguous
 *   `materialSid`, and must agree with `gradeId` if both are given; ignored for
 *   type 3/4/46, which always mint an empty `company sid` (2.2(b)).
 * @param {string} [opts.teaches]   BLUEPRINT templates only: the research-ledger
 *   entry this blueprint grants. Written into BOTH `material sid` and
 *   `company sid`, which is what all 876 live blueprint items do — see
 *   services/blueprints.js for the sweep. Refused on any other template.
 */
function buildItemRecord(templateSid, opts = {}) {
  const tmpl = gamedata.lookup(templateSid);
  if (!tmpl) throw new Error(`unresolvable item template sid "${templateSid}"`);
  if (!TEMPLATE_TYPES.includes(tmpl.type)) {
    throw new Error(`template "${templateSid}" (${tmpl.name}) is typecode ${tmpl.type}, not an item template (${TEMPLATE_TYPES.join('/')}) — see TODO.md 2.2(g)`);
  }

  const {
    section, level, quantity = 1,
    gradeId, materialSid: materialOverride, companySid: companyOverride, teaches,
  } = opts;
  if (!section) throw new Error('buildItemRecord: section is required');

  // A blueprint's subject is carried in the two fields a weapon uses for its
  // grade, so the two options are mutually exclusive by construction as well as
  // by kind. Refuse rather than pick one: silently dropping `teaches` mints a
  // blank blueprint that teaches nothing, and a blank one is indistinguishable
  // in game from a real one until the player clicks it.
  const blueprintMeta = teaches === undefined ? null : blueprints.describeEntry(teaches);
  if (blueprintMeta && !blueprints.isBlueprintTemplate(templateSid)) {
    throw new Error(
      `"${tmpl.name}" is not a blueprint item template — "teaches" only applies to one of `
      + `${blueprints.templates().map((t) => t.sid).join(', ') || '(none in this install)'}`,
    );
  }

  // --- item function (2.2(b)) ---
  let itemFunction;
  if (tmpl.type === 2) itemFunction = 5; // 262/262 live weapons
  else if (tmpl.type === 3) itemFunction = 6; // 882/882 live armour
  else if (tmpl.type === 46) itemFunction = 4; // 42/42 live backpacks
  else if (tmpl.type === 107) itemFunction = 0; // 7/7 live crossbows
  else if (tmpl.type === 111) itemFunction = 0; // 11/11 live robotic limbs
  else if (tmpl.type === 102) itemFunction = 0; // 39/39 live maps
  else {
    // Type 4: copy the template's own `ints['item function']` (cached on the
    // gamedata index entry as `itemFunction`). Matched the live item on every
    // type-4 template sampled except two observed exceptions (Cats/String of
    // Cats from Newwworld.mod, and one Building Materials template) —
    // plausibly load-order overrides this editor's first-definition-wins
    // index resolves differently. Not claimed exceptionless. Falls back to 0
    // when the template itself has no such field (shouldn't happen for a
    // real type-4 template, but better than minting `undefined`).
    itemFunction = tmpl.itemFunction ?? 0;
  }

  // --- material / company (2.2(b)/(e)/(h)/(i)) ---
  let materialSid = '';
  let companySid = '';
  let grade = null; // receipt info only, weapons only
  if (tmpl.type === 2) {
    const grades = gamedata.weaponGrades();
    if (gradeId || materialOverride) {
      grade = resolveGrade({ gradeId, materialSid: materialOverride, companySid: companyOverride });
    } else if (grades.length) {
      // No grade requested: default to the LOWEST-ranked ladder entry, per
      // TODO.md 2.2(i) — never silently hand out a high-tier weapon.
      grade = grades[0];
    }
    if (grade) {
      materialSid = grade.modelSid;
      companySid = grade.companySid;
    }
    // If this install's data has no weapon-grade ladder at all (grades.length
    // === 0), materialSid/companySid stay '' — flagged via `grade: null` in
    // meta rather than thrown, since the item itself is still mintable.
  } else {
    // Only a melee weapon (type 2) has a manufacturer ladder. Asking for a
    // grade on anything else is a caller error, not something to drop quietly:
    // silently ignoring it would hand back a plain item while the caller
    // believes it minted a Meitou. saveService.updateItem() refuses the same
    // way ("is not a weapon"), so the two paths agree.
    if (gradeId) {
      throw new Error(`"${tmpl.name}" is typecode ${tmpl.type}, which has no weapon grade — gradeId does not apply`);
    }
    // Type 3/4/46/107: `material sid` defaults to the first candidate in the
    // union of extra['material'] targets across every definition of this sid
    // (2.2(h)); `company sid` is always empty (universal on all 882+503 live
    // type-3/4 records, all 42 live type-46 ones, and all 7 type-107 ones —
    // a crossbow's `material sid` names its model, e.g. "Handheld Crossbow").
    //
    // Type 102 (map) is the exception: its template DOES carry an
    // extra['material'] row ("Item_Map"), but all 39 live map items have an
    // EMPTY `material sid`. Follow the items, not the template.
    //
    // A BLUEPRINT is the other exception, and the only kind that fills
    // `company sid` without being a weapon: both fields carry the ledger entry
    // it grants, identically, on all 876 live examples. It is not a
    // manufacturer — the game just reuses the pair as the blueprint's subject.
    if (blueprintMeta) {
      materialSid = blueprintMeta.teaches;
      companySid = blueprintMeta.teaches;
    } else {
      materialSid = tmpl.type === 102
        ? (materialOverride || '')
        : (materialOverride || gamedata.materialCandidates(templateSid)[0] || '');
      companySid = '';
    }
  }

  // --- level / quality (2.2(b)/(e)) ---
  let levelValue;
  let qualityValue;
  if (tmpl.type === 4) {
    // 2.2(e): type 4 `level` is 0 on all 503 live records — always 0,
    // regardless of what the caller asked for. `quality` is the type-4 mode
    // (1, 404/503) — no quality control is offered for type 4 at all.
    levelValue = 0;
    qualityValue = 1;
  } else if (tmpl.type === 46 || tmpl.type === 102) {
    // All 42 live backpacks and all 39 live maps: level 0, quality 100.
    // Neither has a quality tier in the UI sense, so `level` is not taken from
    // the caller.
    levelValue = 0;
    qualityValue = 100;
  } else {
    // 2.2(b): universal 100 on all 1144 live type-2/3 records, and on all 7
    // live type-107 (crossbow) ones, whose `level` varies from 5 to 80 exactly
    // like a melee weapon's — this is NOT the user-facing "quality" tier
    // (that's `level`); do not confuse it with the template's own
    // floats.quality, which the live data disagrees with.
    levelValue = Number.isInteger(level) ? level : 0;
    qualityValue = 100;
  }

  const bools = new Map([
    ['death', false],
    ['in inventory', true],
  ]);
  const floats = new Map();
  // A robotic limb's condition floats come FIRST, before charges/quality — that
  // is the order on all 11 live ones, and key order is load-bearing.
  if (tmpl.type === 111) for (const key of LIMB_FLOATS) floats.set(key, 0);
  floats.set('charges', 1); // 2.2(b): universal on type 2/3, mode for type 4 — never the template's own floats.charges
  floats.set('quality', qualityValue);
  // 2.2(a): this exact 15-key order, verbatim — not alphabetical, not grouped.
  const ints = new Map([
    ['item function', itemFunction],
    ['inventory y', 0],
    ['insideBuildingI', 0],
    ['level', levelValue],
    ['insideBuildingCS', 0],
    ['insideBuildingC', 0],
    ['insideBuildingS', 0],
    ['insideBuildingTYPE', 11],
    ['ownedbyCS', 0],
    ['ownedbyS', 0],
    ['quantity', quantity],
    ['ownedbyI', 0],
    ['ownedbyC', 0],
    ['inventory x', 0],
    ['ownedbyTYPE', 11],
  ]);

  const strings = new Map();
  if (isEquippableTemplateType(tmpl.type)) strings.set('uniform', ''); // 2.2(a): omitted entirely for type 4
  strings.set('color sid', '');
  strings.set('material sid', materialSid);
  strings.set('company sid', companySid);
  strings.set('section', section);
  strings.set('base data sid', templateSid);

  const record = {
    instanceCount: 0,
    type: 42,
    name: '0', // 2.2(a): the literal one-character string, on all 1648 live records
    modDataType: 0,
    bools,
    floats,
    ints,
    vec3: new Map(),
    vec4: new Map(),
    strings,
    filenames: new Map(),
    extra: new Map(),
    instances: [],
  };

  return {
    record,
    meta: {
      templateName: tmpl.name,
      templateType: tmpl.type,
      blueprint: blueprintMeta,
      grade: grade ? {
        id: grade.id,
        companySid: grade.companySid,
        companyName: grade.companyName,
        modelSid: grade.modelSid,
        modelName: grade.modelName,
        rank: grade.rank,
        defaulted: !gradeId && !materialOverride,
      } : null,
    },
  };
}

module.exports = { buildItemRecord, resolveGrade, TEMPLATE_TYPES };
