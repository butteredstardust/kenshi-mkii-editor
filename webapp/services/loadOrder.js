'use strict';

const fs = require('node:fs');
const path = require('node:path');

const paths = require('./pathService');
const gamedata = require('./gamedataService');

/**
 * The game's own data-file load order.
 *
 * `gamedataService` indexes stringIDs first-definition-wins, which is the right
 * rule for a display name you only need to be stable. It is the WRONG rule
 * anywhere a mod's re-definition is the one the running game obeys, and this
 * module is the shared answer for those callers (`researchService`,
 * `racesService`).
 *
 * Order: base data (`gamedata.base` and friends) first, then `data/mods.cfg`
 * order, then anything installed but unlisted. Unlisted files go LAST rather
 * than being dropped — `rebirth.mod` is exactly that case on this install,
 * absent from mods.cfg yet plainly active, and it is the definition that renames
 * race `17-gamedata.quack` from "Human" to "Greenlander" and tech
 * `2058-gamedata.base` to the `repeats: 5` the save's ledger actually shows.
 */
function filesInLoadOrder() {
  const files = gamedata.dataFiles();
  const install = paths.installDir();
  let order = [];
  if (install) {
    try {
      order = fs.readFileSync(path.join(install, 'data', 'mods.cfg'), 'latin1')
        .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    } catch { /* no mods.cfg: base-then-everything-else is still a sane order */ }
  }
  const rank = new Map(order.map((n, i) => [n.toLowerCase(), i + 1]));
  const rankOf = (file) => {
    const base = path.basename(file);
    if (!base.endsWith('.mod')) return 0; // gamedata.base and friends always load first
    return rank.get(base.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
  };
  return files
    .map((f, i) => ({ f, r: rankOf(f), i }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.f);
}

module.exports = { filesInLoadOrder };
