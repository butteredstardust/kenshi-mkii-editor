import { API } from '../api-client.mjs';
import { esc, plural, showReceipt, runMutation } from '../core.mjs';
import { page, state, keyOf, canWrite, dis } from '../state.mjs';
import { sectionSummary } from '../icons.mjs';
import { EQUIP_SLOTS, SLOT_LABELS, isWorn, wearFirst } from '../slots.mjs';
import {
  LEVEL_PRESETS, defaultGradeId, defaultLevelFor, gradeOptions, tierLabel,
} from '../grades.mjs';
import {
  itemTable, addItemSection, addItemResults, packBlock, raceFitWarnings,
} from '../items.mjs';
import { render, refresh, savePicker } from '../nav.mjs';
import { buildRoster, rosterNav, rosterRaces } from './roster.mjs';

export function gearCard(c, file) {
  const items = c.inventory || [];
  const bySection = new Map();
  for (const it of items) {
    if (!bySection.has(it.section)) bySection.set(it.section, []);
    bySection.get(it.section).push(it);
  }
  const equipped = EQUIP_SLOTS.flatMap((slot) => bySection.get(slot) || []);
  const carried = bySection.get('main') || [];
  const backpack = [...(bySection.get('backpack_attach') || []), ...(bySection.get('backpack_content') || [])];
  // A worn pack keeps its contents in its own inventory record, one hop past
  // the character's — see saveService.packContentsOf(). `it.contents` is that
  // hop already resolved; before it existed this section could only ever show
  // the empty pack.
  const packs = backpack.filter((it) => it.section === 'backpack_attach');
  const packCount = backpack.length + packs.reduce((n, p) => n + p.contents.length, 0);
  const known = new Set([...EQUIP_SLOTS, 'main', 'backpack_attach', 'backpack_content']);
  const other = items.filter((it) => !known.has(it.section));
  const anyWidened = items.some((it) => it.slotsWidened);

  return `<article class="card" data-file="${esc(file)}" data-sid="${esc(c.sid)}" data-name="${esc(c.name)}">
    <div class="card-head">
      <h3>${esc(c.name)}</h3>
      ${c.isLeader ? '<span class="badge badge--accent">leader</span>' : ''}
      <span class="muted">${esc(c.origin)}</span>
    </div>
    <p class="hint">Change a row, then Apply — everything on it is written in one edit. Filling an occupied slot
      sends the current occupant to Carried. Race fit is not checked.${anyWidened ? ' Some items here are of an '
      + 'unrecognised kind, so every slot is offered.' : ''}</p>

    ${addItemSection(c, file)}

    <details class="section" open>
      ${sectionSummary('armour', `Equipped (${esc(equipped.length)}/${esc(EQUIP_SLOTS.length)})`)}
      <div class="section-body">
        ${itemTable(equipped, 'Nothing equipped.')}
      </div>
    </details>

    <details class="section">
      ${sectionSummary('bag', `Carried (${esc(carried.length)})`)}
      <div class="section-body">${itemTable(carried, 'Nothing carried.')}</div>
    </details>

    <details class="section">
      ${sectionSummary('backpack', `Backpack (${esc(packCount)})`)}
      <div class="section-body stack">${packs.length
    ? packs.map(packBlock).join('')
    : itemTable(backpack, 'No backpack worn.')}</div>
    </details>

    ${other.length ? `<details class="section">
      ${sectionSummary('list', `Other (${esc(other.length)})`)}
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
// Loadouts grouped by their leading tag. 29 kits in one flat <select> is a
// wall; grouped by role it reads as a menu. Order is deliberate — heaviest
// first, oddments last — and anything untagged still appears, under "Other".
const LOADOUT_GROUPS = [
  ['heavy', 'Heavy armour'], ['light', 'Light armour'], ['ranged', 'Ranged'],
  ['blunt', 'Blunt / non-lethal'], ['support', 'Support'], ['trade', 'Trade & hauling'],
  ['travel', 'Travel'], ['starter', 'Starter kit'], ['weapons', 'Weapons only'],
  ['pack', 'Packs'],
];

function loadoutGroups() {
  const rows = state.loadouts || [];
  const taken = new Set();
  const out = [];
  for (const [tag, label] of LOADOUT_GROUPS) {
    const group = rows.filter((l) => !taken.has(l.id) && (l.tags || []).includes(tag));
    for (const l of group) taken.add(l.id);
    if (group.length) out.push([label, group]);
  }
  const rest = rows.filter((l) => !taken.has(l.id));
  if (rest.length) out.push(['Other', rest]);
  return out;
}

function bulkPanel(picked) {
  const bulk = state.bulk || {};
  const loadout = (state.loadouts || []).find((l) => l.id === bulk.loadoutId) || (state.loadouts || [])[0];

  const chips = loadout ? `<div class="chips">
      ${loadout.items.map((it) => `<span class="chip">${esc(it.name || it.templateSid)}
        <span class="slot">${esc(SLOT_LABELS[it.section] || it.section)}</span></span>`).join('')}
    </div>
    ${loadout.missing.length ? `<p class="hint note-warn">${esc(plural(loadout.missing.length, 'item'))} in this set are not in your installed data and will be rejected.</p>` : ''}` : '';

  return `<article class="card" id="bulk-card">
    <div class="card-head">
      <h3>Equip ${esc(picked.length)} character${picked.length === 1 ? '' : 's'}</h3>
      <button class="btn btn--ghost btn--xs" id="bulk-clear">Clear selection</button>
    </div>
    <p class="hint">One edit, one backup. Poor race fits are reported, never blocked.</p>

    <details class="section" ${state.bulkItem && state.bulkItem.template ? '' : 'open'}>
      ${sectionSummary('armour', 'Apply a loadout')}
      <div class="section-body stack">
        <div class="field-row">
          <label class="field field--grow">Loadout
            <select id="bulk-loadout" ${dis()}>
              ${loadoutGroups().map(([group, rows]) => `<optgroup label="${esc(group)}">
                ${rows.map((l) => `<option value="${esc(l.id)}" ${loadout && l.id === loadout.id ? 'selected' : ''}>${esc(l.label)}</option>`).join('')}
              </optgroup>`).join('')}
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

    ${bulkItemSection()}
    ${bulkRegradeSection()}
    ${bulkUnequipSection(picked)}
    <pre class="receipt" id="bulk-receipt" hidden></pre>
  </article>`;
}

/**
 * "Upgrade what they're already wearing."
 *
 * The other two halves of this panel both ADD an item. This one adds nothing:
 * it re-grades gear the selection already owns, which is the thing a player
 * asks for once the squad is kitted out ("everyone's armour to Masterwork,
 * every weapon to Edge Type 5"). Doing it through the Gear row's Apply is one
 * staged edit — and one backup — per item, on a squad of ten that is a hundred.
 *
 * Two controls, and only two, because those are the two things a player names:
 * armour's tier ("Masterwork") is `ints.level` on a named ladder, and a
 * weapon's grade ("Meitou") is the company/material pair. There used to be a
 * third — a raw Weapon Level box — and it was pure friction: the number has no
 * name in the game's own vocabulary, and asking for it on top of the grade made
 * people guess. The server now takes the level from the grade's own ladder rank
 * (saveService.regradeMany -> itemFactory.defaultLevelForGrade), so choosing
 * "Meitou" here really does mean the whole thing.
 */
function bulkRegradeSection() {
  const g = state.bulkGear || {};

  return `<details class="section" id="bulk-regrade-section">
    ${sectionSummary('stats', 'Set the quality of what they already have')}
    <div class="section-body stack">
      <div class="field-row">
        <label class="field">Armour tier
          <select id="bulk-regrade-armour" data-nofilter ${dis()}>
            <option value="">leave alone</option>
            ${LEVEL_PRESETS.map(([v, label]) => `<option value="${esc(v)}" ${g.armourLevel === v ? 'selected' : ''}>${esc(label)} (${esc(v)})</option>`).join('')}
          </select></label>
        <label class="field">Weapon grade
          <select id="bulk-regrade-grade" ${dis()}>
            <option value="">leave alone</option>
            ${gradeOptions(g.gradeId)}
          </select></label>
      </div>
      <div class="field-row">
        <label class="field-check">
          <input type="checkbox" id="bulk-regrade-carried" ${g.includeCarried ? 'checked' : ''}>
          Include carried items
        </label>
        <label class="field-check">
          <input type="checkbox" id="bulk-regrade-pack" ${g.includePackContents ? 'checked' : ''}>
          Include backpack contents
        </label>
        <button class="btn btn--primary" id="bulk-regrade-apply" ${dis()} disabled>Apply</button>
      </div>
      <p class="hint">Only what they are wearing, unless you widen it above. Nothing is added, removed or moved —
        a grade rewrites the weapon's manufacturer, material and level together; an armour tier rewrites its level.</p>
      <div id="bulk-regrade-preflight"></div>
    </div>
  </details>`;
}

/**
 * "Take it off again."
 *
 * Unequipping is a move to Carried, never a delete — the item stays in the
 * character's inventory. Two filters because both readings of the request are
 * real: a slot ("take everyone's helmet off") and one specific item ("nobody
 * should still be wearing that chainmail"). The item list is built from what
 * the selection is ACTUALLY wearing, so it can never name something no one has.
 */
function bulkUnequipSection(picked) {
  const u = state.bulkUnequip || {};
  const slot = u.slot || '';
  const slots = [...EQUIP_SLOTS, 'backpack_attach'];

  return `<details class="section" id="bulk-unequip-section">
    ${sectionSummary('bag', 'Unequip')}
    <div class="section-body stack">
      <div class="field-row">
        <label class="field">Slot
          <select id="bulk-unequip-slot" ${dis()}>
            <option value="">Everything worn</option>
            ${slots.map((s) => `<option value="${esc(s)}" ${slot === s ? 'selected' : ''}>${esc(SLOT_LABELS[s] || s)}</option>`).join('')}
          </select></label>
        <label class="field field--grow">Item
          <select id="bulk-unequip-item" ${dis()}>
            ${wornItemOptions(picked, slot, u.templateSid)}
          </select></label>
        <button class="btn btn--primary" id="bulk-unequip-apply" ${dis()}>Unequip</button>
      </div>
      <p class="hint">Everything taken off moves to Carried — nothing is dropped or destroyed.
        The item list is what this selection is wearing right now.</p>
      <div id="bulk-unequip-preflight"></div>
    </div>
  </details>`;
}

/**
 * The `<option>`s for the unequip panel's item filter: one per distinct
 * template the SELECTION is currently wearing, in the chosen slot. Rebuilt
 * imperatively when the selection or the slot changes, so it can never offer to
 * take off something nobody has on.
 */
function wornItemOptions(picked, slot, selected) {
  const worn = [];
  const seen = new Set();
  for (const { c } of picked) {
    for (const it of c.inventory || []) {
      if (!isWorn(it.section)) continue;
      if (slot && it.section !== slot) continue;
      if (!it.base || seen.has(it.base)) continue;
      seen.add(it.base);
      worn.push(it);
    }
  }
  worn.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  // Grouped by the slot the item is worn in. When the Slot filter above is set
  // there is only ever one group, so the headings are dropped — a lone
  // "Head" optgroup over a list already filtered to head slots is noise.
  if (slot) {
    return `<option value="">Any item</option>
      ${worn.map((it) => `<option value="${esc(it.base)}" ${selected === it.base ? 'selected' : ''}>${esc(it.name)}</option>`).join('')}`;
  }
  const bySlot = new Map();
  for (const it of worn) {
    if (!bySlot.has(it.section)) bySlot.set(it.section, []);
    bySlot.get(it.section).push(it);
  }
  // EQUIP_SLOTS order, not insertion order — head to boots, the way the Gear
  // page already lists a character.
  const ordered = [...EQUIP_SLOTS, 'backpack_attach'].filter((s) => bySlot.has(s));
  return `<option value="">Any item</option>
    ${ordered.map((s) => `<optgroup label="${esc(SLOT_LABELS[s] || s)}">
      ${bySlot.get(s).map((it) => `<option value="${esc(it.base)}" ${selected === it.base ? 'selected' : ''}>${esc(it.name)}</option>`).join('')}
    </optgroup>`).join('')}`;
}

/** One `.preflight` row per character. Shared by the two panels below. */
function preflightRows(picked, describe) {
  return `<div class="preflight">${picked.map(({ c }) => {
    const what = describe(c);
    return `<div class="preflight-row">
      <span class="who">${esc(c.name || '(unnamed)')}<span class="race">${esc(c.race ? c.race.name : 'unknown race')}</span></span>
      <span class="what">${what || '<em>nothing</em>'}</span>
    </div>`;
  }).join('')}</div>`;
}

/**
 * What the re-grade is about to touch, per character, before the write — the
 * same "name the consequence first" rule the loadout half follows. Computed
 * from the inventory already on the character; the server re-derives it.
 */
function bulkRegradePreflight(picked, opts) {
  const { armourLevel, gradeId, includeCarried, includePackContents } = opts;
  if (armourLevel === undefined && !gradeId) return '';

  const inScope = (c) => {
    const own = (c.inventory || []).filter((it) => includeCarried || isWorn(it.section));
    const nested = includePackContents
      ? (c.inventory || []).flatMap((it) => it.contents || [])
      : [];
    return [...own, ...nested];
  };

  return preflightRows(picked, (c) => {
    const items = inScope(c);
    const armour = items.filter((it) => it.kindType === 3);
    const weapons = items.filter((it) => it.kindType === 2);
    const parts = [];
    if (armourLevel !== undefined && armour.length) {
      parts.push(`${esc(armour.length)} armour → ${esc(tierLabel(armourLevel))}`);
    }
    if (gradeId && weapons.length) {
      const g = (state.weaponGrades || []).find((x) => x.id === gradeId);
      // Name the level the grade implies, so the preflight still says what is
      // about to be written now that nobody typed the number.
      parts.push(`${esc(plural(weapons.length, 'weapon'))} → ${esc(g ? `${g.modelName} (level ${g.rank})` : gradeId)}`);
    }
    return parts.map((p) => `<div>${p}</div>`).join('');
  });
}

/** What the unequip is about to take off, per character. */
function bulkUnequipPreflight(picked, { slot, templateSid }) {
  return preflightRows(picked, (c) => {
    const going = (c.inventory || []).filter((it) => isWorn(it.section)
      && (!slot || it.section === slot)
      && (!templateSid || it.base === templateSid));
    return going.length ? esc(going.map((it) => it.name).join(', ')) : '';
  });
}

/**
 * "Give everyone selected this one item."
 *
 * The loadout half above answers "kit this squad out"; this half answers the
 * much more common "they all need a Blackened Chainmail". Doing that with a
 * loadout would mean inventing a 30th one-item catalogue entry per item in the
 * game, and doing it through the Gear page's per-character Add item means one
 * staged edit and one backup per character — the exact thing the bulk route
 * exists to avoid. It is the same picker as `addItemSection()`, deliberately:
 * one item search in this app, learned once. Ids rather than the `.add-item-*`
 * classes because wire()'s per-card loop wires those against a single
 * character, and this card has no single character.
 */
function bulkItemSection() {
  const pick = state.bulkItem || {};
  return `<details class="section" id="bulk-item-section" ${pick.template ? 'open' : ''}>
    ${sectionSummary('add', 'Give one item to everyone')}
    <div class="section-body stack">
      <div class="field-row">
        <label class="field field--grow">Search items
          <input type="search" id="bulk-item-search" placeholder="e.g. Blackened Chainmail, katana"
            value="${esc(pick.query || '')}" ${dis()}></label>
        <label class="field">Category
          <select id="bulk-item-kind" ${dis()}>
            <option value="">All</option>
            ${(state.itemKinds || []).map((k) => `<option value="${esc(k.kind)}" ${pick.kind === k.kind ? 'selected' : ''}>${esc(k.label)}</option>`).join('')}
          </select></label>
        <label class="field">Slot
          <select id="bulk-item-slot" ${dis()}>
            <option value="">Any</option>
            ${(state.itemSlots || []).map((s) => `<option value="${esc(s)}" ${pick.slot === s ? 'selected' : ''}>${esc(SLOT_LABELS[s] || s)}</option>`).join('')}
          </select></label>
      </div>
      <p class="hint">Slot only lists items whose slot the editor can confirm — search by name for the rest.
        Every character selected gets their own copy; nothing is shared or moved between them.</p>
      <div id="bulk-item-results" class="picker-results"></div>
      <div id="bulk-item-config"></div>
      <div id="bulk-item-preflight"></div>
    </div>
  </details>`;
}

/**
 * The configure step for the one item, sized to the whole selection rather
 * than to one character. Quality controls are the same three-way split
 * `addItemConfig()` makes (armour Level ladder, weapon grade pair, neither for
 * trade goods) — every character gets the item at the same quality, which is
 * the point of setting it once here.
 */
function bulkItemConfig(pick, count) {
  const t = pick.template;
  const isWeapon = t.type === 2;
  const isArmour = t.type === 3;

  // Same split as addItemConfig(): armour has a named tier, a weapon has a
  // grade and nothing else to ask for.
  const levelControl = isArmour ? `
    <label class="field">Armour tier
      <select id="bulk-item-level-preset" data-nofilter>
        <option value="">choose…</option>
        ${LEVEL_PRESETS.map(([v, label]) => `<option value="${esc(v)}" ${pick.level === v ? 'selected' : ''}>${esc(label)} (${esc(v)})</option>`).join('')}
      </select></label>` : '';

  const gradeControl = isWeapon ? `
    <label class="field">Grade
      <select id="bulk-item-grade">
        <option value="">lowest (default)</option>
        ${gradeOptions(pick.gradeId)}
      </select></label>` : '';

  const quantityControl = t.stackable ? `
    <label class="field">Quantity each
      <input type="number" id="bulk-item-quantity" class="w-sm" step="1" min="1"
        value="${esc(pick.quantity ?? 1)}"></label>` : '';

  return `<div class="stack">
    <h4 class="group-label">Selected — ${esc(t.name)} <span class="muted">(${esc(t.kind)})</span></h4>
    ${t.description ? `<p class="hint">${esc(t.description)}</p>` : ''}
    <div class="field-row">
      ${levelControl}
      ${gradeControl}
      ${quantityControl}
      <label class="field">Place in
        <select id="bulk-item-place">
          ${wearFirst(t.allowedSections).map((s) => `<option value="${esc(s)}" ${pick.section === s ? 'selected' : ''}>${esc(SLOT_LABELS[s] || s)}</option>`).join('')}
        </select></label>
      <label class="field-check">
        <input type="checkbox" id="bulk-item-skip" ${pick.skipIfSlotFilled ? 'checked' : ''}>
        Skip a slot that's already filled
      </label>
      <span class="actions">
        <button class="btn btn--primary" id="bulk-item-apply" ${dis()}>Give to ${esc(count)}</button>
        <button class="btn btn--ghost" id="bulk-item-clear">Clear</button>
      </span>
    </div>
    ${t.slotsWidened ? '<p class="hint">Unrecognised kind — every slot is offered.</p>' : ''}
    ${isWeapon ? '<p class="hint">Grade is the manufacturer and material together — it sets the weapon\'s level too.</p>' : ''}
  </div>`;
}

/**
 * What is about to happen, per character, BEFORE the write — the same
 * "name the consequence first" rule the single-item row follows with its
 * "replaces X" note, scaled to a squad. Computed client-side from data already
 * on the character; the server re-derives it all anyway.
 */
function bulkPreflight(picked, loadout, skip = false) {
  if (!loadout) return '';
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

    // The reason this panel warns at all: a kit is applied to a whole squad at
    // once, and a mixed-race squad is exactly where "Shek cannot wear that
    // helmet" needs saying BEFORE the write, not in the receipt afterwards.
    const fit = gets.flatMap((it) => raceFitWarnings(
      { name: it.name || it.templateSid, raceRule: it.raceRule, type: it.type }, c, it.section,
    ));

    return `<div class="preflight-row">
      <span class="who">${esc(c.name || '(unnamed)')}<span class="race">${esc(c.race ? c.race.name : 'unknown race')}</span></span>
      <span class="what">
        ${gets.length ? esc(gets.map((it) => it.name || it.templateSid).join(', ')) : '<em>nothing — every slot already filled</em>'}
        ${replaces.length ? `<div class="muted">replaces ${esc(replaces.join(', '))}</div>` : ''}
        ${skipped.length ? `<div class="muted">skipping ${esc(plural(skipped.length, 'already-filled slot'))}</div>` : ''}
        ${fit.map((w) => `<div class="note-warn">${esc(w)}</div>`).join('')}
        ${notes.map((n) => `<div class="note-warn">${esc(n)}</div>`).join('')}
      </span>
    </div>`;
  }).join('')}</div>`;
}

export function renderGear() {
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
      <span class="muted">${esc(plural(all.length, 'character'))}</span>
      <span class="actions">
        <button class="btn btn--xs" id="toggle-select">${state.selectMode ? 'Done selecting' : 'Equip several at once'}</button>
      </span>
    </section>
    <div class="workspace">
      ${rosterNav(groups, { selectable: state.selectMode, races: rosterRaces(all) })}
      <div id="detail">${detail}</div>
    </div>`;
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
  const lines = [`${plural(r.itemsAdded, 'item')} → ${plural(r.charactersTouched, 'character')} in ${plural(r.filesTouched, 'file')}`];
  for (const c of r.characters) {
    const got = c.added.map((a) => a.name).join(', ') || 'nothing';
    lines.push(`  ${c.name || '(unnamed)'} — ${got}`);
    if (c.displaced.length) lines.push(`      displaced: ${c.displaced.map((d) => d.name).join(', ')}`);
    if (c.skipped.length) lines.push(`      skipped ${plural(c.skipped.length, 'filled slot')}`);
    for (const w of c.warnings) lines.push(`      ! ${w.text}`);
  }
  return lines;
}

