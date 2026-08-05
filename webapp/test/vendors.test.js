'use strict';

const test = require('node:test');
const assert = require('node:assert');

const paths = require('../services/pathService');
const vendors = require('../services/vendorsService');
const gamedata = require('../services/gamedataService');
const locations = require('../services/locationsService');
const itemSlots = require('../services/itemSlots');
const itemFactory = require('../services/itemFactory');

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

test('every row is listed, and `addable` agrees with what addItem would accept', (t) => {
  if (!hasInstall) return t.skip('no Kenshi install found');
  // Nothing is hidden: a shop that sells research tech should SAY so rather
  // than look like it sells nothing. What must hold is that the `addable` flag
  // never lies — an Add button that always fails is worse than no button.
  let addable = 0; let blocked = 0;
  for (const shop of vendors.all()) {
    for (const it of shop.items) {
      const tmpl = gamedata.lookup(it.sid);
      assert.ok(tmpl, `${shop.shop} offers unresolvable ${it.sid}`);
      assert.strictEqual(it.type, tmpl.type);
      // A blueprint row is addable regardless of its SUBJECT's typecode — what
      // gets minted is the blueprint item template, not the subject. Everything
      // else still has to be a template addItem() would accept.
      const expected = it.blueprint
        ? gamedata.ITEM_TEMPLATE_TYPES.has(gamedata.lookup(it.blueprint.templateSid).type)
        : gamedata.ITEM_TEMPLATE_TYPES.has(tmpl.type);
      assert.strictEqual(it.addable, expected,
        `"${it.name}" (typecode ${tmpl.type}) is marked addable=${it.addable}`);
      if (it.addable) { addable++; } else { blocked++; assert.ok(it.reason, `${it.name} is blocked with no reason given`); }
    }
  }
  assert.ok(addable > 0 && blocked > 0, 'expected both addable and non-addable rows');
});

test('a map is addable — the gap that hiding non-addable rows was masking', (t) => {
  if (!hasInstall) return t.skip('no Kenshi install found');
  const maps = gamedata.itemTemplates().filter((x) => x.type === 102);
  if (!maps.length) return t.skip('no typecode-102 templates in this install');

  // A map has every hallmark of an item — weight, value, stackable, icon, mesh,
  // inventory footprint — and 39 live ones exist in the install's own level
  // files. It was excluded only because no save this player owns contains one.
  const { sections, widened } = itemSlots.allowedSections(maps[0].sid, null);
  assert.deepStrictEqual(sections, ['main', 'backpack_content'], 'a map is carried, never worn');
  assert.strictEqual(widened, false);

  const { record } = itemFactory.buildItemRecord(maps[0].sid, { section: 'main' });
  // Copied from all 39 live map items, which agree on every one of these.
  assert.ok(!record.strings.has('uniform'), 'no live map item has a "uniform" key');
  assert.strictEqual(record.strings.get('material sid'), '',
    'a map mints an EMPTY material sid even though its template carries an extra[material] row');
  assert.strictEqual(record.strings.get('company sid'), '');
  assert.strictEqual(record.ints.get('item function'), 0);
  assert.strictEqual(record.ints.get('level'), 0);
  assert.strictEqual(record.floats.get('quality'), 100);
  assert.strictEqual(record.floats.get('charges'), 1);
  assert.deepStrictEqual([...record.floats.keys()], ['charges', 'quality']);

  // And a shop somewhere actually sells one.
  assert.ok(vendors.all().some((s) => s.items.some((i) => i.type === 102 && i.addable)),
    'no shop offers an addable map');
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
