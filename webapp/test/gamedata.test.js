'use strict';

/**
 * Read-only tests for the item catalog/picker backend (TODO.md 2.3):
 * `gamedataService.itemTemplates()` and `GET /api/gamedata/items`.
 *
 * These hit the REAL game data files (via `pathService`), not fixtures — the
 * whole point of gamedataService is to reflect this install's actual mods,
 * per TODO.md 2.2(g)/2.3. Skip (not fail) when no install is found.
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

const paths = require('../services/pathService');
const gamedata = require('../services/gamedataService');
const itemCatalog = require('../services/itemCatalogService');
const statusRouter = require('../routes/api/status');

const hasInstall = !!paths.installDir();

function startServer() {
  return new Promise((resolve) => {
    const app = express();
    app.use(statusRouter);
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function get(server, urlPath) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (err) {
          reject(err);
        }
      });
    }).on('error', reject);
  });
}

// The set grew three times, each because a whole item class turned out to be
// unreachable: 46 (backpack) when bulk equip landed, 107 (crossbow) when the
// loadout catalogue went looking for a ranged archetype and found "Ranger" at
// a typecode nothing accepted, and 111 (robotic limb) when a user searched for
// a "KLR Series Arm (left)" and got nothing. A sweep of all 123 files of a live
// save (6103 ITEM records) then settled it: exactly these six typecodes ever
// back an item. See services/itemFactory.js and the equip suite's
// "every typecode that backs a live item is offered" test.
test('itemTemplates() filters to typecodes {2, 3, 4, 46, 107, 111} and is non-empty', (t) => {
  if (!hasInstall) return t.skip('no Kenshi install found');
  const templates = gamedata.itemTemplates();
  assert.ok(templates.length > 0, 'itemTemplates() returned nothing');
  for (const tpl of templates) {
    assert.ok([2, 3, 4, 46, 107, 111].includes(tpl.type), `sid ${tpl.sid} has unexpected type ${tpl.type}`);
  }
  assert.ok(templates.some((tpl) => tpl.type === 46), 'no backpack template offered');
  assert.ok(templates.some((tpl) => tpl.type === 107), 'no crossbow template offered');
  assert.ok(templates.some((tpl) => tpl.type === 111), 'no robotic-limb template offered');
});

// Regression test for TODO.md 2.2(g): the original 2.3 task text said "filter
// gamedata to type 42" — that is WRONG. Type 42 is the save-side ITEM
// *instance* record; a gamedata TEMPLATE is typecode 2/3/4. Guard against
// that mistake creeping back in.
test('itemTemplates() never returns typecode 42 (the 2.2(g) bug this corrects)', (t) => {
  if (!hasInstall) return t.skip('no Kenshi install found');
  const templates = gamedata.itemTemplates();
  assert.ok(
    !templates.some((tpl) => tpl.type === 42),
    'a type-42 (save-side ITEM instance) record leaked into the template list — see TODO.md 2.2(g)'
  );
});

test('GET /api/gamedata/items: every row carries the documented fields', async (t) => {
  if (!hasInstall) return t.skip('no Kenshi install found');
  const server = await startServer();
  try {
    const { status, body } = await get(server, '/gamedata/items?limit=200');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.items));
    assert.ok(body.items.length > 0);
    for (const item of body.items) {
      assert.equal(typeof item.sid, 'string');
      assert.equal(typeof item.name, 'string');
      assert.ok([2, 3, 4, 46, 107, 111].includes(item.type));
      assert.ok(['weapon', 'armour', 'trade goods', 'backpack', 'crossbow', 'limb'].includes(item.kind),
        `${item.name} has kind "${item.kind}" — every offered typecode needs a kind label`);
      assert.equal(typeof item.stackable, 'boolean', `stackable must be a boolean, got ${typeof item.stackable} for ${item.sid}`);
      assert.ok(item.category === null || typeof item.category === 'string');
      assert.ok(item.description === null || typeof item.description === 'string');
      assert.ok(Array.isArray(item.allowedSections));
      assert.equal(typeof item.slotsWidened, 'boolean');
    }
  } finally {
    server.close();
  }
});

test('GET /api/gamedata/items: q narrows the result set, case-insensitively', async (t) => {
  if (!hasInstall) return t.skip('no Kenshi install found');
  const server = await startServer();
  try {
    const unfiltered = await get(server, '/gamedata/items?q=');
    const fullTotal = unfiltered.body.total;
    assert.ok(fullTotal > 0);

    // Pick a template with a name specific enough that searching for it
    // narrows the set (not just re-returns everything).
    const templates = gamedata.itemTemplates();
    const target = templates.find((tpl) => tpl.name && tpl.name.length >= 4);
    assert.ok(target, 'no template with a usable name found to search for');

    const lower = await get(server, `/gamedata/items?q=${encodeURIComponent(target.name.toLowerCase())}&limit=500`);
    const upper = await get(server, `/gamedata/items?q=${encodeURIComponent(target.name.toUpperCase())}&limit=500`);

    assert.ok(lower.body.total > 0, 'search for a known item name returned nothing');
    assert.ok(lower.body.total <= fullTotal, 'search must narrow (or at most match) the full set');
    assert.equal(lower.body.total, upper.body.total, 'search must be case-insensitive');
    assert.deepEqual(
      lower.body.items.map((i) => i.sid).sort(),
      upper.body.items.map((i) => i.sid).sort(),
      'upper/lower-case search must return the same rows'
    );
    for (const item of lower.body.items) {
      assert.ok(item.name.toLowerCase().includes(target.name.toLowerCase()), `${item.name} does not contain ${target.name}`);
    }
    assert.ok(lower.body.items.some((i) => i.sid === target.sid), 'the exact template searched for was not found by its own name');
  } finally {
    server.close();
  }
});

test('GET /api/gamedata/items: limit is respected and clamped', async (t) => {
  if (!hasInstall) return t.skip('no Kenshi install found');
  const server = await startServer();
  try {
    const small = await get(server, '/gamedata/items?limit=5');
    assert.ok(small.body.items.length <= 5);

    const huge = await get(server, '/gamedata/items?limit=999999');
    assert.ok(huge.body.items.length <= 500, 'limit must be hard-capped, never unbounded');
    if (huge.body.total > 500) assert.equal(huge.body.items.length, 500, 'a total above the hard cap must return exactly the cap');

    const invalid = await get(server, '/gamedata/items?limit=not-a-number');
    assert.ok(invalid.body.items.length <= 50, 'an invalid limit must fall back to a sane default, not throw or return everything');
    assert.equal(invalid.status, 200);

    const negative = await get(server, '/gamedata/items?limit=-5');
    assert.equal(negative.status, 200);
    assert.ok(negative.body.items.length > 0, 'a non-positive limit must fall back to the default, not return zero rows');
  } finally {
    server.close();
  }
});

test('GET /api/gamedata/items: a catalogued item is decorated, an uncatalogued one is not (and neither throws)', async (t) => {
  if (!hasInstall) return t.skip('no Kenshi install found');
  const server = await startServer();
  try {
    const templates = gamedata.itemTemplates();
    const catalogued = templates.find((tpl) => itemCatalog.lookup(tpl.sid) !== null);
    const uncatalogued = templates.find((tpl) => itemCatalog.lookup(tpl.sid) === null);
    assert.ok(catalogued, 'no catalogued item template found to test against (data/items.canonical.json vs. this install)');
    assert.ok(uncatalogued, 'no uncatalogued item template found to test against');

    const res = await get(server, `/gamedata/items?q=${encodeURIComponent(catalogued.name)}&limit=500`);
    assert.equal(res.status, 200);
    const hit = res.body.items.find((i) => i.sid === catalogued.sid);
    assert.ok(hit, `catalogued template ${catalogued.sid} (${catalogued.name}) not found in its own name search`);
    assert.ok(hit.category !== null || hit.description !== null, `catalogued item ${catalogued.sid} came back with no enrichment at all`);

    const res2 = await get(server, `/gamedata/items?q=${encodeURIComponent(uncatalogued.name)}&limit=500`);
    assert.equal(res2.status, 200);
    const miss = res2.body.items.find((i) => i.sid === uncatalogued.sid);
    assert.ok(miss, `uncatalogued template ${uncatalogued.sid} (${uncatalogued.name}) not found in its own name search`);
    assert.equal(miss.category, null);
    assert.equal(miss.description, null);
  } finally {
    server.close();
  }
});

// The weapon grade ladder (TODO.md 2.2(i)) backs the "Add item" picker's
// quality control for weapons. A weapon's grade is the (company sid, material
// sid) pair; `addItem` takes the entry's `modelSid` as its `materialSid`
// option, so these two fields are a load-bearing contract, not decoration.
test('GET /api/gamedata/weapon-grades returns an ordered, well-formed ladder', async (t) => {
  if (!hasInstall) return t.skip('no Kenshi install found');
  const server = await startServer();
  try {
    const { status, body } = await get(server, '/gamedata/weapon-grades');
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(body.grades), 'grades must be an array');
    assert.ok(body.grades.length > 0, 'ladder is empty');

    for (const g of body.grades) {
      for (const key of ['companySid', 'companyName', 'modelSid', 'modelName', 'rank']) {
        assert.ok(g[key] !== undefined, `grade row missing "${key}": ${JSON.stringify(g)}`);
      }
      assert.strictEqual(typeof g.rank, 'number', `rank must be numeric: ${JSON.stringify(g)}`);
    }

    // Ordered by rank ascending — the UI renders it as a worst-to-best ladder,
    // and addItem defaults to grades[0] when the caller picks nothing, so a
    // mis-sorted list would silently hand out the wrong default.
    for (let i = 1; i < body.grades.length; i++) {
      assert.ok(body.grades[i].rank >= body.grades[i - 1].rank, 'ladder is not sorted by rank');
    }

    // De-duplicated on (company, model): the same pair is defined in several
    // data files and must not appear twice in a dropdown.
    const pairs = body.grades.map((g) => `${g.companySid}|${g.modelSid}`);
    assert.strictEqual(pairs.length, new Set(pairs).size, 'ladder contains duplicate (company, model) pairs');
  } finally {
    server.close();
  }
});