export function wireBulkEquip() {
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
    preflightEl.innerHTML = bulkPreflight(rosterEntries(), currentLoadout(),
      !!(skipBox && skipBox.checked));
  };

  // Filled in by the wire* helpers below; no-ops until then so the tick handler
  // can call them unconditionally.
  let refreshItemPanel = () => {};
  let refreshRegradePanel = () => {};
  let refreshUnequipPanel = () => {};

  // Everything a tick changes, patched in place — see onTick() above.
  syncSelectionUi = () => {
    const n = state.selection.size;
    const count = page.querySelector('.roster-select-bar span');
    if (count) count.textContent = `${n} selected`;
    const heading = card.querySelector('h3');
    if (heading) heading.textContent = `Equip ${n} character${n === 1 ? '' : 's'}`;
    if (applyBtn) applyBtn.textContent = `Apply to ${n}`;
    refreshPreflight();
    refreshItemPanel();
    refreshRegradePanel();
    refreshUnequipPanel();
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
    const label = `${loadout.label} → ${plural(picked.length, 'character')}`;
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

  refreshItemPanel = wireBulkItem({ receipt, rosterEntries });
  refreshRegradePanel = wireBulkRegrade({ receipt, rosterEntries });
  refreshUnequipPanel = wireBulkUnequip({ receipt, rosterEntries });
}

