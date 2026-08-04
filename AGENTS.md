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
| `services/gamedataService.js` | `stringID → name` index across all data files, disk-cached |
| `services/saveService.js` | Domain model: world summary, squads, characters, items |
| `services/itemSlots.js` | Item/slot compatibility rules for `setItemSection()` and the Gear UI's `allowedSections` |
| `services/itemFactory.js` | Shape of a minted type-42 ITEM record; weapon-grade resolution |
| `services/loadouts.js` | Named gear sets for bulk equip — editorial, like `archetypes.js` |
| `services/fitCheck.js` | Advisory "does this item suit this character" warnings. Never blocks a write |
| `services/locationsService.js` | Town world positions, read from the **install's** `.level` placement data (never the save). Disk-cached |
| `services/characterFactory.js` | Shape of a minted character: clone/sanitise/heal the six state records |
| `services/recruits.js` | "Roll a recruit" catalogue: 50 entries in 10 archetype groups. Editorial, but races/tiers of the named ones come from the game's type-1 character records |
| `services/names.js` | Plausible names, read from Kenshi's own `namesM/F/MF.txt` |
| `services/backupService.js` | Whole-directory versioned backups with hash manifests |
| `services/mutationService.js` | The write gate: game check, staging, verify, rollback |
| `routes/api/*.js` | HTTP surface, one file per domain, mounted by `routes/api/index.js` |
| `routes/lib/handler.js` | `handle()` — turns thrown errors into JSON with a status |
| `scripts/status.js` | Console character report; smoke test for the whole stack |

### Frontend

`public/index.html` → `public/app.mjs`, with `public/modules/core.mjs`
(`esc`, `num`, `bar`) and `public/modules/api-client.mjs` (typed fetch wrappers,
CSRF handling). Styles in `public/styles.css`.

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
- **An item template is typecode 2, 3, 4, 46 or 107 — never 42.** 42 is the
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
- **A weapon's grade is the (company sid, material sid) PAIR, and a model sid is
  not a key.** 14 of this install's 24 grade model sids appear under two
  different companies — `1069-gamedata.base` is both "Homemade" and
  "Edgewalkers". Anything choosing a grade passes the ladder row's
  `id` (`"<companySid>|<modelSid>"`); resolving by model sid alone silently
  picks whichever row sorts first and writes a different manufacturer than the
  user chose. `itemFactory.resolveGrade()` is the one place that resolution
  happens.
