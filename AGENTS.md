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
| `services/pathService.js` | Locates saves, install dir, workshop dir, backup root |
| `services/gamedataService.js` | `stringID → name` index across all data files, disk-cached |
| `services/saveService.js` | Domain model: world summary, squads, characters, items |
| `services/itemSlots.js` | Item/slot compatibility rules for `setItemSection()` and the Gear UI's `allowedSections` |
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
| GET | `/api/gamedata/items` | Item-template picker feed: `?q=` name substring, `?limit=` (default 50, cap 500). Rows carry `sid`, `name`, `type`, `kind`, `stackable`, `allowedSections`/`slotsWidened` (from `services/itemSlots.js`) and catalog `category`/`description` (null on a miss). Filtered to template typecodes **2/3/4** — type 42 is the save-side item *instance*, not a template. |
| GET | `/api/gamedata/weapon-grades` | The weapon grade ladder (`{ companySid, companyName, modelSid, modelName, rank }[]`, rank-ascending). A weapon's grade is the (company sid, material sid) pair, not `ints.level` — pass the chosen `modelSid` as `addItem`'s `materialSid`. |
| GET | `/api/saves` | List save directories, newest first |
| GET | `/api/saves/:name/status` | World summary + squads + characters + inventories |
| PUT | `/api/saves/:name/money` | Set player cats (goes through the mutation gate) |
| PUT | `/api/saves/:name/platoons/:file/characters/:sid/stats` | Set one or more attributes/skills on a character's STATS record (bulk, one staged edit; `{ stats: { statKey: value } }`) |
| GET | `/api/archetypes` | "Train as archetype" catalogue (id/label tree of mains and subs), for the UI dropdowns |
| POST | `/api/saves/:name/platoons/:file/characters/:sid/train` | "Train as archetype": one staged edit setting all 4 attributes to 45, archetype skills to random 45–95, everything else to random 15–40; `{ archetype, sub, mode? }` (`mode: 'raise'` default never lowers an existing stat, `'set'` overwrites) |
| PUT | `/api/saves/:name/platoons/:file/characters/:sid/medical/parts/:n` | Heal a body part: set `flesh<n>` (or `"full"`), zero `bandage<n>`/`stun<n>` by default; `{ flesh, bandage?, stun? }` |
| PUT | `/api/saves/:name/platoons/:file/characters/:sid/medical/parts/:n/damage` | Limb loss (destructive, no lower clamp on `flesh`); same body shape as heal, UI must confirm before calling |
| PUT | `/api/saves/:name/platoons/:file/characters/:sid/medical/hunger` | Set `hung` (0-3) and/or `fed` (0-10) independently; `{ hung?, fed? }` |
| POST | `/api/saves/:name/platoons/:file/characters/:sid/revive` | Clear dead/coma/incapacitated/unconscious + zero KO, and raise any flesh below `minFleshPercent`% of the character's own max — one combined write |
| POST | `/api/saves/:name/platoons/:file/characters/:sid/medical/restore-limbs` | Delete `ints.limbs` if present (no bitmask interpretation); no-op is rejected by the mutation gate |
| PUT | `/api/saves/:name/platoons/:file/characters/:sid/inventory/:itemSid/section` | Move an item into a slot (`strings.section` on type 42); `{ section }`. If the target slot is already occupied by another of this character's items, that item's `section` is flipped back to `main` in the same write. Rejects a slot not in the documented list, an item that isn't in this character's own inventory, or a slot incompatible with the item's kind (see `services/itemSlots.js`) — the latter check is skipped (permissive) when the item's kind can't be resolved via `gamedataService`. |
| PUT | `/api/saves/:name/platoons/:file/characters/:sid/inventory/:itemSid/quality` | Set `ints.level` and/or `floats.quality` on an item, independently; `{ level?, quality? }`. Both keys must already exist on the record. |
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
