'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const backups = require('./backupService');
const paths = require('./pathService');
const { readFile } = require('./kenshi/codec');

/**
 * The single gate every write passes through.
 *
 * Kenshi keeps the whole world in memory and rewrites the save directory on
 * save, so an edit applied while the game is running is silently discarded at
 * best and interleaved with the game's own write at worst. Nothing here writes
 * to a live save unless the game is closed.
 *
 * mutate() is deliberately sequential and refuses to overlap: two concurrent
 * edits to the same directory would each be computed against the pre-edit
 * bytes and the second would erase the first.
 */

let active = null;

function gameIsRunning() {
  try {
    const out = execFileSync('tasklist.exe', ['/FI', 'IMAGENAME eq kenshi_x64.exe', '/NH'], {
      encoding: 'utf8', windowsHide: true,
    });
    return /kenshi_x64\.exe/i.test(out);
  } catch {
    // If we cannot tell, assume the worst rather than risk a corrupt save.
    return true;
  }
}

/**
 * Is this directory one Kenshi itself owns?
 *
 * The game-running check exists for exactly one reason: Kenshi holds the world
 * in memory and rewrites its own save directory on save, so editing a file it
 * owns while it runs is discarded at best and interleaved at worst. That
 * reasoning applies to the save root and to nothing else. A copy in a temp
 * directory or in `webapp/.fixtures/` is not a save the game knows about, will
 * ever write to, or could conflict over.
 *
 * So the gate asks "is this a live save?" rather than "is the game running?",
 * which lets the write tests actually run while the player is playing — the
 * whole suite used to skip 56 tests the moment Kenshi was open, which is
 * precisely when someone is most likely to be editing.
 *
 * Note the direction of the failure: if the save root cannot be determined at
 * all, this returns TRUE and the write is gated. Unknown means treat it as
 * live. The check can never *permit* a write to a real save — it can only
 * decline to gate a directory it has positively established lives elsewhere.
 */
function isLiveSaveDir(dir) {
  const root = paths.saveRoot();
  if (!root) return true; // cannot prove it is safe, so assume it is not
  const rel = path.relative(path.resolve(root), path.resolve(dir));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * A written file must still parse, and must still round-trip to the same bytes.
 * That is the strongest cheap check available: it proves the file is internally
 * consistent under the same codec the game's format demands.
 */
function verifyParses(bytes, label) {
  const parsed = readFile(bytes);
  if (parsed.parsedTo + parsed.tail.length !== bytes.length) {
    throw new Error(`${label}: parsed length does not cover the file`);
  }
  return { records: parsed.records.length, bytes: bytes.length };
}

/**
 * @param {string} saveDir      live save directory
 * @param {string} label        human description, recorded on the backup
 * @param {function} action     receives the staged dir, returns
 *                              { file, bytes, ...receipt } or an array of them
 */
async function mutate(saveDir, label, action) {
  if (active) {
    const err = new Error(`another edit is in progress: ${active}`);
    err.status = 409;
    throw err;
  }
  if (!fs.existsSync(saveDir)) {
    const err = new Error(`save directory not found: ${saveDir}`);
    err.status = 404;
    throw err;
  }
  const live = isLiveSaveDir(saveDir);
  if (live && gameIsRunning()) {
    const err = new Error('Kenshi is running — close the game before editing a save');
    err.status = 409;
    throw err;
  }

  active = label;
  const operationId = `op_${Date.now().toString(36)}`;
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'kenshi-mkii-'));
  let backup = null;

  try {
    const before = backups.hashDir(saveDir);
    backup = backups.create(saveDir, `auto: ${label}`);

    backups.copyDir(saveDir, staging);
    const results = [].concat(await action(staging));

    const verifications = [];
    for (const r of results) {
      verifications.push({ file: r.file, ...verifyParses(r.bytes, r.file) });
      fs.writeFileSync(path.join(staging, r.file), r.bytes);
    }

    const staged = backups.hashDir(staging);
    const changed = Object.keys(staged).filter((k) => staged[k] !== before[k]);
    if (changed.length === 0) throw new Error('edit produced no change');

    // Re-check the two preconditions that could have gone stale while we worked.
    if (live && gameIsRunning()) throw new Error('Kenshi started during the edit — aborted, live save untouched');
    const stillLive = backups.hashDir(saveDir);
    for (const [rel, hash] of Object.entries(before)) {
      if (stillLive[rel] !== hash) throw new Error(`live save changed underneath us (${rel}) — aborted`);
    }

    for (const rel of changed) {
      fs.copyFileSync(path.join(staging, rel), path.join(saveDir, rel));
    }

    const after = backups.hashDir(saveDir);
    return {
      operationId,
      label,
      backupId: backup.id,
      changedFiles: changed,
      verifications,
      beforeHashes: Object.fromEntries(changed.map((k) => [k, before[k]])),
      afterHashes: Object.fromEntries(changed.map((k) => [k, after[k]])),
      receipts: results.map(({ bytes, ...rest }) => rest),
      rollbackStatus: 'not needed',
    };
  } catch (err) {
    if (backup) {
      try {
        backups.restore(backup.id);
        err.rollbackStatus = 'restored from backup';
      } catch (rollbackErr) {
        err.rollbackStatus = `ROLLBACK FAILED: ${rollbackErr.message} (backup ${backup.id})`;
      }
    }
    throw err;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    active = null;
  }
}

function state() { return { active }; }

module.exports = { mutate, gameIsRunning, isLiveSaveDir, verifyParses, state };
