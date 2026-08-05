# Changelog

All notable changes to the Kenshi MKII Editor are recorded here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Because this app writes to save files, one rule sits above the changelog: no
release ships unless `npm test` — the byte-identical codec round trip — passes.

## [Unreleased]

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
