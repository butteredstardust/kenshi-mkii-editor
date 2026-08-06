'use strict';

const express = require('express');
const { handle } = require('../lib/handler');
const paths = require('../../services/pathService');
const saveService = require('../../services/saveService');
const mutation = require('../../services/mutationService');
const loadouts = require('../../services/loadouts');
const locations = require('../../services/locationsService');
const research = require('../../services/researchService');
const racesService = require('../../services/racesService');

const router = express.Router();

// A mutation label is not throwaway text: it is stored in the backup manifest
// and is the only description of that backup the Backups page can show. So it
// agrees in number, the same as the UI's `plural()` — "equip 1 item on 1
// character", never "1 item(s) on 1 character(s)".
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

router.get('/saves', handle(async () => paths.listSaves()));

router.get('/saves/:name/status', handle(async (req) => saveService.status(req.params.name)));

router.put('/saves/:name/money', handle(async (req) => {
  const save = paths.findSave(req.params.name);
  if (!save) { const e = new Error(`no save named "${req.params.name}"`); e.status = 404; throw e; }
  const amount = Number(req.body?.amount);
  return mutation.mutate(save.dir, `set money to ${amount}`,
    (staging) => saveService.setPlayerMoney(staging, amount));
}));

router.put('/saves/:name/platoons/:file/characters/:sid/stats', handle(async (req) => {
  const save = paths.findSave(req.params.name);
  if (!save) { const e = new Error(`no save named "${req.params.name}"`); e.status = 404; throw e; }
  const stats = req.body?.stats;
  if (!stats || typeof stats !== 'object' || Array.isArray(stats)) {
    const e = new Error('body must include a "stats" object of statKey -> value');
    e.status = 400;
    throw e;
  }
  return mutation.mutate(save.dir, `set stats on ${req.params.sid}`,
    (staging) => saveService.setStats(staging, req.params.file, req.params.sid, stats));
}));

router.post('/saves/:name/platoons/:file/characters/:sid/train', handle(async (req) => {
  const save = paths.findSave(req.params.name);
  if (!save) { const e = new Error(`no save named "${req.params.name}"`); e.status = 404; throw e; }
  const { archetype, sub, mode } = req.body || {};
  if (typeof archetype !== 'string' || !archetype) {
    const e = new Error('body must include "archetype" (string id)'); e.status = 400; throw e;
  }
  if (typeof sub !== 'string' || !sub) {
    const e = new Error('body must include "sub" (string id)'); e.status = 400; throw e;
  }
  return mutation.mutate(save.dir, `train ${req.params.sid} as ${archetype}/${sub}`,
    (staging) => saveService.trainCharacter(staging, req.params.file, req.params.sid,
      { archetype, sub, mode: mode === 'set' ? 'set' : 'raise' }));
}));

// Rename a character (TODO.md 1.3): `strings.name` on CHAR_STATE, plus the
// STATS record's header name for FCS parity. Length/encoding validation lives
// in saveService.encodeName() — the route only rejects a non-string body.
router.put('/saves/:name/platoons/:file/characters/:sid/name', handle(async (req) => {
  const save = findSaveOr404(req.params.name);
  const newName = req.body?.name;
  if (typeof newName !== 'string') {
    const e = new Error('body must include "name" (string)'); e.status = 400; throw e;
  }
  return mutation.mutate(save.dir, `rename ${req.params.sid} to ${newName}`,
    (staging) => saveService.renameCharacter(staging, req.params.file, req.params.sid, newName));
}));

// Rename the squad — i.e. the player faction, the only squad-level name a save
// actually stores. Writes quick.save only; platoon FILENAMES are deliberately
// left alone (see saveService.renamePlayerFaction).
router.put('/saves/:name/faction/name', handle(async (req) => {
  const save = findSaveOr404(req.params.name);
  const newName = req.body?.name;
  if (typeof newName !== 'string') {
    const e = new Error('body must include "name" (string)'); e.status = 400; throw e;
  }
  return mutation.mutate(save.dir, `rename player faction to ${newName}`,
    (staging) => saveService.renamePlayerFaction(staging, newName));
}));

