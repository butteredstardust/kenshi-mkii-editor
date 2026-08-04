# Kenshi MKII Editor

A local save editor for [Kenshi](https://store.steampowered.com/app/233860/Kenshi/).
Reads a save directory, shows your squad — stats, wounds, inventory, world state
— and edits it through a gated write path that backs up first and rolls back on
any failure.

Runs entirely on your machine, bound to loopback. No accounts, no telemetry, one
runtime dependency.

## Requirements

- Node.js 22+
- Kenshi installed (the editor reads `gamedata.base` and your workshop mods to
  turn internal ids into readable names)

## Run

```bash
cd webapp
npm install
npm start
```

Then open <http://127.0.0.1:3080>. Or double-click `webapp\start.bat`.

To stop it, close the console window, or run `webapp\stop.bat` (pass a port as
the first argument if you started it on a non-default one). It only kills
whatever is listening on that port, never every `node.exe` on the machine.

**Close Kenshi before editing.** The game holds the world in memory and rewrites
the save directory on save, so an edit applied while it is running is discarded
at best. The editor refuses to write while `kenshi_x64.exe` is up.

Console report without the browser:

```bash
node webapp/scripts/status.js          # newest save
node webapp/scripts/status.js save1    # a named save
```

## What it does today

- Auto-detects saves (`%LOCALAPPDATA%\kenshi\save\`), the Kenshi install and the
  workshop mod folder
- Per-character view: attributes, trained skills, per-body-part wounds,
  consciousness/coma/bleeding/hunger, resolved inventory with materials
- World view: faction, region, in-game clock, cats, position
- Name resolution across ~62,000 stringIDs from base data plus every installed
  mod
- Whole-directory backups with hash manifests, restore and delete
- One reference mutation (player cats) exercising the full write pipeline

## Safety

- A save is a **directory**; backups and restores cover all of it
- Every write: automatic backup → staged copy → edit → re-parse → hash diff →
  re-check preconditions → install only changed files → receipt
- Any failure after the backup exists triggers an automatic restore
- Bytes are only written after the codec proves it can round-trip the file
  byte-identically (`npm test` asserts this against your live save and against
  `gamedata.base`, `rebirth.mod`, `Newwworld.mod` and `Dialogue.mod`)

## Docs

- [`AGENTS.md`](AGENTS.md) — architecture, safety model, conventions, API
- [`docs/save-format.md`](docs/save-format.md) — the binary format and how it
  was reverse-engineered
- [`tools/py-reference/`](tools/py-reference/) — the independent Python
  implementation used to derive and cross-check the format

## Status

Early. The read path and the write pipeline are done and verified; the set of
available edits is deliberately small so far. See the open questions at the end
of `docs/save-format.md`.
