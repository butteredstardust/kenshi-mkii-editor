# Kenshi MKII Editor — Agent Briefing

Read this before touching the codec, the services, or a save file. It applies to
every coding agent working in this repo, not just Claude — keep it
agent-agnostic if you edit it.

## TL;DR

- The **webapp** (`webapp/`, port 3080, loopback only) is the supported
  interface. Python under `tools/py-reference/` is a cross-check, not a
  dependency — never wire it into the request path.
- **Kenshi must be closed** while the app writes. `mutationService` enforces it.
- A save is a **directory**, not a file. Back up and restore the whole thing.
- Nothing is written unless it **round-trips byte-identically** first. That test
  is the entire safety argument — do not weaken it.
- Strings are carried as **latin1**, never UTF-8. See §3.
- No external tools, no build step, one runtime dependency (`express`).

---

## 1. Architecture

`webapp/` is a Node/Express app with **no bundler** — the browser loads plain ES
modules. It binds `127.0.0.1:3080` only, because it can overwrite a live save.

### Backend

| File | Role |
|---|---|
| `server.js` | Express boot, loopback bind, CSP, CSRF gate |
| `services/kenshi/binary.js` | `Reader`/`Writer` primitives (`L`/`F`/`?`/`S`), `asText()` |
| `services/kenshi/codec.js` | Record container: `readFile` / `writeFile`, header probe |
| `services/kenshi/ids.js` | Minting: `nextRecordId`, `mintSid`, `addRecord`, `addInstance` |
| `services/pathService.js` | Locates saves, install dir, workshop dir, backup root |
| `services/gamedataService.js` | `stringID → name` index across all data files, disk-cached. Also the material union, the weapon-grade ladder, and `raceRules()` — the racial armour restrictions (§3) |
| `services/saveService.js` | Domain model: world summary, squads, characters, items |
| `services/itemSlots.js` | Item/slot compatibility rules for `setItemSection()` and the Gear UI's `allowedSections` |
| `services/itemFactory.js` | Shape of a minted type-42 ITEM record; weapon-grade resolution |
| `services/loadouts.js` | Named gear sets for bulk equip — editorial, like `archetypes.js`. The `meitou` half is derived from gamedata character templates, not from a save |
| `services/fitCheck.js` | Advisory "does this item suit this character" warnings — the game's own `races`/`races exclude` rules, uncovered body parts, and the wiki's per-race slot table. **Never blocks a write** |
| `services/personalities.js` | The `ints.personality` decode — **derived from gamedata**, not editorial |
| `services/loadOrder.js` | `filesInLoadOrder()` — base, then `data/mods.cfg`, then unlisted. Shared by `researchService`, `racesService` and `factionsService`; the answer wherever a mod's re-definition is the one the game obeys |
| `services/blueprints.js` | A blueprint IS an item: which type-4 template to mint and what ledger entry it grants. See §3 |
| `services/factionsService.js` | Faction relations: the type-10 catalogue in load order, and the save's type-37 relation grid. Disk-cached catalogue |
| `services/racesService.js` | The type-7 race catalogue, resolved in load order: names, `playable`, appearance family, and the `combat anatomy` that IS the MEDICAL body plan. Disk-cached |
| `services/vendorsService.js` | Who sells what, and where: gamedata's town -> squad -> vendor list -> item chain. Disk-cached |
| `services/locationsService.js` | Town world positions, read from the **install's** `.level` placement data (never the save). Disk-cached |
| `services/characterFactory.js` | Shape of a minted character: clone/sanitise/heal the six state records |
| `services/recruits.js` | "Roll a recruit" catalogue: 75 entries in 10 archetype groups. Editorial, but races/tiers/weapon classes of the named ones come from the game's type-1 character records |
| `services/names.js` | Plausible names, read from Kenshi's own `namesM/F/MF.txt` |
| `services/backupService.js` | Whole-directory versioned backups with hash manifests |
| `services/mutationService.js` | The write gate: game check, staging, verify, rollback |
| `routes/api/*.js` | HTTP surface, one file per domain, mounted by `routes/api/index.js` |
| `routes/lib/handler.js` | `handle()` — turns thrown errors into JSON with a status |
| `scripts/status.js` | Console character report; smoke test for the whole stack |

### Frontend

`public/index.html` → `public/app.mjs`, with `public/modules/core.mjs`
(`esc`, `num`, `bar`), `public/modules/api-client.mjs` (typed fetch wrappers,
CSRF handling) and `public/modules/combo.mjs` (searchable dropdowns). Styles in
`public/styles.css`.

`combo.mjs` is a progressive enhancement, not a component: a MutationObserver on
`#page` finds every `<select>` with more than five real options and puts a filter
box above it, hiding the options that do not match. The native control is kept
and stays authoritative — `.value`, `onchange`, `data-initial` diffs and `dis()`
all behave exactly as if it never ran, which is why no call site had to change.
Add `data-nofilter` to opt a control out (the six-rung armour-tier ladder does,
because it is ordered and repeated once per table row). Anything that rewrites a
select's `<option>`s imperatively is covered by the same observer.

---

## 2. Safety / mutation model

Every write goes through `mutationService.mutate(saveDir, label, action)`:

1. Reject if another mutation is active (409).
2. Reject if `kenshi_x64.exe` is running (409). If the check itself fails, assume
   it **is** running.
3. Hash the live directory; create an automatic backup.
4. Copy the save to a temp staging directory.
5. Run `action(stagingDir)` → `{ file, bytes }` (or an array of them).
6. **Re-parse the produced bytes** and confirm the parse covers the whole file.
7. Write into staging; diff hashes; reject a no-op edit.
8. Re-check both preconditions — game still closed, live save unchanged since
   step 3 — and abort if either went stale.
9. Copy only the changed files into the live directory.
10. Return a receipt: `operationId`, `backupId`, `changedFiles`, `verifications`,
    before/after hashes, `rollbackStatus`.
11. On any failure after the backup exists, restore from it automatically.

**Do not add a write path that bypasses this.** A service function's job is to
produce bytes and return them; installing bytes is `mutationService`'s job
alone. `saveService.setPlayerMoney()` is the reference shape.

