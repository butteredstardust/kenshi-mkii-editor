import { esc, plural } from '../core.mjs';
import { sectionSummary } from '../icons.mjs';
import { EQUIP_SLOTS } from '../slots.mjs';
import { itemTable, addItemSection, packBlock } from '../items.mjs';
import { savePicker } from '../nav.mjs';
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

// Bulk equip (multi-select roster + apply-a-loadout/re-grade/unequip panel)
// used to live here. It moved to modules/features/bulk-equip.mjs, rendered by
// the Loadouts tab (loadouts.mjs) — a kit's contents are named and browsed
// right there, so applying one to several characters belongs on that page,
// not this one. This file keeps the single-character card only.

export function renderGear() {
  const r = buildRoster();
  if (!r) return '<p>No save found.</p>';
  const { all, groups, sel } = r;
  if (!all.length) return `${savePicker()}<p>No player squad in this save.</p>`;

  const detail = sel ? gearCard(sel.c, sel.file)
    : '<div class="empty-state"><strong>No character selected</strong>Pick someone from the roster to edit their gear.</div>';

  return `${savePicker()}
    <section class="summary-bar">
      <span><b>Gear</b></span>
      <span class="muted">${esc(plural(all.length, 'character'))}</span>
    </section>
    <div class="workspace">
      ${rosterNav(groups, { races: rosterRaces(all) })}
      <div id="detail">${detail}</div>
    </div>`;
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
