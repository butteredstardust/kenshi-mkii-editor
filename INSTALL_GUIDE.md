# Installation Guide — Kenshi MKII Editor

Two ways to install. Pick one:

- **[A. Windows installer](#a-windows-installer)** — double-click, no Node.js
  needed. This is what you want if you just want to edit a save.
- **[B. From source](#b-from-source)** — clone and `npm install`. This is what
  you want if you intend to change the code or run the test suite.

Section **[C. Building the installer](#c-building-the-installer)** covers
producing the setup `.exe` from a source checkout.

---

## What this app is

A local save editor for [Kenshi](https://store.steampowered.com/app/233860/Kenshi/).
It runs as a small web server on your own machine, bound to `127.0.0.1`, and you
drive it from a browser tab. Nothing is uploaded, there are no accounts, and no
telemetry. Read [`ACKNOWLEDGEMENTS.md`](ACKNOWLEDGEMENTS.md) for licensing and
the "this is unofficial" disclaimer.

**Close Kenshi before editing.** The game holds the world in memory and rewrites
the save directory when it saves, so an edit applied while it is running is
discarded at best. The editor refuses to write while `kenshi_x64.exe` is
running, but the safest habit is to quit the game first.

---

## Prerequisites

| | Installer | From source |
|---|---|---|
| Windows 10/11, 64-bit | required | required |
| Kenshi, installed | required | required |
| Node.js 22+ | not needed (bundled) | required |
| Git | not needed | required |
| Administrator rights | not needed | not needed |

The editor needs the Kenshi **installation** as well as your saves: it reads
`gamedata.base`, the other base `.mod` files and your Steam Workshop mods to turn
internal string IDs into readable names. It opens those files read-only.

Nothing needs an internet connection at any point.

---

## A. Windows installer

### A1. Run the setup

Run `kenshi-mkii-editor-<version>.exe`.

It is a **per-user** install: it writes to
`%LOCALAPPDATA%\Programs\KenshiMKIIEditor`, asks for no elevation, and touches
no system directories or registry keys beyond its own uninstall entry. The
wizard shows the licence and the acknowledgements before installing, and offers
a desktop shortcut.

SmartScreen will likely warn that the publisher is unrecognised — the installer
is not code-signed. *More info → Run anyway*, or check the file's SHA-256 against
the release listing first if you prefer.

### A2. Launch

Use the Start menu or desktop shortcut. The shortcut runs `bin\launch.vbs`,
which:

1. starts the bundled `node.exe` running `server.js`, detached and with **no
   console window**;
2. waits for `http://127.0.0.1:3080/api/health` to answer with this app's id and
   version;
3. opens your default browser at `http://127.0.0.1:3080`.

Only one copy can run at a time. A PID lockfile at
`%LOCALAPPDATA%\KenshiMKIIEditor\kenshi-mkii-editor.lock` plus the identity check
on `/api/health` mean a second launch reopens the existing instance's tab instead
of starting a competing server over the same save directory. If something else
already owns port 3080, the launcher says so and refuses to start rather than
failing silently.

### A3. Verify

In the browser tab, the header line under the title should show your save root,
your Kenshi install directory and the number of saves found. If it does, the
editor found everything it needs.

### A4. Stop it

Closing the browser tab does **not** stop the server — it has no console window
to close either. Either:

- run the Start-menu *Uninstall* entry (which stops it first), or
- stop it explicitly:

  ```
  "%LOCALAPPDATA%\Programs\KenshiMKIIEditor\bin\node.exe" "%LOCALAPPDATA%\Programs\KenshiMKIIEditor\bin\launcher.js" --stop
  ```

  `--stop` verifies the locked PID really is this installation's
  `bin\node.exe server.js` before killing anything, so it can never take down an
  unrelated Node process.

Leaving it running is harmless: it is idle, listens only on loopback, and never
writes without an explicit action in the UI.

### A5. Uninstall

*Settings → Apps → Kenshi MKII Editor → Uninstall*, or the Start-menu entry.
Uninstall stops the running server first, then removes the program directory
including the generated name-index cache and the lockfile.

**Your saves and your backups are not touched.** Backups live in
`%LOCALAPPDATA%\kenshi\save-backups\` and survive uninstall; delete that folder
yourself if you want the disk space back.

---

## B. From source

### B1. Install Node.js 22+

<https://nodejs.org/> — the LTS installer. Verify:

```
node --version
```

### B2. Clone and install

```
git clone <repository-url> "Kenshi MKII Editor"
cd "Kenshi MKII Editor\webapp"
npm install
```

There is no root `package.json`. **Every `npm`/`node` command in this project
runs from `webapp/`.**

Express is the only runtime dependency; there is no build step, no bundler and
no transpiler.

### B3. Start

```
npm start
```

Then open <http://127.0.0.1:3080>. Or double-click `webapp\start.bat`, which
installs dependencies if needed, opens the browser and leaves the server in a
console window.

To stop it, close that console window or run `webapp\stop.bat`. `stop.bat` kills
only what is listening on the port (pass a different port as its first argument
if you changed it) — never every `node.exe` on the machine.

### B4. Verify the install

Console report, no browser needed:

```
node scripts/status.js            # newest save
node scripts/status.js save1      # a named save
```

It should print your squad, their stats and wounds, and the world state. If the
save root or install directory comes up empty, see
[Troubleshooting](#troubleshooting).

Name resolution is cached at `webapp/.cache/nameindex.json` (~62,000 string IDs).
It builds itself on first use; rebuild it after installing, removing or updating
mods:

```
npm run gamedata:rebuild
```

### B5. Run the test suite

```
npm test
```

The important test is the codec round trip: it reads your real save files and
`gamedata.base`, rewrites them in memory and asserts SHA-256 equality. It is
read-only against your save, and it is the canary for format drift after a
Kenshi update. **If it fails, do not write anything** — the codec no longer
understands the format.

Tests that need save *contents* (rather than just bytes) read a snapshot in
`webapp/.fixtures/`, never your live save. Without one they skip with an
instruction to create it:

```
npm run fixture:create             # newest save, full copy (~39 MB)
npm run fixture:create autosave1   # a named save
node scripts/make-fixture.js --slim  # drops zone/, faster loop
```

### B6. Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `KENSHI_MKII_PORT` | `3080` | Port for the loopback server. |
| `LOCALAPPDATA` | Windows-provided | Root for save and backup discovery. |

That is the whole list. Paths are auto-detected (see below) rather than
configured.

---

## Paths the editor uses

| What | Where |
|---|---|
| Saves | `%LOCALAPPDATA%\kenshi\save\<name>\` |
| Backups | `%LOCALAPPDATA%\kenshi\save-backups\<id>\` |
| Kenshi install | Steam/GOG library, auto-detected |
| Base game data | `<Kenshi>\data\gamedata.base` and the base `.mod` files |
| Workshop mods | `<steamapps>\workshop\content\233860\` |
| Name-index cache | `webapp\.cache\nameindex.json` (generated) |

`services/pathService.js` probes the usual Steam and GOG locations. The
constants in that file are fallbacks, not assumptions baked into the rest of the
app — an install found anywhere else works the same way.

---

## Troubleshooting

**"No saves found" / empty save root.**
The editor looks in `%LOCALAPPDATA%\kenshi\save\`. The `save\` folder *inside*
the game directory is a legacy location that modern installs leave as empty
skeletons — having saves there is not the same as having saves. Confirm the
folder exists and contains a directory per save.

**Install directory not detected.**
Auto-detection covers the common Steam library paths and the default GOG
location. A library on another drive may not be found; the status line in the
UI (and `node scripts/status.js`) tells you what was resolved.

**Names show as raw string IDs.**
The name index has not been built, or is stale after a mod change. Run
`npm run gamedata:rebuild` from `webapp/`, or delete
`webapp\.cache\nameindex.json` and reload.

**Port 3080 already in use.**
From source: `set KENSHI_MKII_PORT=3081 && npm start`. Installed: stop whatever
holds the port — the launcher deliberately refuses to start a second server over
the same saves.

**The editor refuses to write.**
It will not write while `kenshi_x64.exe` is running. Quit the game and reload
the page.

**`npm test` fails on the round trip after a game update.**
Expected, and it is the point. Treat the header layout, typecodes and field
names as unverified until the format is re-derived; see
[`docs/save-format.md`](docs/save-format.md).

**A write went wrong.**
Every write takes an automatic backup first and rolls back on any failure. The
Backups page lists them with hash manifests and restores whole directories. The
backups also survive uninstall.

---

## C. Building the installer

From a source checkout on Windows:

```
powershell -ExecutionPolicy Bypass -File releases\build.ps1
```

Requirements:

- Node.js 22+ on `PATH` (its `node.exe` is what gets bundled into the installer)
- [Inno Setup 6](https://jrsoftware.org/isdl.php), by default at
  `%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe`

What it does:

1. Stages a **runtime-only** copy of `webapp/` into `releases\build\app`. Tests,
   the save fixture, the name cache, the wiki-scraping build inputs and the
   development scripts are excluded by allowlist, not by filter.
2. Runs `npm ci --omit=dev` in the staged copy.
3. Copies the build machine's `node.exe` into `bin\` and generates
   `icons\app_icon.ico` if it is missing.
4. Runs `releases\audit-package.ps1`, which fails the build if any save or
   game-data artifact, test directory, private settings file or build-machine
   absolute path made it into the payload, or if `LICENSE`,
   `ACKNOWLEDGEMENTS.md` or the launcher are missing.
5. Generates `releases\kenshi-mkii-editor.iss` and compiles
   `releases\kenshi-mkii-editor-<version>.exe`.

Useful switches:

```
releases\build.ps1 -SkipCompile                 # stage and audit only
releases\build.ps1 -Version 0.2.0               # override package.json
releases\build.ps1 -IsccPath "D:\...\ISCC.exe"  # non-default Inno Setup
```

The version comes from `webapp/package.json` unless `-Version` says otherwise.
`kenshi-mkii-editor.iss` is generated output — edit `build.ps1`, not the `.iss`.

---

## Next steps

- [`README.md`](README.md) — what the editor does today
- [`AGENTS.md`](AGENTS.md) — architecture, the mutation/safety model, the API
- [`docs/save-format.md`](docs/save-format.md) — the byte-level format
- [`docs/ui-style-guide.md`](docs/ui-style-guide.md) — the design system
- [`CHANGELOG.md`](CHANGELOG.md) — what changed between versions