- **Race compatibility is advisory, never enforced.** Kenshi's real race/mesh
  restrictions are not in any field this editor has identified (TODO.md 1.5), so
  refusing an item on suspicion would be inventing a rule. `services/fitCheck.js`
  produces warnings — one derived (an armour template's `extra['part coverage']`
  names body parts the target's MEDICAL record may not have) and one editorial
  (a loadout's own race notes). Kind-vs-slot incompatibility is a different
  question, IS enforced, and lives in `services/itemSlots.js`.
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

---

## 5. API surface

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/health` | Liveness |
| GET | `/api/status` | Save root, install dir, save list, game-running, writability |
| GET | `/api/gamedata` | Name-index stats |
| POST | `/api/gamedata/rebuild` | Rebuild the name index from disk |
| GET | `/api/gamedata/items` | Item-template picker feed: `?q=` name substring, `?limit=` (default 50, cap 500). Rows carry `sid`, `name`, `type`, `kind`, `stackable`, `allowedSections`/`slotsWidened` (from `services/itemSlots.js`) and catalog `category`/`description` (null on a miss). Filtered to template typecodes **2/3/4/46/107** — type 42 is the save-side item *instance*, not a template. |
| GET | `/api/gamedata/weapon-grades` | The weapon grade ladder (`{ id, companySid, companyName, modelSid, modelName, rank }[]`, rank-ascending). A weapon's grade is the **(company sid, material sid) pair**, not `ints.level` — and **`modelSid` alone is not a key**: 14 of this install's 24 model sids appear under two companies. Pass the row's `id` (`"<companySid>\|<modelSid>"`) as `gradeId`. |
| GET | `/api/locations` | Town positions for the teleport picker: `{ id, name, label, faction, x, y, z, source }[]` plus build stats. From the install's world data, **not** the save — see `services/locationsService.js` for why the two obvious sources are both wrong |
| POST | `/api/locations/rebuild` | Re-scan the install for town placements (after installing or removing a mod) |
| POST | `/api/saves/:name/platoons/:file/teleport` | Move a squad. `{ locationId }` for a catalogued town, or raw `{ x, y, z }`; `sids?` limits it to some of the squad. Edits the SQUAD (30) instances' `pos` **and** the quick.save SQUAD_META position so the map marker follows |
| GET | `/api/loadouts` | **29 named gear sets** for bulk equip (`services/loadouts.js`) — editorial, read off the game's own NPCs. Items already resolved to names/kinds, plus `tags` (heavy/light/ranged/support/trade/travel/starter) for grouping, advisory `raceNotes`, and a `missing[]` of any template this install cannot resolve |
| GET | `/api/saves` | List save directories, newest first |
| GET | `/api/saves/:name/status` | World summary + squads + characters + inventories |
| PUT | `/api/saves/:name/money` | Set player cats (goes through the mutation gate) |
| PUT | `/api/saves/:name/platoons/:file/characters/:sid/stats` | Set one or more attributes/skills on a character's STATS record (bulk, one staged edit; `{ stats: { statKey: value } }`) |
| GET | `/api/archetypes` | "Train as archetype" catalogue (id/label tree of mains and subs), for the UI dropdowns |
| GET | `/api/recruits` | "Roll a recruit" catalogue (`services/recruits.js`): 50 entries in 10 archetype groups (soldier, duellist, shadow, ranger, medic, artisan, trader, explorer, labourer, outcast), each with 4-5 options. Carries `group`/`groupLabel`, race hint, archetype/sub, tier, blurb, and `where` resolved against this install's towns |
| GET | `/api/names` | A pool of plausible names from Kenshi's own `namesM/F/MF.txt` (`?count=`, capped at 200). Used to pre-fill the new-member name field |
| GET | `/api/saves/:name/races` | `{ races, default }` — the races this save can supply a **living donor** for (`{ sid, name, count, donors }`, most donors first) plus the one the UI should preselect. A new member is cloned from an existing character, so this is what the save contains, never all of gamedata |
| PUT | `/api/saves/:name/platoons/:file/characters/:sid/name` | Rename a character: `strings.name` on CHAR_STATE (36) **and** the STATS (25) record's header `name`, which is where the game keeps a named character's name. `{ name }`, ≤ 63 UTF-8 bytes, control characters rejected, encoded through `binary.fromText()` |
| PUT | `/api/saves/:name/faction/name` | Rename the squad — i.e. the **player faction**, the only squad-level name a save stores. One write to `quick.save` covering GAME_STATE `pfaction name`, every player SQUAD_META (34) `faction name`, and the player FACTION (37) record's header name. Platoon **filenames are deliberately not renamed** (see below) |
| POST | `/api/saves/:name/platoons/:file/characters` | Add a squad member. `{ name, raceSid, archetype, sub, tier? }`. Writes two files — the `.platoon` and `quick.save` — in one staged edit. See `services/characterFactory.js` |
| POST | `/api/saves/:name/equip` | **Bulk equip.** `{ targets: [{file, sid}], loadoutId?, items?, skipIfSlotFilled? }` — every target gets every item in ONE staged edit, across however many platoon files the targets span (`loadoutId` and `items` concatenate). Kind-vs-slot incompatibility is a hard refusal; **race fit never blocks**, it is reported per character via `services/fitCheck.js`. See `saveService.equipMany()` |
| POST | `/api/saves/:name/platoons/:file/characters/:sid/train` | "Train as archetype": one staged edit setting all 4 attributes to 45, archetype skills to random 45–95, everything else to random 15–40; `{ archetype, sub, mode? }` (`mode: 'raise'` default never lowers an existing stat, `'set'` overwrites) |
| PUT | `/api/saves/:name/platoons/:file/characters/:sid/medical/parts/:n` | Heal a body part: set `flesh<n>` (or `"full"`), zero `bandage<n>`/`stun<n>` by default; `{ flesh, bandage?, stun? }` |
| PUT | `/api/saves/:name/platoons/:file/characters/:sid/medical/parts/:n/damage` | Limb loss (destructive, no lower clamp on `flesh`); same body shape as heal, UI must confirm before calling |
| PUT | `/api/saves/:name/platoons/:file/characters/:sid/medical/hunger` | Set `hung` (0-3) and/or `fed` (0-10) independently; `{ hung?, fed? }` |
| POST | `/api/saves/:name/platoons/:file/characters/:sid/revive` | Clear dead/coma/incapacitated/unconscious + zero KO, and raise any flesh below `minFleshPercent`% of the character's own max — one combined write |
| POST | `/api/saves/:name/platoons/:file/characters/:sid/medical/restore-limbs` | Delete `ints.limbs` if present (no bitmask interpretation); no-op is rejected by the mutation gate |
| PUT | `/api/saves/:name/platoons/:file/characters/:sid/inventory/:itemSid/section` | Move an item into a slot (`strings.section` on type 42); `{ section }`. If the target slot is already occupied by another of this character's items, that item's `section` is flipped back to `main` in the same write. Rejects a slot not in the documented list, an item that isn't in this character's own inventory, or a slot incompatible with the item's kind (see `services/itemSlots.js`) — the latter check is skipped (permissive) when the item's kind can't be resolved via `gamedataService`. |
| PUT | `/api/saves/:name/platoons/:file/characters/:sid/inventory/:itemSid/quality` | Set `ints.level` and/or `floats.quality` on an item, independently; `{ level?, quality? }`. Both keys must already exist on the record. Thin wrapper over `updateItem()`. |
| PUT | `/api/saves/:name/platoons/:file/characters/:sid/inventory/:itemSid` | **Unified per-item edit** — `{ section?, level?, quality?, quantity?, materialSid? }`, any combination, in ONE staged edit (one gate pass, one backup). This is what the Gear row's single "Apply" calls; the two narrower routes above are wrappers over the same `saveService.updateItem()`. `quantity > 1` is rejected unless the template is stackable. Weapon grade is chosen with `gradeId` and writes `material sid`/`company sid` in lockstep — the **pair** is the grade, `level` is a separate field. Bare `materialSid` still works but is ambiguous (see `/api/gamedata/weapon-grades`) and resolves to the lowest-ranked matching row. |
| POST | `/api/saves/:name/platoons/:file/characters/:sid/inventory` | Add a new item to a character's inventory; mints a type-42 ITEM record and an INVENTORY (41) instance via `services/kenshi/ids.js`. `{ templateSid, section, quantity?, level?, materialSid?, companySid? }`. `templateSid` must resolve to a gamedata item template (typecode 2/3/4); `section` is validated via `itemSlots.allowedSections()`; `quantity > 1` is rejected unless the template is stackable. Displaces a prior occupant of an already-occupied single-occupancy `section` back to `main`, same rule as the `/section` route above. See `services/itemFactory.js` for the minted record's exact shape. |
| GET | `/api/backups` | List backups |
| POST | `/api/backups` | Create a labelled backup |
| POST | `/api/backups/:id/restore` | Restore a save directory from a backup |
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
