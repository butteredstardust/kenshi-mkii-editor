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
  pendingReceipt: null, // survives the re-render a mutation triggers (see wire())
  trainChoice: null, // { key, archetype, sub } — likewise survives the re-render
  // "Add item" picker state, keyed like trainChoice so it survives the
  // re-render a successful add triggers — otherwise adding one of something
  // would clear the search and force the user to start over to add a second.
  // { key, query, results, total, template, level, materialSid, quantity, section }
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
  render();
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

function itemSlotSelect(it) {
  // Options come straight from the server's allowedSections (services/itemSlots.js)
  // — the client never recomputes compatibility itself. Fall back to the full
  // list only if an older/unpatched API response omits the field.
  const options = it.allowedSections || ITEM_SLOTS;
  return `<select class="item-slot-select" data-sid="${esc(it.sid)}">
    ${options.map((slot) => `<option value="${esc(slot)}" ${it.section === slot ? 'selected' : ''}>${esc(slot)}</option>`).join('')}
  </select>`;
}

function itemRow(it) {
  const hasQuality = it.level != null || it.quality != null;
  return `<tr data-sid="${esc(it.sid)}">
    <td class="col-item">${esc(it.name)}${it.catalog?.category ? `<div class="muted">${esc(it.catalog.category)}</div>` : ''}</td>
    <td class="n">${it.quantity > 1 ? `×${esc(it.quantity)}` : ''}</td>
    <td class="muted">${esc(it.section || '—')}</td>
    <td class="shrink">${hasQuality ? `
      <select class="item-level-preset">
        <option value="">preset…</option>
        ${LEVEL_PRESETS.map(([v, label]) => `<option value="${esc(v)}">${esc(label)} (${esc(v)})</option>`).join('')}
      </select>
      <input type="number" class="item-level-input w-sm" step="1" min="0"
        value="${esc(it.level ?? '')}" placeholder="level">
      <input type="number" class="item-quality-input w-sm" step="0.1" min="0"
        value="${esc(inputNum(it.quality))}" placeholder="quality">
    ` : '<span class="muted">—</span>'}</td>
    <td class="shrink">${itemSlotSelect(it)}
      <span class="muted item-collision-note"></span></td>
    <td class="shrink"><span class="actions">
      <button class="btn move-item-btn" data-sid="${esc(it.sid)}" ${dis()}>Move</button>
      ${hasQuality ? `<button class="btn set-quality-btn" data-sid="${esc(it.sid)}" ${dis()}>Set</button>` : ''}
    </span></td>
  </tr>`;
}