// Races this save can actually supply a donor for, plus the one the UI should
// preselect. Read-only; scans every .platoon file (see availableRaces()).
router.get('/saves/:name/races', handle(async (req) => {
  const save = findSaveOr404(req.params.name);
  const races = saveService.availableRaces(save.dir);
  return { races, default: saveService.defaultRace(races) };
}));

// Change a character's race. One platoon-file write covering the APPEARANCE
// (66) race row and the MEDICAL (57) body plan — see saveService.setRace() for
// why those two and nothing else, and racesService.js for how a race's
// `combat anatomy` was shown to BE the body plan.
router.put('/saves/:name/platoons/:file/characters/:sid/race', handle(async (req) => {
  const save = findSaveOr404(req.params.name);
  const raceSid = req.body?.raceSid;
  if (typeof raceSid !== 'string' || !raceSid) {
    const e = new Error('body must include "raceSid" (non-empty string)'); e.status = 400; throw e;
  }
  return mutation.mutate(save.dir, `set race of ${req.params.sid} to ${racesService.nameOf(raceSid, raceSid)}`,
    (staging) => saveService.setRace(staging, req.params.file, req.params.sid, raceSid));
}));

// Add a new member to a squad (two-file write: the .platoon and quick.save).
router.post('/saves/:name/platoons/:file/characters', handle(async (req) => {
  const save = findSaveOr404(req.params.name);
  const { name, raceSid, archetype, sub, tier } = req.body || {};
  for (const [key, value] of Object.entries({ name, raceSid, archetype, sub })) {
    if (typeof value !== 'string' || !value) {
      const e = new Error(`body must include "${key}" (non-empty string)`); e.status = 400; throw e;
    }
  }
  if (tier !== undefined && (typeof tier !== 'string' || !tier)) {
    const e = new Error('"tier", if given, must be a non-empty string'); e.status = 400; throw e;
  }
  return mutation.mutate(save.dir, `add ${name} to ${req.params.file}`,
    (staging) => saveService.addSquadMember(staging, req.params.file,
      { name, raceSid, archetype, sub, ...(tier === undefined ? {} : { tier }) }));
}));

// Bulk equip: give every character in `targets` every item in `items`, in ONE
// staged edit across however many platoon files the targets span. Body shape is
// checked here; the domain rules (template resolves, typecode, stackability,
// slot compatibility) live in saveService.equipMany()/itemSlots.js.
//
// `loadoutId` is a convenience: name a catalogue entry instead of restating its
// items, and its advisory race notes come along. `items` may be given as well
// as (or instead of) a loadout — the two concatenate, so "this kit plus a
// backpack" is one request.
router.post('/saves/:name/equip', handle(async (req) => {
  const save = findSaveOr404(req.params.name);
  const { targets, items, loadoutId, skipIfSlotFilled } = req.body || {};

  requireTargets(targets);
  if (items !== undefined && !Array.isArray(items)) {
    const e = new Error('"items", if given, must be an array'); e.status = 400; throw e;
  }
  if (skipIfSlotFilled !== undefined && typeof skipIfSlotFilled !== 'boolean') {
    const e = new Error('"skipIfSlotFilled", if given, must be a boolean'); e.status = 400; throw e;
  }

  let loadout = null;
  if (loadoutId !== undefined) {
    if (typeof loadoutId !== 'string' || !loadoutId) {
      const e = new Error('"loadoutId", if given, must be a non-empty string'); e.status = 400; throw e;
    }
    loadout = loadouts.find(loadoutId);
    if (!loadout) { const e = new Error(`unknown loadout "${loadoutId}"`); e.status = 400; throw e; }
  }

  const allItems = [...(loadout ? loadout.items : []), ...(items || [])];
  if (!allItems.length) {
    const e = new Error('nothing to equip — provide "loadoutId" and/or a non-empty "items" array');
    e.status = 400;
    throw e;
  }

  const label = loadout
    ? `equip ${loadout.label} on ${plural(targets.length, 'character')}`
    : `equip ${plural(allItems.length, 'item')} on ${plural(targets.length, 'character')}`;

  return mutation.mutate(save.dir, label, (staging) => saveService.equipMany(staging, {
    targets,
    items: allItems,
    raceNotes: loadout ? loadout.raceNotes || [] : [],
    skipIfSlotFilled: !!skipIfSlotFilled,
  }));
}));