/**
 * The re-grade half of the bulk panel.
 *
 * Like every other panel here it renders its pre-flight imperatively rather
 * than through render(), which would tear down the roster the selection lives
 * in. The Apply button stays disabled until at least one of the three controls
 * is actually set — otherwise its only effect would be the mutation gate's
 * "edit produced no change", which reads like a bug rather than a no-op.
 *
 * @returns {() => void} the repaint the tick handler calls.
 */
function wireBulkRegrade({ receipt, rosterEntries }) {
  const armourSel = document.getElementById('bulk-regrade-armour');
  if (!armourSel) return () => {};
  const gradeSel = document.getElementById('bulk-regrade-grade');
  const carriedBox = document.getElementById('bulk-regrade-carried');
  const packBox = document.getElementById('bulk-regrade-pack');
  const applyBtn = document.getElementById('bulk-regrade-apply');
  const preflightEl = document.getElementById('bulk-regrade-preflight');

  // The request body, minus `targets` — exactly the fields the server accepts
  // (an unknown key is a 400, not a silently ignored option), and only the ones
  // the user actually set.
  const choice = () => {
    const out = {};
    if (armourSel.value !== '') out.armourLevel = Number(armourSel.value);
    if (gradeSel && gradeSel.value) out.gradeId = gradeSel.value;
    // No `weaponLevel`: the grade carries it. The route still accepts the field
    // (a script or a future control may want it) — this panel simply no longer
    // asks, so the server's derived value stands.
    out.includeCarried = !!(carriedBox && carriedBox.checked);
    out.includePackContents = !!(packBox && packBox.checked);
    return out;
  };
  const isEmpty = (c) => c.armourLevel === undefined && !c.gradeId;

  const sync = () => {
    const c = choice();
    state.bulkGear = {
      armourLevel: c.armourLevel,
      gradeId: c.gradeId,
      includeCarried: c.includeCarried,
      includePackContents: c.includePackContents,
    };
    applyBtn.disabled = isEmpty(c) || !canWrite();
    const picked = rosterEntries();
    applyBtn.textContent = `Apply to ${picked.length}`;
    if (preflightEl) preflightEl.innerHTML = bulkRegradePreflight(picked, c);
  };

  for (const el of [armourSel, gradeSel, carriedBox, packBox]) {
    if (!el) continue;
    el.onchange = sync;
    el.oninput = sync;
  }
  sync();

  applyBtn.onclick = () => {
    const picked = rosterEntries();
    if (!picked.length) return showReceipt(receipt, new Error('Select at least one character first.'));
    const c = choice();
    if (isEmpty(c)) return showReceipt(receipt, new Error('Choose an armour tier or a weapon grade first.'));

    const label = `re-graded gear on ${plural(picked.length, 'character')}`;
    return runMutation(applyBtn, receipt, label,
      () => API.regradeMany(state.save, { targets: picked.map(({ c: ch, file }) => ({ file, sid: ch.sid })), ...c }),
      async (result) => {
        await refresh();
        state.panelReceipt = { result, label, details: regradeDetails(result) };
        render();
      },
      { details: regradeDetails });
  };

  return sync;
}