### Restoring is the exception, and it is gated separately

Restoring a backup replaces a whole directory rather than producing bytes, so it
cannot go through `mutate()`. It gets its own gate,
`mutationService.restoreBackup(id)`, which applies the same first two
preconditions — no other mutation active, game closed if the target is a live
save — and holds the same one-at-a-time lock while it runs.

`backupService.restore(id)` underneath it stays deliberately **ungated**:
`mutate()`'s step 11 calls it to roll back a failed edit, and a rollback must
never be refused — that is precisely the moment a save is half-written. Call
`mutationService.restoreBackup()` from anything user-facing; call
`backupService.restore()` only from a rollback path.

Restore stages the incoming copy beside the save and swaps it in, so the save is
never deleted ahead of a copy that might fail. The staging directories are
dot-prefixed, and `pathService.listSaves()` skips dot-prefixed directories so an
orphan left by a crash can never be offered to the player as a save.

---

## 3. Format rules that will bite you

Full detail in `docs/save-format.md`. The non-negotiables:

- **Strings are latin1, not UTF-8.** `quick.save` holds a `0x80` byte in a string
  field. UTF-8 decoding replaces it with U+FFFD and the string grows 4 → 6 bytes
  on write. Use `asText()` only at the display boundary.
- **Key order is significant.** Sections are `Map`s. Never convert a section to
  a plain object — it reorders nothing but silently collapses duplicate keys and
  changes the count.
- **Preserve what you cannot explain.** `headerRaw` and `tail` are raw slices.
  The filetype-17 header blob is located by probing, not by a guessed layout.
- **`instanceCount` duplicates the instances section count on SOME typecodes
  only — do not assume it globally.** Measured over all 3933 records of a live
  save: it matches on every type 41 (INVENTORY, 282/282), 42 (ITEM, 1648/1648),
  36, 57, 25, 66, 67, 9, 37 and others — but **not** on type 30 (SQUAD: 23 of 25
  records have `instanceCount: 0` alongside 2–19 real instances), nor on types
  28, 38, 94 or 108. It does not drive parsing either: `readRecord` reads it as a
  leading field and reads the instances section's own count separately. So keep
  the two in lockstep when adding an instance to a container where they already
  agree (41 is the case that matters today), and **leave it alone** where the
  file itself says they don't.
- **`hit<n>` in medical records is not a reliable maximum** (undamaged arms read
  100 against a `hit` of 80). Judge damage against the character's own highest
  intact part.
- **stringIDs are not paths.** `changes_otto.mod` and `gamedata.quack` do not
  exist on disk; their records live in `gamedata.base`. Resolve through the flat
  index, never the filename.
- **User text goes in through `fromText()`, never as a raw JS string.** `asText()`
  is the read side; `binary.fromText()` is its exact inverse and the only correct
  write side. Assigning the plain string instead writes it as latin1, silently
  truncating every code point above U+00FF to its low byte — "Ō" lands on disk
  as "L". Measure length caps with `byteLength()`: string fields are
  length-prefixed in **bytes**.
- **A character-instance id is not a record sid.** In an INVENTORY (41) record
  the instances are ordinals ("1", "2", …); in a SQUAD (30) record they are
  sid-shaped handles ("32--INGAME") minted from that file's own id counter, and
  across all 282 character instances of a live save **not one of them is any
  record's sid** — the ids they consume show up as exact gaps in the file's
  record-id sequence. So a new squad member burns **seven** ids: six state
  records plus its own handle. `ids.addInstance()` takes an explicit `id` for
  this case and refuses a duplicate.
- **A backpack's contents are one hop further than they look.** A worn pack is a
  type-42 ITEM in the character's INVENTORY, and it holds a single instance
  pointing at its **own** INVENTORY (41) record, whose instances are the
  contents (type-42 items sectioned `backpack_content`). Nothing that reads only
  the character's own inventory can see them — which is why 152 items in the
  live save were invisible to this editor until `packContentsOf()` existed.
- **A town's position is in the install, not the save, and not where you'd
  think.** A type-13 town record carries no position at all; the placement is an
  *instance* targeting it, in `data/newland/leveldata/<mod>/leveldata.level`.
  The root `data/leveldata.level` looks like the file you want and is not: 20
  entries, all with a sentinel height, at positions that disagree with the
  world. The save's type-94 town states are named but carry only a 4500-unit
  zone cell, and their naming is a different layer (the save calls the player's
  cell "Heng" where the data places "Trader's Edge"). See
  `services/locationsService.js` for the full evidence.
- **Vendor stock is NOT in the save either.** Shops roll their inventory at
  runtime. What a shop CAN carry comes from a gamedata chain:
  town (13) `extra['residents'|'bar squads'|…]` -> squad (52) `extra['vendors']`
  -> vendor list (49) `extra['items'|'weapons'|'clothing'|'robotics'|…]` -> item
  template. Collect those extra rows as a **union across every definition of a
  sid**, exactly like the material index: Black Desert City's first definition
  carries only `extra['faction']`, and first-definition-wins reports the city as
  having no shops at all. There is no town -> biome-region link in the data
  (type-95 regions reference `nests`, not towns), which is why the Vendors page
  groups by faction and says "Faction", not "Region".
- **Dialogue is NOT in the save.** A CHAR_STATE record has no dialogue
  reference of any kind — across 555 live characters there are exactly four
  CHAR_STATE string-key shapes (`name, owner faction ID, sheath`, plus optional
  `bountyfac<n>`). Dialogue hangs off the type-1 CHARACTER TEMPLATE in gamedata
  (`extra['dialogue package']` and `extra['dialogue package player']`), reached
  through the squad instance's `target`. The editor reports it and offers no
  setter; do not add one without new evidence.
- **`ints.personality` is one of seven values**, decoded in
  `services/personalities.js` from gamedata's type-26 records: 1 Honorable,
  2 Traitorous, 5 Smart, 6 Dumb, 9 Brave, 10 Fearful, 14 Crazy. The record named
  "Random" lists exactly those seven, and no live character uses any other.
