import { API } from './modules/api-client.mjs';
import { esc, num, inputNum, meter, showReceipt, runMutation } from './modules/core.mjs';

/*
 * Reference implementation for docs/ui-style-guide.md. New features compose the
 * components in styles.css — they do not introduce per-feature class names, and
 * every mutation control follows the same shape: intent tier -> confirm if
 * destructive -> disabled while the game runs -> receipt via runMutation().
 */

const page = document.getElementById('page');
const envEl = document.getElementById('env');

// `selected` is a "<platoonFile>::<sid>" key, not an index — the roster can be
// filtered and the save re-read between renders, so positions aren't stable.
const state = {
  env: null, save: null, status: null, current: 'squad', selected: null, filter: '',
  archetypes: [], // catalogue for "train as archetype" dropdowns, fetched once at boot
  recruits: [], // "roll a recruit" catalogue (editorial — see services/recruits.js)
  races: null, // { races, default } for THIS save — a new member is cloned from
  // an existing character, so the list is what the save contains, not all of gamedata.
  // "Add member" form state, kept here so the re-render after a successful add
  // doesn't wipe what the user typed for the next one (same reason as trainChoice).
  addMember: null,
  // Receipt for whichever PANEL-level (not card-level) mutation just ran — the
  // Squad tab's rename/add-member panel or the Gear tab's bulk equip. Both
  // re-render on success, which replaces the .receipt element the result was
  // just written into, so it is stashed here and re-attached by the next wire().
  // Only one of those panels exists at a time (they are on different tabs).
  panelReceipt: null,
  loadouts: [], // named gear sets for bulk equip (editorial — services/loadouts.js)
  // Bulk equip: a Set of the same stable "<file>::<sid>" keys `selected` uses,
  // never indices — the roster can be filtered and the save re-read between
  // renders. Empty means "not in selection mode", so single-character editing
  // is completely unchanged until you tick something.
  selection: new Set(),
  selectMode: false,
  bulk: null, // { loadoutId, skipIfSlotFilled } — survives the re-render after a write
  pendingReceipt: null, // survives the re-render a mutation triggers (see wire())
  trainChoice: null, // { key, archetype, sub } — likewise survives the re-render
  // "Add item" picker state, keyed like trainChoice so it survives the
  // re-render a successful add triggers — otherwise adding one of something
  // would clear the search and force the user to start over to add a second.
  // { key, query, results, total, template, level, gradeId, quantity, section }
  addItem: null,
  weaponGrades: null, // fetched once, lazily — only needed when a weapon is picked
};

const keyOf = (file, sid) => `${file}::${sid}`;

/** Look up a character object (for its live `.inventory`) by roster key parts. */
function findCharacter(file, sid) {
  const s = state.status;
  const q = s && s.squads.find((sq) => sq.file === file);
  return q ? q.characters.find((c) => c.sid === sid) || null : null;
}

async function boot() {
  state.env = await API.status();
  const s = state.env.saves[0];
  state.save = s ? s.name : null;
  envEl.innerHTML = state.env.gameRunning
    ? '<span class="critical">Kenshi is running — edits are blocked until you close it</span>'
    : `<span class="ok">ready</span> <span class="muted">· ${esc(state.env.saves.length)} save(s) · ${esc(state.env.saveRoot || 'no save folder found')}</span>`;
  if (state.save) state.status = await API.saveStatus(state.save);
  state.archetypes = await API.archetypes();
  state.recruits = await API.recruits().catch(() => []);
  state.loadouts = await API.loadouts().catch(() => []);
  await loadRaces();
  // The grade ladder backs the Gear row's weapon "Quality" select, which is
  // rendered synchronously, so it has to be here rather than fetched lazily.
  // It is one small request (38 rows) and almost every squad carries a weapon.
  try {
    state.weaponGrades = (await API.weaponGrades()).grades;
  } catch {
    state.weaponGrades = []; // ladder is an enhancement; rows fall back to raw fields
  }
  render();
}

/**
 * Race list for the current save. Per-save, not global: "Add member" clones an
 * existing character of the chosen race out of this save, so a race with no
 * living example here genuinely cannot be recruited (see
 * services/characterFactory.js).
 */
async function loadRaces() {
  if (!state.save) { state.races = null; return; }
  try {
    state.races = await API.races(state.save);
  } catch {
    state.races = { races: [], default: null }; // panel renders its own explanation
  }
}

/** True when writes are possible right now. Every mutation control uses this. */
const canWrite = () => !state.env.gameRunning;
const dis = () => (canWrite() ? '' : 'disabled');

function savePicker() {
  return `<label class="picker">Save
    <select id="save-select">
      ${state.env.saves.map((s) => `<option value="${esc(s.name)}" ${s.name === state.save ? 'selected' : ''}>${esc(s.name)} — ${esc(s.savedAt)}</option>`).join('')}
    </select></label>`;
}

// Display label -> real on-disk float key on the STATS (25) record. Attribute
// keys don't all match their display label (`toughness2`, not `toughness`).
const ATTR_LABELS = [
  ['strength', 'Strength'], ['dexterity', 'Dexterity'],
  ['toughness2', 'Toughness'], ['perception', 'Perception'],
];

function statField(statKey, label, value, min = 0) {
  const v = inputNum(value);
  return `<label class="field">${esc(label)}
    <input type="number" class="stat-input" data-stat="${esc(statKey)}" data-initial="${esc(v)}"
      min="${esc(min)}" max="100" step="0.1" value="${esc(v)}"></label>`;
}

// Display-only grouping for the skills field-grid — purely presentational, it
// never changes which float key gets written (`data-stat` is always the raw
// on-disk key, same as an ungrouped field). Any skill key not covered here
// still renders, in the trailing "Other" group, so a modded save's extra
// skills are never silently hidden.
const SKILL_GROUPS = [
  ['Combat', ['attack', 'defence', 'unarmed', 'katana', 'sabres', 'blunt', 'poles',
    'heavy weapons', 'dodge', 'arrow defence', 'mass combat', 'warrior spirit', 'assassin']],
  ['Ranged', ['bow', 'turrets']],
  ['Crafting & labour', ['armour smith', 'weapon smith', 'bow smith', 'engineer',
    'robotics', 'cooking', 'farming', 'labouring']],
  ['Science & medical', ['science', 'medic', 'doctor', 'hackers']],
  ['Athletics & stealth', ['athletics', 'climbing', 'swimming', 'endurance', 'stealth',
    'lockpicking', 'thievery', 'tracking', 'survival', 'bluff']],
];

function healthSection(m) {
  const flags = ['dead', 'unconscious', 'coma', 'incapacitated'].filter((k) => m[k]);
  const hurt = flags.length > 0 || (m.parts || []).some((p) => (p.percentOfIntact ?? 100) < 100);

  return `<details class="section" ${hurt ? 'open' : ''}>
    <summary>Health</summary>
    <div class="section-body stack">
      ${flags.length ? `<div class="actions">
        <button class="btn btn--primary revive-btn" ${dis()}>Revive</button>
        ${m.limbs != null ? `<button class="btn btn--danger restore-limbs-btn" ${dis()}>Restore limbs</button>` : ''}
      </div>
      <p class="hint">Revive clears death, KO and coma flags and raises lethally low flesh in the same write — HP overrides the flags on reload, so they must change together.</p>`
    : (m.limbs != null ? `<div class="actions"><button class="btn btn--danger restore-limbs-btn" ${dis()}>Restore limbs</button></div>` : '')}

      <div class="field-row">
        <label class="field">Hunger
          <input type="number" class="hunger-input w-sm" data-field="hung" data-initial="${esc(inputNum(m.hunger))}"
            min="0" max="3" step="0.1" value="${esc(inputNum(m.hunger))}"></label>
        <label class="field">Fed
          <input type="number" class="hunger-input w-sm" data-field="fed" data-initial="${esc(inputNum(m.fed))}"
            min="0" max="10" step="0.1" value="${esc(inputNum(m.fed))}"></label>
        <button class="btn btn--primary save-hunger" ${dis()}>Apply</button>
      </div>
      <p class="hint">Hunger runs 0–3. Fed has no documented cap; this editor allows 0–10.</p>

      <div class="table-wrap"><table class="data-table table--compact">
        <caption>Bars are relative to this character's own undamaged parts, not to <code>hit&lt;n&gt;</code>.</caption>
        <thead><tr>
          <th>Part</th><th class="col-meter">Condition</th><th class="n">Current</th><th class="n">%</th>
          <th class="shrink">Set flesh</th><th class="shrink"></th>
        </tr></thead>
        <tbody>${(m.parts || []).map((p, i) => `<tr data-part="${esc(i)}">
          <td>${esc(p.part)}</td>
          <td class="col-meter">${meter(p.percentOfIntact)}</td>
          <td class="n">${num(p.current)}</td>
          <td class="n muted">${esc(p.percentOfIntact ?? '—')}%</td>
          <td class="shrink"><input type="number" class="flesh-input w-sm" step="0.1" value="${esc(inputNum(p.current))}"></td>
          <td class="shrink"><span class="actions">
            <button class="btn btn--xs heal-part-btn" data-part="${esc(i)}" ${dis()}>Set</button>
            <button class="btn btn--xs full-heal-btn" data-part="${esc(i)}" ${dis()}>Full</button>
          </span></td></tr>`).join('')}</tbody>
      </table></div>
    </div>
  </details>`;
}

/*
 * Nested `<details class="section">`, same pattern as the "Skills (N)" block
 * below — that's the judgement call for the "one .btn--primary per section"
 * rule (style guide §3): the outer Stats & skills section already spends its
 * primary slot on "Apply stats" (manual per-field edits), so Train gets its
 * own nested section rather than fighting over the same slot or downgrading
 * either action's tier. Train is a bulk, high-blast-radius write in its own
 * right and reads clearly as its own sub-commit.
 */
