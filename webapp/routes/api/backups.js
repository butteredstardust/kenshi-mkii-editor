'use strict';

const express = require('express');
const { handle } = require('../lib/handler');
const paths = require('../../services/pathService');
const backups = require('../../services/backupService');

const router = express.Router();

router.get('/backups', handle(async () => backups.list()));

router.post('/backups', handle(async (req) => {
  const save = paths.findSave(req.body?.save) || paths.latestSave();
  if (!save) { const e = new Error('no save to back up'); e.status = 404; throw e; }
  return backups.create(save.dir, req.body?.label || 'manual');
}));

router.post('/backups/:id/restore', handle(async (req) => backups.restore(req.params.id)));
router.delete('/backups/:id', handle(async (req) => backups.remove(req.params.id)));

module.exports = router;
