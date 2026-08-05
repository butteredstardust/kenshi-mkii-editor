# Kenshi MKII Editor

A save editor for *Kenshi*. Heal the squad a Beak Thing chewed through, hand out
the gear you never found a vendor for, fix the research you can't be bothered to
grind again, or just teleport out of the Ashlands — from a page in your own
browser, on your own PC.

No account, no launcher, no internet connection. It reads your save, shows you
your world, and refuses to write a single byte it doesn't fully understand.

## Get started

1. **Close Kenshi.** Completely — the game holds the world in memory and
   rewrites the save on exit, so an edit made while it's running is thrown away.
   The editor checks, and refuses.
2. Download the `.exe` below and run it. Everything it needs is inside the
   installer, including its own Node runtime. Nothing else to download, no
   setup.
3. Launch **Kenshi MKII Editor** from your Start menu. It opens a page in your
   browser — that page *is* the app.

Windows SmartScreen may warn you about an unrecognised publisher, because this
installer isn't code-signed. Choose **More info → Run anyway** if you're
comfortable with that.

## What you can change

**Your squad**
- Attributes and trained skills, per character.
- Wounds on every body part, plus consciousness, coma, bleeding and hunger —
  revive and heal a squad that a fight left face-down in the dirt.
- Robotic limbs and decoded personality, read straight out of the save.

**Your gear**
- The full item catalog with category filters and slot icons: search it, set any
  quantity, and equip in bulk.
- Fit checks before anything is equipped — the editor knows which slots your
  characters' races actually have, and won't hand a Skeleton something it can't
  wear.
- Weapon grades and materials handled properly, not faked.

**Your world**
- Relations with all 114 factions, keyed by their stable internal ID rather than
  a display name, so nothing lands on the wrong faction.
- Research: see what's finished, unlock more.
- Vendor stock by faction, town and shop.
- Faction, region, in-game clock, cats, position — and teleport to any town.

**Your recruits**
- 50 grouped recruits with names drawn from Kenshi's own name pools, and 37
  loadouts read off the game's own NPCs.

## Your save is not at risk

- **The format is proved, not guessed.** The editor's own test suite reads every
  file in your save and writes it back in memory, then asserts the result is
  byte-identical — SHA-256, not "looks right". No release ships unless that
  passes. If it can't reproduce a file exactly, it doesn't understand it, and it
  won't write it.
- **Automatic backup.** A timestamped, checksummed copy of the whole save
  directory is taken before any change. You can take extra backups, restore any
  of them, and delete old ones, from the Backups page.
- **Every change is rehearsed first.** Edits are applied to a staged copy, the
  result is re-parsed and hash-diffed, preconditions are re-checked, and only
  then are the changed files swapped into place. Any failure after the backup
  exists restores the original automatically and tells you what happened.
- **Nothing is written while Kenshi is open.**
- **It stays on your PC.** The server binds to loopback only, rejects any request
  that didn't arrive addressed to your own machine, and makes no outbound
  connections. Nothing is uploaded and nothing phones home.

## Requirements

- Windows 10 or 11, 64-bit
- Kenshi installed. The editor reads `gamedata.base` and your Workshop mods to
  turn ~62,000 internal string IDs into readable names, honouring your
  `mods.cfg` load order.
- Saves in the standard location (`%LOCALAPPDATA%\kenshi\save\`)
- A web browser

## Before you use it

- **Unofficial.** Not made by, affiliated with, or endorsed by Lo-Fi Games. All
  game trademarks and copyrights belong to their owners.
- **No warranty.** Provided as-is, with no guarantee it keeps working after a
  game update. Keep your own backups too.
- **A game update can change the save format.** The format was derived against
  Kenshi 1.0.65. If a future patch changes it, the editor's round-trip check is
  what catches it — but wait for an update rather than forcing anything through.
- **Early days.** The read path and the write pipeline are complete and verified;
  the set of available edits is deliberately small and will grow.

## Credits and licences

Full notices are shown by the installer, and in `ACKNOWLEDGEMENTS.md` in the
install folder.

- Item data derived from the Kenshi Wiki on Fandom — CC BY-SA 3.0, by the wiki's
  contributors.
- Bundled software: Node.js and Express (MIT).
- The editor itself is MIT-licensed; `LICENSE` ships in the package.

---

*Nothing here is fair. Not even the save format.*
