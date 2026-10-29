/* End-to-end checks in a real browser. The app is served from memory with a small hook added, so a test can
   feed it hits at exact times instead of playing. Nothing is changed on disk. */
const test = require('node:test'), assert = require('node:assert/strict');
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const { ROOT, html } = require('./helpers');

const page = html.replace('let heardTimer=0;', 'window.__T={hit:handleHit,run:()=>run,S:()=>S};let heardTimer=0;');
assert.ok(page !== html, 'the test hook did not attach: has handleHit moved?');

let server, base, browser;
test.before(async () => {
  server = http.createServer((req, res) => {
    const u = req.url.split('?')[0];
    if (u === '/' || u === '/index.html') { res.setHeader('content-type', 'text/html'); return res.end(page); }
    const f = path.join(ROOT, u);
    if (f.startsWith(ROOT) && fs.existsSync(f) && fs.statSync(f).isFile()) return res.end(fs.readFileSync(f));
    res.statusCode = 404; res.end();
  });
  await new Promise(r => server.listen(0, r));
  base = 'http://localhost:' + server.address().port + '/';
  browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
});
test.after(async () => { await browser.close(); server.close(); });

/* A fresh browser profile, with settings put in storage before the app starts. */
async function open(settings, size, init) {
  const ctx = await browser.newContext({ viewport: size || { width: 390, height: 900 } });
  const p = await ctx.newPage();
  p.errors = [];
  p.on('pageerror', e => p.errors.push(e.message));
  await p.addInitScript(s => {
    if (s && !localStorage.getItem('stick-timing-trainer.v1')) localStorage.setItem('stick-timing-trainer.v1', JSON.stringify({ settings: s, cal: null }));
  }, settings);
  if (init) await p.addInitScript(init);
  await p.goto(base);
  await p.waitForTimeout(300);
  return p;
}

test('the page starts with no errors and the right title', async () => {
  const p = await open({});
  assert.equal(await p.title(), 'Pocket - your pad practice coach');
  assert.deepEqual(p.errors, []);
  assert.match(await p.textContent('.app'), /Set up/);
  assert.equal(await p.isDisabled('#startBtn'), true);   /* Start waits for mic, Mic check and latency */
});

