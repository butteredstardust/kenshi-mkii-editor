import { API } from '../api-client.mjs';
import { esc, num, inputNum, plural, showReceipt, runMutation } from '../core.mjs';
import { state, canWrite, dis } from '../state.mjs';
import { icon, sectionSummary } from '../icons.mjs';
import { render, savePicker } from '../nav.mjs';

/*
 * Factions (services/factionsService.js).
 *
 * Two things a player wants and the save records separately:
 *
 *  1. **How everyone feels about me.** Stored on the OTHER faction's record —
 *     the player's own type-37 record carries no relation rows at all — so this
 *     page is a list of 113 factions each with one editable number.
 *  2. **How they feel about each other.** The same mechanism one hop over, so
 *     it is the same table behind a disclosure rather than a second page.
 *
 * Both feed ONE pending-edit map and ONE Apply. Every relation in a save lives
 * in the same quick.save, so N separate writes would mean N backups and N
 * intermediate on-disk states for edits that all land in one file — the same
 * reason the Research page batches (style guide §4 "one row, one commit",
 * applied at panel scale).
 */

// Standing -> label and badge tier. The BANDS come from the faction's own
// `enemy classification`/`business relations` ints and are resolved server-side;
// this only says which of the four intent tiers each word belongs to (style
// guide §3 — danger for "attacks you", warn for degraded, accent for good).
const STANDINGS = {
  hostile: ['Hostile', 'badge--danger'],
  unfriendly: ['Will not trade', 'badge--warn'],
  wary: ['Wary', 'badge--warn'],
  neutral: ['Neutral', 'badge--muted'],
  friendly: ['Friendly', 'badge--accent'],
  allied: ['Allied', 'badge--accent'],
};

// Quick values for the number input. Deliberately the round numbers Kenshi's
// own data uses (-100/-50/0/50/100 account for 12669 of the fixture's 12882
// rows) rather than invented gradations.
const RELATION_PRESETS = [
  ['100', 'Allied'], ['50', 'Friendly'], ['0', 'Neutral'], ['-50', 'Unfriendly'], ['-100', 'Hostile'],
];

const editKey = (from, to) => `${from}|${to}`;

/**
 * The standing word. The NUMBER behind it is deliberately not repeated here:
 * every editable row already shows it, two cells to the right, in the input the
 * user is about to change — printing "NEUTRAL 0.0" beside an input reading 0
 * put the same figure on screen twice and made the row look like it had two
 * different values. A row that cannot be edited has no input, so that one keeps
 * the number.
 */
function standingBadge(standing, relation, editable) {
  const [label, cls] = STANDINGS[standing] || [standing, 'badge--muted'];
  return `<span class="badge ${cls}">${esc(label)}</span>
    ${editable ? '' : `<span class="muted">${esc(num(relation))}</span>`}`;
}

/**
 * The editable cell for one directional relation. `data-initial` is what the
 * save holds; the Apply button diffs against it, so a value typed back to where
 * it started correctly contributes nothing (style guide §4).
 */
function relationInput(from, to, relation, editable) {
  if (!editable) return '<span class="muted">—</span>';
  const key = editKey(from, to);
  const pending = state.factionEdits.get(key);
  return `<span class="actions">
      <input type="number" class="relation-input w-sm" min="-100" max="100" step="1"
        data-from="${esc(from)}" data-to="${esc(to)}" data-initial="${esc(inputNum(relation))}"
        value="${esc(pending === undefined ? inputNum(relation) : inputNum(pending))}" ${dis()}>
      <select class="relation-preset" data-key="${esc(key)}" ${dis()} aria-label="Preset">
        <!-- Named, not "…": this control appears on all 113 rows, and a
             dropdown whose only visible text is an ellipsis is a control the
             reader has to open to find out what it does. -->
        <option value="">Set…</option>
        ${RELATION_PRESETS.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}
      </select>
    </span>`;
}

/**
 * The two tables share the standing/engine-faction filters — those describe
 * kinds of faction, which mean the same thing in both — but each owns its own
 * search text. Sharing that made typing "Holy" into the top box silently cut the
 * drill-down to two rows, which reads as a broken table rather than a filter.
 * "Only ones I've met" is player-relative and applies to the top table alone.
 */
function factionMatches(f, view) {
  const q = state.factionFilter;
  if (q.hideDebug && f.notReal) return false;
  if (!view && q.onlyMet && !f.met) return false;
  if (q.standing && f.standing !== q.standing) return false;
  const text = view ? q.viewQ : q.q;
  if (!text) return true;
  return f.name.toLowerCase().includes(text.toLowerCase());
}

