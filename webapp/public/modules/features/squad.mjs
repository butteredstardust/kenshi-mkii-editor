import { API } from '../api-client.mjs';
import {
  esc, num, inputNum, meter, plural, showReceipt, runMutation,
} from '../core.mjs';
import { state, dis } from '../state.mjs';
import { icon, sectionSummary } from '../icons.mjs';
import { EQUIP_SLOTS, SLOT_LABELS } from '../slots.mjs';
import { inventorySection } from '../items.mjs';
import { render, refresh, savePicker } from '../nav.mjs';
import { buildRoster, rosterNav } from './roster.mjs';
import { loadoutItems } from './loadouts.mjs';
import { loadoutGroups } from './bulk-equip.mjs';

/**
 * Race list for the current save. Per-save, not global: "Add member" clones an
 * existing character of the chosen race out of this save, so a race with no
 * living example here genuinely cannot be recruited (see
 * services/characterFactory.js).
 */
export async function loadRaces() {
  if (!state.save) { state.races = null; return; }
  try {
    state.races = await API.races(state.save);
  } catch {
    state.races = { races: [], default: null }; // panel renders its own explanation
  }
}

// Display label -> real on-disk float key on the STATS (25) record. Attribute
// keys don't all match their display label (`toughness2`, not `toughness`).
const ATTR_LABELS = [
  ['strength', 'Strength'], ['dexterity', 'Dexterity'],
  ['toughness2', 'Toughness'], ['perception', 'Perception'],
];

function statField(statKey, label, value, min = 0) {
  const v = inputNum(value);
  return `<label class="field">${esc(label)}
    <input type="number" class="stat-input" data-stat="${esc(statKey)}" data-initial="${esc(v)}"
      min="${esc(min)}" max="100" step="0.1" value="${esc(v)}"></label>`;
}

// Display-only grouping for the skills field-grid — purely presentational, it
// never changes which float key gets written (`data-stat` is always the raw
// on-disk key, same as an ungrouped field). Any skill key not covered here
// still renders, in the trailing "Other" group, so a modded save's extra
// skills are never silently hidden.
const SKILL_GROUPS = [
  // `hackers` sits here, not under Science: it is the cleaver weapon class, the
  // seventh of the game's own `skill category` values on a type-2 weapon
  // template (4 = Combat Cleaver, Moon Cleaver, Paladin's Cross, Short-Cleaver).
  // See services/archetypes.js, where the same mistake was training scientists
  // in it.
  ['Combat', ['attack', 'defence', 'unarmed', 'katana', 'sabres', 'blunt', 'poles',
    'heavy weapons', 'hackers', 'dodge', 'arrow defence', 'mass combat', 'warrior spirit', 'assassin']],
  ['Ranged', ['bow', 'turrets']],
  ['Crafting & labour', ['armour smith', 'weapon smith', 'bow smith', 'engineer',
    'robotics', 'cooking', 'farming', 'labouring']],
  ['Science & medical', ['science', 'medic', 'doctor']],
  ['Athletics & stealth', ['athletics', 'climbing', 'swimming', 'endurance', 'stealth',
    'lockpicking', 'thievery', 'tracking', 'survival', 'bluff']],
];

function healthSection(m) {
  const flags = ['dead', 'unconscious', 'coma', 'incapacitated'].filter((k) => m[k]);
  const hurt = flags.length > 0 || (m.parts || []).some((p) => (p.percentOfIntact ?? 100) < 100);

  return `<details class="section" ${hurt ? 'open' : ''}>
    ${sectionSummary('heart', 'Health')}
    <div class="section-body stack">
      ${flags.length ? `<div class="actions">
        <button class="btn btn--primary revive-btn" ${dis()}>Revive</button>
        ${m.limbs != null ? `<button class="btn btn--danger restore-limbs-btn" ${dis()}>Restore limbs</button>` : ''}
      </div>
      <p class="hint">Clears the death, KO and coma flags and raises lethal flesh together — HP overrides the flags on reload.</p>`
    : (m.limbs != null ? `<div class="actions"><button class="btn btn--danger restore-limbs-btn" ${dis()}>Restore limbs</button></div>` : '')}

      <div class="field-row">
        <label class="field">Hunger
          <input type="number" class="hunger-input w-sm" data-field="hung" data-initial="${esc(inputNum(m.hunger))}"
            min="0" max="3" step="0.1" value="${esc(inputNum(m.hunger))}"></label>
        <label class="field">Fed
          <input type="number" class="hunger-input w-sm" data-field="fed" data-initial="${esc(inputNum(m.fed))}"
            min="0" max="10" step="0.1" value="${esc(inputNum(m.fed))}"></label>
        <button class="btn btn--primary save-hunger" ${dis()}>Apply</button>
      </div>
      <p class="hint">Hunger 0–3. Fed 0–10 (this editor's cap).</p>

      <div class="table-wrap"><table class="data-table table--compact">
        <caption>Bars are relative to this character's own undamaged parts, not to <code>hit&lt;n&gt;</code>.</caption>
        <thead><tr>
          <th>Part</th><th class="col-meter">Condition</th><th class="n">Current</th><th class="n">%</th>
          <th class="shrink">Set flesh</th><th class="shrink"></th>
        </tr></thead>
        <tbody>${(m.parts || []).map((p, i) => `<tr data-part="${esc(i)}">
          <td>${esc(p.part)}</td>
          <td class="col-meter">${meter(p.percentOfIntact)}</td>
          <td class="n">${num(p.current)}</td>
          <td class="n muted">${esc(p.percentOfIntact ?? '—')}%</td>
          <td class="shrink"><input type="number" class="flesh-input w-sm" step="0.1" value="${esc(inputNum(p.current))}"></td>
          <td class="shrink"><span class="actions">
            <button class="btn btn--xs heal-part-btn" data-part="${esc(i)}" ${dis()}>Set</button>
            <button class="btn btn--xs full-heal-btn" data-part="${esc(i)}" ${dis()}>Full</button>
          </span></td></tr>`).join('')}</tbody>
      </table></div>
    </div>
  </details>`;
}

