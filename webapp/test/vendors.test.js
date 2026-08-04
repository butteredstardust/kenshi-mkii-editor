'use strict';

const test = require('node:test');
const assert = require('node:assert');

const paths = require('../services/pathService');
const vendors = require('../services/vendorsService');
const gamedata = require('../services/gamedataService');
const locations = require('../services/locationsService');

/**
 * Vendor stock is NOT in the save — shops roll their inventory at runtime. It
 * is built from a gamedata chain (town -> squad -> vendor list -> item), so
 * every test here is read-only and needs only an install.
 */
const hasInstall = !!paths.installDir();

test('the vendor chain resolves town -> shop -> stock', (t) => {
  if (!hasInstall) return t.skip('no Kenshi install found');
  const all = vendors.all();
  assert.ok(all.length > 0, 'no shops found at all');

  const s = vendors.stats();
  assert.ok(s.shops > 100, `only ${s.shops} shops — the union-of-definitions rule is probably not being applied`);
  assert.ok(s.towns > 50, `only ${s.towns} towns have shops`);

  for (const shop of all) {
    assert.ok(shop.id.includes('|'), 'a shop id is "<townSid>|<squadSid>"');
    assert.ok(shop.town && shop.shop, JSON.stringify(shop));
    assert.ok(shop.items.length > 0, `${shop.shop} has no stock but was kept`);
    assert.ok(shop.lists.length > 0, `${shop.shop} has no vendor list`);
  }
  const ids = all.map((x) => x.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'shop ids must be unique');
});

test('every item a shop offers is one this editor can actually add', (t) => {
  if (!hasInstall) return t.skip('no Kenshi install found');
  // A vendor list also names tech (21), map (102) and manufacturer (51)
  // records. Those are real stock but not templates addItem can mint, so
  // offering them would put a button on the page that always fails.
  for (const shop of vendors.all()) {
    for (const it of shop.items) {
      const tmpl = gamedata.lookup(it.sid);
      assert.ok(tmpl, `${shop.shop} offers unresolvable ${it.sid}`);
      assert.ok(gamedata.ITEM_TEMPLATE_TYPES.has(tmpl.type),
        `${shop.shop} offers "${it.name}" (typecode ${tmpl.type}), which addItem would refuse`);
      assert.strictEqual(it.type, tmpl.type);
    }
  }
});

test('the union-of-definitions rule is what makes Black Desert City work', (t) => {
  if (!hasInstall) return t.skip('no Kenshi install found');
  // The regression this guards: Black Desert City's FIRST definition carries
  // only extra['faction']. Its residents — including the robotics shop the
  // whole feature was traced from — are attached by a later definition, so
  // first-definition-wins reports the city as having no shops at all.
  const bdc = vendors.all().filter((s) => s.town === 'Black Desert City');
  if (!bdc.length) return t.skip('this install has no Black Desert City');
  assert.ok(bdc.length >= 3, `only ${bdc.length} shop(s) in Black Desert City`);
  const robotics = bdc.find((s) => /robotic/i.test(s.shop));
  assert.ok(robotics, 'no robotics shop in Black Desert City');
  assert.ok(robotics.items.some((i) => /KLR Series Arm/i.test(i.name)),
    'the robotics shop should stock the KLR arms — that is the case this was traced from');
});

test('the reverse lookup finds every shop carrying a template', (t) => {
  if (!hasInstall) return t.skip('no Kenshi install found');
  const anyShop = vendors.all().find((s) => s.items.length);
  const item = anyShop.items[0];
  const carriers = vendors.shopsCarrying(item.sid);
  assert.ok(carriers.some((c) => c.id === anyShop.id),
    `${anyShop.shop} stocks ${item.name} but the reverse lookup missed it`);
  for (const c of carriers) assert.ok(vendors.find(c.id), `${c.id} is not a real shop id`);
  assert.deepStrictEqual(vendors.shopsCarrying('not-a-real-sid'), []);
});

test('the tree groups by faction and town without losing a shop', (t) => {
  if (!hasInstall) return t.skip('no Kenshi install found');
  const tree = vendors.tree();
  assert.ok(tree.length > 1, 'expected several factions');
  let counted = 0;
  for (const f of tree) {
    assert.ok(f.faction, 'a faction group needs a name');
    for (const town of f.towns) {
      assert.ok(town.town && town.shops.length);
      counted += town.shops.length;
    }
  }
  assert.strictEqual(counted, vendors.all().length, 'the tree dropped or duplicated shops');

  // Towns are keyed to the placement catalogue where one exists, so the
  // Vendors page and the teleport picker agree about which town is which.
  for (const shop of vendors.all()) {
    if (!shop.locationId) continue;
    assert.ok(locations.find(shop.locationId), `${shop.town} -> ${shop.locationId} is not a real location`);
  }
});
