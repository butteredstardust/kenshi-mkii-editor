# TODO — replacing FCS workflows in-app

This is the detailed, task-level plan. `docs/roadmap.md` is the strategic view
(five coarse phases); this file supersedes it in detail and should stay
consistent with it — when a phase here completes, fold a one-line summary back
into `roadmap.md`'s "Done" section rather than letting the two drift apart.

Source of features: `docs/fcs-capabilities.md` (20 manual FCS workflows from
the Steam guide). Source of format facts: `docs/save-format.md`. Every task
below cites the record typecode and field names it touches; where the guide
doesn't pin down the exact field, the task says "needs investigation" and how
to do it instead of guessing.

## Ground rules (non-negotiable, from AGENTS.md)

- Strings are **latin1**, not UTF-8, everywhere except the display boundary
  (`asText()`). Never round-trip a string through `.mjs` UTF-8 handling before
  it hits the codec.
- Every save-format section is a `Map`, never a plain object. Key order is
  significant and must be preserved on write.
- **Kenshi must be closed** for any write. `mutationService` enforces this;
  never bypass it.
- **No write ships without a byte-identical round-trip test.** Parse, write,
  re-parse, compare — this is the entire safety argument for the project.
- All mutations go through `mutationService.mutate(saveDir, label, action)`.
  A service function's job is to compute new record state and return
  `{ file, bytes }`; it never touches the live save directory itself.
  `saveService.setPlayerMoney()` is the reference shape — follow it.
- Backend: CommonJS, function in `services/*.js`, route in `routes/api/*.js`
  wrapped in `handle()`, validated/range-checked before touching a record.
- Frontend: vanilla ES modules, `innerHTML` strings, escape every dynamic
  value with `esc()` from `public/modules/core.mjs`.
- `instanceCount` in a record header duplicates the length of that record's
  own instances section — keep them equal if instances are ever added or
  removed.
- `hit<n>` in medical records is not a trustworthy maximum. Never write
  `hit<n>` into `flesh<n>` and call it "full health" — judge against the
  character's own highest intact part, as `saveService.medicalOf` already
  does for reads.

---

## Phase 0 — prerequisite investigation (blocks several Phase 1/2 tasks)