function trainSection() {
  const cats = state.archetypes || [];
  if (!cats.length) return '';
  const mainOptions = cats.map((a) => `<option value="${esc(a.id)}">${esc(a.label)}</option>`).join('');
  const firstSubs = cats[0].subs || [];
  const subOptions = firstSubs.map((s) => `<option value="${esc(s.id)}">${esc(s.label)}</option>`).join('');
  return `<details class="section">
    <summary>Train as archetype</summary>
    <div class="section-body stack">
      <div class="field-row">
        <label class="field">Main archetype
          <select class="train-main">${mainOptions}</select></label>
        <label class="field">Sub-archetype
          <select class="train-sub">${subOptions}</select></label>
        <label class="field-check">
          <input type="checkbox" class="train-raise-only" checked>
          Only raise (never lower existing)
        </label>
        <button class="btn btn--primary train-btn" ${dis()}>Train</button>
      </div>
      <p class="hint">Attributes are set to 45. Archetype skills (main + sub) roll 45–95. Every other skill rolls 15–40. Each skill is randomised independently.</p>
    </div>
  </details>`;
}

function statsSection(c) {
  const a = c.stats.attributes || {};
  const skills = c.stats.skills || [];
  const bySkill = new Map(skills.map((k) => [k.skill, k.level]));
  const grouped = new Set();

  const groupHtml = SKILL_GROUPS.map(([label, keys]) => {
    const present = keys.filter((k) => bySkill.has(k));
    present.forEach((k) => grouped.add(k));
    if (present.length === 0) return '';
    return `<h4 class="group-label">${esc(label)}</h4>
      <div class="field-grid">
        ${present.map((k) => statField(k, k, bySkill.get(k), -100)).join('')}
      </div>`;
  }).join('');

  // Anything not covered by SKILL_GROUPS (including a modded save's extra
  // skill keys) still renders here, so nothing is silently hidden.
  const other = skills.filter((k) => !grouped.has(k.skill));
  const otherHtml = other.length ? `<h4 class="group-label">Other</h4>
    <div class="field-grid">
      ${other.map((k) => statField(k.skill, k.skill, k.level, -100)).join('')}
    </div>` : '';

  return `<details class="section">
    <summary>Stats &amp; skills</summary>
    <div class="section-body stack">
      <div class="field-grid">
        ${ATTR_LABELS.map(([key, label]) => statField(key, label, a[key === 'toughness2' ? 'toughness' : key] ?? 0)).join('')}
      </div>
      <details class="section">
        <summary>Skills (${esc(skills.length)})</summary>
        <div class="section-body stack">
          ${groupHtml}${otherHtml}
        </div>
      </details>
      <div class="actions">
        <button class="btn btn--primary save-stats" ${dis()}>Apply stats</button>
        <span class="hint">Attributes clamp to 0–100. Skills allow -100–100 (untrained skills are stored negative). Values above 100 can bug out in game.</span>
      </div>
      ${trainSection()}
    </div>
  </details>`;
}

function inventorySection(c) {
  return `<details class="section">
    <summary>Inventory (${esc(c.inventory.length)})</summary>
    <div class="section-body table-wrap">
      <table class="data-table"><tbody>${c.inventory.map((it) => `<tr>
        <td>${esc(it.name)}</td>
        <td class="n">${it.quantity > 1 ? `×${esc(it.quantity)}` : ''}</td>
        <td class="muted">${esc(it.section)}</td></tr>`).join('') || '<tr><td class="muted">Empty.</td></tr>'}
      </tbody></table>
    </div>
  </details>`;
}

// ------------------------------------------------------------------ Gear --

// Body slots, one roster row each in "Equipped". `main` (general carry) and
// `backpack_attach`/`backpack_content` are grouped into their own "Carried"
// and "Backpack" sections instead (a worn backpack + its contents read
// better together than split across two panes) — every slot still appears
// in exactly one section, never zero or two. Mirrors saveService's
// ITEM_SLOTS/ITEM_BUCKET_SLOTS; kept in sync by hand since the client has no
// access to the server module.
const EQUIP_SLOTS = ['head', 'shirt', 'armour', 'legs', 'boots', 'back', 'hip', 'belt'];
const ITEM_SLOTS = ['main', 'head', 'shirt', 'armour', 'legs', 'boots', 'back', 'hip', 'belt', 'backpack_attach', 'backpack_content'];

// FCS-guide-confirmed named tiers for armour's "Level" field (TODO.md 3.4) —
// this save's own data backs it: every armour-typed item's `level` was one of
// exactly {20,40,60,80}, a strict subset of this list, while `quality` never
// varied (always 100). NOT valid for weapon grade (e.g. Meitou) — the guide
// says weapon grade is a company-sid/material-sid pair instead, which this
// editor does not attempt to set. Quick-fill only: choosing one just writes
// the number into the Level input below, it does not submit anything.
const LEVEL_PRESETS = [
  [5, 'Prototype'], [20, 'Shoddy'], [40, 'Standard'], [60, 'High'], [80, 'Specialist'], [95, 'Masterwork'],
];

/**
 * Slot glyphs. Inline SVG, not an icon font (style guide §1): each one encodes
 * WHICH slot a row occupies, so it carries information the text would
 * otherwise have to repeat, and it makes a long inventory scannable by shape
 * instead of by reading every row. `currentColor` so they inherit tone.
 */
const ICON_PATHS = {
  head: '<path d="M3.5 9.5a4.5 4.5 0 0 1 9 0v3h-9z"/><path d="M3.5 10.5h9"/>',
  shirt: '<path d="M6 2.5 2.5 4.5 4 7l2-1.2v7.7h4V5.8L12 7l1.5-2.5L10 2.5 8 4z"/>',
  armour: '<path d="M4 3h8v5.5A4 4 0 0 1 8 13a4 4 0 0 1-4-4.5z"/><path d="M8 3v10"/>',
  legs: '<path d="M4 2.5h8l-.6 11H9.2L8 7l-1.2 6.5H4.6z"/>',
  boots: '<path d="M4.5 2.5h3v6.5l5 2v2.5h-8z"/>',
  weapon: '<path d="M13.5 2.5 7 9"/><path d="M5 9.5 6.5 11"/><path d="m2.5 13.5 2.2-.6 1.1-1.1-1.6-1.6-1.1 1.1z"/>',
  belt: '<path d="M2 6h12v4H2z"/><path d="M6.5 6v4M9.5 6v4"/>',
  backpack: '<path d="M4 5.5h8v8H4z"/><path d="M6 5.5V4a2 2 0 0 1 4 0v1.5"/><path d="M6 9.5h4"/>',
  bag: '<path d="M3 5.5h10l-1 8H4z"/><path d="M6 5.5V4.2a2 2 0 0 1 4 0v1.3"/>',
};

// Human labels for the raw on-disk `section` strings. Display only — every
// value written back is the raw key, never the label (see itemSlotSelect).
const SLOT_LABELS = {
  main: 'Carried', head: 'Head', shirt: 'Shirt', armour: 'Body armour',
  legs: 'Legs', boots: 'Boots', back: 'Back (weapon)', hip: 'Hip (weapon)',
  belt: 'Belt', backpack_attach: 'Backpack (worn)', backpack_content: 'In backpack',
};

// Which glyph stands for which `strings.section` value.
const SLOT_ICONS = {
  head: 'head', shirt: 'shirt', armour: 'armour', legs: 'legs', boots: 'boots',
  back: 'weapon', hip: 'weapon', belt: 'belt',
  backpack_attach: 'backpack', backpack_content: 'backpack', main: 'bag',
};

function icon(name, label) {
  const d = ICON_PATHS[name];
  if (!d) return '';
  return `<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor"
    stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round"
    role="img" aria-label="${esc(label || name)}">${d}</svg>`;
}

function itemSlotSelect(it) {
  // Options come straight from the server's allowedSections (services/itemSlots.js)
  // — the client never recomputes compatibility itself. Fall back to the full
  // list only if an older/unpatched API response omits the field.
  const options = it.allowedSections || ITEM_SLOTS;
  return `<select class="item-slot-select" data-sid="${esc(it.sid)}"
      data-initial="${esc(it.section || '')}" aria-label="Slot" ${dis()}>
    ${options.map((slot) => `<option value="${esc(slot)}" ${it.section === slot ? 'selected' : ''}>${esc(SLOT_LABELS[slot] || slot)}</option>`).join('')}
  </select>`;
}

/**
 * One inventory row.
 *
 * REDESIGN NOTE (previous version had a "Move" button and a "Set" button side
 * by side, plus a preset dropdown, a raw `level` box and a raw `quality` box):
 * every control here is a PENDING edit, and one "Apply" per row commits all of
 * them in a single staged write via `PUT .../inventory/:itemSid`. That is not
 * just tidier — `mutationService` treats each call as one edit against one
 * snapshot and takes one backup, so two buttons meant two gate passes and an
 * intermediate on-disk state nobody asked for.
 *
 * "Quality" is now ONE named control per kind rather than two raw numbers,
 * because the underlying field genuinely differs by kind (TODO.md 2.2(e)):
 * a weapon's recognisable grade is the company/material pair ("Meitou"), while
 * armour's is `ints.level` on a named tier ladder. The raw numbers are still
 * reachable, one click away under "More", so nothing became unreachable.
 */
