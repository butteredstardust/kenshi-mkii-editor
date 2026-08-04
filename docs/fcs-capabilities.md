# Kenshi Save Editing with FCS: Complete Capabilities Guide

## Source Information

This document is based on the Steam Community guide "Save Editing 101" by Shidan (user ID: 16156116), originally published 17 May 2018 and last updated 16 Aug 2025. The guide is available at: https://steamcommunity.com/sharedfiles/filedetails/?id=1370334383

This guide documents every manual workflow that users can perform with the Forgotten Construction Set (FCS) to edit Kenshi save game files. This project aims to eventually replace these manual FCS workflows with direct programmatic save editing.

---

## Character Attributes and Statistics

### Attributes and Skills

**What it does:** Change character attributes and skill levels, which directly affect combat ability, dialogue responses, and gameplay performance.

**FCS Location:** Character stats accessible via the STATS entry named after the character, or through the GAMESTATE_CHARACTER entry in the platoon file.

**Steps:**
1. Locate the character's STATS entry in the FCS
2. Scroll through the list until you find the character's name
3. Open it by double-clicking
4. In the window that appears, you'll see all character stats
5. Change the numbers next to each stat to set new levels

**Important Warnings:**
- DO NOT set stats above 100, as they can bug out with negative effects on the character
- Higher values are sometimes incompatible with the game's internal calculations

### Character Personality

**What it does:** Modify a character's personality type, which affects how they respond in dialogue and which dialogue lines they speak.

**FCS Location:** GAMESTATE_CHARACTER entry in the platoon file, toward the bottom half of values.

**Steps:**
1. Open the platoon file for the character
2. Locate the GAMESTATE_CHARACTER type entry
3. Find the "personality" value (toward the bottom half of the list)
4. Change the number to the desired personality

**Personality Values:**
- 1 = Honorable
- 2 = Traitorous
- 5 = Smart
- 6 = Dumb
- 9 = Brave
- 10 = Fearful
- 11 = Warm/Kind
- 12 = Cold/Cruel
- 13 = Normal
- 14 = Maniacal

**Notes:**
- Some personality values (11, 12, 13) were not fully implemented in vanilla and should be avoided
- Most dialogue lines only exist for the main personality types

### Character Rename

**What it does:** Change a character's display name as shown in-game.

**FCS Location:** GAMESTATE_CHARACTER entry in the platoon file.

**Steps:**
1. Open the platoon file for the character
2. Locate the GAMESTATE_CHARACTER type entry
3. Find the "name" value (approximately halfway down the list)
4. Replace the text with the new name
5. (Optional but recommended) Also update the name on the STATS entry for that character for future editing convenience

---

## Character Appearance and Identity

### Character Race

**What it does:** Change a character's playable race (e.g., convert a human character to a skeleton or shek).

**FCS Location:** CHARACTER_APPEARANCE and MEDICAL_STATE entries in the INSTANCE_COLLECTION within the platoon file.

**Steps:**
1. Create a temporary character of the desired race in the same squad as your target character
2. Open the platoon file
3. Navigate to INSTANCE_COLLECTION
4. Open each character's CHARACTER_APPEARANCE entry and rename them to the character's name for easy identification
5. In your target character's CHARACTER_APPEARANCE entry, delete the reference in the "race" section on the right
6. Click the box in the top right of the entry and select "Copy data from Item"
7. Select the temporary character's CHARACTER_APPEARANCE entry - this overwrites your character's appearance including race
8. Now copy the hit values (hit0, hit1, hit2, etc.) from the temporary character's MEDICAL_STATE to your target character's MEDICAL_STATE to match the body part hit boxes
9. Rename any renamed entries back to "0"
10. Save the file
11. In-game, you can dismiss or keep the temporary character

**Important Warnings:**
- Must update hit values in MEDICAL_STATE to match the new race, or you'll encounter bugs with hit detection
- The appearance copy operation will overwrite the target character's entire appearance

### Armour Colour

**What it does:** Change the color scheme of armor and items a character is wearing.

**FCS Location:** INVENTORY_ITEM_STATE entry in the platoon file; Colour Scheme section in the FCS main window.

**Steps:**
1. Ideally, empty your character's inventory except for the item you want to color
2. Remove all weapons, backpacks, armor, and other equipped items
3. Open the FCS with a separate instance to access the Colour Scheme data
   - Load: gamedata.base, Newworld.mod, Dialogue.mod, and rebirth.mod
   - DO NOT save changes while in this instance
