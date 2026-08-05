import { API } from '../api-client.mjs';
import { esc, meter, plural, showReceipt, runMutation } from '../core.mjs';
import { state, canWrite, dis } from '../state.mjs';
import { icon, RESEARCH_ICONS } from '../icons.mjs';
import { render, refresh, savePicker } from '../nav.mjs';

/*
 * Research (TODO.md 2.5).
 *
 * A save's whole research state is ONE type-21 record in quick.save, so every
 * tech on this page — however many are ticked — is a single staged edit against
 * a single record. That is why the page offers bulk selection at all: unlocking
 * ten techs one at a time would be ten backups and ten intermediate on-disk
 * states for edits that all land in the same place.
 */

function researchProgress(r) {
  const pct = r.counts.total ? Math.round((r.counts.done / r.counts.total) * 100) : 0;
  return `<div class="progress-head">
      <div class="progress-figure"><strong>${esc(r.counts.done)}</strong><span class="muted">of ${esc(r.counts.total)} techs</span></div>
      ${meter(pct)}
    </div>
    <div class="pills">
      <span class="pill"><span class="pill-key">Maxed</span><span class="pill-val">${esc(r.counts.maxed)}</span></span>
      <span class="pill"><span class="pill-key">Repeat levels</span><span class="pill-val">${esc(r.counts.extraLevels)}</span></span>
      <span class="pill"><span class="pill-key">Blueprints</span><span class="pill-val">${esc(r.counts.blueprints)}</span></span>
      <span class="pill"><span class="pill-key">Ledger rows</span><span class="pill-val">${esc(r.counts.entries)}</span></span>
    </div>
    <p class="hint hint--block">Blueprints are the other half of the same ledger — which craftable
      items are unlocked. They are counted here but not editable: nothing in the data
      says which blueprints a tech implies, so writing them would be guesswork.</p>`;
}

/** One tech's status as a badge: the only column that has to be read exactly. */
function researchBadge(t) {
  if (t.maxed && t.maxLevel > 1) return `<span class="badge badge--accent">Maxed ${esc(t.maxLevel)}/${esc(t.maxLevel)}</span>`;
  if (t.maxed) return '<span class="badge badge--accent">Researched</span>';
  if (t.done) return `<span class="badge">Level ${esc(t.atLevel)}/${esc(t.maxLevel)}</span>`;
  return '<span class="badge badge--muted">Not researched</span>';
}

function researchFilters(r) {
  const f = state.researchFilter;
  const cats = r.byCategory;
  return `<div class="field-row">
      <label class="field field--grow">Search
        <input type="search" id="research-q" placeholder="tech name or what it unlocks" value="${esc(f.q)}"></label>
      <label class="field">Branch
        <select id="research-cat">
          <option value="">All branches (${esc(r.counts.done)}/${esc(r.counts.total)})</option>
          ${cats.map((c) => `<option value="${esc(c.category)}" ${c.category === f.category ? 'selected' : ''}>${esc(c.category)} — ${esc(c.done)}/${esc(c.total)}</option>`).join('')}
        </select></label>
      <label class="field-check"><input type="checkbox" id="research-todo" ${f.onlyTodo ? 'checked' : ''}>
        Only unfinished</label>
    </div>`;
}

function researchMatches(t, f) {
  if (f.category && t.category !== f.category) return false;
  if (f.onlyTodo && t.maxed) return false;
  if (!f.q) return true;
  const q = f.q.toLowerCase();
  return t.name.toLowerCase().includes(q)
    || t.category.toLowerCase().includes(q)
    || t.description.toLowerCase().includes(q)
    || t.unlocks.some((u) => u.name.toLowerCase().includes(q));
}

/**
 * One row. The disclosure holds the description and the full unlock list —
 * detail worth having but not worth 199 rows of vertical space.
 */
function researchRow(t) {
  const picked = state.researchSel.has(t.sid);
  const cost = t.cost.map((c) => `${c.count > 1 ? `${c.count}× ` : ''}${c.name}`).join(', ');
  return `<tr data-tech="${esc(t.sid)}" ${t.maxed ? 'class="row-muted"' : ''}>
      <td class="shrink">${t.maxed ? '' : `<input type="checkbox" class="research-check" data-tech="${esc(t.sid)}" ${picked ? 'checked' : ''} ${dis()}>`}</td>
      <td class="col-item">
        <span class="item-name">${icon(RESEARCH_ICONS[t.category] || 'list', t.category)}<span>${esc(t.name)}</span></span>
        ${t.blockedBy.length ? `<div class="muted">needs ${esc(t.blockedBy.join(', '))}</div>` : ''}
      </td>
      <td class="muted">${esc(t.category)}</td>
      <td class="muted">Tier ${esc(t.level)}</td>
      <td>${researchBadge(t)}</td>
      <td class="muted">${esc(cost || '—')}</td>
      <td class="muted">${t.unlocks.length ? esc(plural(t.unlocks.length, 'item')) : '—'}</td>
      <td class="shrink"><span class="actions actions--end">
        ${t.maxed ? '<span class="muted">—</span>'
    : `<button class="btn btn--xs research-one" data-tech="${esc(t.sid)}" ${dis()}>Unlock</button>`}
      </span></td>
    </tr>`;
}

function researchTable(techs) {
  if (!techs.length) {
    return `<div class="empty-state"><strong>Nothing matches</strong>No tech matches this search and filter.</div>`;
  }
  // Not `table--compact`: eight columns capped at 46rem crushes the status and
  // cost cells into two-line stacks, and those are the two a player reads.
  return `<div class="table-wrap"><table class="data-table">
      <thead><tr>
        <th class="shrink"></th><th class="col-item">Tech</th><th>Branch</th><th>Tier</th>
        <th>Status</th><th>Costs</th><th>Unlocks</th><th class="shrink"></th>
      </tr></thead>
      <tbody>${techs.map(researchRow).join('')}</tbody>
    </table></div>`;
}

