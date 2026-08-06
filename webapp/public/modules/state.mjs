export const page = document.getElementById('page');
export const envEl = document.getElementById('env');

// `selected` is a "<platoonFile>::<sid>" key, not an index — the roster can be
// filtered and the save re-read between renders, so positions aren't stable.
export const state = {
  env: null, save: null, status: null, current: 'squad', selected: null, filter: '',
  archetypes: [], // catalogue for "train as archetype" dropdowns, fetched once at boot
  personalities: [], // the seven working personality values, decoded from gamedata
  recruits: [], // "roll a recruit" catalogue (editorial — see services/recruits.js)
  namePool: [], // plausible names from Kenshi's own namesM/F/MF.txt
  races: null, // { races, default } for THIS save — a new member is cloned from
  // an existing character, so the list is what the save contains, not all of gamedata.
  raceCatalogue: [], // EVERY race in gamedata, load-order resolved (services/racesService.js).
  // Switching a race clones nothing, so it can offer races this save has never seen.
  // "Add member" form state, kept here so the re-render after a successful add
  // doesn't wipe what the user typed for the next one (same reason as trainChoice).
  addMember: null,
  // Receipt for whichever PANEL-level (not card-level) mutation just ran — the
  // Squad tab's rename/add-member panel or the Loadouts tab's bulk equip. Both
  // re-render on success, which replaces the .receipt element the result was
  // just written into, so it is stashed here and re-attached by the next wire().
  // Only one of those panels exists at a time (they are on different tabs).
  panelReceipt: null,
  loadouts: [], // named gear sets — the Loadouts catalogue AND bulk equip's source (editorial — services/loadouts.js)
  loadoutFilter: { q: '', category: '' }, // Loadouts tab's own search/category filter
  recruitFilter: { q: '', group: '' }, // Recruits tab's own search/group filter
  locations: [], // town positions, from the INSTALL's world data (not the save)
  vendors: null, // { tree, stats } — who sells what, from gamedata not the save
  vendorSel: null, // { faction, town, shopId } drill-down selection
  vendorShop: null, // the loaded shop's full contents
  vendorTarget: null, // "<file>::<sid>" of the character an Add goes to
  teleport: null, // { locationId } — survives the re-render a jump triggers
  // Research, fetched per save (a save's research state is one type-21 record
  // in its own quick.save) and cleared whenever the save changes or a write
  // lands. `researchSel` is a Set of tech sids — techs have stable ids, so
  // unlike the roster there is no file::sid key to build.
  research: null,
  // Faction relations, fetched per save (they are 114 type-37 records in that
  // save's own quick.save) and cleared whenever the save changes or a write
  // lands. `factionEdits` is a Map keyed "<fromGamedataSid>|<toGamedataSid>" —
  // faction sids are stable gamedata ids, so unlike the roster there is no
  // file::sid key to build. Both the player table and the drill-down write into
  // the SAME map, so a batch can span both and still be one staged edit.
  factions: null,
  factionEdits: new Map(),
  factionFilter: {
    q: '', standing: '', onlyMet: false, hideDebug: true,
    viewQ: '', // the drill-down's own search — see factionMatches()
  },
  factionFocus: null, // gamedata sid whose outgoing relations are open
  factionView: null, // the loaded relationsOf() result for factionFocus
  researchSel: new Set(),
  researchFilter: { q: '', category: '', onlyTodo: true },
  researchReqs: true, // "include prerequisites" — see researchService.plan()
  // Bulk equip (Loadouts tab): a Set of the same stable "<file>::<sid>" keys
  // `selected` uses, never indices — the roster can be filtered and the save
  // re-read between renders. Empty means "not in selection mode".
  selection: new Set(),
  selectMode: false,
  // Race stringID the roster is narrowed to, or '' for all. A sid, never a name
  // — two races in this install share a display name. Paired with "All shown",
  // this is how "give every Skeleton this" is done in two clicks.
  raceFilter: '',
  // Which roster groups (platoon files) are expanded. `null` means "follow the
  // selection" — only the group holding the selected character is open, and it
  // follows them as they move. The moment the user toggles a group by hand this
  // becomes a real Set and their choice sticks, until the selection moves to a
  // group that isn't open, which hands control back. See rosterGroupsOpen().
  rosterOpen: null,
  bulk: null, // { loadoutId, skipIfSlotFilled } — survives the re-render after a write
  // The bulk panel's OTHER half: one item picked once and given to everyone
  // selected ("equip the whole squad with Blackened Chainmail"). Same shape as
  // `addItem` minus the per-character key, because the whole point is that it
  // is not tied to one character.
  // { query, kind, slot, results, total, template, level, gradeId, quantity, section, skipIfSlotFilled }
  bulkItem: null,
  // The bulk panel's two edits to gear the selection ALREADY owns, kept here for
  // the same reason as `bulk`: both re-render on success, and a form that snaps
  // back to its defaults contradicts the receipt that just said what was applied.
  // { armourLevel, gradeId, includeCarried, includePackContents } — no
  // weaponLevel: the panel asks for a grade and the server takes the level from
  // that grade's ladder rank. The route still accepts one; nothing sends it.
  bulkGear: null,
  bulkUnequip: null, // { slot, templateSid }
  pendingReceipt: null, // survives the re-render a mutation triggers (see wire())
  trainChoice: null, // { key, archetype, sub } — likewise survives the re-render
  // "Add item" picker state, keyed like trainChoice so it survives the
  // re-render a successful add triggers — otherwise adding one of something
  // would clear the search and force the user to start over to add a second.
  // { key, query, results, total, template, level, gradeId, quantity, section }
  addItem: null,
  itemKinds: [], itemSlots: [], // filter vocabulary, owned by the server
  weaponGrades: null, // fetched once, lazily — only needed when a weapon is picked
  colors: null, // the type-55 colour-scheme catalogue (TODO.md 3.1), fetched once
  factionCatalogue: null, // the full type-10 faction catalogue — the uniform picker's source (TODO.md 3.2)
  // Backups accumulate one per edit and never expire, so the list is long and
  // mostly about saves you are not looking at. Both filters are view-only.
  backupFilter: { allSaves: false, showAll: false },
};

export const keyOf = (file, sid) => `${file}::${sid}`;

/** Look up a character object (for its live `.inventory`) by roster key parts. */
export function findCharacter(file, sid) {
  const s = state.status;
  const q = s && s.squads.find((sq) => sq.file === file);
  return q ? q.characters.find((c) => c.sid === sid) || null : null;
}

/** True when writes are possible right now. Every mutation control uses this. */
export const canWrite = () => !state.env.gameRunning;
export const dis = () => (canWrite() ? '' : 'disabled');