- [x] **Confirm field names for personality, race, coordinates, faction
  transfer, and bounty fields against a real save.** `docs/fcs-capabilities.md`
  gives FCS UI labels ("personality", "name", "hit values", "amount#"), not
  necessarily the exact on-disk key strings the codec would see (compare how
  `unconcious` is the game's own misspelling, not "unconscious"). Before
  writing any mutation that touches a field not already read by
  `saveService.js`, dump the relevant record's `bools`/`floats`/`ints`/`strings`
  Maps for a live character (extend `scripts/status.js` or write a throwaway
  script) and confirm the literal key text. Record confirmed keys in this file
  by editing the task below them.
  Test: n/a (read-only investigation script, not shipped).

  **Confirmed keys** (dumped read-only from live save `save1`,
  `%LOCALAPPDATA%\kenshi\save\save1`, 2026-08-03 snapshot, `quick.save` plus
  all 23 `.platoon` files; dump script and raw output kept outside the repo in the
  investigation scratchpad, not shipped):

  - **STATS (25)** — `strings` Map is **empty** on every sampled record (10+).
    There is **no `name` key on type 25**. The record's own container-level
    `name` field (the one in the 6-field record header, not a Map entry) does
    carry the origin-template name (e.g. `"Cannibal"`), but that's metadata
    shared by every record spawned from that template, not a per-character
    field — TODO 1.3's "does STATS carry a name string" is answered: **no**,
    drop that sub-task.
  - **CHAR_STATE (36)** — confirmed: `strings.name` (character's display
    name), `ints.personality`, `bools.is leader`. Bounty field families
    **do exist** and a bountied character **is present** in this save
    (Cannibal, sid `209--INGAME` in `Cannibals_1.platoon`, and two more
    Cannibals plus one Outlaw Farmer). Confirmed sections:
    - `ints.amount<n>` (e.g. `amount0: 700`)
    - `ints.bountyexp<n>` (e.g. `bountyexp0: 36`)
    - `ints.claim<n>` (e.g. `claim0: 0`)
    - `ints.crimes<n>` (e.g. `crimes0: 0`)
    - `strings.bountyfac<n>` (e.g. `bountyfac0: "defaultEmpireFactionSID"`,
      `bountyfac1: "1083-gamedata.base"`) — note `bountyfac0` held the literal
      string `defaultEmpireFactionSID`, not a `<id>-<file>` stringID, so
      readers must not assume every `bountyfac<n>` resolves through
      `gamedata.nameOf`.
    All five families are `ints` except `bountyfac<n>`, which is `strings`.
  - **MEDICAL (57)** — confirmed: `flesh<n>`, `bandage<n>`, `stun<n>`, `hit<n>`
    (all `floats`), `sid<n>` (`strings`), `rig<n>`, `wear<n>` (both `floats`,
    matching the "no investigation needed" note already in TODO 1.2). **`KO`
    is a `floats` key** (`floats.KO`, e.g. `2878.56`), not `bools`. **`hung`
    and `fed` are also `floats`**, not `bools` (`floats.hung`, `floats.fed`,
    matching TODO 1.2's hunger task). `bools.dead` is confirmed `bools`, along
    with `bools.unconcious` (confirmed game misspelling), `bools.coma`,
    `bools.incapacitated`.
    A `limbs` key **does exist**: `ints.limbs` on the type-57 record
    (confirmed on char instance `291--INGAME` in `Cannibals_1.platoon`, an
    incapacitated/comatose Cannibal — `dead: false`, `coma: true`,
    `unconcious: true`, `incapacitated: true`), value `16`. Looks like a
    bitmask (that character also had two strongly negative `flesh<n>` values,
    `flesh0: -10.3` and `flesh5: -83.6`, consistent with AGENTS.md's
    "negative-of-max is a documented limb-loss mechanic"), but which bit maps
    to which body part/side is **not confirmed** — 16 (bit 4) didn't obviously
    correspond to either of the two damaged parts (0 or 5) by a simple
    `1 << n` scheme. TODO 1.2's limb-restoration task can now target
    `ints.limbs` on type 57 instead of guessing the section, but the "right
    side" companion-key question and the bit-to-part mapping are still open —
    needs either a save with a single, unambiguous limb loss or in-game
    experimentation, not just this save's dump.
  - **APPEARANCE (66)** — full record dumped for characters of 10 distinct
    races present in this save (Human, Sundemon, Cannibal, Dog1, Shek, Hive
    Worker/Soldier Drone, Hive, Skimmer, Skeleton). **The race is not a key in
    `bools`/`floats`/`ints`/`strings` at all** — it lives in the record's
    **`extra` (extra-data) section**, category `"race"`, as a single row whose
    `target` field is the race's stringID (e.g. `17-gamedata.quack` → `Human`,
    `17946-stick_people.mod` → `Skeleton`, `2603-gamedata.base` → `Cannibal`).
    `v0`/`v1`/`v2` on that row were `0` in every sample. Diffing a Human vs. a
    Skeleton vs. a Hive record found no other race-tied key outside `extra`:
    `ints`/`strings`/`bools` differ only in incidental per-character values
    (hair/head/beard mod sids, `sex female`, `morph index`) and in which
    race-specific slider names appear in `floats` (e.g. Hive-only
    `stick_wide_jaw`, `stick_long_horns`, `stick_long_antenna` sliders).
    TODO 1.5's "dump a type-66 record for two characters of different races
    and diff" is done: the field to change is `extra.get('race')[0].target`,
    not an `ints`/`strings` key — this changes the shape of `setRace()`'s
    implementation (it needs to touch the `extra` Map, which no existing
    mutation in this codebase writes to yet) and should be called out
    explicitly when 1.5 is implemented.
  - **ITEM (42)** — confirmed sections for every field in the investigation
    list:
    - `strings.section`, `strings['color sid']` (confirmed **lowercase
      `color`**, not `colour sid` — matches TODO 3.1's American-spelling
      guess), `strings.uniform`, `strings['material sid']`,
      `strings['company sid']` (empty string when unset, e.g. no manufacturer)
    - `ints.level` — **lowercase `level`, not `Level`**. TODO 3.4 guessed
      `ints.Level` or `floats.Level`; the real key is `ints.level`. It
      coexists on the same record with `floats.quality` (already read by
      `itemOf()`), and both are populated independently on real items (e.g.
      `level: 15, quality: 100` on one item, `level: 0, quality: 5` on
      another) — **they are two distinct fields**, not a UI-label alias of
      the same one; TODO 3.4's "reconcile these" question is answered.
    - `ints.ownedbyC`, `ints.ownedbyCS`, `ints.ownedbyI`, `ints.ownedbyS`,
      `ints.ownedbyTYPE` — all confirmed in `ints`, matching TODO 3.3's guess.
  - **SQUAD (30) instances** — confirmed shape:
    `{ id, target, pos: vec3, rot: vec4, states: string[] }` per character
    instance, `target` being the origin/race-start-template stringID and
    `states` the list of `stringId`s to resolve into that character's
    CHAR_STATE/STATS/MEDICAL/INVENTORY/APPEARANCE/AI records. Matches
    `readPlatoon()`'s existing assumptions exactly.
  - **INVENTORY (41) instances** — confirmed shape:
    `{ id, target, pos: vec3, rot: vec4, states: string[] }`, same shape as a
    squad instance. On every sampled item instance (5+, across two
    characters), **`states` was an empty array (`[]`)** — item instances do
    not carry state records the way character instances do; `target` points
    directly at the type-42 ITEM record's `sid`.
  - **FACTION (37), in `quick.save`** — confirmed `floats.relation<n>` and
    `strings.relationSID<n>` (e.g. `relation113: 100`,
    `relationSID113: "16860-gamedata.base"`). Also present but **not
    previously documented**: `floats.trust<n>` and `floats.trustNeg<n>`
    per-index, interleaved with the `relation<n>`/`relationSID<n>` pairs, plus
    a scalar `floats.prosperity` on the same record. One `relationSID<n>`
    value observed was the literal string `nofac` rather than a `<id>-<file>`
    stringID — same caution as `bountyfac0` above: don't assume every
    `relationSID<n>`/`bountyfac<n>` resolves through the name index.
  - **GAME_STATE (56) camera record** — full `ints`/`floats` dumped (already
    partially read by `worldSummary()`/`setPlayerMoney()`). Plausible
    hunger-rate/research-speed candidates by value inspection: `floats.rs`,
    `floats.ht`, `floats.gdm`, `floats.cod`, `floats.ps`, `floats.nnm`,
    `floats.bs` were all exactly `1` in this save (consistent with "default
    multiplier" semantics) — **not confirmed**. Comparing `save1` against
    `autosave1` (same playthrough, close in time) found these floats
    byte-identical between the two, so this save alone cannot disambiguate
    them; would need a save where the player actually changed the hunger-rate
    or research-speed slider from default to diff against. TODO 3.7's write
    task must stay blocked on this — do not guess which of `rs`/`ht`/`gdm`
    etc. is which.

  **NOT FOUND / needs a different save fixture:**
  - Faction transfer: no evidence found of a character mid-transfer between
    factions in this save (would need a save taken during/around an actual
    FCS-driven transfer to observe which files/records change) — TODO 1.6 is
    correctly scoped as investigation/design-note-only already; nothing here
    changes that.
  - `limbs` bit-to-body-part mapping (see MEDICAL above) — the key and section
    are confirmed, but the encoding is not; needs a save with an unambiguous
    single lost limb, or in-game before/after comparison.
  - GAME_STATE hunger-rate / research-speed exact key (see above) — narrowed
    to a handful of `floats` candidates, not resolved to one key each; needs a
    save/settings diff, not just this save's snapshot.

- [x] **Confirm whether `nextId` needs to be bumped when a record is added,
  and whether platoon files carry their own id counter.** This is listed as
  an open question in `docs/save-format.md` §9 and blocks every "add a new
  record" task (new item instances, new characters). Investigate by: (a)
  reading `codec.js` `readHeader` — `nextId` is only parsed for filetype 15
  (`quick.save`), not for `.platoon` files (filetype is also 15, so platoons
  do have their own `nextId` — confirm this holds for a real platoon file);
  (b) checking whether any existing id in a platoon or quick.save collides
  with ids used across files (ids look global, minted from a shared counter
  per `docs/save-format.md` §1: "ids minted from a single counter in
  quick.save"). Cross-file id uniqueness must be re-verified, since inventory
  item records added to a platoon file need ids that don't collide with
  anything in quick.save or other platoons.
  Test: n/a (investigation). Write findings as comments in
  `saveService.js` near wherever id allocation ends up living.

  **Findings** (read-only, no save written; script in scratch, not shipped;
  checked both `save1` and `autosave1`, `quick.save` + all `.platoon` files
  in each — 25 files, 46 file-instances total):

  - (a) `codec.js`'s `readHeader` parses `nextId` for **every** filetype-15
    file, i.e. `quick.save` *and* every `.platoon` (they share filetype 15,
    same header shape: `L 15, L nextId, L recordCount`). Confirmed on real
    platoon files — every one has its own `nextId`, distinct from
    `quick.save`'s. `writeFile()` currently patches `header.countAt` (record
    count) on write but **never touches `nextId`** — it is preserved
    unchanged, which is correct only as long as nothing mints a new id.
  - (b)/(c) **IDs are per-file, not global.** Built the full id set per file
    and diffed pairwise: in `save1`, 1271 of 1426 distinct ids appear in
    **more than one file**; in `autosave1`, 679 of 720. E.g. id `619` in
    `autosave1` exists simultaneously in `quick.save` (type 9), `The Holy
    Nation_1.platoon` (type 36), `The Holy Nation_8.platoon` (type 36) and
    `The Holy Nation_9.platoon` (type 42) — four unrelated records, same
    numeric id. This directly contradicts `docs/save-format.md` §1 / `AGENTS.md`'s
    "ids minted from a single counter in quick.save" — that line needs
    revision in a follow-up doc pass, out of scope here.
  - A sharper finding: even **`sid` collides across files**, not just `id`.
    Almost every save/platoon record minted at runtime uses the literal
    suffix `-INGAME` (not the file's own name) — e.g. `sid = "619--INGAME"`
    (id `619` + suffix `-INGAME`, hence the double dash). Since `-INGAME` is
    reused verbatim across files, and ids collide too, the *same sid string*
    names different records in different files (667 of 746 sids collide
    across the 4-file Holy Nation cluster in `autosave1`). So `sid` is only
    guaranteed unique **within one file** — cross-file references must be
    resolved some other way than "look up this sid anywhere in the save"
    (consistent with squads/instances/states only ever referencing records
    inside their own platoon file, or `quick.save`'s own). Only a few sid
    suffixes reference genuine external files: `gamedata.base`-style
    template sids, plus one-off `BetterBanking.mod` and `S27` suffixes seen
    on a couple of `quick.save` records (unexplained, not relevant to id
    allocation).
  - (d) **Header `nextId` equals `max(id)` in that same file, exactly, with
    zero margin — in every one of the 46 file-instances checked.** Not
    `max(id) + 1` as `docs/save-format.md` §3 currently describes ("highest
    id + 1"); the observed value is the highest id itself, already in use by
    an existing record. So today's header value is *not* immediately safe to
    hand out as a new id — `nextId + 1` is the safe next id (guaranteed free
    since it exceeds every id in the file), and the header field must then be
    bumped to that new value on write.
  - Ids within a file are **sparse, not contiguous** (e.g. `Cannibals_3.platoon`:
    57 records, ids 1..64, 7 gaps) — consistent with a simple per-file
    incrementing counter that also counted ids for records later removed.

  **Conclusion: ids (and the `-INGAME` sid tag) are scoped per file, minted
  from that file's own header `nextId`, not from a single save-wide counter
  in `quick.save`.** `nextRecordId(file)` must read that *file's own*
  `header.nextId`, hand out `nextId + 1`, and write `nextId + 1` back into
  the header on save — it must never borrow a value from `quick.save` (or
  any other file) when minting an id for a platoon record, and vice versa.

  **The game renumbers and reorders records on every save** (independent
  verification pass, same two saves). Comparing `autosave1` and `save1` — same
  playthrough, same 23 platoon files, *identical record counts per file* — every
  file's `nextId` in `save1` is almost exactly double `autosave1`'s
  (`Nameless_0` 30→60, `Slaves_0` 30→60, `United Cities_17` 370→740,
  `The Holy Nation_1` 723→1446, and so on for all 22 shared files), and no
  record kept its id. In `platoon/Nameless_0.platoon`, all 28 records are
  present in both saves but at different positions with different ids: index 0
  is a type-67 record with id 29 in `autosave1` and a type-36 with id 60 in
  `save1`. Per-record id offsets are irregular (31, 29, 28, 26, 24, 39, 21…),
  so this is a genuine re-mint on serialization, not a constant shift.

  Two consequences, both good for Phase 2:
  - **Ids are ephemeral, not identity.** They are not stable across saves and
    must never be persisted by this editor or used as a cross-save key.
  - **Cross-references are carried by `sid`, and `sid` embeds the id.** A squad
    instance points at its records as `target: "26--INGAME"`, not as a numeric
    id. So `addRecord` only needs an id that is free *within that one file at
    that moment* (`nextId + 1`) — the game will renumber it on the next save
    anyway — but it **must write the matching `sid` (`"<newId>--INGAME"`) and
    every reference to it in lockstep**, since a stale sid is what actually
    breaks the link. This lowers the risk of the whole 2.2 mint-a-record task
    considerably: a chosen id only has to survive until the player's next save.

  **What remains uncertain** (not resolved by static analysis alone):
  - Whether the game itself re-mints, rejects, or silently accepts an id we
    choose this way on next load — untested, would require writing to a save
    and launching Kenshi, out of scope for this read-only task. The renumbering
    evidence above makes "silently accepts, then renumbers" the most likely
    outcome, but it is still inference, not observation.
  - Whether an editor-added record should keep reusing the `-INGAME` sid tag
    (indistinguishable from a genuine in-game-created record) or use a
    distinct tag to mark editor provenance — no evidence either way; flag for
    a decision when `addRecord`/`allocateId` is actually implemented (Phase 2).
  - Only two saves from one install/playthrough were available to check;
    a save from a different playthrough (ideally one with more mods, so more
    sid-suffix variety) would strengthen confidence further.

---

## Phase 1 — Squad editing

Everything in this phase writes to a `.platoon` file. All of it hangs off the
squad (30) → instance → state records structure already read by
`saveService.readPlatoon()`.

### 1.1 Attributes and skills (type 25 — STATS)

- [x] **Set a single stat (attribute or skill) on a character's STATS
  record.** Field: one entry in `rec.floats` on the type-25 record, keyed by
  the skill/attribute name (e.g. `strength`, `dexterity`, `toughness2`,
  `perception`, or any skill key already enumerated by `statsOf()` in
  `saveService.js`). Function: `saveService.setStat(saveDir, platoonFile,
  characterSid, statKey, value)` — locate the platoon by filename, re-read it
  with `readFile`, find the STATS record via the same squad→instance→states
  resolution `readPlatoon` already does, `floats.set(statKey, value)`,
  `writeFile`. Route: `PUT /api/saves/:name/platoons/:file/characters/:sid/stats`.
  UI: editable number input per stat/skill row in `characterCard()` (currently
  read-only text), an "Apply" button per character following the money-editor
  pattern in `renderWorld()`.
  Validation: clamp 0–100 per the guide's explicit warning ("DO NOT set stats
  above 100, as they can bug out"); reject negative values; reject unknown
  `statKey` (must be a key already present in the record's `floats` map —
  don't silently mint a new float key without confirming the game reads it).
  Test: round-trip a scratch save, set a known character's `strength` to 75,
  re-parse, assert the float changed and no other record changed (same
  pattern as `mutation.test.js`'s money test, asserting `changedFiles` is
  exactly the one `.platoon` file and record count is unchanged).

  **Implemented.** `saveService.setStats(saveDir, platoonFile, characterSid,
  stats)` is the bulk primitive (accepts an object or `Map` of
  `statKey -> value`); `saveService.setStat(...)` is a one-entry wrapper over
  it, per the "prefer the bulk form" note in the task below — there was no
  reason to build the single-stat path separately and then bolt bulk on
  after. Both go through the new `saveService.resolveCharacter(saveDir,
  platoonFile, characterSid)` helper (see the cross-cutting route-namespace
  item). Validation: clamps rejected outside 0–100 (`> 100` and `< 0` both
  throw before touching the record), unknown `statKey` (not already in that
  record's `floats` Map) throws rather than minting a new key. Route: `PUT
  /api/saves/:name/platoons/:file/characters/:sid/stats`, body
  `{ stats: { statKey: value, ... } }`. Tests:
  `webapp/test/mutation.test.js` — single-stat round trip, validation
  rejection (too high / negative / unknown key, asserting the save is
  byte-unchanged after each rejection), and a 3-stat bulk call asserting all
  three changed and `floats` key insertion order is otherwise identical.

- [x] **Bulk stat editor UI**: form covering all 4 attributes + all skills for
  one character in one submit, built on the single-stat mutation above
  (either N sequential calls or extend the service function to accept a
  `Map<statKey, value>` and do all sets in one record read/write — prefer the
  latter, since `mutationService` rejects a no-op edit and treats each
  `action()` call as one staged edit against one pre-edit snapshot; N
  sequential calls would each re-open the mutation gate).
  Test: round-trip test setting 3+ stats in one call, assert all three changed
  and the record's key insertion order is otherwise untouched (Map iteration
  order stays the same except for values).

  **Implemented, now covering every skill, not just trained ones.** The
  earlier version of this note scoped the UI down to skills with
  `level > 1.05`, on the assumption that untrained skills weren't worth
  showing. A live dump showed that's wrong: **every one of a character's 38
  skills is already present in `rec.floats`**, including untrained ones
  stored as small negatives (observed on a live Cannibal: `thievery=-3.41`,
  `weapon smith=-1.94`, `dodge=-0.46`). `statsSection()` in `public/app.mjs`
  now renders all of them, grouped into labelled subgroups (`SKILL_GROUPS`:
  Combat, Ranged, Crafting & labour, Science & medical, Athletics & stealth,
  plus a trailing "Other" for anything ungrouped, e.g. a modded save's extra
  skill keys) inside a nested collapsible `<details class="section">` so the
  card doesn't become a wall of 38 inputs by default. The grouping is
  display-only — `data-stat` on each input is always the raw on-disk key, so
  it never affects what gets written. Attributes keep `min="0"`; skills now
  carry `min="-100"` to match the relaxed server-side rule (see
  `saveService.setStats()` — skills allow -100..100, attributes stay
  0..100, both still reject `> 100`). The button still diffs each input
  against its `data-initial` and sends only changed keys in one
  `PUT .../stats` call. No UI test exists for this repo (no browser test
  harness is wired up); verified by `node --check` on the changed `.mjs`
  files, by `npm test` (round-trip tests for negative skills/attributes),
  and by reasoning through the existing money-editor code path it mirrors.

### 1.2 Health / medical (type 57 — MEDICAL)

- [x] **Heal a body part**: set `flesh<n>` to a caller-supplied value (or to
  "full", defined as `Math.max(...allParts.current)` at write time — the
  editor's own definition per `docs/save-format.md`, not `hit<n>`), and
  zero out `bandage<n>` and `stun<n>` for that part per the guide's "to fully
  heal" steps. Fields: `floats.flesh<n>`, `floats.bandage<n>`, `floats.stun<n>`
  on type 57, `n` in 0..6 (`BODY_SLOTS` already defined in `saveService.js`).
  `rig` and `wear` are named in the guide but not yet in `medicalOf()`; they
  are confirmed present as per-part floats `rig<n>` / `wear<n>` (observed in a
  live type-57 record), so no investigation is needed — just surface them.
  Function: `saveService.healPart(saveDir, platoonFile, sid, partIndex,
  { flesh, bandage, stun })`. Route:
  `PUT /api/saves/:name/platoons/:file/characters/:sid/medical/parts/:n`.
  UI: make the existing body-part table in `characterCard()` editable, one row
  = one form.
  Validation: `partIndex` in range; `flesh` non-negative (negative-of-max is a
  documented limb-loss mechanic, not a bug — see task below, keep this task to
  simple healing/damage and clamp to `>= 0` here).
  Test: round-trip, heal one part, assert `flesh<n>` changed and adjacent
  `sid<n>`/`hit<n>` keys untouched.

  **Implemented.** `saveService.healPart()` is a thin wrapper over a new
  shared `setPartHealth()` (also used by `damagePart()` below) so the heal and
  limb-loss clamp logic don't drift apart. `bandage`/`stun` default to 0
  ("zero out" per the guide) but can be overridden with any non-negative
  value. `medicalOf()` now also surfaces `rig<n>`/`wear<n>` per part and a raw
  `limbs` value (see restore-limbs below). Route landed as specified. UI:
  the body-part table in `characterCard()` (`public/app.mjs`) is now editable
  — one flesh input + "Heal"/"Full" buttons per row. Tests:
  `webapp/test/mutation.test.js` — heal-with-explicit-values (asserts
  `sid<n>`/`hit<n>` untouched) and heal-with-`"full"` (asserts it equals
  `Math.max` of the character's own parts, not `hit<n>`).

- [x] **Revive (clear death/KO/coma)**: clear `bools.dead`, `bools.coma`,
  `bools.incapacitated`, and set the KO timer to 0. The literal key is
  confirmed: `floats.KO` on type 57 (observed in a live record; not yet read by
  `medicalOf()`). **Must be a single combined mutation
  with the heal-part task above, not offered standalone in the UI**: the
  guide's explicit warning is "HP data will override KO/death flags — if HP is
  still at lethal levels, the character will die again when you reload."
  Function: `saveService.revive(saveDir, platoonFile, sid, { minFleshPercent
  = 50 })` — clears the flags AND raises every `flesh<n>` below a floor in the
  same write. Route: `POST
  /api/saves/:name/platoons/:file/characters/:sid/revive`. UI: single "Revive"
  button on a dead/KO'd character's card, no separate raw flag toggles exposed.
  Test: round-trip on a character forced into a dead state in the scratch
  copy (or documented as manual-verification-only if no dead character exists
  in the sample save — note this explicitly rather than skipping silently).

  **Implemented.** `saveService.revive()` clears `dead`/`coma`/
  `incapacitated`/`unconcious` and sets `floats.KO` to 0, AND raises every
  `flesh<n>` below `minFleshPercent`% (default 50) of the character's own max
  `flesh<n>` — all in the one record read/write, so `mutationService` stages
  it as a single edit.
  **Known limitation:** the floor is a percentage of the character's own
  highest intact part, because `hit<n>` is not a trustworthy maximum and so
  can never be the reference. That baseline degenerates when *nothing* is
  intact — on a character whose every part is at or below zero the floor
  computes to ~0, which would clear the death flags while leaving HP lethal,
  i.e. exactly the "dies again on reload" trap this function exists to
  prevent. `revive()` therefore refuses outright in that case and tells the
  caller to heal a part explicitly first; covered by its own test. If a
  trustworthy per-part maximum is ever derived (see the `hit<n>` open
  question), revive could fall back to it instead of refusing. UI exposes only a single "Revive" confirm button, no
  raw flag toggles. Test: the sample save (`Cannibals_1.platoon`, per Phase
  0's note) was checked first for a live dead/comatose character at test-run
  time; when the current save doesn't have one, the test builds a synthetic
  dead+lethal-flesh record in the scratch copy instead of skipping, and says
  so via the mutation label (`test: revive (synthetic fixture)` vs.
  `(live fixture)`) — both paths assert flags cleared AND every part's flesh
  at or above the floor after the one write.

- [x] **Limb restoration**: delete the `limbs` key (guide: "left side" value,
  as opposed to right-side values which must NOT be touched — needs Phase 0
  investigation to identify which section (`ints`? `strings`?) `limbs` lives
  in and what the "right side" companion keys are, since a wrong guess here
  risks touching the wrong key). Evidence so far: no `limbs` key appears in the
  bools/floats/ints/strings of a live type-57 record — but both sample
  characters have all limbs intact, so the key may only be written once a limb
  is actually lost. A save with a missing limb is likely needed to confirm. Function: `saveService.restoreLimbs(saveDir,
  platoonFile, sid)` — deletes the one key from the relevant Map if present;
  no-op (and thus mutation-gate-rejected as "produced no change") if absent.
  Route: `POST .../characters/:sid/medical/restore-limbs`.
  Test: round-trip against a character with lost limbs if the sample save has
  one; otherwise a synthetic record built in-memory in the test asserting the
  key is removed and the section's remaining key order is preserved.
  **Blocked on Phase 0 investigation** — do not guess the section.

  **Implemented, per the now-resolved Phase 0 finding** (`ints.limbs` on type
  57, encoding not decoded). `saveService.restoreLimbs()` deletes
  `ints.limbs` if present; deliberately makes **no attempt** to interpret
  individual bits, per the task's own instruction — the FCS "left side, not
  right side" note is read as an FCS-UI key-vs-value-column distinction, i.e.
  delete the key itself, not a specific bit. Absence is left to
  `mutationService.mutate()`'s existing "edit produced no change" rejection.
  Tests: one against a real/synthetic `ints.limbs: 16` fixture (Cannibals_1
  checked first, synthetic fallback otherwise, same not-skipped-silently
  pattern as revive) asserting the key is gone and the rest of `ints`' key
  order is preserved; a second test asserting the no-op path actually throws
  `edit produced no change` rather than silently succeeding.

- [x] **Hunger**: set `floats.hung` and `floats.fed` on type 57. Function:
  `saveService.setHunger(saveDir, platoonFile, sid, { hung, fed })`. Route:
  `PUT .../characters/:sid/medical/hunger`. UI: two number inputs next to the
  existing hunger/fed display in `characterCard()`.
  Validation: clamp `hung` to 0–3 (guide's documented scale), `fed` to a
  sane non-negative range (no documented cap — leave generous, e.g. 0–10, and
  say so in a comment since the guide doesn't give one).
  Test: round-trip, assert both floats changed independently (set only `hung`,
  confirm `fed` untouched, and vice versa in a second case).

  **Implemented** exactly as specified: `hung` clamped 0–3, `fed` clamped
  0–10 with a code comment explicitly noting the guide gives no cap and 10 is
  this editor's own choice. Either key may be omitted from the call and the
  other is left untouched (checked with `!== undefined`, not truthiness, so
  `0` is a valid explicit value). UI: two number inputs + one "Apply hunger"
  button per character. Test: sets `hung` alone and confirms `fed` unchanged,
  then sets `fed` alone in a second mutation and confirms `hung` held the
  value from the first write.

- [x] **Limb loss (destructive, low priority within this section)**: set
  `flesh<n>` to `-100% of max` per the guide, only meaningful combined with
  the game's "limb loss frequency" setting so treat as advanced/optional. Same
  function signature as heal-part but with no lower clamp. Gate behind a UI
  confirmation ("this can permanently remove a limb"). Test: round-trip only;
  do not attempt to assert in-game behavior (out of scope for an offline
  editor).

  **Backend and test implemented, UI deliberately left out.**
  `saveService.damagePart()` and route `PUT .../medical/parts/:n/damage`
  exist (same `setPartHealth()` core as `healPart()`, called with
  `allowNegative: true`, and rejects `flesh: 'full'` since "full" has no
  meaning for damage). Test: round-trips a negative `flesh<n>` value (-83.6,
  matching the Phase 0 sample) and confirms `healPart()` still rejects the
  same negative value on the same record, i.e. the clamp is the only
  difference between the two functions. What was skipped: no UI confirm
  button was wired up in `characterCard()`/`wire()` for this one, since Phase
  1.2's other four items filled the available time and this is explicitly the
  lowest-priority item in the task list — the route works if called directly
  (e.g. via curl or a future UI pass), it's just not reachable from the app
  today. Flagging this explicitly rather than claiming full completion.

### 1.3 Character state (type 36 — CHAR_STATE)

- [x] **Rename a character**: `strings.name` on type 36. Optionally also
  update the STATS record's `name` field for FCS-parity (guide: "recommended
  to also update the name on the STATS entry" — but that was an FCS
  navigation convenience, not a game requirement; confirm via Phase 0 whether
  the type-25 record even carries a `name` string — `saveService.js`'s
  `statsOf()` never reads one, so this may not apply and should be dropped if
  not present). Function: `saveService.renameCharacter(saveDir, platoonFile,
  sid, newName)`. Route: `PUT .../characters/:sid/name`. UI: click-to-edit on
  the `<h3>` in `characterCard()`.
  Validation: non-empty string, reasonable max length (game UI truncates —
  pick 63 latin1 bytes as a conservative cap and document it), must be written
  latin1 (test with a name containing a byte outside ASCII to catch UTF-8
  round-trip corruption, mirroring the `0x80` trap in `docs/save-format.md`
  §2).
  Test: round-trip with an ASCII name and with one non-ASCII latin1 byte,
  assert exact byte preservation.

  **Implemented** — see "Rename a squad, rename a character, add a squad
  member" in the Editor-only additions section at the end of this file for the
  full write-up. Short version: `saveService.renameCharacter()` writes both
  `strings.name` on type 36 and the type-25 record's *header* `name` (the
  guide's advice turned out to describe real game behaviour, not just an FCS
  convenience); the 63-byte cap and the latin1 encoding both live in
  `saveService.encodeName()` / `binary.fromText()`; the UI is an "Identity"
  section on the character card rather than a click-to-edit `<h3>`.

- [x] **Personality**: `ints.personality` on type 36 (already read by
  `readPlatoon()` as `personality`). Function: `saveService.setPersonality`.
  Route + UI as above. Validation: restrict the dropdown to the guide's
  documented working values (1, 2, 5, 6, 9, 10, 14) and warn in the UI that 11/12/13
  are unimplemented in vanilla rather than silently allowing them (allow them,
  but flag).
  Test: round-trip, assert int changed.

### 1.4 Character coordinates / teleport

- [x] **Teleport a character**: the instance's `pos` (vec3) inside the
  squad (type 30) record's `instances` array — NOT a field inside any of the
  states records. This is a different mutation shape from everything else in
  this phase: it edits the squad record's own instance list, not a
  state-record's Map. Function: `saveService.teleportCharacter(saveDir,
  platoonFile, sid, { x, y, z })` — find the squad record, find the instance
  whose `id === sid`, overwrite `inst.pos`. Route: `PUT
  .../characters/:sid/position`. UI: three number inputs (or a "copy from
  character X" picker per the guide's Method 1) on the character card.
  Validation: none documented by the guide beyond "must be a valid world
  location" — out of scope to validate against the actual terrain; just accept
  floats. Note in the UI that off-map coordinates can strand a character.
  Test: round-trip, assert `pos` changed and `rot`/`states`/`id`/`target`
  unchanged on that instance, and no other instance touched.

  **Implemented** as `saveService.teleportSquad()` — squad-scoped rather than
  one character at a time (`sids` narrows it), because moving one member of a
  squad across the world is rarely what anyone wants. It also writes the
  quick.save SQUAD_META position, which this task didn't anticipate: leaving it
  behind puts the squad's map marker in one place and its characters in another.
  The "copy from character X" picker became a town picker instead — see the
  teleport entry in Editor-only additions for where town positions actually
  live, which was the real work.

### 1.5 Character race

- [ ] **Change race** (largest single task in this phase; do last within
  Phase 1). Fields: the type-66 APPEARANCE record's race-related keys (not yet
  read by `saveService.js` at all — `T.APPEARANCE = 66` is defined but no
  reader exists) plus the type-57 MEDICAL record's `hit<n>`/`sid<n>` set,
  which the guide says must be copied together or hit detection breaks.
  **This needs its own investigation pass** before implementation: dump a
  type-66 record for two characters of different races and diff the
  `strings`/`ints` Maps to find the race key(s), since the guide's FCS-UI
  workflow ("copy data from item") doesn't map to a single field name.
  Function: `saveService.setRace(saveDir, platoonFile, sid, raceStringId)` —
  once the field(s) are identified, this likely means copying a whole subset
  of the type-66 record's Maps from a template plus copying every `hit<n>`
  value from a same-race template's MEDICAL record. Route: `PUT
  .../characters/:sid/race`. UI: dropdown of known race stringIDs (source:
  `gamedataService` — filter the name index for race-type records once the
  type is known).
  Validation: reject if no template record for the target race is resolvable.
  Test: round-trip; additionally assert the MEDICAL record's part count and
  `sid<n>` labels are self-consistent with the new race's body plan (e.g. a
  race with 5 hit-parts doesn't end up with 7 stale `flesh<n>` entries copied
  from a human template).
  **Blocked on investigation of type-66 field layout — do not guess.**

### 1.6 Transferring characters between factions

- [ ] **Investigation only, this phase**: the guide itself says this is "a
  complex procedure not fully detailed" spanning multiple files (moving an
  instance's state records from one platoon file to another, updating squad
  member counts on both sides, and possibly `quick.save` faction data).
  `mutationService.mutate()` already accepts an array of `{file, bytes}`
  results, which is the multi-file primitive this needs — nothing exercises
  that path yet, per `docs/roadmap.md`'s "Later / unresolved" note.
  Deliverable for this task: a design note (in this file or a new
  `docs/character-transfer.md`) listing every record that must move/update,
  based on tracing one manual transfer in FCS or diffing two saves before/after
  a manual transfer. **Do not implement the mutation itself until Phase 2's
  new-record-id work (Phase 0's second task) is resolved**, since transfer
  likely needs to renumber or relink ids across files.
  Test: n/a for this task (design doc only).

---

## Phase 2 — Inventory editing

Priority: (a) equip an already-owned item into a slot, (b) add a new item to
inventory. (a) is safe — it edits one existing record's one field. (b) is the
hard blocker for several other Phase 3 tasks.

### 2.1 Equip an item into a slot (type 42 — ITEM, `section` field)

- [x] **Change an item's equip slot.** Field: `strings.section` on the
  type-42 ITEM record (already read by `saveService.itemOf()` as `section`).
  Function: `saveService.setItemSection(saveDir, platoonFile, itemSid,
  targetSection)`. Route: `PUT
  .../characters/:sid/inventory/:itemSid/section`. UI: a `<select>` per
  inventory row in the `<details>` block of `characterCard()`, options being
  the guide's documented slot list (`main`, `head`, `shirt`, `armour`, `legs`,
  `boots`, `back`, `hip`, `belt`, `backpack_attach`, `backpack_content`).
  Validation: target must be one of the documented slot strings; **when
  swapping into an occupied slot, the mutation must also flip the previously
  occupying item's `section` back to `main` in the same write** (guide step
  6) — otherwise the save can end up with two items claiming the same slot.
  This means the function needs to scan the character's other inventory items
  for a `section === targetSection` collision and clear it. Warn in the UI,
  per the guide, that race-disallowed items (e.g. shirt on hiver) will not
  actually equip in-game even though the save edit succeeds — this can't be
  validated by the editor since race-compatibility tables aren't in scope.
  Test: round-trip; a two-item case exercising the auto-swap-back-to-main
  behavior, asserting exactly two `section` strings changed and nothing else.

  **Implemented.** `saveService.setItemSection(saveDir, platoonFile,
  characterSid, itemSid, targetSection)` — validates `targetSection` against
  the documented `ITEM_SLOTS` list, resolves the item through a new
  `resolveCharacterItem()` helper (shared with `setItemQuality()` below) that
  confirms the item's sid is actually one of this character's own
  `INVENTORY` instances before touching it, rejecting an item belonging to
  someone else. Collision handling: `main` and `backpack_content` are treated
  as buckets (`ITEM_BUCKET_SLOTS`) — many items can legitimately share either
  at once, so moving into one never displaces anything; every other
  documented slot is single-occupancy, and moving into an already-occupied
  one flips the prior occupant's `section` back to `main` in the same
  record read/write. Route: `PUT
  /api/saves/:name/platoons/:file/characters/:sid/inventory/:itemSid/section`,
  body `{ section }`. UI: see the new Gear tab below — a per-item `<select>`
  of all 11 documented slots plus a "Move" button (neutral `.btn`, per the
  style guide's row-level-write rule), with a live "replaces X" note computed
  client-side before the write so the swap is never a surprise, on top of the
  server's own before/after receipt. The race-compatibility caveat (the
  editor cannot check whether this character's race can actually wear/wield
  an item) is a single `.hint` at the top of the Gear card, not repeated per
  row. Tests (`webapp/test/mutation.test.js`): move into an empty slot
  (asserts only that item's section changed); the collision case (asserts
  exactly two `section` strings changed and nothing else on either record —
  quantity/quality on both are also asserted untouched); an invalid slot
  string rejected byte-identically; an item sid that isn't in the target
  character's own inventory rejected byte-identically.

  **Superseded in part by the Gear redesign (see 2.4 below).** The "Move"
  button described above no longer exists: `setItemSection()` is now a thin
  wrapper over `saveService.updateItem()`, and the row commits every change
  through one "Apply". The service-level collision rule and all the tests
  above are unchanged.

- [x] **Restrict "Move to" to slots the item's KIND can actually occupy.**
  The original 2.1 implementation offered every one of the 11 documented
  slots for every item — a shirt could be "moved" into a weapon slot, and the
  save edit would succeed even though it's nonsense. Fixed by a new
  `webapp/services/itemSlots.js`, the single source of truth both
  `saveService.setItemSection()` (server-side enforcement) and the Gear tab's
  `<select>` (via a new `allowedSections`/`slotsWidened` pair on `itemOf()`'s
  payload) read from — the UI never recomputes compatibility itself.

  **Investigation: is there an authoritative gamedata slot field? YES, for
  armour.** Every type-3 (armour) gamedata TEMPLATE record (parsed straight
  out of `gamedata.base`/mod files with the existing codec, read-only) carries
  its own `ints.slot` integer. Resolved all 1648 type-42 ITEM records in the
  live save through `base data sid` and cross-tabulated the template's `slot`
  against the item's own observed `section` (script kept in the investigation
  scratchpad, not shipped) — the result is an exact, zero-exception 1:1
  mapping:
  ```
  slot 3 -> head    (86 live items, all slot 3)
  slot 5 -> armour  (229 live items, all slot 5)
  slot 6 -> legs    (236 live items, all slot 6)
  slot 8 -> shirt   (126 live items, all slot 8)
  slot 9 -> boots   (205 live items, all slot 9)
  ```
  **Negative result for weapons.** `ints.slot` also exists on type-2 (weapon)
  templates, but is `0` on every single sampled weapon record (19/19 in
  `gamedata.base`, 27/47 in `rebirth.mod`) and carries no disambiguating
  information: the SAME weapon template (Katana, `476-gamedata.base`) was
  observed equipped in BOTH `hip` and `back` on different live item instances
  in this save. So `slot` cannot and does not decide hip vs back for weapons
  — it is used only for type-3 records; type-2/type-4 fall back to the
  typecode-level sets from the original 2.1 evidence dump (`type 2`:
  `hip`,`back`; `type 3` generic: `head`,`shirt`,`armour`,`legs`,`boots`;
  `type 4`: no equip slots).
  **The field is not universal.** `gamedata.base` has `ints.slot` on 100% of
  its own type-2/type-3 records, but bundled overhaul mods omit it on most of
  theirs (`rebirth.mod`: 29/131 type-3, 27/47 type-2; `Newwworld.mod`: 19/30
  type-3). Absence is the common case for modded content, not an edge case.

  **Resolution order implemented in `itemSlots.allowedSections(baseSid,
  currentSection)`:**
  1. type-3 template's own `ints.slot`, if present and one of the 5 mapped
     values above -> that one specific section (authoritative).
  2. Otherwise, for type-3 only, a one-save observational fallback —
     `webapp/data/itemSlotObservations.json` (generated read-only from the
     live save by a throwaway script, NOT hand-written; 33 armour templates
     where `ints.slot` was absent/unmapped but every live instance still
     agreed on exactly one `section`) -> that one section. A missing entry
     here never restricts anything; it just falls through to step 3.
  3. Otherwise the typecode-level set for a known typecode (2, 3, 4).
  4. Otherwise (typecode unresolved via `gamedataService.lookup()`, or
     resolved to a typecode with no rule here) -> **permissive**: every
     documented slot is offered, and `widened: true` is reported so the UI
     can say so once. Hiding a legitimate slot on a modded item this editor
     has never seen is worse than occasionally offering an invalid one.

  Always, on top of whichever base set above: the two storage buckets
  (`main`, `backpack_content`) are added unconditionally, and the item's OWN
  current `section` is added if not already present — otherwise an item
  sitting in an unexpected slot would become impossible to move out of.

  `gamedataService`'s cached name index now also stores each record's
  `ints.slot` (or `null`) alongside `name`/`type`, so `itemSlots.js` never has
  to re-open a data file at request time; the on-disk cache
  (`webapp/.cache/nameindex.json`) got a `CACHE_VERSION` bump so a
  pre-existing cache from before this change is rebuilt rather than served
  with a missing field.

  `saveService.setItemSection()` now rejects a target section that isn't in
  `itemSlots.allowedSections(baseSid, currentSection).sections`, before the
  existing collision/displacement logic runs. `itemOf()` carries
  `allowedSections` (the exact `<option>` list, in `ALL_SECTIONS` order) and
  `slotsWidened` (true only when the item's kind was unresolved/unmapped) on
  every inventory row. The Gear card's existing `.hint` gains one clause
  ("`Move to` only offers slots this item's kind is actually compatible
  with...") plus a conditional sentence when any item on the card is
  `slotsWidened`. Race compatibility (a shirt on a hiver) remains explicitly
  unvalidated, per the original 2.1 note.

  **Two pre-existing tests had to be adjusted, not just left in place**: the
  original "moves an item into an empty slot" and "swaps into an occupied
  slot" tests picked an arbitrary item/slot pair with no regard for kind —
  which, on this live save, happened to mean moving a weapon (Flesh Cleaver)
  into `head`/`shirt`. That move is now correctly rejected, so both tests
  were changed to pick an item/slot pair that `itemSlots.allowedSections()`
  actually permits (their assertions and overall structure are otherwise
  unchanged — they still verify "only the moved item's section changes" and
  "the displaced occupant flips back to main"). Five new tests cover the
  compatibility rules themselves: weapon-into-shirt rejected byte-identical;
  armour-into-hip rejected byte-identical; a shirt-slot item moving from
  `main` and from `backpack_content` into `shirt` both succeed (the case that
  must keep working); an item with a corrupted/unresolvable `base data sid`
  is permitted into any slot (permissive fallback); and a direct unit test on
  `itemSlots.allowedSections()` confirming a weapon's own current section
  (forced to `shirt`, not a normal weapon slot) is still always included in
  the result.

### 2.2 Add a new item to inventory — capability prerequisite

**Investigation complete (read-only sweep of live save `save1`: all 23
`.platoon` files, 1648 type-42 ITEM records, 62624 gamedata templates; scripts
kept in the scratchpad, not shipped).** This resolves every "needs
investigation" question the two tasks below raise. Implement against these
facts, do not re-derive or guess.

**(a) A type-42 ITEM record's shape is completely deterministic.** All 1648
live records agree on section membership AND key insertion order — there is
exactly one `ints` order, one `bools` order, one `floats` order, and two
`strings` orders. A minted record must reproduce one of these exactly:

- Container fields: `instanceCount: 0`, `type: 42`, `name: "0"` (the literal
  one-character string, on all 1648), `sid: "<id>--INGAME"`, `modDataType: 0`.
- `vec3`, `vec4`, `filenames`, `extra`, `instances` — **all empty** on all 1648.
- `bools`, in order: `death` (false), `in inventory` (true).
- `floats`, in order: `charges`, `quality`.
- `ints`, in this exact order (15 keys — the order is NOT alphabetical and NOT
  grouped; copy it verbatim):
  `item function`, `inventory y`, `insideBuildingI`, `level`,
  `insideBuildingCS`, `insideBuildingC`, `insideBuildingS`,
  `insideBuildingTYPE`, `ownedbyCS`, `ownedbyS`, `quantity`, `ownedbyI`,
  `ownedbyC`, `inventory x`, `ownedbyTYPE`
- `strings`, one of two orders, decided by the template's typecode:
  - equippable (template type 2/3, and the one observed type 107):
    `uniform`, `color sid`, `material sid`, `company sid`, `section`,
    `base data sid`  (1145 records)
  - non-equippable (template type 4): the same list **without `uniform`**
    (503 records)

**(b) Field values — what to write, and the evidence.**

- `item function`: determined by the template. Type 2 -> `5` (262/262 live),
  type 3 -> `6` (882/882). Type 4 varies per template and must be copied from
  the **template's own `ints['item function']`** — that matched the live item
  on every type-4 template except two (`Cats`/`String of Cats` from
  Newwworld.mod, template 0 vs item 14; and one `Building Materials`, template
  7 vs item 0). Both exceptions are plausibly load-order overrides of a sid
  this editor's first-definition-wins index resolves differently — not worth
  blocking on, but do not claim the mapping is exceptionless.
- `quantity`: 1 unless stacking (see (d)).
- `charges`: `1`. Universal on type 2/3 (1144/1144) and the mode for type 4.
  Note the template also carries its own `floats.charges` (First Aid Kit: 200)
  which is NOT what live items hold — do not copy the template's value.
- `quality`: `100` for template type 2/3 (universal in the save: 882 armour +
  262 weapons, all exactly 100); `1` for type 4 (the mode, 404/503). Again do
  NOT copy the template's own `floats.quality` (First Aid Kit template: 25,
  live items: 5).
- `level`: caller-supplied (this is the user-facing "quality" tier — see (e)).
  Type 4 items are `0` on all 503 live records; default type 4 to 0 and ignore
  a caller-supplied level for them.
- `inventory x` / `inventory y`: `0` / `0`. 1419 of 1648 live items sit at
  0,0, including many co-existing in one bag, so the game clearly re-packs the
  grid itself rather than trusting these. Do not attempt grid placement.
- `insideBuildingI/C/S/CS`: `0`; `insideBuildingTYPE`: `11`.
- `ownedbyC/CS/I/S`: `0`; `ownedbyTYPE`: `11`. This all-zeros + TYPE 11 combo
  is the single most common (1228/1648); the nonzero variants look like
  ownership/stolen-goods tracking and several hold values that read as
  reinterpreted float bits (e.g. `ownedbyS: -1230779968`), so zeros are both
  the modal and the conservative choice.
- `section`: caller-supplied, validated through `services/itemSlots.js` (see
  (f)).
- `uniform`, `color sid`: empty string `""` (the overwhelming default), and
  only emit `uniform` at all for the equippable string-order above.
- `company sid`: empty string `""` for template type 3 and 4 (universal:
  882 + 503 live records all empty). For type 2 (weapons) it is **set** on all
  262 live records and resolves to a **type-51** record (the manufacturer —
  `Metal Purity`, `Old-Eye Blades`, `Catun Scrapmaster`). See (e).
- `material sid`: set on every live item. **The template's own
  `extra` Map has a `material` category whose first row's `target` is the
  correct default** — confirmed end-to-end (Basic First Aid Kit template ->
  `5263-lanterns_otto.mod`, which is exactly what 101 live First Aid Kit
  records carry; Samurai Armour -> `14519-gamedata.base`, matching 97 live
  records). It resolves to a **type-47** record for armour/trade goods.
  Weapons (type 2) have **no `extra` at all** on the template, and their
  `material sid` resolves to a **type-50** record instead — the weapon grade
  ladder (`Totally rusted junk`, `Rusted junk`, `Edge Type 1..5`, `Mk III..V`,
  `Catun No.1..3`, `Industrial 004..008`). See (e).
  Fall back to `""` when no `material` row exists and no type-50 default is
  chosen — an empty material is already the live norm for `company sid` so it
  is not a novel shape, but flag it in the receipt.

**(c) The INVENTORY (type 41) container.** Confirmed shape: it carries **no
bools/floats/ints/strings/vec/extra at all** — it is a pure instance list. Each
instance is `{ id, target, pos: [0,0,0], rot: [1,0,0,0], states: [] }` where:
- `id` is a **small ordinal string counted within that bag** (`"1"`, `"2"`,
  ...), NOT a sid — do not mint an `-INGAME` sid here.
- `target` is the new ITEM record's sid (`"<newId>--INGAME"`).
- `states` is **always empty** for item instances (confirmed again here, matching
  Phase 0).
- The record's `instanceCount` field must be bumped in lockstep with
  `instances.length` — **for a type-41 container specifically.** Verified
  during implementation: `instanceCount` is NOT universally the instance count,
  contrary to AGENTS.md §3's original blanket claim (now corrected there).
  Across all 3933 records of the live save it agrees on 282/282 type-41 and
  1648/1648 type-42 records, but on type 30 (SQUAD) 23 of 25 records carry
  `instanceCount: 0` against 2-19 real instances; types 28/38/94/108 disagree
  too. It does not drive parsing (`readRecord` reads the instances section's own
  count separately). `ids.addInstance()` therefore bumps it only when the record
  already kept the two equal, and leaves it alone otherwise — relevant to Phase
  1.6 (character transfer), which edits SQUAD records.

**(d) Stackability.** Only template type 4 carries `ints.stackable`; type 2 and
type 3 templates have no such field (0/50 weapons, 0/1646 armour) and no live
weapon or armour item was ever observed with `quantity > 1`. So: **offer a
quantity control only when the template has a truthy `ints.stackable`, and
reject `quantity > 1` server-side otherwise.** Caveat to encode honestly:
`stackable` was `1` on every type-4 template sampled, so it confirms "this may
stack" but never discriminates a non-stacking type-4 item — it is a necessary,
not sufficient, condition. No maximum stack size is documented anywhere in the
data; observed live stacks run to 100 (`Cats`). Leave uncapped, say so in a
comment (matching the existing task text).

**(e) "Quality" is three different things depending on the item's kind** — the
UI's single "quality" control must not pretend otherwise:
- **Armour (type 3):** `ints.level`. Live values are exactly {20, 40, 60, 80,
  95}, a subset of the guide's named ladder (5 Prototype, 20 Shoddy, 40
  Standard, 60 High, 80 Specialist, 95 Masterwork). This is the good case.
- **Weapons (type 2):** `ints.level` also varies ({5,10,15,20,25,35,40,95}),
  but the *named* Kenshi weapon grade is the `material sid` (type-50) +
  `company sid` (type-51) pair, which `saveService`'s existing comment and
  TODO.md 3.4 both explicitly decline to map. Keep that stance: set `level`
  from the caller, take material/company from a sane default, and do not
  claim to set "Meitou".
- **Trade goods (type 4):** `level` is always 0 and `quality` is 1 (or 5 for
  first aid kits). Offer no quality control at all.

**(f) Destination slot.** Reuse `itemSlots.allowedSections(baseSid,
currentSection)` — for a not-yet-existing item pass `currentSection` as null/
empty. It already returns the buckets (`main`, `backpack_content`) plus the
kind's real equip slots, and reports `widened` for unresolvable kinds. Do not
write a second compatibility path. Adding **into an already-occupied
single-occupancy slot must displace the prior occupant back to `main`**, the
same rule `setItemSection()` already implements — share that logic, don't
duplicate it.

**(h) `material sid` must be resolved by UNIONING every definition of the
template sid, not by first-definition-wins.** `gamedataService`'s index keeps
the *first* definition of a sid it sees, which is correct for display names but
**wrong** for `extra['material']`: mods routinely re-define a vanilla template
purely to attach extra material/texture rows. Worked example — `Leather Shirt`
(`1169-gamedata.base`): the `gamedata.base` definition has no `material` rows at
all, yet every live Leather Shirt item carries a material sid, and those sids
(`148-Unofficial Patches for Kenshi.mod`, `26-Dropped in Style.mod`) come from
*mod* re-definitions of that same template sid.

Collecting the union of `extra['material']` targets across **all** definitions
of a sid and comparing against what live items actually carry: of the 58
distinct base sids in use in this save, **49 have at least one candidate
material this way, and for all 49 the candidate set contains the material the
live item actually uses — 49/49, no exceptions.** The 9 with no candidate are
all type-2 weapons, which never have `extra.material` (0/50 templates) and are
handled by (i) instead. So: default `material sid` to the first unioned
candidate; fall back to `""` only when there is genuinely none.

**(i) The weapon grade ladder IS recoverable — TODO 3.4's "not attempted"
stance can be relaxed for weapons.** A type-51 record (the manufacturer/
"company") carries an `extra['weapon models']` category whose rows point at
type-50 records (the grade), with `v0` as the grade's rank. Unioning across all
data files yields a complete 38-row ladder for this install, ordered by `v0`:

```
v0=0   Totally rusted junk   (Unknown)          v0=40  Catun No.3 / Industrial 008
v0=5   Rusted junk           (Unknown)          v0=45  Catun No.4
v0=10  Rusted junk           (Homemade)         v0=50  Catun No.4 / Mk III
v0=15  002                   (Metal Purity)     v0=55  Mk IV      (Truth Two)
v0=20  003 / Merchants Blade                    v0=60  Mk V       (Truth Two)
v0=25  Industrial 004        (Metal Purity)     v0=65  Mk VI      (Truth Two)
v0=30  Catun No.1 / Industrial 005/007          v0=70  Edge Type 1 (Edgewalkers)
v0=35  Catun No.2            (Catun Scrapmaster) v0=75 Edge Type 4 (Edgewalkers)
                                                v0=80  Edge Type 5 (Edgewalkers)
                                                v0=100 Meitou     (Cross, rebirth.mod)
```

So a weapon's grade is the **(`company sid`, `material sid`) pair**, and the
ladder names it. Verified: all **262/262** live weapons in this save use a
(company, material) pair that exists in this ladder.

**Do NOT claim `ints.level` equals the ladder's `v0`.** It correlates but does
not match: `v0 === level` on only 166 of those 262 (e.g. a `Staff` at level 10
sits on the v0=5 "Rusted junk" row; a `Katana` at level 95 on the v0=20 "003"
row). Treat `level` and the grade pair as two independent fields the caller
sets separately — which is also what the live data shows.

**(g) Item templates are typecodes 2/3/4 (not 42).** The existing 2.3 task text
says "filter to type 42" — that is **wrong** and must not be implemented.
Type 42 is the *save-side instance* record; a **template** in gamedata is type
2 (weapon), 3 (armour) or 4 (trade goods/consumable), plus a rare type 107 seen
once. Supporting cast, for reference and for the picker's enrichment: type 47 =
material/texture variant, type 50 = weapon grade, type 51 = weapon
manufacturer. The picker must filter to {2, 3, 4}.

- [x] **BLOCKED ON CAPABILITY WE DO NOT HAVE: minting a new record.**
  This is the headline feature the user asked for and it is the single
  largest piece of new codec-adjacent work in this plan. Everything else in
  2.2 depends on it. Concretely, adding an item means:
  1. A brand-new type-42 ITEM record (id, sid, `base data sid` pointing at the
     item template resolved via `gamedataService`, `quantity`, `section`,
     default `material sid`/`company sid` etc.) appended to the platoon file's
     `records` array.
  2. A new entry in the character's type-41 INVENTORY container record's
     `instances` array (`{id, target: newItemSid, pos, rot, states: []}` —
     confirm from a real record whether item instances carry any `states`)
     pointing at the new record, AND the INVENTORY record's `instanceCount`
     header field bumped to match (per AGENTS.md: "instanceCount... duplicates
     the instances section count. Keep them consistent if you ever add an
     instance").
  3. A fresh, collision-free id for the new record, which needs Phase 0's
     `nextId` investigation resolved first — is `nextId` per-file (each
     `.platoon` has its own, since filetype 15 headers are per-file) or
     global? The save-format doc explicitly lists this as unresolved
     (`docs/save-format.md` §9) and `codec.js`'s `writeFile()` already patches
     `record.length` into the header on write but has no equivalent id-bump
     logic — that needs to be added, likely in `codec.js` (`allocateId(file)`
     helper that reads+bumps `header.nextId` for filetype 15) or a new small
     `services/kenshi/ids.js`.
  4. The record's own `sid` field (`"<id>-<originating file>"`) needs an
     `<originating file>` suffix — investigate what real player-added item
     instances use (does the game ever mint sids with the save's own platoon
     filename as origin? or does it always reference a template's sid
     directly without minting a new sid for the *instance*, only for the
     record wrapping it?). This is genuinely uncertain — resolve it by
     comparing a manually-added-via-FCS item's record fields against a
     naturally-picked-up item's record fields, not by inventing a convention.
  Task: write `services/kenshi/ids.js` (or extend `codec.js`) with
  `nextRecordId(file)` and wire it into a `codec.js`-level `addRecord(file,
  rec)` / `addInstance(containerRec, instance)` helper pair used by
  `saveService`.
  **Test (own dedicated round-trip test, separate from the feature test
  below): add a record with `addRecord`, write the file, re-parse, assert (a)
  byte-for-byte round trip when no record is added (regression guard), (b)
  when one record is added, `recordCount`/header patches correctly, the new
  record parses back identically to what was written, and `nextId` in the
  header increased and no existing id collides with it.**

  **Implemented** (by an earlier agent pass; verified here as a prerequisite
  for the feature task below). `services/kenshi/ids.js` provides
  `nextRecordId(file)`, `mintSid(id)`, `addRecord(file, rec)` and
  `addInstance(containerRec, target, opts)`; `codec.js`'s `writeFile()` patches
  `header.nextId` back into `headerRaw` on write (guarded on `nextIdAt` being
  defined, since mod files have no such field). Its own dedicated round-trip
  tests live in `test/*.test.js` (`addRecord mints a record that round-trips
  and does not collide`, `addRecord rejects a malformed record before
  appending`, `addInstance bumps instanceCount in lockstep and survives round
  trip`, `nextRecordId throws on mod files`, etc.) — all still passing.

- [x] **Add item to inventory (feature, built on the above).** Function:
  `saveService.addItem(saveDir, platoonFile, characterSid, itemTemplateSid,
  { quantity = 1, section = 'main' })` — resolves the template via
  `gamedataService.lookup(itemTemplateSid)` to confirm it's a real item type,
  calls the new `addRecord`/`addInstance` helpers, sets `quantity` and
  `section` on the new type-42 record. Route: `POST
  .../characters/:sid/inventory`. UI: Phase 2.3's item picker feeds an
  "Add to inventory" button.
  Validation: `quantity` positive integer; reject template sids not resolvable
  in the name index; reasonable quantity cap if the game has one (unconfirmed
  — leave uncapped but flag as unvalidated in a code comment).
  Test: round-trip in the scratch save: add an item to a real character,
  re-parse, assert the character's `inventory` (via `readPlatoon`) now
  includes it with correct `base data sid`, and that every other character's
  inventory and the rest of the file is byte-identical except the appended
  record and the touched INVENTORY record.
  **Blocked on the previous task.**

  **Implemented, against the (a)-(i) evidence above exactly, no re-derivation.**
  `services/itemFactory.js` (new) is the single place the type-42 shape
  knowledge lives — `buildItemRecord(templateSid, { section, level, quantity,
  materialSid, companySid })` reproduces 2.2(a)'s 9-section shape and 15-key
  `ints` order verbatim, the two `strings` orders (with/without `uniform`), and
  every 2.2(b) default (item function 5/6/template-copy, `charges: 1`,
  `quality` 100/1, `insideBuilding*`/`ownedby*` zeros + TYPE 11,
  `inventory x`/`y`: 0/0). It returns `{ record, meta }` — `meta` carries the
  template name/type and (for weapons) which grade ladder entry was used, for
  the receipt; never written to disk.

  `gamedataService` gained two new lookups needed for 2.2(h)/(i), both built in
  the SAME single pass over every data file that already builds the name
  index (no extra I/O): `materialCandidates(sid)` returns the UNIONED
  `extra['material']` targets across every definition of `sid` (not
  first-definition-wins — the existing index is correct for display names but
  wrong for this), and `weaponGrades()` returns the full type-51/type-50
  ladder, de-duplicated by (company, model) and sorted by rank ascending.
  `CACHE_VERSION` bumped 3 -> 4 (new `itemFunction` per-entry field, plus the
  two new top-level `materialIndex`/`weaponGrades` cache collections) so a
  pre-existing on-disk cache is rebuilt rather than served incomplete.

  Weapon grade defaulting follows 2.2(i) exactly: if the caller supplies a
  `materialSid` (a type-50 grade sid), its company is resolved from the ladder
  (and an explicit `companySid` is cross-checked against it, rejected on
  mismatch); if not supplied, defaults to the LOWEST-ranked ladder entry — never
  a high tier silently. `level` is never conflated with the ladder's `v0`, per
  2.2(i)'s explicit warning — they're set independently, `level` defaulting to
  0 when the caller doesn't supply one (not documented either way, chosen
  conservatively).

  `saveService.addItem()` follows `setPlayerMoney()`'s reference shape:
  computes `{ file, bytes, item, displaced }` and returns it; never touches the
  live save directory. Validates, in order: `quantity` is a positive integer;
  `templateSid` resolves via `gamedataService.lookup()` and is typecode 2/3/4
  (2.2(g) — rejects a stray type-42 sid explicitly, that would be an
  *instance*, not a template); `quantity > 1` rejected unless
  `tmpl.stackable` (2.2(d), no upper bound, commented as such); `section` is
  validated through `itemSlots.allowedSections(templateSid, null)` — the exact
  same function `setItemSection()` uses, no second compatibility path (2.2(f)).

  The collision/displacement rule was pulled out of `setItemSection()` into a
  new shared `displaceIntoSlot(bag, bySid, excludeSid, targetSection)` helper
  in `saveService.js` (2.2(f)'s explicit "share that logic, don't duplicate
  it") — `setItemSection()` was refactored to call it too, so there is exactly
  one copy of the collision rule now, not two. `addItem()` calls it with
  `excludeSid: null` since the new item has no sid yet when the check runs.

  Route: `POST /api/saves/:name/platoons/:file/characters/:sid/inventory`,
  body `{ templateSid, section, quantity?, level?, materialSid?, companySid? }`,
  validated at the route boundary (400 on missing/wrong-typed fields) before
  reaching `mutation.mutate()`, same pattern as the other routes in
  `routes/api/saves.js`.

  Tests added to `test/mutation.test.js` (baseline 58 passing -> 65 passing, 0
  failing, `npm test` reconfirmed after every change): add-and-round-trip
  (asserts every pre-existing record except the touched INVENTORY record is
  `assert.deepStrictEqual`-identical to before, the new record is the last one
  appended, `instanceCount === instances.length` on the touched INVENTORY
  record, the minted id collides with nothing in the file, and header `nextId`
  advanced); stackable-quantity-5 succeeds and non-stackable-quantity-5 is
  rejected byte-identical; unresolvable template sid rejected;
  wrong-typecode template (a real type-51 company sid) rejected; a
  kind-incompatible section (weapon into `head`) rejected; `quantity` 0 / -1 /
  1.5 all rejected byte-identical; and the displacement case (forcing an
  existing item into `head`, then adding a new head-slot item, asserting the
  prior occupant flips to `main` in the same write).

  **What (a)-(i) turned out to be incomplete or unverifiable when exercised:**
  the type-4 `item function` "two observed exceptions" (Cats, Building
  Materials) are carried forward as a code comment, not re-investigated —
  `itemFactory.js` still copies the template's own value and does not attempt
  to special-case those two sids. Whether an install with NO type-51/type-50
  records at all (a very stripped mod list) still mints a sane weapon item was
  not exercised against a real save — `buildItemRecord()` degrades to empty
  `material sid`/`company sid` in that case rather than throwing, which is a
  judgment call, not a measured fact. The route's `quantity`/`level` body
  validation only checks `typeof === 'number'`, not integer-ness or sign — that
  finer validation intentionally lives in `saveService.addItem()` (single
  source of truth for the domain rule), so a route-level 400 for e.g.
  `quantity: 1.5` is instead a 500 with the service's own error message; this
  matches how `/stats` and other existing routes already delegate range
  checks to the service layer, not a new inconsistency.

  **What was not built, and why:** no UI wiring (no "Add to inventory" button
  in `characterCard()`/Gear tab) — Phase 2.3's item picker (`GET
  /api/gamedata/items`) is the UI's data source and is already done, but
  wiring a picker + form + `showReceipt()` call was out of scope for this pass
  (backend + tests only, per the task).

  **Follow-ups applied during verification** (not by the implementing pass):
  - `weaponGrades()` **is** now exposed over HTTP as
    `GET /api/gamedata/weapon-grades`, since it is the UI's quality control for
    weapons and 2.2's whole point was to be ready for that UI. Covered by a test
    in `test/gamedata.test.js` asserting the ladder is rank-ordered and
    de-duplicated on (company, model) — `addItem` defaults to `grades[0]`, so a
    mis-sorted list would silently hand out the wrong default.
    `materialCandidates()` remains internal; nothing in the UI flow needs it yet.
  - `addItem()` now **rejects unknown option keys** instead of ignoring them.
    Found by verification: calling it with an intuitive-looking
    `grade: <type-50 sid>` silently produced a "Totally rusted junk" weapon
    rather than the requested Meitou, because the option is really named
    `materialSid` (the grade IS the material). Silently writing the wrong item
    into a save is the worst failure mode this route has; regression test in
    `test/mutation.test.js`.

### 2.3 Item catalog / picker (supports 2.2's UI, otherwise standalone)

- [x] **Picker UI built** (`addItemSection`/`addItemResults`/`addItemConfig` in
  `public/app.mjs`, wired in `wire()`). An "Add item" collapsible section at the
  top of the Gear card, following the flow search -> select -> configure ->
  place, each step revealing the next.

  - **Search results and the configure step render imperatively, not through
    `render()`.** A full re-render per keystroke would tear down the search box
    mid-type. Only the successful write re-renders, because that genuinely
    changes what the item tables show. Requests are debounced 180ms and a
    slower earlier response is discarded if the query moved on (`pick.query !==
    query`), so results can't arrive out of order.
  - **Picker state is keyed by `"<file>::<sid>"` in `state.addItem`**, the same
    trick `trainChoice` uses, so a successful add doesn't wipe the search and
    selection — adding a second of something is one more click, not a restart.
  - **"Quality" is three different controls, per (e)**: armour gets Level + the
    named preset ladder, weapons additionally get the grade `<select>` fed by
    `GET /api/gamedata/weapon-grades` (fetched lazily the first time a weapon is
    picked, not at boot), trade goods get neither and get a Quantity box
    instead — gated on the row's own `stackable`. Every kind-specific decision
    comes off the server row; the client never classifies an item itself.
  - **Destination** is the row's `allowedSections`, defaulting to the first
    entry, which is always the `main` bucket — a default that can never displace
    anything. A live "Replaces X, which moves back to Carried (main)" note
    computes client-side before the write, mirroring the existing per-row move
    control.
  - Two new style-guide components were needed and are documented in
    `styles.css`: `.picker-results` (a max-height scrolling result list — 2000+
    templates would otherwise push the rest of the card off-screen and defeat
    the collapsible sections) and `.field--grow` (a search box shouldn't be
    shrink-to-fit).
  - **Pre-existing bug fixed while verifying at 560px:** `.workspace` grid items
    had the default `min-width: auto`, so the detail pane's widest item table
    dragged the whole track past the viewport and the PAGE scrolled sideways
    (style guide §2.7) instead of the table scrolling inside its `.table-wrap`.
    One line: `.workspace > * { min-width: 0; }`. Not caused by this feature —
    reproduced with the Add item section closed.
  - **Verified by driving the real app**, not just by reading the code: a second
    server instance was pointed at a *copy* of the save (`pathService`
    overrides + `KENSHI_MKII_PORT`), and a Meitou Katana at level 95 was added
    to a hip slot — confirmed on disk as `material: Meitou, company: Cross,
    level: 95, section: hip`, with the pre-existing Katana displaced to `main`,
    no duplicate record ids, and `instanceCount` consistent. A 25-stack of
    Advanced First Aid Kits was added likewise and landed with the correct
    type-4 record shape (no `uniform` key, `item function: 1`). Checked at
    1400px and 560px. The user's live save was never written to.
  - **Not done:** no test coverage for the UI itself — this repo has no browser
    test harness, and adding one was out of scope. The verification above was
    manual (driven through Playwright), so a future change to `app.mjs` will not
    be caught by `npm test`.

- [x] **Backend done.** `gamedataService.itemTemplates()`
  and `GET /api/gamedata/items` ship with 7 tests in `test/gamedata.test.js`
  (including an explicit regression guard that no type-42 row can appear).
  Measured on this install: 2067 item templates — 1646 armour (t3), 371 trade
  goods (t4), 50 weapons (t2). Rows carry everything the described UI flow
  needs: `stackable` for the quantity control, `kind` for which quality control
  to show, and `allowedSections`/`slotsWidened` for the destination picker.

- [ ] **"Add item" picker UI**: the name index (`gamedataService`) already
  holds every item definition; group by typecode and expose
  `GET /api/gamedata/items` returning `{ sid, name, ... }[]` filtered to the
  item-template typecodes. ~~type 42~~ — **corrected by the 2.2 investigation
  above, see (g): 42 is the save-side instance record, NOT a template. The
  template typecodes are 2 (weapon), 3 (armour) and 4 (trade goods).**
  UI: searchable `<select>` or filtered list, wired to 2.2's "Add" button.
  Test: unit test on `gamedataService` asserting the filter returns only
  entries of those typecodes and is non-empty against the real data files (same style as
  existing gamedata tests, if any — check `webapp/test/` for a
  `gamedata.test.js` pattern; if none exists this is the first).

  **The picker must be driven by `gamedataService`, with `data/items.canonical.json`
  as an enrichment layer only — never the other way round.** Measured after the
  wiki catalog was built: this install has **2162 item-typed stringIDs**, and the
  catalog resolves **387 of them (17.9%)**. The other 1775 have no wiki page at
  all and are overwhelmingly *mod* content (GenMod 238, Universal Wasteland
  Expansion 170, UnknownRegionsAdventures 148, Ronin's Armor Sets 120, …). A
  catalog-driven picker would therefore hide ~82% of the items in the user's own
  install, including everything their mods add. Join on `stringId`: list from the
  index, and when the catalog has a matching entry, decorate the row with its
  category/description/image. Items with `stringId: null` in the catalog are wiki
  pages with no in-game record (cut content, mostly) — they must never appear in
  a picker, since there is nothing to write into the save.

---

### 2.4 Gear page redesign (user-reported: quantity broken, controls confusing)

- [x] **`quantity` had no mutation at all.** It could only be set when an item
  was first created, so the Gear table rendered it as read-only text and the
  user's report that "quantity does not work" was exactly right — there was no
  code path to change it. Fixed by `saveService.updateItem()`.

- [x] **`saveService.updateItem()` — one staged edit covering slot, level,
  quality, quantity and weapon grade.** `setItemSection()`/`setItemQuality()` are now
  thin wrappers over it, so the collision/displacement rule still lives in
  exactly one place (`displaceIntoSlot`). Route:
  `PUT .../inventory/:itemSid`. Combining is not cosmetic:
  `mutationService.mutate()` treats each call as one staged edit against one
  pre-edit snapshot and takes one backup, so the old two-button row meant two
  gate passes, two backups, and a window where disk held a half-applied state.
  All validation runs before any mutation, so a partly-valid patch can never
  half-edit a record. Tests: quantity set/rejected (non-stackable, 0, negative,
  fractional), combined slot+level+quantity asserting ONE changed file and ONE
  receipt, unknown-field and empty-patch rejection, and weapon re-grading.

- [x] **Weapon grade is now editable on an existing item**, not just at
  creation. Being able to pick Meitou when adding a katana but not when editing
  one was exactly the kind of asymmetry that made the page confusing.
  `materialSid` names a ladder entry (a type-50 sid) and `company sid` is
  resolved from it and written in lockstep — the pair IS the grade (2.2(i)), so
  they can never be written out of step. Rejected on non-weapons.

  **Correction, found later while building bulk equip:** "`materialSid` names a
  ladder entry" was wrong. It names a *model*, and a model can belong to more
  than one company — 14 of this install's 24 model sids appear under two
  (`1069-gamedata.base` is both "Homemade" and "Edgewalkers"). So the `<select>`
  keyed on `modelSid` emitted duplicate option values, and
  `grades.find(g => g.modelSid === ...)` silently resolved to whichever row
  sorted first: choosing "Edge Type 5 — Edgewalkers" wrote Homemade. The pair
  really is the grade, which means the *key* has to be the pair too. Every
  ladder row now carries `id: "<companySid>|<modelSid>"`, `gradeId` is what the
  UI and the API pass, and `itemFactory.resolveGrade()` is the single place that
  resolution happens. See the bulk-equip entry at the end of this file.

- [x] **UI redesign.** What was wrong, and what replaced it:
  - *Two write buttons per row ("Move" for the slot select, "Set" for the
    number boxes) with no visual link to their controls.* Now every control is a
    pending edit and **one "Apply" per row** commits them together. It stays
    **disabled until something actually differs from disk**, so pressing it can
    never produce the mutation gate's "edit produced no change" error, which
    read like a bug for what looked like a valid action.
  - *A "preset…" dropdown that only quick-filled a box, beside a raw `level`
    number and a raw `quality` number.* Now **one named control per concept**,
    chosen by kind (2.2(e)): armour gets the named tier ladder, weapons get the
    grade ladder, trade goods get neither. The raw `level`/`quality` numbers
    moved behind a per-row **"More"** disclosure — relocated, never dropped,
    since removing reachable capability to tidy a view is not a redesign.
  - *Raw on-disk slot keys shown as labels.* Now human labels (`Body armour`,
    `Hip (weapon)`, `In backpack`) with the raw key still the written value.
  - **Slot icons** (inline SVG in `ICON_PATHS`, not an icon font) encode which
    slot a row occupies, making a long inventory scannable by shape. Recorded as
    an explicit carve-out in `docs/ui-style-guide.md` §1: informational glyphs
    are allowed, an icon duplicating an adjacent label is not.
  - Fixed a **pre-existing** layout bug found while checking 560px:
    `.workspace` grid items had the default `min-width: auto`, so the widest
    item table dragged the page into horizontal scroll (§2.7) instead of
    scrolling inside its own `.table-wrap`. Reproduced with the new section
    closed, so it predates this work.

  **Verified by driving the real app** against a *copy* of the save (second
  server instance via `pathService` overrides + `KENSHI_MKII_PORT`), not just by
  reading the code: quantity 1 -> 77 persisted; a Naginata re-graded to Meitou
  AND moved to hip in one Apply, with the Katana displaced to Carried and
  `company sid` following the grade; exactly one backup per Apply. Checked at
  1400px and 560px. The live save was never written to.

  **Still not covered:** no automated UI tests (no browser harness in this
  repo), so `app.mjs` regressions won't be caught by `npm test`.

## Phase 3 — Everything else from the guide

Ordered by dependency; independent items can be done in any order within.

### 3.1 Armour colour (type 42 — ITEM)

- [x] **Set/clear an item's colour scheme.** Field: `strings['color sid']`
  (confirmed lowercase `color`, American spelling). A non-empty value is a
  **typecode-55** record's stringID — `services/colorsService.js` builds that
  catalogue in load order (like `racesService`/`factionsService`): each row is
  `{ sid, name, color1, color2, hex1, hex2 }`, `hexN` being `ints['color N']`
  (a packed `0xRRGGBB`) rendered as `#RRGGBB`. A type-3 armour template's own
  `extra['color']` category, if it carries one (15 of this install's
  templates do), is UNIONED across every definition of the sid — the same
  rule as the material index and the racial `races`/`races exclude` rows.
  `colorsService.allowedColors(baseSid, currentColorSid)` returns
  `{ sids, widened }`: the template's own list when it has one, else the
  WHOLE catalogue with `widened: true` — never a block, per AGENTS.md §3.
  Function: `saveService.setItemColor(saveDir, platoonFile, characterSid,
  itemSid, colorSid)` — a thin wrapper over `updateItem({ colorSid })`;
  `colorSid: ''` clears it (the key exists on every type-42 record, empty or
  not, so this never mints). A non-empty value that doesn't resolve through
  `colorsService` is a WARNING on the receipt (`warnings[]`), never a
  refusal — mods define schemes this install may not have indexed. Route:
  `PUT .../characters/:sid/inventory/:itemSid/color`, plus `colorSid` on the
  unified `PUT .../inventory/:itemSid`. Catalogue: `GET /api/colors` +
  `POST /api/colors/rebuild`. Read side: `itemOf()` now carries `colorSid`,
  `colorName` (null on a miss), `colorHex` (for a swatch, null on a miss),
  `allowedColors`, `colorsWidened`. UI: a `<select data-field="colorSid">` in
  the Gear row's "More" panel (a coloured `.dot` swatch — the existing status
  indicator class, colour overridden inline — appears next to the item name
  when it has a colour), joining the existing diff-then-Apply mechanism; a
  blank `<select>` value is a real, selectable state (how a colour is
  cleared), which needed a small fix in `shell.mjs`'s `collectPatch()` — a
  blank value on a `<select>` is sent, while a blank value on a plain number
  input still means "nothing typed, leave alone".
  Test: `webapp/test/mutation.test.js` — set then clear, asserting the string
  key stays present (never deleted) and every other string/int/float on the
  record is untouched; a combined test applying colour + uniform + stolen +
  section in one `updateItem()` call.

### 3.2 Uniform tag (type 42 — ITEM)

- [x] **Set/clear the uniform faction tag.** Field: `strings.uniform` — a
  typecode-10 faction stringID, the SAME catalogue `services/factionsService.js`
  already builds (`GET /api/factions` for the full list). **Confirmed:
  5219 of 8300 type-42 records in the fixture have NO `uniform` key at all**
  — the non-equippable string order (type-4/46/102 templates, TODO.md 2.2(a))
  — so this is refused outright on those, never minted, exactly like the
  existing missing-`level`/`quality` refusals. `itemOf()` carries `hasUniform`
  (does the record carry the key at all) separately from `uniformSid` (its
  value, which can legitimately be `''`) — the UI decides whether to offer the
  control on `hasUniform`, never on whether the value happens to be empty.
  Function: `saveService.setUniform(saveDir, platoonFile, characterSid,
  itemSid, uniformSid)`, a thin wrapper over `updateItem({ uniformSid })`;
  `''` clears. A non-empty value that doesn't resolve via
  `factionsService.templateOf()` is a WARNING, not a refusal — the literal
  string `defaultEmpireFactionSID` is a legitimate live value (TODO.md Phase 0
  §2.2(a)) and, in this install, actually resolves to a real type-10 record
  (one of the ~23 gamedata records whose sid is a literal name rather than the
  usual `<id>-<file>` form, AGENTS.md §3's Research-template case), so it is
  not even guaranteed to be a miss everywhere. Route:
  `PUT .../characters/:sid/inventory/:itemSid/uniform`, plus `uniformSid` on
  the unified `PUT .../inventory/:itemSid`. UI: a `<select data-field=
  "uniformSid">` in the Gear row's "More" panel, rendered **only when
  `hasUniform` is true**; a current value that doesn't resolve is kept as its
  own selected option showing the raw string, so simply opening the row and
  clicking Apply on something else can never silently blank it.
  Test: set on an item that has the key (only that string changes); refused
  on an item that doesn't (byte-identical); covered again in the combined
  section/colour/uniform/stolen test.

### 3.3 Stolen tag (type 42 — ITEM)

- [x] **Clear stolen flags.** Fields confirmed in `ints`: `ownedbyC`,
  `ownedbyCS`, `ownedbyI`, `ownedbyS`, `ownedbyTYPE` — all present on every
  type-42 record. **`ownedbyTYPE` is 11 on 100% of the fixture's records, so
  it is NOT the stolen signal**; the signal is a nonzero `ownedbyCS` or
  `ownedbyS` (`ownedbyC`/`ownedbyI` were 0 on every sampled record). Read
  side landed first, per the task's own note: `itemOf()` now carries `stolen`
  (boolean) and `owner` (`{ C, CS, I, S, TYPE }` raw). Function:
  `saveService.clearStolen(saveDir, platoonFile, characterSid, itemSid)`, a
  thin wrapper over `updateItem({ clearStolen: true })` — `true` is the only
  accepted value, and all five keys must already exist or the write is
  refused (none observed missing them, but the "never mint" rule applies
  uniformly). Sets `ownedbyC/CS/I/S` to 0 and `ownedbyTYPE` to 11 — the
  observed "unowned" shape (6371 of the fixture's 8300 records). Route:
  `POST .../characters/:sid/inventory/:itemSid/clear-stolen`, plus
  `clearStolen: true` on the unified `PUT .../inventory/:itemSid`. UI: a
  `badge badge--warn` reading "stolen" on the item name cell (only rendered
  when `it.stolen`), and a "Clear stolen flags" checkbox in the Gear row's
  "More" panel (also only rendered when stolen — nothing to clear otherwise),
  joining the same diff-then-Apply Apply button rather than a separate write
  path.
  Test: clearing a record with nonzero `ownedbyS`/`ownedbyCS` (asserts all
  four zeroed, `ownedbyTYPE` 11, and `ints` key insertion order otherwise
  unchanged); clearing an already-clean record rejected by the mutation
  gate's existing "edit produced no change" rule (mirrors the `restoreLimbs`
  no-op test); covered again in the combined test.

**What shipped across all three, and what did not:**

- One new service, `services/colorsService.js`, modelled on
  `racesService`/`factionsService` — load-order resolution, disk cache at
  `webapp/.cache/colors.json`, `rebuild()`. 155 colour schemes resolved on
  this install (only 15 base-game armour templates carry an allow-list; the
  rest are `widened`).
- `updateItem()` gained three fields (`colorSid`, `uniformSid`, `clearStolen`)
  in `UPDATE_ITEM_FIELDS`, validated BEFORE any write (AGENTS.md §4) and
  applied in the SAME staged edit as `section`/`level`/`quality`/`gradeId` —
  no second write path, per AGENTS.md §2's explicit rule.
  `setItemColor()`/`setUniform()`/`clearStolen()` are thin wrappers, the same
  shape as `setItemQuality()`.
- Deliberately did NOT add a second, independent "colour compatibility" gate
  the way `itemSlots.js` gates `section` — colour is advisory everywhere per
  the task brief, so `allowedColors()` only ever WIDENS, never restricts a
  write.
- Deliberately did NOT attempt to interpret the nonzero `ownedby*` values
  themselves (they read as reinterpreted float bits or runtime handles,
  e.g. `-1351759424`) — only detect-nonzero-and-clear, exactly as scoped.
- The frontend fix worth flagging: `shell.mjs`'s row-level `collectPatch()`
  previously treated ANY blank control value as "nothing changed, skip it".
  That was correct for the plain number inputs it was written for, but wrong
  for a `<select>` whose blank option is a real state (colour/uniform's
  "— none —") — fixed by branching on `el.tagName` rather than widening the
  blank-value skip to cover selects, which would have made colour/uniform
  impossible to ever clear via Apply.

### 3.4 Weapon and armour quality (type 42 — ITEM)

- [x] **Armour quality (`Level`) — investigated and implemented.** Phase 0
  had already confirmed `ints.level` (lowercase) and `floats.quality` are two
  genuinely distinct fields, both populated independently, but left open
  which one (if either) is the FCS guide's named "Level" tier. Resolved by a
  read-only dump (scratchpad script, not shipped) of every type-42 ITEM
  record across the live save (`quick.save` + all 23 `.platoon` files, 1648
  item records total), grouped by the item's `gamedataService.lookup()` type:
  - **Type 3 (Armour, 882 records): `ints.level` was one of exactly
    `{20, 40, 60, 80}` — a strict subset of the FCS guide's own named-tier
    list (5=Prototype, 20=Shoddy, 40=Standard, 60=High, 80=Specialist,
    95=Masterwork). `floats.quality` was `100` on every single one of the
    882, with zero variation.** A field that never varies cannot be the
    thing that encodes a per-item grade, and a field whose *only* observed
    values are a subset of the guide's own named list is about as strong a
    confirmation as a single save can give without an in-game A/B test.
    **Conclusion: `ints.level` is the armour "Level" field; `floats.quality`
    is not.**
  - **`floats.quality` is not dead everywhere, though — it varies on
    *consumables/trade goods*.** Independent re-run of the same sweep across
    all 1648 type-42 records: on **type 4 (503 records)** `ints.level` is
    always `0` while `floats.quality` takes `1` (×404), `5` (×98) and `100`
    (×1) — e.g. every `Basic First Aid Kit` reads `quality: 5`, while raw
    materials (`Fuel`, `Raw Meat`, `Cats`, `Animal Skin`) read `1`. So
    `quality` carries a real per-item meaning for that class (medical kits
    plausibly their healing grade), and is merely a constant `100` filler on
    armour and weapons. The UI must therefore not present `quality` as a
    generic rarity control: for armour/weapons it is inert, and its meaning
    for type 4 is **still unconfirmed** — no named mapping has been
    established, so it stays a plain numeric input.
  - **Type 2 (Weapons, 262 records): `ints.level` took values
    `{5,10,15,20,25,35,40}`** — a finer, non-matching scale, and
    `floats.quality` was again constant at `100`. This is consistent with
    the FCS guide's own text (see below): for weapons, "Level" is not the
    quality-tier field at all.
  - **The guide itself (`docs/fcs-capabilities.md`, "Weapon and armour
    quality" section) says the two item kinds work differently**: armour's
    quality is the "Level" value (named tiers as above); a weapon's grade
    (Rusting Junk … Meitou) is controlled by a `company sid`/`material sid`
    *pairing*, not by `level`. This matches what the dump shows — weapon
    `level` values don't line up with any named-tier list, because `level`
    isn't the field the guide means for weapons in the first place.
  - **`floats.quality`'s actual role is still unconfirmed** — constant `100`
    on every weapon/armour record in this save (type 4 consumables show it
    varying, `1`/`5`/`100`, so it isn't dead weight in general — just
    apparently not a per-item grade dial for gear). Exposed as an honest raw
    numeric field, not implied to be a grade.
  - **Never invent a number for Meitou** — no weapon in this save exhibits a
    `level` value outside the observed set, and per the point above `level`
    isn't even the right field to look at for weapons. The named-tier UI
    (see below) is offered for the `level` field ONLY, with an explicit hint
    that it is confirmed for armour and does NOT apply to weapon grade.

  Function: `saveService.setItemQuality(saveDir, platoonFile, characterSid,
  itemSid, { level, quality })` — sets either or both, independently (same
  shape as `setHunger()`); both keys must already exist on the record (same
  "never mint a new key" discipline as `setStats()`). No upper clamp (the
  guide documents values continuing to improve past the named vanilla tiers);
  both reject negative. Route: `PUT
  /api/saves/:name/platoons/:file/characters/:sid/inventory/:itemSid/quality`,
  body `{ level?, quality? }`. UI: on the Gear tab, each item row with either
  field present gets a raw `Level` number input, a raw `Quality` number
  input, and a quick-fill `<select>` of the six named armour tiers that just
  writes the number into the Level input (never auto-submits) — the hint
  under the Gear card's header explains the armour-only scope and the
  company/material-sid caveat for weapons. Test
  (`webapp/test/mutation.test.js`): sets `level` alone, confirms `quality`
  unchanged, then sets `quality` alone in a second write, confirms `level`
  held the first write's value.

- [x] **Weapon manufacturer/model (`company sid`, `material sid`) — SHIPPED,
  during the Phase 2 gear work rather than here.** This entry sat unticked
  long after the thing it describes was built; the checkbox was stale, not the
  work. What exists today: `services/itemFactory.js` owns
  `resolveGrade()` and `defaultLevelForGrade()`,
  `gamedataService.weaponGrades()` builds the 38-row ladder,
  `GET /api/gamedata/weapon-grades` serves it, and `gradeId` is an accepted
  field on `updateItem()`, `addItem()` and `regradeMany()` alike. The Gear
  row's grade `<select>` and the bulk re-grade panel are the UI.
  The task's core worry — that a mismatched (company, material) pair resets the
  weapon on load — was answered by making the pair unsplittable rather than by
  warning about it: **the grade IS the pair**, callers pass the ladder row's
  composite `id` (`"<companySid>|<modelSid>"`), and the two strings are always
  written in lockstep. A model sid alone is deliberately not a key, because 14
  of this install's 24 model sids appear under two different companies —
  resolving by model alone silently writes a manufacturer the user did not
  choose. AGENTS.md §3 carries the full rule. Bare `materialSid` still works
  for compatibility and resolves to the lowest-ranked matching row.
  Also settled here: a grade chosen without an explicit `level` now supplies
  one from the ladder row's own `rank`, because a player has one word for the
  concept ("a Meitou katana") and a level defaulting to 0 behind the grade was
  producing Meitou weapons at level 0. They remain two independent fields and
  an explicit `level` always wins; `defaultLevelForGrade()` is the single place
  that decision lives. Scoped to type 2 only — a crossbow (107) takes a level
  but has no manufacturer ladder, so it is *refused* a grade rather than
  silently ignoring one.
  Tests: `webapp/test/regrade.test.js` plus the grade cases in
  `mutation.test.js` and `equip.test.js`.
  **The one thing still not verified, and unverifiable from here:** whether the
  game actually accepts a given pair on load. No offline editor can observe
  that, exactly as this task's own last line predicted. What replaced the
  proposed "warn loudly" UI copy is the stronger guarantee that the editor
  cannot emit a pair that isn't a real ladder row in the first place.

  Original task detail, kept for the record: mismatched company/material pairs
  reset the weapon to a default on load, and a real pairing table needs
  cross-referencing `gamedata.base`'s faction/weapon records, not a single
  save's dump. Full original task detail below, unchanged. Fields:
  `strings['company sid']` and `strings['material sid']` on type 42 (note:
  `material sid` is already read by `itemOf()` today, but currently treated
  as a generic "material" display field — re-check that it means "model" for
  weapons specifically as the guide states, since armour likely uses the same
  key for actual material). Function: `saveService.setWeaponManufacturer` /
  `setWeaponModel`, or a combined `setWeaponVariant(saveDir, platoonFile,
  itemSid, companySid, materialSid)` since the guide's key warning is that
  **mismatched combinations reset the weapon to a default on load** — the UI
  should present known-good (company, material) pairs together rather than
  two independent free-text fields, sourced from `gamedataService` once the
  valid pairing rule is understood (may require cross-referencing
  `gamedata.base` faction/weapon-table records — flag as needing more
  investigation than a quick dump, since "exact SID values... too many to
  list" per the guide).
  Validation: warn loudly in the UI about the reset-to-default risk; consider
  only allowing pairs the editor has verified server-side against the data
  files rather than free text.
  Test: round-trip for a valid pair; a second test asserting the editor
  rejects an unresolvable sid before writing (no live-game verification of
  the "resets to default" behavior is possible from an offline editor — note
  that limitation in the UI copy).

### 3.5 Faction relations (type 37 — FACTION, in `quick.save`)

**Both tasks below SHIPPED** — as a dedicated `services/factionsService.js` and
a Factions tab (`public/modules/features/factions.mjs`), not as the
`saveService.factionsOf()` reader and World-tab row this entry imagined. The
checkboxes were stale, not the work. Covered by `webapp/test/factions.test.js`.
Three things the implementation learned that this task did not anticipate, all
now in AGENTS.md §3:

- **Relations live on the OTHER faction's record.** The player's own type-37
  record carries *no* relation rows at all — it is the only one of the 114 with
  none, and the only one with `floats['global trust']` and `extra['known']`. So
  "my standing with the Holy Nation" is a float on the Holy Nation's record.
  The task's plan of "find whichever `relationSID<n>` equals the player's own
  faction sid" is therefore the right shape but pointed at the wrong record.
- **A faction's identity is `strings['gamedata stringID']`, not its sid or its
  header name.** Save-side sids are runtime handles worthless across saves, and
  matching by header `name` looks fine but breaks on the 7 of 114 whose name
  gamedata never uses — plus the player's own, which carries whatever they
  renamed their squad to.
- **Relations are not symmetric** (458 of 11449 reciprocal pairs disagree), so
  a change is directional and touches exactly one float. Every slot already
  exists, so `setRelations()` **never mints a key** — a missing row is refused,
  not invented. The -100..100 clamp landed as specified. Standing labels are
  derived from each faction's own `enemy classification`/`business relations`,
  never from bands this editor invented.

Original task detail, kept for the record:

- [x] **Read-side first**: surface faction list + relation values in the
  World tab. `docs/roadmap.md`'s "Next" list already flags this as cheap
  read-only work ("faction relations (type 37) with resolved names... already
  parsed, just needs surfacing") — do this before the write task since it
  gives a UI to build the write against and de-risks field-name questions.
  Fields: `relation<n>` floats + `relationSID<n>` strings on type 37 (per
  `docs/save-format.md` §5). Function: add a `factionsOf(world)` reader to
  `saveService.js`, resolving `relationSID<n>` targets through
  `gamedataService.nameOf`. Route: fold into the existing
  `GET /api/saves/:name/status` response or add
  `GET /api/saves/:name/factions`.
  Test: extend `webapp/test` model tests (check for an existing
  `saveService`-focused test file; if none, this is a good place to start one)
  asserting the reader returns plausible relation values for the sample save.

- [x] **Write relation value.** Given a faction record and the index `n` whose
  `relationSID<n>` matches the player's own faction sid (guide: identify by
  "204-gamedata.base" in the sample — **do not hardcode that sid**, resolve
  the player's own faction the same way `worldSummary()` already does via
  `pfaction name`, or by finding whichever `relationSID<n>` equals the
  player's own faction's stringId), set `relation<n>`. Function:
  `saveService.setFactionRelation(saveDir, factionRecordSid, value)` — this
  is the first write in this plan that touches `quick.save` for something
  other than money. Route: `PUT /api/saves/:name/factions/:sid/relation`. UI:
  editable relation value per row in the new faction list.
  Validation: clamp -100..100 per the guide's explicit warning ("values
  outside this range can cause bugs").
  Test: round-trip on `quick.save`, assert exactly one `relation<n>` float
  changed on exactly one type-37 record.

### 3.6 Bounties (type 36 — CHAR_STATE, per the guide; verify)

- [x] **Investigate bounty field layout** — confirmed against a real record
  (`platoon/Cannibals_3.platoon`, sid `84-Cannibals_3.platoon-INGAME`, name
  "Cannibal"): `ints.amount<n>`, `ints.bountyexp<n>`, `ints.claim<n>`,
  `ints.crimes<n>` and `strings.bountyfac<n>` all present together, e.g.
  `amount0: 502, bountyexp0: 40, claim0: 0, crimes0: 0,
  bountyfac0: "1083-gamedata.base"` (The Holy Nation, a real typecode-10
  faction sid the existing `factionsService.js` catalogue resolves), with a
  second index carrying the same amount under `bountyfac1:
  "defaultEmpireFactionSID"` — a literal string, not a `<id>-<file>` stringID,
  same caution as `relationSID<n>` (AGENTS.md §3): never assumed to resolve,
  never a throw on a miss. **The caution is about coping with a miss, not about
  that shape being unresolvable** — this pass assumed the literal string could
  not resolve and the test asserting so is what caught it: it DOES resolve, to
  the United Cities, being one of the literal-name sids AGENTS.md §3 documents
  (`PLAYER_WEAPONS`, `RESEARCH_TEMPLATE`, `blank squad`, ...).
  `locationsService.js` had already hardcoded that exact mapping in its
  `FACTION_ALIASES`, which is corroboration nobody looked for at the time.
  Indices are per-character and small (0/1 observed); a character
  commonly carries the same amount twice, once per faction that wants them.
  **`saveService.bountiesOf(charStateRec)` walks the `amount<n>` keys that
  actually exist** (never assumes 0..1) and returns `[]`, never `null`, for an
  unbountied character. Wired into `readPlatoon()`, so every character in
  `GET /api/saves/:name/status` carries a `bounties[]`.
  **The fixture's 26 bountied characters are ALL NPCs** in non-player
  `.platoon` files (Cannibals, Outlaw Farmers, ...) — the fixture's only
  player squad, `Nameless_0.platoon`, has not one bounty key across its 13
  characters. So the service function and route are exercised against real
  records by the test suite, but the Squad-tab UI could not be driven against
  this fixture end to end; it is built and correct, just unverified live.

- [x] **Clear/reduce a bounty**. Two functions, both following
  `setPlayerMoney()`'s reference shape (compute, return `{ file, bytes }`;
  `mutationService` installs):
  `saveService.setBountyAmount(saveDir, platoonFile, characterSid,
  bountyIndex, amount)` sets one `ints.amount<bountyIndex>`, and
  `saveService.clearBounties(saveDir, platoonFile, characterSid, { amount =
  1 })` sets **every** `amount<n>` present on the record to the same value in
  ONE staged edit. Both reject `amount <= 0` or non-integer with a message
  that names the reasoning (the guide's explicit warning against 0, and that
  a small positive value which expires on its own is the documented safe
  removal path) rather than a bare "must be positive" someone might later
  "fix" away. No upper clamp.
  **There is no "add a bounty" function, and there never can be**: the whole
  `amount<n>`/`bountyexp<n>`/`claim<n>`/`crimes<n>`/`bountyfac<n>` key family
  is absent entirely — not present-and-zero — on an unbountied character, and
  this editor never mints a key that isn't already on the record (AGENTS.md
  §3). So this feature can only ever reduce or clear a bounty that already
  exists.
  **`bountyexp<n>`/`claim<n>`/`crimes<n>`/`bountyfac<n>` are deliberately left
  untouched by `clearBounties()`** — the guide's safe method is about the
  amount alone, and nothing here has established what the other four
  families do or whether writing them is safe.
  Routes: `PUT .../characters/:sid/bounties/:n` (`{ amount }`) and
  `POST .../characters/:sid/bounties/clear` (`{ amount? }`, default 1).
  UI (Squad tab, `public/modules/features/squad.mjs`): a `badge badge--warn`
  reading "wanted" next to the character's name when `bounties.length > 0`; a
  "Bounties" section rendered **only** when there is at least one bounty (an
  unbountied character shows nothing, not an empty section) — one row per
  bounty with the resolved faction name (or the raw string on a miss, never
  hidden), a `min="1"` amount input with its own Apply, and
  `bountyexp`/`claim`/`crimes` as read-only muted text; one "Reduce all to 1"
  action for `clearBounties()`; a hint explaining the mechanic cannot remove
  a bounty outright and why 0 is refused. **Built but not exercised against
  the fixture** (see the note above) — a real player's save with a bountied
  squad member will hit this path, but this pass could not click through it.
  Test (`webapp/test/mutation.test.js`): `bountiesOf()` resolves a known
  faction sid, and asserts `defaultEmpireFactionSID` resolves to "United
  Cities" rather than missing (this assertion started out backwards, asserting
  a miss, and failing it is how the literal-name-sid finding above surfaced —
  it now pins the resolution so a future change that drops literal-name sids
  fails here); `setBountyAmount` changes only `amount<n>`, leaving the
  other three int families, both `bountyfac<n>` strings and key order
  untouched; rejects 0, a negative value and a non-integer, save
  byte-identical; rejects an index with no `amount<n>` key, save
  byte-identical (never mints); `clearBounties` sets both `amount0`/`amount1`
  on a two-bounty character in ONE staged edit (`changedFiles` length 1),
  leaving the other four families untouched; a no-bounty character is
  rejected by the mutation gate's "edit produced no change" rule (mirrors the
  `restoreLimbs` no-op test).

### 3.7 Advanced settings (type 56 — GAME_STATE, camera entry)

- [ ] **Investigate and surface hunger rate / research speed fields.** The
  guide says these live in the same "camera" type-56 record as player money
  (already handled by `gameStateOf()`/`setPlayerMoney()`), but doesn't name
  the exact keys beyond "hunger rate" and "research speed." Dump the full
  `ints`/`floats` Maps of the type-56 record from the sample save (Phase
  0-style) and identify plausible keys by value inspection (a hunger-rate
  field is likely a small float multiplier near 1.0; research speed likewise).
  Function: once identified, `saveService.setAdvancedSetting(saveDir, key,
  value)` generalized over a small allow-list of known-safe type-56 keys
  (do NOT expose arbitrary key writes on this record — money already has its
  own dedicated, clamped function and that pattern should hold for every
  field individually, not a generic key/value passthrough).
  Route: `PUT /api/saves/:name/settings/:key`. UI: a small settings panel on
  the World tab alongside the money editor.
  Validation: per-field range clamp once semantics are confirmed; until then,
  do not ship the write, only the investigation notes.
  Test: round-trip once fields are confirmed and a function exists.

  **Investigation re-run 2026-08-06 against the test fixture. Still blocked,
  and now blocked for a reason that no amount of reading saves on this machine
  will clear.** The type-56 record's full `floats` Map was dumped again. Seven
  keys are exactly `1`, which is what a default multiplier looks like:
  `ht`, `nnm`, `rs`, `gdm`, `ps`, `cod`, `bs`. Everything else on the record is
  plainly something else — sky/cloud state, `zoom`, `alt`, `biome_text_timer`,
  and a long tail of `<sid>: <float>` dialogue-cooldown entries keyed by
  stringID.

  `rs` reads as "research speed" and `ht` as "hunger…something", but **reading
  as** is not evidence, and two of the seven could be swapped without this save
  showing any difference. Phase 0 already compared `save1` against `autosave1`
  and found these floats byte-identical; this pass adds that all four saves on
  this machine (`save1`, `autosave0/1/2`) are one playthrough with default
  settings, so the whole corpus available here has **zero variance** in exactly
  the fields that need to vary to be identified. A seventh candidate observed at
  the same value is not seven times the evidence — it is the same non-evidence
  seven times.

  What would actually resolve it, in rough order of cost: a save from a
  playthrough where the player moved the hunger-rate or research-speed slider
  off default (diff the two, one key moves); failing that, creating such a save
  in-game and diffing against a default one. Both need a human at the game, not
  another sweep of these files.

  **Do not guess which of `rs`/`ht`/`gdm`/`ps`/`cod`/`nnm`/`bs` is which, and
  do not ship a write against a guess.** A wrong guess here silently rewrites a
  world rule the player never asked to change, and the round-trip test cannot
  catch it — a byte-perfect write of the wrong field is still byte-perfect.
  This entry stays unticked deliberately; it is not an oversight.

### 3.8 Player money

- [x] Already implemented (`saveService.setPlayerMoney`,
  `PUT /api/saves/:name/money`, World tab). No further work — listed here
  only so this file is a complete cross-reference against
  `docs/fcs-capabilities.md`.

---

## Cross-cutting follow-ups (not tied to one phase)

- [x] **Character-scoped route namespace.** Every Phase 1/2 task above
  assumes routes of the shape `/api/saves/:name/platoons/:file/characters/:sid/...`,
  which doesn't exist yet (`routes/api/saves.js` currently only has
  `/status` and `/money`). Add the platoon-file + character-sid addressing
  scheme as its own small task before the first Phase 1 feature lands, so
  every subsequent route is consistent rather than each feature inventing its
  own URL shape. Needs a `saveService` helper to resolve `(saveDir,
  platoonFile, characterSid) → { world/parsed, record }` shared across all the
  per-character mutations above, replacing ad hoc lookups in each function.
  Test: covered indirectly by the first feature that uses it.

  **Implemented** as `saveService.resolveCharacter(saveDir, platoonFile,
  characterSid)`, landed together with 1.1's stats mutation (the first
  consumer). Returns `{ relFile, parsed, bySid, squad, instance, records }`
  where `records` is `{ stats, medical, state, inventory }` — the same four
  state-record types `readPlatoon()` already resolves per character, pulled
  out into a shared helper so future Phase 1 mutations (medical, rename,
  personality, teleport, race) can reuse it instead of re-deriving the
  squad → instance → states lookup each time. `relFile` is the path relative
  to `saveDir` (e.g. `platoon/Nameless_0.platoon`) that mutation functions
  hand back to `mutationService` as `file`, matching what `changedFiles` and
  the staged-write path both expect. Route landed:
  `PUT /api/saves/:name/platoons/:file/characters/:sid/stats` (see 1.1).
  Test: covered indirectly by `mutation.test.js`'s new stats tests, which all
  go through this resolver.

- [ ] **UI receipt/error pattern reuse.** The money editor's
  apply-button/receipt-`<pre>` pattern in `app.mjs` (`wire()`'s `apply.onclick`
  block) should become a small shared helper once 3+ features use the same
  shape, rather than copy-pasted per feature. Not urgent — revisit after
  Phase 1 ships two or three mutations and the duplication is visible.

---

## Editor-only additions (beyond the FCS parity list)

Features in this section are **not** in `docs/fcs-capabilities.md` — they're
this editor's own convenience additions on top of the 20 FCS-derived
workflows tracked above, so they're kept in a separate section rather than
numbered into Phase 1/2/3.

- [x] **Train as archetype.** One-click stat spread instead of typing ~42
  numbers by hand: pick a main archetype (Soldier, Marksman, Shadow,
  Craftsman, Medic/Scientist, Support) and a sub-archetype, and
  `saveService.trainCharacter()` sets all 4 attributes to 45, the
  archetype's skills (main + sub, deduped) to a random 45–95 each, and every
  other skill actually present on that character's STATS record to a random
  15–40 each, all in one staged edit. `mode: 'raise'` (default) never lowers
  an existing stat (`Math.max(current, rolled)`); `mode: 'set'` overwrites.
  Function: `saveService.trainCharacter(saveDir, platoonFile, characterSid,
  { archetype, sub, mode, rng })`. Routes: `POST
  /api/saves/:name/platoons/:file/characters/:sid/train`, and `GET
  /api/archetypes` for the catalogue (id/label tree only, no skill lists
  needed client-side). UI: a nested "Train as archetype" section inside the
  character card's Stats & skills section, with dependent main/sub `<select>`s,
  a "raise only" checkbox (checked by default) and a confirm() naming the
  character, archetype and whether it can lower stats.
  **The archetype -> skill mapping (`services/archetypes.js`) is this
  editor's own editorial judgement, not derived from game data** — unlike
  every field name elsewhere in `services/`, it is safe to rebalance or
  extend without re-deriving anything from a save; the only hard constraint
  is that every skill key it lists must be a real on-disk float key (it uses
  all 38 documented human skill keys, each exactly once across the six
  mains). Non-human characters with a smaller skill set are handled for
  free: `trainCharacter()` iterates the character's own `rec.floats` Map
  rather than a hardcoded key list, so it only ever touches keys that
  already exist on that specific record.
  Tests (`webapp/test/mutation.test.js`, deterministic via an injected
  `rng: () => 0.5`): full Soldier/Katanas train asserting all 4 attributes
  >= 45, every archetype skill lands in 45–95, everything else in 15–40, and
  the round trip holds; `mode: 'raise'` does not lower a pre-set 99 value;
  an unknown archetype or sub id is rejected and leaves the save
  byte-identical.

- [x] **Rename a squad, rename a character, add a squad member.** The three
  Squad-page gaps a save editor is expected to cover, shipped together because
  they share one investigation.

  **Rename a character** (this also closes Phase 1.3's first task).
  `saveService.renameCharacter(saveDir, platoonFile, sid, newName)` writes
  `strings.name` on CHAR_STATE (36) and the STATS (25) record's **header**
  `name`. Phase 0 recorded that type 25 has no `name` *string key* and that its
  header name carries the origin template's name — both true, but incomplete:
  on a character the player has actually named, the game itself writes the
  character's name there (a live player character's STATS record reads "Dai",
  not "start- Homeless"). So the FCS guide's "also update the name on the STATS
  entry" is real behaviour, not just an FCS navigation convenience, and it is
  written. Route: `PUT .../characters/:sid/name`. UI: an "Identity" section at
  the top of the character card — not a click-to-edit `<h3>` as originally
  sketched, because this writes through the mutation gate and needs the same
  field/Apply/receipt shape as every other write here.
  Validation lives in `saveService.encodeName()`: non-empty after trim, no
  control characters, at most 63 UTF-8 bytes (this editor's own conservative
  cap), encoded through the new `binary.fromText()` — the exact inverse of
  `asText()`. That helper is the point of the latin1 discipline on the write
  side: assigning a raw JS string writes it as latin1 and silently truncates
  every code point above U+00FF to its low byte, so "Ōkami" would land on disk
  as "Lkami". Tested with a non-ASCII name specifically for that.

  **Rename a squad.** There is no per-squad name field in a Kenshi save. A
  sweep of a live save (quick.save + all 23 `.platoon` files) for any string
  key or value resembling one found the player's chosen name in exactly three
  places, all in `quick.save`: GAME_STATE (56) `strings['pfaction name']`,
  every player SQUAD_META (34) `strings['faction name']`, and the player
  FACTION (37) record's header `name`. So "rename squad" is "rename the player
  faction", and `saveService.renamePlayerFaction()` rewrites all three in one
  edit — the FACTION record only when its header name matches unambiguously,
  since two factions sharing a display name would make the choice a guess.
  Deliberately NOT renamed: the type-34 record's `sid`, header `name`,
  `strings['platoon stringID']` and `filenames['content file']`, and the
  `.platoon` filenames. Those four are one identity ("Nameless_0"), and changing
  them means renaming files, which `mutationService` cannot do — it installs
  changed file *contents*; it never moves, creates or deletes a path.
  Consequence, and the reason this needed a second change:
  `playerPlatoonFiles()` used to find the player's squads by matching the
  `<Faction>_<n>.platoon` filename prefix, which would have reported "no player
  squad" the instant the faction was renamed. It now resolves them through the
  type-34 records' `content file`, keeping the prefix scan only as a fallback.
  Route: `PUT /api/saves/:name/faction/name`.

  **Add a squad member.** `saveService.addSquadMember(saveDir, platoonFile,
  { name, raceSid, archetype, sub, tier, rng })` — the only two-file mutation in
  the app (the `.platoon` and `quick.save`, one staged edit), and the first
  thing to exercise `mutate()`'s array form, previously unused.

  The new character is **cloned from a living character of the requested race
  already in the save**, then stripped back to nothing but its species. That is
  a design choice, not a shortcut: a character is a SQUAD instance plus six
  state records whose contents are race-dependent in ways this editor has not
  derived — MEDICAL's `hit<n>`/`flesh<n>`/`sid<n>` body plan, APPEARANCE's
  race-specific slider keys and its `extra['race']` row, STATS' skill key set.
  Synthesising those from a type-7 race template would mean re-deriving the
  game's own character instantiation; cloning takes every one of them from data
  the game itself wrote. Race is never rewritten — the donor is chosen *by*
  race, so body plan and appearance are consistent by construction, which also
  sidesteps Phase 1.5's blocked "change race" problem entirely.
  Sanitised on the clone (`services/characterFactory.js`): name, `owner faction
  ID`, `is leader` false, `slavestate` 0, every bounty family deleted
  (`amount<n>`/`bountyexp<n>`/`claim<n>`/`crimes<n>`/`bountyfac<n>`), every
  `flesh<n>` raised to the donor's own highest part with `bandage`/`stun`/
  `bleeding`/`KO`/`hung` zeroed and the four death flags cleared, `ints.limbs`
  deleted (same "delete the key, don't interpret the bitmask" rule as
  `restoreLimbs()`). AI (67) and INVENTORY (41) are **minted, not cloned** —
  280 of the 282 live AI records are exactly `{ bools: { jobs } }` and the two
  exceptions carry a job handle a new character must not inherit; the inventory
  starts empty and gear is added through the existing Gear page.
  `blood` is left as the donor's: it ranges -67.8 to 183.2 across a live save,
  so there is no defensible "full" to write — which is why the donor is picked
  for health (undamaged first, then a donor already in the target platoon, then
  raw score) rather than arbitrarily. The receipt names the donor and the blood
  value inherited.
  Ids: **seven** are minted from the file's own `nextId` — six state records
  plus the squad instance's handle. A character instance's `id` is sid-shaped
  ("32--INGAME") and is *not* a record sid: across all 282 character instances
  of a live save none matched any record's sid, and the ids they consume appear
  as exact gaps in each file's record-id sequence (`Nameless_0.platoon` holds
  records 31, 33-50, 52-60; its two character instances are 32 and 51).
  `ids.addInstance()` grew an explicit `id` option for this — inventory
  instances keep their ordinal ids — and now refuses a duplicate.
  Counts bumped in lockstep: SQUAD (30) `ints['char count']`, SQUAD_META (34)
  `ints['char count']`, GAME_STATE (56) `ints.members`. The SQUAD record's
  `instanceCount` is left alone: 23 of 25 live squad records carry 0 against
  real instances, and `addInstance()` only keeps it in step where the file
  already did.
  Routes: `POST /api/saves/:name/platoons/:file/characters`, plus `GET
  /api/saves/:name/races` (the races this save can supply a *living donor* for,
  with donor counts, and the one to preselect) and `GET /api/recruits`.
  UI: a "Squad" panel above the roster with two collapsed sections, "Rename
  squad" and "Add member". Add member offers a ready-made recruit dropdown and
  a "Surprise me" button backed by `services/recruits.js` — an editorial
  catalogue in the spirit of the wiki's Unique Recruits page (name, race
  preference, archetype/sub, power tier, blurb), carrying the same "not derived
  from game data, safe to rebalance" caveat as `archetypes.js`. A recruit's race
  is a *preference* matched against the races the save actually has, never a
  requirement: a save with no Shek in it still recruits Ruka, as whatever race
  is selected, and says so in the blurb line.
  **Default race:** requested as Greenlander, resolved by preference order
  (`/^greenlander$/` -> `/greenlander/` -> `/^human$/` -> `/human/` -> most
  donors), because "Greenlander" is not a name every install's data uses — on
  this one the human race resolves to "Human" (`17-gamedata.quack`), vanilla
  data having been consolidated over the years.
  Stat spread reuses "Train as archetype": `applyStatSpread()` was extracted out
  of `trainCharacter()` so both roll stats the same way, with the power tier
  supplying the ranges (Green 20 / 20-45 / 5-20 .. Legend 70 / 75-95 / 25-50).
  Tests (`webapp/test/squad.test.js`, 11 of them): `encodeName`'s limits and the
  latin1 round trip for a non-ASCII name; rename character (both records, one
  file, no record added or removed) and its four rejections; rename faction (all
  three places, quick.save only, and the platoon files still resolving
  afterwards under the new name while keeping their old filenames) and its
  rejections; `availableRaces` invariants and `defaultRace`'s preference order;
  the recruit catalogue validating against real archetype/sub/tier ids; add
  member asserting two changed files, +6 records, +7 `nextId`, no duplicate
  id/sid/instance handle, `instanceCount` untouched, the member reading back
  healthy/leaderless/empty-handed with the requested race and tier spread, no
  surviving bounty key, and both quick.save counters moved; and seven
  add-member rejections including a `../quick.save` path escape, each asserting
  the save is byte-identical afterwards.

  **Untested, and not testable offline:** whether Kenshi accepts a
  cloned-and-renumbered character on load. Phase 0's evidence — the game
  re-mints every id and rewrites every sid on its own next save — makes
  "accepts, then renumbers" by far the most likely outcome, but that is
  inference, not observation. Every add still takes an automatic backup first,
  and the round trip proves only that the file is internally consistent under
  this codec.

- [x] **Equip several characters at once, and a visual pass over the whole UI.**
  Both prompted by the same thing: four ad-hoc scripts in `webapp/scripts/`
  (`equip-weapons.js`, `equip-ancient-samurai.js`, `equip-octo.js`,
  `equip-backpacks.js`) that geared up a whole squad because the UI could not.
  Reading them was the design document; each one exposed a specific gap.

  **Gap 1 — race was not in the API.** Every script had to `require()`
  `saveService` in-process and call `scanCharacters()` (re-parsing all 23
  platoon files) purely to learn each character's race, because
  `GET /api/saves/:name/status` didn't carry it. That is why these had to be
  Node scripts rather than buttons. `readPlatoon()` now returns
  `race: { sid, name }` per character, read via the new `saveService.raceOf()`
  off the APPEARANCE (66) record's `extra['race']` row — the same place
  `scanCharacters()` always read it, just no longer requiring a whole-save scan
  to reach. The roster shows it, and bulk equip needs it.

  **Gap 2 — there was no bulk write.** Three of the four scripts fired N×2
  sequential POSTs at the per-character `addItem` route.
  `mutationService.mutate()` treats each call as one staged edit against one
  snapshot and takes one backup, so equipping 10 characters with 6 items each
  meant 60 gate passes, 60 backups and 59 intermediate on-disk states nobody
  asked for. `equip-backpacks.js` had already worked this out and did the whole
  thing in one `mutate()` — that is the shape `saveService.equipMany(saveDir,
  { targets, items, raceNotes, skipIfSlotFilled })` generalises. Targets are
  `{ file, sid }` pairs and may span platoon files; each file is parsed once and
  returned as its own `{ file, bytes }`, which `mutate()` verifies and installs
  all-or-nothing. Everything is validated before any file is touched (the same
  two-pass rule as `updateItem()`), and the displacement rule reuses the
  existing `displaceIntoSlot()` rather than growing a second copy.
  `skipIfSlotFilled` reproduces the backpack script's "don't hand out a second
  backpack" behaviour; it is off by default so the default matches the Gear
  page's existing displace-the-occupant semantics.

  **Gap 3 — backpacks were unreachable.** The Thieves Backpack is typecode
  **46**, and both `itemFactory.buildItemRecord()` and `GET /api/gamedata/items`
  were hard-gated to 2/3/4 — which is exactly why `equip-backpacks.js` had to
  hand-roll its own type-42 record. That hand-rolled shape turned out to be
  right, and is now the evidence for the supported one: all 42 live
  type-46-backed items in the save mint with `item function: 4`, `level: 0`,
  `quality: 100`, `charges: 1`, an empty `company sid`, `material sid` from the
  material union, and **no `uniform` key**, and all 42 sit in
  `backpack_attach` with zero exceptions. So: 46 added to
  `gamedataService.ITEM_TEMPLATE_TYPES` (22 backpack templates the picker used
  to hide), to `itemSlots.TYPECODE_SECTIONS` (it used to fall through to the
  permissive branch, offering all 11 slots and flagging `widened`), and to
  `itemFactory`. Typecode **107** is deliberately left unmapped — its 7 live
  items disagree (6 `back`, 1 `backpack_content`), so permissive is the honest
  answer.

  **Gap 4 — a real weapon-grade bug the scripts were silently working around.**
  14 of this install's 24 grade model sids appear under **two** companies
  (`1069-gamedata.base` is both "Homemade" and "Edgewalkers"), but the Gear
  row's grade `<select>`, the Add-item grade `<select>` and
  `buildItemRecord()` all keyed on `modelSid` alone — so the selects emitted
  duplicate option values and `grades.find(g => g.modelSid === ...)` picked
  whichever row sorted first. Choosing "Edge Type 5 — Edgewalkers" wrote
  Homemade. The scripts dodged it by passing `companySid: 'PLAYER_WEAPONS'`
  explicitly, which the UI had no way to express. Fixed: every ladder row now
  carries a stable `id` (`"<companySid>|<modelSid>"`), the new
  `itemFactory.resolveGrade()` is the single resolution point, and `gradeId`
  flows through `addItem`/`updateItem`/`equipMany` and both selects. Bare
  `materialSid` still works (older API) but its ambiguity is now explicit and
  documented: lowest rank wins, and a mismatched `companySid` throws instead of
  quietly writing a different manufacturer.

  **Compatibility policy — decided deliberately, and the two halves are not the
  same.** Kind-vs-slot (a shirt into `hip`) is a **hard refusal**, validated up
  front through `itemSlots.allowedSections()`, the same single source of truth
  `addItem`/`updateItem` use. Race fit **never blocks**: every selected
  character gets every item, and `services/fitCheck.js` reports what looks
  wrong afterwards. Kenshi's real race/mesh restrictions are not in any field
  this editor has identified (1.5 is still blocked on exactly that), so refusing
  on suspicion would mean inventing a rule. Two warning sources, labelled by
  which they are: **derived** — a type-3 template's `extra['part coverage']`
  rows name the body parts it covers by stringID, and a character's MEDICAL
  record lists the parts it has as `sid<n>`, so an item covering a part the
  character lacks is provably a poor fit (this is what catches plate armour on a
  bonedog, which has no arms); and **editorial** — the race notes copied out of
  the scripts, deduped per character so a loadout's "animal" note doesn't repeat
  once per item. Caching `partCoverage` on the gamedata index took
  `CACHE_VERSION` 4 → 5; a stale cache rebuilds itself on version mismatch.

  **`services/loadouts.js`** carries the four scripts' contents as data — same
  "editorial, not derived from a save, safe to re-balance" contract as
  `archetypes.js` and `recruits.js`, with `validate()` asserting every
  `templateSid` resolves and every `section` is legal for that template's kind.
  The scripts themselves are deleted, along with `character-races.js`, which
  Gap 1 reduced to a field on a status read.

  Routes: `POST /api/saves/:name/equip` (`loadoutId` and `items` concatenate,
  so "this kit plus a backpack" is one request) and `GET /api/loadouts`.
  UI: the Gear tab gains an "Equip several at once" toggle; the roster grows
  checkboxes, and the detail pane swaps to a bulk panel showing the loadout's
  contents as chips and a **pre-flight list** — per character, what they get,
  what it displaces, what is skipped, and any fit warning — before anything is
  written. Selection is a `Set` of the same stable `"<file>::<sid>"` keys the
  single-character flow uses, never indices. Ticking a box patches the count,
  heading and pre-flight in place rather than re-rendering; only the 0↔1
  transition (which genuinely swaps the pane) calls `render()`, because a full
  re-render detaches every checkbox mid-interaction.
  `core.mjs`'s `showReceipt()` grew optional `details` lines so a 60-item bulk
  result is readable — it stays the ONE receipt surface, no second component.

  **UI visual pass.** `docs/ui-style-guide.md` §1 previously banned gradients,
  shadows and animation outright, which over time became the thing holding the
  interface back: with only hairline borders available, a card, a panel and a
  table all read as the same flat rectangle. §1 is amended (and a new §1a
  "Motion" added) to permit depth and motion **that carry meaning** — elevation
  encodes layering, motion encodes change — while still banning decoration for
  its own sake. Concretely: more surface levels and an `--elev-*` scale, a wider
  type scale (headings used to top out at `1.05rem`), sticky header and tab bar,
  an accent underline on the active tab, hover/active/selected states that are
  actually visible, a rotating disclosure caret, real empty states, and
  two-line roster rows carrying race, equipped-slot pips and condition — the
  pips exist so you can see who still needs armour *before* selecting them,
  which is the whole point of a multi-select. Motion is ≤120ms, never on a
  receipt (the answer to "did my write land" must not be delayed), and all of it
  is disabled by one global `prefers-reduced-motion` block. **Dark only** — a
  light theme was considered and rejected: it would double every colour decision
  and contrast check for a tool that runs beside a dark game.

  Tests: `webapp/test/equip.test.js` (12) — the loadout catalogue validating
  against real templates and legal sections; a minted backpack matching the live
  shape including key order and the absent `uniform` key; `gradeId` pinning the
  exact company where a bare model sid is ambiguous, and the documented
  lowest-rank fallback; `fitCheck` warning only about genuinely absent parts;
  bulk equip asserting one staged edit, one type-42 record per (character, item)
  pair, `nextId` bumped by exactly that many, no duplicate id/sid, and every item
  reading back in the right slot on the right character; displacement and
  `skipIfSlotFilled`; a bad race fit warned but still written, with deduped
  warnings; nine rejection cases each leaving the save byte-identical, including
  a `../quick.save` path escape; and a genuine cross-platoon-file write (which
  targets any two platoon files, not just player squads — this save has only one
  player squad, and the multi-file path is the reason `equipMany` returns an
  array, so it must not go untested).
  Two pre-existing tests were also made save-state-independent rather than
  weakened: `healPart "full"` now wounds a part first (on a fully-healed squad
  "set flesh to my own maximum" is a genuine no-op and the gate rightly rejects
  it), and the `trainCharacter` band test passes `mode: 'set'` (the bands are
  what the roll produces; the default 'raise' mode writes
  `Math.max(current, rolled)`, which is the point of raise mode and has its own
  test).

  **Left alone deliberately:** `scripts/build-locations-catalog.js` and
  `data/locations-catalog.json` — teleport groundwork for 1.4, unrelated to this.

- [x] **Teleport the squad to a town, backpack contents, and a Squad-page
  layout fix.** (Closes 1.4.)

  **Where towns actually are — three sources checked, two of them wrong.**
  A type-13 town record (Admag, The Hub, ...) holds only the town's *template*:
  radius, population, whether it is public. It has **no position**. The
  placement is an INSTANCE targeting it, and those live in
  `<Kenshi>/data/newland/leveldata/<mod>/leveldata.level`.

  1. `<Kenshi>/data/leveldata.level` — the obvious file, and the wrong one. One
     20-instance townlist, every entry with a sentinel height (-99 or 0), at
     positions that disagree with the world: it places "Traders edge" at
     (-3273, -99, 63366) when the real one is at (48030, 1504, -41953) — 8 units
     in y from where the player's own squad is standing in that town right now.
     This was the only file the ad-hoc `build-locations-catalog.js` read, so its
     20-entry output was not merely incomplete but positionally wrong.
     Sentinel-height placements are dropped outright (22 of 403).
  2. The save's own type-94 town states — 330 of them, named, which looks ideal.
     But they carry only a zone-grid cell (`zzX0`/`zzY0`). The grid was derived
     (`world = cell * 4500 - 141000`, fitted exactly on Trader's Edge and Bast
     and consistent with the save's own `zone.X.Y.zone` filenames) — and it is
     still useless here, because a cell is 4500 units square and standing in a
     town does not reliably put you in that town's recorded cell. Worse, the
     naming is a different layer: the save calls the player's cell "Heng" while
     the data places "Trader's Edge" there, and the game agrees the player is in
     the *region* Heng ("Heng" exists as a type-95 region record, not a town).
     Joining the two by name gave a consistent cell for only 188 of 255.
  3. `<Kenshi>/data/leveldata/*.zone` — no town placements at all.

  **Verification of the source that is used**, against the live save. NPC squads
  name a town as their `basetown`, so a garrison's centroid is an independent
  "where is this town really": Traders edge 99 units from the placement, Barren
  Village 394, Trader's Edge 871 — all well inside a town, whose own
  `size radius` starts at 350. The player's squad sits 520 units from its town's
  placement.

  `services/locationsService.js` yields **293 locations across 59 factions** on
  this install (168 distinct names; several towns are genuinely placed more than
  once, and this install has five distinct Cannibal Villages). Duplicates of the
  same name within 2000 units are collapsed; further apart they are kept as
  separate entries. Ids are made unique defensively rather than assumed: this
  install has "Trade outpost" placed twice (wanting `trade-outpost-2`) *and* a
  separate town literally named "Trade outpost 2", which slugs to the same
  thing. `- Copy` files are skipped — `leveldata - Copy.level` and
  `leveldata - Copy (2).level` are a mod author's own backups sitting next to
  the real file, and including them tripled every town in that mod. Disk-cached
  (~650ms to build); `POST /api/locations/rebuild` after a mod change.

  `saveService.teleportSquad()` writes the SQUAD (30) instances' `pos` — the
  squad record's own instance list, not a field inside any state record — plus
  the quick.save SQUAD_META (34) position, so the map marker follows the
  characters instead of being left behind. Characters land on a small ring
  rather than stacked on one point. `sids` moves part of a squad.
  Route: `POST /api/saves/:name/platoons/:file/teleport`; UI is a
  faction-grouped destination picker in the Squad panel, `.btn--danger` with a
  confirm naming the consequence.

  **Unique Recruits mapping.** Each entry in `services/recruits.js` gained a
  `where` list of the towns the wiki's "possible locations" put them in,
  resolved at request time against the towns this install actually has. Like
  `race`, it is a hint: a heavily modded world renames and moves towns, and
  several vanilla names simply do not exist here (Squin, Mourn, Stoat). An
  unresolved name is *reported* as unresolved rather than dropped, so the UI
  never implies the wiki and the install agree when they don't. Every one of the
  20 recruits resolves to at least one real place in this install.

  **Backpack contents — a structural gap, not a display bug.** A worn pack is a
  type-42 ITEM in the character's inventory, and it holds ONE instance pointing
  at its **own** INVENTORY (41) record, whose instances are the contents
  (type-42 items sectioned `backpack_content`). Verified on a live save: a Garru
  Backpack (sid 250) has one instance targeting sid 251, a type-41 record with
  13 instances, none of which appear in the character's own inventory. So
  nothing reading only the character's INVENTORY could ever see them, and all
  152 `backpack_content` items in this save were invisible. `packContentsOf()`
  follows that second hop; the Gear page nests the contents under the pack's own
  editable row. They are shown **read-only** — they live in a record this editor
  does not write to yet, and a Slot select that silently did nothing would be
  worse than plain text.

  **Squad-page layout.** The squad-level actions (rename, add member, teleport)
  were a full-width panel above the workspace: three collapsed rows spending
  1240px and pushing the character card — the thing you came to edit — a screen
  down the page. They are squad-scoped, so they now sit in the left column under
  the roster (`.side`), and the character card starts at the top of the
  workspace. Sidebar-width panels stack their field rows and stretch their
  controls; the roster gets its own scroll so the panel under it stays reachable
  on a 30-character squad.

  **Icons.** Every card and panel section summary now carries a glyph
  (`sectionSummary()`), so a card of five collapsed disclosures is scannable by
  shape rather than by reading each label — the same "carries information, not
  decoration" test the equip-slot icons already passed (style guide §1).

  Tests: `webapp/test/teleport.test.js` (6) — the catalogue carrying only real
  positions with unique ids and no under-deduped near-duplicates; catalogued
  positions cross-checked against the save's own garrisons (using only towns
  with 3+ squads: a single squad naming a town as home proves nothing, and one
  in this save is standing 17.7 km from its Telbooze home); every recruit
  location resolving or being reported unresolved; a teleport moving all ten
  characters onto a ring with the marker following and no record added; a
  partial teleport leaving everyone else exactly where they were; five rejection
  cases including a `../quick.save` path escape, each byte-identical; and a
  backpack reporting its contents through the second hop.

- [x] **26 more loadouts, read off the game's own NPCs — and crossbow support,
  which they turned up.**

  The catalogue was three kits, all variations on one idea (a katana and
  Ancient Samurai plate) because it was seeded from four ad-hoc scripts rather
  than from the game. So the game was asked instead: every character in the live
  save sorted by combat skill with their worn gear dumped, then the
  best-equipped member of each of the 22 factions present.

  **What that showed, and what the catalogue had wrong:**

  - **A full kit is FIVE armour pieces, not four.** The `shirt` slot is worn
    UNDER body armour and every existing loadout missed it: a Samurai Gate
    Sergeant wears a Chain Shirt beneath Empire Samurai Armour, a Shinobi Guard
    wears Blackened Chainmail under a Black Rag Shirt. A test now pins this —
    anything tagged `full` must fill head/shirt/armour/legs/boots and carry a
    weapon.
  - **Armour `level` tracks rank**: a grunt is 20, a garrison soldier 40-60, an
    elite 80, a named character 95. Weapon grade tracks it in step: Catun No.1
    around rank 30 for a grunt, Industrial 008 for a veteran, Edge Type 5 for an
    elite. The kits follow that ladder rather than making everything masterwork.
  - **Senior fighters carry two weapons**, one on `back` and one on `hip` (the
    Gate Sergeant carries a naginata and a wakizashi).
  - **Almost everyone carries a first aid kit and some cats.**

  **Crossbows were a whole missing weapon class.** Looking for a ranged
  archetype turned up "Ranger" at **typecode 107** — which nothing accepted,
  because 107 had been left deliberately unmapped when the type-46 work found
  its 7 live items split 6 `back` / 1 `backpack_content` and called that
  ambiguous. It isn't: the outlier is a crossbow being *carried in a pack*, and
  `backpack_content` is a bucket any item may sit in rather than a competing
  equip slot. Every crossbow that is actually equipped is on the back, which is
  where Kenshi wears one. All 7 live records agree on the rest of the shape:
  `item function: 0`, a caller-settable `level` (5 to 80 observed, exactly like
  a melee weapon), `quality: 100`, a `uniform` key, and an empty `company sid` —
  a crossbow has no manufacturer ladder.

  That last point exposed a real bug: `buildItemRecord()` only consulted the
  grade ladder for typecode 2, so a `gradeId` passed for anything else was
  **silently dropped**. A caller asking for a Meitou crossbow got a plain one
  and was told nothing. It now throws, matching how `updateItem()` already
  refused the same thing ("is not a weapon").

  **The catalogue is now 29 kits** across heavy armour (9), light (4), ranged
  (2), blunt/non-lethal (2), support (2), trade & hauling (2), travel (2),
  starter (4), plus the weapons-only and pack-only oddments. Every one resolves
  against this install with zero missing templates, and they use 20 distinct
  body armours and 17 distinct weapons — variety is asserted by test, not just
  by count, since twenty kits ending in the same breastplate would pass a count
  check. Entries carry `tags`, and the UI groups the `<select>` by role because
  29 options in one flat list is a wall.

  `validate()` also grew two checks the bigger catalogue needs: a loadout may
  not fill the same single-occupancy slot twice (the second would silently
  displace the first to `main` at write time), and may not ask for quantity > 1
  on an unstackable template or a grade on a template that has no ladder.

  Also removed: `scripts/build-locations-catalog.js` and
  `data/locations-catalog.json`, superseded by `services/locationsService.js`.

- [x] **50 grouped recruits, random names from the game's own pools, 9 more
  loadouts — all from the game's type-1 character records.**

  **The source.** A named Kenshi character (Tinfist, Bugmaster, Moll, ...) is a
  **type-1 record** in gamedata, and it carries far more than a name:
  `ints['combat stats']`, `ranged stats`, `stealth stats`, `unarmed stats`,
  `strength`, `armour grade`, plus `extra['race']`, `extra['clothing']`,
  `extra['weapons']`, `extra['weapon level']` (the grade *company*) and
  `extra['inventory']`. That is the game's own answer to "what is this character
  and what do they wear", and it is what this pass was built on:

      Tinfist      Skeleton   combat/stealth/unarmed/strength all 100, no weapon
      Bugmaster    Human      combat 95, Cross-grade (Meitou) foreign sabre
      Moll         Sundemon   combat 90, stealth 90, ninja blade
      Valamon      Shek       combat 80, strength 40
      Savant       Sundemon   combat 75, strength 35, Meitou nodachi
      Dust King    Human      combat 45, spiked helmet + heart protector
      Seto         Shek       combat 35, martial-artist bindings, no blade
      Crumblejon   Human      combat 30, horse chopper and fragment axe

  It also **corrected races the earlier editorial guesses got wrong**: Green is
  a Hive Worker Drone, not a human; Shryke, Savant, Moll and Bo are Sundemons;
  Seto and Ells are Shek. Tiers now follow the `combat stats` column rather than
  vibes — Tinfist and Bugmaster are Legends because the data says 100 and 95.

  **Recruits: 20 → 50, in ten archetype groups of five** — Soldiers, Duellists,
  Shadows, Rangers, Medics & scientists, Artisans, Traders, Explorers,
  Labourers, Outcasts. `validate()` enforces the group sizes (4-5 each), so a
  group can't quietly decay to one lonely option, and the UI renders the picker
  as `<optgroup>`s. Every one of the 50 still resolves to at least one real town
  in this install.

  **Names: `services/names.js`.** Kenshi ships `namesM.txt` (98), `namesF.txt`
  (37) and `namesMF.txt` (67) in its data directory and draws every generated
  NPC name from them, so the editor now does too — 202 names, read as latin1
  like everything else off this install. The "Add member" name field is
  pre-filled with one (skipping names already in the squad) and there is a
  re-roll button; typing over it is the override. A missing install means no
  suggestion, never a blocked add. Exposed as `GET /api/names?count=`.

  **Loadouts: 29 → 37**, the new ones lifted straight off those characters —
  Abolitionist (Tinfist's dustcoat and repair kits, no weapon), Nightstalker
  (Moll), Ronin (Savant's police armour and Meitou nodachi), Bandit Lord (Dust
  King), Dust Runner (Shryke's stormgoggles and polearm), Robed Scholar
  (Longen), Hungry Bandit (Crumblejon), Shinobi Thief (Bo) — plus Martial Artist
  corrected to the Martial Artist Bindings and gi pants Seto actually wears. 18
  distinct body armours and 20 distinct weapons across the catalogue.

  **UI copy.** Every explanatory hint was cut to one line. The worst offender
  was the Add member panel, which ran to five sentences about cloning, donor
  counts, discarded flags and which two files get written; it now reads "Cloned
  from a living character of that race in this save (the number beside each race
  is how many). Arrives at the squad, healthy and carrying nothing." The
  reasoning still lives in the source comments and in this file — the UI just
  says what the control does. Fourteen hints shortened in total.

  Tests: names are deterministic under an injected rng, honour `avoid`, and
  never return null once a pool exists; recruits validate their groups, group
  sizes and race hints (a typo'd race hint would silently fall back to the
  default race rather than erroring, so it is asserted against the six the save
  can actually match).

- [x] **Squad-page readability pass.** All user-reported, all in the card and
  the header:

  - **Backpack contents were invisible on the Squad page.** The Gear page got
    them when `packContentsOf()` landed, but the Squad card's read-only
    Inventory still listed only the character's own inventory record — so a pack
    bull carrying 46 items in its pack showed exactly one line: the pack.
    Contents now nest under the pack that holds them, and the section count
    includes them (Booty reads "Inventory (47)", not "(1)").
  - **That list had no icons**, while the Gear page's did. It now uses the same
    `SLOT_ICONS`/`SLOT_LABELS` maps, so an item looks like the same item on both
    pages and the slot reads "In backpack" rather than `backpack_content`.
  - **Attributes and top skills as pills.** Four attribute pills plus the
    character's four strongest trained skills, accented — that second row is the
    "what is this character" signal: `mass combat 109 / attack 95 / warrior
    spirit 94` reads as a fighter at a glance, `medic / science / doctor` as a
    medic. Skills at or below zero are untrained (the save stores those
    negative) and are never shown as a strength.
  - **Blood and hunger as bars, bleeding as a state.** The scales come from this
    save's own 535 medical records rather than a guess:
      - `blood` sits at p50 100.2 and runs to 181.7 — it is race-dependent, so
        the bar caps at 100 and the number carries the truth (a bull reads 175).
      - `hung` has a minimum of 1.5 and p25 through max all exactly 3.0, so
        **3 is the resting value for a healthy character** and a LOW reading is
        the bad one. The bar fills toward 3. This corrected an assumption: the
        field is not "how hungry", it is how well fed.
      - `bleeding` is exactly 0.0 on 534 of 535 characters and 0.1 on the one
        exception, so a bar would never move. It reads as bleeding / none.
  - **World header as pills.** Faction and region as the heading, then cats,
    members and the clock, each with its own glyph and unit. They were four
    identical muted spans, which made "211" and "10" look like the same kind of
    number. The clock glyph also distinguishes day from night — free from the
    hour, and the most useful thing about the time in Kenshi.
  - **The two storage buckets come first in every slot picker**, labelled
    ("Carried", "In backpack") rather than shown as raw keys. Adding something
    usually means into the pack or into their hands; the body slots sorted ahead
    of both only because `ITEM_SLOTS` lists them in wear order.
  - **No quality control on items that have none.** Trade goods (type 4) and
    packs (type 46) always mint `level` 0 and the field means nothing on them,
    so the row offered a "Level 0" dropdown inviting an edit that would do
    nothing. They show "—" now; weapons and armour are unchanged.

- [x] **Personality decoded and editable; dialogue investigated and found NOT
  save-side.** (Closes 1.3's second task.)

  **Robotic limbs, and the reason a whole item class kept going missing.**
  A user searched for "KLR Series Arm (left)" and the picker had nothing.
  Rather than add one typecode and wait for the next report, the question was
  settled properly: sweep **all 123 files of a live save** (quick.save, every
  platoon, every zone — vendor stock lives in the zones, which is where the
  limbs were) and tally which gamedata typecode backs each of the 6103 live
  ITEM records. Exactly six do: 4 (3234), 3 (2225), 2 (560), 46 (56), 107 (17)
  and **111 (11)**. Only 111 was missing, and it is now supported: 32 templates.
  A test now asserts this invariant directly — every typecode backing a live
  item must be offered — so the next gap fails the suite instead of the user.
  A robotic limb is CARRIED, never worn: all 11 live ones sit in
  `backpack_content`, and its record is the one kind with extra float keys —
  `wear`, `stun`, `dam` ahead of `charges`/`quality`, which is limb condition.
  Also fixed: `saveService.addItem()` had its own hardcoded `[2,3,4]` gate, so
  backpacks, crossbows and limbs were addable through bulk equip but rejected
  by the single-item route. It now reads `itemFactory.TEMPLATE_TYPES`, the one
  list that mints the record.

  **Category filters** on the item search: `kind` (weapon / armour / crossbow /
  backpack / robotic limb / trade goods) and `slot`. The slot filter is
  deliberately STRICT and this is a real trade-off: only 184 of this install's
  1646 armour templates carry a slot the editor can confirm, the other 1462
  falling through to itemSlots' permissive branch. That branch is right when
  *placing* an item (hiding a legitimate slot on a modded item is the worse
  error) and wrong when *filtering* (a "boots" search returning 1477 rows
  including every shirt is useless), so the filter requires a specific slot —
  one section, or the two a melee weapon genuinely has. Boots returns 15, not
  1477. Everything else stays reachable through `kind` and the name search, and
  the UI says so in one line.

  **Personality: fully decoded, and it is editable.** The save stores it as
  `ints.personality` on CHAR_STATE — a single small integer. Gamedata carries 31
  type-26 "personality" records holding `tags always/common/never/rare` integer
  lists, and the records that describe exactly ONE trait pin the value:

      "Honorable"      always=[1]     "Traitorous"  always=[2]
      "Smart Doc Type" always=[5]     "Dumb"        always=[6]
      "Brave"          always=[9]     "Fearful"     always=[10]
      "Crazy"          always=[14]

  Four independent cross-checks agree exactly — "dumb honorable brave"
  always=[6,1,9]; "Ninja Neutral - brave, hon, crazy, trait" common=[1,9,14,2];
  "Traitorous brave crazy" common=[2,9,14]; "Not honourable" common= all seven
  but 1. And the decisive one: the record named **"Random"** lists
  `common=[1,2,5,6,9,10,14]` — exactly, and only, the seven values that occur
  across all 555 characters in the save. That independently confirms the FCS
  guide's warning about unimplemented values: 7, 11 and 12 appear only inside
  "bandit types" and never on a real character.
  So `services/personalities.js` is **derived, not editorial** — unlike
  archetypes/recruits/loadouts — and `setPersonality()` refuses anything outside
  the seven unless the caller passes `allowUnknown`. The UI shows a named
  dropdown with the trait's effect, not a raw int.

  **Dialogue: not possible from a save, and here is the proof rather than a
  shrug.** A CHAR_STATE record carries no dialogue reference of any kind —
  across all 555 characters there are exactly four distinct CHAR_STATE
  string-key shapes (`name, owner faction ID, sheath`, plus optional
  `bountyfac<n>`), and none names a dialogue package, personality record or
  voice. Dialogue hangs off the type-1 CHARACTER TEMPLATE in gamedata, as
  `extra['dialogue package']` (what it says to the world) and
  `extra['dialogue package player']` (what it says to the player — the
  talkable/recruitable marker; 169 of this install's 659 templates have one).
  The only thing the save stores is which template a character came from: the
  squad instance's `target`.
  That is worth SHOWING, and now is — the Identity section reports the origin
  template and whether it talks to the player. It explains something real: the
  characters from a "start- Homeless" game start have no dialogue at all, while
  a member cloned from a "Lost drone" carries "Player HIVER Ronin" and one from
  a "Samurai Conscript" has world dialogue only.
  It is NOT made editable. Repointing `target` at a talkative template is a
  one-string edit, but that field is the character's whole origin — race
  template, stats, gear rules and dialogue together — and whether the game
  re-reads dialogue from it for an already-spawned character cannot be
  established offline. A test asserts `saveService.setDialogue` stays undefined,
  and that no CHAR_STATE string key ever matches /dialog|voice|package/ — so if
  a future save proves otherwise, the suite says so rather than the assumption
  quietly persisting.

- [x] **Vendors page — who sells what, and where.**

  Prompted by "KLR Series Arm (left), found in the robotics shop in Black Desert
  City". That is a gamedata fact, not a save fact: **shops roll their inventory
  at runtime**, so a save holds no vendor stock at all (the type-42 items in a
  save's `zone/*.zone` files are building storage — crates — reached through a
  `0-buildinglist`, not shop inventory).

  The chain, traced end to end against that exact example:

      town (13)  --extra['residents' | 'bar squads' | 'default resident'
                          | 'roaming squads']-->
        squad (52)  --extra['vendors']-->
          vendor list (49)  --extra['items'|'weapons'|'clothing'|'robotics'|...]-->
            item template (2/3/4/46/107/111)

  Black Desert City lists a resident squad "Robotics shop (black desert)", whose
  vendor list "Robotics limb vendor (best)" carries the KLR arms. Exactly as
  reported.

  **The union rule is load-bearing here.** Extra rows must be collected across
  EVERY definition of a sid, not first-definition-wins — the same rule (and the
  same reason) as gamedataService's material index. Black Desert City's first
  definition carries only `extra['faction']`; its residents, including the
  robotics shop, are attached by a later one, so first-definition-wins reports
  the city as having no shops whatsoever. There is a test for that specific
  case.

  Result: **898 shops across 228 towns and 49 factions.** Only items this editor
  can actually mint are offered — a vendor list also names tech (21), map (102)
  and manufacturer (51) records, and putting those on the page would mean a
  button that always fails.

  **On "region".** The request was region -> location -> type -> contents. The
  top level is the town's FACTION, and the UI says "Faction" rather than
  "Region", because nothing in the data links a town to a biome region: type-95
  region records reference `nests` and factions reference `biomes`, but neither
  gives town -> region. The save knows a region for a position (`map area sid`)
  but only for places the player has visited. Faction is real, complete, and how
  Kenshi territory actually divides — calling it a region would be a claim the
  data cannot support.

  UI: three cascading pickers (faction / location / shop), the shop's stock as a
  table with a glyph per item kind, and a per-row Add that writes straight to a
  chosen character. The destination controls live in their own `.action-bar`
  strip so "what am I looking at" and "where does this land" do not read as one
  six-field form. Stock is labelled as what the shop *can* carry.

  Also added a reverse lookup (`GET /api/vendors-carrying/:sid`) — every shop
  stocking a given template — which is the "where do I buy this?" question and
  falls straight out of the same index.

  Tests (`webapp/test/vendors.test.js`, 5, all read-only): the chain resolves
  with plausible coverage and unique ids; every offered item is one `addItem`
  would accept; the Black Desert City union case specifically; the reverse
  lookup round-trips; and the tree groups without dropping or duplicating a
  shop, with every `locationId` resolving in the placement catalogue so the
  Vendors page and the teleport picker agree about which town is which.

- [x] **Maps are items too — and the Vendors page now hides nothing.**

  Prompted by the right question: "what are the items in the inventories that we
  cannot add? if it's sold by the game vendor then we should be able to add it".
  The page was silently dropping three record types. Checking each rather than
  defending the filter found one real gap:

  - **type 102, maps — WRONG to exclude, now addable.** "Map to Mongrel",
    "Ancient Military Documents". The template has every hallmark of an item:
    `weight kg`, `value`, `stackable: 1`, `charges`, `quality`, an inventory
    footprint, a mesh and an icon. It was excluded because the full-save sweep
    that established the other six typecodes found none — but that was absence
    of evidence: **this player has never owned a map.** 39 live map items do
    exist, in the install's own `newland/leveldata/*/interiors.level` files, and
    all 39 agree on the minted shape: no `uniform` key, `item function: 0`,
    `level: 0`, `quality: 100`, `charges: 1`, and an **empty `material sid`**
    despite the template carrying an `extra['material']` row — follow the items,
    not the template. 18 map templates are now offered, with a "Maps" filter in
    the picker.
  - **type 21, research tech — correctly excluded.** "Advanced Outpost
    Blueprints", "Bolts: Regulars". Carries `level`, `time`, `production mult`,
    `category`, `description`; no weight, value, mesh, icon or footprint. Zero of
    ~25,000 live ITEM records across four saves and 713 install files are backed
    by one. In game you buy an Ancient Science Book (a type-4 item) and the book
    unlocks the node; the node itself is never carried.
  - **type 51, weapon manufacturers — correctly excluded.** "Truth Two",
    "Edgewalkers". Carries `blunt damage mod`, `price mod`,
    `extra['weapon models']`. It is the grade company, already modelled as the
    weapon grade ladder. A vendor listing one means "stocks weapons of that
    make", not "sells this object".

  **And the page stops hiding them.** Dropping a row because the editor cannot
  mint it made the shop look like it does not sell it — which is exactly what
  masked the map gap for a whole release. Every vendor row is now listed; the 40
  that genuinely are not objects are dimmed, have no Add button, and carry the
  reason inline. 439 distinct addable templates against 40 non-addable, across
  898 shops.

  `stackable` also stopped being a typecode whitelist: it is now read wherever
  `ints.stackable` exists, which is types 4 (374 templates) and 102 (18), and is
  1 on every one of them. Presence is the real signal.

  Tests: `addable` must agree exactly with what `addItem` would accept (an Add
  button that always fails is worse than no button), every blocked row must
  carry a reason, and the minted map record is pinned field by field against the
  39 live ones — including the empty `material sid`, the one place the template
  and the items disagree.

- [x] **Research: see what is done, and unlock more of it.**

  A save's **entire** research state turned out to be a single typecode-21 record
  in `quick.save` — `floats["num finished"]` plus `finished<N>` strings, no name,
  no instances, no extra rows. A sweep of every key, category and instance in the
  file for `/finish|research|tech/i` returns that record and nothing else, which
  is what makes unlocking a genuinely complete one-record edit rather than half a
  fix. `test/research.test.js` asserts that exclusivity so a future format change
  cannot quietly falsify it.

  **Three kinds of entry, and telling them apart was the work.** The live save
  has 6622 of them:

  - `2915-gamedata.base` — a finished tech. 193 of 198.
  - `2058-gamedata.base.4` — level 4 of a *repeating* tech; level 1 is the bare
    sid. Confirmed rather than assumed: all 14 base sids carrying one resolve to a
    tech with `repeats > 0`, the `N`s run contiguously from 2, the bare sid is
    always present too, and no `repeats: 0` tech ever has one.
  - `66169-Newwworld.mod.TECH.1` — an unlocked item *blueprint*, 6391 of them,
    pointing at armour/crossbow/backpack templates and never at a tech.

  The tempting hypothesis — "a finished tech implies the items its `enable *` rows
  name" — is **false in both directions**: 439 things named by a finished tech are
  absent from the ledger, and 6344 listed items are named by no tech at all. So
  the page reports the blueprint count and says plainly that it will not write
  that dimension, because nothing in the data says what a tech implies. Unlocking
  a tech writes the tech.

  **Mods override techs, and load order decides which definition wins.** 183 of
  199 techs are defined more than once. Resolution walks `data/mods.cfg` — the
  game's own order — base first, unlisted mods last, with each definition
  overriding only the fields it actually carries (a mod attaching one `enable
  armour` row must not blank the scalars it never mentioned) and `extra` rows
  unioned. This is not tidiness: sid `2058-gamedata.base` is "Weapon Smithing"
  with `repeats: 14` in `gamedata.base` but "Basic Weapon Grades" with
  `repeats: 5` in `rebirth.mod`, and the save has levels up to exactly 5. 20 techs
  even display a different **name** depending on the rule. The falsifiable check,
  now a test: every tech's resolved `repeats` must be >= the highest level the
  ledger records for it — load order passes 194/194, first-definition-wins fails.

  `RESEARCH_TEMPLATE` is kept out of the tree: it is FCS boilerplate, one of 23
  records across all gamedata whose sid is a literal name rather than the
  `<id>-<file>` form every authored record uses (`PLAYER_WEAPONS`, `FISTS`,
  `blank squad`, …). The game marks it finished in every save, so it is still
  *classified* — otherwise it would surface as an unrecognised entry — just not
  offered. Every one of the 6622 entries now classifies; `unknown` is 0 across all
  four saves, and a test holds it there.

  The page: overall progress, per-branch counts, search (across what a tech
  unlocks, not just its name — "katana" finds Katanas and Naginatas), branch
  filter, "only unfinished" on by default, per-row Unlock and multi-select with
  "include prerequisites". Bulk selection is offered precisely *because* it is one
  record: ten techs unlocked one at a time would be ten backups and ten
  intermediate on-disk states for edits that all land in the same place.

  Writes append `finished<N>` and bump `num finished`, never touching an existing
  entry — the 6391 blueprint rows this service deliberately does not model come
  back byte-identical. Verified in memory rather than on disk (Kenshi was running,
  so the gate correctly refused every real write): the bytes are computed,
  re-parsed, and asserted to preserve all 6622 original entries in order, keep the
  key/`num finished` invariants, add no duplicates, and leave the record's section
  shape untouched. **Not yet observed loading in the game.**

- [x] **Codec: signalling NaNs survive the round trip.**

  Found by the round trip failing mid-session on the player's two newest
  autosaves, having passed on the older ones minutes earlier. Kenshi writes
  hundreds of NaN floats per `quick.save` (225–333 here, nearly all in a type-108
  spatial cache's instance positions). Most are quiet NaNs and always round-tripped
  fine, because a `float32 -> double -> float32` trip through a JS number preserves
  a NaN's sign and payload. What it does **not** preserve is the quiet bit: the
  hardware sets it on the widening conversion, so a *signalling* NaN came back as
  `0x...ff` where the file had `0x...bf`. One bit, one byte, in a 3.6 MB file — and
  with it the byte-identical round trip that is this editor's entire safety
  argument, which meant no write to the player's current save was permitted at all.

  `binary.js` now records each NaN's raw 32 bits against the ordinal of that float
  within its record and restores them on write. Keyed by ordinal rather than by
  "the Nth NaN" so that editing one float away from NaN cannot shift the others,
  and held in a `WeakMap` off the record so nothing that reads, diffs or clones a
  record has to know it exists. A record with no entry (freshly minted or cloned)
  writes a canonical NaN, which is correct — nothing requires a new record to
  reproduce bits it never had.

  The regression test builds a file, patches a float's bytes to `0xffbf1409` (the
  exact pattern from the failing save), and asserts a read-then-write reproduces
  it. Confirmed to fail with the fix disabled — a test that passes either way
  would have been worthless here, and the first version of it was exactly that.
