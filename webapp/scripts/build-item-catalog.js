#!/usr/bin/env node
'use strict';

/**
 * Builds the item catalog under `webapp/data/`.
 *
 * Pipeline (raw snapshot -> canonical -> overrides -> audit):
 *
 *   wiki-items.snapshot.json  raw MediaWiki scrape. Machine-owned; --refresh
 *                             overwrites it. Never hand-edit.
 *   item-overrides.json       hand-maintained corrections, applied on top of
 *                             the snapshot. Each entry carries a `comment`.
 *   items.canonical.json      the joined, cleaned result the app would consume.
 *   item-map-audit.json       counts + the actual unmatched lists, so the
 *                             quality of the join is visible, not assumed.
 *
 * The wiki is NOT the source of truth for identity. `gamedataService` is: a
 * save references items by stringID (`476-gamedata.base`), and the catalog is
 * only useful insofar as it resolves a human name to one of those. An item we
 * cannot resolve gets `stringId: null` — never a guess.
 *
 * Usage (from webapp/):
 *   node scripts/build-item-catalog.js              # offline rebuild from snapshot
 *   node scripts/build-item-catalog.js --refresh    # re-scrape the wiki, then rebuild
 *   node scripts/build-item-catalog.js --refresh --max-depth=3 --max-pages=200
 *
 * No new runtime dependencies: Node's global fetch only.
 */

const fs = require('node:fs');
const path = require('node:path');

const API = 'https://kenshi.fandom.com/api.php';
const WIKI = 'https://kenshi.fandom.com/wiki/';
const ROOT_CATEGORY = 'Category:Items';
const LICENSE = 'CC BY-SA 3.0';
const USER_AGENT =
  'KenshiMKIIEditor/0.1 (personal, non-commercial Kenshi save-editor; single-threaded, rate-limited)';

const DATA_DIR = path.join(__dirname, '..', 'data');
const SNAPSHOT_FILE = path.join(DATA_DIR, 'wiki-items.snapshot.json');
const CANONICAL_FILE = path.join(DATA_DIR, 'items.canonical.json');
const OVERRIDES_FILE = path.join(DATA_DIR, 'item-overrides.json');
const AUDIT_FILE = path.join(DATA_DIR, 'item-map-audit.json');

const SCHEMA_VERSION = 1;

/**
 * gamedata typecodes that can legitimately sit in a character's inventory.
 * Derived by sampling the name index (see docs/save-format.md §5): 2 weapon,
 * 3 armour/clothing, 4 trade good / consumable / book, 46 backpack, 86 nest
 * loot (eggs, bone fragments), 102 map, 107 crossbow, 111 limb/prosthetic.
 * Deliberately excluded: 47 (material/colour variants), 50/51 (weapon grade
 * and manufacturer), 62 (crafting recipes), 21 (research) — those share names
 * with real items and would produce plausible-looking wrong stringIDs.
 */
const ITEM_TYPES = new Set([2, 3, 4, 46, 86, 102, 107, 111]);

/* ------------------------------------------------------------------ args */

function parseArgs(argv) {
  const opts = {
    refresh: false,
    maxDepth: 4,
    maxPages: Infinity,
    delayMs: 350,
    root: ROOT_CATEGORY,
  };
  for (const arg of argv) {
    if (arg === '--refresh') opts.refresh = true;
    else if (arg === '--offline') opts.refresh = false;
    else if (arg.startsWith('--max-depth=')) opts.maxDepth = Number(arg.split('=')[1]);
    else if (arg.startsWith('--max-pages=')) opts.maxPages = Number(arg.split('=')[1]);
    else if (arg.startsWith('--delay=')) opts.delayMs = Number(arg.split('=')[1]);
    else if (arg.startsWith('--root=')) opts.root = arg.split('=').slice(1).join('=');
    else if (arg === '--help' || arg === '-h') { usage(); process.exit(0); }
    else throw new Error(`unknown flag: ${arg}`);
  }
  return opts;
}

function usage() {
  console.log(
    'build-item-catalog.js [--refresh] [--max-depth=N] [--max-pages=N] [--delay=ms] [--root=Category:X]'
  );
}

