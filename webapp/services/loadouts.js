'use strict';

const gamedata = require('./gamedataService');
const itemSlots = require('./itemSlots');

/**
 * Named gear sets for "equip several characters at once".
 *
 * IMPORTANT, same caveat as services/archetypes.js and services/recruits.js:
 * **this is editorial data, not derived from a save.** It is a convenience
 * catalogue, safe to edit, re-balance or delete without re-deriving anything.
 * `validate()` (called by the tests) is the only hard constraint: every
 * `templateSid` must resolve to a real item template, and every `section` must
 * be one that template's kind can actually occupy per services/itemSlots.js.
 *
 * These four entries are the contents of the four ad-hoc scripts this feature
 * replaced (`scripts/equip-weapons.js`, `equip-ancient-samurai.js`,
 * `equip-octo.js`, `equip-backpacks.js`). The sids, levels and grade below are
 * exactly the ones those scripts used.
 *
 * `raceNotes` carries the scripts' own race rules — but ONLY as warning text.
 * Bulk equip deliberately never skips a character (see saveService.equipMany):
 * everything selected gets everything in the loadout, and anything the editor
 * believes is a poor fit is reported afterwards. Hard incompatibility (an item
 * kind that cannot occupy the requested slot at all) is still a refusal, and
 * that check lives in itemSlots.js, not here.
 */

// The weapon grade both weapon-carrying scripts asked for: "Edge Type 5" as
// made by the player's own workshops. Written as a grade id
// ("<companySid>|<modelSid>") because a bare model sid is ambiguous — Edge
// Type 5 also exists as an Edgewalkers product, and picking the wrong one
// silently rewrites the weapon's manufacturer. See gamedataService.weaponGrades().
const EDGE_TYPE_5_HOMEMADE = 'PLAYER_WEAPONS|1069-gamedata.base';

const SAMURAI = [
  { templateSid: '1533508-Newwworld.mod', section: 'armour', level: 95 },
  { templateSid: '1533509-Newwworld.mod', section: 'boots', level: 95 },
  { templateSid: '1533511-Newwworld.mod', section: 'legs', level: 95 },
  { templateSid: '1533510-Newwworld.mod', section: 'head', level: 95 },
];

const WEAPONS = [
  { templateSid: '476-gamedata.base', section: 'hip', level: 80, gradeId: EDGE_TYPE_5_HOMEMADE },
  { templateSid: '52308-rebirth.mod', section: 'back', level: 80, gradeId: EDGE_TYPE_5_HOMEMADE },
];

const LOADOUTS = [
  {
    id: 'ancient-samurai',
    label: 'Ancient Samurai armour',
    description: 'Masterwork-tier Ancient Samurai plate, boots, legplates and helmet.',
    items: SAMURAI,
    raceNotes: [
      { races: ['Skeleton', 'Hive'], note: 'boots and helmet are a poor fit on this race' },
      { races: ['Dog1'], note: 'animal — wears nothing' },
    ],
  },
  {
    id: 'player-weapons',
    label: 'Katana + naginata',
    description: 'Edge Type 5 katana on the hip and naginata on the back, level 80.',
    items: WEAPONS,
    raceNotes: [{ races: ['Dog1'], note: 'animal — carries nothing' }],
  },
  {
    id: 'thieves-backpack',
    label: 'Thieves Backpack',
    description: 'One Thieves Backpack, worn.',
    items: [{ templateSid: '46036-rebirth.mod', section: 'backpack_attach' }],
    raceNotes: [{ races: ['Dog1'], note: 'animal — wears nothing' }],
  },
  {
    id: 'full-kit',
    label: 'Full kit (armour + weapons)',
    description: 'The Ancient Samurai set and both weapons together.',
    items: [...SAMURAI, ...WEAPONS],
    raceNotes: [
      { races: ['Skeleton', 'Hive'], note: 'boots and helmet are a poor fit on this race' },
      { races: ['Dog1'], note: 'animal — wears and carries nothing' },
    ],
  },
];

function find(id) {
  return LOADOUTS.find((l) => l.id === id) || null;
}

/**
 * Catalogue for the UI, with each item's resolved name and kind so the client
 * can show what a loadout contains without looking anything up itself.
 * `missing` lists any templateSid this install's data cannot resolve — a
 * loadout referencing a mod the user has since removed still renders, clearly
 * marked, rather than vanishing or throwing.
 */
function catalogue() {
  return LOADOUTS.map((l) => {
    const items = l.items.map((it) => {
      const tmpl = gamedata.lookup(it.templateSid);
      return {
        templateSid: it.templateSid,
        section: it.section,
        level: it.level ?? null,
        gradeId: it.gradeId ?? null,
        name: tmpl ? tmpl.name : null,
        type: tmpl ? tmpl.type : null,
      };
    });
    return {
      id: l.id,
      label: l.label,
      description: l.description,
      items,
      raceNotes: l.raceNotes || [],
      missing: items.filter((it) => !it.name).map((it) => it.templateSid),
    };
  });
}

/**
 * Throws if any entry is malformed or names a section its template's kind
 * cannot occupy. An unresolvable templateSid is NOT fatal — this install's mod
 * set is not the only one these ids could be checked against — but it is
 * returned so a test can report it.
 * @returns {{ ok: true, unresolved: string[] }}
 */
function validate() {
  const ids = LOADOUTS.map((l) => l.id);
  if (new Set(ids).size !== ids.length) throw new Error('duplicate loadout id');

  const unresolved = [];
  for (const l of LOADOUTS) {
    if (!l.id || !l.label) throw new Error(`loadout missing id/label: ${JSON.stringify(l)}`);
    if (!Array.isArray(l.items) || !l.items.length) throw new Error(`loadout "${l.id}" has no items`);
    for (const it of l.items) {
      if (!it.templateSid || !it.section) {
        throw new Error(`loadout "${l.id}": every item needs templateSid and section`);
      }
      const tmpl = gamedata.lookup(it.templateSid);
      if (!tmpl) { unresolved.push(it.templateSid); continue; }
      const { sections } = itemSlots.allowedSections(it.templateSid, null);
      if (!sections.includes(it.section)) {
        throw new Error(
          `loadout "${l.id}": "${tmpl.name}" cannot occupy section "${it.section}" `
          + `(allowed: ${sections.join(', ')})`,
        );
      }
    }
  }
  return { ok: true, unresolved };
}

module.exports = { LOADOUTS, find, catalogue, validate };
