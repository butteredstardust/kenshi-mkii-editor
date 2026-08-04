'use strict';

const gamedata = require('./gamedataService');

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

// 2.2(a): the two `strings` key orders differ only by whether `uniform` is
// present. Confirmed present for template types 2 (weapon) and 3 (armour),
// and the one observed type 107 in the live sweep — but buildItemRecord()
// only ever accepts 2/3/4 (2.2(g): a template's typecode is never 42, and 107
// was a single unexplained outlier, not a third supported kind), so in
// practice this reduces to "type 4 is the only non-equippable case".
function isEquippableTemplateType(type) {
  return type !== 4;
}

/**
 * @param {string} templateSid  a gamedata TEMPLATE sid (typecode 2/3/4)
 * @param {object} opts
 * @param {string} opts.section     required — validated by the caller via
 *   itemSlots.allowedSections(templateSid, null) (2.2(f)); not re-validated here.
 * @param {number} [opts.level]     type 2/3 only; type 4 always mints 0 and
 *   ignores this (2.2(e)).
 * @param {number} [opts.quantity=1]  written as-is; stackability is validated
 *   by the caller (2.2(d)).
 * @param {string} [opts.materialSid]  type 2: a type-50 grade sid to look up
 *   in the weapon ladder (2.2(i)); type 3/4: an explicit `material sid`
 *   override, bypassing the union-of-definitions default (2.2(h)).
 * @param {string} [opts.companySid]  type 2 only: must name the SAME ladder
 *   entry as `materialSid` if both are given (see below); ignored for type 3/4,
 *   which always mint an empty `company sid` (2.2(b)).
 */
function buildItemRecord(templateSid, opts = {}) {
  const tmpl = gamedata.lookup(templateSid);
  if (!tmpl) throw new Error(`unresolvable item template sid "${templateSid}"`);
  if (![2, 3, 4].includes(tmpl.type)) {
    throw new Error(`template "${templateSid}" (${tmpl.name}) is typecode ${tmpl.type}, not an item template (2/3/4) — see TODO.md 2.2(g)`);
  }

  const { section, level, quantity = 1, materialSid: materialOverride, companySid: companyOverride } = opts;
  if (!section) throw new Error('buildItemRecord: section is required');

  // --- item function (2.2(b)) ---
  let itemFunction;
  if (tmpl.type === 2) itemFunction = 5; // 262/262 live weapons
  else if (tmpl.type === 3) itemFunction = 6; // 882/882 live armour
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
    if (materialOverride) {
      grade = grades.find((g) => g.modelSid === materialOverride);
      if (!grade) throw new Error(`"${materialOverride}" is not a known weapon grade (type-50) sid`);
      if (companyOverride && companyOverride !== grade.companySid) {
        throw new Error(
          `companySid "${companyOverride}" does not match the ladder entry for materialSid "${materialOverride}" `
          + `(expected companySid "${grade.companySid}")`,
        );
      }
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
    // Type 3/4: `material sid` defaults to the first candidate in the union
    // of extra['material'] targets across every definition of this sid
    // (2.2(h)); `company sid` is always empty (universal on all 882+503 live
    // type-3/4 records).
    materialSid = materialOverride || gamedata.materialCandidates(templateSid)[0] || '';
    companySid = '';
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
  } else {
    // 2.2(b): universal 100 on all 1144 live type-2/3 records — this is NOT
    // the user-facing "quality" tier (that's `level`); do not confuse it with
    // the template's own floats.quality, which the live data disagrees with.
    levelValue = Number.isInteger(level) ? level : 0;
    qualityValue = 100;
  }

  const bools = new Map([
    ['death', false],
    ['in inventory', true],
  ]);
  const floats = new Map([
    ['charges', 1], // 2.2(b): universal on type 2/3, mode for type 4 — never the template's own floats.charges
    ['quality', qualityValue],
  ]);
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
      grade: grade ? {
        companySid: grade.companySid,
        companyName: grade.companyName,
        modelSid: grade.modelSid,
        modelName: grade.modelName,
        rank: grade.rank,
        defaulted: !materialOverride,
      } : null,
    },
  };
}

module.exports = { buildItemRecord };
