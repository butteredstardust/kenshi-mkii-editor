# UI style guide

Rules for anyone — human or agent — adding UI to `webapp/public/`. This is a
guardrail document, not inspiration: it exists because each feature so far
bolted its own controls onto the character card with its own class names, and
the page became unreadable. `AGENTS.md` governs correctness; this governs how
the thing looks and behaves.

Canonical files:

- `public/styles.css` — the design system. Tokens and components live here.
- `public/modules/core.mjs` — `esc`, `num`, `inputNum`, `meter`, `numField`,
  `showReceipt`, `runMutation`.
- `public/app.mjs` — the reference implementation. Copy its patterns.

---

## 1. What this app is

An offline, loopback-only power tool that edits **irreplaceable save data** for
one user on one machine. That drives every decision below:

- **Density over spaciousness.** A squad has many characters, each with dozens
  of stats. This is a data tool, not a landing page. Prefer compact rows,
  tabular numbers, and progressive disclosure over generous whitespace.
- **Safety is a visual property.** A button that can destroy a character must
  not look like a button that reveals a panel. See §3.
- **Nothing is decorative.** No gradients, shadows, animations, icon fonts, or
  illustrative flourish. If a pixel isn't carrying information, delete it.

## 2. The hard rules

These are the ones that actually get violated. Breaking any of them is a bug.

1. **Never render a raw save float.** Use `num(v)` for text and `inputNum(v)`
   for `value="..."`. Dumping `70.69469451904297` into an input is the single
   most common way this UI has looked broken.
2. **Escape every dynamic value with `esc()`** — including numbers and values
   you're sure are safe. `innerHTML` is the only rendering path here.