/** The player-facing table: every faction's standing toward the player. */
function factionTable(r) {
  const shown = r.factions.filter((f) => factionMatches(f, false));
  if (!shown.length) {
    return '<div class="empty-state"><strong>Nothing matches</strong>No faction matches this search and filter.</div>';
  }
  return `<div class="table-wrap"><table class="data-table">
      <thead><tr>
        <th class="col-item">Faction</th><th>Standing</th><th>Met</th>
        <th class="n">Turns hostile at</th><th class="shrink">Relation</th><th class="shrink"></th>
      </tr></thead>
      <tbody>${shown.map((f) => `<tr${f.notReal ? ' class="row-muted"' : ''}>
        <td class="col-item">${esc(f.name)}
          ${f.notReal ? '<div class="muted">engine utility faction, not a real one</div>' : ''}</td>
        <td>${standingBadge(f.standing, f.relation, f.editable)}</td>
        <td class="muted">${f.met ? 'yes' : 'not yet'}</td>
        <td class="muted n">${esc(f.enemyAt)}</td>
        <td class="shrink">${relationInput(f.sid, r.player.gamedataSid, f.relation, f.editable)}</td>
        <td class="shrink"><span class="actions actions--end">
          <button class="btn btn--xs btn--ghost faction-open" data-faction="${esc(f.sid)}">Their view</button>
        </span></td>
      </tr>`).join('')}</tbody>
    </table></div>`;
}

/** The drill-down: one faction's outgoing list. Same edit mechanism. */
function factionViewTable() {
  const v = state.factionView;
  if (!v) return '<p class="hint">Pick a faction to see how it sees everyone else.</p>';
  const shown = v.relations.filter((f) => factionMatches(f, true));
  return `<p class="hint">How <strong>${esc(v.faction.name)}</strong> sees everyone else. This is the other
      direction and it is not a mirror — a faction can hate someone who is indifferent to it.
      ${esc(v.faction.name)} turns hostile at ${esc(v.faction.enemyAt)} and stops trading below
      ${esc(v.faction.tradeAt)}.</p>
    <label class="field field--grow">Search
      <input type="search" id="faction-view-q" placeholder="faction name"
        value="${esc(state.factionFilter.viewQ)}"></label>
    <div class="table-wrap"><table class="data-table">
      <thead><tr><th class="col-item">Toward</th><th>Standing</th><th class="shrink">Relation</th></tr></thead>
      <tbody>${shown.map((f) => `<tr${f.notReal || f.isSelf ? ' class="row-muted"' : ''}>
        <td class="col-item">${esc(f.name)}
          ${f.isPlayer ? '<div class="muted">your squad</div>' : ''}
          ${f.isSelf ? '<div class="muted">itself — always 100, not editable</div>' : ''}</td>
        <td>${standingBadge(f.standing, f.relation, f.editable)}</td>
        <td class="shrink">${relationInput(v.faction.sid, f.sid, f.relation, f.editable)}</td>
      </tr>`).join('') || '<tr><td colspan="3" class="muted">Nothing matches.</td></tr>'}</tbody>
    </table></div>`;
}

