'use strict';

/**
 * Console character report — the same view the webapp renders, without the
 * browser. Useful as a smoke test that the codec, the name index and the
 * domain model all still agree after a game update.
 *
 *   node scripts/status.js            newest save
 *   node scripts/status.js save1      a named save
 */

const saveService = require('../services/saveService');

const name = process.argv[2];
const s = saveService.status(name);
const pad = (v, n) => String(v).padEnd(n);

console.log('='.repeat(74));
console.log(`SAVE: ${s.save.name}   saved ${s.save.savedAt}   (Kenshi ${s.world.gameVersion})`);
console.log('='.repeat(74));
console.log(`Faction : ${s.world.faction}`);
console.log(`Region  : ${s.world.region}`);
console.log(`Time    : day ${s.world.day}, ${String(s.world.hour).padStart(2, '0')}:${String(s.world.minute).padStart(2, '0')}`);
console.log(`Cats    : ${s.world.money}`);
console.log(`Squad   : ${s.world.squads} squad(s), ${s.world.members} member(s)`);

for (const squad of s.squads) {
  for (const c of squad.characters) {
    console.log(`\n${'-'.repeat(74)}`);
    console.log(`${c.name}${c.isLeader ? '  (squad leader)' : ''}   [from ${c.origin}]`);
    console.log('-'.repeat(74));
    console.log(`  position : ${c.position.map((v) => Math.round(v)).join(', ')}`);

    const m = c.medical;
    if (m) {
      const flags = ['dead', 'unconscious', 'coma', 'incapacitated'].filter((k) => m[k]);
      console.log(`  condition: ${flags.length ? flags.join(', ').toUpperCase() : 'conscious'}`);
      console.log(`  blood ${m.blood?.toFixed(1)}   bleeding ${m.bleeding?.toFixed(2)}   fed ${m.fed?.toFixed(2)}   hunger ${m.hunger?.toFixed(2)}`);
      for (const p of m.parts) {
        const filled = Math.round((p.percentOfIntact ?? 0) / 5);
        console.log(`    ${pad(p.part, 14)} ${'#'.repeat(filled)}${'.'.repeat(Math.max(0, 20 - filled))} ${p.current.toFixed(1).padStart(6)}  ${String(p.percentOfIntact).padStart(3)}%`);
      }
    }

    if (c.stats) {
      const a = c.stats.attributes;
      console.log(`  attributes: STR ${a.strength.toFixed(1)}  DEX ${a.dexterity.toFixed(1)}  TGH ${a.toughness.toFixed(1)}  PER ${a.perception.toFixed(1)}`);
      const trained = c.stats.skills.filter((k) => k.level > 1.05).slice(0, 12);
      console.log(`  skills: ${trained.map((k) => `${k.skill} ${k.level.toFixed(1)}`).join(', ') || '(all at starting level)'}`);
    }

    if (c.inventory.length) {
      console.log(`  inventory (${c.inventory.length}):`);
      for (const it of c.inventory) {
        console.log(`    ${pad(it.name, 30)} ${it.quantity > 1 ? `x${it.quantity} ` : ''}[${it.section}]`);
      }
    }
  }
}