/* ------------------------------------------------------------- http layer */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One sequential, rate-limited API call. No parallelism anywhere in this
 * script — we are a guest on someone else's wiki.
 */
async function api(params, opts, attempt = 0) {
  const qs = new URLSearchParams({
    format: 'json',
    formatversion: '2',
    maxlag: '5',
    ...params,
  });
  const url = `${API}?${qs}`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
  await sleep(opts.delayMs);
  if (!res.ok) {
    if (attempt < 2) { await sleep(2000 * (attempt + 1)); return api(params, opts, attempt + 1); }
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  const json = await res.json();
  if (json.error) {
    if (json.error.code === 'maxlag' && attempt < 3) {
      await sleep(5000);
      return api(params, opts, attempt + 1);
    }
    throw new Error(`API error ${json.error.code}: ${json.error.info}`);
  }
  return json;
}

/** Walk a query that paginates via `continue`, yielding each response. */
async function* paginate(params, opts) {
  let cont = {};
  for (;;) {
    const json = await api({ ...params, ...cont }, opts);
    yield json;
    if (!json.continue) return;
    cont = json.continue;
  }
}

/* ------------------------------------------------------------- the crawl */

/**
 * Breadth-first walk of Category:Items and its subcategories.
 * Returns { pages: Map(title -> {pageid, categoryPaths}), categories: [...] }.
 */
async function crawlCategories(opts) {
  const pages = new Map();
  const visited = new Set();
  const categories = [];
  const queue = [{ title: opts.root, depth: 0, trail: [] }];

  while (queue.length) {
    const { title, depth, trail } = queue.shift();
    if (visited.has(title)) continue;
    visited.add(title);
    const trailHere = [...trail, title.replace(/^Category:/, '')];
    categories.push({ category: title, depth, memberPages: 0, subcategories: 0 });
    const rec = categories[categories.length - 1];

    for await (const json of paginate(
      { action: 'query', list: 'categorymembers', cmtitle: title, cmlimit: '500', cmtype: 'page|subcat' },
      opts
    )) {
      for (const m of json.query.categorymembers) {
        if (m.ns === 14) {
          rec.subcategories++;
          if (depth + 1 <= opts.maxDepth) queue.push({ title: m.title, depth: depth + 1, trail: trailHere });
        } else if (m.ns === 0) {
          rec.memberPages++;
          const existing = pages.get(m.title);
          if (existing) {
            existing.categoryPaths.push(trailHere.join(' / '));
          } else if (pages.size < opts.maxPages) {
            pages.set(m.title, { pageid: m.pageid, title: m.title, categoryPaths: [trailHere.join(' / ')] });
          }
        }
      }
    }
    process.stderr.write(
      `  [depth ${depth}] ${title}: ${rec.memberPages} pages, ${rec.subcategories} subcats (total ${pages.size})\n`
    );
  }
  return { pages, categories };
}

/** Fetch wikitext + page image for a batch of page ids. */
async function fetchPageContent(ids, opts) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const json = await api(
      {
        action: 'query',
        pageids: batch.join('|'),
        prop: 'revisions|pageimages|categories',
        rvprop: 'content|ids|timestamp',
        rvslots: 'main',
        piprop: 'name',
        cllimit: 'max',
      },
      opts
    );
    for (const p of json.query.pages || []) out.set(p.pageid, p);
    process.stderr.write(`  content ${Math.min(i + 50, ids.length)}/${ids.length}\n`);
  }
  return out;
}

/* ---------------------------------------------------------- wikitext bits */

/**
 * Pull top-level `{{Template|...}}` calls out of wikitext, brace-balanced.
 * Only what we need to read an infobox — this is not a wikitext parser.
 */
function extractTemplates(text) {
  const out = [];
  for (let i = 0; i < text.length - 1; i++) {
    if (text[i] !== '{' || text[i + 1] !== '{') continue;
    let depth = 0;
    let j = i;
    for (; j < text.length - 1; j++) {
      if (text[j] === '{' && text[j + 1] === '{') { depth++; j++; }
      else if (text[j] === '}' && text[j + 1] === '}') { depth--; j++; if (depth === 0) { j++; break; } }
    }
    if (depth !== 0) continue;
    const body = text.slice(i + 2, j - 2);
    out.push({ raw: text.slice(i, j), ...splitTemplate(body), offset: i });
    i = j - 1;
  }
  return out;
}

