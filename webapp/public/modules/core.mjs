/**
 * Shared view helpers. Read docs/ui-style-guide.md before adding to this file.
 *
 * These exist so every feature renders numbers, meters, fields and mutation
 * receipts the SAME way. If you find yourself hand-rolling one of these at a
 * call site, use the helper instead or extend it here.
 */

/** Escape a value for interpolation into innerHTML. Use on EVERY dynamic value. */
export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/**
 * Format a number for DISPLAY. Never render a raw save float — they carry full
 * f32 precision (`70.69469451904297`) and dumping that into text or an input
 * value is the single most common way this UI has looked broken.
 */
export const num = (v, d = 1) => (typeof v === 'number' ? v.toFixed(d) : '—');

/**
 * Format a number for an <input value="...">. Same rule as num(), but trims
 * trailing zeros so the field reads "100" not "100.0" and round-trips cleanly
 * when the user doesn't touch it.
 */
export const inputNum = (v, d = 2) => (typeof v === 'number' ? String(Number(v.toFixed(d))) : '');

/** Proportion bar. `percent` is 0..100; tone is derived, never passed in. */
export function meter(percent) {
  const p = Math.max(0, Math.min(100, percent ?? 0));
  const tone = p < 35 ? 'danger' : p < 70 ? 'warn' : 'ok';
  return `<span class="meter"><span class="meter-fill ${tone}" style="width:${p}%"></span></span>`;
}

/** Back-compat alias — prefer meter(). */
export const bar = meter;

/** A labelled numeric input. `attrs` is a plain string of extra attributes. */
export function numField(label, value, attrs = '') {
  return `<label class="field">${esc(label)}
    <input type="number" value="${esc(inputNum(value))}" ${attrs}></label>`;
}

/**
 * Render a mutation result into a `.receipt` element.
 *
 * Every write in this app reports through here so success and failure look the
 * same everywhere. Pass the receipt object from the API on success, or an Error.
 */
export function showReceipt(el, result, { label = 'done', details = null } = {}) {
  if (!el) return;
  el.hidden = false;
  if (result instanceof Error) {
    el.className = 'receipt receipt--error';
    el.textContent = result.message;
    return;
  }
  el.className = 'receipt receipt--ok';
  // Backups, restores and deletes report through here too, and they change no
  // files in the save — appending "no files" to those read as a failure.
  const parts = [Array.isArray(result.changedFiles)
    ? `${label} — ${result.changedFiles.join(', ') || 'no files'}`
    : label];
  if (result.backupId) parts.push(`backup ${result.backupId}`);
  if (result.rollbackStatus && result.rollbackStatus !== 'not needed') {
    parts.push(`rollback: ${result.rollbackStatus}`);
  }
  // A bulk write can touch a dozen characters, and "one edit, 60 items" on its
  // own tells you nothing about what each of them got. `details` is a plain
  // array of already-formatted lines; this stays the ONE receipt surface
  // (style guide §2.5) rather than growing a second component for bulk results.
  const lines = [parts.join(' · ')];
  if (details && details.length) lines.push('', ...details);
  el.textContent = lines.join('\n');
}

/**
 * Wrap a mutation button click: disables the button, renders the receipt, and
 * refreshes. `run` returns the API promise. Failures surface in the receipt
 * rather than the console — a silent failure on a save editor is unacceptable.
 */
export async function runMutation(btn, receiptEl, label, run, after, { details = null } = {}) {
  const prev = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'working…';
  try {
    const result = await run();
    showReceipt(receiptEl, result, { label, details: details ? details(result) : null });
    if (after) await after(result);
  } catch (err) {
    showReceipt(receiptEl, err);
  } finally {
    btn.disabled = false;
    btn.textContent = prev;
  }
}
