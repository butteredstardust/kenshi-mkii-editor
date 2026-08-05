// `backpack_attach`/`backpack_content` are grouped into their own "Carried"
// and "Backpack" sections instead (a worn backpack + its contents read
// better together than split across two panes) — every slot still appears
// in exactly one section, never zero or two. Mirrors saveService's
// ITEM_SLOTS/ITEM_BUCKET_SLOTS; kept in sync by hand since the client has no
// access to the server module.
export const EQUIP_SLOTS = ['head', 'shirt', 'armour', 'legs', 'boots', 'back', 'hip', 'belt'];
export const ITEM_SLOTS = ['main', 'head', 'shirt', 'armour', 'legs', 'boots', 'back', 'hip', 'belt', 'backpack_attach', 'backpack_content'];

// The five slots the wiki's per-race table covers. Weapons and packs are not
// part of that table and are never flagged by it.
export const ARMOUR_SLOTS = ['head', 'shirt', 'armour', 'legs', 'boots'];

// Human labels for the raw on-disk `section` strings. Display only — every
// value written back is the raw key, never the label (see itemSlotSelect).
export const SLOT_LABELS = {
  main: 'Carried', head: 'Head', shirt: 'Shirt', armour: 'Body armour',
  legs: 'Legs', boots: 'Boots', back: 'Back (weapon)', hip: 'Hip (weapon)',
  belt: 'Belt', backpack_attach: 'Backpack (worn)', backpack_content: 'In backpack',
};

/**
 * "Worn", i.e. anything that is not one of the two storage buckets — the
 * client-side mirror of saveService's EQUIP_SECTIONS. An unequip only ever
 * means moving one of these back to Carried.
 */
export const BUCKET_SLOTS = ['main', 'backpack_content'];
export const isWorn = (section) => !!section && !BUCKET_SLOTS.includes(section);

/**
 * Put the two storage buckets first. Adding something usually means "into the
 * pack" or "into the character's hands" — the body slots are the exception, and
 * they were sorted ahead of both because ITEM_SLOTS lists them in wear order.
 */
export function carryFirst(sections) {
  const buckets = ['main', 'backpack_content'].filter((s) => sections.includes(s));
  return [...buckets, ...sections.filter((s) => !buckets.includes(s))];
}

/**
 * The inverse of `carryFirst()`, and deliberately so.
 *
 * The per-character picker defaults to Carried because "Add item" there means
 * "put this in their inventory". This panel is titled Equip: "give everyone a
 * Blackened Chainmail" means WEAR it, and defaulting to Carried would quietly
 * hand twenty characters an unworn shirt. Body slots first, the two storage
 * buckets after, for the items (food, ore, a map) that have no body slot at all.
 */
export function wearFirst(sections) {
  const isBucket = (s) => s === 'main' || s === 'backpack_content';
  return [...sections.filter((s) => !isBucket(s)), ...sections.filter(isBucket)];
}