/** Split a template body on top-level pipes into a name and named params. */
function splitTemplate(body) {
  const parts = [];
  let depth = 0;
  let buf = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '{' && body[i + 1] === '{') { depth++; buf += '{{'; i++; continue; }
    if (c === '}' && body[i + 1] === '}') { depth--; buf += '}}'; i++; continue; }
    if (c === '[' && body[i + 1] === '[') { depth++; buf += '[['; i++; continue; }
    if (c === ']' && body[i + 1] === ']') { depth--; buf += ']]'; i++; continue; }
    if (c === '|' && depth === 0) { parts.push(buf); buf = ''; continue; }
    buf += c;
  }
  parts.push(buf);
  const name = parts.shift().trim();
  const params = {};
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    const key = p.slice(0, eq).trim().toLowerCase().replace(/\s+/g, ' ');
    const value = p.slice(eq + 1).trim();
    if (key && !(key in params)) params[key] = value;
  }
  return { name, params };
}

/** Strip the wiki markup that survives into a plain field. */
function cleanValue(v) {
  if (v == null) return null;
  let s = String(v);
  s = s.replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '');
  s = s.replace(/<ref[^>]*\/>/gi, '');
  s = s.replace(/<br\s*\/?>/gi, ' ');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/\[\[(?:[^\]|]*\|)?([^\]|]*)\]\]/g, '$1');
  s = s.replace(/'''?/g, '');
  s = s.replace(/\{\{[^{}]*\}\}/g, '');
  s = s.replace(/&nbsp;/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s || null;
}

const STRING_ID_RE = /^\d+-\S+$/;

/** Every `<n>-<file>` stringID mentioned anywhere in an infobox. */
function stringIdsFrom(params) {
  const found = [];
  for (const [k, v] of Object.entries(params)) {
    if (!/string.?id|stringid/.test(k)) continue;
    for (const tok of cleanValue(v) ? cleanValue(v).split(/[,;\s]+/) : []) {
      if (STRING_ID_RE.test(tok)) found.push(tok);
    }
  }
  return [...new Set(found)];
}

/** Infobox templates we recognise, in preference order. */
const INFOBOX_NAMES = [
  'weapon', 'item', 'equipment intro', 'armour', 'armor', 'infobox', 'weapon infobox',
  'clothing', 'backpack', 'food', 'building', 'limb', 'crossbow', 'book',
];

function pickInfobox(templates) {
  for (const want of INFOBOX_NAMES) {
    const hit = templates.find((t) => t.name.toLowerCase() === want);
    if (hit) return hit;
  }
  // Fall back to a leading template that carries a description-ish param.
  const lead = templates.find(
    (t) => t.offset < 200 && ('description' in t.params || 'desc' in t.params)
  );
  return lead || null;
}

const NOISE_PARAMS = new Set([
  'imagesettings', 'mw-collapsible mw-collapsed', 'collapsible', 'align', 'width', 'height',
]);

function buildSnapshotItem(page, meta) {
  const rev = page.revisions && page.revisions[0];
  const wikitext = rev ? rev.slots.main.content : '';
  const templates = extractTemplates(wikitext);
  const box = pickInfobox(templates);
  const params = box ? box.params : {};

  const infobox = {};
  for (const [k, v] of Object.entries(params)) {
    if (NOISE_PARAMS.has(k)) continue;
    const c = cleanValue(v);
    if (c !== null) infobox[k] = c;
  }

  const description =
    cleanValue(params.description) || cleanValue(params.desc) || null;

  const imageFile =
    cleanValue(params.icon) || cleanValue(params.image) || page.pageimage || null;

  return {
    page: page.title,
    pageId: page.pageid,
    revisionId: rev ? rev.revid : null,
    revisionTimestamp: rev ? rev.timestamp : null,
    categoryPaths: meta.categoryPaths,
    categories: (page.categories || [])
      .map((c) => c.title.replace(/^Category:/, ''))
      .filter((c) => !/^(Pages|Articles|Browse|Candidates)/i.test(c)),
    template: box ? box.name : null,
    infobox,
    description,
    imageFile,
    wikiStringIds: stringIdsFrom(params),
    isRedirectish: /^#REDIRECT/i.test(wikitext.trim()),
    wikitextBytes: wikitext.length,
  };
}

/* ------------------------------------------------------------- the scrape */

async function refresh(opts) {
  process.stderr.write(`Crawling ${opts.root} (max depth ${opts.maxDepth})...\n`);
  const { pages, categories } = await crawlCategories(opts);
  const list = [...pages.values()];
  process.stderr.write(`Fetching wikitext for ${list.length} pages...\n`);
  const content = await fetchPageContent(list.map((p) => p.pageid), opts);

  const items = [];
  for (const meta of list) {
    const page = content.get(meta.pageid);
    if (!page || page.missing) continue;
    items.push(buildSnapshotItem(page, meta));
  }
  items.sort((a, b) => a.page.localeCompare(b.page));

  const snapshot = {
    schemaVersion: SCHEMA_VERSION,
    fetchedAt: new Date().toISOString(),
    sourceUrl: API,
    sourceWiki: 'https://kenshi.fandom.com/',
    rootCategory: opts.root,
    license: LICENSE,
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/3.0/',
    attribution: 'Kenshi Wiki (Fandom) contributors, text available under CC BY-SA 3.0.',
    crawl: {
      maxDepth: opts.maxDepth,
      maxPages: opts.maxPages === Infinity ? null : opts.maxPages,
      delayMs: opts.delayMs,
      categoriesVisited: categories.length,
      pagesFound: list.length,
      pagesFetched: items.length,
    },
    categories,
    items,
  };
  writeJson(SNAPSHOT_FILE, snapshot);
  process.stderr.write(`Wrote ${rel(SNAPSHOT_FILE)}: ${items.length} items\n`);
  return snapshot;
}

/* -------------------------------------------------------------- the join */

/**
 * Conservative: case, punctuation and whitespace only. No stemming, no
 * synonyms, no fuzzy distance. Apostrophes are elided rather than turned into
 * a space, because the wiki writes "Drifters Leather Jacket" where gamedata
 * writes "Drifter's Leather Jacket" — same token stream either way.
 */
function normaliseName(name) {
  return String(name)
    .toLowerCase()
    .replace(/[‘’ʼ']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function slugId(title) {
  return String(title)
    .normalize('NFKD')
    .replace(/[‘’]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

/** name index -> item-only lookup tables. */
function buildGamedataIndex() {
  const gamedata = require('../services/gamedataService');
  const raw = loadRawIndex();
  const byExact = new Map();
  const byNorm = new Map();
  const items = [];
  for (const [sid, entry] of raw) {
    if (!ITEM_TYPES.has(entry.type)) continue;
    if (!entry.name) continue;
    items.push({ sid, name: entry.name, type: entry.type });
    push(byExact, entry.name, { sid, name: entry.name, type: entry.type });
    push(byNorm, normaliseName(entry.name), { sid, name: entry.name, type: entry.type });
  }
  const anyByNorm = new Map();
  for (const [sid, entry] of raw) {
    if (!entry.name) continue;
    push(anyByNorm, normaliseName(entry.name), { sid, name: entry.name, type: entry.type });
  }
  return { raw, byExact, byNorm, anyByNorm, items, stats: gamedata.indexStats() };
}

function push(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

/**
 * Read the whole stringID index. gamedataService exposes single-key lookups;
 * for a full-table join we read its cache directly, and fall back to forcing a
 * build through the service if no cache exists yet.
 */
function loadRawIndex() {
  const gamedata = require('../services/gamedataService');
  const cacheFile = path.join(__dirname, '..', '.cache', 'nameindex.json');
  if (!fs.existsSync(cacheFile)) gamedata.rebuild();
  const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  return new Map(Object.entries(cached.index));
}

/** Pick one candidate deterministically: base data first, then lowest id. */
function preferred(candidates) {
  const rank = (c) => {
    const file = c.sid.split('-').slice(1).join('-');
    if (file === 'gamedata.base') return 0;
    if (/^(rebirth|Newwworld|Dialogue)\.mod$/.test(file)) return 1;
    if (/^gamedata\./.test(file) || /^changes_/.test(file)) return 2;
    return 3;
  };
  return [...candidates].sort((a, b) => {
    const d = rank(a) - rank(b);
    if (d) return d;
    // Some gamedata stringIDs are symbolic (`SHACKLES`, `BODY`) rather than
    // `<n>-<file>`; fall back to a string compare so the order stays stable.
    const na = Number.parseInt(a.sid, 10);
    const nb = Number.parseInt(b.sid, 10);
    if (Number.isNaN(na) || Number.isNaN(nb)) return a.sid.localeCompare(b.sid);
    return na - nb;
  })[0];
}

function matchItem(item, gi) {
  // 1. The wiki itself declares the stringID. Trust it only if the local
  //    gamedata index actually contains it — otherwise it is a stale edit.
  for (const sid of item.wikiStringIds) {
    const hit = gi.raw.get(sid);
    if (hit) {
      return {
        stringId: sid,
        matchMethod: 'wiki-string-id',
        gamedataName: hit.name,
        gamedataType: hit.type,
        candidateCount: 1,
        note: ITEM_TYPES.has(hit.type) ? null : `resolves to non-item typecode ${hit.type}`,
      };
    }
  }
  if (item.wikiStringIds.length) {
    // Declared but not present locally. Record why, resolve nothing.
    return {
      stringId: null,
      matchMethod: 'unmatched',
      gamedataName: null,
      gamedataType: null,
      candidateCount: 0,
      note: `wiki stringID ${item.wikiStringIds.join(', ')} not in local gamedata index`,
    };
  }
  // 2. Exact name against item-typed gamedata records.
  const exact = gi.byExact.get(item.page);
  if (exact && exact.length) {
    const p = preferred(exact);
    return { stringId: p.sid, matchMethod: 'exact', gamedataName: p.name, gamedataType: p.type, candidateCount: exact.length, note: null };
  }
  // 3. Normalised name (case / punctuation / whitespace only).
  const norm = gi.byNorm.get(normaliseName(item.page));
  if (norm && norm.length) {
    const p = preferred(norm);
    return { stringId: p.sid, matchMethod: 'normalised', gamedataName: p.name, gamedataType: p.type, candidateCount: norm.length, note: null };
  }
  // 4. Nothing. Note it if the name exists under a typecode we excluded — that
  //    is diagnostic, not a match.
  const other = gi.anyByNorm.get(normaliseName(item.page));
  return {
    stringId: null,
    matchMethod: 'unmatched',
    gamedataName: null,
    gamedataType: null,
    candidateCount: 0,
    note: other && other.length
      ? `name exists in gamedata only under non-item typecode(s) ${[...new Set(other.map((o) => o.type))].join(', ')}`
      : null,
  };
}

/* ----------------------------------------------------------- taxonomy bits */

function taxonomyOf(item) {
  const paths = item.categoryPaths || [];
  const groups = new Set();
  const subs = new Set();
  for (const p of paths) {
    const segs = p.split(' / ');
    if (segs.length > 1) groups.add(segs[1]);
    if (segs.length > 2) subs.add(segs.slice(2).join(' / '));
  }
  const tpl = (item.template || '').toLowerCase();
  return {
    group: [...groups][0] || 'Items',
    groups: [...groups],
    subcategories: [...subs],
    categories: item.categories || [],
    kind: tpl.includes('weapon') ? 'weapon'
      : tpl.includes('equipment') || tpl.includes('armour') ? 'equipment'
      : tpl ? 'item' : null,
  };
}

/** Infobox keys worth promoting to first-class stats. Everything else stays
 *  inside `wiki.infobox` untouched — no schema is forced onto messy fields. */
const STAT_KEYS = [
  'class', 'type', 'armour type', 'weight', 'value', 'price', 'charges', 'quality',
  'damage', 'attack', 'defence', 'reach', 'blood loss', 'armour penetration',
  'damage_humans', 'damage_robots', 'damage_animals', 'cut', 'blunt',
  'cut resistance', 'blunt resistance', 'harpoon', 'coverage', 'size',
];

function statsOf(infobox) {
  const out = {};
  for (const k of STAT_KEYS) {
    if (infobox[k] != null) out[k] = infobox[k];
  }
  return out;
}

/* ------------------------------------------------------------- canonical */

/**
 * `Category:Items` is not a clean set. Its subtree drags in unique *characters*
 * (Category:Unique is NPCs, not unique items), weapon manufacturers, research
 * techs, and the category index / list pages themselves. None of those can ever
 * carry an item stringID, so counting them as "unmatched" would understate the
 * join instead of describing it. Each exclusion is recorded with its reason in
 * item-map-audit.json, so nothing disappears silently.
 *
 * `match` is passed in so the last rule can keep anything that DID resolve.
 */
function exclusionReason(raw, categorySet, match) {
  const cats = new Set(raw.categories || []);
  if (raw.isRedirectish) return 'redirect';
  if (/\//.test(raw.page) || /^Board Thread:/.test(raw.page)) return 'not an article page';
  if (cats.has('Characters')) return 'character page (Category:Unique is unique NPCs, not unique items)';
  if (cats.has('Manufacturers') || /\((manufacturer)\)$/i.test(raw.page)) return 'weapon manufacturer, not an item';
  if (cats.has('Technology') || /\(Tech\)$/.test(raw.page)) return 'research tech, not an item';
  if (cats.has('Weapon Types')) return 'weapon class page, not an item';
  // A page can share its title with a category and still be a real item
  // (`Katana` is both an item and Category:Katana), so only drop the ones with
  // no infobox — those are the list pages.
  if (categorySet.has(raw.page) && !raw.template) return 'category index page';
  if (/\bSeries$/.test(raw.page) && !raw.template) return 'book series index page';
  if (!raw.template && !match.stringId) {
    return 'no infobox and no gamedata match — list/lore page with no item data';
  }
  return null;
}

function buildCanonical(snapshot, overrides, gi) {
  const items = {};
  const seen = new Map();
  const excluded = [];
  const categorySet = new Set(
    (snapshot.categories || []).map((c) => c.category.replace(/^Category:/, ''))
  );

  for (const raw of snapshot.items) {
    const preMatch = matchItem(raw, gi);
    const reason = exclusionReason(raw, categorySet, preMatch);
    if (reason) { excluded.push({ page: raw.page, reason }); continue; }
    let id = slugId(raw.page);
    if (seen.has(id)) { id = `${id}-${raw.pageId}`; }
    seen.set(id, raw.page);

    const match = preMatch;
    const infobox = { ...raw.infobox };
    delete infobox['string id'];

    // The wiki keeps pre-rename page titles (Longsword -> Flat Topper,
    // Guardless Katana -> Slim Katana). When a resolved record disagrees with
    // the page title, gamedata wins: the picker must show what the player sees
    // in game. The wiki title survives as an alias and in `wiki.page`.
    const renamed =
      match.gamedataName && normaliseName(match.gamedataName) !== normaliseName(raw.page);
    const displayName = renamed ? match.gamedataName : raw.page;

    items[id] = {
      id,
      displayName,
      aliases: renamed ? [raw.page] : [],
      stringId: match.stringId,
      matchMethod: match.matchMethod,
      match: {
        method: match.matchMethod,
        gamedataName: match.gamedataName,
        gamedataType: match.gamedataType,
        candidateCount: match.candidateCount,
        note: match.note,
        reviewed: false,
      },
      taxonomy: taxonomyOf(raw),
      stats: statsOf(raw.infobox),
      wiki: {
        page: raw.page,
        pageId: raw.pageId,
        pageUrl: WIKI + encodeURIComponent(raw.page.replace(/ /g, '_')),
        revisionId: raw.revisionId,
        description: raw.description,
        imageFile: raw.imageFile,
        imageUrl: raw.imageFile
          ? `${WIKI}Special:Redirect/file/${encodeURIComponent(raw.imageFile.replace(/ /g, '_'))}`
          : null,
        template: raw.template,
        infobox,
      },
      sources: ['kenshi-wiki-fandom', 'gamedata-name-index'],
    };
  }

  // Two wiki pages can resolve to one gamedata record (an old-name page and a
  // current-name page both survive on the wiki). A stringID must name exactly
  // one catalog entry or the picker offers the same item twice, so merge.
  const merged = [];
  const byStringId = new Map();
  for (const item of Object.values(items)) {
    if (!item.stringId) continue;
    push(byStringId, item.stringId, item);
  }
  for (const [sid, group] of byStringId) {
    if (group.length < 2) continue;
    const richness = (i) =>
      (i.wiki && i.wiki.description ? 4 : 0) +
      (i.wiki && i.wiki.template ? 2 : 0) +
      (Object.keys(i.stats).length ? 1 : 0);
    const sorted = [...group].sort((a, b) => richness(b) - richness(a) || a.id.localeCompare(b.id));
    const winner = sorted[0];
    for (const loser of sorted.slice(1)) {
      for (const name of [loser.displayName, ...loser.aliases]) {
        if (name !== winner.displayName && !winner.aliases.includes(name)) winner.aliases.push(name);
      }
      merged.push({ droppedId: loser.id, droppedName: loser.displayName, keptId: winner.id, stringId: sid });
      delete items[loser.id];
    }
  }

  // Overrides last so a human correction always wins.
  const applied = [];
  for (const [id, patch] of Object.entries(overrides.items || {})) {
    if (id.startsWith('_')) continue;
    const { comment, ...fields } = patch;
    const base = items[id] || {
      id,
      displayName: id,
      aliases: [],
      stringId: null,
      matchMethod: 'override',
      match: { method: 'override', gamedataName: null, gamedataType: null, candidateCount: 0, note: comment || null, reviewed: true },
      taxonomy: { group: 'Items', groups: [], subcategories: [], categories: [], kind: null },
      stats: {},
      wiki: null,
      sources: ['item-overrides'],
    };
    items[id] = deepMerge(base, fields);
    items[id].id = id;
    if (fields.stringId !== undefined) {
      items[id].matchMethod = 'override';
      items[id].match = { ...items[id].match, method: 'override', note: comment || items[id].match.note, reviewed: true };
    }
    applied.push({ id, comment: comment || null });
  }

  const ordered = {};
  for (const id of Object.keys(items).sort()) ordered[id] = items[id];

  return {
    canonical: {
      schemaVersion: SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      source: {
        snapshot: 'data/wiki-items.snapshot.json',
        snapshotFetchedAt: snapshot.fetchedAt,
        overrides: 'data/item-overrides.json',
        gamedataIndex: gi.stats,
        license: LICENSE,
        attribution: snapshot.attribution,
      },
      itemTypecodes: [...ITEM_TYPES],
      items: ordered,
    },
    excluded,
    merged,
    overridesApplied: applied,
  };
}

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/* ----------------------------------------------------------------- audit */

function buildAudit(canonical, snapshot, gi, extras) {
  const entries = Object.values(canonical.items);
  const by = (m) => entries.filter((e) => e.matchMethod === m);
  const matched = entries.filter((e) => e.stringId);

  const usedSids = new Set(matched.map((e) => e.stringId));
  const gamedataUnmatched = gi.items.filter((i) => !usedSids.has(i.sid));
  const byFile = {};
  for (const i of gamedataUnmatched) {
    const file = i.sid.split('-').slice(1).join('-');
    byFile[file] = (byFile[file] || 0) + 1;
  }

  const nonItemType = matched.filter((e) => !ITEM_TYPES.has(e.match.gamedataType));

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: canonical.generatedAt,
    source: {
      snapshot: 'data/wiki-items.snapshot.json',
      snapshotFetchedAt: snapshot.fetchedAt,
      canonical: 'data/items.canonical.json',
      gamedataIndex: gi.stats,
      itemTypecodes: [...ITEM_TYPES],
    },
    counts: {
      wikiSnapshotPages: snapshot.items.length,
      wikiCategoriesVisited: snapshot.categories.length,
      excludedWikiPages: extras.excluded.length,
      canonicalItems: entries.length,
      matched: matched.length,
      unmatched: entries.length - matched.length,
      matchRatePercent: Number(((matched.length / entries.length) * 100).toFixed(1)),
      byWikiStringId: by('wiki-string-id').length,
      exact: by('exact').length,
      normalised: by('normalised').length,
      override: by('override').length,
      ambiguousNameMatches: matched.filter((e) => e.match.candidateCount > 1).length,
      matchedToNonItemTypecode: nonItemType.length,
      withDescription: entries.filter((e) => e.wiki && e.wiki.description).length,
      withImage: entries.filter((e) => e.wiki && e.wiki.imageFile).length,
      withStats: entries.filter((e) => Object.keys(e.stats).length > 0).length,
      withInfobox: entries.filter((e) => e.wiki && e.wiki.template).length,
      overridesApplied: extras.overridesApplied.length,
      mergedDuplicateStringIds: extras.merged.length,
      renamedByGamedata: entries.filter((e) => e.aliases && e.aliases.length).length,
      gamedataItemTypedStringIds: gi.items.length,
      gamedataStringIdsTotal: gi.raw.size,
      gamedataUnmatched: gamedataUnmatched.length,
    },
    gamedataUnmatchedByFile: Object.fromEntries(
      Object.entries(byFile).sort((a, b) => b[1] - a[1])
    ),
    unmatchedWikiItems: entries
      .filter((e) => !e.stringId)
      .map((e) => ({ id: e.id, displayName: e.displayName, group: e.taxonomy.group, note: e.match.note }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    ambiguousMatches: matched
      .filter((e) => e.match.candidateCount > 1)
      .map((e) => ({ id: e.id, stringId: e.stringId, candidateCount: e.match.candidateCount, method: e.matchMethod })),
    matchedToNonItemTypecode: nonItemType.map((e) => ({
      id: e.id, stringId: e.stringId, typecode: e.match.gamedataType, note: e.match.note,
    })),
    mergedDuplicates: extras.merged,
    renamedByGamedata: entries
      .filter((e) => e.aliases && e.aliases.length)
      .map((e) => ({ id: e.id, displayName: e.displayName, aliases: e.aliases, stringId: e.stringId })),
    excludedWikiPages: extras.excluded,
    overridesApplied: extras.overridesApplied,
    gamedataUnmatchedNames: gamedataUnmatched
      .map((i) => ({ stringId: i.sid, name: i.name, typecode: i.type }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/* ------------------------------------------------------------------- io */

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function rel(p) { return path.relative(path.join(__dirname, '..'), p).replace(/\\/g, '/'); }

/* ----------------------------------------------------------------- main */

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  let snapshot;
  if (opts.refresh) {
    snapshot = await refresh(opts);
  } else {
    snapshot = readJson(SNAPSHOT_FILE, null);
    if (!snapshot) {
      throw new Error(`no snapshot at ${rel(SNAPSHOT_FILE)} — run with --refresh first`);
    }
  }

  const overrides = readJson(OVERRIDES_FILE, { schemaVersion: SCHEMA_VERSION, items: {} });
  const gi = buildGamedataIndex();
  const { canonical, excluded, merged, overridesApplied } = buildCanonical(snapshot, overrides, gi);
  writeJson(CANONICAL_FILE, canonical);

  const audit = buildAudit(canonical, snapshot, gi, { excluded, merged, overridesApplied });
  writeJson(AUDIT_FILE, audit);

  const c = audit.counts;
  console.log(`${rel(CANONICAL_FILE)}: ${c.canonicalItems} items`);
  console.log(
    `  matched ${c.matched}/${c.canonicalItems} (${c.matchRatePercent}%) — ` +
    `stringID ${c.byWikiStringId}, exact ${c.exact}, normalised ${c.normalised}, override ${c.override}`
  );
  console.log(`  unmatched ${c.unmatched}; gamedata item records without a wiki page ${c.gamedataUnmatched}`);
  console.log(`${rel(AUDIT_FILE)}: written`);
}

if (require.main === module) {
  main().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
}

module.exports = {
  extractTemplates, splitTemplate, cleanValue, normaliseName, slugId, ITEM_TYPES,
};