// Bulk re-grade: set the quality of gear the selected characters ALREADY own —
// "every piece of armour to Masterwork, every weapon to Edge Type 5" — in ONE
// staged edit. Nothing is added or moved; see saveService.regradeMany() for
// which typecode each control applies to and why armour's tier and a weapon's
// grade are different fields.
router.post('/saves/:name/regrade', handle(async (req) => {
  const save = findSaveOr404(req.params.name);
  const {
    targets, armourLevel, weaponGradeId, weaponLevel, includeCarried, includePackContents,
  } = req.body || {};

  requireTargets(targets);
  for (const [key, value] of Object.entries({ armourLevel, weaponLevel })) {
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
      const e = new Error(`"${key}", if given, must be a number`); e.status = 400; throw e;
    }
  }
  if (weaponGradeId !== undefined && (typeof weaponGradeId !== 'string' || !weaponGradeId)) {
    const e = new Error('"weaponGradeId", if given, must be a non-empty string'); e.status = 400; throw e;
  }
  for (const [key, value] of Object.entries({ includeCarried, includePackContents })) {
    if (value !== undefined && typeof value !== 'boolean') {
      const e = new Error(`"${key}", if given, must be a boolean`); e.status = 400; throw e;
    }
  }
  if (armourLevel === undefined && weaponGradeId === undefined && weaponLevel === undefined) {
    const e = new Error('body must include at least one of armourLevel, weaponGradeId, weaponLevel');
    e.status = 400;
    throw e;
  }

  // Only forward what was actually supplied — regradeMany() distinguishes
  // "leave this kind alone" from "set it", and an explicit `undefined` would
  // still be an own key on the object it validates.
  const patch = { targets };
  if (armourLevel !== undefined) patch.armourLevel = armourLevel;
  if (weaponGradeId !== undefined) patch.weaponGradeId = weaponGradeId;
  if (weaponLevel !== undefined) patch.weaponLevel = weaponLevel;
  if (includeCarried !== undefined) patch.includeCarried = includeCarried;
  if (includePackContents !== undefined) patch.includePackContents = includePackContents;

  return mutation.mutate(save.dir, `re-grade gear on ${plural(targets.length, 'character')}`,
    (staging) => saveService.regradeMany(staging, patch));
}));

// Bulk unequip: move worn items back to Carried. With no filter it strips every
// worn item; `sections` limits it to slots ("take everyone's helmet off"),
// `templateSids` to a particular item, `itemSids` to exact item records.
router.post('/saves/:name/unequip', handle(async (req) => {
  const save = findSaveOr404(req.params.name);
  const { targets, sections, templateSids, itemSids } = req.body || {};

  requireTargets(targets);
  for (const [key, value] of Object.entries({ sections, templateSids, itemSids })) {
    if (value === undefined) continue;
    if (!Array.isArray(value) || !value.length || value.some((s) => typeof s !== 'string' || !s)) {
      const e = new Error(`"${key}", if given, must be a non-empty array of strings`); e.status = 400; throw e;
    }
  }

  const patch = { targets };
  if (sections !== undefined) patch.sections = sections;
  if (templateSids !== undefined) patch.templateSids = templateSids;
  if (itemSids !== undefined) patch.itemSids = itemSids;

  const label = sections && sections.length === 1
    ? `unequip ${sections[0]} on ${plural(targets.length, 'character')}`
    : `unequip on ${plural(targets.length, 'character')}`;
  return mutation.mutate(save.dir, label, (staging) => saveService.unequipMany(staging, patch));
}));

// What this save has researched, joined onto the tech tree.
router.get('/saves/:name/research', handle(async (req) => {
  const save = findSaveOr404(req.params.name);
  return research.statusFor(save.dir);
}));

