'use strict';

const fs = require('node:fs');
const path = require('node:path');

const paths = require('./pathService');
const { asText } = require('./kenshi/binary');

/**
 * Plausible character names — read from Kenshi's own name pools.
 *
 * The game ships `namesM.txt`, `namesF.txt` and `namesMF.txt` in its data
 * directory and draws every generated NPC name from them. Using the same files
 * is why a rolled name reads like a Kenshi name instead of like something an
 * editor invented: they are the source of "Shaku", "Squint", "Bloodrum-drinker
 * called Cat". No list is hardcoded here.
 *
 * The files are plain newline-separated text, read as latin1 like everything
 * else that comes off this install (a name file is not guaranteed ASCII, and
 * decoding it as UTF-8 is the same trap `docs/save-format.md` §2 describes).
 *
 * If the install can't be found, this falls back to an empty pool and the
 * caller simply gets no suggestion — a missing name file must never stop a
 * character being created.
 */

const FILES = [
  ['male', 'namesM.txt'],
  ['female', 'namesF.txt'],
  ['any', 'namesMF.txt'],
];

let pools = null;

function readPool(dir, file) {
  try {
    // latin1, for the same reason the codec uses it — see the header.
    const raw = fs.readFileSync(path.join(dir, file), 'latin1');
    return raw.split(/\r?\n/)
      .map((line) => asText(line).trim())
      .filter((line) => line && !line.startsWith('#'));
  } catch {
    return [];
  }
}

function load() {
  if (pools) return pools;
  const install = paths.installDir();
  const dir = install ? path.join(install, 'data') : null;
  pools = { male: [], female: [], any: [] };
  if (dir) for (const [key, file] of FILES) pools[key] = readPool(dir, file);
  return pools;
}

/**
 * @param {object} [opts]
 * @param {'male'|'female'|'any'} [opts.gender='any'] which pool to draw from;
 *   'any' means all three pooled together, which is what an editor with no
 *   opinion about a character's gender should do.
 * @param {function} [opts.rng=Math.random] injectable for deterministic tests,
 *   same discipline as trainCharacter()/recruits.roll().
 * @param {string[]} [opts.avoid] names already in use — a squad with two
 *   Shakus is a worse default than trying again.
 * @returns {string|null} null when this install has no name files at all
 */
function random({ gender = 'any', rng = Math.random, avoid = [] } = {}) {
  const p = load();
  const pool = gender === 'any' ? [...p.male, ...p.female, ...p.any] : (p[gender] || []);
  if (!pool.length) return null;

  const taken = new Set(avoid.map((n) => String(n).toLowerCase()));
  const free = pool.filter((n) => !taken.has(n.toLowerCase()));
  const from = free.length ? free : pool; // every name taken: repeat rather than fail
  return from[Math.floor(rng() * from.length)];
}

function stats() {
  const p = load();
  return { male: p.male.length, female: p.female.length, any: p.any.length, total: p.male.length + p.female.length + p.any.length };
}

/** Test/diagnostic hook — drops the cached pools so a reinstall is picked up. */
function reload() { pools = null; return stats(); }

module.exports = { random, stats, reload };
