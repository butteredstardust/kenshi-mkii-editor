# Roadmap

Ordered roughly by dependency, not by appeal. Everything below assumes the rule
from `AGENTS.md`: a write path ships only once its file round-trips
byte-identically and its edit goes through `mutationService`.

## Done

- Binary codec for filetypes 15/16/17, verified by byte-identical round trip
  against the live save and all four base data files
- stringID → name index across base data and every installed mod (~62k ids)
- Read model: world summary, squads, characters, stats, medical, inventory
- Whole-directory backups with hash manifests; restore and delete
- Mutation gate: game-running check, staging, re-parse verification, hash diff,
  stale-precondition abort, automatic rollback
- Webapp shell (Squad / World / Backups) and a console report
- Phase 0 field/id investigation (`TODO.md`): on-disk key names confirmed
  against a live save for bounty, medical, item, faction and appearance
  records (race lives in the `extra` section, not `ints`/`strings`), and record
  ids established as per-file and re-minted by the game on every save

## Next

1. **Read-only breadth first.** Squad-level view for non-player factions,
   town states (type 94), faction relations (type 37) with resolved names. All
   of it is already parsed — it just needs surfacing. Cheap, and it grows
   confidence in the typecode map before anything writes.
2. **Character edits.** Stats and attributes are plain floats in the type-25
   record, which makes them the natural second mutation after money. Needs a
   sane clamp (Kenshi skills cap at 100) and a per-field receipt.
3. **Medical edits.** Heal a character: set `flesh<n>` per part, clear `KO`,
   `coma`, `unconcious`, `bleeding`. Careful — `hit<n>` is not a trustworthy
   maximum (see `docs/save-format.md` §5), so "full health" needs a defensible
   definition rather than copying `hit<n>` into `flesh<n>`.
4. **Inventory edits.** Quantity changes are safe (one int in a type-42 record).
   *Adding* an item is the first operation that mints a new record, which drags
   in `nextId` handling and the `instanceCount`/instances-section duplication —
   treat it as a separate, larger piece of work.
5. **Item catalog.** The name index already holds every item definition in the
   installed data; grouping by typecode gives an "add item" picker for free.

## Later / unresolved

- **Zone files.** `zone/*.zone` parses with the same codec but the record
  semantics (player buildings, dropped items, interiors) are unmapped.
- **`nextId` semantics.** Confirm whether the counter must be bumped when adding
  records, and whether platoon files carry their own.
- **Multi-file edits.** Moving a character between squads touches two platoon
  files and `quick.save`. `mutationService` already accepts an array of file
  writes; nothing exercises it yet.
- **Mod-file writing.** The codec round-trips `.mod` files, so a future FCS-lite
  is possible. Out of scope until the save side is solid.
- **A diff view.** Two saves, or a save and its backup, compared record by
  record — the fastest way to learn what a game action actually changes, and
  the tool that would answer most of the open questions above.
