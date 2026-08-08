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
- `public/modules/` — the reference implementation. Copy its patterns. A tab
  lives in `modules/features/<tab>.mjs`; the shell that renders and wires them
  is `modules/system/shell.mjs`; `public/app.mjs` is only the entry point. See
  AGENTS.md §1 for the full map.

---

## 1. What this app is

An offline, loopback-only power tool that edits **irreplaceable save data** for
one user on one machine. That drives every decision below:

- **Density over spaciousness.** A squad has many characters, each with dozens
  of stats. This is a data tool, not a landing page. Prefer compact rows,
  tabular numbers, and progressive disclosure over generous whitespace.
- **Safety is a visual property.** A button that can destroy a character must
  not look like a button that reveals a panel. See §3.
- **Every pixel earns its place.** This rule used to read "nothing is
  decorative — no gradients, shadows or animations", which over time became the
  thing holding the interface back: with only hairline borders to work with,
  a card, a panel and a table all read as the same flat rectangle. Depth and
  motion are now allowed **as long as they carry meaning**:
  - **Elevation encodes layering**, not prettiness. Use the `--elev-*` tokens so
    a raised surface means "this sits above that" — a card above the page, a
    picker above a card. Do not put a shadow on something that isn't layered.
  - **Motion encodes change.** See §1a.
  - Still banned: gradients used as texture, icon fonts, illustrative flourish,
    and any effect whose removal would cost the user no information.
  - **Inline SVG glyphs are allowed where they carry information** — the
    equip-slot icons in the Gear rows encode which slot a row occupies, so they
    replace text rather than dress it up, and make a 30-item inventory scannable
    by shape. Add them to `ICON_PATHS` in `modules/icons.mjs`, size them in `em`, and draw
    them in `currentColor` so they inherit tone instead of introducing a colour.
    An icon that merely sits next to a label it duplicates is decoration —
    delete it.
- **Dark only.** There is no light theme and adding one is not a small change:
  every colour decision would have to be made and contrast-checked twice, for a
  tool that runs beside a dark game. If you find yourself hardcoding a colour
  for one theme, you have gone wrong — use the tokens.

## 1a. Motion

- **≤120ms, ease-out, and only on hover, focus, selection and disclosure.**
  Anything longer is felt as lag in a tool this dense.
- **Never animate a mutation result.** A receipt appears instantly. A user
  watching for whether a write landed must not be shown a transition first.
- **Never animate layout** (width, height, top/left) on anything containing a
  table — it reflows the page mid-frame. Transition `opacity`, `background`,
  `border-color`, `color` and `transform` only.
- **Always honour `prefers-reduced-motion: reduce`** — `styles.css` has a single
  global block that disables transitions; do not add motion that escapes it.

## 2. The hard rules

These are the ones that actually get violated. Breaking any of them is a bug.

1. **Never render a raw save float.** Use `num(v)` for text and `inputNum(v)`
   for `value="..."`. Dumping `70.69469451904297` into an input is the single
   most common way this UI has looked broken.
2. **Escape every dynamic value with `esc()`** — including numbers and values
   you're sure are safe. `innerHTML` is the only rendering path here.
