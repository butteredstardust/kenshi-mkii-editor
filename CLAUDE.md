# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Start here

**`AGENTS.md` is the canonical agent ruleset for this repo** — architecture, the
mutation/safety model, format rules, conventions and the full API surface. Read
it first; it applies to every coding agent working here, so keep it
agent-agnostic if you edit it.

Other canonical docs:

- **`docs/save-format.md`** — the byte-level Kenshi save/mod format, how
  stringIDs resolve to names, how the format was derived, and what is still
  unknown. Read this before touching `services/kenshi/`.
- **`docs/ui-style-guide.md`** — the design system and the rules for adding UI.
  Read it before touching anything in `webapp/public/`.
- **`README.md`** — what the project is and how to run it.
- **`INSTALL_GUIDE.md`** — installing from the installer or from source, the
  paths and env vars, troubleshooting, and how `releases/build.ps1` packages the
  app. Read it before touching `releases/` or `webapp/bin/`.
- **`ACKNOWLEDGEMENTS.md`** — game-data attribution and third-party licences.
  Add an entry here when you add a dependency or ship derived game data.
- **`CHANGELOG.md`** — user-facing history. Add to `## [Unreleased]` when a
  change is something a user would notice.

There is no root `package.json`; every `npm`/`node` command runs from `webapp/`.

## Claude-specific notes

- **Never write to a save without the round trip passing.** `npm test` in
  `webapp/` reads the live save and rewrites it in memory, asserting SHA-256
  equality. If it fails, the codec no longer understands the format and any
  write is corruption. Do not skip, weaken or `t.skip()` your way past it.
- **Do not edit the user's live save to try something out.** Copy a save
  directory to a scratch location and work there. Every real edit creates an
  automatic backup, but a scratch copy is cheaper than a restore.
- **`tools/py-reference/` is reference, not runtime.** Those scripts are the
  independent second implementation used to derive the format. Use them to
  cross-check a suspicious result (`python tools/py-reference/report.py <saveDir>`
  vs `node webapp/scripts/status.js`), never to add features.
- **Latin1, not UTF-8.** If you find yourself writing `'utf8'` anywhere near the
  codec, re-read `docs/save-format.md` §2 first.
- When adding a mutation, model it on `saveService.setPlayerMoney()`: compute
  bytes, return them, and let `mutationService` install them.