export async function renderFactions() {
  if (!state.save) return `${savePicker()}<div class="empty-state"><strong>No save</strong>No Kenshi save was found to read factions from.</div>`;
  if (!state.factions) {
    try {
      state.factions = await API.factions(state.save);
    } catch (err) {
      return `${savePicker()}<div class="empty-state"><strong>Factions unavailable</strong>${esc(err.message)}</div>`;
    }
  }
  const r = state.factions;
  const c = r.counts;
  const pending = state.factionEdits.size;

  return `${savePicker()}
    <section class="panel" id="factions-panel">
      <div class="panel-head"><h2>${icon('squad', 'Factions')} Factions</h2>
        <span class="muted">${esc(c.total)} factions · ${esc(c.met)} met</span></div>

      <div class="pills">
        <span class="pill"><span class="pill-key">Squad</span><span class="pill-val">${esc(r.player.name)}</span></span>
        <span class="pill-sep"></span>
        <span class="pill"><span class="pill-key">Hostile</span><span class="pill-val">${esc(c.hostile)}</span></span>
        <span class="pill"><span class="pill-key">Unfriendly</span><span class="pill-val">${esc(c.unfriendly)}</span></span>
        <span class="pill"><span class="pill-key">Neutral</span><span class="pill-val">${esc(c.neutral)}</span></span>
        <span class="pill"><span class="pill-key">Friendly</span><span class="pill-val">${esc(c.friendly)}</span></span>
        <span class="pill"><span class="pill-key">Allied</span><span class="pill-val">${esc(c.allied)}</span></span>
      </div>

      <div class="field-row">
        <label class="field field--grow">Search
          <input type="search" id="faction-q" placeholder="faction name" value="${esc(state.factionFilter.q)}"></label>
        <label class="field">Standing
          <select id="faction-standing">
            <option value="">Any</option>
            ${Object.entries(STANDINGS).map(([k, [label]]) => `<option value="${esc(k)}" ${state.factionFilter.standing === k ? 'selected' : ''}>${esc(label)}</option>`).join('')}
          </select></label>
        <label class="field-check"><input type="checkbox" id="faction-met" ${state.factionFilter.onlyMet ? 'checked' : ''}>
          Only ones I've met</label>
        <label class="field-check"><input type="checkbox" id="faction-debug" ${state.factionFilter.hideDebug ? 'checked' : ''}>
          Hide engine factions</label>
      </div>

      <div class="action-bar">
        <span class="action-bar-label">${icon('rename', 'Apply')} Changes</span>
        <span class="muted" id="faction-count">${esc(pending)} pending</span>
        <button class="btn btn--xs btn--ghost" id="faction-reset">Discard</button>
        <button class="btn btn--primary" id="faction-apply" ${pending && canWrite() ? '' : 'disabled'}>Apply changes</button>
      </div>
      <p class="hint">A relation is directional and lives on the <em>other</em> faction's record — your
        own carries none. Values run -100 to 100; the "turns hostile at" column is that faction's own
        threshold from gamedata, not a rule this editor invented. Every pending change is written in one
        staged edit through the mutation gate.
        ${c.met < c.total ? `${esc(plural(c.total - c.met, 'faction'))} you have not met can still be edited, but the
          game will not show them to you until you run into them.` : ''}</p>
      <pre class="receipt" id="faction-receipt" hidden></pre>

      ${factionTable(r)}

      <details class="section" id="faction-view-section" ${state.factionFocus ? 'open' : ''}>
        ${sectionSummary('list', 'Between other factions')}
        <div class="section-body">
          <label class="field field--grow">Faction
            <select id="faction-focus">
              <option value="">choose…</option>
              ${factionFocusOptions(r.factions)}
            </select></label>
          <div id="faction-view">${factionViewTable()}</div>
        </div>
      </details>
    </section>`;
}

/**
 * The 114 factions, grouped for the drill-down picker.
 *
 * Three headings, in the order they matter to the reader: the ones this save
 * has actually met, the ones it has not, and the debug/placeholder records the
 * catalogue marks `notReal` (which are real rows in the file and must stay
 * reachable, but are never what someone is looking for). The same three
 * distinctions the table above already filters on — this only makes them
 * visible in the dropdown too.
 */