// Mark research finished. `levels` sets a per-tech target level for repeating
// techs (default: the tech's maximum); `withRequirements` (default true) also
// finishes anything a requested tech depends on, so the tree is never left
// claiming a tech is done while its prerequisite is not.
router.post('/saves/:name/research/unlock', handle(async (req) => {
  const save = findSaveOr404(req.params.name);
  const { sids, levels, withRequirements } = req.body || {};

  if (!Array.isArray(sids) || !sids.length) {
    const e = new Error('body must include a non-empty "sids" array of research tech ids'); e.status = 400; throw e;
  }
  if (sids.some((s) => typeof s !== 'string' || !s)) {
    const e = new Error('every entry in "sids" must be a non-empty string'); e.status = 400; throw e;
  }
  if (levels !== undefined && (typeof levels !== 'object' || levels === null || Array.isArray(levels))) {
    const e = new Error('"levels", if given, must be an object of techSid -> level'); e.status = 400; throw e;
  }
  if (withRequirements !== undefined && typeof withRequirements !== 'boolean') {
    const e = new Error('"withRequirements", if given, must be a boolean'); e.status = 400; throw e;
  }

  const label = sids.length === 1
    ? `unlock research ${(research.techBySid(sids[0]) || {}).name || sids[0]}`
    : `unlock ${sids.length} research techs`;

  return mutation.mutate(save.dir, label, (staging) => research.unlock(staging, {
    sids,
    levels: levels || {},
    withRequirements: withRequirements !== false,
  }));
}));

// Teleport a squad (TODO.md 1.4). Either name a catalogued town via
// `locationId`, or give raw `{ x, y, z }` — the town is the safe path and what
// the UI offers; raw coordinates are accepted for anyone who knows where they
// want to land.
router.post('/saves/:name/platoons/:file/teleport', handle(async (req) => {
  const save = findSaveOr404(req.params.name);
  const { locationId, x, y, z, sids } = req.body || {};

  let dest = null;
  if (locationId !== undefined) {
    if (typeof locationId !== 'string' || !locationId) {
      const e = new Error('"locationId", if given, must be a non-empty string'); e.status = 400; throw e;
    }
    const loc = locations.find(locationId);
    if (!loc) { const e = new Error(`unknown location "${locationId}"`); e.status = 400; throw e; }
    dest = { x: loc.x, y: loc.y, z: loc.z, label: loc.label };
  } else {
    for (const [key, value] of Object.entries({ x, y, z })) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        const e = new Error(`"${key}" must be a number when no locationId is given`); e.status = 400; throw e;
      }
    }
    dest = { x, y, z, label: null };
  }

  if (sids !== undefined && (!Array.isArray(sids) || sids.some((s) => typeof s !== 'string' || !s))) {
    const e = new Error('"sids", if given, must be an array of non-empty strings'); e.status = 400; throw e;
  }

  return mutation.mutate(save.dir, `teleport ${req.params.file} to ${dest.label || `${Math.round(dest.x)}, ${Math.round(dest.z)}`}`,
    (staging) => saveService.teleportSquad(staging, req.params.file,
      { ...dest, ...(sids === undefined ? {} : { sids }) }));
}));

// Personality (TODO.md 1.3): one int on CHAR_STATE. The seven working values
// are decoded in services/personalities.js from gamedata's type-26 records;
// `allowUnknown` lets a caller past that check deliberately.
router.put('/saves/:name/platoons/:file/characters/:sid/personality', handle(async (req) => {
  const save = findSaveOr404(req.params.name);
  const { personality, allowUnknown } = req.body || {};
  if (typeof personality !== 'number' || !Number.isInteger(personality)) {
    const e = new Error('body must include "personality" (integer)'); e.status = 400; throw e;
  }
  return mutation.mutate(save.dir, `set personality on ${req.params.sid}`,
    (staging) => saveService.setPersonality(staging, req.params.file, req.params.sid, personality,
      { allowUnknown: !!allowUnknown }));
}));

// Bounties (TODO.md 3.6): amount<n> only. Reduces or clears an existing
// bounty; there is deliberately no "add a bounty" route — see
// saveService.setBountyAmount()'s comment for why (the key is absent
// entirely on an unbountied character, and this editor never mints one).
router.put('/saves/:name/platoons/:file/characters/:sid/bounties/:n', handle(async (req) => {
  const save = findSaveOr404(req.params.name);
  const amount = Number(req.body?.amount);
  return mutation.mutate(save.dir, `set bounty ${req.params.n} on ${req.params.sid} to ${amount}`,
    (staging) => saveService.setBountyAmount(staging, req.params.file, req.params.sid, req.params.n, amount));
}));

