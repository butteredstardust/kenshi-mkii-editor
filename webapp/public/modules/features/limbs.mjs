import { API } from '../api-client.mjs';
import {
  esc, num, inputNum, meter, plural, showReceipt, runMutation,
} from '../core.mjs';
import { state, dis, canWrite } from '../state.mjs';
import { icon } from '../icons.mjs';
import { LEVEL_PRESETS, DEFAULT_ARMOUR_LEVEL, tierLabel } from '../grades.mjs';
import { render, refresh, savePicker } from '../nav.mjs';
import { buildRoster, rosterNav } from './roster.mjs';

/*
 * Limbs — which of a character's four limbs are their own, which are gone,
 * and which are prosthetics.
 *
 * This is `ints.limbs` on the MEDICAL (57) record, decoded as four 2-bit
 * fields over part slots 3,4,5,6 (see saveService.limbStateOf() for the
 * derivation and its limits). It is its own page rather than another section
 * on the Squad card because the two facts it edits — a limb's STATE and its
 * HP — are stored independently and can contradict each other, and reconciling
 * them needs the whole body in front of you at once, not one row of a table.
 *
 * The page states what the editor is sure of. "Lost" rests on 93 limbs across
 * 88 records; "robotic" rests on exactly one character. Saying so is the
 * difference between a tool and a guess.
 */

const STATE_LABELS = { own: 'Their own', lost: 'Lost', robotic: 'Prosthetic' };

/** The character's own undamaged maximum — the same rule healPart('full') uses. */
function intactMax(medical) {
  return Math.max(0, ...(medical.parts || []).map((p) => p.current));
}

/** The four limb slots, in body order; `null` when this character has none. */
function limbParts(medical) {
  return (medical.parts || []).filter((p) => p.limbState);
}

/**
 * The pending edit for one character, kept in `state.limbEdit` so it survives
 * the re-render a write triggers — same reason `trainChoice` and `bulkGear` do.
 * Keyed by "<file>::<sid>", because it is one character's body.
 */
function edit(key) {
  if (!state.limbEdit || state.limbEdit.key !== key) {
    state.limbEdit = {
      key, states: {}, flesh: {}, install: {}, keepFlesh: true,
    };
  }
  // `install` was added after the first version of this page shipped; a
  // `state.limbEdit` that survived a reload without it must not throw.
  if (!state.limbEdit.install) state.limbEdit.install = {};
  return state.limbEdit;
}

/**
 * One row per limb: what it is now, what it would become, and its condition.
 *
 * The flesh box is deliberately here rather than on the Squad card only: a
 * limb this page has just marked lost with its HP left at 100 is a save that
 * says two different things, and the fix has to be one click away from the
 * control that caused it.
 */
/**
 * The "fit a limb" row, revealed under a limb the moment it is set to
 * Prosthetic — the transition the page exists for ("missing → wearing a
 * prosthetic").
 *
 * The list is filtered to the limbs that fit THIS part, by the template's own
 * `ints.slot` (50..53 = left arm, right arm, left leg, right leg), so a right
 * leg can never be offered for a left arm. Quality is the armour ladder,
 * defaulting to Specialist, because a robot limb's `HP`/`HP 1` band is the
 * same shape armour's stats scale over — the chosen tier is named in HP terms
 * beside it rather than left as an abstract number.
 */