/** The bulk re-grade receipt's per-character lines. */
function regradeDetails(result) {
  const r = (result.receipts || [])[0];
  if (!r || !r.characters) return null;
  const lines = [`${plural(r.itemsChanged, 'item')} → ${plural(r.charactersTouched, 'character')} in ${plural(r.filesTouched, 'file')}`];
  for (const c of r.characters) {
    lines.push(`  ${c.name || '(unnamed)'} — ${plural(c.changed.length, 'item')}`);
    for (const it of c.changed) {
      const bits = [];
      if (it.before.level !== it.after.level) bits.push(`level ${it.before.level} → ${it.after.level}`);
      if (it.before.materialSid !== it.after.materialSid) bits.push('grade set');
      lines.push(`      ${it.name} (${SLOT_LABELS[it.section] || it.section}) — ${bits.join(', ')}`);
    }
    if (c.skipped) lines.push(`      ${plural(c.skipped, 'item')} of an unknown kind left alone`);
  }
  return lines;
}

/**
 * The unequip half of the bulk panel. The item filter is rebuilt whenever the
 * slot or the selection changes, because it is a list of what those characters
 * are wearing right now, not a catalogue.
 *
 * @returns {() => void} the repaint the tick handler calls.
 */
function wireBulkUnequip({ receipt, rosterEntries }) {
  const slotSel = document.getElementById('bulk-unequip-slot');
  if (!slotSel) return () => {};
  const itemSel = document.getElementById('bulk-unequip-item');
  const applyBtn = document.getElementById('bulk-unequip-apply');
  const preflightEl = document.getElementById('bulk-unequip-preflight');

  const sync = ({ rebuildItems = true } = {}) => {
    const picked = rosterEntries();
    const slot = slotSel.value;
    if (rebuildItems && itemSel) {
      // Changing the slot can orphan the chosen item; keep it only if it is
      // still one of the options rather than silently unequipping something else.
      const keep = itemSel.value;
      itemSel.innerHTML = wornItemOptions(picked, slot, keep);
      if (itemSel.value !== keep) itemSel.value = '';
    }
    const templateSid = itemSel ? itemSel.value : '';
    state.bulkUnequip = { slot, templateSid };
    applyBtn.disabled = !canWrite();
    if (preflightEl) preflightEl.innerHTML = bulkUnequipPreflight(picked, { slot, templateSid });
  };

  slotSel.onchange = () => sync();
  if (itemSel) itemSel.onchange = () => sync({ rebuildItems: false });
  sync();

  applyBtn.onclick = () => {
    const picked = rosterEntries();
    if (!picked.length) return showReceipt(receipt, new Error('Select at least one character first.'));
    const { slot, templateSid } = state.bulkUnequip || {};

    const body = { targets: picked.map(({ c, file }) => ({ file, sid: c.sid })) };
    if (slot) body.sections = [slot];
    if (templateSid) body.templateSids = [templateSid];

    const what = slot ? (SLOT_LABELS[slot] || slot) : 'everything worn';
    const label = `unequipped ${what} on ${plural(picked.length, 'character')}`;
    return runMutation(applyBtn, receipt, label,
      () => API.unequipMany(state.save, body),
      async (result) => {
        await refresh();
        state.panelReceipt = { result, label, details: unequipDetails(result) };
        render();
      },
      { details: unequipDetails });
  };

  return sync;
}

