import { API } from '../api-client.mjs';
import { esc, plural, showReceipt, runMutation } from '../core.mjs';
import { state, dis } from '../state.mjs';
import { icon, sectionSummary } from '../icons.mjs';
import { gearPreviewBlock, loadGearPreview } from '../gear-preview.mjs';
import { render, refresh, savePicker } from '../nav.mjs';
import { loadoutItems } from './loadouts.mjs';
import { loadoutGroups } from './bulk-equip.mjs';
import { TIER_OPTIONS, loadRaces } from './squad.mjs';

/*
 * Recruits (services/recruits.js) — the 144-entry "roll a recruit" catalogue,
 * in the spirit of the wiki's Unique Recruits page. The catalogue itself is
 * save-independent: editorial data plus this install's own gamedata (skills,
 * tiers, towns).
 *
 * The page is no longer read-only, though. Browsing 144 characters you cannot
 * hire is a reference document, not a tool, so a row's "Recruit" button opens
 * the hire card at the top of the page: pick the squad they join and the kit
 * they arrive in, see exactly what that kit is before the write, and add them.
 * That is POST .../characters — the same one call the Squad tab's "Add member"
 * makes, gear included in the same staged edit (AGENTS.md §5).
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

/**
 * A row's Recruit button lives in the `<summary>`, not in the body: it must
 * work whether or not you have opened the row to read about them, and 144
 * rows all carrying an expanded form instead would be 144 squad selects and
 * 144 name fields in the DOM. One shared hire card at the top of the page is
 * the form; this button is what points it at a recruit.
 *
 * `preventDefault()` because a click inside a `<summary>` would otherwise also
 * toggle the disclosure — choosing someone should not collapse what you were
 * reading about them.
 */
