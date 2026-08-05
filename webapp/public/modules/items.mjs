import { esc, inputNum, plural } from './core.mjs';
import { state, keyOf, dis } from './state.mjs';
import { icon, sectionSummary, SLOT_ICONS } from './icons.mjs';
import { ITEM_SLOTS, SLOT_LABELS, ARMOUR_SLOTS, isWorn, carryFirst } from './slots.mjs';
import { LEVEL_PRESETS, gradeOptions } from './grades.mjs';

/**
 * Read-only inventory for the Squad card — same glyphs and slot labels the Gear
 * page uses, so an item looks like the same thing on both pages, and pack
 * contents nested under the pack that holds them (they live in the pack's own
 * inventory record, one hop past the character's — see
 * saveService.packContentsOf). Before this they were simply absent here.
 */
export function invRow(it, { nested = false } = {}) {
  return `<tr${nested ? ' class="inv-nested"' : ''}>
    <td class="col-item"><span class="item-name">${icon(SLOT_ICONS[it.section] || 'bag', it.section)}<span>${esc(it.name)}</span></span></td>
    <td class="n shrink">${it.quantity > 1 ? `&times;${esc(it.quantity)}` : ''}</td>
    <td class="muted shrink">${esc(SLOT_LABELS[it.section] || it.section)}</td>
  </tr>`;
}

export function inventorySection(c) {
  const items = c.inventory || [];
  const nestedCount = items.reduce((n, it) => n + it.contents.length, 0);
  const rows = items.flatMap((it) => [invRow(it), ...it.contents.map((inner) => invRow(inner, { nested: true }))]);

  return `<details class="section">
    ${sectionSummary('list', `Inventory (${esc(items.length + nestedCount)})`)}
    <div class="section-body table-wrap">
      <table class="data-table table--compact"><tbody>
        ${rows.join('') || '<tr><td class="muted">Empty.</td></tr>'}
      </tbody></table>
    </div>
  </details>`;
}

// ------------------------------------------------------------------ Gear --

// Body slots, one roster row each in "Equipped". `main` (general carry) and
/**
 * Does the game's own data (or the wiki's slot table) say this character
 * shouldn't wear this template? The client-side twin of services/fitCheck.js,
 * for the ONE thing the server cannot answer ahead of time: a template the
 * character does not own yet, being previewed in a picker.
 *
 * `template.raceRule` comes straight off the server (`/api/gamedata/items`) and
 * is matched on the race's **sid**, never its name — two races in this install
 * share a display name. `armourSlots` likewise arrives resolved per character.
 * Nothing here decides anything: every one of these is also produced by the
 * server on the write, and neither refuses.
 */
export function raceFitWarnings(template, character, section) {
  const out = [];
  if (!template || !character) return out;
  const race = character.race;
  const rule = template.raceRule;

  if (race && rule) {
    const has = (list) => (list || []).some((r) => r.sid === race.sid);
    if (has(rule.exclude)) {
      out.push(`${template.name} cannot be worn by ${race.name}`);
    } else if ((rule.only || []).length && !has(rule.only)) {
      const named = rule.only.slice(0, 3).map((r) => r.name).join(', ')
        + (rule.only.length > 3 ? ` and ${rule.only.length - 3} more` : '');
      out.push(`${template.name} can only be worn by ${named}`);
    }
  }

  if (race && race.armourSlots && section && ARMOUR_SLOTS.includes(section)
    && !race.armourSlots.includes(section)) {
    out.push(`${race.slotRuleLabel || race.name} have no ${section} slot in game`);
  }
  return out;
}

