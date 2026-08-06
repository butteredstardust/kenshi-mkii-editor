import { esc, plural } from '../core.mjs';
import { state, keyOf } from '../state.mjs';
import { icon } from '../icons.mjs';
import { SLOT_LABELS } from '../slots.mjs';
import { render, savePicker } from '../nav.mjs';
import { buildRoster, rosterNav, rosterRaces } from './roster.mjs';
import { bulkPanel, wireBulkEquip as wireBulk } from './bulk-equip.mjs';

/*
 * Loadouts (services/loadouts.js) — the 148 named gear sets that back bulk
 * equip, made browsable on their own rather than only ever appearing as
 * entries in that panel's <select>. `state.loadouts` is already the full
 * catalogue, fetched once at boot (shell.mjs's boot()) because the OLD Gear
 * tab's bulk panel needed it synchronously — this page reads the exact same
 * array rather than fetching a second copy of save-independent data.
 *
 * Bulk equip itself moved here from gear.mjs (see bulk-equip.mjs) because a
 * kit's contents are named and browsed right here — asking "what does the
 * Shek Garrison set look like" and "give it to my squad" belong on one page,
 * not two.
 */

/**
 * loadoutItems() is exported for recruits.mjs and squad.mjs — a recruit's
 * "kit" IS a loadout, read-only, and the app has one item-list renderer, not
 * three that would drift apart the first time someone edits only one of them.
 *
 * `narrow` folds the four columns into two, slot under the name instead of
 * beside it. The Squad tab's add-member preview lives in a 280px sidebar,
 * where four columns cannot fit at any font size: the table would scroll
 * inside its `.table-wrap` and push the quality column — "lvl 80", "Catun
 * No.3", the entire reason the preview exists — out of sight by default.
 */
export function loadoutItems(loadout, { narrow = false } = {}) {
  if (!loadout.items.length) return '<p class="hint">No items.</p>';
  const cols = narrow ? 2 : 4;
  return `<div class="table-wrap"><table class="data-table ${narrow ? '' : 'table--compact'}"><tbody>
    ${loadout.items.map((it) => {
    const note = raceRuleNote(it.raceRule);
    const name = it.name ? esc(it.name) : `<span class="muted">${esc(it.templateSid)}</span>`;
    const slot = esc(SLOT_LABELS[it.section] || it.section);
    const qty = it.quantity > 1 ? `×${esc(it.quantity)}` : '';
    return `<tr>
      ${narrow ? `<td class="col-item">${name}
        <div class="muted">${slot}${qty ? ` · ${qty}` : ''}</div></td>
      <td class="muted shrink">${qualityCell(it)}</td>`
    : `<td class="col-item">${name}</td>
      <td class="muted">${slot}</td>
      <td class="n shrink">${qty}</td>
      <td class="muted shrink">${qualityCell(it)}</td>`}
    </tr>
    ${note ? `<tr class="item-advanced"><td colspan="${cols}"><span class="note-warn">${esc(note)}</span></td></tr>` : ''}`;
  }).join('')}
  </tbody></table></div>`;
}

/**
 * `level` (armour/crossbow quality) and `gradeId` (a weapon's manufacturer +
 * material) are two independent save fields — see docs/save-format.md and
 * grades.mjs. A weapon has no meaningful `level` of its own, so an item never
 * shows both; whichever the loadout actually set is what renders.
 */
function qualityCell(it) {
  const parts = [];
  if (it.level != null) parts.push(`lvl ${esc(it.level)}`);
  if (it.gradeId) {
    const g = (state.weaponGrades || []).find((x) => x.id === it.gradeId);
    if (g) {
      const label = g.companyName && g.companyName !== g.modelName ? `${g.modelName} (${g.companyName})` : g.modelName;
      parts.push(esc(label));
    } else {
      parts.push(`<span class="muted">${esc(it.gradeId)}</span>`);
    }
  }
  return parts.length ? parts.join(', ') : '<span class="muted">—</span>';
}

/**
 * Compact race-fit text for one item, matching `raceFitWarnings()`'s wording
 * (items.mjs) without needing a character to check it against — this page has
 * none, it is a catalogue. "Hive only" / "not wearable by: …", not a sentence
 * per race, because a piece with a five-race exclude list is common (packs)
 * and a sentence each would swamp the row.
 */
function raceRuleNote(rule) {
  if (!rule) return '';
  const bits = [];
  if (rule.only && rule.only.length) bits.push(`${names(rule.only)} only`);
  if (rule.exclude && rule.exclude.length) bits.push(`not wearable by ${names(rule.exclude)}`);
  return bits.join('; ');
}

/**
 * Race names, capped. Almost every clothing template in the game excludes all
 * ten Hive and Deadhive races, so spelling the list out put a two-line block
 * under every armour row of every kit — five times over on a full set, saying
 * the same thing each time. The count is what carries the information here; the
 * kit's own `raceNotes` above the table is where the summary belongs, and the
 * per-character pre-flight in bulk-equip.mjs is where the exact list matters.
 */
function names(rows, cap = 3) {
  const shown = rows.slice(0, cap).map((r) => r.name).join(', ');
  return rows.length > cap ? `${shown} and ${rows.length - cap} more` : shown;
}