export async function renderResearch() {
  if (!state.save) return `${savePicker()}<div class="empty-state"><strong>No save</strong>No Kenshi save was found to read research from.</div>`;
  if (!state.research) {
    try {
      state.research = await API.research(state.save);
    } catch (err) {
      return `${savePicker()}<div class="empty-state"><strong>Research unavailable</strong>${esc(err.message)}</div>`;
    }
  }
  const r = state.research;
  const shown = r.techs.filter((t) => researchMatches(t, state.researchFilter));
  const picked = [...state.researchSel];

  return `${savePicker()}
    <section class="panel" id="research-panel">
      <div class="panel-head"><h2>${icon('stats', 'Research')} Research</h2>
        <span class="muted">${esc(shown.length)} of ${esc(r.techs.length)} shown</span></div>
      ${researchProgress(r)}
      ${researchFilters(r)}
      <div class="action-bar">
        <span class="action-bar-label">${icon('add', 'Unlock')} Unlock</span>
        <span class="muted" id="research-count">${esc(picked.length)} selected</span>
        <button class="btn btn--xs btn--ghost" id="research-all">Select shown</button>
        <button class="btn btn--xs btn--ghost" id="research-none">Clear</button>
        <label class="field-check"><input type="checkbox" id="research-reqs" ${state.researchReqs ? 'checked' : ''}>
          Include prerequisites</label>
        <button class="btn btn--primary" id="research-apply" ${picked.length && canWrite() ? '' : 'disabled'}>Unlock selected</button>
      </div>
      <p class="hint">Repeating techs are unlocked to their top level. Writes go through the
        mutation gate: automatic backup, staged edit, re-parse, hash compare, rollback on failure.</p>
      <pre class="receipt" id="research-receipt" hidden></pre>
      ${researchTable(shown)}
    </section>`;
}

/**
 * Research page.
 *
 * The checkbox handler deliberately does NOT re-render — 199 rows torn down and
 * rebuilt on every tick would lose scroll position halfway down a long branch.
 * Only the count and the Apply button's disabled state depend on the selection,
 * so both are patched in place, the same rule the Gear roster's multi-select
 * follows.
 */
export function wireResearch() {
  const panel = document.getElementById('research-panel');
  if (!panel) return;
  const receipt = document.getElementById('research-receipt');
  const countEl = document.getElementById('research-count');
  const applyBtn = document.getElementById('research-apply');

  if (state.panelReceipt) {
    showReceipt(receipt, state.panelReceipt.result, { label: state.panelReceipt.label });
    state.panelReceipt = null;
  }

  const syncCount = () => {
    const n = state.researchSel.size;
    countEl.textContent = `${n} selected`;
    applyBtn.disabled = !n || !canWrite();
  };

  for (const box of panel.querySelectorAll('.research-check')) {
    box.onchange = () => {
      if (box.checked) state.researchSel.add(box.dataset.tech);
      else state.researchSel.delete(box.dataset.tech);
      syncCount();
    };
  }

  const shownSids = () => [...panel.querySelectorAll('.research-check')].map((b) => b.dataset.tech);

  document.getElementById('research-all').onclick = () => {
    for (const sid of shownSids()) state.researchSel.add(sid);
    for (const box of panel.querySelectorAll('.research-check')) box.checked = true;
    syncCount();
  };
  document.getElementById('research-none').onclick = () => {
    state.researchSel.clear();
    for (const box of panel.querySelectorAll('.research-check')) box.checked = false;
    syncCount();
  };

  const reqs = document.getElementById('research-reqs');
  reqs.onchange = () => { state.researchReqs = reqs.checked; };

  // Filters re-render (they change which rows exist), and the search box has to
  // reclaim focus and the caret afterwards — render() replaces the node.
  const q = document.getElementById('research-q');
  q.oninput = () => {
    state.researchFilter = { ...state.researchFilter, q: q.value };
    render().then(() => {
      const next = document.getElementById('research-q');
      if (next) { next.focus(); next.setSelectionRange(next.value.length, next.value.length); }
    });
  };
  const cat = document.getElementById('research-cat');
  cat.onchange = () => { state.researchFilter = { ...state.researchFilter, category: cat.value }; render(); };
  const todo = document.getElementById('research-todo');
  todo.onchange = () => { state.researchFilter = { ...state.researchFilter, onlyTodo: todo.checked }; render(); };

  // A successful unlock invalidates the cached research state — the page must
  // re-read it from disk rather than trust what it just sent.
  const run = (btn, sids, label) => runMutation(btn, receipt, label,
    () => API.unlockResearch(state.save, { sids, withRequirements: state.researchReqs }),
    async (result) => {
      state.researchSel.clear();
      state.research = null;
      await refresh();
      state.panelReceipt = { result, label };
      render();
    });

  applyBtn.onclick = () => {
    const sids = [...state.researchSel];
    if (!sids.length) return undefined;
    return run(applyBtn, sids, `unlocked ${plural(sids.length, 'tech')}`);
  };

  for (const btn of panel.querySelectorAll('.research-one')) {
    btn.onclick = () => {
      const sid = btn.dataset.tech;
      const t = state.research.techs.find((x) => x.sid === sid);
      return run(btn, [sid], `unlocked ${t ? t.name : sid}`);
    };
  }

  syncCount();
}