// Reduce every bounty on a character to the same small positive value (default
// 1) in ONE staged edit — the guide's documented safe removal method.
router.post('/saves/:name/platoons/:file/characters/:sid/bounties/clear', handle(async (req) => {
  const save = findSaveOr404(req.params.name);
  const { amount } = req.body || {};
  if (amount !== undefined && (typeof amount !== 'number' || !Number.isFinite(amount))) {
    const e = new Error('"amount", if given, must be a number'); e.status = 400; throw e;
  }
  return mutation.mutate(save.dir, `reduce all bounties on ${req.params.sid}`,
    (staging) => saveService.clearBounties(staging, req.params.file, req.params.sid,
      amount === undefined ? {} : { amount }));
}));

function findSaveOr404(name) {
  const save = paths.findSave(name);
  if (!save) { const e = new Error(`no save named "${name}"`); e.status = 404; throw e; }
  return save;
}

/**
 * The `targets` array every bulk character route takes: `{ file, sid }[]`,
 * non-empty. Shape only — that a sid names a real character in that file is
 * saveService's answer, not a route's.
 */
function requireTargets(targets) {
  if (!Array.isArray(targets) || !targets.length) {
    const e = new Error('body must include a non-empty "targets" array of { file, sid }'); e.status = 400; throw e;
  }
  for (const t of targets) {
    if (!t || typeof t.file !== 'string' || !t.file || typeof t.sid !== 'string' || !t.sid) {
      const e = new Error('every target must be { file: string, sid: string }'); e.status = 400; throw e;
    }
  }
}

router.put('/saves/:name/platoons/:file/characters/:sid/medical/parts/:n', handle(async (req) => {
  const save = findSaveOr404(req.params.name);
  const { flesh, bandage, stun } = req.body || {};
  return mutation.mutate(save.dir, `heal part ${req.params.n} on ${req.params.sid}`,
    (staging) => saveService.healPart(staging, req.params.file, req.params.sid, req.params.n, { flesh, bandage, stun }));
}));

// Limb loss (Phase 1.2, lowest priority): same shape as heal, no lower clamp.
// The UI must gate this behind an explicit confirmation before calling it.
router.put('/saves/:name/platoons/:file/characters/:sid/medical/parts/:n/damage', handle(async (req) => {
  const save = findSaveOr404(req.params.name);
  const { flesh, bandage, stun } = req.body || {};
  return mutation.mutate(save.dir, `damage part ${req.params.n} on ${req.params.sid}`,
    (staging) => saveService.damagePart(staging, req.params.file, req.params.sid, req.params.n, { flesh, bandage, stun }));
}));

router.put('/saves/:name/platoons/:file/characters/:sid/medical/hunger', handle(async (req) => {
  const save = findSaveOr404(req.params.name);
  const { hung, fed } = req.body || {};
  return mutation.mutate(save.dir, `set hunger on ${req.params.sid}`,
    (staging) => saveService.setHunger(staging, req.params.file, req.params.sid, { hung, fed }));
}));

router.post('/saves/:name/platoons/:file/characters/:sid/revive', handle(async (req) => {
  const save = findSaveOr404(req.params.name);
  const minFleshPercent = req.body?.minFleshPercent;
  return mutation.mutate(save.dir, `revive ${req.params.sid}`,
    (staging) => saveService.revive(staging, req.params.file, req.params.sid,
      minFleshPercent === undefined ? {} : { minFleshPercent }));
}));

router.post('/saves/:name/platoons/:file/characters/:sid/medical/restore-limbs', handle(async (req) => {
  const save = findSaveOr404(req.params.name);
  return mutation.mutate(save.dir, `restore limbs on ${req.params.sid}`,
    (staging) => saveService.restoreLimbs(staging, req.params.file, req.params.sid));
}));