function recruitRow(r, hireable) {
  return `<details class="list-row">
    <summary><span class="item-name">${esc(r.name)}
        ${r.meitou ? '<span class="badge badge--accent">Meitou</span>' : ''}</span>
      <span class="muted">${esc(r.race)} · ${esc(r.subLabel)}, ${esc(r.tierLabel)}</span>
      ${hireable ? `<button class="btn btn--xs recruit-pick-btn" data-recruit="${esc(r.id)}">Recruit</button>` : ''}</summary>
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

// ------------------------------------------------------------ hire card --

/** The platoon files a new member can be added to, in roster order. */
function squadFiles() {
  return (state.status ? state.status.squads : []).map((q) => q.file);
}

const squadLabel = (file) => file.replace(/\.platoon$/, '');

/** The hire form's state, created empty on first touch. */
function hire() {
  state.hire = state.hire || {};
  return state.hire;
}

/**
 * A plausible default name for a recruit with no fixed one. Kenshi's own name
 * files, skipping anyone already in the squad — same pool the Squad tab's
 * "Add member" draws from.
 */
function suggestName() {
  const pool = state.namePool || [];
  if (!pool.length) return '';
  const taken = new Set((state.status ? state.status.squads : [])
    .flatMap((q) => q.characters.map((c) => (c.name || '').toLowerCase())));
  const free = pool.filter((n) => !taken.has(n.toLowerCase()));
  const from = free.length ? free : pool;
  return from[Math.floor(Math.random() * from.length)];
}

/**
 * Match a recruit's authored race against the races THIS save can actually
 * supply a donor for. A recruit's race is a preference, never a requirement:
 * a save with no Shek in it must still be able to recruit Ruka — as a Human,
 * say — rather than refuse. Returns null when nothing matches, and the card
 * says so rather than silently substituting.
 */
function matchRace(recruitRace) {
  const races = (state.races && state.races.races) || [];
  if (!recruitRace) return null;
  return races.find((x) => x.name.toLowerCase().includes(recruitRace.toLowerCase())) || null;
}

/**
 * The gear select. A recruit's own `loadoutId` is read off the game's type-1
 * character template (AGENTS.md §5), so "their own kit" is the honest default
 * for a named character — Auto is what an anonymous one gets. Both are offered
 * because "recruit Ruka, but in Shek Kingdom armour" is a real request, and so
 * is the whole 148-kit catalogue below them.
 */
function gearSelect(r, chosen) {
  const own = r.loadoutId
    ? `<option value="${esc(r.loadoutId)}" ${chosen === r.loadoutId ? 'selected' : ''}>Their own kit — ${esc(r.loadoutLabel || r.loadoutId)}</option>`
    : '';
  return `<label class="field field--grow">Arrives with
    <select id="hire-gear" ${dis()}>
      ${own}
      <option value="" ${chosen === '' ? 'selected' : ''}>Auto — matched to their role</option>
      <option value="none" ${chosen === 'none' ? 'selected' : ''}>Nothing — arrives empty-handed</option>
      ${loadoutGroups().map(([group, rows]) => `<optgroup label="${esc(group)}">
        ${rows.map((l) => `<option value="${esc(l.id)}" ${chosen === l.id ? 'selected' : ''}>${esc(l.label)}</option>`).join('')}
      </optgroup>`).join('')}
    </select></label>`;
}

/**
 * The hire card: one recruit, one squad, one kit, one write.
 *
 * It sits above the catalogue rather than inside the chosen row so the page
 * has exactly one form and exactly one receipt surface no matter which of the
 * 144 rows you came from — and so the choice you made two screens down is
 * still on screen when you commit it.
 */
function hireCard(r, files) {
  const h = hire();
  const match = matchRace(r.race);
  const races = (state.races && state.races.races) || [];
  const raceSid = h.raceSid || (match && match.sid) || (state.races && state.races.default && state.races.default.sid) || (races[0] && races[0].sid);
  const file = files.includes(h.file) ? h.file : files[0];
  const tier = h.tier || r.tier;
  const gearId = h.gearId === undefined ? (r.loadoutId || '') : h.gearId;

  return `<article class="card" id="hire-card">
    <div class="card-head">
      <h3>Recruit ${esc(r.name)}</h3>
      ${r.meitou ? '<span class="badge badge--accent">Meitou</span>' : ''}
      <span class="muted">${esc(r.race)} · ${esc(r.subLabel)}, ${esc(r.tierLabel)}</span>
      <button class="btn btn--ghost btn--xs" id="hire-clear">Cancel</button>
    </div>
    <p class="hint">${esc(r.blurb)}</p>

    <div class="field-row">
      <label class="field field--grow">Name
        <span class="actions">
          <input type="text" id="hire-name" maxlength="63" placeholder="name"
            value="${esc(h.name === undefined ? r.name : h.name)}" ${dis()}>
          <button class="btn btn--ghost btn--xs" id="hire-reroll" title="Another name">${icon('dice', 'Another name')}</button>
        </span></label>
      <label class="field">Squad
        <select id="hire-file" ${dis()}>
          ${files.map((f) => `<option value="${esc(f)}" ${file === f ? 'selected' : ''}>${esc(squadLabel(f))}</option>`).join('')}
        </select></label>
      <button class="btn btn--primary" id="hire-add" ${dis()}>Add to squad</button>
    </div>

    <div class="field-row">
      <label class="field">Race
        <select id="hire-race" ${dis()}>
          ${races.map((x) => `<option value="${esc(x.sid)}" ${raceSid === x.sid ? 'selected' : ''}>${esc(x.name)} (${esc(x.donors)})</option>`).join('')}
        </select></label>
      <label class="field">Experience
        <select id="hire-tier" ${dis()}>
          ${TIER_OPTIONS.map(([id, label]) => `<option value="${esc(id)}" ${tier === id ? 'selected' : ''}>${esc(label)}</option>`).join('')}
        </select></label>
      ${gearSelect(r, gearId)}
    </div>
    ${match ? '' : `<p class="hint note-warn">No ${esc(r.race)} lives in this save, so there is nobody of that race to
      clone from — they will join as the race selected above. Their skills and kit are unaffected.</p>`}

    <details class="section" open>
      ${sectionSummary('bag', 'What they arrive with')}
      <div class="section-body" id="hire-gear-preview">${gearPreviewBlock(h.preview, { narrow: false })}</div>
    </details>

    <p class="hint">Cloned from a living character of that race in this save (the number beside each race is how
      many). One staged edit: the character and everything they carry are written together.</p>
    <pre class="receipt" id="hire-receipt" hidden></pre>
  </article>`;
}

/**
 * The bar above the catalogue. Present whenever this save has a squad to add
 * to, so the page says what it can do before you have picked anyone —
 * an action you only discover by clicking a row is an action nobody finds.
 */
function hireSection(r, files) {
  return `<section class="summary-bar">
      <span><b>Recruit into your squad</b></span>
      <span class="muted">${r ? esc(r.name) : `Pick anyone below — they join with their own kit, into ${esc(plural(files.length, 'squad'))}.`}</span>
    </section>
    ${r ? hireCard(r, files) : ''}`;
}

export function renderRecruits() {
  const rows = state.recruits || [];
  const shown = rows.filter((r) => recruitMatches(r, state.recruitFilter));
  const groups = groupedRecruits(shown);

  // Hiring needs a save with a squad to add to and a race to clone a donor
  // from; without either the whole section is absent rather than shown broken,
  // exactly as the Loadouts tab drops its bulk panel on a save with no roster.
  const files = squadFiles();
  const canHire = !!state.save && files.length > 0 && !!(state.races && state.races.races.length);
  const chosen = canHire ? rows.find((r) => r.id === hire().recruitId) || null : null;

  return `${savePicker()}
    ${canHire ? hireSection(chosen, files) : ''}
    <section class="panel" id="recruits-panel">
      <div class="panel-head"><h2>${icon('dice', 'Recruits')} Recruits</h2>
        <span class="muted">${esc(shown.length)} of ${esc(rows.length)} shown</span></div>
      <p class="hint">The "roll a recruit" catalogue — who you can find, where, and what they're worth training
        as. Editorial data plus this install's own gamedata.${canHire ? '' : ' Pick a save with a player squad to recruit any of them.'}</p>
      ${recruitFilters(rows)}
      ${groups.length ? groups.map((g) => `<h3 class="group-label">${esc(g.label)}</h3>${g.rows.map((r) => recruitRow(r, canHire)).join('')}`).join('')
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

  // Choosing a recruit resets the form's per-recruit fields — their name, their
  // tier, their kit — rather than carrying the last person's choices onto the
  // next one. The squad is deliberately NOT reset: recruiting three people into
  // the same squad is the common case.
  document.querySelectorAll('.recruit-pick-btn').forEach((b) => {
    b.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      state.hire = { recruitId: b.dataset.recruit, file: hire().file, focus: true };
      render();
    };
  });

  wireHireCard();
}