/*
 * Nested `<details class="section">`, same pattern as the "Skills (N)" block
 * below — that's the judgement call for the "one .btn--primary per section"
 * rule (style guide §3): the outer Stats & skills section already spends its
 * primary slot on "Apply stats" (manual per-field edits), so Train gets its
 * own nested section rather than fighting over the same slot or downgrading
 * either action's tier. Train is a bulk, high-blast-radius write in its own
 * right and reads clearly as its own sub-commit.
 */
function trainSection() {
  const cats = state.archetypes || [];
  if (!cats.length) return '';
  const mainOptions = cats.map((a) => `<option value="${esc(a.id)}">${esc(a.label)}</option>`).join('');
  const firstSubs = cats[0].subs || [];
  const subOptions = firstSubs.map((s) => `<option value="${esc(s.id)}">${esc(s.label)}</option>`).join('');
  return `<details class="section">
    ${sectionSummary('stats', 'Train as archetype')}
    <div class="section-body stack">
      <div class="field-row">
        <label class="field">Main archetype
          <select class="train-main">${mainOptions}</select></label>
        <label class="field">Sub-archetype
          <select class="train-sub">${subOptions}</select></label>
        <label class="field-check">
          <input type="checkbox" class="train-raise-only" checked>
          Only raise (never lower existing)
        </label>
        <button class="btn btn--primary train-btn" ${dis()}>Train</button>
      </div>
      <p class="hint">Attributes 45, archetype skills 45–95, everything else 15–40.</p>
    </div>
  </details>`;
}

function statsSection(c) {
  const a = c.stats.attributes || {};
  const skills = c.stats.skills || [];
  const bySkill = new Map(skills.map((k) => [k.skill, k.level]));
  const grouped = new Set();

  const groupHtml = SKILL_GROUPS.map(([label, keys]) => {
    const present = keys.filter((k) => bySkill.has(k));
    present.forEach((k) => grouped.add(k));
    if (present.length === 0) return '';
    return `<h4 class="group-label">${esc(label)}</h4>
      <div class="field-grid">
        ${present.map((k) => statField(k, k, bySkill.get(k), -100)).join('')}
      </div>`;
  }).join('');

  // Anything not covered by SKILL_GROUPS (including a modded save's extra
  // skill keys) still renders here, so nothing is silently hidden.
  const other = skills.filter((k) => !grouped.has(k.skill));
  const otherHtml = other.length ? `<h4 class="group-label">Other</h4>
    <div class="field-grid">
      ${other.map((k) => statField(k.skill, k.skill, k.level, -100)).join('')}
    </div>` : '';

  return `<details class="section">
    ${sectionSummary('stats', 'Stats & skills')}
    <div class="section-body stack">
      <div class="field-grid">
        ${ATTR_LABELS.map(([key, label]) => statField(key, label, a[key === 'toughness2' ? 'toughness' : key] ?? 0)).join('')}
      </div>
      <details class="section">
        <summary>Skills (${esc(skills.length)})</summary>
        <div class="section-body stack">
          ${groupHtml}${otherHtml}
        </div>
      </details>
      <div class="actions">
        <button class="btn btn--primary save-stats" ${dis()}>Apply stats</button>
        <span class="hint">Attributes 0–100, skills -100–100. Above 100 can bug out in game.</span>
      </div>
      ${trainSection()}
    </div>
  </details>`;
}

/**
 * Rename one character. Its own section rather than a click-to-edit `<h3>`,
 * because this writes through the mutation gate like everything else here and
 * so needs the same shape: a labelled field, one primary Apply, a receipt.
 */
/**
 * The race row: what this character is, and what it can be changed to.
 *
 * Two things worth knowing about the list. It is the FULL gamedata catalogue,
 * not `state.races` — that one is the per-save donor pool "Add member" needs,
 * and a race switch clones nobody, so it can offer races this save has never
 * contained. And it is filtered to `switchable`: a race with no `combat anatomy`
 * anywhere in gamedata gives the editor no body plan to write, and the server
 * refuses it, so offering it would be offering an error.
 *
 * The two optgroups are the only editorial judgement here — "playable" is the
 * race record's own flag, and it is the difference between the races Kenshi's
 * character creator offers and the 47 others (Soldierbot, P4 Unit, animals) that
 * work but were never meant to be picked.
 */
function raceRow(c) {
  const current = c.race;
  const all = (state.raceCatalogue || []).filter((r) => r.switchable);
  if (!current) return '';
  if (!all.length) {
    return `<p class="hint">Race: <b>${esc(current.name)}</b>. No race catalogue loaded, so it cannot be changed.</p>`;
  }
  // A race the save uses but gamedata cannot resolve a body plan for still has
  // to appear, or the select would silently misreport what this character is.
  const listed = all.some((r) => r.sid === current.sid);
  const playable = all.filter((r) => r.playable);
  const other = all.filter((r) => !r.playable);
  // `label`, not `name`: several races share a name and the label carries the
  // originating file that tells them apart.
  const opt = (r) => `<option value="${esc(r.sid)}" ${r.sid === current.sid ? 'selected' : ''}>${esc(r.label || r.name)}</option>`;
  const from = (state.raceCatalogue || []).find((r) => r.sid === current.sid);

  return `<div class="field-row">
      <label class="field field--grow">Race
        <select class="char-race" data-initial="${esc(current.sid)}" ${dis()}>
          ${listed ? '' : `<option value="${esc(current.sid)}" selected>${esc(current.name)} (body plan unknown)</option>`}
          <optgroup label="Playable">${playable.map(opt).join('')}</optgroup>
          <optgroup label="Other">${other.map(opt).join('')}</optgroup>
        </select></label>
      <button class="btn set-race" ${dis()}>Set</button>
    </div>
    <p class="hint">Rewrites the appearance record's race and rescales each body part to the new
      race's limits. Wounds are kept in proportion, gear and stats are untouched.
      ${from && from.appearanceFamily
    ? `Faces carry over between races sharing a slider set — <b>${esc(from.appearanceFamily.replace(/^editor_data_|\.xml$/g, ''))}</b> here.`
    : ''}</p>`;
}

