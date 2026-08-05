import { esc, plural } from '../core.mjs';
import { state, dis } from '../state.mjs';
import { icon } from '../icons.mjs';
import { savePicker } from '../nav.mjs';

/*
 * World.
 *
 * This page used to be `Object.entries(s.world)` straight into a table, which
 * meant the LABELS were the save model's own key names put through the kv
 * table's uppercase: "GAMEVERSION", "CAMERAPOS", and day / hour / minute as
 * three separate rows of one number each. Those are field names, not English
 * (style guide §5), and the reader has to reassemble the clock themselves.
 *
 * So the keys are named and grouped here. The mapping is presentation-only and
 * deliberately not exhaustive: anything it does not name still renders, under
 * "Other", because a save gaining a field must never make that field invisible.
 */
const WORLD_LABELS = {
  gameVersion: 'Game version',
  cameraPos: 'Camera position',
};

// Keys the rows below compose into something better than one number each — the
// clock out of day/hour/minute, the roster out of squads/members — so they must
// not also appear raw.
const WORLD_COMPOSED = ['day', 'hour', 'minute', 'squads', 'members', 'faction', 'region', 'money'];

function worldValue(v) {
  if (Array.isArray(v)) return v.map((n) => (typeof n === 'number' ? Math.round(n) : n)).join(', ');
  return v;
}

function worldRows(s) {
  const w = s.world;
  const hh = String(w.hour ?? 0).padStart(2, '0');
  const mm = String(w.minute ?? 0).padStart(2, '0');
  const night = w.hour != null && (w.hour < 6 || w.hour >= 20);
  const rest = Object.entries(w).filter(([k]) => !WORLD_COMPOSED.includes(k));

  const row = (label, value) => `<tr><th>${esc(label)}</th><td>${esc(value)}</td></tr>`;
  return `${row('Squad name', w.faction)}
    ${w.region ? row('Region', w.region) : ''}
    <tr><th>Time</th><td>Day ${esc(w.day)}, ${esc(hh)}:${esc(mm)}
      <span class="muted">${esc(night ? 'after dark' : 'daylight')}</span></td></tr>
    ${row('Roster', `${plural(w.members, 'character')} in ${plural(w.squads, 'squad')}`)}
    ${row('Cats', w.money)}
    ${rest.map(([k, v]) => row(WORLD_LABELS[k] || k, worldValue(v))).join('')}
    ${row('Records in quick.save', s.recordCount)}
    ${row('Save directory', s.save.dir)}`;
}

export function renderWorld() {
  const s = state.status;
  if (!s) return `${savePicker()}<div class="empty-state"><strong>No save</strong>No Kenshi save was found to read.</div>`;
  return `${savePicker()}
    <section class="panel">
      <div class="panel-head"><h2>${icon('cats', 'Player money')} Player money</h2></div>
      <div class="field-row">
        <label class="field">Cats
          <input type="number" id="money" min="0" value="${esc(s.world.money)}"></label>
        <button class="btn btn--primary" id="save-money" ${dis()}>Apply</button>
      </div>
      <p class="hint">Writes go through the mutation gate: automatic backup, staged edit, re-parse, hash compare, and rollback on any failure. Kenshi must be closed.</p>
      <pre class="receipt" id="receipt" hidden></pre>
    </section>

    <section class="panel">
      <div class="panel-head"><h2>${icon('list', 'World')} World</h2>
        <span class="muted">read-only</span></div>
      <div class="table-wrap"><table class="data-table kv"><tbody>
        ${worldRows(s)}
      </tbody></table></div>
    </section>`;
}
