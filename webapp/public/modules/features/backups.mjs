import { API } from '../api-client.mjs';
import { esc, plural } from '../core.mjs';
import { state, canWrite, dis } from '../state.mjs';
import { icon } from '../icons.mjs';

/*
 * Backups.
 *
 * Every edit takes one automatically, so this list only ever grows — 37 after a
 * single afternoon on this machine — and the page has to stay readable at 300.
 * Three things follow from that, and they are the whole design:
 *
 *  1. **Show one save's backups.** Restoring save1 from save2's backup is not a
 *     thing anyone wants; the other saves' rows are noise around the row you
 *     came for. "All saves" is one checkbox away.
 *  2. **Show the recent ones.** A restore point older than the last 25 edits is
 *     something you go looking for deliberately, so it is behind "Show all".
 *  3. **The id is not information.** `save1__2026-08-05T13-31-43-351Z` is the
 *     save name and the timestamp, both of which have their own column. It was
 *     the widest column in the table and said nothing the other two didn't.
 *
 * Restore keeps `.btn--danger` (style guide §3 — it replaces a whole save
 * directory). The rule that a repeated row should not carry a loud button is
 * satisfied by there being few rows, not by understating what the button does.
 */

/** "Today 14:31" / "Yesterday 14:31" / "3 Aug 14:31", in the user's own zone. */
function whenLabel(iso) {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return iso;
  const time = t.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const yesterday = new Date(midnight); yesterday.setDate(yesterday.getDate() - 1);
  if (t >= midnight) return `Today ${time}`;
  if (t >= yesterday) return `Yesterday ${time}`;
  return `${t.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`;
}

/**
 * A backup's label, split into what it was and whether the editor took it
 * itself. The `auto: ` prefix is on 36 of this machine's 37 backups, so as a
 * column it is pure repetition; as a badge it is the one bit that matters.
 */
function backupLabel(b) {
  const auto = b.label.startsWith('auto: ');
  return `<span class="item-name">
      <span>${esc(auto ? b.label.slice(6) : b.label)}</span>
      ${auto ? '' : '<span class="badge badge--accent">manual</span>'}
    </span>`;
}

const BACKUP_PAGE = 25;

export async function renderBackups() {
  const all = await API.backups();
  const f = state.backupFilter;
  const mine = f.allSaves || !state.save ? all : all.filter((b) => b.saveName === state.save);
  const shown = f.showAll ? mine : mine.slice(0, BACKUP_PAGE);
  const hidden = mine.length - shown.length;

  // No file-count column: a backup is the whole directory, so it is the same
  // number on every row of a given save (447 here) and a column of one repeated
  // figure is a column of nothing. It rides along in the row's tooltip, and the
  // restore receipt reports it for the one that matters.
  const rows = shown.map((b) => `<tr>
      <td class="shrink" title="${esc(b.createdAt)}">${esc(whenLabel(b.createdAt))}</td>
      <td title="${esc(plural(b.files ?? 0, 'file'))}">${backupLabel(b)}</td>
      ${f.allSaves ? `<td class="muted shrink">${esc(b.saveName)}</td>` : ''}
      <td class="shrink"><span class="actions actions--end">
        <button class="btn btn--xs btn--danger" data-restore="${esc(b.id)}" ${dis()}>Restore</button>
        <button class="btn btn--xs btn--ghost" data-delete="${esc(b.id)}">Delete</button>
      </span></td>
    </tr>`).join('');

  const table = shown.length
    ? `<div class="table-wrap"><table class="data-table">
        <thead><tr>
          <th class="shrink">Taken</th><th>Before</th>
          ${f.allSaves ? '<th class="shrink">Save</th>' : ''}<th class="shrink"></th>
        </tr></thead>
        <tbody>${rows}</tbody>
        ${hidden > 0 ? `<caption>${esc(plural(hidden, 'older backup'))} not shown.</caption>` : ''}
      </table></div>`
    : `<div class="empty-state"><strong>No backups yet</strong>${
      all.length ? 'None for this save. Tick "All saves" to see the others.'
        : 'One is taken automatically before every edit, so the first write will make one.'}</div>`;

  return `<section class="panel">
      <div class="panel-head">
        <h2>${icon('backup', 'Backups')} Backups</h2>
        <span class="muted">${esc(plural(mine.length, 'backup'))}${
  f.allSaves || mine.length === all.length ? '' : ` of ${esc(all.length)}`}</span>
      </div>
      <p class="hint hint--block">One whole-directory backup is taken automatically before every
        edit, and restoring one replaces the entire save directory — not just the file that changed.</p>
      ${canWrite() ? '' : '<p class="hint note-warn">Close Kenshi to back up or restore. The game rewrites its save directory from memory, so a backup taken now could catch it mid-write, and a restore would be overwritten the next time you save.</p>'}

      <div class="action-bar">
        <span class="action-bar-label">${icon('backup', 'Show')} Show</span>
        <label class="field-check"><input type="checkbox" id="backup-all-saves" ${f.allSaves ? 'checked' : ''}>
          Every save, not just ${esc(state.save || 'this one')}</label>
        ${mine.length > BACKUP_PAGE ? `<label class="field-check"><input type="checkbox" id="backup-show-all" ${f.showAll ? 'checked' : ''}>
          All ${esc(mine.length)}, not just the newest ${esc(BACKUP_PAGE)}</label>` : ''}
        <button class="btn btn--primary" id="make-backup" ${dis()}>Back up ${esc(state.save || '')}</button>
      </div>
      <pre class="receipt" id="backup-receipt" hidden></pre>
      ${table}
    </section>`;
}
