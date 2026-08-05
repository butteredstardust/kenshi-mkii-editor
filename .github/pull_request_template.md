## What this changes

<!-- One or two sentences. Link the issue if there is one. -->

## Checklist

- [ ] `npm test` passes **on a machine with a real Kenshi save and a fixture**
      (`npm run fixture:create`). CI cannot run the byte-identical round trip —
      it has no game data, so nearly the whole suite skips there. A green tick
      on CI is not this check.
- [ ] If this touches `services/kenshi/`: `docs/save-format.md` still describes
      the format accurately, and no `'utf8'` went anywhere near the codec.
- [ ] If this adds a mutation: it computes bytes and returns them, and
      `mutationService` installs them (see `saveService.setPlayerMoney()`).
      It has a test that runs against a scratch copy, never the live save.
- [ ] If this touches `webapp/public/`: it follows `docs/ui-style-guide.md` and
      uses existing components rather than new per-feature classes.
- [ ] If a user would notice this change, it is in `CHANGELOG.md` under
      `## [Unreleased]`.
- [ ] If this adds a dependency or ships derived game data, it is in
      `ACKNOWLEDGEMENTS.md`.

## Save safety

<!--
If this can write to a save, say what you tested it against and how you
confirmed the result. If it cannot, say "read-only".
-->