function fitRow(p, e, cols) {
  const pending = e.states[p.index] || p.limbState;
  if (pending !== 'robotic') return '';
  const fit = e.install[p.index] || {};
  const all = (state.limbTemplates || []).filter((l) => l.partIndex === p.index);
  if (!all.length) {
    return `<tr class="item-advanced"><td colspan="${cols}"><span class="muted">This install has no robotic limb
      that fits ${esc(p.part)}.</span></td></tr>`;
  }
  const chosen = all.find((l) => l.sid === fit.templateSid) || null;
  const level = fit.level === undefined ? DEFAULT_ARMOUR_LEVEL : fit.level;
  // HP at the chosen tier, interpolated across the limb's own band — the
  // number the tier actually buys, stated in the limb's terms.
  const hpAt = chosen && chosen.hp != null && chosen.hpMax != null
    ? Math.round(chosen.hp + ((chosen.hpMax - chosen.hp) * (Math.max(0, Math.min(100, level)) / 100)))
    : null;

  return `<tr class="item-advanced" data-fit="${esc(p.index)}">
    <td colspan="${cols}">
      <div class="field-row">
        <label class="field field--grow">Limb to fit
          <select class="limb-fit" data-part="${esc(p.index)}" ${dis()}>
            <option value="">None — just record the state</option>
            ${all.map((l) => `<option value="${esc(l.sid)}" ${fit.templateSid === l.sid ? 'selected' : ''}>${esc(l.name)}${l.hpMax != null ? ` — up to ${esc(l.hpMax)} HP` : ''}</option>`).join('')}
          </select></label>
        <label class="field">Quality
          <select class="limb-fit-level" data-part="${esc(p.index)}" data-nofilter ${dis()}>
            ${LEVEL_PRESETS.map(([v, label]) => `<option value="${esc(v)}" ${level === v ? 'selected' : ''}>${esc(label)} (${esc(v)})</option>`).join('')}
          </select></label>
        ${chosen ? `<span class="hint">${esc(tierLabel(level))}${hpAt != null ? ` — about ${esc(hpAt)} HP of ${esc(chosen.hpMax)}` : ''}</span>` : ''}
      </div>
    </td>
  </tr>`;
}

function limbRow(p, e, cols) {
  const pending = e.states[p.index] || p.limbState;
  const changed = pending !== p.limbState;
  const flesh = e.flesh[p.index];
  const fleshChanged = flesh !== undefined && Math.abs(flesh - p.current) > 0.005;

  return `<tr data-part="${esc(p.index)}">
    <td>${esc(p.part)}
      ${changed ? `<div class="muted">${esc(STATE_LABELS[p.limbState])} → <b>${esc(STATE_LABELS[pending])}</b></div>` : ''}</td>
    <td class="shrink">
      <select class="limb-state" data-part="${esc(p.index)}" data-nofilter ${dis()}>
        ${Object.entries(STATE_LABELS).map(([id, label]) => `<option value="${esc(id)}" ${pending === id ? 'selected' : ''}>${esc(label)}</option>`).join('')}
      </select></td>
    <td class="col-meter">${meter(p.percentOfIntact)}</td>
    <td class="n">${num(p.current)}</td>
    <td class="shrink"><input type="number" class="limb-flesh w-sm" data-part="${esc(p.index)}" step="0.1"
      value="${esc(inputNum(flesh === undefined ? p.current : flesh))}" ${dis()}></td>
    <td class="shrink muted">${fleshChanged ? `→ ${esc(num(flesh))}` : ''}</td>
  </tr>
  ${fitRow(p, e, cols)}`;
}

/**
 * What this page will actually write, spelled out before the write — the same
 * "name the consequence first" rule the bulk pre-flight follows. A limb going
 * from own to lost is the one irreversible thing here, so it is named in
 * `.note-warn`, and the button below it is `.btn--danger` when it is present.
 */
function preflight(parts, e) {
  const rows = [];
  for (const p of parts) {
    const to = e.states[p.index] || p.limbState;
    const flesh = e.flesh[p.index];
    const fit = e.install[p.index];
    const bits = [];
    if (to !== p.limbState) bits.push(`${STATE_LABELS[p.limbState]} → ${STATE_LABELS[to]}`);
    if (flesh !== undefined && Math.abs(flesh - p.current) > 0.005) bits.push(`HP ${num(p.current)} → ${num(flesh)}`);
    if (to === 'robotic' && fit && fit.templateSid) {
      const limb = (state.limbTemplates || []).find((l) => l.sid === fit.templateSid);
      bits.push(`fit ${limb ? limb.name : fit.templateSid} at ${tierLabel(fit.level ?? DEFAULT_ARMOUR_LEVEL)}`);
    }
    if (bits.length) rows.push({ part: p.part, text: bits.join(', '), losing: to === 'lost' && p.limbState !== 'lost' });
  }
  if (!rows.length) return '<p class="hint">Nothing changed yet.</p>';
  return `<div class="preflight">${rows.map((r) => `<div class="preflight-row">
      <span class="who">${esc(r.part)}</span>
      <span class="what">${esc(r.text)}
        ${r.losing ? '<div class="note-warn">This limb is severed. In game it does not grow back — only a prosthetic replaces it.</div>' : ''}</span>
    </div>`).join('')}</div>`;
}