export function itemSlotSelect(it) {
  // Options come straight from the server's allowedSections (services/itemSlots.js)
  // — the client never recomputes compatibility itself. Fall back to the full
  // list only if an older/unpatched API response omits the field.
  const options = carryFirst(it.allowedSections || ITEM_SLOTS);
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
export function itemRow(it) {
  const glyph = SLOT_ICONS[it.section] || 'bag';
  const isWeapon = it.kindType === 2;
  const hasLevel = it.level != null;
  const grades = state.weaponGrades || [];

  const qtyCell = it.stackable
    ? `<input type="number" class="item-field w-sm" data-field="quantity" step="1" min="1"
        value="${esc(it.quantity ?? 1)}" data-initial="${esc(it.quantity ?? 1)}" aria-label="Quantity" ${dis()}>`
    : `<span class="muted">${it.quantity > 1 ? `×${esc(it.quantity)}` : '1'}</span>`;

  // Trade goods and packs have no quality tier: every one mints `level` 0 and
  // the field means nothing on them (itemFactory forces it). Showing a
  // "Level 0" dropdown invites an edit that does nothing.
  const hasQuality = isWeapon || (hasLevel && it.kindType !== 4 && it.kindType !== 46);

  let qualityCell = '<span class="muted">—</span>';
  if (isWeapon && grades.length) {
    // Keyed on the grade's composite id ("<companySid>|<modelSid>"), NOT on
    // modelSid: 14 of this install's 24 model sids belong to two different
    // companies, so a modelSid-keyed <select> emits duplicate option values and
    // the server has to guess which manufacturer you meant.
    qualityCell = `<select class="item-field" data-field="gradeId" data-initial="${esc(it.gradeId || '')}" aria-label="Grade" ${dis()}>
      ${gradeOptions(it.gradeId, it.material)}
    </select>`;
  } else if (hasQuality) {
    const named = LEVEL_PRESETS.some(([v]) => v === it.level);
    // `data-nofilter`: six rungs of an ORDERED ladder, Prototype to Masterwork,
    // and this control is repeated once per equipped item. A search box over a
    // list you read top to bottom is noise anywhere; six of them stacked down a
    // table is noise that crowds out the table. The grade select next door has
    // 38 unordered rows and keeps its filter.
    qualityCell = `<select class="item-field" data-field="level" data-nofilter data-initial="${esc(it.level)}" aria-label="Quality tier" ${dis()}>
      ${named ? '' : `<option value="${esc(it.level)}" selected>Level ${esc(it.level)}</option>`}
      ${LEVEL_PRESETS.map(([v, label]) => `<option value="${esc(v)}" ${v === it.level ? 'selected' : ''}>${esc(label)} (${esc(v)})</option>`).join('')}
    </select>`;
  }

  // Server-computed for every owned item (saveService.readPlatoon): the game's
  // own racial restrictions plus the wiki's slot table. Shown on the row rather
  // than only on a write, because the most common case is armour that is
  // ALREADY on the wrong character — nothing would ever surface it otherwise.
  const fit = it.fitWarnings || [];

  return `<tr data-sid="${esc(it.sid)}">
    <td class="col-item"><span class="item-name">${icon(glyph, it.section)}<span>${esc(it.name)}</span>
      ${fit.length ? '<span class="badge badge--warn" title="Race fit">race</span>' : ''}</span>
      ${fit.map((w) => `<div class="note-warn">${esc(w.text)}</div>`).join('')}
      ${it.blueprint
    // Every blueprint is called "Blueprints", so without this a stack of five
    // different ones reads as five copies of one item.
    ? `<div class="muted">unlocks ${esc(it.blueprint.subjectName || it.blueprint.teaches || 'nothing')}</div>`
    : it.catalog?.category ? `<div class="muted">${esc(it.catalog.category)}</div>` : ''}</td>
    <td class="n shrink">${qtyCell}</td>
    <td class="shrink">${itemSlotSelect(it)}
      <div class="muted item-collision-note"></div></td>
    <td class="shrink">${qualityCell}</td>
    <td class="shrink"><span class="actions">
      <button class="btn apply-item-btn" data-sid="${esc(it.sid)}" disabled>Apply</button>
      ${isWorn(it.section) ? `<button class="btn btn--ghost btn--xs unequip-item-btn" data-sid="${esc(it.sid)}"
        title="Move this back to Carried" ${dis()}>Unequip</button>` : ''}
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
          ${isWeapon ? 'For weapons, choosing a Grade already sets Level to that grade\'s rank — type a number here only to override it.' : ''}</span>
      </div>
    </td>
  </tr>`;
}

export function itemTable(items, emptyText) {
  // Column headings over no rows are furniture: "ITEM QTY SLOT QUALITY" above
  // "Nothing equipped" describes a table that is not there.
  if (!items.length) return `<p class="hint">${esc(emptyText)}</p>`;
  // Deliberately NOT .table--compact: that cap suits the read-mostly body-part
  // table, but this row carries a select per concept, and under a 46rem cap the
  // item-name column collapses and wraps every name to 4 lines.
  return `<div class="table-wrap"><table class="data-table"><thead><tr>
      <th class="col-item">Item</th><th class="n">Qty</th><th>Slot</th><th>Quality</th><th></th>
    </tr></thead>
    <tbody>${items.map(itemRow).join('')}</tbody>
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
export function addItemSection(c, file) {
  const pick = state.addItem && state.addItem.key === keyOf(file, c.sid) ? state.addItem : null;
  return `<details class="section" ${pick ? 'open' : ''}>
    ${sectionSummary('add', 'Add item')}
    <div class="section-body stack">
      <div class="field-row">
        <label class="field field--grow">Search items
          <input type="search" class="add-item-search" placeholder="e.g. katana, KLR arm"
            value="${esc(pick ? pick.query || '' : '')}" ${dis()}></label>
        <label class="field">Category
          <select class="add-item-kind" ${dis()}>
            <option value="">All</option>
            ${(state.itemKinds || []).map((k) => `<option value="${esc(k.kind)}" ${pick && pick.kind === k.kind ? 'selected' : ''}>${esc(k.label)}</option>`).join('')}
          </select></label>
        <label class="field">Slot
          <select class="add-item-slot" ${dis()}>
            <option value="">Any</option>
            ${(state.itemSlots || []).map((s) => `<option value="${esc(s)}" ${pick && pick.slot === s ? 'selected' : ''}>${esc(SLOT_LABELS[s] || s)}</option>`).join('')}
          </select></label>
      </div>
      <p class="hint">Slot only lists items whose slot the editor can confirm — search by name for the rest.</p>
      <div class="add-item-results picker-results"></div>
      <div class="add-item-config"></div>
      <p class="hint">Filling an occupied slot sends the current occupant to Carried. Race fit is not checked.</p>
    </div>
  </details>`;
}

/** Result rows for the item search. Rendered imperatively so typing never re-renders the page. */
export function addItemResults(items, total) {
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
export function addItemConfig(pick) {
  const t = pick.template;
  const isWeapon = t.type === 2;
  const isArmour = t.type === 3;

  // Armour keeps its named tier ladder — that IS how a player names armour
  // quality ("Masterwork"). A WEAPON does not: nobody asks for a level-80
  // katana, they ask for an Edge Type 5, so the grade below is the only quality
  // control offered and the server derives `ints.level` from the grade's own
  // ladder rank (itemFactory.defaultLevelForGrade). The raw number is still
  // reachable afterwards under a row's "More".
  const levelControl = isArmour ? `
    <label class="field">Armour tier
      <select class="add-item-level-preset" data-nofilter>
        <option value="">choose…</option>
        ${LEVEL_PRESETS.map(([v, label]) => `<option value="${esc(v)}" ${pick.level === v ? 'selected' : ''}>${esc(label)} (${esc(v)})</option>`).join('')}
      </select></label>` : '';

  const gradeControl = isWeapon ? `
    <label class="field">Grade
      <select class="add-item-grade">
        <option value="">lowest (default)</option>
        ${gradeOptions(pick.gradeId)}
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
          ${carryFirst(t.allowedSections).map((s) => `<option value="${esc(s)}" ${pick.section === s ? 'selected' : ''}>${esc(SLOT_LABELS[s] || s)}</option>`).join('')}
        </select></label>
      <span class="actions">
        <button class="btn btn--primary add-item-btn" ${dis()}>Add to inventory</button>
        <button class="btn btn--ghost add-item-clear">Clear</button>
      </span>
    </div>
    <p class="hint add-item-collision"></p>
    <div class="add-item-fit"></div>
    ${t.slotsWidened ? '<p class="hint">Unrecognised kind — every slot is offered.</p>' : ''}
    ${isWeapon ? '<p class="hint">Grade is the manufacturer and material together — it sets the weapon\'s level too.</p>' : ''}
  </div>`;
}

/**
 * The race-fit block shown under a picker, BEFORE the write. Warnings only —
 * the button beside it stays enabled, because this editor's whole job is
 * writing things Kenshi's own UI will not offer (AGENTS.md §3). Naming the
 * consequence and then letting the user decide is the same contract the
 * "replaces X" collision note follows.
 */
export function fitNotice(warnings, { who = null } = {}) {
  if (!warnings.length) return '';
  return `<p class="note-warn">${who ? `${esc(who)}: ` : ''}${warnings.map(esc).join('. ')}.
    <span class="muted">Applying anyway is allowed — the game may not show it.</span></p>`;
}

/**
 * One worn pack and what is inside it.
 *
 * The pack itself keeps the normal editable row (it is an item on the
 * character like any other). Its contents are listed read-only: they live in
 * the pack's own inventory record, and nothing in this editor can write there
 * yet — offering a Slot select that silently did nothing would be worse than
 * showing them plainly.
 */
export function packBlock(pack) {
  const total = pack.contents.reduce((n, it) => n + (it.quantity || 1), 0);
  return `<div class="pack">
    ${itemTable([pack], '')}
    <div class="pack-contents">
      <h4 class="group-label">${icon('bag', 'Contents')} Inside — ${esc(plural(pack.contents.length, 'stack'))}, ${esc(plural(total, 'item'))}</h4>
      ${pack.contents.length ? `<div class="table-wrap"><table class="data-table table--compact"><tbody>
        ${pack.contents.map((it) => `<tr>
          <td class="col-item"><span class="item-name">${icon('bag', it.section)}<span>${esc(it.name)}</span></span></td>
          <td class="n shrink">${it.quantity > 1 ? `&times;${esc(it.quantity)}` : ''}</td>
          <td class="muted">${esc(it.catalog?.category || '')}</td>
        </tr>`).join('')}
      </tbody></table></div>`
    : '<p class="hint">This pack is empty.</p>'}
      <p class="hint">Read-only — contents live in the pack's own record.</p>
    </div>
  </div>`;
}
