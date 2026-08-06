# Changelog

All notable changes to the Kenshi MKII Editor are recorded here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Because this app writes to save files, one rule sits above the changelog: no
release ships unless `npm test` — the byte-identical codec round trip — passes.

## [Unreleased]

### Added

- **Recruits and Loadouts tabs.** Two new pages for inspecting the catalogues
  the editor has always used but never shown. Recruits lists all 144 entries
  under their 11 group headings, each expanding to the skills their archetype
  trains, the numbers their tier will actually write, where the character is
  found (and, separately and honestly, the towns this install's data cannot
  place), and the gear set that *is* that character. Loadouts lists all 148
  kits under their 11 categories, each expanding to its items with slot,
  quantity, armour level and weapon grade resolved to names, plus the racial
  restrictions on each piece. Both are search-and-filter, read-only, and
  save-independent — nothing on the Recruits page reads or writes a save at
  all.
- **The catalogues doubled.** 75 recruits in 10 groups became 144 in 11 (the
  new `hunter` group split the melee scouts and bounty hunters out of
  `ranger`, which had become two-thirds katana users under a heading people
  pick for crossbows), and 66 loadouts became 148, every one now filed under
  one of 11 ordered categories.

- **Recruit provisioning.** Adding a new squad member now equips them in the
  SAME staged edit as the character itself — armour, weapon(s), a medical kit
  (a robotics repair kit rather than bandages for a Skeleton, which does not
  eat and gets no food), a couple of food items, and a random 300-5000 cats.
  The gear set is auto-picked from the recruit's archetype/sub/tier
  (`services/provisioning.js`'s `defaultLoadoutFor()`), a
  `services/recruits.js` entry's own `loadoutId` always wins where one exists,
  and the caller can still name a different loadout, pass explicit items, or
  turn provisioning off entirely (`provision: false` reproduces the old
  behaviour exactly). Armour always mints at Specialist (level 80) and a
  melee weapon always at Catun No.3 (the real `Catun Scrapmaster` manufacturer
  row, not the player-crafted "Homemade" variant of the same model) —
  overriding whatever grade the chosen loadout template carried, since a
  recruit's gear quality is a separate decision from which pieces they get.
  `POST /api/saves/:name/platoons/:file/characters` takes `provision?`/
  `loadoutId?`/`items?`; `GET /api/provisioning/preview` shows what a given
  shape would produce without writing anything.
- **Bounties, on the Squad tab** (TODO.md 3.6). A "wanted" badge and a
  Bounties section appear on a character carrying one, showing who wants
  them, the amount (editable), and expiry/claimed/crimes as reference-only
  text. This can only ever reduce or clear a bounty, never add one — the
  save has no bounty keys at all on a character who isn't wanted, and this
  editor never invents a key that isn't already on the record. Reducing an
  amount to a small positive value (never 0, which the guide warns against)
  is the documented safe way to let a bounty expire on its own.
- **Armour colour, uniform faction tag and stolen flags** on the Gear row
  (TODO.md 3.1/3.2/3.3). A colour `<select>` (with a swatch) and a uniform
  faction `<select>` join the row's "More" panel — the uniform control only
  appears on items whose record shape actually carries the field, since a
  large share of items (backpacks, maps, trade goods) never do. A "stolen"
  badge appears on flagged items, with a checkbox to clear the ownership
  flags. All three join the row's existing single "Apply".
- **29 Meitou-wielder loadouts.** One per named character the game hands a
  Meitou-grade weapon — General Hat-12, Mad Cat-Lon, Esata, Emperor Tengu, the
  Crab Queen, Bugmaster, Eyegore and the rest — grouped by weapon class. Their
  gear is not invented: every piece was read off that character's own type-1
  CHARACTER template in your installed data, resolved in load order.
- The same 29 characters as ready-made recruits, each linked to their loadout,
  with race and power tier taken from their template's `race` and
  `combat stats`.
- **Hackers**, the cleaver weapon class, as a trainable soldier sub-archetype.
- **Search boxes on long dropdowns.** Any list of more than five options gets a
  filter above it — grades, loadouts, recruits, factions, towns, races. Typing
  narrows the list, multiple words all have to match, and Enter picks the answer
  when only one is left. The dropdown itself is unchanged, so keyboard and
  screen-reader behaviour is the browser's own.
- Grouped headings on the weapon-grade, faction and unequip-item dropdowns
  (grades band by their ladder rank, factions by whether you have met them,
  worn items by slot).

### Changed

- **Bulk equip moved from the Gear tab to the Loadouts tab.** Choosing a kit
  and applying it to several characters is now one page instead of two: the
  kit's contents are named and browsed immediately above the panel that applies
  them. Gear is single-character again. Nothing about the write changed — still
  one staged edit and one backup however many characters and items are
  involved.
- The bulk-equip loadout dropdown now groups the 148 kits by the same 11
  categories the page itself is grouped by. It previously grouped by the
  leading tag, which worked at 66 kits but had grown to 52 of them under
  "Light armour" and 8 under "Other".
- The Add member panel no longer says a recruit "arrives carrying nothing" —
  it shows what they will actually arrive with, before the write, and offers a
  gear override (or "Nothing", which reproduces the old behaviour).
- **Weapons are chosen by grade, not by level.** The "Weapon Level" number
  input is gone from the Gear pages: picking a grade ("Meitou", "Edge Type 5")
  now sets the weapon's level to that grade's own ladder rank, server-side. The
  raw field is still editable under a row's "More", where an explicit value
  still wins. Armour is untouched — its tier ladder was always the named control.
- Fixed: the researcher sub-archetype trained the `hackers` skill, which is
  Kenshi's cleaver weapon class rather than anything to do with research. It now
  trains `engineer`, and `hackers` is grouped with the combat skills.
- Fixed: Savant was catalogued as a heavy-weapons user (he wields a nodachi —
  katanas), and Valamon and Longen as blunt and crossbows respectively (both
  wield what this install calls a Flat Topper — sabres). All three now follow
  the weapon's own `skill category`.

## [0.2.0] — 2026-08-05

### Added

- Packaging: `releases/build.ps1` stages a runtime-only copy of `webapp/`,
  bundles `node.exe` and compiles a per-user offline Windows installer with Inno
  Setup. `releases/audit-package.ps1` fails the build if save data, game data,
  tests or build-machine paths reach the payload.
- Installed launcher (`webapp/bin/launch.vbs` + `launcher.js`): starts the server
  with no console window, waits on `/api/health`, opens the browser, and holds a
  PID lock so two instances can never share one save directory. `--stop` refuses
  to kill any process that is not this installation's server.
- `GET /api/health` now reports `appId` and `appVersion` so the launcher can tell
  its own server from anything else on the port.
- `webapp/scripts/make-icon.js` generates `icons/app_icon.ico` and
  `icons/icon_256.png` from the same mark as the browser tab, with no image
  library.
- Documentation: `INSTALL_GUIDE.md`, `ACKNOWLEDGEMENTS.md`, `CHANGELOG.md` and
  `webapp/LICENSE` (MIT).
- Attribution footer in the app itself: the unofficial notice and the CC BY-SA
  credit for the item data were previously only in the installer.
- GitHub Actions: CI on every push and pull request (syntax sweep, tests, a
  server boot that asserts the loopback and CSRF guards, and an installer
  build), and a manually dispatched release workflow that builds, checksums and
  publishes the installer. CI runs without a Kenshi install, so it cannot
  execute the round trip — the release workflow refuses to run unless the
  round trip has been confirmed locally.

### Changed

- **The Backups page is a list you can actually use.** It shows one save's
  backups (every save is a checkbox away) and the newest 25 of them, with the
  time in your own clock — "Today 16:31" rather than
  `2026-08-05T13:31:43.519Z` — and without the id column, which was the widest
  in the table and only ever repeated the save name and that same timestamp.
  Editor-taken backups are no longer prefixed `auto:` on every row; the manual
  ones carry a badge instead.
- **The World page reads as English.** It was the save model's own field names
  put through a table's uppercase — `GAMEVERSION`, `CAMERAPOS`, and the clock
  spread over three rows of one number each. The keys are named and the clock,
  the roster and the money are one row each. Fields the mapping doesn't know
  still render, so a save gaining one can't make it invisible.
- Counts agree with their nouns: `1 item`, `2 items`, never `2 item(s)`. This
  reaches the backup labels too, which are stored on disk and are all the
  Backups page has to describe what a backup was taken before.
- A faction row no longer repeats its relation as both a number beside the
  standing badge and the value in the input two cells along, and the preset
  dropdown on all 113 rows says "Set…" rather than "…".

### Fixed

- **`GET /api/backups` was a 1.5 MB response.** It served every backup's full
  manifest, including one SHA-256 per file of a whole save directory — 447 of
  them per backup — to draw a table with no hash column. It now returns
  summaries and a file count: the same 37 backups are 8.5 KB, 183× smaller. The
  hashes stay on disk, where `restore()` still verifies against them.
- **Search boxes were 148px wide.** `.field--grow` set `display: flex` but no
  grow factor, so the field stayed shrink-to-fit and the input's `width: 100%`
  resolved against it — in a 1159px row. "tech name or what it unlocks" was
  clipped mid-word on the Research page.
- The app is centred. `main` was capped at 1240px but never centred, so on a
  wide monitor the whole editor sat against the left edge; the header, tabs,
  content and footer now share one gutter and line up at every width.
- **Restoring a backup was the one write path with no safety gate.** It could
  run while Kenshi was open — the game rewrites its save directory from memory,
  so the restore was silently discarded the next time the player saved — and it
  could run in the middle of another edit. It is now held to the same two
  preconditions as every other write.
- **Restoring a backup deleted the save before copying the backup in.** Any
  failure in that window — a full disk, an antivirus handle, the process dying
  — destroyed the save with nothing left to fall back on. The backup is now
  staged beside the save and swapped in, so the only moment the save does not
  exist is between two renames, and a failed swap puts the original straight
  back.
- Taking a manual backup while Kenshi is running is refused, rather than
  capturing whatever half-written state the game happens to be in.
- The Backups page ignored two of the UI's hard rules: its controls stayed
  enabled while Kenshi was running, and its failures died in the console instead
  of a receipt — on the one page you visit when something has already gone
  wrong. Deleting a backup now confirms first.
- User-facing errors no longer cite `TODO.md`, an internal document that does
  not ship. "`X` is not stackable" was the one a player would actually hit.

## [0.1.0] — 2026-08-05

First working version: the read path and the write pipeline are complete and
verified. The set of available edits is deliberately small.

### Added

- **Save format codec** for Kenshi's binary save/mod files, derived by
  reverse-engineering a 1.0.65 save and verified by a byte-identical round trip
  against the live save, `gamedata.base`, `rebirth.mod`, `Newwworld.mod` and
  `Dialogue.mod`. Documented in `docs/save-format.md`.
- **Name resolution** across ~62,000 string IDs from base game data plus every
  installed workshop mod, honouring `mods.cfg` load order, cached at
  `webapp/.cache/nameindex.json`.
- **Auto-detection** of the save root, the Kenshi install and the workshop mod
  folder.
- **Squad page**: attributes, trained skills, per-body-part wounds,
  consciousness/coma/bleeding/hunger as vitals, resolved inventory and backpack
  contents with materials, robotic limbs, decoded personality.
- **Gear page**: item catalog with category filters and slot icons, editable
  quantity, bulk equip, fit checks against race and slot, grade handling.
- **Vendors page**: browse shop stock by faction, town and shop.
- **Factions page**: relations with all 114 factions, keyed by their stable
  gamedata string ID rather than by display name.
- **Research page**: what is finished, and unlocking more.
- **World page**: faction, region, in-game clock, cats, position, and teleport to
  towns.
- **Backups page**: whole-directory backups with SHA-256 manifests, restore and
  delete.
- **Recruits and loadouts**: 50 grouped recruits with names drawn from Kenshi's
  own name pools, and 37 loadouts read off the game's own NPCs.
- **Mutation pipeline**: automatic backup → staged copy → edit → re-parse → hash
  diff → re-check preconditions → install only changed files → receipt, with an
  automatic restore on any failure after the backup exists. Writes are refused
  while `kenshi_x64.exe` is running.
- **Console report**: `node webapp/scripts/status.js [saveName]`.
- **Python reference implementation** in `tools/py-reference/` — an independently
  written second parser kept for cross-checking the JavaScript codec.

### Fixed

- Signalling NaN floats now survive the round trip. The game had newly started
  writing them; the codec's canonicalisation was silently rewriting one bit.
- Maps are items too: the vendor page no longer hides rows it could not add.
- Grade-pair handling when equipping items.

### Security

- Server binds to loopback only and rejects any request whose `Host` is not
  `127.0.0.1`/`localhost`; per-session CSRF token required on every mutating
  request; cross-origin mutations rejected; CSP, `nosniff`, `DENY` framing and
  `no-referrer` set on every response.
