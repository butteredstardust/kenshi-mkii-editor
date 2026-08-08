import { API } from './api-client.mjs';
import { esc, plural } from './core.mjs';
import { state } from './state.mjs';
import { loadoutItems } from './features/loadouts.mjs';

/*
 * "What does this recruit arrive with?" — the read-only provisioning preview
 * (GET /api/provisioning/preview), rendered the one way this app renders an
 * item list.
 *
 * It lives here rather than in squad.mjs because two panels ask the same
 * question now: the Squad tab's "Add member" form and the Recruits tab's
 * "Recruit them" card. The fetch has three behaviours that are easy to get
 * subtly wrong twice — a cache key so re-wiring a panel doesn't re-hit the
 * network, a stale-response guard so a slow early request can't clobber a
 * newer one, and imperative painting so the form is never torn down
 * mid-choice — so there is one implementation and both panels call it.
 */

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

function renderGearPreview(data, narrow) {
  const resolved = resolvePreviewItems(data);
  return `<div class="stack">
    <p class="hint">${data.loadoutLabel ? `Arrives as <b>${esc(data.loadoutLabel)}</b> — ` : ''}${esc(plural(resolved.length, 'item'))}, ${esc(data.cats)} cats.</p>
    ${loadoutItems({ items: resolved }, { narrow })}
    ${(data.warnings || []).map((w) => `<p class="hint note-warn">${esc(w)}</p>`).join('')}
  </div>`;
}

/**
 * The preview panel's content, purely from a stored preview object — this
 * never fetches. `loadGearPreview()` below owns the fetch and writes its
 * result into that same object, so this one function renders both the first
 * paint (from whatever survived the last re-render) and every subsequent
 * imperative repaint.
 *
 * `narrow` folds the item table into two columns — see loadoutItems(). The
 * Squad tab's copy sits in a 280px sidebar and needs it; the Recruits tab's
 * card has the full page width and does not.
 */
export function gearPreviewBlock(preview, { narrow = true } = {}) {
  const p = preview;
  if (!p) return '<p class="hint">Choose a race, specialisation and gear above to preview what they arrive with.</p>';
  if (p.none) return '<p class="hint">Arrives empty-handed — no gear, no cats.</p>';
  if (p.loading) return '<p class="hint">Loading preview…</p>';
  if (p.error) return `<p class="hint note-warn">Could not preview starting gear: ${esc(p.error)}</p>`;
  if (p.data) return renderGearPreview(p.data, narrow);
  return '';
}

/**
 * Fetch the provisioning preview for `query` and paint it into the element
 * `elOf()` returns, imperatively — like every other picker preview in this
 * app, a full render() here would tear down the form (and the name field)
 * mid-choice. This is a GET with no mutation-gate involvement at all, so it
 * runs regardless of `state.env.gameRunning`; only the write buttons are
 * blocked.
 *
 * `get`/`set` are the caller's own slot for the result, because the two
 * callers keep it in two different places (`state.addMember.preview` and
 * `state.hire.preview`) and both have to survive a re-render.
 *
 * @param {object}   o
 * @param {() => (HTMLElement|null)} o.elOf  looked up again after the await —
 *   the panel may have been re-rendered while the request was in flight.
 * @param {object}   o.query  archetype/sub/tier/raceSid, as the route takes them.
 * @param {string}   o.gearId '' = auto, 'none' = arrives empty-handed, else a loadoutId.
 * @param {() => object} o.get
 * @param {(p: object) => void} o.set
 * @param {boolean}  o.narrow
 */
export async function loadGearPreview({
  elOf, query, gearId = '', get, set, narrow = true,
}) {
  const el = elOf();
  if (!el) return;
  if (gearId === 'none') {
    set({ none: true });
    el.innerHTML = gearPreviewBlock(get(), { narrow });
    return;
  }
  const key = [query.archetype, query.sub, query.tier, query.raceSid, gearId].join('|');
  const cached = get();
  if (cached && cached.key === key && (cached.data || cached.error)) {
    el.innerHTML = gearPreviewBlock(cached, { narrow });
    return;
  }
  set({ key, loading: true });
  el.innerHTML = gearPreviewBlock(get(), { narrow });

  const params = { ...query };
  if (gearId) params.loadoutId = gearId;
  try {
    const data = await API.provisioningPreview(params);
    // A slower earlier request must not clobber a newer one — the same
    // discipline the item search pickers use.
    if ((get() || {}).key !== key) return;
    set({ key, data });
  } catch (err) {
    if ((get() || {}).key !== key) return;
    set({ key, error: err.message || 'request failed' });
  }
  const stillThere = elOf();
  if (stillThere) stillThere.innerHTML = gearPreviewBlock(get(), { narrow });
}
