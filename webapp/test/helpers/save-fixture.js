'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const paths = require('../../services/pathService');
const backups = require('../../services/backupService');

/**
 * The save the test suite is allowed to touch.
 *
 * ===========================================================================
 * THE RULE
 * ===========================================================================
 * **No test reads or writes the player's live save.** Everything that needs a
 * save's contents goes through here, which serves a snapshot in
 * `webapp/.fixtures/` (gitignored — a save directory is 39 MB of the player's
 * game, and `.gitignore` already refuses `*.save`/`*.platoon`/`*.zone` besides).
 *
 * Create or refresh it with:
 *
 *     npm run fixture:create            # newest save
 *     npm run fixture:create autosave1  # a named one
 *
 * Without a fixture, every test that needs save CONTENTS skips with that
 * instruction rather than quietly falling back to the live save — a silent
 * fallback would put the thing this is meant to protect back in the firing line
 * the first time someone forgot to run the script.
 *
 * The one deliberate exception is `codec.test.js`, which round-trips every live
 * save READ-ONLY. That test is the format-drift canary: it is how a signalling
 * NaN the game had newly started writing was caught within minutes of the
 * player's autosave picking it up. Reading a save cannot bother it; depending
 * on its contents can, and that is what this helper ends.
 *
 * ===========================================================================
 * WHY A FIXTURE AND NOT JUST A TEMP COPY
 * ===========================================================================
 * The suite already copied the live save to a temp directory before writing to
 * it, so the live save was never the write target. What it did do was *depend*
 * on the live save's contents, and that broke things for real: two tests failed
 * mid-session purely because the player had wounded one character and trained
 * another, and preconditions like "need a player squad of at least 2" are the
 * player's to invalidate at any moment. Worse, which save `latestSave()` means
 * changes as autosave0/1/2 roll over, so two runs could be talking about two
 * different worlds.
 */

const FIXTURE_ROOT = path.join(__dirname, '..', '..', '.fixtures');

function fixtureRoot() { return FIXTURE_ROOT; }

/** Metadata written by scripts/make-fixture.js, or null if there is no fixture. */
function fixtureInfo() {
  try {
    return JSON.parse(fs.readFileSync(path.join(FIXTURE_ROOT, 'FIXTURE.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The fixture save directory: `{ name, dir }`, or null if none has been made.
 * Read-only — tests copy it before writing (see scratchSave).
 */
function fixtureSave() {
  const info = fixtureInfo();
  if (!info) return null;
  const dir = path.join(FIXTURE_ROOT, info.save);
  if (!fs.existsSync(path.join(dir, 'quick.save'))) return null;
  return { name: info.save, dir, savedAt: info.savedAt, snapshotAt: info.snapshotAt };
}

/** The message every skip uses, so the fix is always one copy-paste away. */
const NO_FIXTURE = 'no test fixture — run `npm run fixture:create` (the suite never uses your live save)';

/**
 * A throwaway copy of the fixture, safe to write to.
 *
 * Also points `backupRoot` inside the same temp directory, so the automatic
 * backup every mutation takes lands there too and the player's real backup
 * folder is never touched.
 */
function scratchSave() {
  const src = fixtureSave();
  if (!src) return null;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kenshi-mkii-test-'));
  const dir = path.join(root, src.name);
  backups.copyDir(src.dir, dir);
  paths.setOverrides({ backupRoot: path.join(root, 'backups') });
  return { root, dir, name: src.name };
}

module.exports = { fixtureRoot, fixtureInfo, fixtureSave, scratchSave, NO_FIXTURE };