- **An item template is typecode 2, 3, 4, 46, 102, 107 or 111 — never 42.** 42 is the
  save-side ITEM *instance*. The two late additions were both whole item classes
  the editor could not reach:
  - **46 (backpack)** — 22 in this install's data; all 42 live type-46-backed
    items sit in `backpack_attach` and mint with `item function: 4`, `level: 0`,
    `quality: 100`, an empty `company sid` and **no `uniform` key**.
  - **107 (crossbow)** — all 7 live ones mint with `item function: 0`, a
    caller-settable `level`, `quality: 100`, an empty `company sid` (a crossbow
    has no manufacturer ladder, so `gradeId` is *refused*, not ignored) and a
    `uniform` key. Worn on `back`: 6 of the 7 are, and the seventh is one being
    carried inside a pack, which is a bucket rather than a competing slot.
  - **111 (robotic limb)** — CARRIED, never worn: all 11 live ones sit in
    `backpack_content`. The one kind with extra float keys: `wear`, `stun`,
    `dam` come BEFORE `charges`/`quality`, and key order is load-bearing.
  - **102 (map)** — carried, no `uniform` key, `item function: 0`, `level: 0`,
    `quality: 100`, and an **empty `material sid`** even though its template
    carries an `extra['material']` row. All 39 live examples agree. Note where
    they were found: no save this player owns contains a map, so the evidence is
    in the INSTALL's own `newland/leveldata/*/interiors.level` files. A
    save-only sweep will wrongly conclude maps are not items.

  **Do not add a typecode by guesswork, and do not conclude one is absent from a
  save sweep alone.** The first six were settled by sweeping all 123 files of a
  save (6103 ITEM records); `test/equip.test.js` asserts that invariant. But
  maps were missed by exactly that method — the player had never owned one — and
  only surfaced when a vendor was found selling something the editor refused to
  add. When in doubt, check the template for an item's hallmarks: `weight kg`,
  `value`, an inventory footprint, a mesh and an icon. And the supported
  set lives in `itemFactory.TEMPLATE_TYPES` alone — a second hardcoded copy is
  exactly how backpacks, crossbows and limbs stayed unreachable through
  `addItem()` after bulk equip could already place them.
- **A BLUEPRINT is an item, and it is not the thing it unlocks.** The editor got
  this wrong in both directions at once: a vendor's `blueprints` shelf points at
  a type-21 research tech, which was dimmed as "not a carryable item"; and its
  `armour blueprints` shelf points at a type-3 armour, for which the page
  offered to add *the armour*. Neither is what the shop sells. The blueprint is
  a **separate type-4 template** — `BLUEPRINT_ITEM`, `BLUEPRINT_ITEM_ARMOUR`,
  `BLUEPRINT_ITEM_GEAR`, `2223-gamedata.base` — identified by
  `ints['item function'] === 11` (FCS "_Research"), and **both** its
  `material sid` and `company sid` carry the research-ledger entry it grants.
  Measured over 46119 type-42 records across 1662 files (install `data/`, its
  `.level`/`.zone` files, and every save): 876 have item function 11, all 876
  have `material sid === company sid`, and the entry is one of exactly the three
  shapes the research ledger uses — 608 `"<type-3 sid>.TECH.1"`, 238 a bare
  type-21 tech sid, 19 `"<type-107 sid>.TECH.1"`. That closes the loop this file
  left open under "Research is one record": a `.TECH.N` ledger row is an
  unlocked item blueprint, and this is the object that writes one.
  **A save-only sweep finds zero** — no save this player owns contains one, the
  same trap maps fell into. Adding a blueprint writes the object and **must not
  touch the research ledger**; clicking it in game is what finishes the tech.
  `services/blueprints.js` owns the template choice and entry shape; a shop can
  sell a thing AND its blueprint, so a vendor row is keyed `blueprint|<sid>`,
  never by template sid alone.