function loadoutMatches(l, f) {
  if (f.category && l.category !== f.category) return false;
  if (!f.q) return true;
  const q = f.q.toLowerCase();
  return l.label.toLowerCase().includes(q)
    || l.description.toLowerCase().includes(q)
    || l.categoryLabel.toLowerCase().includes(q)
    || (l.tags || []).some((t) => t.toLowerCase().includes(q));
}

/** Rows grouped by category, ordered by `categoryIndex`, then by label. */
function groupedLoadouts(rows) {
  const byIndex = new Map();
  for (const l of rows) {
    if (!byIndex.has(l.categoryIndex)) byIndex.set(l.categoryIndex, { label: l.categoryLabel, rows: [] });
    byIndex.get(l.categoryIndex).rows.push(l);
  }
  return [...byIndex.entries()].sort(([a], [b]) => a - b).map(([, g]) => {
    g.rows.sort((a, b) => a.label.localeCompare(b.label));
    return g;
  });
}

function loadoutFilters(rows) {
  const f = state.loadoutFilter;
  // Categories in their own display order, not alphabetical — the same reason
  // the groups below are.
  const cats = [...new Map(rows.map((l) => [l.categoryIndex, l.categoryLabel])).entries()]
    .sort(([a], [b]) => a - b);
  return `<div class="field-row">
      <label class="field field--grow">Search
        <input type="search" id="loadout-q" placeholder="kit name, tag or description" value="${esc(f.q)}"></label>
      <label class="field">Category
        <select id="loadout-cat">
          <option value="">All categories</option>
          ${cats.map(([, label]) => {
    const cat = rows.find((l) => l.categoryLabel === label).category;
    return `<option value="${esc(cat)}" ${f.category === cat ? 'selected' : ''}>${esc(label)}</option>`;
  }).join('')}
        </select></label>
    </div>`;
}

function loadoutCard(l) {
  return `<details class="list-row">
    <summary><span class="item-name">${esc(l.label)}</span>
      <span class="muted">${esc(plural(l.items.length, 'item'))}</span></summary>
    <div class="section-body stack">
      <p class="hint">${esc(l.description)}</p>
      ${l.tags.length ? `<div class="chips">${l.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>` : ''}
      ${l.raceNotes.map((n) => `<p class="hint note-warn">${esc(n.note)}${n.races && n.races.length ? ` (${esc(n.races.join(', '))})` : ''}</p>`).join('')}
      ${l.missing.length ? `<p class="hint note-warn">${esc(plural(l.missing.length, 'item'))} in this set are not in your installed data.</p>` : ''}
      ${loadoutItems(l)}
    </div>
  </details>`;
}

export function renderLoadouts() {
  const rows = state.loadouts || [];
  const shown = rows.filter((l) => loadoutMatches(l, state.loadoutFilter));
  const groups = groupedLoadouts(shown);

  const r = buildRoster();
  const picked = r ? r.all.filter(({ c, file }) => state.selection.has(keyOf(file, c.sid))) : [];

  // Bulk equip needs a roster to pick targets from — a save with a squad — so
  // the whole section is absent rather than shown empty when there is none.
  // Same summary-bar + workspace shape gear.mjs used to render this in, so the
  // move doesn't also change how it looks.
  const bulkSection = r && r.all.length ? `
    <section class="summary-bar">
      <span><b>Equip several at once</b></span>
      <span class="muted">${esc(plural(state.selection.size, 'character'))} selected</span>
      <span class="actions">
        <button class="btn btn--xs" id="toggle-select">${state.selectMode ? 'Done selecting' : 'Select characters'}</button>
      </span>
    </section>
    ${state.selectMode ? `<div class="workspace">
          ${rosterNav(r.groups, { selectable: true, races: rosterRaces(r.all) })}
          <div id="detail">${picked.length ? bulkPanel(picked)
    : '<div class="empty-state"><strong>Nothing selected</strong>Tick characters in the roster to equip them together in one edit.</div>'}</div>
        </div>` : '<p class="hint">Pick a kit above, then select characters here to apply it to several at once.</p>'}` : '';

  return `${savePicker()}
    <section class="panel" id="loadouts-panel">
      <div class="panel-head"><h2>${icon('bag', 'Loadouts')} Loadouts</h2>
        <span class="muted">${esc(shown.length)} of ${esc(rows.length)} shown</span></div>
      ${loadoutFilters(rows)}
      ${groups.length ? groups.map((g) => `<h3 class="group-label">${esc(g.label)}</h3>${g.rows.map(loadoutCard).join('')}`).join('')
    : '<div class="empty-state"><strong>Nothing matches</strong>No loadout matches this search and filter.</div>'}
    </section>
    ${bulkSection}`;
}

export function wireLoadouts() {
  const panel = document.getElementById('loadouts-panel');
  if (!panel) return;

  const q = document.getElementById('loadout-q');
  if (q) q.oninput = () => {
    state.loadoutFilter = { ...state.loadoutFilter, q: q.value };
    render();
    const next = document.getElementById('loadout-q');
    if (next) { next.focus(); next.setSelectionRange(next.value.length, next.value.length); }
  };
  const cat = document.getElementById('loadout-cat');
  if (cat) cat.onchange = () => { state.loadoutFilter = { ...state.loadoutFilter, category: cat.value }; render(); };
}

// Bulk equip's own wiring (roster multi-select, the three panels, the toggle
// button above) — re-exported under its original name because shell.mjs's
// wire() calls it unconditionally, same as every other tab's wire*().
export const wireBulkEquip = wireBulk;