test('Help opens and the Try it buttons load their exercise', async () => {
  const p = await open({ seeded: true });
  await p.click('#helpBtn').catch(async () => { await p.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Help').click()); });
  await p.waitForTimeout(300);
  const tries = await p.evaluate(() => document.querySelectorAll('[data-try]').length);
  assert.ok(tries >= 5, 'Try it buttons found: ' + tries);
  assert.deepEqual(p.errors, []);
});

/* Plays a routine by calling the hit handler with times relative to the run. */
async function playScenario(text, bpm, spec) {
  const p = await open({ input: 'kb', bpm, routineText: text, seeded: true });
  await p.evaluate(() => [...document.querySelectorAll('button')].find(b => /^Start/.test(b.textContent.trim()) && b.offsetParent).click());
  await p.waitForFunction(() => window.__T.run() && window.__T.run().plan, null, { timeout: 8000 });
  await p.evaluate(spec => {
    const T = window.__T, r = T.run(), pl = r.plan;
    pl.slots.forEach((s, i) => {
      const note = pl.segs[s.seg].notes[s.pos], hand = note.slice(-1), other = hand === 'R' ? 'L' : 'R';
      const hit = (t, h) => T.hit({ t: r.t0 + t, kb: true, f: null, det: { hand: h, conf: 1 } });
      if (s.gr) (spec.pre || []).forEach(d => hit(s.t - d, other));
      if (spec.stray === i && !s.gr) hit(s.t - 0.04, other);
      hit(s.t + 0.005, hand);
    });
  }, spec);
  await p.waitForFunction(() => window.__T.run().ended, null, { timeout: 40000 });
  const r = await p.evaluate(() => { const r = window.__T.run(); return { slots: r.slots, miss: r.miss, within: r.within, extras: r.extras }; });
  assert.deepEqual(p.errors, []);
  return r;
}

test('flam grace notes are not extras, and the main stroke is scored', async () => {
  const r = await playScenario('8 fR fL R L x2', 120, { pre: [0.03] });
  assert.deepEqual(r, { slots: 8, miss: 0, within: 8, extras: 0 });
});

test('drag grace notes at a fast tempo are not extras', async () => {
  const r = await playScenario('16 dR dL R L x2', 120, { pre: [0.1, 0.05] });
  assert.deepEqual(r, { slots: 8, miss: 0, within: 8, extras: 0 });
});

test('a stray hit before a plain stroke is still an extra', async () => {
  const r = await playScenario('8 R L R L x2', 120, { stray: 2 });
  assert.equal(r.extras, 1);
  assert.equal(r.miss, 0);
});

test('saved titles survive a reload, including long single exercises', async () => {
  const p = await open({ seeded: true });
  await p.click('#tabLibrary');
  await p.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Import').click());
  await p.setInputFiles('#routineFile', path.join(ROOT, 'routines/rudiments.txt'));
  await p.waitForTimeout(600);
  await p.reload();
  await p.waitForTimeout(400);
  await p.click('#tabLibrary');
  await p.waitForTimeout(300);
  const untitled = await p.evaluate(() => [...document.querySelectorAll('#libPage > .hrow .hn')].map(e => e.textContent));
  assert.deepEqual(untitled, [], 'routines that lost their title: ' + untitled.join(' | '));
});

test('builder: flam holds until a stroke, greys the other keys, and writes fR', async () => {
  const p = await open({ seeded: true, routineText: '8 RL' });
  await p.click('#editPlay');
  await p.waitForTimeout(300);
  const off = () => p.evaluate(() => [...document.querySelectorAll('.bkey')].filter(k => k.disabled).map(k => k.dataset.k));
  assert.deepEqual(await off(), []);
  await p.click('.bkey[data-k="flam"]');
  assert.deepEqual((await off()).sort(), ['_', 'back', 'clear', 'group', 'swap']);
  await p.click('.bkey[data-k="drag"]');
  assert.equal(await p.getAttribute('.bkey[data-k=drag]', 'aria-pressed'), 'true');
  await p.click('.bkey[data-k="drag"]');
  assert.deepEqual(await off(), []);
  await p.click('.bkey[data-k="flam"]');
  await p.click('.bkey[data-k="R"]');
  assert.equal(await p.inputValue('#routineText'), '8 RLfR');
  assert.deepEqual(await off(), []);
  assert.deepEqual(p.errors, []);
});

test('editor: Discard puts a saved routine back', async () => {
  const p = await open({ seeded: true, routineText: 'title: Mine\n8 RLRL RLRL' });
  await p.click('#editPlay');
  await p.click('#saveBtn');
  await p.click('.bkey[data-k="flam"]');
  await p.click('.bkey[data-k="R"]');
  assert.equal(await p.textContent('#edState'), 'Unsaved');
  await p.click('#edDiscard');
  assert.equal(await p.textContent('#edDiscard'), 'Discard?');
  await p.click('#edDiscard');
  assert.equal(await p.inputValue('#routineText'), 'title: Mine\n8 RLRL RLRL');
  assert.equal(await p.textContent('#edState'), 'Saved');
});

test('destructive buttons ask twice', async () => {
  const p = await open({ seeded: true });
  await p.click('#tabSettings').catch(() => {});
  const label = await p.evaluate(() => {
    const b = document.getElementById('recClear');
    b.click();
    return b.textContent + '|' + b.classList.contains('arm');
  });
  assert.equal(label, 'Clear all?|true');
});

test('a stray exercise is deleted from a run, and an unheard one is not scored', async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const p = await ctx.newPage();
  p.errors = [];
  p.on('pageerror', e => p.errors.push(e.message));
  await p.addInitScript(() => {
    if (localStorage.getItem('seeded-by-test')) return;
    localStorage.setItem('seeded-by-test', '1');
    const ex = (k, i, w, h) => ({ k, bpm: 60, due: 32, within: w, heard: h, avg: h ? -2.7 : null, sd: h ? 3 : null, miss: 0, i });
    localStorage.setItem('stick-timing-trainer.records.v2', JSON.stringify({ v: 1, names: { pabc: 'Mine' }, nu: 1, lib: [], runs: [{
      id: 'r1', t: Date.now(), mode: 'routine', rk: 'pabc', lv: 'beat', dy: '', ne: 3, bpm: 60, tol: 20, sec: 120,
      exercises: [ex('8 RLRL RLRL', 1, 30, 32), ex('8 RRLL RRLL', 2, 26, 32), ex('8 dLfR', 3, 0, 0)],
      rp: { x: 'RLRL RLRL\nRRLL RRLL\ndLfR', st: 1, ev: 8, eu: 'pass', gp: 0, o: null } }] }));
    localStorage.setItem('stick-timing-trainer.v1', JSON.stringify({ settings: { seeded: true, noise: -50, latCal: true }, cal: null }));
  });
  await p.goto(base);
  await p.waitForTimeout(300);
  await p.click('#tabProgress');
  await p.locator('.lrow', { hasText: 'Mine' }).first().click();
  const text = () => p.evaluate(() => [...document.querySelectorAll('#pg')].map(x => x.innerText).join('|'));
  let t = await text();
  assert.match(t, /1 not played/);            /* nothing was heard in the last exercise */
  assert.doesNotMatch(t, /dLfR[\s\S]*ACC/);    /* it is not scored, so it cannot be the weakest */
  await p.evaluate(() => { document.querySelector('details').open = true; document.querySelector('details .ib').click(); });
  const del = () => p.evaluate(() => [...document.querySelectorAll('.rmenu button')].find(x => /^Delete/.test(x.textContent)).click());
  await del(); await del();
  await p.waitForTimeout(300);
  t = await text();
  assert.doesNotMatch(t, /\d not played/);
  assert.match(t, /88%/);                      /* both exercises were played, so the run now has an overall score */
  const saved = await p.evaluate(() => JSON.parse(localStorage.getItem('stick-timing-trainer.records.v2')).runs[0]);
  assert.equal(saved.ne, 2);
  assert.deepEqual(p.errors, []);
  await ctx.close();
});

/* One keyboard run with perfect hits. Returns how many runs were saved and the result text. */
async function runOnce(settings, practice, init) {
  const p = await open(Object.assign({ input: 'kb', bpm: 120, routineText: '8 RLRL', eachUnit: 'pass', eachVal: 1, seeded: true }, settings), null, init);
  if (practice) await p.evaluate(() => { const s = document.getElementById('score'); s.value = '0'; s.dispatchEvent(new Event('change')); });
  await p.evaluate(() => [...document.querySelectorAll('button')].find(b => /^Start/.test(b.textContent.trim()) && b.offsetParent).click());
  await p.waitForFunction(() => window.__T.run() && window.__T.run().plan, null, { timeout: 8000 });
  await p.evaluate(() => {
    const T = window.__T, r = T.run(), pl = r.plan;
    pl.slots.forEach(s => {
      const hand = pl.segs[s.seg].notes[s.pos].slice(-1);
      T.hit({ t: r.t0 + s.t + 0.005, kb: true, f: null, det: { hand, conf: 1 } });
    });
  });
  await p.waitForFunction(() => window.__T.run().ended, null, { timeout: 40000 });
  await p.waitForTimeout(300);
  const out = await p.evaluate(() => ({
    saved: ((JSON.parse(localStorage.getItem('stick-timing-trainer.records.v2')) || {}).runs || []).map(r => r.lv),
    text: document.getElementById('advice').innerText,
    discard: !document.getElementById('advDiscard').hidden,
    win: document.getElementById('advWin').hidden ? '' : document.getElementById('advWin').textContent,
    next: document.getElementById('advNext').textContent,
    tag: document.getElementById('tag').textContent,
    days: ((JSON.parse(localStorage.getItem('stick-timing-trainer.records.v2')) || {}).sum || {}).days || {},
  }));
  assert.deepEqual(p.errors, []);
  return out;
}

test('Master (count-in only) is scored and saved', async () => {
  const o = await runOnce({ click: 'none' }, false);
  assert.deepEqual(o.saved, ['none']);
  assert.ok(o.discard);
});

test('a practice run shows its result but saves nothing', async () => {
  const o = await runOnce({ click: 'beat' }, true);
  assert.deepEqual(o.saved, []);
  assert.match(o.text, /Practice run, not saved/);
  assert.ok(!o.discard);
});

test('a practice run still counts its time, and the header shows it', async () => {
  const o = await runOnce({ click: 'beat' }, true);
  assert.equal(Object.keys(o.days).length, 1);
  assert.match(o.tag, /^No streak yet · today \d+ of 5 min$/);
});

test('a new badge is announced on the result, with the next one in sight', async () => {
  const seed = () => {
    if (localStorage.getItem('seeded-runs')) return;
    localStorage.setItem('seeded-runs', '1');
    const run = i => ({ id: 'r' + i, t: Date.now() - 86400000 * (i + 1), mode: 'single', rk: null, lv: 'beat', dy: '', ne: 1, bpm: 60, tol: 20, sec: 60,
      exercises: [{ k: '8 RLRL', bpm: 60, due: 16, within: 8, heard: 16, avg: 0, sd: 3, miss: 0, i: 1 }] });
    localStorage.setItem('stick-timing-trainer.records.v2', JSON.stringify({ v: 1, names: {}, nu: 1, lib: [], runs: [0, 1, 2, 3].map(run) }));
  };
  const o = await runOnce({ click: 'beat' }, false, seed);
  assert.match(o.win, /New badge: 5 runs/);
  assert.match(o.next, /^Next badge: /);
});
