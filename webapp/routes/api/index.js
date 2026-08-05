'use strict';

const express = require('express');

const router = express.Router();

router.use(require('./status'));
router.use(require('./saves'));
router.use(require('./factions'));
router.use(require('./backups'));

router.use((req, res) => res.status(404).json({ error: `unknown endpoint ${req.method} /api${req.path}` }));

module.exports = router;
