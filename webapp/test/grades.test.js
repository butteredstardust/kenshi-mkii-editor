'use strict';

/**
 * The weapon-grade ladder resolves in the game's own load order.
 *
 * A player reported the editor offering "Edge Type 5" where his game says
 * "Edge Type 3". Both are the same record — `1069-gamedata.base` — named one
 * thing in `gamedata.base` and another in four installed mods, and the game
 * obeys the last one. The ladder was built first-definition-wins, so it
 * disagreed with the screen on the NAME and, worse, on the RANK: that number
 * is what `itemFactory.defaultLevelForGrade()` writes into a weapon's
 * `ints.level`, and all 11 re-defined grade pairs carry a different one.
 *
 * These tests re-derive the answer straight from the data files, in load
 * order, and compare — so they keep passing when the player's mod list
 * changes, and fail the moment the ladder goes back to reading whichever
 * definition it saw first. Same shape as test/research.test.js, which pins
 * the same rule for techs.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const gamedata = require('../services/gamedataService');
const { filesInLoadOrder } = require('../services/loadOrder');
const { readFile } = require('../services/kenshi/codec');
const { asText } = require('../services/kenshi/binary');

/** Last-definition-wins names and grade rows, read independently of the index. */
function resolveFromDisk() {
  const names = new Map(); // sid -> name (last wins)
  const rows = new Map(); // "company|model" -> rank (last wins)
  for (const file of filesInLoadOrder()) {
    let parsed;
    try { parsed = readFile(fs.readFileSync(file)); } catch { continue; }
    for (const rec of parsed.records) {
      if (!rec.sid) continue;
      if (rec.type === 50 || rec.type === 51) names.set(rec.sid, asText(rec.name));
      if (rec.type !== 51) continue;
      for (const row of rec.extra.get('weapon models') || []) {
        if (row.target) rows.set(`${rec.sid}|${row.target}`, row.v0);
      }
    }
  }
  return { names, rows };
}

const grades = gamedata.weaponGrades();
const disk = resolveFromDisk();

test('the ladder has rows to check at all', () => {
  assert.ok(grades.length > 0, 'no weapon grades — is the Kenshi install readable?');
  assert.ok(disk.rows.size > 0, 'no grade rows found on disk');
});

test('every grade name is the LAST definition in load order, not the first', () => {
  const wrong = [];
  for (const g of grades) {
    const model = disk.names.get(g.modelSid);
    const company = disk.names.get(g.companySid);
    if (model !== undefined && g.modelName !== model) wrong.push(`${g.id}: model "${g.modelName}" != "${model}"`);
    if (company !== undefined && g.companyName !== company) wrong.push(`${g.id}: company "${g.companyName}" != "${company}"`);
  }
  assert.deepEqual(wrong, [], 'names must match the last definition the game loads');
});

test('every grade rank is the LAST definition in load order — it becomes a weapon\'s level', () => {
  const wrong = [];
  for (const g of grades) {
    const rank = disk.rows.get(g.id);
    if (rank !== undefined && g.rank !== rank) wrong.push(`${g.id}: rank ${g.rank} != ${rank}`);
  }
  assert.deepEqual(wrong, [], 'ranks must match the last definition the game loads');
});

test('a grade is the (company, model) pair, and every id is unique', () => {
  const ids = grades.map((g) => g.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate grade id');
  for (const g of grades) assert.equal(g.id, `${g.companySid}|${g.modelSid}`);
});

test('the ladder is rank-ascending, so a UI can present it as a ladder', () => {
  for (let i = 1; i < grades.length; i++) {
    assert.ok(grades[i].rank >= grades[i - 1].rank,
      `rank ${grades[i].rank} follows ${grades[i - 1].rank}`);
  }
});

test('the cache is versioned past the first-definition-wins ladder', () => {
  // A cache written before this fix holds the old names and ranks and would be
  // served verbatim; only the version bump forces the rebuild.
  const cache = path.join(__dirname, '..', '.cache', 'nameindex.json');
  if (!fs.existsSync(cache)) return;
  const { version } = JSON.parse(fs.readFileSync(cache, 'utf8'));
  assert.ok(version >= 9, `stale cache version ${version} — run npm run gamedata:rebuild`);
});