// Gear (TODO.md 2.1): change an item's equip slot. The collision rule (moving
// into an occupied slot flips the prior occupant back to "main") is handled
// entirely inside setItemSection() as one staged edit.
router.put('/saves/:name/platoons/:file/characters/:sid/inventory/:itemSid/section', handle(async (req) => {
  const save = findSaveOr404(req.params.name);
  const { section } = req.body || {};
  return mutation.mutate(save.dir, `move item ${req.params.itemSid} to ${section}`,
    (staging) => saveService.setItemSection(staging, req.params.file, req.params.sid, req.params.itemSid, section));
}));

// Gear (TODO.md 3.4): ints.level and/or floats.quality, independently settable.
router.put('/saves/:name/platoons/:file/characters/:sid/inventory/:itemSid/quality', handle(async (req) => {
  const save = findSaveOr404(req.params.name);
  const { level, quality } = req.body || {};
  return mutation.mutate(save.dir, `set item ${req.params.itemSid} quality`,
    (staging) => saveService.setItemQuality(staging, req.params.file, req.params.sid, req.params.itemSid, { level, quality }));
}));

// Gear (TODO.md 3.1): colour scheme. Empty string clears it — the key always
// exists on a type-42 record, so this never mints.
router.put('/saves/:name/platoons/:file/characters/:sid/inventory/:itemSid/color', handle(async (req) => {
  const save = findSaveOr404(req.params.name);
  const { colorSid } = req.body || {};
  if (typeof colorSid !== 'string') { const e = new Error('body must include "colorSid" (string, "" to clear)'); e.status = 400; throw e; }
  return mutation.mutate(save.dir, `set item ${req.params.itemSid} colour`,
    (staging) => saveService.setItemColor(staging, req.params.file, req.params.sid, req.params.itemSid, colorSid));
}));

// Gear (TODO.md 3.2): uniform faction tag. Refused on an item whose template
// shape carries no `uniform` key at all — see saveService.updateItem().
router.put('/saves/:name/platoons/:file/characters/:sid/inventory/:itemSid/uniform', handle(async (req) => {
  const save = findSaveOr404(req.params.name);
  const { uniformSid } = req.body || {};
  if (typeof uniformSid !== 'string') { const e = new Error('body must include "uniformSid" (string, "" to clear)'); e.status = 400; throw e; }
  return mutation.mutate(save.dir, `set item ${req.params.itemSid} uniform`,
    (staging) => saveService.setUniform(staging, req.params.file, req.params.sid, req.params.itemSid, uniformSid));
}));

// Gear (TODO.md 3.3): clear stolen flags.
router.post('/saves/:name/platoons/:file/characters/:sid/inventory/:itemSid/clear-stolen', handle(async (req) => {
  const save = findSaveOr404(req.params.name);
  return mutation.mutate(save.dir, `clear stolen flags on item ${req.params.itemSid}`,
    (staging) => saveService.clearStolen(staging, req.params.file, req.params.sid, req.params.itemSid));
}));