function itemRow(it) {
  const glyph = SLOT_ICONS[it.section] || 'bag';
  const isWeapon = it.kindType === 2;
  const hasLevel = it.level != null;
  const grades = state.weaponGrades || [];

  const qtyCell = it.stackable
    ? `<input type="number" class="item-field w-sm" data-field="quantity" step="1" min="1"
        value="${esc(it.quantity ?? 1)}" data-initial="${esc(it.quantity ?? 1)}" aria-label="Quantity" ${dis()}>`
    : `<span class="muted">${it.quantity > 1 ? `×${esc(it.quantity)}` : '1'}</span>`;

  let qualityCell = '<span class="muted">—</span>';
  if (isWeapon && grades.length) {
    // Keyed on the grade's composite id ("<companySid>|<modelSid>"), NOT on
    // modelSid: 14 of this install's 24 model sids belong to two different
    // companies, so a modelSid-keyed <select> emits duplicate option values and
    // the server has to guess which manufacturer you meant.
    qualityCell = `<select class="item-field" data-field="gradeId" data-initial="${esc(it.gradeId || '')}" aria-label="Grade" ${dis()}>
      ${it.gradeId && !grades.some((g) => g.id === it.gradeId)
    ? `<option value="${esc(it.gradeId)}" selected>${esc(it.material || 'current')}</option>` : ''}
      ${grades.map((g) => `<option value="${esc(g.id)}" ${g.id === it.gradeId ? 'selected' : ''}>${esc(g.modelName)} — ${esc(g.companyName)}</option>`).join('')}
    </select>`;
  } else if (hasLevel) {
    const named = LEVEL_PRESETS.some(([v]) => v === it.level);
    qualityCell = `<select class="item-field" data-field="level" data-initial="${esc(it.level)}" aria-label="Quality tier" ${dis()}>
      ${named ? '' : `<option value="${esc(it.level)}" selected>Level ${esc(it.level)}</option>`}
      ${LEVEL_PRESETS.map(([v, label]) => `<option value="${esc(v)}" ${v === it.level ? 'selected' : ''}>${esc(label)} (${esc(v)})</option>`).join('')}
    </select>`;
  }

  return `<tr data-sid="${esc(it.sid)}">
    <td class="col-item"><span class="item-name">${icon(glyph, it.section)}<span>${esc(it.name)}</span></span>
      ${it.catalog?.category ? `<div class="muted">${esc(it.catalog.category)}</div>` : ''}</td>
    <td class="n shrink">${qtyCell}</td>
    <td class="shrink">${itemSlotSelect(it)}
      <div class="muted item-collision-note"></div></td>
    <td class="shrink">${qualityCell}</td>
    <td class="shrink"><span class="actions">
      <button class="btn apply-item-btn" data-sid="${esc(it.sid)}" disabled>Apply</button>
      <button class="btn btn--ghost btn--xs more-item-btn" aria-expanded="false"
        title="Raw level and quality values">More</button>
    </span></td>
  </tr>
  <tr class="item-advanced" data-advanced-for="${esc(it.sid)}" hidden>
    <td colspan="5">
      <div class="field-row">
        <label class="field">Level
          <input type="number" class="item-field w-sm" data-field="level" step="1" min="0"
            value="${esc(it.level ?? '')}" data-initial="${esc(it.level ?? '')}" ${dis()}></label>
        <label class="field">Quality
          <input type="number" class="item-field w-sm" data-field="quality" step="0.1" min="0"
            value="${esc(inputNum(it.quality))}" data-initial="${esc(inputNum(it.quality))}" ${dis()}></label>
        <span class="hint">Raw save fields. For armour, Level is the same value the tier above sets.
          ${isWeapon ? 'For weapons, Level is separate from the grade and does not follow from it.' : ''}</span>
      </div>
    </td>
  </tr>`;
}

function itemTable(items, emptyText) {
  // Deliberately NOT .table--compact: that cap suits the read-mostly body-part
  // table, but this row carries a select per concept, and under a 46rem cap the
  // item-name column collapses and wraps every name to 4 lines.
  return `<div class="table-wrap"><table class="data-table"><thead><tr>
      <th class="col-item">Item</th><th class="n">Qty</th><th>Slot</th><th>Quality</th><th></th>
    </tr></thead>
    <tbody>${items.map(itemRow).join('') || `<tr><td colspan="5" class="muted">${esc(emptyText)}</td></tr>`}</tbody>
  </table></div>`;
}

/**
 * "Add item" (TODO.md 2.2/2.3). The flow is search -> select -> configure ->
 * place, and each step only reveals the next, so the panel is one line until
 * the user actually engages with it.
 *
 * Everything kind-specific comes off the server row (`kind`, `stackable`,
 * `allowedSections`) — the client never decides what an item is or where it
 * can go. See services/itemSlots.js and TODO.md 2.2(d)/(e)/(f).
 */
function addItemSection(c, file) {
  const pick = state.addItem && state.addItem.key === keyOf(file, c.sid) ? state.addItem : null;
  return `<details class="section" ${pick ? 'open' : ''}>
    <summary>Add item</summary>
    <div class="section-body stack">
      <label class="field field--grow">Search items
        <input type="search" class="add-item-search" placeholder="e.g. katana, first aid"
          value="${esc(pick ? pick.query || '' : '')}" ${dis()}></label>
      <div class="add-item-results picker-results"></div>
      <div class="add-item-config"></div>
      <p class="hint">Adds a brand-new item record to this character's inventory. The editor cannot check whether
        this character's race can actually wear or wield it, and placing an item into an occupied body slot sends
        the current occupant back to Carried in the same write.</p>
    </div>
  </details>`;
}

/** Result rows for the item search. Rendered imperatively so typing never re-renders the page. */
function addItemResults(items, total) {
  if (!items.length) return '<p class="muted">No matching item templates.</p>';
  const more = total > items.length
    ? `<p class="hint">Showing ${esc(items.length)} of ${esc(total)} matches — narrow the search to see the rest.</p>`
    : '';
  return `<div class="table-wrap"><table class="data-table"><tbody>
    ${items.map((it) => `<tr>
      <td class="col-item">${esc(it.name)}${it.category ? `<div class="muted">${esc(it.category)}</div>` : ''}</td>
      <td class="muted">${esc(it.kind)}</td>
      <td class="shrink"><span class="actions">
        <button class="btn btn--xs pick-item-btn" data-sid="${esc(it.sid)}" ${dis()}>Select</button>
      </span></td>
    </tr>`).join('')}
  </tbody></table></div>${more}`;
}

/**
 * The configure step for a selected template. "Quality" is deliberately three
 * different controls (TODO.md 2.2(e)): armour gets the named Level ladder,
 * weapons get the grade ladder (a company/material pair, which `level` does
 * NOT determine — they are independent fields), and trade goods get neither.
 */
