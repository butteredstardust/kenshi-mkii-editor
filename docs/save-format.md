# Kenshi save format and the extraction process

How a Kenshi save is laid out on disk, how the binary container is decoded, and
how a raw `stringID` becomes a name like `Azuchi Blue Heavy Armour`. Everything
here was derived by reverse-engineering a real 1.0.65 save and is verified by a
byte-identical round trip (see [Verification](#7-verification)).

---

## 1. Where saves actually live

```
%LOCALAPPDATA%\kenshi\save\<SaveName>\
    quick.save                  world state
    platoon\<Faction>_<n>.platoon    squads: characters, stats, medical, inventory
    zone\zone.<x>.<y>.zone      per-terrain-cell state
    zone\*.hkt                  Havok physics tiles
    portraits_texture.png       cached squad portraits
```

**The `save\` folder inside the Kenshi install directory is not it.** On a
current install that folder contains only empty directory skeletons — the game
creates the tree there but writes nothing into it. Reading it and concluding
"no saves exist" is the first trap.

A save is a **directory, not a file**. Backing up or restoring one file in
isolation produces an internally inconsistent save — always operate on the whole
directory.

Record ids are **per-file, not save-wide** (verified — see §9). Every
filetype-15 file, `quick.save` and each `.platoon` alike, carries its own
`nextId` counter, and the same numeric id routinely names unrelated records in
different files. Ids are also re-minted by the game on every save, so they are
not stable identity. Cross-file and intra-file references travel by `sid`
(`"<id>-<originating file>"`), not by raw id.

---

## 2. Primitive types

Everything is little-endian, unaligned, with no padding.

| Code | Meaning |
|---|---|
| `L` | 4-byte signed integer |
| `F` | 4-byte IEEE-754 float |
| `?` | 1-byte boolean |
| `S` | `L` byte-length prefix, then that many bytes, no terminator |

Two traps in `S`:

- The prefix counts **bytes, not characters**. Workshop mods ship Japanese
  descriptions.
- The bytes are **not guaranteed to be valid UTF-8**. `quick.save` contains a
  string field holding a `0x80` byte. Decoding as UTF-8 substitutes U+FFFD and
  the string grows from 4 bytes to 6 on write — silent, permanent corruption.
  The codec therefore carries strings as **latin1** (a lossless byte↔char
  mapping) and only decodes to UTF-8 at the display boundary
  (`binary.js` → `asText()`).

A trap in `F`: **a NaN is not just "NaN".** Saves contain hundreds of NaN floats
(mostly a type-108 spatial cache's instance positions), and some are *signalling*
NaNs. Reading a float32 into a JS number widens it to a double, which sets the
quiet bit, so writing it back changes one bit and breaks the byte-identical round
trip. The codec keeps each NaN's raw 32 bits, keyed by the float's ordinal within
its record, and restores them on write.

---

## 3. File headers

The first `L` is the filetype.

### Filetype 15 — save files (`quick.save`, `*.platoon`)

```
L  15
L  nextId          per-file id counter; observed == highest id in this file
                   (not highest + 1) — so `nextId + 1` is the first free id
L  recordCount
```

Records start immediately at offset 12.

### Filetype 16 — older mod / base data (`gamedata.base`, `Newwworld.mod`)

```
L  16
L  modVersion
S  author
S  description
S  dependencies    comma-separated filenames
S  references
L  unknown         build stamp, e.g. 0x004C67BE
L  recordCount
```

### Filetype 17 — newer mod files (`rebirth.mod`, `Dialogue.mod`, workshop mods)

Same as 16 with **one extra `L` immediately after the filetype**, plus a
**variable-length blob between the reference list and the record count** whose
layout is not understood. Its size differs per file: 0 bytes in `Azuchi.mod`,
9 in `Dialogue.mod`, 10 in `rebirth.mod`.

Rather than guess, the codec **probes**: for `k` in 0..40, read `L unknown`,
`L recordCount` at `refsEnd + k`, and accept the first `k` where the count is
plausible *and* the next three records parse cleanly. Every byte before the
records is then preserved verbatim (`headerRaw`) so a write reproduces the
original exactly, understood or not.

This is the general principle for this format: **preserve what you cannot
explain.**

---

## 4. Record layout

`recordCount` records follow the header, back to back.

```
L  instanceCount   duplicates the length of the instances section below
L  typecode        object class (see §5)
L  id
S  name
S  stringId        "<id>-<originating file>"
L  modDataType     status flag
```

Then **nine count-prefixed sections, in this exact order**:

| # | Section | Entry |
|---|---|---|
| 1 | bools | `S key`, `? value` |
| 2 | floats | `S key`, `F value` |
| 3 | ints | `S key`, `L value` |
| 4 | vec3 | `S key`, `F x`, `F y`, `F z` |
| 5 | vec4 | `S key`, `F w`, `F x`, `F y`, `F z` |
| 6 | strings | `S key`, `S value` |
| 7 | filenames | `S key`, `S value` |
| 8 | extra data | `S category`, `L count`, then `count ×` (`S target`, `L v0`, `L v1`, `L v2`) |
| 9 | instances | `S id`, `S target`, `F ×3` position, `F ×4` rotation, `L stateCount`, then `stateCount × S` |

Section counts are zero far more often than not; a typical record is a long run
of zero `L`s.

**Key order is not sorted and must be preserved on write.** The codec uses
`Map`, never a plain object — plain objects would also silently collapse
duplicate keys and change the count.

Filetype 15 files have a **tail** after the last record — an opaque stream of
longs (11,436 bytes in the sample save). It is preserved byte for byte.

### The instanceCount duplication

The leading `L instanceCount` in the record header repeats the count of the
instances section at the end of the same record. This duplication is what made
the layout hard to find: a record with 113 instances has `113` at both ends, and
mistaking the leading one for the start of a section produces a parse that
*almost* works and then fails 900 KB later.

---

## 5. Typecodes seen in a save

| Type | Contents |
|---|---|
| 9 | faction world-controller (`num plats`, `updatetime`) |
| 25 | **character stats** — one float per skill and attribute |
| 30 | **squad** — `char count` + one instance per character |
| 34 | **squad metadata** (world file) — one per `.platoon`: `faction name`, `char count`, `platoon stringID`, `content file` |
| 36 | **character state** — `name`, `is leader`, `personality`, `age` |
| 37 | **faction** — `relation<n>` floats + `relationSID<n>` targets |
| 41 | **inventory container** — one instance per item |
| 42 | **item** — `base data sid`, `quantity`, `section`, `material sid`. The *instance*; its template lives in gamedata as typecode 2 (weapon), 3 (armour), 4 (trade goods) or 46 (backpack) |
| 21 | **research ledger** (exactly one per save) — `num finished` + `finished<N>` strings. Also the gamedata typecode for a research tech; see AGENTS.md §3 |
| 56 | **game state** — `player money`, `pfaction name`, `area`, clock, camera |
| 57 | **medical** — per-body-part health, blood, hunger, KO/coma flags |
| 66 | appearance sliders |
| 67 | AI / jobs |
| 94 | town state |

`gamedata.base` uses a much wider range (19 = dialogue line, 31, 29, …).

### Reading a character

A character is not one record — it is a cluster stitched together by the squad
record's instance list:

```
squad (30)
  └── instance                      target = race/start template stringID
        id       = character instance id
        pos      = world position
        states[] = [ 36 char state, 25 stats, 57 medical, 41 inventory, 66 look, 67 ai ]
```

Resolve each `states[]` entry through a `stringId → record` map of the same
platoon file, then dispatch on typecode. `inventory (41)` is one more hop: its
instances point at `item (42)` records.

The squad instance's own `id` deserves a note, because it is not what the
analogous field in an inventory record is. An `inventory (41)` instance id is a
small ordinal counted inside that container ("1", "2", …). A `squad (30)`
instance id is **sid-shaped** ("32--INGAME") and is minted from the same
per-file id counter as records — but it is **not a record**. Across all 282
character instances of a live save, no instance id matched any record's sid, and
the ids they consume appear as exact gaps in each file's record-id sequence
(`Nameless_0.platoon` holds records 31, 33–50, 52–60; its two character
instances are 32 and 51). Anything adding a character must allocate one id for
the handle on top of one per state record.

A character's **race** is likewise not where you would look for it: it is in the
`appearance (66)` record's *extra data* section, category `"race"`, as a single
row whose `target` is the race's stringID (typecode 7). It is not a key in
`bools`/`floats`/`ints`/`strings`.

That one row is the save's entire statement of species; everything a race
*implies* comes from the type-7 record in gamedata. In particular the
`medical (57)` record's body plan is not independent data — a race's
`extra['combat anatomy']` has one row per body part, whose `target` is the part
(typecode 16), `v0` is that part's `hit<n>` and `v1` its undamaged maximum.
Across every character of every save on the development machine — 3717, in 15
races — the part sets agree 3717/3717 and `hit<n> == v0` 3717/3717. Resolving it
needs the game's load order, the rows unioned across definitions (a mod may
re-state one limb), and `2147483647` read as "remove this part"; see
`services/racesService.js` and AGENTS.md §3.

The appearance record's *sliders* are a different matter: their key sets vary per
race (a Shek record has `bone_wide_jaw`/`bone_horns_thick` keys a Greenlander's
does not, and 13 distinct key shapes were observed within Greenlanders alone).
Nothing here derives which keys a race requires, which is why
`services/characterFactory.js` builds a NEW character by cloning an existing one
of the wanted race rather than synthesising those structures — and why
`saveService.setRace()`, which changes an EXISTING character's race, leaves the
sliders exactly as they are and warns that the character will look different.

### Body-part health

`flesh<n>` is the current value, `sid<n>` names the part. There is also a
`hit<n>` that looks like a maximum but **is not trustworthy as one** — an
undamaged arm reads `flesh 100` against `hit 80`, and a bonedog's hind legs read
`70.7` against `50`. The editor reports both raw and judges damage against the
character's own highest intact part, which is unambiguous.

The real per-part maximum lives in the race, not the save: it is the second
number (`v1`) on that part's `combat anatomy` row (§5, "Reading a character").
It is a *natural* maximum rather than a hard ceiling — 39 live Hive Worker
Drones read up to 125 against a `v1` of 75, and they are the characters whose
`hitmult<n>` is not 1, i.e. the ones wearing robotic limbs.

The other per-part floats are per-CHARACTER, not per-race: `hitmult<n>` is 1,
`rig<n>` and `wear<n>` are 0 on every character without prosthetics.

---

## 6. Resolving stringIDs to names

Every reference is a string of the form `"<id>-<originating file>"`:
`476-gamedata.base`, `98840-Azuchi.mod`, `32-gamedata.quack`.

**The filename part is not a path.** It records where the record was *first*
defined, permanently, and that file may no longer exist. Vanilla data was
consolidated over the years, so a live save happily references
`changes_otto.mod`, `Escapes.mod` and `gamedata.quack` — none of which are files
on disk. Their records live inside `gamedata.base` today. Chasing the filename
leads to a false "missing mod" conclusion.

Resolution is therefore a **flat lookup across every data file**:

1. Parse `gamedata.base`, `Newwworld.mod`, `Dialogue.mod`, `rebirth.mod` from
   `<Kenshi>\data\`.
2. Parse every `*.mod` under `steamapps\workshop\content\233860\*\` and
   `<Kenshi>\mods\*\`.
3. Index `record.stringId → { name, type }`. First definition wins.

On this install that yields **~62,600 stringIDs** from ~140 files. Mods that
ship only textures or meshes carry zero records and no usable header; the
probe in §3 fails on them and they are skipped — correctly, since they define
no names.

Worked example, `save1`:

| stringID | resolves to |
|---|---|
| `47927-rebirth.mod` | `start- Homeless` (the game start the character came from) |
| `476-gamedata.base` | `Katana` |
| `98840-Azuchi.mod` | `Azuchi Blue Heavy Armour` |
| `42315-changes_otto.mod` | `Animal Teeth` |
| `32-gamedata.quack` | `Head` |
| `55664-rebirth.mod` | `Bast` |

---

## 7. Verification

The only cheap proof that the codec understands a file is a **byte-identical
round trip**: read it, write it back, compare SHA-256.

`webapp/test/codec.test.js` asserts this for the live save (`quick.save`, every
`.platoon`) and for `gamedata.base`, `rebirth.mod`, `Newwworld.mod` and
`Dialogue.mod` — 4.6 MB, 4.0 MB, 2.0 MB and 11.9 MB respectively, all exact.

```
node --test "test/*.test.js"
```

Any file that fails the round trip must never be written to disk. This is also
the version-change canary: after a Kenshi update, re-run these tests before
trusting any edit.

---

## 8. How this was derived

Recorded because the dead ends are instructive:

1. **Scan for length-prefixed ASCII strings** to find record boundaries. This
   over-matches badly — `(key, value)` string pairs are byte-indistinguishable
   from `(name, stringId)` record headers — but it reveals the `<n>-<file>`
   stringID shape.
2. **Hexdump around a known record** and align fields by hand. `1196--INGAME`
   at the top of the save gives the header size; `updatetime` decoding as
   `46.03` identifies the float section.
3. **Trial-consume ambiguous sections** with candidate element widths (1, 4, 12,
   16 bytes, or a nested string) and validate by checking that the next record
   header looks sane. This resolved sections 1–7 and cost nothing.
4. **Dead end:** the instances section defeated step 3 for a long time. Entry
   strides were a uniform 52–53 bytes *except the first*, which was 8 bytes
   longer. Every layout consistent with entries 2..n contradicted entry 1.
   The resolution was that those 8 bytes were never part of the section at all —
   they were the `instanceCount` + `typecode` of the record header, duplicating
   the count that appears again at the section itself.
5. **Confirm against a written spec**, which named `Instance Count` as a record
   header field and immediately explained the duplication.
6. **Prove it** with the round trip in §7 — which then caught two further bugs a
   parse-only check never would have: the UTF-8 corruption in §2, and the
   type-17 header blob in §3.

The Python scripts used during derivation are kept in `tools/py-reference/` as
an independent second implementation. `report.py` and `webapp/scripts/status.js`
produce the same output from the same save; a disagreement between them means
one of the two is wrong.

---

## 9. Open questions

- The variable-length blob in the filetype-17 header (§3) — probed, preserved,
  not understood.
- The filetype-15 tail — described as a memory-dump artefact; preserved as-is.
- `modDataType` — observed 0 in saves, negative in mods; meaning unconfirmed.
- `hit<n>` in medical records (§5) — not a reliable maximum.
- ~~Whether `nextId` must be bumped when adding records.~~ **Resolved** (Phase 0,
  full evidence in `TODO.md`): `nextId` is per-file, equals that file's own
  highest id exactly, so the first free id is `nextId + 1` and the header must
  be bumped to match on write. Ids collide freely across files and are re-minted
  by the game on every save; `sid` carries the references and must be written in
  lockstep with any new id. Still untested: whether the game accepts, rejects or
  silently renumbers an editor-chosen id on load (needs a write plus a game
  launch).
- `zone/*.zone` files parse with the same codec but their record semantics
  (buildings, dropped items) are unmapped.
