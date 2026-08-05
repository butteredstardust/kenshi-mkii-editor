'use strict';

const express = require('express');
const { handle } = require('../lib/handler');
const paths = require('../../services/pathService');
const factions = require('../../services/factionsService');
const mutation = require('../../services/mutationService');

const router = express.Router();

function findSaveOr404(name) {
  const save = paths.findSave(name);
  if (!save) { const e = new Error(`no save named "${name}"`); e.status = 404; throw e; }
  return save;
}

// The type-10 faction catalogue from gamedata, load-order resolved. Save
// independent — it is what a relation's two ends MEAN, not what they are set to.
router.get('/factions', handle(async () => ({
  factions: factions.catalogue(),
  stats: factions.stats(),
})));

router.post('/factions/rebuild', handle(async () => {
  factions.rebuild();
  return { rebuilt: true, stats: factions.stats() };
}));

// How every faction feels about the player, in THIS save. Directional: the
// value lives on the other faction's record, which is the direction the game
// acts on — see services/factionsService.js.
router.get('/saves/:name/factions', handle(async (req) => {
  const save = findSaveOr404(req.params.name);
  return factions.relationsFor(save.dir);
}));

// One faction's full outgoing relation list — how IT sees everyone else.
router.get('/saves/:name/factions/:sid/relations', handle(async (req) => {
  const save = findSaveOr404(req.params.name);
  return factions.relationsOf(save.dir, req.params.sid);
}));

// Set relations. `{ changes: [{ from, to, relation }] }`, both ends named by
// gamedata stringID, however many in ONE staged edit — they all live in the
// same quick.save, so N requests would mean N backups and N intermediate
// on-disk states for edits that land in one file.
//
// Body shape is checked here; the domain rules (the row must already exist, the
// range, no duplicate pair) live in factionsService.setRelations().
router.put('/saves/:name/factions/relations', handle(async (req) => {
  const save = findSaveOr404(req.params.name);
  const { changes } = req.body || {};
  if (!Array.isArray(changes) || !changes.length) {
    const e = new Error('body must include a non-empty "changes" array of { from, to, relation }');
    e.status = 400;
    throw e;
  }
  for (const c of changes) {
    if (!c || typeof c.from !== 'string' || !c.from || typeof c.to !== 'string' || !c.to
      || typeof c.relation !== 'number' || !Number.isFinite(c.relation)) {
      const e = new Error('every change must be { from: string, to: string, relation: number }');
      e.status = 400;
      throw e;
    }
  }
  const label = changes.length === 1
    ? `set relation ${(factions.templateOf(changes[0].from) || {}).name || changes[0].from} → ${changes[0].relation}`
    : `set ${changes.length} faction relations`;
  return mutation.mutate(save.dir, label, (staging) => factions.setRelations(staging, changes));
}));

module.exports = router;
