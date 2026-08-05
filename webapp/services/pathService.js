'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/**
 * Locates Kenshi's save directory and install directory.
 *
 * Saves do NOT live in the game folder on a modern install. Kenshi writes to
 * %LOCALAPPDATA%\kenshi\save\<name>\ ; the `save\` folder inside the game
 * directory is a legacy location that a current install leaves as empty
 * directory skeletons. Check appdata first, then fall back.
 */

const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');

const SAVE_ROOTS = [
  path.join(LOCAL, 'kenshi', 'save'),
];

const INSTALL_CANDIDATES = [
  'D:\\SteamLibrary\\steamapps\\common\\Kenshi',
  'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Kenshi',
  'C:\\Program Files\\Steam\\steamapps\\common\\Kenshi',
  path.join(os.homedir(), 'GOG Games', 'Kenshi'),
];

let overrides = {};
function setOverrides(next) { overrides = { ...next }; }

function saveRoot() {
  if (overrides.saveRoot && fs.existsSync(overrides.saveRoot)) return overrides.saveRoot;
  for (const root of SAVE_ROOTS) {
    if (fs.existsSync(root)) return root;
  }
  return null;
}

function installDir() {
  if (overrides.installDir && fs.existsSync(overrides.installDir)) return overrides.installDir;
  for (const dir of INSTALL_CANDIDATES) {
    if (fs.existsSync(path.join(dir, 'kenshi_x64.exe')) || fs.existsSync(path.join(dir, 'data', 'gamedata.base'))) {
      return dir;
    }
  }
  return null;
}

function gameDataDir() {
  const dir = installDir();
  return dir ? path.join(dir, 'data') : null;
}

function workshopDir() {
  const dir = installDir();
  if (!dir) return null;
  // ...\steamapps\common\Kenshi -> ...\steamapps\workshop\content\233860
  const steamapps = path.resolve(dir, '..', '..');
  const ws = path.join(steamapps, 'workshop', 'content', '233860');
  return fs.existsSync(ws) ? ws : null;
}

/** Every save directory, newest first, judged by the mtime of quick.save. */
function listSaves() {
  const root = saveRoot();
  if (!root) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    // Kenshi never makes a dot-prefixed save directory. backupService's restore
    // stages one beside the save for the moment it takes to swap them, and an
    // orphan left by a crash must not then show up as a save the player can
    // edit.
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => {
      const dir = path.join(root, e.name);
      const quick = path.join(dir, 'quick.save');
      if (!fs.existsSync(quick)) return null;
      const st = fs.statSync(quick);
      return { name: e.name, dir, savedAt: st.mtime.toISOString(), size: st.size };
    })
    .filter(Boolean)
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

function latestSave() { return listSaves()[0] || null; }

function findSave(name) {
  return listSaves().find((s) => s.name === name) || null;
}

function backupRoot() {
  return overrides.backupRoot || path.join(LOCAL, 'kenshi', 'save-backups');
}

module.exports = {
  setOverrides, saveRoot, installDir, gameDataDir, workshopDir,
  listSaves, latestSave, findSave, backupRoot,
};
