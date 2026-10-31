/* The stylesheet keeps to STYLE-GUIDE.md: colours from variables, sizes, radii and tracking from the scales.
   Violations already there are listed in tests/style-baseline.json; see tests/style.js. */
const test = require('node:test'), assert = require('node:assert/strict');
const { staticViolations, compare, report } = require('./style');

const found = staticViolations();
for (const check of Object.keys(found)) test('style: ' + check, () => {
  const c = compare(check, found[check]);
  assert.ok(!c.added.length && !c.fixed.length, report(check, c));
});