- **A faction's identity is `strings['gamedata stringID']`, and relations live on
  the OTHER faction's record.** A save's type-37 FACTION records are all in
  `quick.save` — 114 of them, one per type-10 gamedata template, in every save
  checked. Their own sids are runtime handles (`19921-quick.save-INGAME`) and are
  worthless across saves; `gamedata stringID` is the key. Matching by header
  `name` looks fine and is not: the player's record carries whatever they renamed
  their squad to, and 7 of the 114 have a name gamedata never uses.
  Each record holds `strings["relationSID<n>"]` (the counterpart's gamedata sid)
  plus `floats["relation<n>"]` / `trust<n>` / `trustNeg<n>`. The grid is exact:
  113 factions carry 114 rows each (everyone including themselves, self always
  100), and **the player carries none** — it is the only record with no relation
  rows, the only one with `floats['global trust']`, and the only one with
  `extra['known']` (which factions have been met). So "my standing with the Holy
  Nation" is a float on the *Holy Nation's* record. Relations are **not
  symmetric** (10991 of 11449 reciprocal pairs agree; 458 do not), so a change is
  directional and touches exactly one float. Every slot already exists, which is
  why `factionsService.setRelations()` **never mints a key** — a missing row is
  refused, not invented. Standing labels are derived from the faction's own
  `enemy classification` (-10 on 109 of 114) and `business relations` (-5 on
  103), never from bands this editor made up.
- **A weapon's grade is the (company sid, material sid) PAIR, and a model sid is
  not a key.** 14 of this install's 24 grade model sids appear under two
  different companies — `1069-gamedata.base` is both "Homemade" and
  "Edgewalkers". Anything choosing a grade passes the ladder row's
  `id` (`"<companySid>|<modelSid>"`); resolving by model sid alone silently
  picks whichever row sorts first and writes a different manufacturer than the
  user chose. `itemFactory.resolveGrade()` is the one place that resolution
  happens.
  **`ints.level` is still a SEPARATE field — but a grade chosen without one now
  supplies it.** Nothing in the format links the two, and nothing here has
  changed about that: they are written independently and an explicit `level`
  always wins. What changed is the default. A player has one word for this
  concept ("a Meitou katana"), so the UI asks only for the grade, and a level
  defaulting to 0 behind it produced Meitou weapons at level 0. The ladder row's
  own `rank` is the number — it is the type-51 company record's `v0` for that
  model, already runs 0..100 across this install's 38 rows, and is the same
  scale `ints.level` uses on live weapons. `itemFactory.defaultLevelForGrade()`
  is the one place that decision lives; `buildItemRecord()`, `updateItem()` and
  `regradeMany()` all go through it. **Scoped to type 2 only** — a crossbow
  (107) takes a level but has no manufacturer ladder, so a grade says nothing
  about it and must not move it.
- **Racial armour restrictions ARE in the data — `extra['races']` and
  `extra['races exclude']` on the type-3 template — and they still never block a
  write.** This overturns what this file previously said ("not in any field this
  editor has identified"). `races` is a WHITELIST and `races exclude` a
  BLACKLIST, both naming race stringIDs, and together they reproduce the wiki's
  restriction lists exactly: 63 of this install's 2344 type-3 records carry one.
  Every ordinary shirt excludes all nine Hive races and every Hiver shirt
  whitelists them (which is the wiki's "restricted to Hiver shirts" rule, from
  both ends); Wool Hat, Cap, Hachigane and Side-Angle Hachigane whitelist the
  two human races; Masked/Visored/Spiked/Flared Helmet, Karuta/Kusari Zukin and
  Crab Helmet exclude Shek and the Hive Workers. Union both sides across every
  definition, exactly like the material index — "Paladin's Heavy Hachigane"
  carries the whitelist in one definition and the blacklist in another. Cached
  on the gamedata index (`gamedataService.raceRules()`, CACHE_VERSION 8).
  **Resolve the race names through `racesService`, never `gamedata.nameOf`** —
  a restriction listing "Human" and "Sundemon" names nothing the player can find.
  What is NOT in the data is the wiki's per-race **slot** table (a Skeleton
  having no shirt/head/boots slot at all): nothing in a type-7 race record
  expresses it, so `fitCheck.RACE_SLOT_RULES` carries it as **editorial**, and
  a warning says which of the two it came from. Measuring it against this
  machine's saves is inconclusive by construction — all 3923 characters found
  live in player `.platoon` files, i.e. gear a player (quite possibly using this
  editor) put there — though the Hive rows do match exactly: 0 head and 0 boots
  on Soldier Drones, 0 boots on Workers and Princes.
  **None of this refuses a write, including the derived half.** Kenshi enforces
  these rules in its own UI; a save file will hold a Wool Hat on a Skeleton, and
  writing what the game's UI will not offer is the entire point of this editor.
  `services/fitCheck.js` reports; `saveService` writes anyway. Kind-vs-slot
  incompatibility is a different question, IS enforced, and lives in
  `services/itemSlots.js`. The third signal is still an armour template's
  `extra['part coverage']` naming body parts the target's MEDICAL record lacks.
- **A race's NAME needs load order; `gamedataService.nameOf()` is wrong for it.**
  `17-gamedata.quack` is "Human" in `gamedata.base` and **"Greenlander"** in
  `rebirth.mod`; `18019-gamedata.base` is "Sundemon" and **"Scorchlander"**. Both
  are ~20-definition sids, and the name the player sees is the last one. Race
  names therefore resolve through `services/racesService.js` (which shares
  `services/loadOrder.js` with `researchService`), never the flat index — the
  flat index is still correct for everything whose name no mod re-states.
- **A race's `extra['combat anatomy']` IS the MEDICAL body plan.** Each row's
  `target` is a body part (type 16), `v0` is that part's `hit<n>` and `v1` is its
  undamaged maximum. Measured over every character in every save on this machine
  (3717 of them, 15 races): the part sets match 3717/3717 and `hit<n> == v0`
  3717/3717. Two resolution rules are load-bearing and both were forced by data:
  - **Union the rows across definitions, last-wins per part.** `rebirth.mod`
    re-defines Scorchlander carrying ONE row — Right Arm, the limb that makes a
    Scorchlander not a Greenlander. Letting the last definition replace the list
    gives that race a one-limbed body and mismatches all 862 of them.
  - **A value of `2147483647` (INT32_MAX) REMOVES the part.** "Unofficial Patches
    for Kenshi.mod" gives Goat two forelegs and sentinels its two arms; live
    goats have exactly the resulting seven parts.
- **`flesh<n>` is scaled on a race switch, never clamped.** `v1` is a natural
  maximum, not a ceiling: 39 live Hive Worker Drones read up to 125 against a
  `v1` of 75, and they are the same characters whose otherwise-uniform
  `hitmult<n>` stops being 1 — robotic limbs. Clamping confiscates a prosthetic;
  refilling turns a race switch into a free heal. `hitmult<n>`/`rig<n>`/`wear<n>`
  are per-character and a race switch does not touch them.
- **The MEDICAL slot order is fixed, and slots substitute across races.** Every
  race observed uses `sid0` Head, `sid1` Chest, `sid2` Stomach, `sid3`/`sid4`
  left/right upper limb, `sid5`/`sid6` left/right leg. `Left Arm` and
  `Left Foreleg` are the same slot under two names — identical `body part type`,
  identical `collapse part` bitmask, identical bone names — which is what lets
  `saveService.setRace()` map one plan onto another positionally rather than
  inventing an ordering. Matching is by stringID first, then by that
  (type, collapse) pair.
- **A squad has no name; the player faction does.** A full sweep of a live save
  found the player's chosen name in exactly three places, all in `quick.save`:
  GAME_STATE (56) `strings['pfaction name']`, each SQUAD_META (34)
  `strings['faction name']`, and the player FACTION (37) record's header `name`.
  Rename all three together. **Do not rename platoon files** — a squad's file
  identity is its type-34 `sid`/header `name`/`platoon stringID`/`content file`
  quartet, and `mutationService` installs file *contents*; it never moves,
  creates or deletes a path. `saveService.playerPlatoonFiles()` therefore
  resolves squads through the type-34 records, not by matching the
  `<Faction>_<n>.platoon` filename prefix, so a rename cannot orphan the roster.
- **Record ids are per-file and ephemeral.** Each filetype-15 file has its own
  `nextId`; the same id names unrelated records in different files, and the game
  re-mints every id on every save. Never treat an id as identity or persist one.
  References travel by `sid`. See `docs/save-format.md` §1/§9.

---

### Research is one record, and three kinds of entry

A save's **entire** research state is a single typecode-21 record in
`quick.save`. Nothing else in the file mentions research — a sweep of every key,
category and instance for `/finish|research|tech/i` returns that record and only
that record, which is what makes unlocking a one-record edit rather than a
half-fix. It has no name, no instances, no extra rows:

```
floats:  { "num finished": 6622, "num currents": 0 }
strings: { "finished0": "<entry>", "finished1": "<entry>", ... }
```

`finished<N>` keys are contiguous `0..N-1` and `num finished` is the count. Their
order inside the file is arbitrary (a 6622-entry ledger is thoroughly shuffled),
so append rather than insert and the rest comes back byte-identical. An entry is
one of three shapes and **telling them apart is the whole job**:

| Entry | Means |
|---|---|
| `2915-gamedata.base` | a finished tech (the type-21 gamedata record) |
| `2058-gamedata.base.4` | level 4 of a **repeating** tech; level 1 is the bare sid |
| `66169-Newwworld.mod.TECH.1` | an unlocked **item blueprint** — not a tech at all |

The `.N` reading was confirmed, not assumed: every base sid carrying one resolves
to a tech with `repeats > 0`, the `N`s run contiguously from 2, the bare sid is
always present too, and no tech with `repeats: 0` ever has one.

`.TECH.N` points at an item template (armour, crossbows, backpacks), never at a
tech. **Do not invent a rule linking the two.** The obvious hypothesis — "a
finished tech implies its `enable armour`/`enable buildings`/... rows are
listed" — is false in both directions: 439 things named by a finished tech are
absent from the ledger, and 6344 listed items are named by no tech. Unlocking a
tech writes the tech.

`RESEARCH_TEMPLATE` is FCS boilerplate, not a tech: it is one of 23 records
across all of gamedata whose sid is a literal name instead of the
`<numericId>-<sourceFile>` form every authored record uses (`PLAYER_WEAPONS`,
`FISTS`, `blank squad`, …). The game marks it finished in every save, so
classify it — just keep it out of the tree.

### Mods override gamedata records, and load order decides which wins

183 of this install's 199 techs are defined more than once. **The last definition
wins, and only for the fields it actually carries** — a mod that re-defines a
tech purely to attach one `enable armour` row must not blank the scalars it never
mentioned. `extra` rows are unioned across every definition (the same rule as the
material index).

This is not tidiness. Sid `2058-gamedata.base` is "Weapon Smithing" with
`repeats: 14` in `gamedata.base` and "Basic Weapon Grades" with `repeats: 5` in
`rebirth.mod`; the live save has levels up to exactly 5. 20 techs display a
different **name** depending on which rule you use.

Order comes from `data/mods.cfg`, the game's own load order, with base data first
and anything installed-but-unlisted last (`rebirth.mod` is exactly that case here
— absent from mods.cfg yet plainly active). The falsifiable check, asserted by
`test/research.test.js`: **every tech's resolved `repeats` must be >= the highest
level the ledger records for it.** Load-order resolution passes 194 of 194;
first-definition-wins fails.

### NaN floats: the round trip's one-bit trap

Kenshi writes NaN floats into saves — 225 to 333 per `quick.save`, nearly all in
a type-108 spatial cache's instance positions. A `float32 -> double -> float32`
trip through a JS number preserves a NaN's sign and payload but **sets the quiet
bit**, so a *signalling* NaN comes back one bit different and the byte-identical
round trip fails on that alone. `binary.js` therefore records each NaN's raw bits
against the ordinal of that float within its record, and `Writer.F()` puts them
back. Do not "simplify" this away: it is the difference between the codec
round-tripping the player's current save and refusing to write to it at all.

---

## 4. Conventions

- **Backend:** CommonJS. Add functions to the matching `services/*.js`, then a
  route in `routes/api/*.js` using `handle()`. Validate and range-check every
  input before it reaches a record.
- **Frontend:** vanilla ES modules. Build HTML strings and assign `innerHTML`;
  escape **every** dynamic value with `esc()`. **Read `docs/ui-style-guide.md`
  before adding any UI** — it is a guardrail document, not a suggestion. In
  short: compose the components in `styles.css` rather than inventing
  per-feature class names, never render a raw save float (`num`/`inputNum`),
  match the button intent tier to the consequence, and report every mutation
  through `showReceipt()`.
- **No new runtime dependencies** without a strong reason. `express` is the only
  one, and the codec is deliberately dependency-free.
- **Tests:** `node --test "test/*.test.js"` from `webapp/`. Any new file format
  or new write path needs a round-trip test before it ships.
- **A test reads the fixture through `test/helpers/save-fixture.js`, never
  `saveService.status(name)`.** That call resolves the *name* against the
  player's live save folder, while `scratchSave()` writes to a copy of the
  **fixture** — so the moment the player keeps playing, a test picks characters
  out of one world and edits another, and fails with "no character with sid …"
  that looks exactly like a code regression. Use `fixture.fixtureStatus()` /
  `fixture.fixtureSquad()`, which read the fixture directory itself.

---

## 5. API surface

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/health` | Liveness |
| GET | `/api/status` | Save root, install dir, save list, game-running, writability |
| GET | `/api/gamedata` | Name-index stats |
| POST | `/api/gamedata/rebuild` | Rebuild the name index from disk |
| GET | `/api/gamedata/items` | Item-template picker feed: `?q=` name substring, `?limit=` (default 50, cap 500). Rows carry `sid`, `name`, `type`, `kind`, `stackable`, `allowedSections`/`slotsWidened` (from `services/itemSlots.js`), `raceRule` (the game's own racial restriction — `{ only, exclude }` of `{sid, name}` pairs, or null; **match it on the character's `race.sid`, never the name**) and catalog `category`/`description` (null on a miss). Filtered to template typecodes **2/3/4/46/107** — type 42 is the save-side item *instance*, not a template. |
| GET | `/api/gamedata/weapon-grades` | The weapon grade ladder (`{ id, companySid, companyName, modelSid, modelName, rank }[]`, rank-ascending). A weapon's grade is the **(company sid, material sid) pair**, not `ints.level` — and **`modelSid` alone is not a key**: 14 of this install's 24 model sids appear under two companies. Pass the row's `id` (`"<companySid>\|<modelSid>"`) as `gradeId`. |
| GET | `/api/vendors` | Faction -> town -> shop tree (contents excluded — ~900 shops) plus build stats |
| GET | `/api/vendors/:id` | One shop's full stock. `:id` is `"<townSid>\|<squadSid>"`. Every row carries a `key` — `"blueprint\|<sid>"` on a blueprint shelf, the template sid otherwise — because a shop can sell **both** an armour and the blueprint for it, and keying by template sid alone silently dropped one. A blueprint row carries `blueprint: { templateSid, templateName, teaches, subjectName, kind }`: `templateSid` is the type-4 BLUEPRINT item to mint, `teaches` is the research-ledger entry it grants. Only weapon-manufacturer (51) rows are non-addable now |
| GET | `/api/vendors-carrying/:sid` | Reverse lookup: every shop that stocks this template |
| POST | `/api/vendors/rebuild` | Re-scan gamedata for vendor stock (after a mod change) |
| GET | `/api/locations` | Town positions for the teleport picker: `{ id, name, label, faction, x, y, z, source }[]` plus build stats. From the install's world data, **not** the save — see `services/locationsService.js` for why the two obvious sources are both wrong |
| POST | `/api/locations/rebuild` | Re-scan the install for town placements (after installing or removing a mod) |
| POST | `/api/saves/:name/platoons/:file/teleport` | Move a squad. `{ locationId }` for a catalogued town, or raw `{ x, y, z }`; `sids?` limits it to some of the squad. Edits the SQUAD (30) instances' `pos` **and** the quick.save SQUAD_META position so the map marker follows |
| GET | `/api/personalities` | The seven working personality values, decoded from gamedata's type-26 records (`services/personalities.js`) |
| PUT | `/api/saves/:name/platoons/:file/characters/:sid/personality` | Set `ints.personality` on CHAR_STATE. `{ personality, allowUnknown? }`; refuses anything outside the seven unless overridden |
| GET | `/api/loadouts` | **66 named gear sets** for bulk equip (`services/loadouts.js`) — editorial. The first 37 were read off the game's own NPCs in a live save; the 29 tagged `meitou` are the named Meitou wielders, read off their own **type-1 CHARACTER templates** in gamedata (`extra['clothing'|'weapons'|'inventory'|'race']`, `ints['armour grade']`), unioned across every definition in load order. Items already resolved to names/kinds, plus `tags` (heavy/light/ranged/support/trade/travel/starter, plus the weapon class — katanas/sabres/blunt/heavy-weapons/hackers/polearms — on a Meitou entry) for grouping, advisory `raceNotes`, and a `missing[]` of any template this install cannot resolve. A Meitou entry's weapon carries **no `level`**: the grade supplies it |
| GET | `/api/saves` | List save directories, newest first |
| GET | `/api/saves/:name/status` | World summary + squads + characters + inventories. Every inventory row carries `fitWarnings[]` (`{source: 'derived'\|'editorial', text}`) resolved against **that** character — which is how gear already worn by the wrong race is visible without re-equipping it — and each character's `race` carries `armourSlots`/`slotRuleLabel` from the wiki's per-race slot table (null = no known restriction) |
| PUT | `/api/saves/:name/money` | Set player cats (goes through the mutation gate) |
| PUT | `/api/saves/:name/platoons/:file/characters/:sid/stats` | Set one or more attributes/skills on a character's STATS record (bulk, one staged edit; `{ stats: { statKey: value } }`) |
| GET | `/api/archetypes` | "Train as archetype" catalogue (id/label tree of mains and subs), for the UI dropdowns |
| GET | `/api/recruits` | "Roll a recruit" catalogue (`services/recruits.js`): 75 entries in 10 archetype groups (soldier, duellist, shadow, ranger, medic, artisan, trader, explorer, labourer, outcast), at least 4 per group. Carries `group`/`groupLabel`, race hint, archetype/sub, tier, blurb, `where` resolved against this install's towns, and — on the 29 Meitou wielders — `meitou: true` plus `loadoutId`/`loadoutLabel` pointing at their gear set. Their race/tier/sub come from the game's type-1 template, the weapon class from that weapon's `ints['skill category']` (0 katanas, 1 sabres, 2 blunt, 3 heavy weapons, 4 **hackers**, 8 polearms) |
| GET | `/api/names` | A pool of plausible names from Kenshi's own `namesM/F/MF.txt` (`?count=`, capped at 200). Used to pre-fill the new-member name field |
| GET | `/api/races` | The full type-7 race catalogue (`services/racesService.js`), resolved in the game's own `data/mods.cfg` load order — which is why this says **Greenlander**/**Scorchlander** where the flat name index says "Human"/"Sundemon". `?q=` name substring, `?playable=1` for the character-creator races. Each row carries `label` (name, suffixed with the originating file where two races collide), `appearanceFamily`, `switchable` and the resolved `anatomy`. Save-independent |
| POST | `/api/races/rebuild` | Re-resolve the race catalogue (after a mod change) |
| PUT | `/api/saves/:name/platoons/:file/characters/:sid/race` | **Change a character's race.** `{ raceSid }`. One platoon-file write covering the APPEARANCE (66) `extra['race']` row and the MEDICAL (57) body plan — `sid<n>`/`hit<n>` from the target race's `combat anatomy`, `flesh<n>` **scaled** by the ratio of the two parts' maxima (see AGENTS.md §3 for why scaled, not clamped). Refuses only a race with no anatomy and a body plan that cannot be mapped; everything else (appearance-family mismatch, non-playable race, replaced body parts) is a `warnings[]` on the receipt, never a block |
| GET | `/api/saves/:name/races` | `{ races, default }` — the races this save can supply a **living donor** for (`{ sid, name, count, donors }`, most donors first) plus the one the UI should preselect. A new member is cloned from an existing character, so this is what the save contains, never all of gamedata |
| PUT | `/api/saves/:name/platoons/:file/characters/:sid/name` | Rename a character: `strings.name` on CHAR_STATE (36) **and** the STATS (25) record's header `name`, which is where the game keeps a named character's name. `{ name }`, ≤ 63 UTF-8 bytes, control characters rejected, encoded through `binary.fromText()` |
| PUT | `/api/saves/:name/faction/name` | Rename the squad — i.e. the **player faction**, the only squad-level name a save stores. One write to `quick.save` covering GAME_STATE `pfaction name`, every player SQUAD_META (34) `faction name`, and the player FACTION (37) record's header name. Platoon **filenames are deliberately not renamed** (see below) |
| POST | `/api/saves/:name/platoons/:file/characters` | Add a squad member. `{ name, raceSid, archetype, sub, tier? }`. Writes two files — the `.platoon` and `quick.save` — in one staged edit. See `services/characterFactory.js` |
| POST | `/api/saves/:name/equip` | **Bulk equip.** `{ targets: [{file, sid}], loadoutId?, items?, skipIfSlotFilled? }` — every target gets every item in ONE staged edit, across however many platoon files the targets span (`loadoutId` and `items` concatenate). Kind-vs-slot incompatibility is a hard refusal; **race fit never blocks**, it is reported per character via `services/fitCheck.js` — including the game's own racial armour restrictions (§3), which the UI also shows in the pre-flight before the write. See `saveService.equipMany()` |
| POST | `/api/saves/:name/platoons/:file/characters/:sid/train` | "Train as archetype": one staged edit setting all 4 attributes to 45, archetype skills to random 45–95, everything else to random 15–40; `{ archetype, sub, mode? }` (`mode: 'raise'` default never lowers an existing stat, `'set'` overwrites) |
| PUT | `/api/saves/:name/platoons/:file/characters/:sid/medical/parts/:n` | Heal a body part: set `flesh<n>` (or `"full"`), zero `bandage<n>`/`stun<n>` by default; `{ flesh, bandage?, stun? }` |
| PUT | `/api/saves/:name/platoons/:file/characters/:sid/medical/parts/:n/damage` | Limb loss (destructive, no lower clamp on `flesh`); same body shape as heal, UI must confirm before calling |
| PUT | `/api/saves/:name/platoons/:file/characters/:sid/medical/hunger` | Set `hung` (0-3) and/or `fed` (0-10) independently; `{ hung?, fed? }` |
| POST | `/api/saves/:name/platoons/:file/characters/:sid/revive` | Clear dead/coma/incapacitated/unconscious + zero KO, and raise any flesh below `minFleshPercent`% of the character's own max — one combined write |
| POST | `/api/saves/:name/platoons/:file/characters/:sid/medical/restore-limbs` | Delete `ints.limbs` if present (no bitmask interpretation); no-op is rejected by the mutation gate |
| PUT | `/api/saves/:name/platoons/:file/characters/:sid/inventory/:itemSid/section` | Move an item into a slot (`strings.section` on type 42); `{ section }`. If the target slot is already occupied by another of this character's items, that item's `section` is flipped back to `main` in the same write. Rejects a slot not in the documented list, an item that isn't in this character's own inventory, or a slot incompatible with the item's kind (see `services/itemSlots.js`) — the latter check is skipped (permissive) when the item's kind can't be resolved via `gamedataService`. |
| PUT | `/api/saves/:name/platoons/:file/characters/:sid/inventory/:itemSid/quality` | Set `ints.level` and/or `floats.quality` on an item, independently; `{ level?, quality? }`. Both keys must already exist on the record. Thin wrapper over `updateItem()`. |
| PUT | `/api/saves/:name/platoons/:file/characters/:sid/inventory/:itemSid` | **Unified per-item edit** — `{ section?, level?, quality?, quantity?, materialSid? }`, any combination, in ONE staged edit (one gate pass, one backup). This is what the Gear row's single "Apply" calls; the two narrower routes above are wrappers over the same `saveService.updateItem()`. `quantity > 1` is rejected unless the template is stackable. Weapon grade is chosen with `gradeId` and writes `material sid`/`company sid` in lockstep — the **pair** is the grade, `level` is a separate field, but a `gradeId` sent WITHOUT a `level` also writes the ladder row's `rank` into `ints.level` (§3). The receipt's `after.levelFromGrade` says whether it did. Bare `materialSid` still works but is ambiguous (see `/api/gamedata/weapon-grades`) and resolves to the lowest-ranked matching row. |
| POST | `/api/saves/:name/platoons/:file/characters/:sid/inventory` | Add a new item to a character's inventory; mints a type-42 ITEM record and an INVENTORY (41) instance via `services/kenshi/ids.js`. `{ templateSid, section, quantity?, level?, gradeId?, materialSid?, companySid?, teaches? }`. On a weapon, `gradeId` without `level` mints at the grade's own ladder rank (§3). **`teaches`** is the blueprint case: on a blueprint template only (item function 11), it is the research-ledger entry the blueprint grants and is written into **both** `material sid` and `company sid` — see §3 and `services/blueprints.js`. Refused on any other template, and refused if the string is not one of the two ledger shapes. The receipt carries `warnings[]` when the save has already finished what the blueprint teaches, or when no installed mod defines its subject. It never writes the ledger itself. `templateSid` must resolve to a gamedata item template (typecode 2/3/4); `section` is validated via `itemSlots.allowedSections()`; `quantity > 1` is rejected unless the template is stackable. Displaces a prior occupant of an already-occupied single-occupancy `section` back to `main`, same rule as the `/section` route above. See `services/itemFactory.js` for the minted record's exact shape. |
| POST | `/api/saves/:name/regrade` | **Bulk re-grade of gear the targets already OWN.** `{ targets: [{file, sid}], armourLevel?, weaponGradeId?, weaponLevel?, includeCarried?, includePackContents? }` — one staged edit across however many platoon files the targets span. Nothing is added, removed or moved: only `ints.level` and the `material sid`/`company sid` grade **pair** are written, and only onto records that already carry those keys. Armour's tier IS `ints.level` (5/20/40/60/80/95 = Prototype..Masterwork); a weapon's grade is the (company, material) pair and its `level` is a **separate** field. `armourLevel`/`weaponGradeId`/`weaponLevel` are three independent controls, with one default: `weaponGradeId` without `weaponLevel` also sets type-2 levels to the grade's `rank` (§3), reported as `weaponLevelFromGrade` on the receipt. An explicit `weaponLevel` always wins, and it is the only thing that moves a crossbow's level. Type 107 (crossbow) follows `weaponLevel` and is refused a grade — it has no manufacturer ladder. Scope is WORN items unless widened; an item whose template can't be resolved is left alone, never guessed at. See `saveService.regradeMany()` |
| POST | `/api/saves/:name/unequip` | **Bulk unequip.** `{ targets: [{file, sid}], sections?, templateSids?, itemSids? }` — moves worn items back to `main` (Carried), one staged edit. The three filters AND together: no filter strips everything worn, `sections` is "take everyone's helmet off", `templateSids` is "take that item off whoever has it on", `itemSids` names exact records. The destination is always `main` and deliberately not configurable — a `backpack_content` item lives in the PACK's own inventory record, so writing that section onto an item in the character's own record would name a place the save doesn't have. Only the character's own inventory is walked; something already inside a pack is not equipped. See `saveService.unequipMany()` |
| GET | `/api/research` | The research tech tree (`services/researchService.js`): 198 techs resolved from gamedata **in the game's own `data/mods.cfg` load order**, each with category, tier, cost in research artifacts, requirements and what it unlocks. Save-independent |
| POST | `/api/research/rebuild` | Re-resolve the tech tree (after a mod change) |
| GET | `/api/saves/:name/research` | What this save has finished, joined onto the tree: per tech `done`/`atLevel`/`maxLevel`/`maxed`/`blockedBy`, plus counts including `blueprints` (the other ledger dimension) and `unknown` (must be 0) |
| POST | `/api/saves/:name/research/unlock` | **Mark research finished.** `{ sids, levels?, withRequirements? }` — one staged edit however many techs are named, because a save's entire research state is ONE type-21 record. `levels` caps a repeating tech (default: its maximum); `withRequirements` (default true) also finishes unfinished prerequisites |
| GET | `/api/factions` | The type-10 faction catalogue (`services/factionsService.js`), resolved in `data/mods.cfg` load order: `{ sid, name, notReal, enemyAt, tradeAt, definitions }[]`. `enemyAt`/`tradeAt` are the faction's own `enemy classification`/`business relations` ints — the thresholds every standing label is derived from. Save-independent |
| POST | `/api/factions/rebuild` | Re-resolve the faction catalogue (after a mod change) |
| GET | `/api/saves/:name/factions` | **How every faction feels about the player**, in this save. Per faction: `relation` (-100..100), `standing`, `met` (from the player record's `extra['known']`), `enemyAt`/`tradeAt`, `notReal`, and `editable`. Directional — the value lives on the other faction's type-37 record, because the player's own carries no relation rows at all (§3) |
| GET | `/api/saves/:name/factions/:sid/relations` | One faction's **full outgoing list** — how it sees everyone else, including the player (`isPlayer`) and itself (`isSelf`, always 100, never editable). `:sid` is a gamedata stringID, never a save record sid |
| PUT | `/api/saves/:name/factions/relations` | **Set relations.** `{ changes: [{ from, to, relation }] }`, both ends named by gamedata stringID, however many in ONE staged edit — they all live in `quick.save`. Only updates a `relation<n>` float that already exists; a missing row is refused, never minted. The whole batch is validated before any of it is applied |
| GET | `/api/backups` | List backups, newest first. **Summaries, not manifests** (`backupService.summary()`): a manifest's `hashes` map is one SHA-256 per file of a whole save directory, so serialising it made this a 1.5 MB response to draw a 37-row table. Rows carry `id`, `label`, `saveName`, `createdAt` and a `files` count; the hashes stay on disk for `restore()` to verify against |
| POST | `/api/backups` | Create a labelled backup. Refused with 409 while Kenshi is running — a backup taken mid-write is what you would then restore |
| POST | `/api/backups/:id/restore` | **Replace a save directory with a backup.** Gated by `mutationService.restoreBackup()`: 409 if another edit is active or the game is running, 404 if there is no such backup. Staged beside the save and swapped in, never deleted first |
| DELETE | `/api/backups/:id` | Delete a backup |

Mutating verbs require the `x-csrf-token` header from `GET /api/session`.

---

## 6. Run

```
cd webapp
npm install          # once
npm start            # http://127.0.0.1:3080
npm test             # round-trip + model tests
node scripts/status.js [saveName]
```

No hot reload: restart node after editing `services/`, `routes/` or `server.js`.
`public/*` needs only a browser refresh.

The name index is cached at `webapp/.cache/nameindex.json`. Rebuild it after
installing, removing or updating mods (`npm run gamedata:rebuild`).

---

## 7. Version-change rule

After a Kenshi or RE_Kenshi update, treat the header layout, typecodes and field
names as **unverified**. Run `npm test` first — the round trip is the canary. If
`quick.save` no longer round-trips, stop and re-derive before writing anything.

---

## 8. Known paths (this machine)

```
Saves:        C:\Users\Admin\AppData\Local\kenshi\save\
Backups:      C:\Users\Admin\AppData\Local\kenshi\save-backups\
Install:      D:\SteamLibrary\steamapps\common\Kenshi
Base data:    D:\SteamLibrary\steamapps\common\Kenshi\data\{gamedata.base,rebirth.mod,Newwworld.mod,Dialogue.mod}
Workshop:     D:\SteamLibrary\steamapps\workshop\content\233860\
Name cache:   webapp\.cache\nameindex.json
```

Paths are auto-detected by `pathService.js`; the constants there are fallbacks,
not assumptions baked into the rest of the app.
