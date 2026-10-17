const test = require('node:test');
const assert = require('node:assert');
const { build, outfit, utm33, fetchSnowDepth, fetchCalendar } = require('../src/transform.js');
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
  const o = outfit({ tMin: -8, tMax: -5, wind: 3, precip: 0, kind: 'clear', dark: true });
  assert.equal(o.vinterdress, undefined);
  assert.equal(o.parkdress, 'on');
  assert.equal(o.ullgenser_tykk, 'on');
  const mild = outfit({ tMin: -2, tMax: 0, wind: 2, precip: 0, kind: 'cloudy', dark: false });
  assert.equal(mild.parkdress, 'on');
  assert.equal(mild.fleece, 'on');
});

test('snow depth from NVE decides between winter suit and shell suit', () => {
  const cold = JSON.parse(JSON.stringify(fixture));
  for (const e of cold.properties.timeseries) {
    e.data.instant.details.air_temperature -= 8;
    e.data.next_1_hours = { summary: { symbol_code: 'cloudy' }, details: { precipitation_amount: 0 } };
  }
  const at = new Date('2026-10-16T04:30:00Z');
  const has = (input, key) => build(input, at).items.some(i => i.key === key);
  assert.ok(has(cold, 'parkdress'), 'no data means bare ground');
  assert.ok(has({ ...cold, snow_depth: { '2026-10-16': 2 } }, 'parkdress'), 'a dusting is not enough');
  assert.ok(has({ ...cold, snow_depth: { '2026-10-15': 20 } }, 'vinterdress'), 'latest earlier day is used');
});

test('December to February always means winter suit in frost', () => {
  const cold = JSON.parse(JSON.stringify(fixture));
  for (const e of cold.properties.timeseries) {
    e.time = e.time.replace('2026-10-', '2026-12-');
    e.data.instant.details.air_temperature -= 8;
    e.data.next_1_hours = { summary: { symbol_code: 'cloudy' }, details: { precipitation_amount: 0 } };
  }
  const items = build({ ...cold, snow_depth: { '2026-12-16': 0 } }, new Date('2026-12-16T05:30:00Z')).items;
  assert.ok(items.some(i => i.key === 'vinterdress'));
});

test('coordinates are converted to UTM zone 33 for NVE', () => {
  const oslo = utm33(59.9139, 10.7522);
  assert.ok(Math.abs(oslo.x - 262000) < 1500 && Math.abs(oslo.y - 6649500) < 1500, JSON.stringify(oslo));
});

test('snow depth is fetched from NVE and survives failures', async () => {
  let url;
  const ok = async u => { url = u; return { ok: true, json: async () => ({ NoDataValue: 65535, Data: [0, 3, 65535, 12] }) }; };
  const now = new Date('2026-10-16T10:00:00Z');
  const d = await fetchSnowDepth(69.6496, 18.956, now, 'Europe/Oslo', ok);
  assert.match(url, /^https:\/\/gts\.nve\.no\/api\/GridTimeSeries\/\d+\/\d+\/2026-10-13\/2026-10-16\/sd\.json$/);
  assert.deepEqual(d, { '2026-10-13': 0, '2026-10-14': 3, '2026-10-16': 12 });
  assert.equal(await fetchSnowDepth(69.6, 18.9, now, 'Europe/Oslo', async () => { throw new Error('offline'); }), null);
  assert.equal(await fetchSnowDepth(69.6, 18.9, now, 'Europe/Oslo', async () => ({ ok: false })), null);
});

test('dry frost with snow on the ground means winter suit and winter boots', () => {
  const o = outfit({ tMin: -8, tMax: -5, wind: 3, precip: 0, kind: 'clear', dark: true }, { snowOnGround: true });
  assert.equal(o.vinterdress, 'on');
  assert.equal(o.vinterstovler, 'on');
  assert.equal(o.ullgenser, 'on');
  assert.equal(o.votter, 'on');
});

test('warm and sunny means light clothes and a cap', () => {
  const o = outfit({ tMin: 17, tMax: 22, wind: 2, precip: 0, kind: 'clear', dark: false });
  assert.equal(o.caps, 'on');
  assert.equal(o.joggesko, 'on');
  assert.equal(o.lue, undefined);
});

test('no wind chill: the temperature shown is the forecast temperature', () => {
  const r = build(fixture, new Date('2026-10-16T04:30:00Z'));
  for (const p of r.periods) assert.equal(p.feels, undefined);
  assert.equal(r.now.feels, undefined);
  assert.ok(!JSON.stringify(r).includes('føles'));
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

test('the calendar is fetched by the transform, webcal links included', async () => {
  let url;
  const ics = 'BEGIN:VCALENDAR\nEND:VCALENDAR';
  const ok = async u => { url = u; return { ok: true, text: async () => ics }; };
  assert.equal(await fetchCalendar('webcal://p1-caldav.icloud.com/published/2/abc', ok), ics);
  assert.equal(url, 'https://p1-caldav.icloud.com/published/2/abc');
  assert.equal(await fetchCalendar('', ok), null);
  assert.equal(await fetchCalendar('https://x.test/a.ics', async () => ({ ok: true, text: async () => '<html>' })), null);
  assert.equal(await fetchCalendar('https://x.test/a.ics', async () => { throw new Error('offline'); }), null);
});
