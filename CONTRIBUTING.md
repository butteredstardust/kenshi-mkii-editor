# Contributing to Kenshi MKII Editor

Thanks for contributing. This project can overwrite live game saves, so every
change must preserve the evidence-based format model and the guarded write path.

## Before you start

- Search existing issues and read `AGENTS.md`.
- Read `docs/save-format.md` for codec or model changes and
  `docs/ui-style-guide.md` for UI changes.
- Use [SECURITY.md](SECURITY.md) for vulnerabilities instead of a public issue.
- Do not commit saves, backups, personal paths, cached game indexes, proprietary
  game data, or other users' information.

## Set up

The application lives in `webapp/` and requires Node.js 22 or newer.

```bash
cd webapp
npm install
npm start
```

See `INSTALL_GUIDE.md` for Windows setup and game-path discovery. Keep the app
bound to loopback and close Kenshi before any save mutation.

## Make a change

1. Fork the repository and create a focused branch from `main`.
2. Preserve byte order, latin1 strings, unknown bytes, map key order, per-file
   identifiers, and every invariant documented in `AGENTS.md`.
3. Base new format behavior on measured evidence. Do not guess type codes,
   fields, defaults, or relationships.
4. Route all user-facing writes through `mutationService`; do not bypass the
   game-running check, backup, staging, round-trip verification, hashing, or
   rollback.
5. Add tests for new parsing or mutation behavior and update the relevant docs.

## Validate

Run from `webapp/`:

```bash
npm test
npm run lint
```

The byte-identical round trip is the minimum safety proof. If it fails, stop and
investigate; never loosen the assertion or normalize unexplained bytes. State
the Kenshi version, sample provenance, and checks performed in the pull request
without uploading proprietary or personal data.

## Pull requests

Explain the user-visible change, format evidence, affected files or record
types, safety invariants, test results, and rollback considerations. Keep
unrelated cleanup separate and identify any conclusion based on limited sample
data.

By participating, you agree to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).