/** The hire card's own wiring: the form, the gear preview, and the one write. */
function wireHireCard() {
  const card = document.getElementById('hire-card');
  if (!card) return;
  const receipt = document.getElementById('hire-receipt');

  if (state.panelReceipt) {
    showReceipt(receipt, state.panelReceipt.result, { label: state.panelReceipt.label });
    state.panelReceipt = null;
  }

  const r = (state.recruits || []).find((x) => x.id === hire().recruitId);
  if (!r) return;

  const nameInput = document.getElementById('hire-name');
  const raceSel = document.getElementById('hire-race');
  const tierSel = document.getElementById('hire-tier');
  const gearSel = document.getElementById('hire-gear');
  const fileSel = document.getElementById('hire-file');

  const remember = () => Object.assign(hire(), {
    name: nameInput.value,
    raceSid: raceSel.value,
    tier: tierSel.value,
    // '' = auto (the server picks by archetype/sub/tier), 'none' = provision:
    // false, anything else is a loadout id sent as an override.
    gearId: gearSel.value,
    file: fileSel.value,
  });

  const refreshGearPreview = () => loadGearPreview({
    elOf: () => document.getElementById('hire-gear-preview'),
    query: {
      archetype: r.archetype, sub: r.sub, tier: tierSel.value, raceSid: raceSel.value,
    },
    gearId: gearSel.value,
    get: () => hire().preview,
    set: (p) => { hire().preview = p; },
    narrow: false,
  });

  [nameInput, raceSel, tierSel, gearSel, fileSel].forEach((el) => {
    el.onchange = () => { remember(); refreshGearPreview(); };
  });
  nameInput.oninput = remember;

  const reroll = document.getElementById('hire-reroll');
  if (reroll) reroll.onclick = () => {
    const next = suggestName();
    if (next) { nameInput.value = next; remember(); }
  };

  const cancel = document.getElementById('hire-clear');
  if (cancel) cancel.onclick = () => { state.hire = { file: hire().file }; render(); };

  // Scrolled to only when the card was just opened from a row two screens
  // down — never on an ordinary re-render, which would yank the page around
  // after every keystroke that re-renders.
  if (hire().focus) {
    hire().focus = false;
    card.scrollIntoView({ block: 'nearest' });
  }

  refreshGearPreview();

  const addBtn = document.getElementById('hire-add');
  addBtn.onclick = () => {
    const name = nameInput.value.trim();
    if (!name) return showReceipt(receipt, new Error('Give them a name first.'));
    remember();
    const body = {
      name, raceSid: raceSel.value, archetype: r.archetype, sub: r.sub, tier: tierSel.value,
    };
    // '' (auto) sends neither field — the server's own default already
    // provisions. 'none' means provision:false; anything else is a loadoutId
    // override, which the server refuses outright if it cannot resolve it.
    if (gearSel.value === 'none') body.provision = false;
    else if (gearSel.value) body.loadoutId = gearSel.value;

    const label = `${name} joined ${squadLabel(fileSel.value)}`;
    return runMutation(addBtn, receipt, label,
      () => API.addSquadMember(state.save, fileSel.value, body),
      async (result) => {
        await refresh();
        await loadRaces();
        // Same recruit, fresh form: the name just used is now taken, so the
        // next one gets a suggestion from Kenshi's own pool (drawn AFTER the
        // refresh, so it can see who is in the squad). Keeping the card open
        // rather than clearing it is what lets the receipt below it be read.
        state.hire = { recruitId: r.id, file: fileSel.value, name: suggestName() };
        state.panelReceipt = { result, label };
        render();
      });
  };
}
