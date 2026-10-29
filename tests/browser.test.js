/* End-to-end checks in a real browser. The app is served from memory with a small hook added, so a test can
   feed it hits at exact times instead of playing. Nothing is changed on disk. */
const test = require('node:test'), assert = require('node:assert/strict');
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
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

test('Clear asks what to wipe, starts with nothing ticked, and asks twice', async () => {
  const p = await open({ seeded: true });
  await p.click('#tabSettings').catch(() => {});
  await p.evaluate(() => document.getElementById('recClear').click());
  const r = await p.evaluate(() => ({ parts: [...document.querySelectorAll('#exOpts input')].map(c => c.dataset.k + ':' + c.checked), off: document.getElementById('exGo').disabled, redo: !!document.getElementById('redoSetup') }));
  assert.deepEqual(r.parts, ['hist:false', 'lib:false', 'lists:false', 'set:false', 'dev:false']);
  assert.equal(r.off, true);
  assert.equal(r.redo, false);
  await p.evaluate(() => document.querySelector('#exOpts input[data-k=dev]').click());
  const label = await p.evaluate(() => { const b = document.getElementById('exGo'); b.click(); return b.textContent + '|' + b.classList.contains('arm'); });
  assert.equal(label, 'Clear?|true');
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
    badge: document.getElementById('advBadge').hidden ? '' : document.getElementById('advBadge').innerText,
    next: document.getElementById('advNext').textContent,
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

test('a practice run still counts its time toward the day', async () => {
  const o = await runOnce({ click: 'beat' }, true);
  assert.equal(Object.keys(o.days).length, 1);
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
  assert.match(o.badge, /Unlocked/i);
  assert.match(o.badge, /Next: /);
  assert.match(o.badge, /step \d+ of \d+/i);
  assert.doesNotMatch(o.badge, /undefined|NaN/);
});

test('staff rows stack their label above the staff, whatever else is on the page', async () => {
  const p = await open({ seeded: true, input: 'kb' });
  const d = await p.evaluate(() => { const r = document.querySelector('#rowsTrack .prow'); return r ? getComputedStyle(r).display : 'none'; });
  assert.equal(d, 'grid');
});

test('no empty box sits between the tabs and the page on any tab', async () => {
  const p = await open({ seeded: true, input: 'kb' });
  for (const t of ['Play', 'Library', 'Progress', 'Settings']) {
    await p.evaluate(t => [...document.querySelectorAll('.switch.tabs button')].find(x => x.textContent.trim() === t).click(), t);
    await p.waitForTimeout(150);
    const gap = await p.evaluate(() => {
      const tabs = document.querySelector('.switch.tabs').getBoundingClientRect().bottom;
      const pg = [...document.querySelectorAll('main > [id^=page]')].find(x => !x.hidden);
      return pg.getBoundingClientRect().top - tabs;
    });
    assert.ok(gap <= 24, t + ' gap ' + gap);
  }
});

test('the exercise list starts collapsed, Start is full width and the time sits in the Tempo box', async () => {
  const text = 'title: Test\n' + Array.from({ length: 24 }, () => '8 RLRL RLRL').join('\n') + '\n';
  const p = await open({ seeded: true, input: 'kb', mode: 'routine', routineText: text, bpm: 70, eachUnit: 'pass', eachVal: 8 }, { width: 390, height: 844 });
  const r = await p.evaluate(() => {
    const w = x => document.getElementById(x).getBoundingClientRect();
    return {
      open: document.getElementById('exBox').open,
      sum: document.getElementById('routineInfo').textContent,
      note: document.getElementById('tempoNote').textContent,
      startW: w('startBtn').width, panelW: w('exBox').width,
      startBottom: w('startBtn').bottom,
    };
  });
  assert.equal(r.open, false);
  assert.equal(r.sum, '24 exercises');
  assert.match(r.note, /^about \d+:\d\d/);
  assert.ok(r.startW >= r.panelW - 1, 'Start is full width ' + r.startW + ' vs ' + r.panelW);
  assert.ok(r.startBottom < 844, 'Start is on the first screen ' + r.startBottom);
  await p.evaluate(() => document.querySelector('#exBox>summary').click());
  await p.evaluate(() => document.querySelectorAll('#exerciseList .erow')[6].click());
  assert.equal(await p.evaluate(() => document.getElementById('routineInfo').textContent), '24 exercises · from 7');
});

test('Help: a menu in the title on a phone, a contents list beside the text on desktop', async () => {
  const ph = await open({ seeded: true, input: 'kb' }, { width: 390, height: 844 });
  await ph.evaluate(() => document.getElementById('helpBtn').click());
  await ph.waitForTimeout(200);
  assert.equal(await ph.evaluate(() => document.getElementById('pgTtl').textContent), 'Help · How it works');
  assert.equal(await ph.evaluate(() => getComputedStyle(document.getElementById('helpNav')).display), 'none');
  await ph.evaluate(() => document.getElementById('pgTtl').click());
  const items = await ph.evaluate(() => [...document.querySelectorAll('.rmenu button')].map(b => b.textContent));
  assert.equal(items.length, 9);
  await ph.evaluate(() => [...document.querySelectorAll('.rmenu button')].find(b => b.textContent === 'Scores, tempo and progress').click());
  await ph.waitForTimeout(400);
  assert.equal(await ph.evaluate(() => document.getElementById('pgTtl').textContent), 'Help · Scores, tempo and progress');
  assert.equal(await ph.evaluate(() => document.querySelectorAll('.rmenu').length), 0);

  const dk = await open({ seeded: true, input: 'kb' }, { width: 1440, height: 900 });
  await dk.evaluate(() => document.getElementById('helpBtn').click());
  await dk.waitForTimeout(200);
  const g = await dk.evaluate(() => {
    const n = document.getElementById('helpNav').getBoundingClientRect(), s = document.getElementById('help-how').getBoundingClientRect(), pg = document.getElementById('pageHelp').getBoundingClientRect();
    return { navRight: n.right, secLeft: s.left, navTop: n.top, secTop: s.top, wide: pg.width, title: document.getElementById('pgTtl').textContent };
  });
  assert.ok(g.navRight < g.secLeft, 'list is left of the text');
  assert.ok(Math.abs(g.navTop - g.secTop) < 4, 'list and text start together');
  assert.ok(g.wide > 900, 'Help uses the wide page ' + g.wide);
  assert.equal(g.title, 'Help');
  await dk.evaluate(() => [...document.querySelectorAll('#helpNav button')].find(b => b.textContent === 'If something is off').click());
  await dk.waitForTimeout(400);
  assert.equal(await dk.evaluate(() => document.querySelector('#helpNav button[aria-current]').textContent), 'If something is off');
});

test('every badge has one medal, with a written step name, on the Achievements page', async () => {
  const p = await open({ seeded: true, input: 'kb' }, { width: 1440, height: 900 });
  await p.evaluate(() => [...document.querySelectorAll('.switch.tabs button')].find(x => x.textContent.trim() === 'Progress').click());
  await p.evaluate(() => document.getElementById('pvBtnAch').click());
  await p.waitForTimeout(200);
  const r = await p.evaluate(() => ({ n: document.querySelectorAll('#badges .medal').length, bad: [...document.querySelectorAll('#badges .medal')].filter(m => /undefined|NaN/.test(m.title) || !m.title).length, off: document.querySelectorAll('#badges .medal.off').length }));
  assert.equal(r.n, 17);
  assert.equal(r.bad, 0);
  assert.equal(r.off, 17);
  const txt = await p.evaluate(() => document.getElementById('badges').innerText);
  assert.doesNotMatch(txt, /undefined|NaN/);
});

test('Import asks what to bring in, offers only what the file holds, and imports only the ticks', async () => {
  const p = await open({ seeded: true });
  const file = path.join(os.tmpdir(), 'pocket-imp-test.json');
  fs.writeFileSync(file, JSON.stringify({ lib: [{ id: 'zz1', x: '8 R L R L', t: 1 }], settings: { bpm: 77 } }));
  await p.click('#tabProgress');
  await p.setInputFiles('#recFile', file);
  await p.waitForTimeout(300);
  const rows = await p.evaluate(() => ({ title: document.getElementById('exTitle').textContent, go: document.getElementById('exGo').textContent, parts: [...document.querySelectorAll('#exOpts input')].map(c => c.dataset.k) }));
  assert.equal(rows.title, 'Import');
  assert.equal(rows.go, 'Import');
  assert.deepEqual(rows.parts, ['lib', 'set']);
  await p.evaluate(() => { document.querySelector('#exOpts input[data-k=set]').click(); });
  await p.click('#exGo');
  await p.waitForTimeout(400);
  const after = await p.evaluate(() => ({ bpm: JSON.parse(localStorage.getItem('stick-timing-trainer.v1')).settings.bpm, lib: JSON.parse(localStorage.getItem('stick-timing-trainer.records.v2')).lib.length }));
  assert.notEqual(after.bpm, 77, 'settings were unticked');
  assert.equal(after.lib, 1);
});

test('a scored run is scored, announces a new high score once, and keeps the per-stroke codes', async () => {
  const o = await runOnce({ click: 'half' }, false);
  assert.match(o.win, /New high score! [\d,]+ on Hard/);
  assert.match(o.text, /Score [\d,]+/);
  const p0 = await runOnce({ click: 'half' }, true);
  assert.doesNotMatch(p0.win, /high score/i, 'a practice run is not scored');
});

test('rests are scored: on time unless hit, and a hit on a rest is a miss', async () => {
  const p = await open({ input: 'kb', bpm: 120, routineText: 'R_L_ R_L_', eachUnit: 'pass', eachVal: 2, seeded: true });
  await p.evaluate(() => [...document.querySelectorAll('button')].find(b => /^Start/.test(b.textContent.trim()) && b.offsetParent).click());
  await p.waitForFunction(() => window.__T.run() && window.__T.run().plan, null, { timeout: 8000 });
  await p.evaluate(() => {
    const T = window.__T, r = T.run(), pl = r.plan, rest = pl.cells.filter(c => c.rest)[1];
    pl.slots.forEach(s => { const hand = pl.segs[s.seg].notes[s.pos].slice(-1); T.hit({ t: r.t0 + s.t + 0.005, kb: true, f: null, det: { hand, conf: 1 } }); });
    T.hit({ t: r.t0 + rest.t, kb: true, f: null, det: { hand: 'R', conf: 1 } });
  });
  await p.waitForFunction(() => window.__T.run().ended, null, { timeout: 40000 });
  await p.waitForTimeout(300);
  const q = await p.evaluate(() => JSON.parse(localStorage.getItem('stick-timing-trainer.records.v2')).runs[0].exercises[0].q);
  assert.ok(q && q.length > 8, 'rests are in the sequence: ' + q);
  assert.equal((q.match(/m/g) || []).length, 1, 'one rest was hit: ' + q);
});
