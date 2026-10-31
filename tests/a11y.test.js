/* Every view, in every theme, at phone and desktop width: axe's WCAG checks, plus the guide's 44px targets,
   3:1 field edges and loaded font weights. Violations already there are listed in tests/style-baseline.json. */
const test = require('node:test'), assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { html, serve } = require('./helpers');
const { browserViolations, compare, report } = require('./style');

let found;
test.before(async () => {
  const { server, base } = await serve(html);
  const browser = await chromium.launch();
  try { found = await browserViolations(browser, base); } finally { await browser.close(); server.close(); }
});

for (const check of ['axe', 'target-44', 'field-edge', 'font-weight']) test('a11y: ' + check, () => {
  const c = compare(check, found[check]);
  assert.ok(!c.added.length && !c.fixed.length, report(check, c));
});