4. In the new FCS instance, select "Colour Scheme" section on the left to view available color schemes
5. Open each scheme to see the primary and secondary colors
6. Right-click on the "String ID" at the top of the desired color scheme entry
7. Select "Copy Value" from the menu
8. Switch back to your platoon file FCS instance
9. Open the platoon file and locate the INVENTORY_ITEM_STATE entry for your item
10. Find the "color sid" value near the top on the left
11. Paste the copied value into the "color sid" field
12. Repeat for all items you wish to color
13. Save the file

**Notes:**
- By default, "color sid" is blank for most items
- You can clear colors by erasing the value and leaving it blank
- Multiple instances of FCS can be open simultaneously

---

## Character Health and Status

### Health (Injury and Damage)

**What it does:** Heal or damage a character by editing their health values for each body part.

**FCS Location:** MEDICAL_STATE entry, accessible through changes screen or INSTANCE_COLLECTION.

**Steps:**
1. Open the platoon file
2. Access MEDICAL_STATE entry for your character (either through the changes screen or INSTANCE_COLLECTION)
3. Inside you'll see multiple values for each body part:
   - bandage = cut damage that has been bandaged
   - flesh = the actual health of the part
   - rig = HP that has been splinted
   - stun = blunt damage on the part
   - wear = wear and tear damage on robotic parts
4. To fully heal: set all values except "flesh" to 0, then set "flesh" to the character's maximum health
5. To damage: reduce the "flesh" value to a lower amount

**Mechanics:**
- Any discrepancy between flesh and bandage values = unbandaged cut damage
- Blood level is also shown (1-to-1 ratio with in-game display)
- To make a limb fall off: set its health to -100% of maximum, then reload (if limb loss is set to "frequent")

### Death and KO Status

**What it does:** Revive knocked-out or dead characters.

**FCS Location:** MEDICAL_STATE entry in the platoon file.

**Relevant Fields:**
- coma = whether character is in recovery coma (must get above 0 HP to wake)
- dead = whether character is dead
- KO = KO timer in seconds (only active if not dead or in coma)
- unconscious = whether character is awake or asleep

**Steps to Revive:**
1. Locate the MEDICAL_STATE entry for your character
2. Set the KO timer to 0 to immediately wake them when the save loads
3. Make sure to also fix the character's HP (see Health section), or they'll die again on reload

**Important Warning:**
- HP data will override KO/death flags - if HP is still at lethal levels, the character will die again when you reload

### Hunger

**What it does:** Adjust a character's hunger level and food consumption tracking.

**FCS Location:** MEDICAL_STATE entry, "hung" and "fed" values.

**Values:**
- "hung" = hunger level (0-3 scale with decimals, e.g., 2.5 = 250 hunger in-game)
- "fed" = NU (nutrition units) consumed that cause hunger regeneration (same decimal system, e.g., 0.5 = 50 NU in-game)

**Notes:**
- Edit these values directly in MEDICAL_STATE to change hunger
- 1 unit of decimal = 100 in-game points

### Limb Status

**What it does:** Restore lost limbs to a character (e.g., restore severed legs, arms, or other prosthetics).

**FCS Location:** MEDICAL_STATE entry in the platoon file, "limbs" value on the left side.

**Steps:**
1. Open MEDICAL_STATE for your character
2. Look for the "limbs" value on the left side (only present if character has lost limbs)
3. Right-click on the "limbs" value
4. Select "Delete Value" from the menu
5. Save the file
6. Reload the game - limbs will be restored to normal

**Important Warnings:**
- Only delete the "limbs" value on the left side - not the ones on the right side
- Uncertain what happens to prosthetics when limbs are restored, so remove prosthetics first as a precaution
- Some people mistakenly delete right-side values and become confused why it doesn't work

---

## Squad and Faction Management

### Faction Relations

**What it does:** Change your squad's diplomatic standing with any faction in the game.

**FCS Location:** GAMESTATE_FACTION entry in the quick.save file (NOT the platoon file).