function limbCard(c, file) {
  const m = c.medical;
  const key = `${file}::${c.sid}`;
  const e = edit(key);
  const parts = limbParts(m);
  const max = intactMax(m);

  if (!parts.length) {
    return `<article class="card" id="limb-card">
      <div class="card-head"><h3>${esc(c.name)}</h3></div>
      <p class="hint">This character's MEDICAL record has no limb slots, so there is nothing to edit here.</p>
    </article>`;
  }

  const lost = parts.filter((p) => p.limbState === 'lost').length;
  const robotic = parts.filter((p) => p.limbState === 'robotic').length;
  const losing = parts.some((p) => (e.states[p.index] || p.limbState) === 'lost' && p.limbState !== 'lost');

  return `<article class="card" id="limb-card" data-file="${esc(file)}" data-sid="${esc(c.sid)}">
    <div class="card-head">
      <h3>${esc(c.name)}</h3>
      ${lost ? `<span class="badge badge--danger">${esc(plural(lost, 'limb'))} lost</span>` : ''}
      ${robotic ? `<span class="badge badge--accent">${esc(plural(robotic, 'prosthetic'))}</span>` : ''}
      <span class="muted">${esc(c.race ? c.race.name : '')}</span>
    </div>

    <div class="table-wrap"><table class="data-table table--compact">
      <caption>Condition is relative to this character's own undamaged parts (${esc(num(max))}), not to
        <code>hit&lt;n&gt;</code>.</caption>
      <thead><tr>
        <th>Limb</th><th class="shrink">State</th><th class="col-meter">Condition</th>
        <th class="n">HP</th><th class="shrink">Set HP</th><th class="shrink"></th>
      </tr></thead>
      <tbody>${parts.map((p) => limbRow(p, e, 6)).join('')}</tbody>
    </table></div>

    <div class="field-row">
      <label class="field-check">
        <input type="checkbox" id="limb-keep-flesh" ${e.keepFlesh ? 'checked' : ''}>
        Move HP to match the state
      </label>
      <span class="actions">
        <button class="btn btn--ghost" id="limb-reset">Reset</button>
        <button class="btn ${losing ? 'btn--danger' : 'btn--primary'}" id="limb-apply" ${dis()} disabled>Apply</button>
      </span>
    </div>
    <p class="hint">With that ticked, marking a limb lost also drops its HP to −${esc(num(max))} — the negative-of-maximum
      value the game itself writes — and restoring one raises it back to ${esc(num(max))}. Untick it to set the two
      independently; the save stores them independently, and a lost limb reading full HP is a real state this editor
      can produce.</p>
    <p class="hint">Setting a limb to <b>Prosthetic</b> records the state and, if you pick one, puts that robot limb in
      their inventory at the quality you chose. It goes in <b>Carried</b>, not onto the body: no save on this machine
      contains a single robot-limb item, including the character who has three prosthetics fitted, so the game appears
      to consume the object when the limb goes on and this editor does not invent a place for it.</p>

    <div id="limb-preflight">${preflight(parts, e)}</div>
    <pre class="receipt" id="limb-receipt" hidden></pre>
  </article>`;
}

/**
 * What the editor knows, and how well. `limbs` is shown raw because this page
 * asserts a meaning for a number nobody documented — the player can check the
 * claim against their own file.
 */
function evidenceNote(c) {
  const raw = c && c.medical ? c.medical.limbs : null;
  return `<section class="panel" id="limb-evidence">
    <div class="panel-head"><h2>${icon('identity', 'How this is read')} How this is read</h2>
      <span class="muted">${raw == null ? 'no limbs value on this record' : `limbs = ${esc(raw)}`}</span></div>
    <p class="hint">A save stores this as one integer on the MEDICAL record: four 2-bit fields, one per limb, in
      body order. It was derived from every character in every save on this machine — 4995 medical records, 88 of
      which carry the value. <b>Lost</b> is solid: 82 of the 93 limbs flagged that way have negative HP, and the
      flagged limb is the worst-off one in 83 of the 88 records. <b>Prosthetic</b> is the weak half — exactly one
      character in the corpus has any, and nothing else in the record distinguishes a prosthetic from a healthy
      limb. Treat it as this editor's best reading, not as documentation.</p>
  </section>`;
}