3. **Use existing tokens and components.** No hex colours, no `px` spacing, no
   inline `style=` outside the one approved case (`meter`'s width). Elevation
   comes from `--elev-*`, never a hand-written `box-shadow`. If you need
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

- **Page:** one content column, `--shell-max` (1240px) wide, **centred**. The
  header, the tabs, `main` and the footer all take their horizontal padding from
  `--shell-pad`, so the title, the active tab and the first card sit on one
  vertical line at every width. Do not give a shell element its own
  `padding-inline` — `main` used to be `max-width: 1240px` with no centring, and
  on a 2560px monitor the whole app hugged the left edge against 1300px of empty
  page. The narrow breakpoint overrides the **token**, not one element's padding.

### Every control in a row is the same height

`--control-h` is the height of a button, an input and a select, set once in
`styles.css` and applied to all three. **Do not set a height, or vertical
padding that would beat it, on an individual control.** Without it each control
was as tall as its own font and padding happened to make it — a `.btn` ran
~2.4rem against an input's ~2.1rem — so a row like `Cats [47800] [Apply]`
bottom-aligned three boxes of three different heights and read as a bug.
`--control-h-xs` is the compact variant, for `.btn--xs` in table action cells
where the full height would fatten every row.

Two rules follow from it:

- **`.field-row` bottom-aligns** (`align-items: flex-end`), because a `.field`
  stacks its caption above its control and the controls are what should line up.
  A bare `.field-check` in such a row gets `--control-h` too, or its text sits
  level with the neighbouring input's bottom *border* instead of its text.
- **`.action-bar` centres** (`align-items: center`). It mixes children that have
  a stacked caption with children that don't (a label, a count, buttons, a
  checkbox), and bottom-aligning those scattered their text across three lines.
  Every `.btn` in it takes `--control-h`, `--xs` or not: ghost styling is what
  says "secondary", and a button 0.5rem shorter than its neighbour reads as an
  unrelated widget rather than a hierarchy. The one primary goes last and is
  pushed to the far end, so "Clear" and "Apply changes" are never adjacent.

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

### Stacked surfaces space themselves

`.panel`, `.card`, `.cards`, `.summary-bar`, `.workspace` and `.empty-state`
get one gap between them from a single rule in `styles.css`, whatever kind each
one is and wherever they are stacked. **Do not add a margin to a feature's own
block to fix a seam.**

This has now been got wrong twice, in the same way. First the rule was
`.panel + .panel`, which held only while every page was a stack of panels — the
first card under a panel met it at 0px and the two elevated surfaces read as one
box with a doubled border down the middle. Then the fix was scoped to
`#page > …`, and the bug reappeared on the next page built, because that one
stacks its card and its panel inside `#detail`. The rule is therefore scoped by
**nothing** now: two of those surfaces adjacent to each other get a gap. If you
add a new surface component, add it to that selector rather than giving it a
margin of its own — and if you find yourself writing `margin-top` on a card to
fix a gap, that is the smell this note exists for.

### Pickers

A search that can match hundreds of rows (the "Add item" template picker sees
2000+) uses `.picker-results`: a max-height box that scrolls itself and
collapses when empty. Without it the results push the rest of the card
off-screen, which defeats the collapsible sections. Pair it with a
`.field--grow` search input — a box you type words into should not be
shrink-to-fit.

`.field--grow` grows a **text input**, and it needs the grow factor to do it:
`display: flex` alone leaves the field a flex item at `flex: 0 1 auto`, so it
still sizes to its content and the input's `width: 100%` resolves against a
shrink-to-fit box. Every search box in the app was 148px wide in a 1159px row
for exactly that reason. A `<select>` in the same class is capped instead of
grown — it already sizes to its longest option, and three of them sharing a row
each hit the cap and became a wall (the Vendors pickers).

Render picker results **imperatively** (assign `innerHTML` on the results
container and re-bind its buttons) rather than calling `render()`. A full
re-render per keystroke tears down the search box mid-type. Debounce the
request, and drop a response whose query is no longer the current one so a slow
early request can't overwrite a newer one. Only the final write re-renders.

Picker selection state belongs in `state`, keyed by `"<file>::<sid>"` like
`trainChoice` — otherwise the re-render after a successful write clears the
search and the user starts over to add a second item.

### Long dropdowns filter themselves — you do not have to do anything

Any `<select>` with **more than five** real options gets a filter box above it
automatically (`public/modules/combo.mjs`, wired once by a MutationObserver on
`#page`). Write the plain `<select>` and it happens; nothing about the control
changes, so `.value`, `onchange` and `data-initial` diffs all still work.

What is still yours to do:

- **Group it.** Filtering finds a row you can already name; `<optgroup>` is what
  helps someone who is browsing. Every long list in the app has headings — grades
  band by ladder rank, loadouts by role tag, recruits by role, factions by
  whether you have met them, towns by faction, worn items by slot. A group label
  is matched by the filter too, so "sabres" finds the whole Sabres group.
