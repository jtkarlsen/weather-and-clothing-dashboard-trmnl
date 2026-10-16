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

test('dry frost without snow on the ground means a shell suit with thick wool', () => {
  const o = outfit({ tMin: -8, tMax: -5, feels: -14, wind: 3, precip: 0, kind: 'clear', dark: true });
  assert.equal(o.vinterdress, undefined);
  assert.equal(o.parkdress, 'on');
  assert.equal(o.ullgenser_tykk, 'on');
  const mild = outfit({ tMin: -2, tMax: 0, feels: -3, wind: 2, precip: 0, kind: 'cloudy', dark: false });
  assert.equal(mild.parkdress, 'on');
  assert.equal(mild.fleece, 'on');
});

test('the snow setting is read from the plugin form', () => {
  const cold = JSON.parse(JSON.stringify(fixture));
  for (const e of cold.properties.timeseries) {
    e.data.instant.details.air_temperature -= 8;
    e.data.next_1_hours = { summary: { symbol_code: 'cloudy' }, details: { precipitation_amount: 0 } };
  }
  const at = new Date('2026-10-16T04:30:00Z');
  assert.ok(build(cold, at).items.some(i => i.key === 'parkdress'));
  assert.ok(build({ ...cold, snow_on_ground: 'ja' }, at).items.some(i => i.key === 'vinterdress'));
});

test('dry frost with snow on the ground means winter suit and winter boots', () => {
  const o = outfit({ tMin: -8, tMax: -5, feels: -14, wind: 3, precip: 0, kind: 'clear', dark: true }, { snowOnGround: true });
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

const fs = require('node:fs');
const path = require('node:path');
const ics = fs.readFileSync(path.join(__dirname, 'fixtures/family.ics'), 'utf8');

test('calendar: today\'s events in time order, at most three', () => {
  const r = eventsForDateExport(ics, '2026-10-16');
  assert.deepEqual(r.events, [
    { title: 'Planleggingsdag i barnehagen', time: 'Hele dagen' },
    { title: 'Skole', time: '08.30–14.00' },
    { title: 'JT + Magnus på tur til narvik', time: '12.15–12.45' }
  ]);
  assert.equal(r.more, 1, 'football is the fourth event');
});

test('calendar: weekly rules, exceptions and other days', () => {
  assert.deepEqual(eventsForDateExport(ics, '2026-10-15').events, [], 'school cancelled by EXDATE');
  assert.deepEqual(eventsForDateExport(ics, '2026-10-17').events, [{ title: 'Svømming', time: '11.00–12.00' }]);
  assert.deepEqual(eventsForDateExport(ics, '2026-10-19').events.map(e => e.title), ['Skole']);
});

test('calendar: found in the polled data and passed to the screen', () => {
  const r = build({ IDX_0: fixture, IDX_1: ics }, new Date('2026-10-16T04:30:00Z'));
  assert.equal(r.has_calendar, true);
  assert.equal(r.events.length, 3);
  const plain = build(fixture, new Date('2026-10-16T04:30:00Z'));
  assert.equal(plain.has_calendar, false);
});

function eventsForDateExport(text, date) {
  return require('../src/transform.js').eventsForDate(text, date, 'Europe/Oslo');
}