function factionFocusOptions(factions) {
  const groups = [
    ['Met', factions.filter((f) => !f.notReal && f.met)],
    ['Not yet met', factions.filter((f) => !f.notReal && !f.met)],
    ['Placeholder / debug', factions.filter((f) => f.notReal)],
  ];
  return groups.filter(([, rows]) => rows.length).map(([label, rows]) => `<optgroup label="${esc(label)}">
    ${rows.map((f) => `<option value="${esc(f.sid)}" ${f.sid === state.factionFocus ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}
  </optgroup>`).join('');
}

/**
 * Factions page.
 *
 * Like Research, the per-row handlers deliberately do NOT re-render: 113 rows
 * rebuilt on every keystroke would take the focused number input with them. The
 * pending-edit map and the two things that depend on its size (the count and
 * the Apply button) are patched in place instead. Only the write re-renders.
 */
export function wireFactions() {
  const panel = document.getElementById('factions-panel');
  if (!panel) return;
  const receipt = document.getElementById('faction-receipt');
  const countEl = document.getElementById('faction-count');
  const applyBtn = document.getElementById('faction-apply');

  if (state.panelReceipt) {
    showReceipt(receipt, state.panelReceipt.result, {
      label: state.panelReceipt.label, details: state.panelReceipt.details,
    });
    state.panelReceipt = null;
  }

  const syncCount = () => {
    countEl.textContent = `${state.factionEdits.size} pending`;
    applyBtn.disabled = !state.factionEdits.size || !canWrite();
  };

  // One input's pending value. Typing back to the saved value REMOVES the entry
  // rather than queueing a no-op, so "3 pending" always means three real
  // changes and the gate never sees an edit that produces no change.
  const trackInput = (input) => {
    const key = editKey(input.dataset.from, input.dataset.to);
    const initial = Number(input.dataset.initial);
    const value = Number(input.value);
    if (input.value === '' || !Number.isFinite(value)) { state.factionEdits.delete(key); return syncCount(); }
    if (value === initial) state.factionEdits.delete(key);
    else state.factionEdits.set(key, Math.max(-100, Math.min(100, value)));
    return syncCount();
  };

  const wireRows = (root) => {
    for (const input of root.querySelectorAll('.relation-input')) {
      input.oninput = () => trackInput(input);
    }
    for (const sel of root.querySelectorAll('.relation-preset')) {
      sel.onchange = () => {
        if (!sel.value) return;
        const input = sel.parentElement.querySelector('.relation-input');
        input.value = sel.value;
        sel.value = '';
        trackInput(input);
      };
    }
    for (const btn of root.querySelectorAll('.faction-open')) {
      btn.onclick = () => { state.factionFocus = btn.dataset.faction; loadView(); };
    }
  };

  const viewEl = document.getElementById('faction-view');
  const focusSel = document.getElementById('faction-focus');

  // The drill-down redraws ITSELF rather than calling render(): a full pass
  // would tear down the panel and lose both the scroll position and the caret
  // in whichever box is being typed into (style guide §4, "Pickers").
  const drawView = ({ refocus = false } = {}) => {
    viewEl.innerHTML = factionViewTable();
    wireRows(viewEl);
    const q = document.getElementById('faction-view-q');
    if (q) {
      q.oninput = () => { state.factionFilter.viewQ = q.value; drawView({ refocus: true }); };
      if (refocus) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
    }
  };

  const loadView = async () => {
    const section = document.getElementById('faction-view-section');
    if (section) section.open = true;
    if (focusSel) focusSel.value = state.factionFocus || '';
    if (!state.factionFocus) { state.factionView = null; drawView(); return; }
    const sid = state.factionFocus;
    viewEl.innerHTML = '<p class="hint">Loading…</p>';
    try {
      const v = await API.factionRelations(state.save, sid);
      if (state.factionFocus !== sid) return; // a newer selection won
      state.factionView = v;
      drawView();
    } catch (err) {
      viewEl.innerHTML = '';
      showReceipt(receipt, err);
    }
  };

  wireRows(panel);
  if (focusSel) focusSel.onchange = () => { state.factionFocus = focusSel.value || null; loadView(); };
  // A view already in state was rendered into the HTML above but its own
  // controls are not wired yet; one with no data still needs fetching.
  if (state.factionFocus && !state.factionView) loadView();
  else drawView();

  // Filters re-render (the table is what they change), so pending edits have to
  // survive in state — which is exactly why they live in state.factionEdits and
  // not in the DOM.
  const q = document.getElementById('faction-q');
  if (q) q.oninput = () => {
    state.factionFilter.q = q.value;
    render();
    const next = document.getElementById('faction-q');
    if (next) { next.focus(); next.setSelectionRange(next.value.length, next.value.length); }
  };
  const standing = document.getElementById('faction-standing');
  if (standing) standing.onchange = () => { state.factionFilter.standing = standing.value; render(); };
  const met = document.getElementById('faction-met');
  if (met) met.onchange = () => { state.factionFilter.onlyMet = met.checked; render(); };
  const debug = document.getElementById('faction-debug');
  if (debug) debug.onchange = () => { state.factionFilter.hideDebug = debug.checked; render(); };

  const reset = document.getElementById('faction-reset');
  if (reset) reset.onclick = () => { state.factionEdits.clear(); render(); };

  applyBtn.onclick = () => {
    const changes = [...state.factionEdits.entries()].map(([key, relation]) => {
      const [from, to] = key.split('|');
      return { from, to, relation };
    });
    if (!changes.length) return showReceipt(receipt, new Error('Change a relation first.'));
    const label = changes.length === 1 ? '1 relation set' : `${changes.length} relations set`;
    return runMutation(applyBtn, receipt, label,
      () => API.setFactionRelations(state.save, changes),
      async (result) => {
        // A successful write re-renders (every badge and standing count moves),
        // which replaces the .receipt element the result was just written into —
        // so stash it for the next wire() to re-attach, the same trick the
        // character cards use.
        state.factionEdits.clear();
        state.factions = null;
        state.factionView = null;
        state.panelReceipt = { result, label, details: factionDetails(result) };
        render();
      },
      { details: factionDetails });
  };

  syncCount();
}

/** Turn a relation receipt into readable before -> after lines. */
function factionDetails(result) {
  const r = (result.receipts || [])[0];
  if (!r || !r.changed) return null;
  return r.changed.map((c) => `${c.fromName} → ${c.toName}: ${num(c.before)} → ${num(c.after)} (${c.standing})`);
}
