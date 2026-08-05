# Acknowledgements and Notices

The Kenshi MKII Editor bundles game-data derivatives and third-party software.
We are grateful to their authors and communities.

## Game-data attribution (CC BY-SA)

The item catalog shipped with the editor — names, categories, and the stat
tables shown on the Gear and Vendors pages — derives from and incorporates
content from the [Kenshi Wiki on Fandom](https://kenshi.fandom.com/).

> Kenshi Wiki (Fandom) contributors — *CC BY-SA 3.0*

The underlying wiki text is licensed under
[Creative Commons Attribution-ShareAlike 3.0](https://creativecommons.org/licenses/by-sa/3.0/).
Where this project redistributes or derives from that content it is offered
under the same CC BY-SA terms and credits the original wiki as the source. The
provenance is recorded in the data files themselves rather than only here:

- `webapp/data/wiki-items.snapshot.json` — the raw crawl, stamped with
  `sourceUrl: https://kenshi.fandom.com/api.php`, `license: CC BY-SA 3.0`, the
  fetch timestamp and the crawl parameters.
- `webapp/data/items.canonical.json` — the derived catalog that the app reads,
  carrying the same licence and attribution in its `source` block.

Everything else the editor displays — character stats, wounds, inventories,
factions, research state, town and shop contents — is read live out of the
player's own save files and the Kenshi installation on their machine. None of it
is redistributed with this project.

## Format documentation

The binary save/mod format described in `docs/save-format.md` was derived by
reverse-engineering the player's own Kenshi 1.0.65 save files, with
`tools/py-reference/` written as an independent second implementation used to
cross-check the JavaScript codec. It incorporates no third-party specification
or code.

## Application license

The Kenshi MKII Editor source code is licensed under the
[MIT License](webapp/LICENSE).

> Copyright (c) 2026 Kenshi MKII Editor contributors.
>
> The MIT License does **not** grant any rights to the game *Kenshi* or its
> assets, which remain the property of their respective owners.

## Third-party software

### Node.js

- Runtime: Node.js 22 or newer; license: MIT; copyright: Node.js contributors.
- <https://github.com/nodejs/node/blob/main/LICENSE>
- The Windows installer bundles `node.exe` from the build machine so the editor
  runs without a separate Node.js installation. Node.js includes bundled
  dependencies such as libuv, V8, zlib and ICU under their own licenses; see the
  Node.js LICENSE file for the complete list.

### Express

- Package: `express` (`^4.21.2`); license: MIT; copyright: Express.js Foundation
  and other contributors.
- <https://github.com/expressjs/express>
- Express is this project's only runtime dependency. It pulls in a tree of
  MIT-licensed sub-packages (body-parser, qs, send, finalhandler, mime-types and
  others); their license files are installed under
  `webapp/node_modules/*/LICENSE` and ship inside the installer.

### Inno Setup (build-time only)

- Used by `releases/build.ps1` to compile the Windows installer; license: Inno
  Setup License (modified BSD-style); copyright: (c) 1997–2026 Jordan Russell,
  portions (c) Martijn Laan.
- <https://jrsoftware.org/isinfo.php>
- Inno Setup is not part of the distributed application beyond the setup
  program's own installer engine.

### Application icon

The `K` mark in `icons/` and in the browser tab is generated from a few lines of
geometry by `webapp/scripts/make-icon.js`. It contains no third-party artwork
and depends on no image library.

## Trademarks and disclaimer

“Kenshi”, Lo-Fi Games, and related names, logos and assets are trademarks or
copyrights of their respective owners. They are used here only for informational
and interoperability purposes and remain their owners' property.

The Kenshi MKII Editor is **unofficial** and **not affiliated with or endorsed by
Lo-Fi Games Ltd**. It is provided for personal save-backup and editing
convenience, without warranty and without a promise of compatibility with future
game versions. Editing a save can break it; the editor backs up before every
write and rolls back on failure, but the player remains responsible for their
own save data and for complying with the game's EULA and any applicable platform
terms.