function identitySection(c) {
  const list = state.personalities || [];
  const known = list.some((p) => p.value === c.personality);
  const d = c.dialogue;

  return `<details class="section">
    ${sectionSummary('identity', 'Identity')}
    <div class="section-body stack">
      <div class="field-row">
        <label class="field field--grow">Name
          <input type="text" class="char-name" maxlength="63"
            value="${esc(c.name)}" data-initial="${esc(c.name)}" ${dis()}></label>
        <button class="btn btn--primary rename-char" ${dis()}>Apply</button>
      </div>
      <p class="hint">Up to 63 bytes.</p>

      ${raceRow(c)}

      ${c.personality != null ? `<div class="field-row">
        <label class="field field--grow">Personality
          <select class="char-personality" data-initial="${esc(c.personality)}" ${dis()}>
            ${known ? '' : `<option value="${esc(c.personality)}" selected>unknown (${esc(c.personality)})</option>`}
            ${list.map((p) => `<option value="${esc(p.value)}" ${p.value === c.personality ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}
          </select></label>
        <button class="btn set-personality" ${dis()}>Set</button>
      </div>
      <p class="hint">${esc((list.find((p) => p.value === c.personality) || {}).note || 'Seven values the game uses; the rest are unimplemented.')}</p>` : ''}

      ${d ? `<p class="hint">Dialogue comes from the origin template
        <b>${esc(d.template)}</b>: ${d.talksToPlayer
    ? `talks to the player (${esc(d.playerPackages.join(', '))})`
    : (d.packages.length ? `world dialogue only (${esc(d.packages.join(', '))})` : 'none at all')}.
        Read-only — a save stores no dialogue of its own.</p>` : ''}
    </div>
  </details>`;
}

/**
 * One labelled bar. `percent` drives the fill; `text` is the real value, which
 * is always shown — a bar answers "roughly how bad is this" at a glance and the
 * number answers "exactly how bad", and a save editor owes the user both.
 */
function vital(label, percent, text, tone = null) {
  const p = Math.max(0, Math.min(100, percent ?? 0));
  const t = tone || (p < 25 ? 'danger' : p < 50 ? 'warn' : 'ok');
  return `<div class="vital">
    <span class="vital-label">${esc(label)}</span>
    <span class="meter"><span class="meter-fill ${t}" style="width:${p}%"></span></span>
    <span class="vital-value ${t === 'ok' ? '' : t}">${esc(text)}</span>
  </div>`;
}

/**
 * Blood, bleeding and hunger as bars rather than three bare floats.
 *
 * Scales are measured off this save's own 535 medical records, not guessed:
 *   - blood    p50 100.2, p75 113, max 181.7 — so 100 reads as "normal" but it
 *              is race-dependent (bigger races carry more). The bar caps at
 *              100 and the number carries the truth.
 *   - bleeding 534 of 535 are exactly 0.0 and the one exception is 0.1. A bar
 *              would be permanently empty and tell you nothing, so this is a
 *              state instead: bleeding or not.
 *   - hung     min 1.5, and p25 through max are all 3.0 — 3 is the resting
 *              value for a healthy character, so the bar fills toward 3 and a
 *              LOW value is the bad one.
 */
function vitalsBlock(m) {
  const blood = typeof m.blood === 'number' ? m.blood : null;
  const hunger = typeof m.hunger === 'number' ? m.hunger : null;
  const bleeding = m.bleeding || 0;

  return `<div class="card-vitals">
    ${blood != null ? vital('Blood', blood, num(blood)) : ''}
    ${hunger != null ? vital('Hunger', (hunger / 3) * 100, `${num(hunger, 1)} / 3`) : ''}
    <div class="vital">
      <span class="vital-label">Bleeding</span>
      <span class="vital-state ${bleeding > 0 ? 'danger' : 'ok'}">
        ${icon(bleeding > 0 ? 'blood' : 'heart', 'Bleeding')}${bleeding > 0 ? esc(num(bleeding, 2)) : 'none'}
      </span>
    </div>
  </div>`;
}

// Display label -> the real float key, for the attribute pills. `toughness2`
// is the on-disk name; the label is not.
const ATTR_PILLS = [['strength', 'STR'], ['dexterity', 'DEX'], ['toughness', 'TGH'], ['perception', 'PER']];

/**
 * Attributes as pills, and the character's strongest skills beside them.
 *
 * The point is recognising a character without opening anything: four numbers
 * say how tough they are, and the top skills say *what they are* — three of
 * medic/science/doctor reads as a medic, katana/attack/defence as a swordsman.
 * Skills are already sorted descending by statsOf(); anything at or below zero
 * is untrained (the save stores those negative) and is never shown as a
 * strength.
 */
function statPills(c) {
  if (!c.stats) return '';
  const a = c.stats.attributes || {};
  const top = (c.stats.skills || []).filter((s) => s.level > 0).slice(0, 4);
  return `<div class="pills">
    ${ATTR_PILLS.map(([key, label]) => `<span class="pill pill--attr" title="${esc(key)}">
      <span class="pill-key">${esc(label)}</span><span class="pill-val">${esc(Math.round(a[key] ?? 0))}</span>
    </span>`).join('')}
    ${top.length ? `<span class="pill-sep"></span>${top.map((s) => `<span class="pill pill--skill">
      <span class="pill-key">${esc(s.skill)}</span><span class="pill-val">${esc(Math.round(s.level))}</span>
    </span>`).join('')}` : ''}
  </div>`;
}

/**
 * Bounties (TODO.md 3.6). Rendered ONLY when `c.bounties.length > 0` — an
 * unbountied character shows nothing at all, not an empty section, per the
 * task's explicit instruction.
 *
 * There is no "add a bounty" control anywhere here, deliberately: the
 * `amount<n>` key is absent entirely on an unbountied character, and this
 * editor never mints a key that isn't already on the record (AGENTS.md §3
 * — see `saveService.setBountyAmount()`'s comment). So this can only ever
 * reduce or clear a bounty that already exists.
 *
 * `bountyexp<n>`/`claim<n>`/`crimes<n>` are shown as read-only muted text —
 * surfaced for honesty, not editable, because nothing has established what
 * they actually do. The faction column shows the resolved name when
 * `factionsService.templateOf()` finds one, and falls back to the raw
 * raw string otherwise — never hidden. (A miss is rarer than it looks:
 * `defaultEmpireFactionSID` isn't stringID-shaped but still resolves, to the
 * United Cities.)
 */
function bountiesSection(c) {
  const bounties = c.bounties || [];
  if (!bounties.length) return '';
  return `<details class="section" open>
    ${sectionSummary('blood', 'Bounties')}
    <div class="section-body stack">
      <div class="table-wrap"><table class="data-table table--compact">
        <thead><tr>
          <th>Wanted by</th><th class="n">Amount</th><th class="n">Expires</th>
          <th class="n">Claimed</th><th class="n">Crimes</th><th class="shrink"></th>
        </tr></thead>
        <tbody>${bounties.map((b) => `<tr data-index="${esc(b.index)}">
          <td>${esc(b.factionName || b.factionSid || 'unknown')}</td>
          <td class="n"><input type="number" class="bounty-amount-input w-sm" min="1" step="1"
            value="${esc(inputNum(b.amount))}" data-initial="${esc(inputNum(b.amount))}" ${dis()}></td>
          <td class="n muted">${esc(b.bountyexp ?? '—')}</td>
          <td class="n muted">${esc(b.claim ?? '—')}</td>
          <td class="n muted">${esc(b.crimes ?? '—')}</td>
          <td class="shrink"><button class="btn btn--xs apply-bounty-btn" data-index="${esc(b.index)}" ${dis()}>Apply</button></td>
        </tr>`).join('')}</tbody>
      </table></div>
      <div class="actions">
        <button class="btn btn--danger reduce-bounties-btn" ${dis()}>Reduce all to 1</button>
      </div>
      <p class="hint">A bounty cannot be removed outright — the safe method (per the FCS guide) is to
        reduce the amount to a small positive value and let it expire on its own in game. Setting it to
        0 is refused deliberately. Expiry/claimed/crimes are shown for reference only; nothing here has
        established what they do, so they are not editable.</p>
    </div>
  </details>`;
}

export function characterCard(c, file) {
  const m = c.medical || {};
  const flags = ['dead', 'unconscious', 'coma', 'incapacitated'].filter((k) => m[k]);
  const wanted = (c.bounties || []).length > 0;

  return `<article class="card" data-file="${esc(file)}" data-sid="${esc(c.sid)}" data-name="${esc(c.name)}">
    <div class="card-head">
      <h3>${esc(c.name)}</h3>
      ${c.isLeader ? '<span class="badge badge--accent">leader</span>' : ''}
      ${wanted ? '<span class="badge badge--warn">wanted</span>' : ''}
      ${flags.map((f) => `<span class="badge badge--danger">${esc(f)}</span>`).join('')}
      <span class="muted">${esc(c.race ? c.race.name : '')}${c.origin ? ` · ${esc(c.origin)}` : ''}</span>
    </div>
    ${statPills(c)}
    ${c.medical ? vitalsBlock(m) : ''}
    ${identitySection(c)}
    ${bountiesSection(c)}
    ${c.medical ? healthSection(m) : ''}
    ${c.stats ? statsSection(c) : ''}
    ${inventorySection(c)}
    <pre class="receipt" hidden></pre>
  </article>`;
}

/** Worst body part, as a rough at-a-glance condition for the roster. */
export function condition(c) {
  const parts = c.medical?.parts || [];
  if (!parts.length) return null;
  return Math.min(...parts.map((p) => p.percentOfIntact ?? 100));
}

/**
 * One pip per equip slot, filled when something occupies it. Information, not
 * decoration (style guide §1): it answers "who still needs armour?" at roster
 * density, which is exactly the question a multi-select equip raises.
 */
export function slotPips(c) {
  const filled = new Set((c.inventory || []).map((it) => it.section));
  return `<span class="pips" role="img" aria-label="${esc(EQUIP_SLOTS.filter((s) => filled.has(s)).length)} of ${esc(EQUIP_SLOTS.length)} slots filled">
    ${EQUIP_SLOTS.map((s) => `<span class="pip ${filled.has(s) ? 'pip--on' : ''}" title="${esc(SLOT_LABELS[s] || s)}"></span>`).join('')}
  </span>`;
}

// ----------------------------------------------------------- Squad panel --

/**
 * Squad-level actions: rename the squad, add a member. Both are squad-scoped
 * rather than character-scoped, so they live in their own panel above the
 * master–detail workspace instead of being bolted onto a character card.
 *
 * Each action is its own `<details class="section">` so each can own one
 * `.btn--primary` without the two fighting over the panel's single primary slot
 * (style guide §3), and so the panel is two collapsed lines until used.
 */
function renameSquadSection(s) {
  return `<details class="section">
    ${sectionSummary('rename', 'Rename squad')}
    <div class="section-body stack">
      <div class="field-row">
        <label class="field field--grow">Name
          <input type="text" id="faction-name" maxlength="63"
            value="${esc(s.world.faction)}" data-initial="${esc(s.world.faction)}" ${dis()}></label>
        <button class="btn btn--primary" id="save-faction-name" ${dis()}>Apply</button>
      </div>
      <p class="hint">Renames the player faction — the only squad-level name a save has. Up to 63 bytes.</p>
    </div>
  </details>`;
}

/**
 * A plausible default name, drawn from Kenshi's own name files and skipping
 * anyone already in the squad. Sticky once chosen, so a re-render doesn't
 * shuffle the name out from under someone mid-type.
 */
function suggestName() {
  const form = state.addMember || {};
  if (form.suggested) return form.suggested;
  const pool = state.namePool || [];
  if (!pool.length) return '';
  const taken = new Set((state.status ? state.status.squads : [])
    .flatMap((q) => q.characters.map((c) => (c.name || '').toLowerCase())));
  const free = pool.filter((n) => !taken.has(n.toLowerCase()));
  const from = free.length ? free : pool;
  const pick = from[Math.floor(Math.random() * from.length)];
  state.addMember = { ...form, suggested: pick };
  return pick;
}

/**
 * Resolve the preview endpoint's RAW items (templateSid only, plus whatever
 * numeric field the server derived) against the loadout the preview says it
 * picked, so `loadoutItems()` — the one item-list renderer in this app — can
 * render them without a second implementation.
 *
 * A provisioned recruit's item list is never exactly its source kit: the
 * server layers a med/repair kit, food and a cats stack on top, none of which
 * are in that kit's own `items`. So the source kit is only the FIRST place a
 * templateSid is looked for — the whole catalogue is the second, and it
 * happens to name every one of those extras (first aid kit, Foodcube, Ration
 * Pack, Cats), because some other kit does carry them. Without that second
 * pass the preview showed a recruit arriving with "43959-rebirth.mod ×9".
 *
 * Anything neither pass resolves still falls through with `name: null`, which
 * `loadoutItems()` renders as the raw templateSid in a muted span — never
 * dropped, just honestly unresolved.
 */
function resolvePreviewItems(preview) {
  const rows = state.loadouts || [];
  const kit = preview.loadoutId ? rows.find((l) => l.id === preview.loadoutId) : null;
  const byTemplate = new Map();
  // Catalogue first, source kit last, so the kit's own row wins the key —
  // a piece's `raceRule` is per-template and identical either way, but the
  // kit is the definition this preview actually came from.
  for (const l of rows) for (const it of l.items) if (it.name) byTemplate.set(it.templateSid, it);
  for (const it of (kit ? kit.items : [])) byTemplate.set(it.templateSid, it);
  return (preview.items || []).map((it) => {
    const known = byTemplate.get(it.templateSid);
    return { ...it, name: known ? known.name : null, raceRule: known ? known.raceRule : (it.raceRule || null) };
  });
}

function renderGearPreview(data) {
  const resolved = resolvePreviewItems(data);
  return `<div class="stack">
    <p class="hint">${data.loadoutLabel ? `Arrives as <b>${esc(data.loadoutLabel)}</b> — ` : ''}${esc(plural(resolved.length, 'item'))}, ${esc(data.cats)} cats.</p>
    ${loadoutItems({ items: resolved }, { narrow: true })}
    ${(data.warnings || []).map((w) => `<p class="hint note-warn">${esc(w)}</p>`).join('')}
  </div>`;
}

/**
 * The preview panel's content, purely from `state.addMember.preview` — never
 * fetches. The fetch itself is imperative (wireSquadPanel's refreshGearPreview,
 * same reasoning as the bulk-equip pre-flight: it must not tear down the form
 * mid-choice) and writes its result into that same field, so this same
 * function renders both the first paint (from whatever was cached across the
 * last re-render) and every subsequent imperative repaint.
 */
function gearPreviewBlock(form) {
  const p = form.preview;
  if (!p) return '<p class="hint">Choose a race, specialisation and gear above to preview what they arrive with.</p>';
  if (p.none) return '<p class="hint">Arrives empty-handed — no gear, no cats.</p>';
  if (p.loading) return '<p class="hint">Loading preview…</p>';
  if (p.error) return `<p class="hint note-warn">Could not preview starting gear: ${esc(p.error)}</p>`;
  if (p.data) return renderGearPreview(p.data);
  return '';
}

function addMemberSection(groups) {
  const races = (state.races && state.races.races) || [];
  const form = state.addMember || {};
  if (!races.length) {
    return `<details class="section">
      ${sectionSummary('add', 'Add member')}
      <div class="section-body">
        <p class="hint">No usable race found in this save. A new member is built by cloning a living
          character of the chosen race out of this save — that is the only way to get a correct per-race
          body plan and appearance record — so there is nothing to model one on here.</p>
      </div>
    </details>`;
  }

  // Preselect the server's suggested race rather than whatever happens to sort
  // first — availableRaces() orders by donor count, defaultRace() by species.
  const raceSid = form.raceSid || (state.races.default && state.races.default.sid) || races[0].sid;
  const files = groups.map((g) => g.file);

  // Grouped by role: 75 recruits in one flat list is unusable, and the groups
  // are the point — each offers at least four real alternatives. The list is
  // filterable (public/modules/combo.mjs), and the filter matches an option's
  // own text, which is why the Meitou marker is IN the label rather than only
  // in the blurb below: "meitou" is exactly what someone types to find these.
  const byGroup = new Map();
  for (const r of state.recruits || []) {
    if (!byGroup.has(r.groupLabel)) byGroup.set(r.groupLabel, []);
    byGroup.get(r.groupLabel).push(r);
  }
  const recruitOptions = [...byGroup.entries()].map(([label, rows]) => `<optgroup label="${esc(label)}">
      ${rows.map((r) => `<option value="${esc(r.id)}" ${form.recruitId === r.id ? 'selected' : ''}>${esc(r.name)} — ${esc(r.subLabel)}, ${esc(r.tierLabel)}${r.meitou ? ' · Meitou' : ''}</option>`).join('')}
    </optgroup>`).join('');

  const cats = state.archetypes || [];
  const main = cats.find((a) => a.id === form.archetype) || cats[0];
  const subs = main ? main.subs : [];

  return `<details class="section" ${form.open ? 'open' : ''}>
    ${sectionSummary('add', 'Add member')}
    <div class="section-body stack">
      <div class="field-row">
        <label class="field field--grow">Ready-made recruit
          <select id="recruit-pick">
            <option value="">choose…</option>
            ${recruitOptions}
          </select></label>
        <button class="btn" id="roll-recruit">Surprise me</button>
      </div>
      <p class="hint" id="recruit-blurb">${esc(form.blurb || '')}</p>

      <div class="field-row">
        <label class="field field--grow">Name
          <span class="actions">
            <input type="text" id="member-name" maxlength="63" placeholder="name"
              value="${esc(form.name || suggestName())}" ${dis()}>
            <button class="btn btn--ghost btn--xs" id="reroll-name" title="Another name">${icon('dice', 'Another name')}</button>
          </span></label>
        <label class="field">Race
          <select id="member-race" ${dis()}>
            ${races.map((r) => `<option value="${esc(r.sid)}" ${raceSid === r.sid ? 'selected' : ''}>${esc(r.name)} (${esc(r.donors)})</option>`).join('')}
          </select></label>
      </div>

      <div class="field-row">
        <label class="field">Specialisation
          <select id="member-archetype" ${dis()}>
            ${cats.map((a) => `<option value="${esc(a.id)}" ${main && a.id === main.id ? 'selected' : ''}>${esc(a.label)}</option>`).join('')}
          </select></label>
        <label class="field">Focus
          <select id="member-sub" ${dis()}>
            ${subs.map((x) => `<option value="${esc(x.id)}" ${form.sub === x.id ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}
          </select></label>
        <label class="field">Experience
          <select id="member-tier" ${dis()}>
            ${TIER_OPTIONS.map(([id, label]) => `<option value="${esc(id)}" ${(form.tier || 'capable') === id ? 'selected' : ''}>${esc(label)}</option>`).join('')}
          </select></label>
        ${files.length > 1 ? `<label class="field">Squad
          <select id="member-file" ${dis()}>
            ${files.map((f) => `<option value="${esc(f)}" ${form.file === f ? 'selected' : ''}>${esc(f.replace(/\.platoon$/, ''))}</option>`).join('')}
          </select></label>` : ''}
        <button class="btn btn--primary" id="add-member" ${dis()}>Add member</button>
      </div>

      <div class="field-row">
        <label class="field field--grow">Starting gear
          <select id="member-gear" ${dis()}>
            <option value="" ${(form.gearId || '') === '' ? 'selected' : ''}>Auto — matched to their role</option>
            <option value="none" ${form.gearId === 'none' ? 'selected' : ''}>Nothing — arrives empty-handed</option>
            ${loadoutGroups().map(([group, rows]) => `<optgroup label="${esc(group)}">
              ${rows.map((l) => `<option value="${esc(l.id)}" ${form.gearId === l.id ? 'selected' : ''}>${esc(l.label)}</option>`).join('')}
            </optgroup>`).join('')}
          </select></label>
      </div>
      <div id="member-gear-preview">${gearPreviewBlock(form)}</div>

      <p class="hint">Cloned from a living character of that race in this save (the number beside each race is
        how many). Provisioned on arrival with Specialist-grade armour, a Catun No.3 weapon, a med or repair kit,
        some food, and 300–5000 cats — override the exact kit with "Starting gear" above, or pick "Nothing" to
        arrive with none of it.</p>
    </div>
  </details>`;
}

// Power tiers, mirroring services/recruits.js TIERS. Display only — the id is
// what gets sent, and the server rejects one it doesn't know.
const TIER_OPTIONS = [
  ['green', 'Green'], ['capable', 'Capable'], ['veteran', 'Veteran'], ['legend', 'Legend'],
];

/**
 * Move the whole squad to a town.
 *
 * The destination list is built from the install's own world data, not from the
 * save and not from a hardcoded table — see services/locationsService.js for
 * why the two obvious sources are both wrong. Only towns that actually exist in
 * this install are offered, so nothing here can strand a squad in a place its
 * data doesn't have.
 */
function teleportSection(groups) {
  const list = state.locations || [];
  if (!list.length) {
    return `<details class="section">
      ${sectionSummary('teleport', 'Teleport')}
      <div class="section-body"><p class="hint">No town positions could be read from your Kenshi
        install, so there is nowhere to jump to.</p></div>
    </details>`;
  }
  const files = groups.map((g) => g.file);
  const chosen = (state.teleport || {}).locationId;

  // Grouped by faction so a 293-entry list is navigable.
  const byFaction = new Map();
  for (const l of list) {
    const key = l.faction || 'Unaligned';
    if (!byFaction.has(key)) byFaction.set(key, []);
    byFaction.get(key).push(l);
  }
  const options = [...byFaction.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([faction, rows]) => `<optgroup label="${esc(faction)}">
      ${rows.map((l) => `<option value="${esc(l.id)}" ${chosen === l.id ? 'selected' : ''}>${esc(l.label)}</option>`).join('')}
    </optgroup>`).join('');

  return `<details class="section">
    ${sectionSummary('teleport', 'Teleport')}
    <div class="section-body stack">
      <div class="field-row">
        <label class="field field--grow">Destination
          <select id="teleport-to" ${dis()}>${options}</select></label>
        ${files.length > 1 ? `<label class="field">Squad
          <select id="teleport-file" ${dis()}>
            ${files.map((f) => `<option value="${esc(f)}">${esc(f.replace(/\.platoon$/, ''))}</option>`).join('')}
          </select></label>` : ''}
        <button class="btn btn--danger" id="teleport-go" ${dis()}>Teleport</button>
      </div>
      <p class="hint" id="teleport-note"></p>
      <p class="hint">Moves the whole squad, map marker included. No undo beyond the automatic backup.</p>
    </div>
  </details>`;
}

function squadPanel(s, groups) {
  return `<section class="panel" id="squad-panel">
    <div class="panel-head"><h2>${icon('squad', 'Squad')} Squad</h2></div>
    ${renameSquadSection(s)}
    ${addMemberSection(groups)}
    ${teleportSection(groups)}
    <pre class="receipt" id="squad-receipt" hidden></pre>
  </section>`;
}

/**
 * The world header: faction and region as the heading, then money, members and
 * the clock as pills.
 *
 * They were four identical `.muted` spans before, which made "211 cats" and
 * "10 member(s)" read as the same kind of thing. Each now carries its own glyph
 * and its unit, and the clock also says whether it is day or night — the single
 * most useful thing about the time in Kenshi, and free from the hour.
 */
function worldBar(s, memberCount) {
  const w = s.world;
  const hh = String(w.hour ?? 0).padStart(2, '0');
  const mm = String(w.minute ?? 0).padStart(2, '0');
  const night = w.hour != null && (w.hour < 6 || w.hour >= 20);
  return `<section class="summary-bar">
    <span class="world-id">
      <b>${esc(w.faction)}</b>
      ${w.region ? `<span class="muted">${esc(w.region)}</span>` : ''}
    </span>
    <span class="pills">
      <span class="pill" title="Cats">${icon('cats', 'Cats')}<span class="pill-val">${esc(w.money)}</span><span class="pill-key">cats</span></span>
      <span class="pill" title="Squad members">${icon('squad', 'Members')}<span class="pill-val">${esc(memberCount)}</span><span class="pill-key">member${memberCount === 1 ? '' : 's'}</span></span>
      <span class="pill" title="In-game time">${icon(night ? 'moon' : 'sun', night ? 'Night' : 'Day')}<span class="pill-val">${esc(hh)}:${esc(mm)}</span><span class="pill-key">day ${esc(w.day)}</span></span>
    </span>
  </section>`;
}

export function renderSquad() {
  const r = buildRoster();
  if (!r) return '<p>No save found.</p>';
  const { s, all, groups, sel } = r;
  if (!all.length) return `${savePicker()}<p>No player squad in this save.</p>`;

  return `${savePicker()}
    ${worldBar(s, all.length)}
    <div class="workspace">
      <div class="side">
        ${rosterNav(groups)}
        ${squadPanel(s, groups)}
      </div>
      <div id="detail">${sel ? characterCard(sel.c, sel.file)
    : '<div class="empty-state"><strong>No character selected</strong>Pick someone from the roster to edit them.</div>'}</div>
    </div>`;
}

export function wireSquadPanel() {
  const panel = document.getElementById('squad-panel');
  if (!panel) return;
  const receipt = document.getElementById('squad-receipt');

  if (state.panelReceipt) {
    showReceipt(receipt, state.panelReceipt.result, { label: state.panelReceipt.label });
    state.panelReceipt = null;
  }

  const run = (btn, label, fn) => runMutation(btn, receipt, label, fn, async (result) => {
    await refresh();
    await loadRaces();
    state.panelReceipt = { result, label };
    render();
  });

  const factionInput = document.getElementById('faction-name');
  const factionBtn = document.getElementById('save-faction-name');
  if (factionBtn && factionInput) factionBtn.onclick = () => {
    const value = factionInput.value.trim();
    if (!value || value === factionInput.dataset.initial) {
      return showReceipt(receipt, new Error('Enter a different squad name first.'));
    }
    return run(factionBtn, `squad renamed to ${value}`, () => API.renameFaction(state.save, value));
  };

  // ---- teleport ----
  const tpSel = document.getElementById('teleport-to');
  const tpGo = document.getElementById('teleport-go');
  const tpNote = document.getElementById('teleport-note');
  const tpFile = document.getElementById('teleport-file');
  if (tpSel && tpGo) {
    const groupFiles = (state.status ? state.status.squads : []).map((q) => q.file);
    const chosen = () => (state.locations || []).find((l) => l.id === tpSel.value) || null;
    const describe = () => {
      const l = chosen();
      state.teleport = { locationId: tpSel.value };
      if (!l || !tpNote) return;
      const file = tpFile ? tpFile.value : groupFiles[0];
      const squad = (state.status.squads || []).find((q) => q.file === file);
      const n = squad ? squad.characters.length : 0;
      tpNote.textContent = `${plural(n, 'character')} to ${l.name}${l.faction ? ` (${l.faction})` : ''} at ${Math.round(l.x)}, ${Math.round(l.z)}.`;
    };
    tpSel.onchange = describe;
    if (tpFile) tpFile.onchange = describe;
    describe();

    tpGo.onclick = () => {
      const l = chosen();
      if (!l) return showReceipt(receipt, new Error('Pick a destination first.'));
      const file = tpFile ? tpFile.value : groupFiles[0];
      if (!file) return showReceipt(receipt, new Error('This save has no player squad.'));
      // .btn--danger, so it confirms and names the consequence (style guide §3).
      if (!confirm(`Teleport everyone in ${file.replace(/\.platoon$/, '')} to ${l.name}?\n\n`
        + 'They are moved instantly across the world. Nothing checks whether the destination is safe, '
        + 'and the only way back is the automatic backup.')) return undefined;
      return run(tpGo, `teleported to ${l.name}`, () => API.teleport(state.save, file, { locationId: l.id }));
    };
  }

  // ---- add member ----
  const nameInput = document.getElementById('member-name');
  if (!nameInput) return;
  const raceSel = document.getElementById('member-race');
  const archSel = document.getElementById('member-archetype');
  const subSel = document.getElementById('member-sub');
  const tierSel = document.getElementById('member-tier');
  const fileSel = document.getElementById('member-file');
  const gearSel = document.getElementById('member-gear');
  const recruitSel = document.getElementById('recruit-pick');
  const blurb = document.getElementById('recruit-blurb');
  const groups = (state.status ? state.status.squads : []).map((q) => q.file);

  // The form lives in state so the re-render after a successful add keeps the
  // last choices — adding a second recruit shouldn't mean re-picking everything.
  const form = () => {
    state.addMember = state.addMember || {};
    return state.addMember;
  };
  const remember = () => Object.assign(form(), {
    open: true,
    name: nameInput.value,
    raceSid: raceSel.value,
    archetype: archSel.value,
    sub: subSel.value,
    tier: tierSel.value,
    file: fileSel ? fileSel.value : groups[0],
    // '' = auto (server picks by archetype/sub/tier), 'none' = provision:
    // false, anything else is a loadout id sent as an override. Kept
    // alongside the rest of the form so a re-render after a successful add
    // remembers the last choice, same as every other field here.
    gearId: gearSel ? gearSel.value : '',
  });

  const populateSubs = () => {
    const main = (state.archetypes || []).find((a) => a.id === archSel.value);
    subSel.innerHTML = (main ? main.subs : [])
      .map((x) => `<option value="${esc(x.id)}">${esc(x.label)}</option>`).join('');
  };

  /**
   * Fetch the read-only provisioning preview and paint it into
   * `#member-gear-preview`, imperatively — like every other picker preview in
   * this app, a full render() here would tear down the form (and the name
   * field) mid-choice. This is a GET with no mutation-gate involvement at all,
   * so it runs regardless of `state.env.gameRunning`; only the Add member
   * button itself is blocked from writing.
   *
   * Skips the fetch entirely when the params haven't actually changed (the
   * cache key below), so re-wiring after an unrelated re-render of this panel
   * doesn't re-hit the network for a preview it already has.
   */
  const previewEl = () => document.getElementById('member-gear-preview');
  const refreshGearPreview = async () => {
    const el = previewEl();
    if (!el) return;
    const gearId = gearSel ? gearSel.value : '';
    if (gearId === 'none') {
      state.addMember = { ...form(), preview: { none: true } };
      el.innerHTML = gearPreviewBlock(state.addMember);
      return;
    }
    const key = [archSel.value, subSel.value, tierSel.value, raceSel.value, gearId].join('|');
    const cached = form().preview;
    if (cached && cached.key === key && (cached.data || cached.error)) {
      el.innerHTML = gearPreviewBlock(form());
      return;
    }
    state.addMember = { ...form(), preview: { key, loading: true } };
    el.innerHTML = gearPreviewBlock(state.addMember);
    const query = { archetype: archSel.value, sub: subSel.value, tier: tierSel.value, raceSid: raceSel.value };
    if (gearId) query.loadoutId = gearId;
    try {
      const data = await API.provisioningPreview(query);
      // A slower earlier request must not clobber a newer one — same
      // discipline the item search picker uses (bulk-equip.mjs's runSearch).
      if (form().preview.key !== key) return;
      state.addMember = { ...form(), preview: { key, data } };
    } catch (err) {
      if (form().preview.key !== key) return;
      state.addMember = { ...form(), preview: { key, error: err.message || 'request failed' } };
    }
    const stillThere = previewEl();
    if (stillThere) stillThere.innerHTML = gearPreviewBlock(form());
  };

  archSel.onchange = () => { populateSubs(); remember(); refreshGearPreview(); };
  [raceSel, subSel, tierSel, gearSel].forEach((el) => {
    if (el) el.onchange = () => { remember(); refreshGearPreview(); };
  });
  [nameInput, fileSel].forEach((el) => {
    if (el) el.onchange = remember;
  });
  nameInput.oninput = remember;

  // Restore the stored sub AFTER repopulating, since the option list depends on
  // the archetype (same ordering problem as the Train selects).
  const stored = state.addMember;
  if (stored && stored.sub) {
    const main = (state.archetypes || []).find((a) => a.id === archSel.value);
    if (main && main.subs.some((x) => x.id === stored.sub)) subSel.value = stored.sub;
  }

  /**
   * Apply a catalogue entry to the form. `race` on a recruit is a preference
   * matched against the races this save actually has — never a hard
   * requirement, because a save with no Shek in it must still be able to
   * recruit Ruka (as a Human, say) rather than fail.
   */
  const applyRecruit = (r) => {
    if (!r) return;
    nameInput.value = r.name;
    const races = (state.races && state.races.races) || [];
    const match = races.find((x) => x.name.toLowerCase().includes(r.race.toLowerCase()));
    if (match) raceSel.value = match.sid;
    archSel.value = r.archetype;
    populateSubs();
    subSel.value = r.sub;
    tierSel.value = r.tier;
    // A recruit's own `loadoutId` IS that character's gear (read off gamedata,
    // not guessed) — the gear select follows it. A recruit with none falls
    // back to auto, never to whatever override was left selected from a
    // previous pick.
    if (gearSel) gearSel.value = r.loadoutId || '';
    blurb.textContent = match
      ? r.blurb
      : `${r.blurb} (no ${r.race} in this save — using ${raceSel.selectedOptions[0]?.textContent || 'the selected race'}.)`;
    Object.assign(form(), { recruitId: r.id, blurb: blurb.textContent });
    remember();
    refreshGearPreview();
  };

  if (recruitSel) recruitSel.onchange = () => {
    applyRecruit((state.recruits || []).find((r) => r.id === recruitSel.value));
  };
  const rerollName = document.getElementById('reroll-name');
  if (rerollName) rerollName.onclick = () => {
    state.addMember = { ...(state.addMember || {}), suggested: null };
    const next = suggestName();
    if (next) { nameInput.value = next; remember(); }
  };

  const rollBtn = document.getElementById('roll-recruit');
  if (rollBtn) rollBtn.onclick = () => {
    const list = state.recruits || [];
    if (!list.length) return;
    const r = list[Math.floor(Math.random() * list.length)];
    if (recruitSel) recruitSel.value = r.id;
    applyRecruit(r);
  };

  // First paint of the preview for whatever the form already holds — cheap
  // thanks to refreshGearPreview()'s own cache check, so re-wiring this panel
  // after an unrelated save mutation (teleport, rename, …) doesn't re-hit the
  // network for a preview nothing invalidated.
  refreshGearPreview();

  const addBtn = document.getElementById('add-member');
  if (addBtn) addBtn.onclick = () => {
    const name = nameInput.value.trim();
    if (!name) return showReceipt(receipt, new Error('Give the new member a name first.'));
    const file = fileSel ? fileSel.value : groups[0];
    if (!file) return showReceipt(receipt, new Error('This save has no player squad to add to.'));
    remember();
    const body = {
      name,
      raceSid: raceSel.value,
      archetype: archSel.value,
      sub: subSel.value,
      tier: tierSel.value,
    };
    // '' (auto) sends neither field — the server's own default already
    // provisions. 'none' means provision:false; anything else is a loadoutId
    // override. Never both, and never `items` — the UI has no per-item picker.
    const gearId = gearSel ? gearSel.value : '';
    if (gearId === 'none') body.provision = false;
    else if (gearId) body.loadoutId = gearId;
    return run(addBtn, `${name} joined`, () => API.addSquadMember(state.save, file, body));
  };
}
