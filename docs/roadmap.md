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
- **Phase 1 — squad editing.** Stats and attributes (bulk, one staged edit),
  medical (heal, damage, revive, hunger, restore limbs), rename, personality,
  teleport (squad-scoped, with the map marker), and race change (the APPEARANCE
  `extra['race']` row plus the MEDICAL body plan, `flesh<n>` scaled rather than
  clamped). Faction transfer (1.6) remains investigation-only.
- **Phase 2 — inventory editing.** Equip into a slot with kind-vs-slot
  compatibility enforced (`services/itemSlots.js`), a unified per-item edit, and
  minting a brand-new type-42 ITEM record plus its INVENTORY instance
  (`services/itemFactory.js`, `services/kenshi/ids.js`) — which is what made
  blueprints, backpacks, crossbows, maps and robotic limbs reachable. Plus bulk
  equip / re-grade / unequip across however many platoon files the targets span.
- **Phase 3 — the rest of the FCS parity list**, bar one item: armour colour,
  uniform tag, stolen-flag clearing, weapon grade as the (company, material)
  pair, faction relations, bounty reduction, and player money. Only 3.7
  (hunger rate / research speed) is unshipped, and deliberately — see below.

## Next

1. **Zone files.** `zone/*.zone` parses with the same codec, but the record
   semantics — player buildings, dropped items, interiors — are unmapped. This
   is the largest remaining unread part of a save.
2. **A diff view.** Two saves, or a save and its backup, compared record by
   record. Repeatedly the thing that would have answered an open question
   fastest, and the tool that unblocks 3.7 and the limb bitmask below.
3. **Faction transfer** (`TODO.md` 1.6). The one Phase 1 item still unbuilt:
   moving a character between platoon files, updating squad membership on both
   sides. `mutationService` already takes an array of file writes, and
   `addSquadMember` already exercises the multi-file path, so the primitive is
   proven — what is missing is the design note tracing one real transfer.

## Later / unresolved

- **Hunger rate / research speed** (`TODO.md` 3.7). Narrowed to seven type-56
  floats that are all exactly `1` — and every save on this machine is one
  playthrough at default settings, so the available evidence has zero variance
  in precisely the fields that must vary to be told apart. Needs a save where
  the player moved those sliders, not another sweep. **Do not guess:** a
  byte-perfect write of the wrong field still round-trips.
- **The `limbs` bitmask.** `ints.limbs` on type 57 is confirmed as the key and
  `restoreLimbs()` deletes it wholesale, but which bit means which body part is
  undecoded. Needs a save with a single unambiguous limb loss.
- **Whether the game accepts an editor-minted id.** Ids are re-minted by the
  game on every save, making "silently accepts, then renumbers" the likely
  outcome — but that is inference, not observation, and confirming it means
  writing a save and launching Kenshi.
- **Mod-file writing.** The codec round-trips `.mod` files, so a future FCS-lite
  is possible. Out of scope until the save side is solid.
- **Mod-file writing.** The codec round-trips `.mod` files, so a future FCS-lite
  is possible. Out of scope until the save side is solid.
- **A diff view.** Two saves, or a save and its backup, compared record by
  record — the fastest way to learn what a game action actually changes, and
  the tool that would answer most of the open questions above.