/**
 * Advisory lines from a single-item write: blueprint notes and race fit. The
 * write already happened by the time these are read — the pre-flight above the
 * button is where they are meant to be seen first; this is the record of what
 * the editor thought while doing it.
 */
export function fitDetails(result) {
  const r = (result.receipts || [])[0] || {};
  const lines = [...(r.warnings || [])];
  for (const w of r.fitWarnings || []) if (!lines.includes(w.text)) lines.push(w.text);
  return lines.length ? lines : null;
}

/** The bulk unequip receipt's per-character lines. */
function unequipDetails(result) {
  const r = (result.receipts || [])[0];
  if (!r || !r.characters) return null;
  const lines = [`${plural(r.itemsMoved, 'item')} → Carried, on ${plural(r.charactersTouched, 'character')} in ${plural(r.filesTouched, 'file')}`];
  for (const c of r.characters) {
    const moved = c.moved.map((m) => `${m.name} (${SLOT_LABELS[m.from] || m.from})`).join(', ');
    lines.push(`  ${c.name || '(unnamed)'} — ${moved || 'nothing'}`);
  }
  return lines;
}

/**
 * The "give one item to everyone" half of the bulk panel.
 *
 * Everything below `#bulk-item-section` is rendered imperatively, the same rule
 * the per-character item picker follows: a full render() on every keystroke
 * would tear down the search box mid-type, and here it would also collapse the
 * roster the selection lives in. Only the write re-renders.
 *
 * @returns {() => void} a repaint for the parts that depend on how many
 *   characters are selected — the tick handler calls it.
 */
