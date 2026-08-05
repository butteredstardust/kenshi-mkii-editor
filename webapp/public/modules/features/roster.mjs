import { esc, meter } from '../core.mjs';
import { state, keyOf, dis } from '../state.mjs';
import { condition, slotPips } from './squad.mjs';

export function rosterItem(c, file, { selectable = false } = {}) {
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
export function buildRoster() {
  const s = state.status;
  if (!s) return null;

  const all = s.squads.flatMap((q) => q.characters.map((c) => ({ c, file: q.file })));
  if (!all.length) return { s, all, groups: [], sel: null };

  // Default to the first character so the editor is never empty on load.
  if (!state.selected || !all.some(({ c, file }) => keyOf(file, c.sid) === state.selected)) {
    state.selected = keyOf(all[0].file, all[0].c.sid);
  }

  const f = state.filter.trim().toLowerCase();
  // Race is a filter of its own rather than part of the name search: "which of
  // these twenty are Skeletons" is the question a racially restricted item
  // raises, and typing "skeleton" into a name box would also match a character
  // called Skeleton and miss nothing else. Matched on the race SID, never the
  // name — two races in this install share a display name.
  const raceSid = state.raceFilter || '';
  const match = ({ c }) => (!f || (c.name || '').toLowerCase().includes(f) || (c.origin || '').toLowerCase().includes(f))
    && (!raceSid || (c.race && c.race.sid === raceSid));
  const shown = all.filter(match);

  const groups = s.squads
    .map((q) => ({ file: q.file, chars: q.characters.filter((c) => shown.some((x) => x.c === c)) }))
    .filter((g) => g.chars.length);

  const sel = all.find(({ c, file }) => keyOf(file, c.sid) === state.selected);

  return { s, all, groups, sel, shown };
}

/** The races present in this save's roster, most numerous first, for the filter. */
export function rosterRaces(all) {
  const byRace = new Map();
  for (const { c } of all) {
    if (!c.race) continue;
    const e = byRace.get(c.race.sid) || { sid: c.race.sid, name: c.race.name, count: 0 };
    e.count += 1;
    byRace.set(c.race.sid, e);
  }
  return [...byRace.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/**
 * Which platoon groups are expanded right now.
 *
 * A save with several squads renders one long undivided list, and the squad you
 * are actually working on is buried in it. So a group is a real disclosure: the
 * one holding the selected character is open, the rest are shut, and selecting
 * someone elsewhere moves the open group to them.
 *
 * `state.rosterOpen === null` is that automatic mode. A manual toggle
 * materialises the set and pins it, so the user can open two squads side by side
 * and keep them open — but if the selection lands in a group they closed, the
 * automatic rule takes over again rather than leaving the editor pointed at
 * somebody invisible.
 *
 * With a single group there is nothing to choose between, so it is always open.
 */
export function rosterGroupsOpen(groups) {
  const selFile = state.selected ? state.selected.split('::')[0] : null;
  if (groups.length < 2) return new Set(groups.map((g) => g.file));
  const manual = state.rosterOpen;
  if (manual && (!selFile || manual.has(selFile))) return manual;
  state.rosterOpen = null;
  const auto = groups.find((g) => g.file === selFile) || groups[0];
  return new Set(auto ? [auto.file] : []);
}

/**
 * `selectable` turns the roster into a multi-select for bulk equip. Off
 * everywhere except the Gear tab, and off there until the user asks for it, so
 * the single-character flow is untouched by default.
 */
export function rosterNav(groups, { selectable = false, races = [] } = {}) {
  // "All" selects what is SHOWN, not the whole save — with the race filter set
  // that is exactly "select every Skeleton", which is the reason the filter
  // exists. The label says so rather than leaving it to be discovered.
  const filtered = !!state.raceFilter || !!state.filter.trim();
  const bar = selectable ? `<div class="roster-select-bar">
      <span>${esc(state.selection.size)} selected</span>
      <span class="actions">
        <button class="btn btn--ghost btn--xs" id="select-all">${filtered ? 'All shown' : 'All'}</button>
        <button class="btn btn--ghost btn--xs" id="select-none">None</button>
      </span>
    </div>` : '';

  const raceBar = races.length > 1 ? `<label class="field roster-race">Race
      <select id="roster-race" ${state.raceFilter ? 'class="is-set"' : ''}>
        <option value="">All races</option>
        ${races.map((r) => `<option value="${esc(r.sid)}" ${state.raceFilter === r.sid ? 'selected' : ''}>${esc(r.name)} (${esc(r.count)})</option>`).join('')}
      </select></label>` : '';

  const open = rosterGroupsOpen(groups);

  return `<nav class="roster" aria-label="Squad roster">
    <input type="search" class="roster-filter" id="roster-filter" placeholder="Filter by name…"
      value="${esc(state.filter)}" autocomplete="off">
    ${raceBar}
    ${bar}
    ${groups.map((g) => `<details class="roster-squad" data-group="${esc(g.file)}" ${open.has(g.file) ? 'open' : ''}>
      <summary class="roster-group">
        <span>${esc(g.file.replace(/\.platoon$/, ''))}</span>
        <span class="roster-group-count">${esc(g.chars.length)}</span>
      </summary>
      <ul class="roster-list">${g.chars.map((c) => rosterItem(c, g.file, { selectable })).join('')}</ul>
    </details>`).join('')
      || '<p class="empty-state">No match.</p>'}
  </nav>`;
}