// Unified per-item edit: slot, level, quality and/or quantity in ONE staged
// edit (one mutation-gate pass, one backup). This is what the Gear row's
// single "Apply" button calls; the narrower /section and /quality routes above
// remain as thin wrappers over the same primitive.
router.put('/saves/:name/platoons/:file/characters/:sid/inventory/:itemSid', handle(async (req) => {
  const save = findSaveOr404(req.params.name);
  const {
    section, level, quality, quantity, materialSid, gradeId, colorSid, uniformSid, clearStolen,
  } = req.body || {};
  for (const [key, value] of Object.entries({ section, materialSid, gradeId })) {
    if (value !== undefined && (typeof value !== 'string' || !value)) {
      const e = new Error(`"${key}", if given, must be a non-empty string`); e.status = 400; throw e;
    }
  }
  // colorSid/uniformSid are string but MAY legitimately be empty — that is
  // how each is cleared (TODO.md 3.1/3.2), unlike section/materialSid/gradeId
  // above, so they get their own, less strict, check.
  for (const [key, value] of Object.entries({ colorSid, uniformSid })) {
    if (value !== undefined && typeof value !== 'string') {
      const e = new Error(`"${key}", if given, must be a string ("" to clear)`); e.status = 400; throw e;
    }
  }
  for (const [key, value] of Object.entries({ level, quality, quantity })) {
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
      const e = new Error(`"${key}", if given, must be a number`); e.status = 400; throw e;
    }
  }
  if (clearStolen !== undefined && clearStolen !== true) {
    const e = new Error('"clearStolen", if given, must be true'); e.status = 400; throw e;
  }
  if (section === undefined && level === undefined && quality === undefined
    && quantity === undefined && materialSid === undefined && gradeId === undefined
    && colorSid === undefined && uniformSid === undefined && clearStolen === undefined) {
    const e = new Error('body must include at least one of section, level, quality, quantity, materialSid, '
      + 'gradeId, colorSid, uniformSid, clearStolen');
    e.status = 400;
    throw e;
  }
  // Only forward the keys actually supplied — updateItem() distinguishes
  // "leave untouched" from "set", and an explicit `undefined` would still be
  // an own key on the object it validates.
  const patch = {};
  if (section !== undefined) patch.section = section;
  if (level !== undefined) patch.level = level;
  if (quality !== undefined) patch.quality = quality;
  if (quantity !== undefined) patch.quantity = quantity;
  if (materialSid !== undefined) patch.materialSid = materialSid;
  if (gradeId !== undefined) patch.gradeId = gradeId;
  if (colorSid !== undefined) patch.colorSid = colorSid;
  if (uniformSid !== undefined) patch.uniformSid = uniformSid;
  if (clearStolen !== undefined) patch.clearStolen = clearStolen;
  return mutation.mutate(save.dir, `update item ${req.params.itemSid}`,
    (staging) => saveService.updateItem(staging, req.params.file, req.params.sid, req.params.itemSid, patch));
}));

// Add a new item to a character's inventory (TODO.md 2.2). Body shape
// validated here (400 on garbage), same as every other route; the deeper
// domain validation (template resolves, typecode 2/3/4, stackability,
// section compatibility) lives in saveService.addItem() itself.
router.post('/saves/:name/platoons/:file/characters/:sid/inventory', handle(async (req) => {
  const save = findSaveOr404(req.params.name);
  const { templateSid, section, quantity, level, materialSid, companySid, gradeId, teaches } = req.body || {};
  if (gradeId !== undefined && (typeof gradeId !== 'string' || !gradeId)) {
    const e = new Error('"gradeId", if given, must be a non-empty string'); e.status = 400; throw e;
  }
  // Blueprints: the research-ledger entry the blueprint grants. Shape is
  // validated in services/blueprints.js; the route only rejects non-strings.
  if (teaches !== undefined && (typeof teaches !== 'string' || !teaches)) {
    const e = new Error('"teaches", if given, must be a non-empty string'); e.status = 400; throw e;
  }
  if (typeof templateSid !== 'string' || !templateSid) {
    const e = new Error('body must include "templateSid" (string, a gamedata item template sid)'); e.status = 400; throw e;
  }
  if (typeof section !== 'string' || !section) {
    const e = new Error('body must include "section" (string)'); e.status = 400; throw e;
  }
  if (quantity !== undefined && (typeof quantity !== 'number' || !Number.isFinite(quantity))) {
    const e = new Error('"quantity", if given, must be a number'); e.status = 400; throw e;
  }
  if (level !== undefined && (typeof level !== 'number' || !Number.isFinite(level))) {
    const e = new Error('"level", if given, must be a number'); e.status = 400; throw e;
  }
  if (materialSid !== undefined && typeof materialSid !== 'string') {
    const e = new Error('"materialSid", if given, must be a string'); e.status = 400; throw e;
  }
  if (companySid !== undefined && typeof companySid !== 'string') {
    const e = new Error('"companySid", if given, must be a string'); e.status = 400; throw e;
  }
  return mutation.mutate(save.dir, `add item ${templateSid} to ${req.params.sid}`,
    (staging) => saveService.addItem(staging, req.params.file, req.params.sid, templateSid,
      { quantity, section, level, materialSid, companySid, gradeId, ...(teaches === undefined ? {} : { teaches }) }));
}));

module.exports = router;
