/*
 * Searchable dropdowns.
 *
 * WHY THIS SHAPE, and not a custom listbox. Several of this app's `<select>`s
 * are long enough that scrolling is the only way to find a row — 38 weapon
 * grades, 66 loadouts, 75 recruits, 114 factions, every town in the world. The
 * obvious fix is a bespoke combobox: a button, a popup, an option list, and a
 * full ARIA implementation to go with it.
 *
 * This does the opposite. The native `<select>` stays exactly where it was,
 * visible, focusable and authoritative — every `.value` read, `onchange`
 * handler, `data-initial` diff and `dis()` disabled state in app.mjs keeps
 * working untouched, because none of them can tell this ran. All that is added
 * is a filter box above it that sets `hidden` on the options that do not match.
 * Screen readers, keyboard navigation, type-ahead and the platform's own
 * touch/mobile picker are the browser's, not a reimplementation of them.
 *
 * Two rules it holds to:
 *   - The SELECTED option is never hidden, whatever the filter says. Hiding it
 *     would leave the control displaying a value that is not in its own list,
 *     which browsers resolve by silently jumping to another option — i.e. by
 *     changing the answer while the user was only searching for it.
 *   - An `<optgroup>` is hidden only when every option inside it is. Group
 *     labels are half the navigation here (see gradeOptions()/loadoutGroups() in
 *     app.mjs), and a heading over nothing reads as a bug.
 *
 * Enhancement is idempotent and driven by a MutationObserver, because this app
 * rebuilds `#page` wholesale on render() AND writes several panels in
 * imperatively (`configEl.innerHTML = …`). One observer covers every path;
 * hooking each call site would not.
 */

/** select -> its filter box and count element, for refreshFilter(). */
const CONTROLS = new WeakMap();

// "More than 5 items" — a list you can take in at a glance needs no search box,
// and adding one to a 3-option control is noise.
const MIN_OPTIONS = 6;

/** Options that count toward the threshold: a placeholder row is not a choice. */
function realOptionCount(select) {
  let n = 0;
  for (const opt of select.options) if (opt.value !== '') n += 1;
  return n;
}

/**
 * What a row is matched against: its own label plus its group's, so typing
 * "sabre" finds the Sabres group's contents and typing "meitou" finds the
 * option even when only the group says so.
 */
function haystack(opt) {
  const group = opt.parentElement && opt.parentElement.tagName === 'OPTGROUP'
    ? opt.parentElement.label : '';
  return `${opt.textContent} ${group}`.toLowerCase();
}

/**
 * Split the query on whitespace and require every term, so "meitou katana"
 * narrows rather than widening the way a single substring test would.
 */
function matcher(query) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return null;
  return (opt) => {
    const hay = haystack(opt);
    return terms.every((t) => hay.includes(t));
  };
}

function applyFilter(select, input, countEl) {
  const match = matcher(input.value);
  let shown = 0;
  let total = 0;

  for (const opt of select.options) {
    if (opt.value === '') { opt.hidden = false; continue; } // keep the "All"/"choose…" row
    total += 1;
    // Never hide what is currently chosen — see the header comment.
    const keep = !match || opt.selected || match(opt);
    opt.hidden = !keep;
    if (keep) shown += 1;
  }

  for (const group of select.querySelectorAll('optgroup')) {
    group.hidden = [...group.children].every((opt) => opt.hidden);
  }

  if (!match) {
    countEl.textContent = '';
  } else if (shown === 0) {
    countEl.textContent = 'no matches';
  } else {
    countEl.textContent = `${shown} of ${total}`;
  }
}

function enhance(select) {
  select.dataset.combo = 'on';

  const wrap = document.createElement('div');
  wrap.className = 'combo';

  const bar = document.createElement('div');
  bar.className = 'combo-bar';

  const input = document.createElement('input');
  input.type = 'search';
  input.className = 'combo-filter';
  input.placeholder = 'Filter…';
  // The select carries the accessible name (it is inside the same <label>);
  // this box is a secondary control and says so rather than stealing it.
  input.setAttribute('aria-label', 'Filter the list below');
  input.autocomplete = 'off';

  const count = document.createElement('span');
  count.className = 'combo-count muted';

  bar.append(input, count);
  select.parentNode.insertBefore(wrap, select);
  wrap.append(bar, select);

  input.addEventListener('input', () => applyFilter(select, input, count));

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      input.value = '';
      applyFilter(select, input, count);
      e.stopPropagation();
      return;
    }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    // Enter commits when the filter has narrowed to a single answer — the
    // "type three letters, press Enter" path. It dispatches a real `change`
    // event so app.mjs's existing handlers fire exactly as if the user had
    // opened the list and clicked, rather than needing a second code path.
    const visible = [...select.options].filter((o) => !o.hidden && o.value !== '');
    if (visible.length !== 1 || visible[0].selected) return;
    select.value = visible[0].value;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
    applyFilter(select, input, count);
  });

  // A disabled select (the game is running) gets a disabled filter — offering
  // to search a control that cannot be used is a dead end.
  input.disabled = select.disabled;
  CONTROLS.set(select, { input, count });
}

/**
 * Re-apply an enhanced select's current filter after its `<option>`s have been
 * replaced from outside (the unequip panel rebuilds its item list whenever the
 * selection or the slot changes). Without this the box still shows a query
 * while the freshly written list is unfiltered — the control would be lying
 * about what it is showing. A no-op on a select this never touched.
 */
export function refreshFilter(select) {
  const parts = select && CONTROLS.get(select);
  if (!parts) return;
  applyFilter(select, parts.input, parts.count);
}

/**
 * Enhance every eligible `<select>` inside `root`. Safe to call repeatedly:
 * already-enhanced controls carry `data-combo` and are skipped.
 */
export function enhanceSelects(root = document) {
  if (!root || typeof root.querySelectorAll !== 'function') return;
  const selects = root.querySelectorAll
    ? [...root.querySelectorAll('select:not([data-combo])')] : [];
  // `root` may itself be a <select> handed over by the observer.
  if (root.tagName === 'SELECT' && !root.dataset.combo) selects.push(root);
  for (const select of selects) {
    // An opt-out for a control that is long but not searched by name — none
    // today, but a caller should not have to fight this to add one.
    if (select.dataset.nofilter !== undefined) continue;
    if (realOptionCount(select) < MIN_OPTIONS) continue;
    enhance(select);
  }
}

/**
 * Start watching `root` for selects that appear later. render() replaces the
 * page wholesale and several panels write their own innerHTML, so this is the
 * one hook that covers all of them.
 */
export function watchSelects(root) {
  if (!root) return;
  enhanceSelects(root);
  // childList only: enhance() sets attributes and moves nodes, and an
  // attribute-watching observer would re-enter on its own writes.
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      // A select whose own <option>s were rewritten in place (the unequip
      // panel does exactly this). It may have been too short to enhance when
      // it was first rendered and long enough now, and if it was already
      // enhanced its filter has to be re-applied to the new list.
      if (record.target && record.target.tagName === 'SELECT') {
        enhanceSelects(record.target);
        refreshFilter(record.target);
        continue;
      }
      for (const node of record.addedNodes) {
        if (node.nodeType === 1) enhanceSelects(node);
      }
    }
  });
  observer.observe(root, { childList: true, subtree: true });
  return observer;
}
