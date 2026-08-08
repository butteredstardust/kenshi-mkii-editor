'use strict';

/**
 * The Acknowledgements page's source (`routes/api/about.js`).
 *
 * Nothing here touches a save. What it guards is a licence obligation: the
 * item catalogue derives from the Kenshi Wiki under CC BY-SA 3.0, and the
 * attribution the app shows has to be the real `ACKNOWLEDGEMENTS.md` rather
 * than a copy that can drift away from it. So these assert that the file is
 * found from the route's own location, and that the clauses the licence
 * actually requires are in what gets served.
 *
 * The route resolves the file by probing two paths — next to `server.js`
 * (where releases/build.ps1 puts it in a packaged install) and the repo root
 * (where it lives in a source checkout). A test that read the repo root
 * directly would pass while the route returned a 404, so this drives the
 * route's own handler.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const router = require('../routes/api/about');

/** Invoke the mounted GET /about handler and return its JSON body. */
function get() {
  const layer = router.stack.find((l) => l.route && l.route.path === '/about');
  assert.ok(layer, 'GET /about is not mounted');
  const handler = layer.route.stack[0].handle;
  return new Promise((resolve, reject) => {
    handler({ method: 'GET' }, {
      json: resolve,
      status(code) { return { json: (body) => reject(new Error(`${code}: ${body.error}`)) }; },
    });
  });
}

test('the notices are served from the real file on disk', async () => {
  const about = await get();
  assert.ok(fs.existsSync(about.source), `reported source does not exist: ${about.source}`);
  assert.equal(path.basename(about.source), 'ACKNOWLEDGEMENTS.md');
  assert.equal(about.markdown, fs.readFileSync(about.source, 'utf8'),
    'served text differs from the file it claims to come from');
});

test('the CC BY-SA attribution the item data requires is in what is served', async () => {
  const { markdown } = await get();
  for (const clause of ['CC BY-SA 3.0', 'kenshi.fandom.com', 'MIT License', 'unofficial']) {
    assert.ok(markdown.includes(clause), `ACKNOWLEDGEMENTS.md no longer states: ${clause}`);
  }
});

test('the build stamp names the version and the one runtime dependency', async () => {
  const about = await get();
  const pkg = require('../package.json');
  assert.equal(about.version, pkg.version);
  assert.equal(about.name, pkg.name);
  // AGENTS.md §4: express is the only runtime dependency, and the page is
  // where that claim is visible to a user. If a second one appears, this test
  // is the reminder that ACKNOWLEDGEMENTS.md needs an entry for it.
  assert.deepEqual(Object.keys(about.dependencies), ['express']);
});
