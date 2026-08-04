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

function restore(id) {
  const dir = backupDir(id);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const src = path.join(dir, 'save');

  // Verify the backup itself before trusting it to overwrite a live save.
  const current = hashDir(src);
  for (const [rel, hash] of Object.entries(manifest.hashes)) {
    if (current[rel] !== hash) throw new Error(`backup ${id} is corrupt: ${rel} hash mismatch`);
  }

  fs.rmSync(manifest.sourceDir, { recursive: true, force: true });
  copyDir(src, manifest.sourceDir);
  return { restored: manifest.id, into: manifest.sourceDir, files: Object.keys(manifest.hashes).length };
}

function remove(id) {
  fs.rmSync(backupDir(id), { recursive: true, force: true });
  return { deleted: id };
}

module.exports = { create, list, restore, remove, hashDir, sha256, copyDir, walk };
