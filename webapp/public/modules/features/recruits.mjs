import { esc } from '../core.mjs';
import { state } from '../state.mjs';
import { icon } from '../icons.mjs';
import { render } from '../nav.mjs';
import { loadoutItems } from './loadouts.mjs';

/*
 * Recruits (services/recruits.js) — the 144-entry "roll a recruit" catalogue,
 * in the spirit of the wiki's Unique Recruits page. Save-independent: it is
 * editorial data plus this install's own gamedata (skills, tiers, towns), so
 * unlike every other tab this one needs no save picker and writes nothing.
 *
 * `state.recruits` is fetched once at boot (shell.mjs) because the "add
 * member" form on the Squad tab already needed it there — this page reads the
 * same array rather than a second copy.
 */

function recruitMatches(r, f) {
  if (f.group && r.group !== f.group) return false;
  if (!f.q) return true;
  const q = f.q.toLowerCase();
  return r.name.toLowerCase().includes(q)
    || r.blurb.toLowerCase().includes(q)
    || r.subLabel.toLowerCase().includes(q)
    || r.groupLabel.toLowerCase().includes(q);
}

/** Rows grouped by `groupLabel`, ordered by `groupIndex`, then by name. */
function groupedRecruits(rows) {
  const byIndex = new Map();
  for (const r of rows) {
    if (!byIndex.has(r.groupIndex)) byIndex.set(r.groupIndex, { label: r.groupLabel, rows: [] });
    byIndex.get(r.groupIndex).rows.push(r);
  }
  return [...byIndex.entries()].sort(([a], [b]) => a - b).map(([, g]) => {
    g.rows.sort((a, b) => a.name.localeCompare(b.name));
    return g;
  });
}

function recruitFilters(rows) {
  const f = state.recruitFilter;
  const groups = [...new Map(rows.map((r) => [r.groupIndex, [r.group, r.groupLabel]])).entries()]
    .sort(([a], [b]) => a - b);
  return `<div class="field-row">
      <label class="field field--grow">Search
        <input type="search" id="recruit-q" placeholder="name, role or blurb" value="${esc(f.q)}"></label>
      <label class="field">Group
        <select id="recruit-group">
          <option value="">All groups</option>
          ${groups.map(([, [id, label]]) => `<option value="${esc(id)}" ${f.group === id ? 'selected' : ''}>${esc(label)}</option>`).join('')}
        </select></label>
    </div>`;
}

/** What a recruit's tier actually writes, stated once rather than per skill. */
function tierDetail(r) {
  const s = r.tierSpread;
  return `<p class="hint">
      <strong>${esc(r.tierLabel)}</strong> tier. ${esc(r.skills.join(', '))}
      land at ${esc(s.archRange[0])}–${esc(s.archRange[1])}; every other skill lands at
      ${esc(s.otherRange[0])}–${esc(s.otherRange[1])}; attributes at ${esc(s.attribute)}.
    </p>`;
}

/** Where a recruit is found — resolved towns, then the ones this install's data can't place. */
function locationDetail(r) {
  if (!r.locations.length && !r.unresolvedLocations.length) return '<p class="hint">No location recorded.</p>';
  return `<div class="stack">
    ${r.locations.length ? `<p class="hint">${r.locations.map((l) => `${esc(l.label)}${l.faction ? ` <span class="muted">(${esc(l.faction)})</span>` : ''}`).join(', ')}</p>` : ''}
    ${r.unresolvedLocations.length ? `<p class="hint">Also authored at ${esc(r.unresolvedLocations.join(', '))} — this install's town data has no match for ${r.unresolvedLocations.length === 1 ? 'it' : 'those'}, not a sign anything is wrong.</p>` : ''}
  </div>`;
}

/** The recruit's kit — the SAME loadout renderer the Loadouts page uses. */
function kitDetail(r) {
  if (!r.loadoutId) return '<p class="hint">No fixed kit — provisioning gives them a default set for their role.</p>';
  const lo = (state.loadouts || []).find((l) => l.id === r.loadoutId);
  if (!lo) return `<p class="hint">Kit "${esc(r.loadoutLabel || r.loadoutId)}" not found in this install's loadout catalogue.</p>`;
  return `<p class="hint">${esc(lo.label)} — ${esc(lo.description)}</p>${loadoutItems(lo)}`;
}

function recruitRow(r) {
  return `<details class="list-row">
    <summary><span class="item-name">${esc(r.name)}
        ${r.meitou ? '<span class="badge badge--accent">Meitou</span>' : ''}</span>
      <span class="muted">${esc(r.race)} · ${esc(r.subLabel)}, ${esc(r.tierLabel)}</span></summary>
    <div class="section-body stack">
      <p class="hint">${esc(r.blurb)}</p>
      <h4 class="group-label">${icon('stats', 'Skills')} Skills</h4>
      ${tierDetail(r)}
      <h4 class="group-label">${icon('teleport', 'Where')} Where they're found</h4>
      ${locationDetail(r)}
      <h4 class="group-label">${icon('bag', 'Kit')} Their kit</h4>
      ${kitDetail(r)}
    </div>
  </details>`;
}

export function renderRecruits() {
  const rows = state.recruits || [];
  const shown = rows.filter((r) => recruitMatches(r, state.recruitFilter));
  const groups = groupedRecruits(shown);

  return `<section class="panel" id="recruits-panel">
      <div class="panel-head"><h2>${icon('dice', 'Recruits')} Recruits</h2>
        <span class="muted">${esc(shown.length)} of ${esc(rows.length)} shown</span></div>
      <p class="hint">The "roll a recruit" catalogue — who you can find, where, and what they're worth training
        as. Editorial data plus this install's own gamedata; nothing here reads or writes a save.</p>
      ${recruitFilters(rows)}
      ${groups.length ? groups.map((g) => `<h3 class="group-label">${esc(g.label)}</h3>${g.rows.map(recruitRow).join('')}`).join('')
    : '<div class="empty-state"><strong>Nothing matches</strong>No recruit matches this search and filter.</div>'}
    </section>`;
}

export function wireRecruits() {
  const panel = document.getElementById('recruits-panel');
  if (!panel) return;

  const q = document.getElementById('recruit-q');
  if (q) q.oninput = () => {
    state.recruitFilter = { ...state.recruitFilter, q: q.value };
    render();
    const next = document.getElementById('recruit-q');
    if (next) { next.focus(); next.setSelectionRange(next.value.length, next.value.length); }
  };
  const group = document.getElementById('recruit-group');
  if (group) group.onchange = () => { state.recruitFilter = { ...state.recruitFilter, group: group.value }; render(); };
}
