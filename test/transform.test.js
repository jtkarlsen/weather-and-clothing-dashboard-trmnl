const test = require('node:test');
const assert = require('node:assert');
const { build, outfit, feelsLike } = require('../src/transform.js');
const fixture = require('./fixtures/tromso-2026-10-16.json');

test('morning in Tromsø in October gives a Norwegian outfit plan', () => {
  const r = build(fixture, new Date('2026-10-16T04:30:00Z'));
  assert.equal(r.ok, true);
  assert.equal(r.day_label, 'I dag');
  assert.equal(r.date, 'Fredag 16. oktober');
  assert.equal(r.now.temp, '1°');
  assert.equal(r.now.icon, 'sleet');
  assert.equal(r.strip.length, 6);
  const names = r.items.map(i => i.name);
  assert.ok(names.includes('Fôret regnjakke'));
  assert.ok(names.includes('Refleksvest'), 'dark before 08:00 means a reflector vest');
  assert.ok(r.items.length <= 10);
  assert.ok(!names.some(n => /under/i.test(n)), 'no underwear');
});

test('after 17:00 the board shows tomorrow', () => {
  const r = build(fixture, new Date('2026-10-16T16:30:00Z'));
  assert.equal(r.day_label, 'I morgen');
  assert.equal(r.date, 'Lørdag 17. oktober');
});

test('each garment has one label: wear it now or pack it', () => {
  const r = build(fixture, new Date('2026-10-16T04:30:00Z'));
  for (const it of r.items) assert.ok(['on', 'bag'].includes(it.status));
  const firstBag = r.items.findIndex(it => it.status === 'bag');
  assert.ok(r.items.slice(firstBag).every(it => it.status === 'bag'), 'things to wear come first');
  assert.equal(r.items.find(it => it.key === 'skiftetoy').label, 'I sekken');
});

test('one variant per garment, so never two kinds of mittens', () => {
  const r = build(fixture, new Date('2026-10-16T16:30:00Z'));
  const icons = r.items.map(i => i.icon);
  assert.equal(new Set(icons).size, icons.length);
});

test('dry frost means winter suit and winter boots', () => {
  const o = outfit({ tMin: -8, tMax: -5, feels: -14, wind: 3, precip: 0, kind: 'clear', dark: true });
  assert.equal(o.vinterdress, 'on');
  assert.equal(o.vinterstovler, 'on');
  assert.equal(o.ullgenser, 'on');
  assert.equal(o.votter, 'on');
});

test('warm and sunny means light clothes and a cap', () => {
  const o = outfit({ tMin: 17, tMax: 22, feels: 17, wind: 2, precip: 0, kind: 'clear', dark: false });
  assert.equal(o.caps, 'on');
  assert.equal(o.joggesko, 'on');
  assert.equal(o.lue, undefined);
});

test('wind makes it feel colder', () => {
  assert.ok(feelsLike(1, 7) < -3);
  assert.equal(feelsLike(15, 7), 15);
});

test('missing forecast gives a readable error', () => {
  const r = build({}, new Date());
  assert.equal(r.ok, false);
  assert.match(r.error, /yr\.no/);
});