export function renderLimbs() {
  const r = buildRoster();
  if (!r) return '<p>No save found.</p>';
  const { all, groups, sel } = r;
  if (!all.length) return `${savePicker()}<p>No player squad in this save.</p>`;

  return `${savePicker()}
    <div class="workspace">
      <div class="side">${rosterNav(groups)}</div>
      <div id="detail">
        ${sel && sel.c.medical ? limbCard(sel.c, sel.file)
    : '<div class="empty-state"><strong>No character selected</strong>Pick someone from the roster to see their limbs.</div>'}
        ${sel ? evidenceNote(sel.c) : ''}
      </div>
    </div>`;
}

let loadingLimbs = false;

export function wireLimbs() {
  const card = document.getElementById('limb-card');
  if (!card) return;

  // The limb catalogue is save-independent and only this page needs it, so it
  // is fetched on first view rather than at boot — the same rule the
  // Acknowledgements page follows. `loadingLimbs` guards the re-render the
  // response triggers from firing a second request.
  if (!state.limbTemplates && !loadingLimbs) {
    loadingLimbs = true;
    API.limbTemplates()
      .then((r) => { state.limbTemplates = r.limbs; })
      .catch(() => { state.limbTemplates = []; })
      .finally(() => { loadingLimbs = false; render(); });
  }
  const receipt = document.getElementById('limb-receipt');

  if (state.panelReceipt) {
    showReceipt(receipt, state.panelReceipt.result,
      { label: state.panelReceipt.label, details: state.panelReceipt.details });
    state.panelReceipt = null;
  }

  const { file, sid } = card.dataset;
  if (!file) return; // the "no limb slots" card has nothing to wire
  const key = `${file}::${sid}`;
  const e = edit(key);
  const c = (state.status.squads.find((q) => q.file === file) || { characters: [] })
    .characters.find((x) => x.sid === sid);
  if (!c) return;
  const parts = limbParts(c.medical);
  const max = intactMax(c.medical);
  const applyBtn = document.getElementById('limb-apply');
  const preflightEl = document.getElementById('limb-preflight');
  const keepBox = document.getElementById('limb-keep-flesh');

  // Repainted imperatively, like every other pre-flight in this app: a full
  // render() on each keystroke would tear down the number field mid-type.
  const sync = () => {
    const dirty = parts.some((p) => (e.states[p.index] && e.states[p.index] !== p.limbState)
      || (e.flesh[p.index] !== undefined && Math.abs(e.flesh[p.index] - p.current) > 0.005)
      || ((e.states[p.index] || p.limbState) === 'robotic'
        && e.install[p.index] && e.install[p.index].templateSid));
    applyBtn.disabled = !dirty || !canWrite();
    // The tier follows the consequence: severing a limb is irreversible in
    // game, so the button says so before it is pressed (style guide §3).
    const losing = parts.some((p) => (e.states[p.index] || p.limbState) === 'lost' && p.limbState !== 'lost');
    applyBtn.classList.toggle('btn--danger', losing);
    applyBtn.classList.toggle('btn--primary', !losing);
    if (preflightEl) preflightEl.innerHTML = preflight(parts, e);
  };

  // The fitting controls only exist while a limb is set to Prosthetic, so they
  // are re-rendered (not just re-synced) when a state changes — hence the
  // render() in the state handler below rather than an imperative patch.
  card.querySelectorAll('.limb-fit').forEach((selEl) => {
    selEl.onchange = () => {
      const i = Number(selEl.dataset.part);
      const held = e.install[i] || {};
      if (!selEl.value) delete e.install[i];
      else e.install[i] = { ...held, templateSid: selEl.value, level: held.level ?? DEFAULT_ARMOUR_LEVEL };
      render();
    };
  });
  card.querySelectorAll('.limb-fit-level').forEach((selEl) => {
    selEl.onchange = () => {
      const i = Number(selEl.dataset.part);
      e.install[i] = { ...(e.install[i] || {}), level: Number(selEl.value) };
      render();
    };
  });

  card.querySelectorAll('.limb-state').forEach((selEl) => {
    selEl.onchange = () => {
      const i = Number(selEl.dataset.part);
      const p = parts.find((x) => x.index === i);
      e.states[i] = selEl.value;
      // A limb that is no longer a prosthetic cannot have one fitted to it.
      if (selEl.value !== 'robotic') delete e.install[i];
      // Keeping the two consistent is a default, not a rule — see the hint
      // under the table, and `keepFlesh` above.
      if (e.keepFlesh) {
        if (selEl.value === 'lost') e.flesh[i] = -max;
        else if (p.current < 0) e.flesh[i] = max;
        else delete e.flesh[i];
      }
      // A full re-render, not a patch: the "limb to fit" row exists only while
      // this limb is a prosthetic, so changing the state changes which
      // controls the table has. Everything typed so far lives in
      // `state.limbEdit`, so nothing is lost by redrawing.
      render();
    };
  });

  card.querySelectorAll('.limb-flesh').forEach((input) => {
    input.oninput = () => {
      const i = Number(input.dataset.part);
      const v = Number(input.value);
      if (input.value === '' || !Number.isFinite(v)) delete e.flesh[i];
      else e.flesh[i] = v;
      sync();
    };
  });

  if (keepBox) keepBox.onchange = () => { e.keepFlesh = keepBox.checked; };

  const reset = document.getElementById('limb-reset');
  if (reset) reset.onclick = () => { state.limbEdit = null; render(); };

  applyBtn.onclick = () => {
    const states = {};
    const flesh = {};
    const install = {};
    for (const p of parts) {
      if (e.states[p.index] && e.states[p.index] !== p.limbState) states[p.index] = e.states[p.index];
      if (e.flesh[p.index] !== undefined && Math.abs(e.flesh[p.index] - p.current) > 0.005) flesh[p.index] = e.flesh[p.index];
      const fit = e.install[p.index];
      // The server refuses a fitting onto a limb that is not robotic, so the
      // state has to travel with it even when it is not itself changing.
      if (fit && fit.templateSid && (e.states[p.index] || p.limbState) === 'robotic') {
        install[p.index] = { templateSid: fit.templateSid, level: fit.level ?? DEFAULT_ARMOUR_LEVEL };
        states[p.index] = 'robotic';
      }
    }
    if (!Object.keys(states).length && !Object.keys(flesh).length && !Object.keys(install).length) {
      return showReceipt(receipt, new Error('Change a limb first.'));
    }
    // Every state the server accepts has to be sent as a state, even when only
    // the HP moved — setLimbs() writes the whole int, and sending a partial map
    // is how a limb would silently revert to "own".
    const losing = Object.entries(states).filter(([i, s]) => s === 'lost'
      && parts.find((p) => p.index === Number(i)).limbState !== 'lost');
    if (losing.length && !confirm(`Sever ${losing.map(([i]) => parts.find((p) => p.index === Number(i)).part).join(', ')} on ${c.name}?\n\n`
      + 'A severed limb does not grow back in game — only a prosthetic replaces it. '
      + 'The only way back is the automatic backup.')) return undefined;

    const label = `limbs set on ${c.name}`;
    return runMutation(applyBtn, receipt, label,
      () => API.setLimbs(state.save, file, sid, { states, flesh, install }),
      async (result) => {
        await refresh();
        state.limbEdit = null;
        state.panelReceipt = { result, label, details: limbDetails(result) };
        render();
      },
      { details: limbDetails });
  };

  sync();
}

/** The receipt's own lines: what the int went from and to, and which HP moved. */
function limbDetails(result) {
  const r = (result.receipts || [])[0];
  if (!r || !r.states) return null;
  const lines = [`limbs ${r.before.limbs ?? 'absent'} → ${r.after.limbs ?? 'absent'}`];
  for (const [slot, s] of Object.entries(r.states)) lines.push(`  part ${slot}: ${STATE_LABELS[s] || s}`);
  for (const [slot, v] of Object.entries(r.after.parts || {})) {
    lines.push(`  part ${slot} HP: ${num(r.before.parts[slot])} → ${num(v)}`);
  }
  for (const f of r.fitted || []) {
    lines.push(`  fitted ${f.name} to part ${f.partIndex}${f.level != null ? ` at level ${f.level}` : ''} — carried, as the item`);
  }
  return lines;
}
