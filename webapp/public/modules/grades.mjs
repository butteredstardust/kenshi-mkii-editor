import { state } from './state.mjs';
import { esc } from './core.mjs';

// FCS-guide-confirmed named tiers for armour's "Level" field (TODO.md 3.4) —
// this save's own data backs it: every armour-typed item's `level` was one of
// exactly {20,40,60,80}, a strict subset of this list, while `quality` never
// varied (always 100). NOT valid for weapon grade (e.g. Meitou) — the guide
// says weapon grade is a company-sid/material-sid pair instead, which this
// editor does not attempt to set. Quick-fill only: choosing one just writes
// the number into the Level input below, it does not submit anything.
export const LEVEL_PRESETS = [
  [5, 'Prototype'], [20, 'Shoddy'], [40, 'Standard'], [60, 'High'], [80, 'Specialist'], [95, 'Masterwork'],
];

/**
 * The tier a new piece of armour is created at unless the user says otherwise.
 * Specialist rather than the ladder's bottom: someone reaching for this editor
 * to hand out armour is not asking for Prototype, and the control is right
 * there to change.
 */
export const DEFAULT_ARMOUR_LEVEL = 80;

/**
 * The grade a new weapon is created at unless the user says otherwise: Edge
 * Type 3, the best grade below Meitou in vanilla Kenshi.
 *
 * This install does not have one. `rebirth.mod` renames the top band to Edge
 * Type 1 / 4 / 5 (ranks 70/75/80), so "Edge Type 3" resolves by NAME where it
 * exists and otherwise by POSITION — the highest rank below the ladder's
 * maximum, which is the position Edge Type 3 occupies in vanilla and lands on
 * Edge Type 5 here. Never the ladder maximum itself: that is Meitou, a unique
 * grade, and defaulting a whole squad to it is a decision the user should make
 * out loud. A tie is broken toward the real manufacturer over `PLAYER_WEAPONS`
 * ("Homemade"), which is the crafted-by-you variant of the same tier.
 */
export function defaultGradeId() {
  const grades = state.weaponGrades || [];
  if (!grades.length) return '';
  const named = grades.filter((g) => /^edge type 3$/i.test(g.modelName));
  const pool = named.length ? named : (() => {
    const top = Math.max(...grades.map((g) => g.rank));
    const below = grades.filter((g) => g.rank < top);
    if (!below.length) return grades;
    const best = Math.max(...below.map((g) => g.rank));
    return below.filter((g) => g.rank === best);
  })();
  const real = pool.find((g) => g.companySid !== 'PLAYER_WEAPONS');
  return (real || pool[0]).id;
}

/** The default `level` for a newly created item of this template type. */
export const defaultLevelFor = (type) => (type === 3 ? DEFAULT_ARMOUR_LEVEL : undefined);

/**
 * Grade bands, for grouping the ladder in a `<select>`.
 *
 * 38 rows in one flat list is the same wall `loadoutGroups()` exists to break
 * up, and worse here because the rows repeat: 14 of this install's 24 model
 * sids appear under two manufacturers, so "Edge Type 5 — Homemade" sits right
 * next to "Edge Type 5 — Edgewalkers" with nothing to say why.
 *
 * The banding is on the ladder's own `rank` — the type-51 company record's `v0`
 * for that model — not on names, because names are what mods rewrite (this
 * install's `rebirth.mod` renames the whole top band). Each entry is the
 * INCLUSIVE lower bound of the band; they are checked from the top down.
 */
export const GRADE_BANDS = [
  [100, 'Meitou — the ladder’s top rung'],
  [70, 'Superior (Edge Type)'],
  [50, 'High (Mk III–VI)'],
  [30, 'Standard (Catun / Industrial)'],
  [15, 'Basic'],
  [0, 'Junk'],
];

export function gradeBandLabel(rank) {
  const hit = GRADE_BANDS.find(([min]) => rank >= min);
  return hit ? hit[1] : 'Other';
}

/**
 * The `<optgroup>`/`<option>` markup for a weapon-grade select, worst band
 * first (the ladder's own order). `selectedId` marks the current row, and a
 * grade the ladder no longer knows — a save written against a mod set since
 * removed — is kept as its own option rather than silently re-pointed at
 * whatever sorts first.
 */
export function gradeOptions(selectedId, currentLabel = null) {
  const grades = state.weaponGrades || [];
  const unknown = selectedId && !grades.some((g) => g.id === selectedId)
    ? `<option value="${esc(selectedId)}" selected>${esc(currentLabel || 'current grade')}</option>`
    : '';

  const bands = new Map();
  for (const g of grades) {
    const label = gradeBandLabel(g.rank);
    if (!bands.has(label)) bands.set(label, []);
    bands.get(label).push(g);
  }
  // GRADE_BANDS is high-to-low; the select reads low-to-high like the ladder.
  const ordered = [...GRADE_BANDS].reverse()
    .map(([, label]) => [label, bands.get(label)])
    .filter(([, rows]) => rows && rows.length);

  return unknown + ordered.map(([label, rows]) => `<optgroup label="${esc(label)}">
      ${rows.map((g) => `<option value="${esc(g.id)}" ${g.id === selectedId ? 'selected' : ''}>${esc(g.modelName)} — ${esc(g.companyName)}</option>`).join('')}
    </optgroup>`).join('');
}

/** The named tier for a level, or the bare number when it isn't one of the six. */
export function tierLabel(level) {
  const hit = LEVEL_PRESETS.find(([v]) => v === level);
  return hit ? `${hit[1]} (${hit[0]})` : `level ${level}`;
}
