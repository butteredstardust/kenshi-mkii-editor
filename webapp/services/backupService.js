'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const paths = require('./pathService');

/**
 * Versioned backups of whole save directories.
 *
 * A Kenshi save is a directory whose files reference each other by stringID
 * (`platoon` records point at ids minted from quick.save's `nextId` counter).
 * Backing up a single file would produce a save that is internally
 * inconsistent, so backups always copy the entire directory.
 */

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function walk(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else out.push(path.relative(base, full));
  }
  return out;
}

function hashDir(dir) {
  const files = walk(dir).sort();
  const hashes = {};
  for (const rel of files) hashes[rel] = sha256(fs.readFileSync(path.join(dir, rel)));
  return hashes;
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const rel of walk(src)) {
    const target = path.join(dst, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(src, rel), target);
  }
}

function backupDir(id) { return path.join(paths.backupRoot(), id); }

function create(saveDir, label = 'manual') {
  const name = path.basename(saveDir);
  const id = `${name}__${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const dst = backupDir(id);
  copyDir(saveDir, path.join(dst, 'save'));
  const manifest = {
    id,
    label,
    saveName: name,
    sourceDir: saveDir,
    createdAt: new Date().toISOString(),
    hashes: hashDir(path.join(dst, 'save')),
  };
  fs.writeFileSync(path.join(dst, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

function list() {
  const root = paths.backupRoot();
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .map((id) => {
      try { return JSON.parse(fs.readFileSync(path.join(root, id, 'manifest.json'), 'utf8')); }
      catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** A backup's manifest, or a thrown error if there is no such backup. */
function read(id) {
  return JSON.parse(fs.readFileSync(path.join(backupDir(id), 'manifest.json'), 'utf8'));
}

/**
 * Put a backup back over the directory it came from.
 *
 * This is the low-level primitive, and it is deliberately ungated: it is also
 * what `mutationService.mutate()` calls to roll back a failed edit, and a
 * rollback must never be refused — that is the moment the save is half-written
 * and needs putting right most. The game-running and concurrency gates for a
 * player-initiated restore live in `mutationService.restoreBackup()`.
 */
function restore(id) {
  const dir = backupDir(id);
  const manifest = read(id);
  const src = path.join(dir, 'save');

  // Verify the backup itself before trusting it to overwrite a live save.
  const current = hashDir(src);
  for (const [rel, hash] of Object.entries(manifest.hashes)) {
    if (current[rel] !== hash) throw new Error(`backup ${id} is corrupt: ${rel} hash mismatch`);
  }

  // Copy first, swap second. Deleting the save and then copying into the hole
  // it leaves means any failure mid-copy — a disk filling up, an antivirus
  // holding a handle, the process dying — destroys the save with nothing left
  // to fall back on. Here the only window in which the save directory does not
  // exist is between two renames within one directory, and if the second one
  // fails the original goes straight back.
  const target = manifest.sourceDir;
  const parent = path.dirname(target);
  const name = path.basename(target);
  const stamp = `${Date.now().toString(36)}-${process.pid}`;
  const incoming = path.join(parent, `.restoring-${name}-${stamp}`);
  const outgoing = path.join(parent, `.replaced-${name}-${stamp}`);

  fs.rmSync(incoming, { recursive: true, force: true });
  copyDir(src, incoming);

  const hadTarget = fs.existsSync(target);
  try {
    if (hadTarget) fs.renameSync(target, outgoing);
    try {
      fs.renameSync(incoming, target);
    } catch (err) {
      if (hadTarget) fs.renameSync(outgoing, target);
      throw err;
    }
  } catch (err) {
    fs.rmSync(incoming, { recursive: true, force: true });
    throw err;
  }
  fs.rmSync(outgoing, { recursive: true, force: true });

  return { restored: manifest.id, into: target, files: Object.keys(manifest.hashes).length };
}

function remove(id) {
  fs.rmSync(backupDir(id), { recursive: true, force: true });
  return { deleted: id };
}

module.exports = { create, list, read, restore, remove, hashDir, sha256, copyDir, walk };
