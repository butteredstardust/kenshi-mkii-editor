'use strict';

const fs = require('node:fs');
const path = require('node:path');

const paths = require('../services/pathService');
const backups = require('../services/backupService');
const { readFile } = require('../services/kenshi/codec');
const fixture = require('../test/helpers/save-fixture');

/**
 * Snapshot one of the player's saves into `webapp/.fixtures/` for the test
 * suite to use.
 *
 * WHY THIS EXISTS. The tests used to source every scratch copy from
 * `paths.latestSave()` — the player's actual current save. Reading it is
 * harmless, but *depending* on it is not:
 *
 *  - The suite's meaning changed as the player played. Two tests broke
 *    mid-session for no reason but that a character had since been wounded and
 *    another trained, and "need a player squad of at least 2" is a precondition
 *    the player can invalidate at any time.
 *  - A save that rolls over (autosave0/1/2 cycling) silently changes which file
 *    the whole suite is talking about between two runs.
 *
 * A fixture fixes both: the suite talks about one known save until someone
 * deliberately re-snapshots it.
 *
 * FULL BY DEFAULT. The copy is a whole save directory, `zone/` and all (39 MB,
 * 400 files). mutationService copies and hashes every file in the directory it
 * writes to, so a trimmed fixture exercises a smaller gate than the real thing
 * — and `zone/` is what proves a mutation leaves unrelated files alone.
 *
 * `--slim` drops `zone/` (28 MB the editor never reads or writes) for a faster
 * local loop: the suite makes a fresh copy per write test, so the full fixture
 * costs about 87s against about 35s slim. Correctness is identical either way;
 * what you lose is the evidence that a write ignored the 210 files it should.
 *
 * Usage:
 *   node scripts/make-fixture.js            # newest save, full
 *   node scripts/make-fixture.js autosave1  # a named save
 *   node scripts/make-fixture.js --slim     # newest save, without zone/
 */
function main() {
  const args = process.argv.slice(2);
  const slim = args.includes('--slim');
  const wanted = args.find((a) => !a.startsWith('--'));
  const src = wanted ? paths.findSave(wanted) : paths.latestSave();
  if (!src) {
    console.error(wanted ? `no save named "${wanted}"` : 'no Kenshi saves found');
    console.error(`saves seen: ${paths.listSaves().map((s) => s.name).join(', ') || '(none)'}`);
    process.exitCode = 1;
    return;
  }

  const root = fixture.fixtureRoot();
  const dest = path.join(root, src.name);

  // Re-snapshotting replaces the previous fixture rather than merging into it:
  // a half-updated save directory is not a save directory.
  if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });

  const started = Date.now();
  backups.copyDir(src.dir, dest);
  if (slim) fs.rmSync(path.join(dest, 'zone'), { recursive: true, force: true });

  // A fixture that doesn't parse is worse than no fixture — it would fail every
  // suite with a confusing error instead of an obvious one. Check before
  // declaring success.
  const quick = path.join(dest, 'quick.save');
  if (!fs.existsSync(quick)) throw new Error(`copied fixture has no quick.save: ${dest}`);
  const parsed = readFile(fs.readFileSync(quick));

  let files = 0;
  let bytes = 0;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else { files++; bytes += fs.statSync(p).size; }
    }
  };
  walk(dest);

  fs.writeFileSync(path.join(root, 'FIXTURE.json'), `${JSON.stringify({
    save: src.name,
    slim,
    sourceDir: src.dir,
    savedAt: src.savedAt,
    snapshotAt: new Date().toISOString(),
    files,
    bytes,
    records: parsed.records.length,
  }, null, 2)}\n`);

  console.log(`fixture: ${src.name} -> ${dest}`);
  console.log(`  ${files} files, ${(bytes / 1048576).toFixed(1)} MB, ${parsed.records.length} records in quick.save${slim ? ' (slim: no zone/)' : ''}`);
  console.log(`  copied in ${Date.now() - started} ms`);
  console.log('  the test suite will use this instead of your live save');
}

main();