function addItemConfig(pick) {
  const t = pick.template;
  const isWeapon = t.type === 2;
  const isArmour = t.type === 3;

  const levelControl = (isWeapon || isArmour) ? `
    <label class="field">Level
      <input type="number" class="add-item-level w-sm" step="1" min="0" max="100"
        value="${esc(pick.level ?? '')}" placeholder="level"></label>
    <label class="field">Preset
      <select class="add-item-level-preset">
        <option value="">choose…</option>
        ${LEVEL_PRESETS.map(([v, label]) => `<option value="${esc(v)}">${esc(label)} (${esc(v)})</option>`).join('')}
      </select></label>` : '';

  const gradeControl = isWeapon ? `
    <label class="field">Grade
      <select class="add-item-grade">
        <option value="">lowest (default)</option>
        ${(state.weaponGrades || []).map((g) => `<option value="${esc(g.id)}" ${pick.gradeId === g.id ? 'selected' : ''}>${esc(g.modelName)} — ${esc(g.companyName)}</option>`).join('')}
      </select></label>` : '';

  const quantityControl = t.stackable ? `
    <label class="field">Quantity
      <input type="number" class="add-item-quantity w-sm" step="1" min="1"
        value="${esc(pick.quantity ?? 1)}"></label>` : '';

  return `<div class="stack">
    <h4 class="group-label">Selected — ${esc(t.name)} <span class="muted">(${esc(t.kind)})</span></h4>
    ${t.description ? `<p class="hint">${esc(t.description)}</p>` : ''}
    <div class="field-row">
      ${levelControl}
      ${gradeControl}
      ${quantityControl}
      <label class="field">Place in
        <select class="add-item-section">
          ${t.allowedSections.map((s) => `<option value="${esc(s)}" ${pick.section === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
        </select></label>
      <span class="actions">
        <button class="btn btn--primary add-item-btn" ${dis()}>Add to inventory</button>
        <button class="btn btn--ghost add-item-clear">Clear</button>
      </span>
    </div>
    <p class="hint add-item-collision"></p>
    ${t.slotsWidened ? '<p class="hint">This item\'s kind could not be resolved, so every slot is offered rather than'
      + ' risk hiding a legitimate one — the editor can\'t vouch for compatibility here.</p>' : ''}
    ${isWeapon ? '<p class="hint">Weapon grade is the manufacturer/material pair (this is what names a Meitou);'
      + ' Level is a separate field and does not follow from it.</p>' : ''}
  </div>`;
}

function gearCard(c, file) {
  const items = c.inventory || [];
  const bySection = new Map();
  for (const it of items) {
    if (!bySection.has(it.section)) bySection.set(it.section, []);
    bySection.get(it.section).push(it);
  }
  const equipped = EQUIP_SLOTS.flatMap((slot) => bySection.get(slot) || []);
  const carried = bySection.get('main') || [];
  const backpack = [...(bySection.get('backpack_attach') || []), ...(bySection.get('backpack_content') || [])];
  const known = new Set([...EQUIP_SLOTS, 'main', 'backpack_attach', 'backpack_content']);
  const other = items.filter((it) => !known.has(it.section));
  const anyWidened = items.some((it) => it.slotsWidened);

  return `<article class="card" data-file="${esc(file)}" data-sid="${esc(c.sid)}" data-name="${esc(c.name)}">
    <div class="card-head">
      <h3>${esc(c.name)}</h3>
      ${c.isLeader ? '<span class="badge badge--accent">leader</span>' : ''}
      <span class="muted">${esc(c.origin)}</span>
    </div>
    <p class="hint">Change anything on a row, then press Apply — slot, quantity and quality are written together in
      one edit. Slot only lists what this item's kind can actually occupy, and moving into an occupied body slot
      sends the current occupant back to Carried. The editor can't tell whether this character's race can really
      wear or wield an item (a shirt on a hiver, say) — that edit still saves, the game just won't honour
      it.${anyWidened ? ' Some items here are of an unrecognised kind, so every slot is offered rather than risk '
      + 'hiding a legitimate one; compatibility isn\'t vouched for on those.' : ''}</p>

    ${addItemSection(c, file)}

    <details class="section" open>
      <summary>Equipped (${esc(equipped.length)}/${esc(EQUIP_SLOTS.length)})</summary>
      <div class="section-body">
        ${itemTable(equipped, 'Nothing equipped.')}
      </div>
    </details>

    <details class="section">
      <summary>Carried (${esc(carried.length)})</summary>
      <div class="section-body">${itemTable(carried, 'Nothing carried.')}</div>
    </details>

    <details class="section">
      <summary>Backpack (${esc(backpack.length)})</summary>
      <div class="section-body">${itemTable(backpack, 'Empty.')}</div>
    </details>

    ${other.length ? `<details class="section">
      <summary>Other (${esc(other.length)})</summary>
      <div class="section-body">${itemTable(other, '')}</div>
    </details>` : ''}
    <pre class="receipt" hidden></pre>
  </article>`;
}

// ------------------------------------------------------------ bulk equip --

/**
 * "Equip several at once."
 *
 * The whole reason this exists rather than looping the single-item control:
 * `mutationService` treats each call as one staged edit against one snapshot and
 * takes one backup, so eight characters × six items through the per-character
 * route is 48 backups and 47 intermediate states nobody asked for. One request,
 * one edit, one receipt.
 */
function bulkPanel(picked) {
  const bulk = state.bulk || {};
  const loadout = (state.loadouts || []).find((l) => l.id === bulk.loadoutId) || (state.loadouts || [])[0];

  const chips = loadout ? `<div class="chips">
      ${loadout.items.map((it) => `<span class="chip">${esc(it.name || it.templateSid)}
        <span class="slot">${esc(SLOT_LABELS[it.section] || it.section)}</span></span>`).join('')}
    </div>
    ${loadout.missing.length ? `<p class="hint note-warn">${esc(loadout.missing.length)} item(s) in this set are not in your installed data and will be rejected.</p>` : ''}` : '';

  return `<article class="card" id="bulk-card">
    <div class="card-head">
      <h3>Equip ${esc(picked.length)} character${picked.length === 1 ? '' : 's'}</h3>
      <button class="btn btn--ghost btn--xs" id="bulk-clear">Clear selection</button>
    </div>
    <p class="hint">Everything below is written in one edit with one backup, across every squad the
      selection touches. Items go to whoever is ticked — the editor does not refuse an item on the
      grounds of race, it tells you afterwards which ones look like a bad fit.</p>

    <details class="section" open>
      <summary>Apply a loadout</summary>
      <div class="section-body stack">
        <div class="field-row">
          <label class="field field--grow">Loadout
            <select id="bulk-loadout" ${dis()}>
              ${(state.loadouts || []).map((l) => `<option value="${esc(l.id)}" ${loadout && l.id === loadout.id ? 'selected' : ''}>${esc(l.label)}</option>`).join('')}
            </select></label>
          <label class="field-check">
            <input type="checkbox" id="bulk-skip" ${bulk.skipIfSlotFilled ? 'checked' : ''}>
            Skip a slot that's already filled
          </label>
          <button class="btn btn--primary" id="bulk-apply" ${dis()}>Apply to ${esc(picked.length)}</button>
        </div>
        ${loadout ? `<p class="hint">${esc(loadout.description)}</p>${chips}` : '<p class="hint">No loadouts available.</p>'}
        <div id="bulk-preflight"></div>
      </div>
    </details>
    <pre class="receipt" id="bulk-receipt" hidden></pre>
  </article>`;
}

/**
 * What is about to happen, per character, BEFORE the write — the same
 * "name the consequence first" rule the single-item row follows with its
 * "replaces X" note, scaled to a squad. Computed client-side from data already
 * on the character; the server re-derives it all anyway.
 */
function bulkPreflight(picked, loadout) {
  if (!loadout) return '';
  const skip = !!(state.bulk || {}).skipIfSlotFilled;
  const buckets = new Set(['main', 'backpack_content']);

  return `<div class="preflight">${picked.map(({ c }) => {
    const filled = new Map((c.inventory || []).map((it) => [it.section, it]));
    const gets = [];
    const skipped = [];
    const replaces = [];
    for (const it of loadout.items) {
      const occupant = buckets.has(it.section) ? null : filled.get(it.section);
      if (skip && occupant) { skipped.push(it); continue; }
      gets.push(it);
      if (occupant) replaces.push(occupant.name);
    }
    const notes = (loadout.raceNotes || [])
      .filter((n) => c.race && (n.races || []).some((r) => c.race.name.toLowerCase().includes(r.toLowerCase())))
      .map((n) => n.note);

    return `<div class="preflight-row">
      <span class="who">${esc(c.name || '(unnamed)')}<span class="race">${esc(c.race ? c.race.name : 'unknown race')}</span></span>
      <span class="what">
        ${gets.length ? esc(gets.map((it) => it.name || it.templateSid).join(', ')) : '<em>nothing — every slot already filled</em>'}
        ${replaces.length ? `<div class="muted">replaces ${esc(replaces.join(', '))}</div>` : ''}
        ${skipped.length ? `<div class="muted">skipping ${esc(skipped.length)} already-filled slot(s)</div>` : ''}
        ${notes.map((n) => `<div class="note-warn">${esc(n)}</div>`).join('')}
      </span>
    </div>`;
  }).join('')}</div>`;
}

function renderGear() {
  const r = buildRoster();
  if (!r) return '<p>No save found.</p>';
  const { all, groups, sel } = r;
  if (!all.length) return `${savePicker()}<p>No player squad in this save.</p>`;

  // Selection survives a filter change, so validate it against the roster that
  // actually exists rather than trusting stale keys after a refresh.
  const picked = all.filter(({ c, file }) => state.selection.has(keyOf(file, c.sid)));

  const detail = picked.length
    ? bulkPanel(picked)
    : (state.selectMode
      ? `<div class="empty-state"><strong>Nothing selected</strong>Tick characters in the roster to equip them together in one edit.</div>`
      : (sel ? gearCard(sel.c, sel.file) : '<div class="empty-state"><strong>No character selected</strong>Pick someone from the roster to edit their gear.</div>'));

  return `${savePicker()}
    <section class="summary-bar">
      <span><b>Gear</b></span>
      <span class="muted">${esc(all.length)} character(s)</span>
      <span class="actions">
        <button class="btn btn--xs" id="toggle-select">${state.selectMode ? 'Done selecting' : 'Equip several at once'}</button>
      </span>
    </section>
    <div class="workspace">
      ${rosterNav(groups, { selectable: state.selectMode })}
      <div id="detail">${detail}</div>
    </div>`;
}

/**
 * Rename one character. Its own section rather than a click-to-edit `<h3>`,
 * because this writes through the mutation gate like everything else here and
 * so needs the same shape: a labelled field, one primary Apply, a receipt.
 */
function identitySection(c) {
  return `<details class="section">
    <summary>Identity</summary>
    <div class="section-body">
      <div class="field-row">
        <label class="field field--grow">Name
          <input type="text" class="char-name" maxlength="63"
            value="${esc(c.name)}" data-initial="${esc(c.name)}" ${dis()}></label>
        <button class="btn btn--primary rename-char" ${dis()}>Apply</button>
      </div>
      <p class="hint">Up to 63 bytes. The name is written to this character's state record and to their stats
        record, which is where the game keeps it for a character you have named.</p>
    </div>
  </details>`;
}

function characterCard(c, file) {
  const m = c.medical || {};
  const flags = ['dead', 'unconscious', 'coma', 'incapacitated'].filter((k) => m[k]);

  return `<article class="card" data-file="${esc(file)}" data-sid="${esc(c.sid)}" data-name="${esc(c.name)}">
    <div class="card-head">
      <h3>${esc(c.name)}</h3>
      ${c.isLeader ? '<span class="badge badge--accent">leader</span>' : ''}
      ${flags.map((f) => `<span class="badge badge--danger">${esc(f)}</span>`).join('')}
      <span class="muted">${esc(c.origin)}</span>
    </div>
    <div class="card-vitals">
      <span class="${flags.length ? 'critical' : 'ok'}">${flags.length ? 'down' : 'conscious'}</span>
      <span>blood ${num(m.blood)}</span>
      <span>bleeding ${num(m.bleeding, 2)}</span>
      <span>hunger ${num(m.hunger, 2)}</span>
    </div>
    ${identitySection(c)}
    ${c.medical ? healthSection(m) : ''}
    ${c.stats ? statsSection(c) : ''}
    ${inventorySection(c)}
    <pre class="receipt" hidden></pre>
  </article>`;
}

/** Worst body part, as a rough at-a-glance condition for the roster. */
function condition(c) {
  const parts = c.medical?.parts || [];
  if (!parts.length) return null;
  return Math.min(...parts.map((p) => p.percentOfIntact ?? 100));
}

/**
 * One pip per equip slot, filled when something occupies it. Information, not
 * decoration (style guide §1): it answers "who still needs armour?" at roster
 * density, which is exactly the question a multi-select equip raises.
 */
function slotPips(c) {
  const filled = new Set((c.inventory || []).map((it) => it.section));
  return `<span class="pips" role="img" aria-label="${esc(EQUIP_SLOTS.filter((s) => filled.has(s)).length)} of ${esc(EQUIP_SLOTS.length)} slots filled">
    ${EQUIP_SLOTS.map((s) => `<span class="pip ${filled.has(s) ? 'pip--on' : ''}" title="${esc(SLOT_LABELS[s] || s)}"></span>`).join('')}
  </span>`;
}

function rosterItem(c, file, { selectable = false } = {}) {
  const key = keyOf(file, c.sid);
  const down = ['dead', 'unconscious', 'coma', 'incapacitated'].some((k) => c.medical?.[k]);
  const cond = condition(c);
  const tone = down ? 'dot--danger' : cond != null && cond < 70 ? 'dot--warn' : '';
  // In selection mode the row is a label wrapping a checkbox rather than a
  // button — ticking someone must not also change which character the detail
  // pane is editing.
  const body = `<span class="body">
      <span class="line">
        <span class="name">${esc(c.name || '(unnamed)')}</span>
        ${c.isLeader ? '<span class="badge badge--accent">L</span>' : ''}
      </span>
      <span class="sub">
        <span class="race">${esc(c.race ? c.race.name : 'unknown race')}</span>
        ${slotPips(c)}
        ${cond != null ? meter(cond) : ''}
      </span>
    </span>`;

  if (selectable) {
    return `<li><label class="roster-item">
      <span class="lead">
        <input type="checkbox" class="roster-check" data-pick="${esc(key)}"
          ${state.selection.has(key) ? 'checked' : ''} ${dis()}>
      </span>
      ${body}
    </label></li>`;
  }
  return `<li><button class="roster-item" data-select="${esc(key)}"
      aria-current="${state.selected === key}">
    <span class="lead"><span class="dot ${tone}"></span></span>
    ${body}
  </button></li>`;
}

/*
 * Shared master–detail roster (style guide "master-detail is the rule for
 * collections"). Squad and Gear both edit the SAME characters through the
 * SAME "<file>::<sid>" selection key, so the roster build/render logic lives
 * here once instead of being copy-pasted per tab — only the detail pane
 * differs between the two.
 */
function buildRoster() {
  const s = state.status;
  if (!s) return null;

  const all = s.squads.flatMap((q) => q.characters.map((c) => ({ c, file: q.file })));
  if (!all.length) return { s, all, groups: [], sel: null };

  // Default to the first character so the editor is never empty on load.
  if (!state.selected || !all.some(({ c, file }) => keyOf(file, c.sid) === state.selected)) {
    state.selected = keyOf(all[0].file, all[0].c.sid);
  }

  const f = state.filter.trim().toLowerCase();
  const match = ({ c }) => !f || (c.name || '').toLowerCase().includes(f) || (c.origin || '').toLowerCase().includes(f);
  const shown = all.filter(match);

  const groups = s.squads
    .map((q) => ({ file: q.file, chars: q.characters.filter((c) => shown.some((x) => x.c === c)) }))
    .filter((g) => g.chars.length);

  const sel = all.find(({ c, file }) => keyOf(file, c.sid) === state.selected);

  return { s, all, groups, sel };
}

/**
 * `selectable` turns the roster into a multi-select for bulk equip. Off
 * everywhere except the Gear tab, and off there until the user asks for it, so
 * the single-character flow is untouched by default.
 */
function rosterNav(groups, { selectable = false } = {}) {
  const bar = selectable ? `<div class="roster-select-bar">
      <span>${esc(state.selection.size)} selected</span>
      <span class="actions">
        <button class="btn btn--ghost btn--xs" id="select-all">All</button>
        <button class="btn btn--ghost btn--xs" id="select-none">None</button>
      </span>
    </div>` : '';

  return `<nav class="roster" aria-label="Squad roster">
    <input type="search" class="roster-filter" id="roster-filter" placeholder="Filter by name…"
      value="${esc(state.filter)}" autocomplete="off">
    ${bar}
    ${groups.map((g) => `<div class="roster-group">${esc(g.file.replace(/\.platoon$/, ''))}</div>
      <ul class="roster-list">${g.chars.map((c) => rosterItem(c, g.file, { selectable })).join('')}</ul>`).join('')
      || '<p class="empty-state">No match.</p>'}
  </nav>`;
}

// ----------------------------------------------------------- Squad panel --

/**
 * Squad-level actions: rename the squad, add a member. Both are squad-scoped
 * rather than character-scoped, so they live in their own panel above the
 * master–detail workspace instead of being bolted onto a character card.
 *
 * Each action is its own `<details class="section">` so each can own one
 * `.btn--primary` without the two fighting over the panel's single primary slot
 * (style guide §3), and so the panel is two collapsed lines until used.
 */
function renameSquadSection(s) {
  return `<details class="section">
    <summary>Rename squad</summary>
    <div class="section-body stack">
      <div class="field-row">
        <label class="field field--grow">Name
          <input type="text" id="faction-name" maxlength="63"
            value="${esc(s.world.faction)}" data-initial="${esc(s.world.faction)}" ${dis()}></label>
        <button class="btn btn--primary" id="save-faction-name" ${dis()}>Apply</button>
      </div>
      <p class="hint">A Kenshi save has no per-squad name — the name on your squad is the player faction's,
        so this rewrites it in the game state, on every one of your squad records and on your faction record,
        together. Platoon filenames on disk keep their old prefix; that is cosmetic and the game does not
        mind. Up to 63 bytes.</p>
    </div>
  </details>`;
}

function addMemberSection(groups) {
  const races = (state.races && state.races.races) || [];
  const form = state.addMember || {};
  if (!races.length) {
    return `<details class="section">
      <summary>Add member</summary>
      <div class="section-body">
        <p class="hint">No usable race found in this save. A new member is built by cloning a living
          character of the chosen race out of this save — that is the only way to get a correct per-race
          body plan and appearance record — so there is nothing to model one on here.</p>
      </div>
    </details>`;
  }

  // Preselect the server's suggested race rather than whatever happens to sort
  // first — availableRaces() orders by donor count, defaultRace() by species.
  const raceSid = form.raceSid || (state.races.default && state.races.default.sid) || races[0].sid;
  const files = groups.map((g) => g.file);
  const recruitOptions = (state.recruits || []).map((r) => `<option value="${esc(r.id)}" ${form.recruitId === r.id ? 'selected' : ''}>${esc(r.name)} — ${esc(r.subLabel)}, ${esc(r.tierLabel)}</option>`).join('');
  const cats = state.archetypes || [];
  const main = cats.find((a) => a.id === form.archetype) || cats[0];
  const subs = main ? main.subs : [];

  return `<details class="section" ${form.open ? 'open' : ''}>
    <summary>Add member</summary>
    <div class="section-body stack">
      <div class="field-row">
        <label class="field field--grow">Ready-made recruit
          <select id="recruit-pick">
            <option value="">choose…</option>
            ${recruitOptions}
          </select></label>
        <button class="btn" id="roll-recruit">Surprise me</button>
      </div>
      <p class="hint" id="recruit-blurb">${esc(form.blurb || '')}</p>

      <div class="field-row">
        <label class="field field--grow">Name
          <input type="text" id="member-name" maxlength="63" placeholder="e.g. Ruka"
            value="${esc(form.name || '')}" ${dis()}></label>
        <label class="field">Race
          <select id="member-race" ${dis()}>
            ${races.map((r) => `<option value="${esc(r.sid)}" ${raceSid === r.sid ? 'selected' : ''}>${esc(r.name)} (${esc(r.donors)})</option>`).join('')}
          </select></label>
      </div>

      <div class="field-row">
        <label class="field">Specialisation
          <select id="member-archetype" ${dis()}>
            ${cats.map((a) => `<option value="${esc(a.id)}" ${main && a.id === main.id ? 'selected' : ''}>${esc(a.label)}</option>`).join('')}
          </select></label>
        <label class="field">Focus
          <select id="member-sub" ${dis()}>
            ${subs.map((x) => `<option value="${esc(x.id)}" ${form.sub === x.id ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}
          </select></label>
        <label class="field">Experience
          <select id="member-tier" ${dis()}>
            ${TIER_OPTIONS.map(([id, label]) => `<option value="${esc(id)}" ${(form.tier || 'capable') === id ? 'selected' : ''}>${esc(label)}</option>`).join('')}
          </select></label>
        ${files.length > 1 ? `<label class="field">Squad
          <select id="member-file" ${dis()}>
            ${files.map((f) => `<option value="${esc(f)}" ${form.file === f ? 'selected' : ''}>${esc(f.replace(/\.platoon$/, ''))}</option>`).join('')}
          </select></label>` : ''}
        <button class="btn btn--primary" id="add-member" ${dis()}>Add member</button>
      </div>

      <p class="hint">The new character is cloned from a living character of that race already in this save,
        then stripped back to nothing but their species: name, faction, leader flag, bounties, wounds and
        inventory are all discarded and the stats are rolled from the specialisation and experience above.
        The number beside each race is how many characters in this save could be used as the model.
        They arrive at the squad's current position carrying nothing — give them gear on the Gear page.
        This writes two files (the platoon and <code>quick.save</code>) in one edit.</p>
    </div>
  </details>`;
}

// Power tiers, mirroring services/recruits.js TIERS. Display only — the id is
// what gets sent, and the server rejects one it doesn't know.
const TIER_OPTIONS = [
  ['green', 'Green'], ['capable', 'Capable'], ['veteran', 'Veteran'], ['legend', 'Legend'],
];

function squadPanel(s, groups) {
  return `<section class="panel" id="squad-panel">
    <div class="panel-head"><h2>Squad</h2></div>
    ${renameSquadSection(s)}
    ${addMemberSection(groups)}
    <pre class="receipt" id="squad-receipt" hidden></pre>
  </section>`;
}

function renderSquad() {
  const r = buildRoster();
  if (!r) return '<p>No save found.</p>';
  const { s, all, groups, sel } = r;
  if (!all.length) return `${savePicker()}<p>No player squad in this save.</p>`;

  return `${savePicker()}
    <section class="summary-bar">
      <span><b>${esc(s.world.faction)}</b></span>
      <span class="muted">${esc(s.world.region)}</span>
      <span class="muted">day ${esc(s.world.day)}, ${String(s.world.hour).padStart(2, '0')}:${String(s.world.minute).padStart(2, '0')}</span>
      <span class="muted">${esc(s.world.money)} cats</span>
      <span class="muted">${esc(all.length)} member(s)</span>
    </section>
    ${squadPanel(s, groups)}
    <div class="workspace">
      ${rosterNav(groups)}
      <div id="detail">${sel ? characterCard(sel.c, sel.file) : '<div class="empty-state">Select a character to edit.</div>'}</div>
    </div>`;
}

function renderWorld() {
  const s = state.status;
  if (!s) return '<p>No save found.</p>';
  return `${savePicker()}
    <section class="panel">
      <div class="panel-head"><h2>Player money</h2></div>
      <div class="field-row">
        <label class="field">Cats
          <input type="number" id="money" min="0" value="${esc(s.world.money)}"></label>
        <button class="btn btn--primary" id="save-money" ${dis()}>Apply</button>
      </div>
      <p class="hint">Writes go through the mutation gate: automatic backup, staged edit, re-parse, hash compare, and rollback on any failure. Kenshi must be closed.</p>
      <pre class="receipt" id="receipt" hidden></pre>
    </section>

    <section class="panel">
      <div class="panel-head"><h2>World</h2></div>
      <div class="table-wrap"><table class="data-table kv"><tbody>
        ${Object.entries(s.world).map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(Array.isArray(v) ? v.map((n) => Math.round(n)).join(', ') : v)}</td></tr>`).join('')}
        <tr><th>records in quick.save</th><td>${esc(s.recordCount)}</td></tr>
        <tr><th>save directory</th><td>${esc(s.save.dir)}</td></tr>
      </tbody></table></div>
    </section>`;
}

async function renderBackups() {
  const list = await API.backups();
  return `<section class="panel">
      <div class="panel-head">
        <h2>Backups</h2>
        <button class="btn btn--primary" id="make-backup">Back up ${esc(state.save || '')}</button>
      </div>
      <div class="table-wrap"><table class="data-table">
        <thead><tr><th>Backup</th><th>Label</th><th>Created</th><th class="shrink"></th></tr></thead>
        <tbody>${list.map((b) => `<tr>
          <td>${esc(b.id)}</td><td>${esc(b.label)}</td><td class="muted">${esc(b.createdAt)}</td>
          <td class="shrink"><span class="actions actions--end">
            <button class="btn btn--xs btn--danger" data-restore="${esc(b.id)}">Restore</button>
            <button class="btn btn--xs btn--ghost" data-delete="${esc(b.id)}">Delete</button>
          </span></td>
        </tr>`).join('') || '<tr><td colspan="4" class="muted">No backups yet.</td></tr>'}</tbody>
      </table></div>
    </section>`;
}

async function render() {
  page.innerHTML = state.current === 'squad' ? renderSquad()
    : state.current === 'gear' ? renderGear()
      : state.current === 'world' ? renderWorld()
        : await renderBackups();
  wire();
}

/** Re-read the save after a successful write so the UI reflects disk. */
async function refresh() {
  state.status = await API.saveStatus(state.save);
}

/**
 * Squad-level actions (rename squad, add member).
 *
 * Both re-render on success — a rename changes the summary bar and a new member
 * changes the roster — so the receipt is stashed in state and re-attached by the
 * next pass, the same trick the character cards use.
 */
/**
 * Multi-select roster + bulk equip (Gear tab).
 *
 * The checkbox handlers deliberately do NOT call render() — re-rendering the
 * page on every tick would tear down the roster mid-click and lose scroll
 * position on a 20-character squad. Only the count, the panel heading and the
 * pre-flight need to change, and those are patched in place.
 */
/**
 * Turn a bulk-equip receipt into readable lines: who got what, what it
 * displaced, what was skipped, and any fit warning. The server reports all of
 * this per character (saveService.equipMany) precisely so the UI doesn't have
 * to guess after the fact.
 */
function bulkDetails(result) {
  const r = (result.receipts || [])[0];
  if (!r || !r.characters) return null;
  const lines = [`${r.itemsAdded} item(s) → ${r.charactersTouched} character(s) in ${r.filesTouched} file(s)`];
  for (const c of r.characters) {
    const got = c.added.map((a) => a.name).join(', ') || 'nothing';
    lines.push(`  ${c.name || '(unnamed)'} — ${got}`);
    if (c.displaced.length) lines.push(`      displaced: ${c.displaced.map((d) => d.name).join(', ')}`);
    if (c.skipped.length) lines.push(`      skipped ${c.skipped.length} filled slot(s)`);
    for (const w of c.warnings) lines.push(`      ! ${w.text}`);
  }
  return lines;
}

function wireBulkEquip() {
  const toggle = document.getElementById('toggle-select');
  if (toggle) toggle.onclick = () => {
    state.selectMode = !state.selectMode;
    if (!state.selectMode) state.selection.clear();
    render();
  };

  const checks = [...page.querySelectorAll('.roster-check')];

  /**
   * Ticking a box must NOT re-render the page. render() replaces `page.innerHTML`
   * wholesale, which detaches every checkbox mid-interaction — a user ticking
   * four names in a row would find the second click landing on a dead node. Only
   * the 0<->1 transition genuinely changes the layout (single-character card vs.
   * bulk panel); every other tick just updates a count, a heading and the
   * pre-flight list, so those are patched in place.
   */
  let syncSelectionUi = () => {};
  const onTick = (crossedZero) => {
    if (crossedZero) render(); else syncSelectionUi();
  };
  const applyTick = (el) => {
    const had = state.selection.size;
    if (el.checked) state.selection.add(el.dataset.pick); else state.selection.delete(el.dataset.pick);
    onTick((had === 0) !== (state.selection.size === 0));
  };

  const setAll = (on) => {
    const had = state.selection.size;
    for (const el of checks) {
      el.checked = on;
      if (on) state.selection.add(el.dataset.pick); else state.selection.delete(el.dataset.pick);
    }
    onTick((had === 0) !== (state.selection.size === 0));
  };
  const all = document.getElementById('select-all');
  const none = document.getElementById('select-none');
  if (all) all.onclick = () => setAll(true);
  if (none) none.onclick = () => setAll(false);

  for (const el of checks) el.onchange = () => applyTick(el);

  const card = document.getElementById('bulk-card');
  if (!card) return;
  const receipt = document.getElementById('bulk-receipt');

  if (state.panelReceipt) {
    showReceipt(receipt, state.panelReceipt.result,
      { label: state.panelReceipt.label, details: state.panelReceipt.details });
    state.panelReceipt = null;
  }

  const clear = document.getElementById('bulk-clear');
  if (clear) clear.onclick = () => { state.selection.clear(); render(); };

  const loadoutSel = document.getElementById('bulk-loadout');
  const skipBox = document.getElementById('bulk-skip');
  const preflightEl = document.getElementById('bulk-preflight');
  const applyBtn = document.getElementById('bulk-apply');

  const rosterEntries = () => {
    const r = buildRoster();
    return r ? r.all.filter(({ c, file }) => state.selection.has(keyOf(file, c.sid))) : [];
  };
  const currentLoadout = () => (state.loadouts || []).find((l) => l.id === (loadoutSel && loadoutSel.value))
    || (state.loadouts || [])[0];

  // Rendered imperatively, not through render(): changing the loadout must not
  // tear down the roster (same rule the item picker follows).
  const refreshPreflight = () => {
    if (!preflightEl) return;
    state.bulk = {
      loadoutId: loadoutSel ? loadoutSel.value : null,
      skipIfSlotFilled: !!(skipBox && skipBox.checked),
    };
    preflightEl.innerHTML = bulkPreflight(rosterEntries(), currentLoadout());
  };

  // Everything a tick changes, patched in place — see onTick() above.
  syncSelectionUi = () => {
    const n = state.selection.size;
    const count = page.querySelector('.roster-select-bar span');
    if (count) count.textContent = `${n} selected`;
    const heading = card.querySelector('h3');
    if (heading) heading.textContent = `Equip ${n} character${n === 1 ? '' : 's'}`;
    if (applyBtn) applyBtn.textContent = `Apply to ${n}`;
    refreshPreflight();
  };

  // Changing the loadout only rewrites this panel's own contents, so it is
  // rendered imperatively too rather than tearing down the roster.
  const redrawLoadout = () => {
    const lo = currentLoadout();
    const desc = card.querySelector('.section-body > .hint');
    if (desc && lo) desc.textContent = lo.description;
    const chipBox = card.querySelector('.chips');
    if (chipBox && lo) {
      chipBox.innerHTML = lo.items.map((it) => `<span class="chip">${esc(it.name || it.templateSid)}
        <span class="slot">${esc(SLOT_LABELS[it.section] || it.section)}</span></span>`).join('');
    }
    refreshPreflight();
  };
  if (loadoutSel) loadoutSel.onchange = redrawLoadout;
  if (skipBox) skipBox.onchange = refreshPreflight;
  refreshPreflight();

  if (applyBtn) applyBtn.onclick = () => {
    const picked = rosterEntries();
    const loadout = currentLoadout();
    if (!picked.length) return showReceipt(receipt, new Error('Select at least one character first.'));
    if (!loadout) return showReceipt(receipt, new Error('No loadout to apply.'));

    const targets = picked.map(({ c, file }) => ({ file, sid: c.sid }));
    const label = `${loadout.label} → ${picked.length} character(s)`;
    return runMutation(applyBtn, receipt, label,
      () => API.equipMany(state.save, {
        targets,
        loadoutId: loadout.id,
        skipIfSlotFilled: !!(skipBox && skipBox.checked),
      }),
      async (result) => {
        await refresh();
        state.panelReceipt = { result, label, details: bulkDetails(result) };
        render();
      },
      { details: bulkDetails });
  };
}

function wireSquadPanel() {
  const panel = document.getElementById('squad-panel');
  if (!panel) return;
  const receipt = document.getElementById('squad-receipt');

  if (state.panelReceipt) {
    showReceipt(receipt, state.panelReceipt.result, { label: state.panelReceipt.label });
    state.panelReceipt = null;
  }

  const run = (btn, label, fn) => runMutation(btn, receipt, label, fn, async (result) => {
    await refresh();
    await loadRaces();
    state.panelReceipt = { result, label };
    render();
  });

  const factionInput = document.getElementById('faction-name');
  const factionBtn = document.getElementById('save-faction-name');
  if (factionBtn && factionInput) factionBtn.onclick = () => {
    const value = factionInput.value.trim();
    if (!value || value === factionInput.dataset.initial) {
      return showReceipt(receipt, new Error('Enter a different squad name first.'));
    }
    return run(factionBtn, `squad renamed to ${value}`, () => API.renameFaction(state.save, value));
  };

  // ---- add member ----
  const nameInput = document.getElementById('member-name');
  if (!nameInput) return;
  const raceSel = document.getElementById('member-race');
  const archSel = document.getElementById('member-archetype');
  const subSel = document.getElementById('member-sub');
  const tierSel = document.getElementById('member-tier');
  const fileSel = document.getElementById('member-file');
  const recruitSel = document.getElementById('recruit-pick');
  const blurb = document.getElementById('recruit-blurb');
  const groups = (state.status ? state.status.squads : []).map((q) => q.file);

  // The form lives in state so the re-render after a successful add keeps the
  // last choices — adding a second recruit shouldn't mean re-picking everything.
  const form = () => {
    state.addMember = state.addMember || {};
    return state.addMember;
  };
  const remember = () => Object.assign(form(), {
    open: true,
    name: nameInput.value,
    raceSid: raceSel.value,
    archetype: archSel.value,
    sub: subSel.value,
    tier: tierSel.value,
    file: fileSel ? fileSel.value : groups[0],
  });

  const populateSubs = () => {
    const main = (state.archetypes || []).find((a) => a.id === archSel.value);
    subSel.innerHTML = (main ? main.subs : [])
      .map((x) => `<option value="${esc(x.id)}">${esc(x.label)}</option>`).join('');
  };

  archSel.onchange = () => { populateSubs(); remember(); };
  [nameInput, raceSel, subSel, tierSel, fileSel].forEach((el) => {
    if (el) el.onchange = remember;
  });
  nameInput.oninput = remember;

  // Restore the stored sub AFTER repopulating, since the option list depends on
  // the archetype (same ordering problem as the Train selects).
  const stored = state.addMember;
  if (stored && stored.sub) {
    const main = (state.archetypes || []).find((a) => a.id === archSel.value);
    if (main && main.subs.some((x) => x.id === stored.sub)) subSel.value = stored.sub;
  }

  /**
   * Apply a catalogue entry to the form. `race` on a recruit is a preference
   * matched against the races this save actually has — never a hard
   * requirement, because a save with no Shek in it must still be able to
   * recruit Ruka (as a Human, say) rather than fail.
   */
  const applyRecruit = (r) => {
    if (!r) return;
    nameInput.value = r.name;
    const races = (state.races && state.races.races) || [];
    const match = races.find((x) => x.name.toLowerCase().includes(r.race.toLowerCase()));
    if (match) raceSel.value = match.sid;
    archSel.value = r.archetype;
    populateSubs();
    subSel.value = r.sub;
    tierSel.value = r.tier;
    blurb.textContent = match
      ? r.blurb
      : `${r.blurb} (no ${r.race} in this save — using ${raceSel.selectedOptions[0]?.textContent || 'the selected race'}.)`;
    Object.assign(form(), { recruitId: r.id, blurb: blurb.textContent });
    remember();
  };

  if (recruitSel) recruitSel.onchange = () => {
    applyRecruit((state.recruits || []).find((r) => r.id === recruitSel.value));
  };
  const rollBtn = document.getElementById('roll-recruit');
  if (rollBtn) rollBtn.onclick = () => {
    const list = state.recruits || [];
    if (!list.length) return;
    const r = list[Math.floor(Math.random() * list.length)];
    if (recruitSel) recruitSel.value = r.id;
    applyRecruit(r);
  };

  const addBtn = document.getElementById('add-member');
  if (addBtn) addBtn.onclick = () => {
    const name = nameInput.value.trim();
    if (!name) return showReceipt(receipt, new Error('Give the new member a name first.'));
    const file = fileSel ? fileSel.value : groups[0];
    if (!file) return showReceipt(receipt, new Error('This save has no player squad to add to.'));
    remember();
    return run(addBtn, `${name} joined`, () => API.addSquadMember(state.save, file, {
      name,
      raceSid: raceSel.value,
      archetype: archSel.value,
      sub: subSel.value,
      tier: tierSel.value,
    }));
  };
}

function wire() {
  const sel = document.getElementById('save-select');
  if (sel) sel.onchange = async () => {
    state.save = sel.value;
    state.addMember = null; // race sids and platoon files are per-save
    await refresh();
    await loadRaces();
    render();
  };

  wireSquadPanel();
  wireBulkEquip();

  const money = document.getElementById('save-money');
  if (money) money.onclick = () => runMutation(
    money, document.getElementById('receipt'), 'money set',
    () => API.setMoney(state.save, Number(document.getElementById('money').value)),
    refresh,
  );

  page.querySelectorAll('[data-select]').forEach((b) => {
    b.onclick = () => { state.selected = b.dataset.select; render(); };
  });

  const filter = document.getElementById('roster-filter');
  if (filter) filter.oninput = () => {
    state.filter = filter.value;
    render();
    // Re-focus the filter and restore the caret — render() replaces the node.
    const next = document.getElementById('roster-filter');
    if (next) { next.focus(); next.setSelectionRange(next.value.length, next.value.length); }
  };

  page.querySelectorAll('.card').forEach((card) => {
    const receipt = card.querySelector('.receipt');
    const { file, sid } = card.dataset;

    // Re-attach the receipt stashed by a mutation that re-rendered this card.
    const pending = state.pendingReceipt;
    if (pending && pending.key === keyOf(file, sid)) {
      showReceipt(receipt, pending.result, { label: pending.label });
      state.pendingReceipt = null;
    }
    // Medical edits change what the card renders, so they re-render; stat edits
    // don't move anything, so they only refresh state.
    // A re-render replaces the card's HTML — including the .receipt element the
    // result was just written into — so the confirmation would vanish the
    // instant the edit succeeded, making a working mutation look like a no-op.
    // Stash it and let the next wire() re-attach it to the fresh element.
    const run = (btn, label, fn, rerender = false) => runMutation(
      btn, receipt, label, fn, async (result) => {
        await refresh();
        if (rerender) {
          state.pendingReceipt = { key: keyOf(file, sid), result, label };
          render();
        }
      },
    );

    const renameBtn = card.querySelector('.rename-char');
    if (renameBtn) renameBtn.onclick = () => {
      const input = card.querySelector('.char-name');
      const value = input.value.trim();
      if (!value || value === input.dataset.initial) {
        return showReceipt(receipt, new Error('Enter a different name first.'));
      }
      // Re-renders: the name shows in the card head, the roster and the filter.
      return run(renameBtn, `renamed to ${value}`, () => API.renameCharacter(state.save, file, sid, value), true);
    };

    const statsBtn = card.querySelector('.save-stats');
    if (statsBtn) statsBtn.onclick = () => {
      const changed = {};
      card.querySelectorAll('.stat-input').forEach((input) => {
        const value = Number(input.value);
        if (input.value !== input.dataset.initial && !Number.isNaN(value)) changed[input.dataset.stat] = value;
      });
      if (Object.keys(changed).length === 0) return showReceipt(receipt, new Error('No stats changed.'));
      return run(statsBtn, `${Object.keys(changed).length} stat(s) set`,
        () => API.setStats(state.save, file, sid, changed));
    };

    card.querySelectorAll('.heal-part-btn').forEach((b) => {
      b.onclick = () => {
        const row = card.querySelector(`tr[data-part="${b.dataset.part}"]`);
        const flesh = Number(row.querySelector('.flesh-input').value);
        return run(b, 'flesh set', () => API.healPart(state.save, file, sid, b.dataset.part, { flesh }), true);
      };
    });

    card.querySelectorAll('.full-heal-btn').forEach((b) => {
      b.onclick = () => run(b, 'part healed',
        () => API.healPart(state.save, file, sid, b.dataset.part, { flesh: 'full' }), true);
    });

    const hunger = card.querySelector('.save-hunger');
    if (hunger) hunger.onclick = () => {
      const body = {};
      card.querySelectorAll('.hunger-input').forEach((input) => {
        const value = Number(input.value);
        if (input.value !== input.dataset.initial && !Number.isNaN(value)) body[input.dataset.field] = value;
      });
      if (Object.keys(body).length === 0) return showReceipt(receipt, new Error('No hunger change.'));
      return run(hunger, 'hunger set', () => API.setHunger(state.save, file, sid, body), true);
    };

    const revive = card.querySelector('.revive-btn');
    if (revive) revive.onclick = () => {
      if (!confirm('Revive this character? Clears death, KO and coma flags and raises any lethally low flesh in the same write.')) return undefined;
      return run(revive, 'revived', () => API.revive(state.save, file, sid, {}), true);
    };

    const limbs = card.querySelector('.restore-limbs-btn');
    if (limbs) limbs.onclick = () => {
      if (!confirm('Restore limbs? This deletes the raw "limbs" flag. Individual lost-limb flesh values are NOT restored by this action.')) return undefined;
      return run(limbs, 'limbs flag cleared', () => API.restoreLimbs(state.save, file, sid), true);
    };

    // Gear: "More" reveals the raw level/quality fields for one row.
    card.querySelectorAll('.more-item-btn').forEach((b) => {
      b.onclick = () => {
        const itemSid = b.closest('tr').dataset.sid;
        const adv = card.querySelector(`tr[data-advanced-for="${CSS.escape(itemSid)}"]`);
        const open = adv.hidden;
        adv.hidden = !open;
        b.setAttribute('aria-expanded', String(open));
      };
    });

    // Gear: every control in a row is a PENDING edit; one Apply per row sends
    // them together. The button stays disabled until something actually
    // differs from what's on disk, so "Apply" never means "write the same
    // values back" (which the mutation gate would reject as a no-op anyway,
    // reporting a confusing error for what looked like a valid action).
    const gearChar = findCharacter(file, sid);

    const collectPatch = (row) => {
      const patch = {};
      // A row's advanced `level` input and its quality <select> both target
      // `level`. Later wins, and the advanced input is later in the DOM, so an
      // explicitly typed raw value takes precedence over the tier dropdown.
      const itemSid = row.dataset.sid;
      const fields = [
        ...row.querySelectorAll('.item-field'),
        ...card.querySelectorAll(`tr[data-advanced-for="${CSS.escape(itemSid)}"] .item-field`),
      ];
      for (const el of fields) {
        if (el.value === '' || el.value === el.dataset.initial) continue;
        patch[el.dataset.field] = el.dataset.field === 'gradeId' ? el.value : Number(el.value);
      }
      const slot = row.querySelector('.item-slot-select');
      if (slot && slot.value !== slot.dataset.initial) patch.section = slot.value;
      return patch;
    };

    const refreshRowState = (row) => {
      const applyBtn = row.querySelector('.apply-item-btn');
      if (!applyBtn) return;
      const changed = Object.keys(collectPatch(row)).length > 0;
      applyBtn.disabled = !changed || !canWrite();

      // Name what a slot change will displace, before the write happens.
      const slot = row.querySelector('.item-slot-select');
      const note = row.querySelector('.item-collision-note');
      if (slot && note) {
        const target = slot.value;
        const isBucket = target === 'main' || target === 'backpack_content';
        const occupant = !isBucket && gearChar
          ? (gearChar.inventory || []).find((it) => it.section === target && it.sid !== row.dataset.sid)
          : null;
        note.textContent = occupant ? `replaces ${occupant.name}` : '';
      }
    };

    card.querySelectorAll('tbody tr[data-sid]').forEach((row) => {
      const itemSid = row.dataset.sid;
      const controls = [
        ...row.querySelectorAll('.item-field, .item-slot-select'),
        ...card.querySelectorAll(`tr[data-advanced-for="${CSS.escape(itemSid)}"] .item-field`),
      ];
      controls.forEach((el) => {
        el.oninput = () => refreshRowState(row);
        el.onchange = () => refreshRowState(row);
      });
      refreshRowState(row);

      const applyBtn = row.querySelector('.apply-item-btn');
      if (applyBtn) applyBtn.onclick = () => {
        const patch = collectPatch(row);
        if (Object.keys(patch).length === 0) return showReceipt(receipt, new Error('Nothing changed on this row.'));
        return run(applyBtn, 'item updated', () => API.updateItem(state.save, file, sid, itemSid, patch), true);
      };
    });

    // ---------------------------------------------------------- Add item --
    // Search results and the configure step are rendered imperatively rather
    // than through render(): a full re-render on every keystroke would tear
    // down the search box mid-type. Only the final write re-renders, because
    // that genuinely changes what the item tables show.
    const addSearch = card.querySelector('.add-item-search');
    if (addSearch) {
      const resultsEl = card.querySelector('.add-item-results');
      const configEl = card.querySelector('.add-item-config');
      const cardKey = keyOf(file, sid);
      const pickOf = () => (state.addItem && state.addItem.key === cardKey ? state.addItem : null);

      const wireConfig = () => {
        const pick = pickOf();
        if (!pick || !pick.template) { configEl.innerHTML = ''; return; }
        configEl.innerHTML = addItemConfig(pick);

        const levelInput = configEl.querySelector('.add-item-level');
        const presetSel = configEl.querySelector('.add-item-level-preset');
        const gradeSel = configEl.querySelector('.add-item-grade');
        const qtyInput = configEl.querySelector('.add-item-quantity');
        const sectionSel = configEl.querySelector('.add-item-section');
        const collision = configEl.querySelector('.add-item-collision');

        // Preset is a quick-fill for the Level box, exactly like the per-row
        // preset in the item table — it writes a number, it never submits.
        if (presetSel) presetSel.onchange = () => {
          if (!presetSel.value) return;
          levelInput.value = presetSel.value;
          pick.level = Number(presetSel.value);
          presetSel.value = '';
        };
        if (levelInput) levelInput.oninput = () => {
          pick.level = levelInput.value === '' ? undefined : Number(levelInput.value);
        };
        if (gradeSel) gradeSel.onchange = () => { pick.gradeId = gradeSel.value || undefined; };
        if (qtyInput) qtyInput.oninput = () => { pick.quantity = Number(qtyInput.value); };

        // Name what this placement will displace BEFORE the write, same as the
        // per-row "replaces X" note on the move control.
        const updateCollision = () => {
          pick.section = sectionSel.value;
          const target = sectionSel.value;
          const isBucket = target === 'main' || target === 'backpack_content';
          const ch = findCharacter(file, sid);
          const occupant = !isBucket && ch
            ? (ch.inventory || []).find((it) => it.section === target)
            : null;
          collision.textContent = occupant ? `Replaces ${occupant.name}, which moves back to Carried (main).` : '';
        };
        sectionSel.onchange = updateCollision;
        updateCollision();

        configEl.querySelector('.add-item-clear').onclick = () => {
          state.addItem = { key: cardKey, query: pick.query, results: pick.results, total: pick.total };
          configEl.innerHTML = '';
        };

        const addBtn = configEl.querySelector('.add-item-btn');
        addBtn.onclick = () => {
          const body = { templateSid: pick.template.sid, section: sectionSel.value };
          if (levelInput && levelInput.value !== '') body.level = Number(levelInput.value);
          if (gradeSel && gradeSel.value) body.gradeId = gradeSel.value;
          if (qtyInput && qtyInput.value !== '') body.quantity = Number(qtyInput.value);
          return run(addBtn, `added ${pick.template.name}`,
            () => API.addItem(state.save, file, sid, body), true);
        };
      };

      const wireResults = () => {
        const pick = pickOf();
        if (!pick || !pick.results) { resultsEl.innerHTML = ''; return; }
        resultsEl.innerHTML = addItemResults(pick.results, pick.total);
        resultsEl.querySelectorAll('.pick-item-btn').forEach((b) => {
          b.onclick = async () => {
            const template = pick.results.find((r) => r.sid === b.dataset.sid);
            if (!template) return;
            // The grade ladder is only meaningful for weapons, so it is fetched
            // the first time one is actually selected rather than at boot.
            if (template.type === 2 && !state.weaponGrades) {
              try {
                state.weaponGrades = (await API.weaponGrades()).grades;
              } catch {
                state.weaponGrades = []; // ladder is optional; the server defaults the grade
              }
            }
            Object.assign(pick, {
              template,
              section: template.allowedSections[0],
              quantity: template.stackable ? 1 : undefined,
              level: undefined,
              gradeId: undefined,
            });
            wireConfig();
          };
        });
      };

      const search = async (query) => {
        const pick = pickOf() || { key: cardKey };
        state.addItem = pick;
        pick.query = query;
        try {
          const res = await API.items(query);
          // A slower earlier request must not overwrite a newer query's results.
          if (pick.query !== query) return;
          pick.results = res.items;
          pick.total = res.total;
        } catch (err) {
          pick.results = [];
          pick.total = 0;
          showReceipt(receipt, err);
        }
        wireResults();
      };

      let searchTimer = null;
      addSearch.oninput = () => {
        clearTimeout(searchTimer);
        const q = addSearch.value;
        searchTimer = setTimeout(() => search(q), 180);
      };
      // Opening the panel with nothing typed yet lists the catalogue, so the
      // control is explorable rather than a blank box that only rewards guesses.
      const addDetails = addSearch.closest('details');
      addDetails.ontoggle = () => {
        if (addDetails.open && !(pickOf() || {}).results) search('');
      };

      wireResults();
      wireConfig();
    }

    const trainMain = card.querySelector('.train-main');
    const trainSub = card.querySelector('.train-sub');
    if (trainMain && trainSub) {
      const populateSubs = () => {
        const m = state.archetypes.find((a) => a.id === trainMain.value);
        trainSub.innerHTML = (m ? m.subs : [])
          .map((s) => `<option value="${esc(s.id)}">${esc(s.label)}</option>`).join('');
      };
      const remember = () => {
        state.trainChoice = { key: keyOf(file, sid), archetype: trainMain.value, sub: trainSub.value };
      };
      trainMain.onchange = () => { populateSubs(); remember(); };
      trainSub.onchange = remember;

      // Training re-renders the card, which would otherwise snap the selects
      // back to the first archetype — leaving the form contradicting the
      // receipt that just said what was applied.
      const choice = state.trainChoice;
      if (choice && choice.key === keyOf(file, sid)) {
        trainMain.value = choice.archetype;
        populateSubs();
        trainSub.value = choice.sub;
      }
    }

    const trainBtn = card.querySelector('.train-btn');
    if (trainBtn) trainBtn.onclick = () => {
      const archetype = trainMain.value;
      const sub = trainSub.value;
      const raiseOnly = card.querySelector('.train-raise-only').checked;
      const mode = raiseOnly ? 'raise' : 'set';
      const main = state.archetypes.find((a) => a.id === archetype);
      const subEntry = main?.subs.find((s) => s.id === sub);
      const lowerNote = raiseOnly ? 'it will never lower an existing stat' : 'it CAN lower existing stats back down';
      // The character object only exists in the render pass; wire() sees the
      // card element, so identity comes off the dataset (see `data-name`).
      if (!confirm(`Train ${card.dataset.name || 'this character'} as ${main?.label || archetype} / ${subEntry?.label || sub}? `
        + `This rewrites attributes and dozens of skills — ${lowerNote}.`)) return undefined;
      return run(trainBtn, 'trained', () => API.trainCharacter(state.save, file, sid, { archetype, sub, mode }), true);
    };
  });

  const mk = document.getElementById('make-backup');
  if (mk) mk.onclick = async () => { await API.createBackup(state.save, 'manual'); render(); };

  page.querySelectorAll('[data-restore]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm(`Restore ${b.dataset.restore}? This overwrites the live save directory.`)) return;
      await API.restoreBackup(b.dataset.restore);
      boot();
    };
  });
  page.querySelectorAll('[data-delete]').forEach((b) => {
    b.onclick = async () => { await API.deleteBackup(b.dataset.delete); render(); };
  });
}

document.querySelectorAll('.tabs button').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    state.current = b.dataset.page;
    render();
  };
});

boot().catch((err) => { page.innerHTML = `<p class="critical">${esc(err.message)}</p>`; });