**Steps:**
1. Open the quick.save file
2. Locate the faction in the changes list by name (should have the faction name as its name, with no numbers, and be type "GAMESTATE_FACTION")
3. Double-click to open the faction
4. Scroll down to find the "relationSID" values
5. Look through them until you find one that says "204-gamedata.base" next to it
6. Make note of the number associated with this entry (e.g., if it's "relationSID26", note the "26")
7. Scroll back up to the "relation" values
8. Find the relation value with the matching number (e.g., "relation26")
9. Change the value to your desired relation level (e.g., -100 to 100)
10. Close the faction window
11. Repeat for other factions as needed
12. Save using the button in the top left
13. Reload the save

**Notes:**
- Try to keep relations between -100 and 100; values outside this range can cause bugs
- The "204-gamedata.base" entry identifies your squad

### Transferring Characters Between Factions

**What it does:** Move characters to and from your squad, recruit non-recruitable characters, or assign your characters to other factions.

**FCS Location:** Complex multi-entry edits in the platoon and related save files.

**Notes:**
- This is a complex procedure not fully detailed in the guide
- The guide references Biglulu's original Reddit guide for instructions: https://www.reddit.com/r/Kenshi/comments/lztg6d/how_to_edit_a_character_into_your_squad/
- Allows recruiting otherwise non-recruitable characters, changing NPC faction affiliations, and more

---

## Inventory and Equipment

### Equipping Items in Locked Slots

**What it does:** Equip items in inventory slots that are normally locked due to race, prosthetics, or other restrictions. Allows equipping boots on amputees, clothes on skeletons, etc.

**FCS Location:** INVENTORY_ITEM_STATE entry in the platoon file.

**Preparation:**
1. Empty your character's inventory completely (no clothes, backpack, weapons, or equipped limbs)
2. Place only the item you wish to equip in inventory
3. Ideally, move the character to their own squad for easier identification

**Steps:**
1. Open the platoon file
2. Locate the INVENTORY_ITEM_STATE entry (should be only one if you followed prep steps)
3. If multiple items exist, identify yours by checking:
   - "inventory x" and "inventory y" values (position in inventory)
   - "section" value (which inventory section)
   - "base data sid" value (compare to the item ID shown while modding)
4. Identify the target slot from this list:
   - main = main inventory window
   - head = helmet slot
   - shirt = shirt slot
   - armour = body armor slot
   - legs = pants slot
   - boots = boots slot
   - back = primary weapon slot
   - hip = secondary weapon slot
   - belt = belt slot
   - backpack_attach = backpack slot
   - backpack_content = backpack inventory window
5. Change the "section" value from its current value to the target slot name
6. If swapping equipped items, also change the target slot's current item section value back to "main"
7. Save the file

**Important Limitations and Warnings:**
- Does NOT work for equipping items disallowed by race (e.g., you cannot equip a shirt to a hiver, cannot equip non-shirt items in shirt slot)
- Equipped items will not render/display on the character EXCEPT for prosthetics and boots, which will show
- Cannot equip multiple items in the same slot
- Most useful for boots on amputees and similar overrides

### Weapon and Armour Quality

**What it does:** Change the quality level of weapons and armor, affecting their stats and effectiveness.

**FCS Location:** INVENTORY_ITEM_STATE entry in the platoon file.

**Preparation:**
1. Ideally, have only one character in the squad with only one item in inventory
2. This makes locating the exact item much easier

**For Armour:**
1. Open the platoon file
2. Locate the INVENTORY_ITEM_STATE entry for the armor
3. Find the "Level" value on the left side
4. Change the value to set the quality

**Vanilla Armour Quality Levels:**
- 5 = Prototype
- 20 = Shoddy
- 40 = Standard
- 60 = High
- 80 = Specialist
- 95 = Masterwork

**For Weapons:**
1. Open the platoon file
2. Locate the INVENTORY_ITEM_STATE entry for the weapon
3. Find two key values: "company sid" and "material sid"
4. The "company sid" determines the manufacturer
5. The "material sid" determines the weapon model/type

**Important Notes:**
- Stats continue to improve beyond vanilla ranges, but eventually hit a cap regardless
- Mismatched manufacturer/model combinations may cause the weapon to reset to Catun Scrapmasters Catun No.1 on load
- Manufacturers and models must use the exact SID values provided (too many to list here, but available in FCS faction/mod data)

---

## Inventory Items and Stolen Goods

### Armour Uniform Tag

**What it does:** Set or remove the uniform designation on armor and clothing, marking items as belonging to specific factions.

**FCS Location:** INVENTORY_ITEM_STATE entry in the platoon file.

**Preparation:**
1. Empty inventory except for the item you're editing
2. Move character to their own squad
3. This makes identification of items much easier

**Steps:**
1. Open the platoon file
2. Locate the INVENTORY_ITEM_STATE entry for the item
3. Find the "uniform" value on the left side near the bottom
4. To remove uniform tag: erase the value (leave it blank)
5. To set a uniform: enter the StringID for the desired faction

**Common Faction IDs:**
- Anti-Slavers: 58229-Dialogue.mod
- Flotsam Ninjas: 49377-rebirth.mod
- Holy Nation: 1083-gamedata.base
- Shek Kingdom: 11624-Dialogue (10).mod
- Slave Traders: 1084-gamedata.base
- Traders Guild: 1088-gamedata.base
- United Cities: defaultEmpireFactionSID

### Stolen Tag

**What it does:** Remove or clear the "stolen" status from items, making them legitimate property.

**FCS Location:** INVENTORY_ITEM_STATE entry in the platoon file.

**Preparation:**
1. Empty inventory except for the item you're editing
2. Move character to their own squad

**Steps:**
1. Open the platoon file
2. Locate the INVENTORY_ITEM_STATE entry for the item
3. Find the "stolen" tags on the left side near the bottom (named "ownedby...")
4. Set these values to 0:
   - ownedbyC
   - ownedbyCS
   - ownedbyI
   - ownedbyS
5. Set the "ownedbyTYPE" value to 11
6. Save the file
7. This clears all stolen flags from the item

---

## Combat and Consequences

### Bounties

**What it does:** Modify or remove bounties on your squad members.

**FCS Location:** GAMESTATE_CHARACTER entry in the platoon file.

**Relevant Fields:**
- amount# = bounty size
- bountyexp# = bounty experience
- bountyfac# = faction that issued the bounty
- claim# = claims on the bounty
- crimes# = crime records

**Steps:**
1. Open the platoon file
2. Locate the GAMESTATE_CHARACTER entry
3. Find the bounty-related values
4. To identify which bounty belongs to which faction, check the "bountyfac" value for the faction's SID
5. Look up the faction SID in the FCS faction list (or reference list below for common factions)

**Common Faction SIDs:**
- United Cities: defaultEmpireFactionSID
- Holy Nation: 1083-gamedata.base
- Shek Kingdom: 11624-Dialogue (10).mod

**To Remove a Bounty:**
- Safest method: set the "amount#" value to a small number (but higher than 0)
- This allows the bounty to expire naturally and quickly
- Alternatively, set it to any other value if you have a specific desired bounty amount

---

## Movement and Location

### Character Coordinates (Teleporting)

**What it does:** Instantly move a character to a different location by editing their X, Y, Z coordinates.

**FCS Location:** INSTANCE_COLLECTION within the platoon file; coordinates at the top of each instance entry.

**Steps to Find Target Coordinates:**

Method 1: Copy from another character
1. Ensure your target character is in the same squad as a character already at the desired location
2. In the FCS, open their coordinates for reference

Method 2: Use in-game editor
1. Place a campfire at your target location
2. Select the campfire
3. Press Shift+F12 to open the in-game editor
4. Note the X, Y, Z coordinates displayed

**Steps to Teleport:**
1. Open the platoon file for your squad
2. Open the INSTANCE_COLLECTION
3. Each entry inside corresponds to a character; open them to identify by name (name appears toward the bottom)
4. At the top of each instance entry, find the X, Y, Z coordinates
5. Replace the coordinates with your target location
6. Save the file
7. Load the save in-game

---

## Game Settings and Progression

### Advanced Settings (Hunger Rate, Research Speed, etc.)

**What it does:** Modify advanced gameplay settings that were chosen when starting a new game or importing, such as hunger rates and research speeds, without needing to import the entire save.

**FCS Location:** quick.save file; camera type entry in the changes list.

**Steps:**
1. Open the quick.save file
2. Search the changes list for the entry named "0" with type "camera"
3. Alternatively, use the search bar and type: "Type = camera"
4. Open this entry
5. All advanced settings are stored here; edit as needed

**Notes:**
- Settings can be edited outside their normal starting limits
- Useful if you want to change one setting but don't want to reimport the entire save

### Player Money

**What it does:** Adjust your squad's cash reserves.

**FCS Location:** quick.save file; camera type entry; "player money" value.

**Steps:**
1. Open the quick.save file
2. Search the changes list for the entry named "0" with type "camera"
3. Locate the "player money" value on the left side
4. Edit the value to set your squad's money

**Warnings:**
- Do not increase beyond approximately 2 billion to avoid potential issues
- The exact upper limit is unknown

---

## Getting Started

### Initial Setup and Backups

**Important Notes:**
- Always backup your save file before editing
- The FCS is a powerful tool but can corrupt saves if misused
- This guide recommends keeping at least one unmodified backup

---