function wireBulkItem({ receipt, rosterEntries }) {
  const search = document.getElementById('bulk-item-search');
  if (!search) return () => {};
  const kindSel = document.getElementById('bulk-item-kind');
  const slotSel = document.getElementById('bulk-item-slot');
  const resultsEl = document.getElementById('bulk-item-results');
  const configEl = document.getElementById('bulk-item-config');
  const preflightEl = document.getElementById('bulk-item-preflight');

  const pickOf = () => {
    if (!state.bulkItem) state.bulkItem = {};
    return state.bulkItem;
  };

  // The pre-flight lists what each selected character is about to get and what
  // it displaces — the same "name the consequence before the write" the loadout
  // half shows. One item is just a one-item loadout as far as that view cares.
  const refreshPreflight = () => {
    const pick = pickOf();
    if (!preflightEl) return;
    if (!pick.template) { preflightEl.innerHTML = ''; return; }
    preflightEl.innerHTML = bulkPreflight(rosterEntries(), {
      items: [{
        templateSid: pick.template.sid,
        name: pick.template.name,
        section: pick.section,
        type: pick.template.type,
        // Carried through so the pre-flight can name who cannot wear it.
        raceRule: pick.template.raceRule || null,
      }],
      raceNotes: [],
    }, !!pick.skipIfSlotFilled);
  };

  const wireConfig = () => {
    const pick = pickOf();
    if (!pick.template) { configEl.innerHTML = ''; refreshPreflight(); return; }
    configEl.innerHTML = bulkItemConfig(pick, rosterEntries().length);

    // Armour only; a weapon is chosen by Grade alone now, so there is no level
    // control to fill in and `presetSel` is simply absent for one.
    const presetSel = document.getElementById('bulk-item-level-preset');
    const gradeSel = document.getElementById('bulk-item-grade');
    const qtyInput = document.getElementById('bulk-item-quantity');
    const placeSel = document.getElementById('bulk-item-place');
    const skipBox = document.getElementById('bulk-item-skip');

    // The armour tier IS the choice now — it sets `level` directly rather than
    // quick-filling a box that is no longer there.
    if (presetSel) presetSel.onchange = () => {
      pick.level = presetSel.value === '' ? undefined : Number(presetSel.value);
    };
    if (gradeSel) gradeSel.onchange = () => { pick.gradeId = gradeSel.value || undefined; };
    if (qtyInput) qtyInput.oninput = () => { pick.quantity = Number(qtyInput.value); };
    if (placeSel) placeSel.onchange = () => { pick.section = placeSel.value; refreshPreflight(); };
    if (skipBox) skipBox.onchange = () => { pick.skipIfSlotFilled = skipBox.checked; refreshPreflight(); };

    document.getElementById('bulk-item-clear').onclick = () => {
      state.bulkItem = { query: pick.query, kind: pick.kind, slot: pick.slot, results: pick.results, total: pick.total };
      configEl.innerHTML = '';
      refreshPreflight();
    };

    const applyBtn = document.getElementById('bulk-item-apply');
    applyBtn.onclick = () => {
      const picked = rosterEntries();
      if (!picked.length) return showReceipt(receipt, new Error('Select at least one character first.'));

      // Only the fields the server accepts (saveService EQUIP_ITEM_FIELDS) —
      // an unknown key is a 400, not a silently ignored option.
      const item = { templateSid: pick.template.sid, section: placeSel.value };
      // `level` is sent only for armour. Omitting it for a weapon is what lets
      // the server derive it from the grade (itemFactory.defaultLevelForGrade).
      if (pick.level !== undefined) item.level = pick.level;
      if (gradeSel && gradeSel.value) item.gradeId = gradeSel.value;
      if (qtyInput && qtyInput.value !== '') item.quantity = Number(qtyInput.value);

      const label = `${pick.template.name} → ${plural(picked.length, 'character')}`;
      return runMutation(applyBtn, receipt, label,
        () => API.equipMany(state.save, {
          targets: picked.map(({ c, file }) => ({ file, sid: c.sid })),
          items: [item],
          skipIfSlotFilled: !!(skipBox && skipBox.checked),
        }),
        async (result) => {
          await refresh();
          state.panelReceipt = { result, label, details: bulkDetails(result) };
          render();
        },
        { details: bulkDetails });
    };

    refreshPreflight();
  };

  const wireResults = () => {
    const pick = pickOf();
    if (!pick.results) { resultsEl.innerHTML = ''; return; }
    resultsEl.innerHTML = addItemResults(pick.results, pick.total);
    resultsEl.querySelectorAll('.pick-item-btn').forEach((b) => {
      b.onclick = async () => {
        const template = pick.results.find((r) => r.sid === b.dataset.sid);
        if (!template) return;
        // The grade ladder only means anything for a weapon, so it is fetched
        // the first time one is actually picked rather than at boot.
        if (template.type === 2 && !state.weaponGrades) {
          try {
            state.weaponGrades = (await API.weaponGrades()).grades;
          } catch {
            state.weaponGrades = []; // optional; the server defaults the grade
          }
        }
        Object.assign(pick, {
          template,
          section: wearFirst(template.allowedSections)[0],
          quantity: template.stackable ? 1 : undefined,
          level: defaultLevelFor(template.type),
          gradeId: template.type === 2 ? defaultGradeId() : undefined,
        });
        wireConfig();
      };
    });
  };

  const runSearch = async (query) => {
    const pick = pickOf();
    pick.query = query;
    pick.kind = kindSel ? kindSel.value : '';
    pick.slot = slotSel ? slotSel.value : '';
    // The filters are part of the request identity, so a slower earlier request
    // cannot overwrite a newer one that only changed a filter.
    const token = `${query}|${pick.kind}|${pick.slot}`;
    try {
      const res = await API.items(query, 40, { kind: pick.kind, slot: pick.slot });
      if (`${pick.query}|${pick.kind}|${pick.slot}` !== token) return;
      pick.results = res.items;
      pick.total = res.total;
      if (res.kinds) state.itemKinds = res.kinds;
      if (res.slots) state.itemSlots = res.slots;
    } catch (err) {
      pick.results = [];
      pick.total = 0;
      showReceipt(receipt, err);
    }
    wireResults();
  };

  let searchTimer = null;
  search.oninput = () => {
    clearTimeout(searchTimer);
    const q = search.value;
    searchTimer = setTimeout(() => runSearch(q), 180);
  };
  if (kindSel) kindSel.onchange = () => runSearch(search.value);
  if (slotSel) slotSel.onchange = () => runSearch(search.value);

  // Opening the panel with nothing typed lists the catalogue, so the control is
  // explorable rather than a blank box that only rewards guesses.
  const details = document.getElementById('bulk-item-section');
  details.ontoggle = () => {
    if (details.open && !pickOf().results) runSearch('');
  };

  wireResults();
  wireConfig();

  // Ticking another name changes the button's count and every row of the
  // pre-flight, and nothing else on this half.
  return () => {
    const applyBtn = document.getElementById('bulk-item-apply');
    if (applyBtn) applyBtn.textContent = `Give to ${rosterEntries().length}`;
    refreshPreflight();
  };
}
