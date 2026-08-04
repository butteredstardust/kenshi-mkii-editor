'use strict';

const express = require('express');
const { handle } = require('../lib/handler');
const paths = require('../../services/pathService');
const saveService = require('../../services/saveService');
const mutation = require('../../services/mutationService');

const router = express.Router();

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

function findSaveOr404(name) {
  const save = paths.findSave(name);
  if (!save) { const e = new Error(`no save named "${name}"`); e.status = 404; throw e; }
  return save;
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

// Unified per-item edit: slot, level, quality and/or quantity in ONE staged
// edit (one mutation-gate pass, one backup). This is what the Gear row's
// single "Apply" button calls; the narrower /section and /quality routes above
// remain as thin wrappers over the same primitive.
router.put('/saves/:name/platoons/:file/characters/:sid/inventory/:itemSid', handle(async (req) => {
  const save = findSaveOr404(req.params.name);
  const { section, level, quality, quantity, materialSid } = req.body || {};
  for (const [key, value] of Object.entries({ section, materialSid })) {
    if (value !== undefined && (typeof value !== 'string' || !value)) {
      const e = new Error(`"${key}", if given, must be a non-empty string`); e.status = 400; throw e;
    }
  }
  for (const [key, value] of Object.entries({ level, quality, quantity })) {
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
      const e = new Error(`"${key}", if given, must be a number`); e.status = 400; throw e;
    }
  }
  if (section === undefined && level === undefined && quality === undefined
    && quantity === undefined && materialSid === undefined) {
    const e = new Error('body must include at least one of section, level, quality, quantity, materialSid');
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
  return mutation.mutate(save.dir, `update item ${req.params.itemSid}`,
    (staging) => saveService.updateItem(staging, req.params.file, req.params.sid, req.params.itemSid, patch));
}));

// Add a new item to a character's inventory (TODO.md 2.2). Body shape
// validated here (400 on garbage), same as every other route; the deeper
// domain validation (template resolves, typecode 2/3/4, stackability,
// section compatibility) lives in saveService.addItem() itself.
router.post('/saves/:name/platoons/:file/characters/:sid/inventory', handle(async (req) => {
  const save = findSaveOr404(req.params.name);
  const { templateSid, section, quantity, level, materialSid, companySid } = req.body || {};
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
      { quantity, section, level, materialSid, companySid }));
}));

module.exports = router;