- **Put the searchable words in the option text.** The filter reads the option's
  own label, not the blurb underneath it. That is why a Meitou recruit's option
  says "· Meitou" — it is exactly what someone types.
- **Opt out with `data-nofilter`** when the list is short, ORDERED and repeated:
  the six-rung armour tier ladder carries it, because you read a ladder top to
  bottom and six search boxes down a table crowd out the table. A 38-row grade
  list in the same cell keeps its filter.

### One row, one commit

A repeated row that can edit several fields gets **one** write button, not one
per field. The Gear row previously had "Move" (slot) beside "Set" (level and
quality) and it was genuinely unclear which button owned which control. Make
every control in the row a pending edit and commit them together:

- Give each control `data-field` and `data-initial`, diff against `data-initial`
  to build the patch, and keep the button **disabled until something actually
  differs**. Otherwise the button's only effect is a mutation-gate "edit
  produced no change" error, which reads like a bug.
- Send one request. `mutationService` treats each call as one staged edit
  against one snapshot and takes one backup, so two buttons meant two gate
  passes and a moment where disk held a state the user never asked for.
- Prefer **one named control per concept** over raw save fields. Kenshi's item
  "quality" is `ints.level` on a tier ladder for armour but a company/material
  pair for weapons, so the row shows the named tier or the named grade, and the
  raw numbers live behind a per-row "More" disclosure. Never make a field
  unreachable to tidy the default view — move it, don't drop it.
- **Ask in the player's vocabulary, and derive the rest.** A weapon has two
  independent save fields, the grade pair and `ints.level`, and the UI used to
  ask for both. A player has one word for that — "Meitou" — so a second box
  asking for a number with no name in the game is friction that gets guessed at.
  The panels now offer only the Grade, and the server writes the level from that
  grade's own ladder rank (AGENTS.md §3). Two things make this honest rather
  than magic: the pre-flight names the level the grade implies before the write,
  and the raw field is still there under "More", where an explicit value wins.
  Do this only where the derived value comes from real data — the rank is the
  game's own number, not a curve this app invented.

### Defaults are a decision, and warnings are not refusals

Two rules the Gear pickers follow, both worth copying:

- **Default to what the user actually wants, not to the safest number.**
  A new piece of armour is created at Specialist and a new weapon at Edge Type 3
  (by name where the ladder has one, else by position — see `defaultGradeId()`),
  because someone opening a save editor to hand out gear is not asking for
  Prototype. Never default to the top of a ladder either: Meitou is a decision
  the user should make out loud. The control sits right there showing what was
  chosen, which is what makes a strong default honest rather than sneaky.
- **A compatibility warning renders next to an ENABLED button.** Race fit,
  including Kenshi's own racial armour restrictions, is advisory everywhere in
  this app (AGENTS.md §3). Say what the game thinks, in a `.note-warn`, before
  the write — in the picker, in the bulk pre-flight, and on the row for gear
  that is already wrong — and let the user proceed. Disabling the button would
  make this editor refuse what it exists to do.

## 5. Copy

- Labels are nouns, sentence case, no trailing colon: `Hunger`, `Set flesh`.
- **Keep implementation detail out of labels.** `Fed (0-10, editor cap)` is a
  label doing a comment's job — the label is `Fed`, and the constraint goes in
  a `.hint` under the field or on the input's `min`/`max`.
- Buttons are verbs: `Apply`, `Revive`, `Restore limbs`.
- **A count agrees with its noun. Use `plural()`, never `(s)`.** `10
  character(s)` is a developer declining to write the label; it reads as a form
  field and it is wrong whenever n is 1. This is not only display text —
  a mutation label is stored in the backup manifest and is the only description
  of that backup the Backups page can show, so `routes/api/saves.js` carries the
  same helper.
- **A label is English, never a key name.** The World page was
  `Object.entries(world)` into a table, which put `GAMEVERSION` and `CAMERAPOS`
  on screen as headings. Name the keys, and compose the ones that are one fact
  in several fields (day + hour + minute is a clock, not three rows). Anything
  the mapping doesn't name must still render — see §4's rule about mappings
  never hiding save data.
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
