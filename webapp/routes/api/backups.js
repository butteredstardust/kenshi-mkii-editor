'use strict';

const express = require('express');
const { handle } = require('../lib/handler');
const paths = require('../../services/pathService');
const backups = require('../../services/backupService');
const mutation = require('../../services/mutationService');

const router = express.Router();

// Summaries, not manifests — a hash per file per backup is megabytes of JSON
// nothing on the page renders. See backupService.summary().
router.get('/backups', handle(async () => backups.list().map(backups.summary)));

router.post('/backups', handle(async (req) => {
  const save = paths.findSave(req.body?.save) || paths.latestSave();
  if (!save) { const e = new Error('no save to back up'); e.status = 404; throw e; }
  // A backup taken while the game is running captures whatever half-written
  // state Kenshi happens to be in, and would restore to that.
  if (mutation.isLiveSaveDir(save.dir) && mutation.gameIsRunning()) {
    const e = new Error('Kenshi is running — close the game before taking a backup');
    e.status = 409;
    throw e;
  }
  return backups.summary(backups.create(save.dir, req.body?.label || 'manual'));
}));

// Gated: see mutationService.restoreBackup().
router.post('/backups/:id/restore', handle(async (req) => mutation.restoreBackup(req.params.id)));
router.delete('/backups/:id', handle(async (req) => backups.remove(req.params.id)));

module.exports = router;