3. **Use existing tokens and components.** No hex colours, no `px` spacing, no
   inline `style=` outside the one approved case (`meter`'s width). If you need
   something new, add it to `styles.css` with a comment explaining why.
4. **Do not invent per-feature class names.** `.stats-editor`, `.medical-editor`
   and `.hunger-editor` were the disease. Compose `.panel`, `.section`,
   `.field`, `.field-row`, `.field-grid`, `.actions`, `.data-table`, `.btn`.
5. **Every mutation control reports through `showReceipt()`** — one receipt
   surface, success and failure alike. Never let a failed write die in the
   console.
6. **Every mutation control disables while Kenshi is running.** Read
   `state.env.gameRunning` and set `disabled`. The server rejects it anyway;
   the UI must not offer it.
7. **Wide content scrolls itself.** Put a `.table-wrap` around any table that
   can outgrow its card. The page body must never scroll horizontally.
8. **Buttons in a table row go in one `.actions` cell**, horizontally, marked
   `.shrink`. Stacked buttons in a cramped cell is what made the body-part
   table three screens tall.

## 3. Intent tiers — colour is meaning

Colour maps to consequence, never to taste. There are exactly four tiers:

| Class | Meaning | Rules |
|---|---|---|
| `.btn` | Neutral. Reveals, refreshes, navigates. No save change. | Default. |
| `.btn--primary` | Writes a staged edit through the mutation gate. | Disable while the game runs; must render a receipt. |
| `.btn--danger` | Irreversible in-game consequence (limb loss, restoring a save). | All of the above **and** must `confirm()` first, naming what happens. |
| `.btn--ghost` | Tertiary/inline, visually recessive. | No save change. |

**At most one `.btn--primary` per section.** The primary tier marks the section's
main commit action so it stays scannable. Row-level write buttons inside a
repeated table use the neutral `.btn`, even though they also write — seven gold
buttons down a column is noise, and noise is how a destructive control stops
being noticed.

The same logic applies to text: `.ok` for healthy state, `.warn` for degraded,
`.critical`/`.danger` for dead/destroyed/blocking. Never use `--accent` to mean
"bad" or `--danger` to mean "important".

## 4. Layout

- **Page:** `main` is capped at `1240px`.

### Master–detail is the rule for collections

A squad is routinely 10–30 characters. **Never render a grid of expanded cards
for a collection that can exceed a handful of items** — pick from a compact list,
edit one at a time:

- `.workspace` — a two-column grid: `.roster` on the left, the detail pane right.
- `.roster` holds a filter input, `.roster-group` headers (one per platoon file)
  and `.roster-item` buttons. A roster row carries only what you need to *choose*:
  a state `.dot`, the name, a leader badge, and a small condition `.meter`.
- Selection lives in app state as a stable key (`"<file>::<sid>"`), **not an
  index** — the list can be filtered and the save re-read between renders.
- Always default to a valid selection so the editor is never empty on load, and
  re-validate the selection after a refresh in case the character disappeared.
- Below `860px` the workspace stacks and the roster gets its own scroll.

The same shape applies to any future collection (items, factions, bounties).

### The detail pane

- **A character card** is: `.card-head` (name, badges, origin) → `.card-vitals`
  (one compact line of key numbers) → collapsible `<details class="section">`
  blocks for Health, Stats, Inventory.
- **Progressive disclosure is still mandatory** inside the card. Sections start
  collapsed except one that needs attention (a hurt character opens Health).
- **Grouping:** related inputs go in `.field-row` (a few) or `.field-grid`
  (many, e.g. stats). A trailing `.actions` row carries the apply button.
- **Subgroups inside a section** get an `<h4 class="group-label">`, a real
  heading — not a styled `<p>` — so the card keeps a valid `h3 → h4` outline.
  Where a group mapping is hardcoded for display (like skill categories), it
  must be presentation-only, and anything it doesn't name must still render in
  a trailing "Other" group. Never let a mapping silently hide save data.
- **Don't let a table span a wide pane.** Add `.table--compact` to readable
  tables; an unconstrained one drags its numbers far from their labels.
- **Grid children need `min-width: 0`.** A grid item defaults to `min-width:
  auto` and refuses to shrink below its content, so one wide table inside the
  detail pane makes the *page* scroll sideways instead of the table scrolling
  in its own `.table-wrap` — breaking §2.7. `.workspace > *` already sets this;
  any new grid must too.

### Pickers

A search that can match hundreds of rows (the "Add item" template picker sees
2000+) uses `.picker-results`: a max-height box that scrolls itself and
collapses when empty. Without it the results push the rest of the card
off-screen, which defeats the collapsible sections. Pair it with a
`.field--grow` search input — a box you type words into should not be
shrink-to-fit.

Render picker results **imperatively** (assign `innerHTML` on the results
container and re-bind its buttons) rather than calling `render()`. A full
re-render per keystroke tears down the search box mid-type. Debounce the
request, and drop a response whose query is no longer the current one so a slow
early request can't overwrite a newer one. Only the final write re-renders.

Picker selection state belongs in `state`, keyed by `"<file>::<sid>"` like
`trainChoice` — otherwise the re-render after a successful write clears the
search and the user starts over to add a second item.

## 5. Copy

- Labels are nouns, sentence case, no trailing colon: `Hunger`, `Set flesh`.
- **Keep implementation detail out of labels.** `Fed (0-10, editor cap)` is a
  label doing a comment's job — the label is `Fed`, and the constraint goes in
  a `.hint` under the field or on the input's `min`/`max`.
- Buttons are verbs: `Apply`, `Revive`, `Restore limbs`.
- State the consequence where it isn't obvious, in a `.hint`, once — not
  repeated next to every control.
- Numbers: one decimal for display (`num`), two for editable values
  (`inputNum`). Percentages are integers.

## 6. Accessibility and input

- Every input has a `<label>` (the `.field` component does this — use it).
- Never remove focus outlines; the token is already set.
- Keep `--muted` at or above its current lightness — it is at the AA contrast
  floor on `--surface`. Do not darken it for aesthetics.
- Numeric inputs carry real `min`/`max`/`step` matching the server's validation,
  so the browser catches errors before a round trip. The server still validates
  — client constraints are a convenience, never the enforcement.

## 7. Adding a feature — the checklist

1. Does an existing component cover it? Use it.
2. Numbers through `num`/`inputNum`; all values through `esc`.
3. Correct intent tier; `confirm()` if `.btn--danger`.
4. Disabled when `state.env.gameRunning`.
5. Result through `showReceipt()` / `runMutation()`.
6. Collapsed by default if it's card detail.
7. Load the page and look at it at 1400px and at 560px before calling it done.