function itemTable(items, emptyText) {
  // Deliberately NOT .table--compact: that cap suits the read-mostly body-part
  // table, but this row carries two selects and two number inputs, and under a
  // 46rem cap the item-name column collapses and wraps every name to 4 lines.
  return `<div class="table-wrap"><table class="data-table"><thead><tr>
      <th class="col-item">Item</th><th class="n">Qty</th><th>Slot</th><th>Level / quality</th><th>Move to</th><th></th>
    </tr></thead>
    <tbody>${items.map(itemRow).join('') || `<tr><td colspan="6" class="muted">${esc(emptyText)}</td></tr>`}</tbody>
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
        ${(state.weaponGrades || []).map((g) => `<option value="${esc(g.modelSid)}" ${pick.materialSid === g.modelSid ? 'selected' : ''}>${esc(g.modelName)} — ${esc(g.companyName)}</option>`).join('')}
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
    <p class="hint">"Move to" only offers slots this item's kind is actually compatible with (weapons can't go in a
      body-armour slot, and vice versa). Moving into a body/equip slot already occupied replaces the current
      occupant, which is sent back to Carried (main) in the same write. The editor cannot check whether this
      character's race can actually wear/wield an item (e.g. a shirt on a hiver) — the save edit succeeds either
      way even if the game won't honour it.${anyWidened ? ' Some items below are of an unrecognised kind, so every '
      + 'slot is offered for them rather than risk hiding a legitimate one — the editor can\'t vouch for '
      + 'compatibility on those.' : ''}</p>

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

function renderGear() {
  const r = buildRoster();
  if (!r) return '<p>No save found.</p>';
  const { all, groups, sel } = r;
  if (!all.length) return `${savePicker()}<p>No player squad in this save.</p>`;

  return `${savePicker()}
    <div class="workspace">
      ${rosterNav(groups)}
      <div id="detail">${sel ? gearCard(sel.c, sel.file) : '<div class="empty-state">Select a character to edit.</div>'}</div>
    </div>`;
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

function rosterItem(c, file) {
  const key = keyOf(file, c.sid);
  const down = ['dead', 'unconscious', 'coma', 'incapacitated'].some((k) => c.medical?.[k]);
  const cond = condition(c);
  const tone = down ? 'dot--danger' : cond != null && cond < 70 ? 'dot--warn' : '';
  return `<li><button class="roster-item" data-select="${esc(key)}"
      aria-current="${state.selected === key}">
    <span class="dot ${tone}"></span>
    <span class="name">${esc(c.name || '(unnamed)')}</span>
    ${c.isLeader ? '<span class="badge badge--accent">L</span>' : ''}
    ${cond != null ? meter(cond) : ''}
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

function rosterNav(groups) {
  return `<nav class="roster" aria-label="Squad roster">
    <input type="search" class="roster-filter" id="roster-filter" placeholder="Filter by name…"
      value="${esc(state.filter)}" autocomplete="off">
    ${groups.map((g) => `<div class="roster-group">${esc(g.file.replace(/\.platoon$/, ''))}</div>
      <ul class="roster-list">${g.chars.map((c) => rosterItem(c, g.file)).join('')}</ul>`).join('')
      || '<p class="empty-state">No match.</p>'}
  </nav>`;
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

function wire() {
  const sel = document.getElementById('save-select');
  if (sel) sel.onchange = async () => {
    state.save = sel.value;
    await refresh();
    render();
  };

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

    // Gear: quick-fill Level presets (writes the number in, does not submit).
    card.querySelectorAll('.item-level-preset').forEach((presetSel) => {
      presetSel.onchange = () => {
        if (!presetSel.value) return;
        const row = presetSel.closest('tr');
        row.querySelector('.item-level-input').value = presetSel.value;
        presetSel.value = '';
      };
    });

    // Gear: name what a slot move will displace, before the write happens.
    const gearChar = findCharacter(file, sid);
    card.querySelectorAll('.item-slot-select').forEach((select) => {
      const updateNote = () => {
        const note = select.parentElement.querySelector('.item-collision-note');
        if (!note) return;
        const target = select.value;
        const isBucket = target === 'main' || target === 'backpack_content';
        const occupant = !isBucket && gearChar
          ? (gearChar.inventory || []).find((it) => it.section === target && it.sid !== select.dataset.sid)
          : null;
        note.textContent = occupant ? `replaces ${occupant.name}` : '';
      };
      select.onchange = updateNote;
      updateNote();
    });

    card.querySelectorAll('.move-item-btn').forEach((b) => {
      b.onclick = () => {
        const row = card.querySelector(`tr[data-sid="${b.dataset.sid}"]`);
        const section = row.querySelector('.item-slot-select').value;
        return run(b, 'item moved', () => API.setItemSection(state.save, file, sid, b.dataset.sid, section), true);
      };
    });

    card.querySelectorAll('.set-quality-btn').forEach((b) => {
      b.onclick = () => {
        const row = card.querySelector(`tr[data-sid="${b.dataset.sid}"]`);
        const levelInput = row.querySelector('.item-level-input');
        const qualityInput = row.querySelector('.item-quality-input');
        const body = {};
        if (levelInput && levelInput.value !== '') body.level = Number(levelInput.value);
        if (qualityInput && qualityInput.value !== '') body.quality = Number(qualityInput.value);
        if (Object.keys(body).length === 0) return showReceipt(receipt, new Error('No level/quality value entered.'));
        return run(b, 'item quality set', () => API.setItemQuality(state.save, file, sid, b.dataset.sid, body), true);
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
        if (gradeSel) gradeSel.onchange = () => { pick.materialSid = gradeSel.value || undefined; };
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
          if (gradeSel && gradeSel.value) body.materialSid = gradeSel.value;
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
              materialSid: undefined,
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
