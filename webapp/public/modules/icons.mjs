import { esc } from './core.mjs';

/**
 * Slot glyphs. Inline SVG, not an icon font (style guide §1): each one encodes
 * WHICH slot a row occupies, so it carries information the text would
 * otherwise have to repeat, and it makes a long inventory scannable by shape
 * instead of by reading every row. `currentColor` so they inherit tone.
 */
export const ICON_PATHS = {
  head: '<path d="M3.5 9.5a4.5 4.5 0 0 1 9 0v3h-9z"/><path d="M3.5 10.5h9"/>',
  // Non-slot glyphs. Each labels a section whose heading would otherwise be a
  // bare word among several identical ones — a squad of collapsed <details>
  // rows is much faster to scan by shape (style guide §1).
  squad: '<path d="M6 4.5a2 2 0 1 0 0 .01"/><path d="M2.5 13v-1.5a3.5 3.5 0 0 1 7 0V13"/><path d="M11 5.5a1.6 1.6 0 1 0 0 .01"/><path d="M10.6 13v-1.8c0-.7-.2-1.3-.6-1.8a2.8 2.8 0 0 1 3.5 2.7V13"/>',
  rename: '<path d="M2.5 13.5h11"/><path d="M4 10.5 10.8 3.7a1.4 1.4 0 0 1 2 2L6 12.5l-2.6.6z"/>',
  add: '<path d="M8 3.5v9"/><path d="M3.5 8h9"/>',
  teleport: '<path d="M8 1.8c2 2.4 3 4.4 3 6.2a3 3 0 0 1-6 0c0-1.8 1-3.8 3-6.2z"/><circle cx="8" cy="7.6" r="1.1"/><path d="M4 13.6h8"/>',
  heart: '<path d="M8 13.2C4.5 10.7 2.5 8.9 2.5 6.8A2.8 2.8 0 0 1 8 5.6a2.8 2.8 0 0 1 5.5 1.2c0 2.1-2 3.9-5.5 6.4z"/>',
  stats: '<path d="M2.5 13.5h11"/><path d="M4.5 13.5v-4"/><path d="M8 13.5v-8"/><path d="M11.5 13.5v-6"/>',
  identity: '<rect x="2.5" y="3.5" width="11" height="9" rx="1.5"/><circle cx="6" cy="7.5" r="1.4"/><path d="M3.8 11c.4-1.1 1.2-1.7 2.2-1.7s1.8.6 2.2 1.7"/><path d="M10 7h3M10 9.5h3"/>',
  dice: '<rect x="2.5" y="2.5" width="11" height="11" rx="2"/><circle cx="5.6" cy="5.6" r=".9" fill="currentColor"/><circle cx="10.4" cy="10.4" r=".9" fill="currentColor"/><circle cx="8" cy="8" r=".9" fill="currentColor"/>',
  cats: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5.2v5.6"/><path d="M9.6 6.4a1.8 1.8 0 0 0-3 1.1c0 1.7 3 .9 3 2.5a1.8 1.8 0 0 1-3 .6"/>',
  sun: '<circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1"/>',
  moon: '<path d="M13 9.6A5.6 5.6 0 0 1 6.4 3a5.6 5.6 0 1 0 6.6 6.6z"/>',
  blood: '<path d="M8 2.2s4 4.5 4 6.9a4 4 0 0 1-8 0c0-2.4 4-6.9 4-6.9z"/>',
  list: '<path d="M5.5 4.5h8M5.5 8h8M5.5 11.5h8"/><path d="M2.5 4.5h.01M2.5 8h.01M2.5 11.5h.01"/>',
  shirt: '<path d="M6 2.5 2.5 4.5 4 7l2-1.2v7.7h4V5.8L12 7l1.5-2.5L10 2.5 8 4z"/>',
  armour: '<path d="M4 3h8v5.5A4 4 0 0 1 8 13a4 4 0 0 1-4-4.5z"/><path d="M8 3v10"/>',
  legs: '<path d="M4 2.5h8l-.6 11H9.2L8 7l-1.2 6.5H4.6z"/>',
  boots: '<path d="M4.5 2.5h3v6.5l5 2v2.5h-8z"/>',
  weapon: '<path d="M13.5 2.5 7 9"/><path d="M5 9.5 6.5 11"/><path d="m2.5 13.5 2.2-.6 1.1-1.1-1.6-1.6-1.1 1.1z"/>',
  belt: '<path d="M2 6h12v4H2z"/><path d="M6.5 6v4M9.5 6v4"/>',
  backpack: '<path d="M4 5.5h8v8H4z"/><path d="M6 5.5V4a2 2 0 0 1 4 0v1.5"/><path d="M6 9.5h4"/>',
  bag: '<path d="M3 5.5h10l-1 8H4z"/><path d="M6 5.5V4.2a2 2 0 0 1 4 0v1.3"/>',
  backup: '<rect x="2.5" y="3" width="11" height="3" rx=".8"/><path d="M3.5 6.5v6a.8.8 0 0 0 .8.8h7.4a.8.8 0 0 0 .8-.8v-6"/><path d="M6.5 9h3"/>',
};

function icon(name, label) {
  const d = ICON_PATHS[name];
  if (!d) return '';
  return `<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor"
    stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round"
    role="img" aria-label="${esc(label || name)}">${d}</svg>`;
}

/**
 * A `<summary>` with a leading glyph. The icon names the section by shape so a
 * card of five collapsed disclosures is scannable without reading each label —
 * it is carrying information, not decorating the word (style guide §1).
 */
function sectionSummary(glyph, label) {
  return `<summary>${icon(glyph, label)}<span>${label}</span></summary>`;
}

// Which glyph stands for which `strings.section` value.
export const SLOT_ICONS = {
  head: 'head', shirt: 'shirt', armour: 'armour', legs: 'legs', boots: 'boots',
  back: 'weapon', hip: 'weapon', belt: 'belt',
  backpack_attach: 'backpack', backpack_content: 'backpack', main: 'bag',
};

// Which glyph stands for each item typecode in the vendor table.
export const ITEM_KIND_ICONS = { 2: 'weapon', 3: 'armour', 4: 'bag', 46: 'backpack', 107: 'weapon', 111: 'identity', 102: 'list', 21: 'stats', 51: 'squad' };

// Category glyphs. Each names a research branch by shape so a 199-row table is
// scannable without reading every category cell (style guide §1).
export const RESEARCH_ICONS = {
  Core: 'list', Defence: 'armour', Smithing: 'weapon', Industry: 'stats',
  Farming: 'sun', Training: 'squad', Electrics: 'teleport', Crafting: 'rename',
};

export { icon, sectionSummary };
