const test = require('node:test'), assert = require('node:assert/strict');
const { loadCore, plain } = require('./helpers');
const c = loadCore(['parseStrokes', 'parseExerciseLine', 'parseRoutine', 'resolveExercises', 'buildPlan', 'builderApply',
  'graceSlot', 'OnsetDetector', 'patKey', 'parseSig', 'textKey', 'nearestSlot', 'analyseCheck', 'strokeRate', 'masteryTier', 'MTIER', 'RATE_AT']);

const plan = (text, opt) => {
  const p = c.parseRoutine(text);
  const ex = c.resolveExercises(p.exercises, { unit: 'pass', v: 1 }, { bpm: 60, subdiv: 4 });
  return { p, ex, plan: c.buildPlan(ex, Object.assign({ gapBeats: 0, clickMode: 'strokes', dyn: null }, opt)) };
};

test('strokes, groups and rests', () => {
  const r = c.parseStrokes('RLRL _ LR', 4);
  assert.deepEqual(plain(r.notes), ['R', 'L', 'R', 'L', '_', 'L', 'R']);
  assert.equal(r.strokes, 6);
});

test('note codes set the subdivision until the next code', () => {
  const r = c.parseStrokes('8 RL 16 RLRL', 4);
  assert.deepEqual(plain(r.subs), [2, 2, 4, 4, 4, 4]);
});

test('unknown characters are refused with a message', () => {
  assert.match(c.parseStrokes('RLX', 4).err, /only L, R/);
});

test('flams and drags: f and d go in front of a stroke', () => {
  assert.deepEqual(plain(c.parseStrokes('fR fL dR dL', 4).notes), ['fR', 'fL', 'dR', 'dL']);
  assert.deepEqual(plain(c.parseStrokes('FR dl', 4).notes), ['fR', 'dL']);
  for (const bad of ['f', 'fR f', 'f R', 'd_', 'fRd'])
    assert.match(c.parseStrokes(bad, 4).err, /flam/, bad);
});

test('a flam is a different exercise from the plain stroke', () => {
  const k = x => c.textKey(x, 4);
  assert.notEqual(k('RLRL RLRL'), k('fRLRL RLRL'));
});

test('time signatures: bar groups and the count-in', () => {
  const s = c.parseSig('7/8 (3+2+2)');
  assert.deepEqual(plain(s.sig.groups), [3, 2, 2]);
  assert.match(c.parseSig('7/8 (3+2)').err, /add up/);
  assert.match(c.parseSig('7/3').err, /2, 4 or 8/);
});

test('routine text: title, each, passes and tempo', () => {
  const p = c.parseRoutine('title: Warm up\neach: x4\nRLRL RLRL  x8\nLRLR LRLR @90\n# a note');
  assert.equal(p.title, 'Warm up');
  assert.equal(p.errors.length, 0);
  assert.equal(p.exercises.length, 2);
  assert.deepEqual(plain(p.exercises[0].dur), { unit: 'pass', v: 8 });
  assert.equal(p.exercises[1].bpm, 90);
});

test('an exercise that does not fill its bar gets a warning', () => {
  const p = c.parseRoutine('time: 7/8\nRLRLRL');
  assert.ok(p.errors.some(e => /holds/.test(e)));
});

test('plan: one slot per stroke, none for rests, and grace flags', () => {
  const { plan: pl } = plan('16 fR _ L dR');
  assert.equal(pl.slots.length, 3);
  assert.deepEqual(plain(pl.slots.map(s => s.gr)), [1, 0, 2]);
});

test('graceSlot finds a flam only just before its main stroke', () => {
  const { plan: pl } = plan('8 R fL R L');
  const s = pl.slots, t = s[1].t;
  assert.equal(c.graceSlot(s, t - 0.04, 0), 1);
  assert.equal(c.graceSlot(s, t - 0.005, 0), -1);
  assert.equal(c.graceSlot(s, t - 0.2, 0), -1);
  assert.equal(c.graceSlot(s, t - 0.04, 2), -1);
});

test('builder taps edit the text', () => {
  assert.equal(c.builderApply('R ', 'fL'), 'R fL');
  assert.equal(c.builderApply('RfL', 'back'), 'R');
  assert.equal(c.builderApply('RLfR', 'swap'), 'LRfL');
  assert.equal(c.builderApply('RL', 'code:8'), 'RL 8 ');
});

/* A stick strike: a noisy burst that fades in a few milliseconds. */
function detect(flam, gap, graceAmp, mainAmp) {
  const sr = 48000, hits = [];
  const d = new c.OnsetDetector(sr, e => { if (e.type === 'hit') hits.push(e); });
  d.set({ thr: 0.02, refrac: 0.04, flam });
  const n = sr, buf = new Float32Array(n);
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const strike = (t, a) => { const s0 = Math.round(t * sr); for (let i = 0; i < sr * 0.05 && s0 + i < n; i++) buf[s0 + i] += a * Math.exp(-i / (0.004 * sr)) * (Math.sin(i * 0.9) * 0.7 + (rnd() - 0.5) * 0.6); };
  if (graceAmp) strike(0.2, graceAmp);
  strike(0.2 + gap, mainAmp);
  for (let i = 0; i < n; i += 128) d.process(buf.subarray(i, i + 128), i);
  return hits.map(h => +h.t.toFixed(3));
}

test('detector: a soft grace does not hide the loud main stroke when flams are on', () => {
  for (const gap of [0.02, 0.03, 0.06]) {
    const h = detect(0.07, gap, 0.12, 0.6);
    assert.ok(h.some(t => Math.abs(t - (0.2 + gap)) < 0.004), 'main stroke heard at gap ' + gap + ' ms: ' + h);
  }
});

test('detector: a single hit is heard once', () => {
  const h = detect(0.07, 0.03, 0, 0.6);
  assert.equal(h.length, 1);
});

test('mastery is measured in strokes a minute, so sixteenths count for more than eighths', () => {
  const key = x => c.textKey(x, 4);
  const sixteenths = key('RLRL RLRL');       /* four strokes to the beat */
  const eighths = key('8 RLRL RLRL');     /* two strokes to the beat */
  assert.equal(c.strokeRate(sixteenths, 60), 240);
  assert.equal(c.strokeRate(eighths, 60), 120);
  assert.equal(c.masteryTier(sixteenths, 60), 3);   /* Gold */
  assert.equal(c.masteryTier(eighths, 60), 1);      /* Bronze */
  assert.equal(c.masteryTier(eighths, 40), 0);      /* Hickory: cleared, but slow */
  assert.equal(c.masteryTier(sixteenths, 150), 7);  /* Diamond */
  assert.equal(c.MTIER.length, c.RATE_AT.length + 1);
  /* rests are not strokes, and a half-note beat counts its own strokes */
  assert.equal(c.strokeRate(key('R_L_ R_L_'), 60), 120);
  assert.equal(c.strokeRate(key('2/2: RLRL RLRL'), 70), 280);
});
