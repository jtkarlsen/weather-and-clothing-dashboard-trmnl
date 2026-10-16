// Serverless transform: turns a MET Norway (yr.no) Locationforecast 2.0 response
// into a small, display-ready outfit plan for kids, in Norwegian.
//
// TRMNL calls run(input) with the polled JSON (plus `trmnl` globals and custom
// field values). Whatever we return becomes the Liquid merge data.

const PERIODS = {
  morning: { label: 'Morgen', range: '07–11', from: 7, to: 12 },
  afternoon: { label: 'Ettermiddag', range: '12–17', from: 12, to: 17 }
};
const STRIP_HOURS = [7, 9, 11, 13, 15, 17];
const SWITCH_TO_TOMORROW_AT = 17; // after this local hour, show tomorrow
const STATUS_LABEL = { on: 'Ha på', bag: 'I sekken' };
const MAX_ITEMS = 10;

// ---------- input helpers ----------

function field(input, key, fallback) {
  const direct = input && input[key];
  if (direct !== undefined && direct !== null && direct !== '') return direct;
  const cf = input && input.trmnl && input.trmnl.plugin_settings && input.trmnl.plugin_settings.custom_fields_values;
  if (cf && cf[key] !== undefined && cf[key] !== '') return cf[key];
  return fallback;
}

function findForecast(input) {
  const candidates = [input, input && input.IDX_0, input && input.data];
  for (const c of candidates) {
    if (c && c.properties && Array.isArray(c.properties.timeseries)) return c;
  }
  return null;
}

// ---------- time helpers ----------

function localParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date);
  const get = t => parts.find(p => p.type === t).value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour')),
    minute: Number(get('minute'))
  };
}

function clock(date, timeZone) {
  const p = localParts(date, timeZone);
  return `${String(p.hour).padStart(2, '0')}.${String(p.minute).padStart(2, '0')}`;
}

// Spelled out by hand: TRMNL's Node runtime may lack Norwegian locale data and fall back to English.
const DAYS = ['Søndag', 'Mandag', 'Tirsdag', 'Onsdag', 'Torsdag', 'Fredag', 'Lørdag'];
const MONTHS = ['januar', 'februar', 'mars', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'desember'];

function norwegianDate(date, timeZone) {
  const [y, m, d] = localParts(date, timeZone).date.split('-').map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${DAYS[weekday]} ${d}. ${MONTHS[m - 1]}`;
}

// ---------- sun ----------

// Solar elevation in degrees (NOAA approximation), good to well under a degree.
function sunElevation(date, lat, lon) {
  const rad = Math.PI / 180;
  const jd = date.getTime() / 86400000 + 2440587.5;
  const n = jd - 2451545.0;
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * rad;
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const eps = (23.439 - 0.0000004 * n) * rad;
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const gmst = (18.697374558 + 24.06570982441908 * n) % 24;
  const ha = ((gmst * 15 + lon) * rad) - ra;
  const el = Math.asin(Math.sin(lat * rad) * Math.sin(dec) + Math.cos(lat * rad) * Math.cos(dec) * Math.cos(ha));
  return el / rad;
}

const isDark = (date, lat, lon) => sunElevation(date, lat, lon) < -0.833;

function sunTimes(dayStartUtc, lat, lon, timeZone) {
  let rise = null, set = null;
  let prev = isDark(dayStartUtc, lat, lon);
  for (let m = 5; m <= 24 * 60; m += 5) {
    const t = new Date(dayStartUtc.getTime() + m * 60000);
    const dark = isDark(t, lat, lon);
    if (prev && !dark && !rise) rise = t;
    if (!prev && dark) set = t;
    prev = dark;
  }
  if (!rise && !set) {
    const noon = new Date(dayStartUtc.getTime() + 12 * 3600000);
    return { text: isDark(noon, lat, lon) ? 'Mørketid: sola er borte i dag' : 'Midnattssol: lyst hele døgnet', rise: null };
  }
  return {
    text: `Sola: ${rise ? clock(rise, timeZone) : '–'}–${set ? clock(set, timeZone) : '–'}`,
    rise
  };
}

// ---------- weather ----------

// Wind chill (Environment Canada / JAG-TI), wind in m/s.
function feelsLike(t, windMs) {
  const v = windMs * 3.6;
  if (t > 10 || v < 4.8) return t;
  const vp = Math.pow(v, 0.16);
  return 13.12 + 0.6215 * t - 11.37 * vp + 0.3965 * t * vp;
}

const SYMBOL_RANK = ['clear', 'partly', 'cloudy', 'fog', 'rain', 'sleet', 'snow', 'thunder'];

function symbolKind(code) {
  if (!code) return 'cloudy';
  if (code.includes('thunder')) return 'thunder';
  if (code.includes('snow')) return 'snow';
  if (code.includes('sleet')) return 'sleet';
  if (code.includes('rain')) return 'rain';
  if (code.startsWith('fog')) return 'fog';
  if (code.startsWith('clearsky') || code.startsWith('fair')) return code.startsWith('fair') ? 'partly' : 'clear';
  if (code.startsWith('partlycloudy')) return 'partly';
  return 'cloudy';
}

function summarize(hours) {
  const temps = hours.map(h => h.temp);
  const feels = hours.map(h => feelsLike(h.temp, h.wind));
  const kind = hours.map(h => symbolKind(h.symbol))
    .reduce((a, b) => (SYMBOL_RANK.indexOf(b) > SYMBOL_RANK.indexOf(a) ? b : a), 'clear');
  return {
    tMin: Math.min(...temps),
    tMax: Math.max(...temps),
    feels: Math.min(...feels),
    wind: Math.max(...hours.map(h => h.wind)),
    precip: hours.reduce((s, h) => s + h.precip, 0),
    kind,
    dark: hours.some(h => h.dark)
  };
}

const fmtTemp = t => `${Math.round(t) < 0 ? '−' : ''}${Math.abs(Math.round(t))}°`;
const fmtWind = w => `${Math.round(w)}\u00a0m/s`;

const KIND_TEXT = {
  clear: 'Sol', partly: 'Lettskyet', cloudy: 'Skyet', fog: 'Tåke',
  rain: 'Regn', sleet: 'Sludd', snow: 'Snø', thunder: 'Torden'
};

function describe(s, when) {
  const words = [];
  if (s.feels <= -10) words.push('Veldig kaldt');
  else if (s.feels <= 2) words.push('Kaldt');
  else if (s.feels <= 10) words.push('Kjølig');
  else if (s.feels <= 18) words.push('Mildt');
  else words.push('Varmt');
  const wet = ['rain', 'sleet', 'thunder'].includes(s.kind) && s.precip >= 0.2;
  if (wet) words.push('vått');
  if (s.wind >= 6) words.push('vind');
  const first = words.length > 1 ? `${words.slice(0, -1).join(', ')} og ${words[words.length - 1]}.` : `${words[0]}.`;
  const precipWord = { rain: 'Regn', sleet: 'Sludd', snow: 'Snø', thunder: 'Regn og torden' }[s.kind];
  const second = precipWord && s.precip >= 0.2 ? `${precipWord} ${when}.` : `Opphold ${when}.`;
  return `${first} ${second}`;
}

// ---------- clothing ----------

// Item catalogue in display priority order. `icon` matches a symbol id in shared.liquid.
const CATALOGUE = [
  ['vinterdress', 'Vinterdress', 'vinterdress'],
  ['regnjakke_foret', 'Fôret regnjakke', 'regnjakke'],
  ['regnbukse_foret', 'Fôret regnbukse', 'regnbukse'],
  ['regnjakke', 'Regnjakke', 'regnjakke'],
  ['regnbukse', 'Regnbukse', 'regnbukse'],
  ['lett_jakke', 'Lett jakke', 'jakke'],
  ['ullgenser', 'Ullgenser', 'genser'],
  ['fleece', 'Fleecejakke', 'fleece'],
  ['vinterstovler', 'Vinterstøvler', 'stovler'],
  ['forede_stovler', 'Fôrede støvler', 'stovler'],
  ['gummistovler', 'Gummistøvler', 'stovler'],
  ['joggesko', 'Joggesko', 'sko'],
  ['ullsokker', 'Ullsokker', 'sokker'],
  ['lue', 'Lue', 'lue'],
  ['votter_vanntette', 'Vanntette votter', 'votter'],
  ['votter', 'Votter', 'votter'],
  ['hals', 'Hals', 'hals'],
  ['caps', 'Caps', 'caps'],
  ['refleksvest', 'Refleksvest', 'refleks'],
  ['skiftetoy', 'Skiftetøy', 'sekk']
];

function outfit(s) {
  const out = {};
  const f = s.feels;
  const wet = (['rain', 'sleet', 'thunder'].includes(s.kind) && s.precip >= 0.2) || s.precip >= 0.5;
  const rainy = ['rain', 'sleet', 'thunder'].includes(s.kind);

  if (s.tMin <= -1 && !rainy) out.vinterdress = 'on';
  else if (f <= 6) { out.regnjakke_foret = 'on'; out.regnbukse_foret = 'on'; }
  else if (wet) { out.regnjakke = 'on'; out.regnbukse = 'on'; }
  else if (f <= 14) out.lett_jakke = 'on';

  if (f <= 0 && out.vinterdress) out.ullgenser = 'on';
  else if (f <= 10) out.fleece = 'on';
  else if (f <= 14) out.fleece = 'bag';

  if (s.tMin <= -1 && !rainy) out.vinterstovler = 'on';
  else if (f <= 6) out.forede_stovler = 'on';
  else if (wet) out.gummistovler = 'on';
  else out.joggesko = 'on';

  if (s.tMin <= 8) out.ullsokker = 'on';

  if (f <= 8) out.lue = 'on';
  else if (f <= 12) out.lue = 'bag';

  const mitten = wet || s.kind === 'snow' ? 'votter_vanntette' : 'votter';
  if (f <= 4) out[mitten] = 'on';
  else if (f <= 8) out[mitten] = 'bag';

  if (f <= 0) out.hals = 'on';
  else if (f <= 5) out.hals = 'bag';

  if (s.tMax >= 18 && ['clear', 'partly'].includes(s.kind)) out.caps = 'on';

  if (s.dark) out.refleksvest = 'on';

  out.skiftetoy = 'bag';
  return out;
}

const STRONGER = { no: 0, bag: 1, on: 2 };
const stronger = (x, y) => (STRONGER[x] >= STRONGER[y] ? x : y);

// One label per garment, because kids get dressed once, in the morning:
// "Ha på" if it is needed on the way to school, "I sekken" if it is only
// needed later in the day or is optional.
function dayStatus(m, a) {
  if (m === 'on') return 'on';
  if (m === 'bag' || a !== 'no') return 'bag';
  return 'no';
}

function mergeOutfits(morning, afternoon) {
  // Items sharing an icon are variants of one garment (e.g. boots). The warmest
  // variant needed in either period is shown, so a kid never sees two pairs of boots.
  const byIcon = new Map();
  for (const [key, name, icon] of CATALOGUE) {
    const m = morning[key] || 'no';
    const a = afternoon[key] || 'no';
    if (m === 'no' && a === 'no') continue;
    const seen = byIcon.get(icon);
    if (seen) { seen.m = stronger(seen.m, m); seen.a = stronger(seen.a, a); }
    else byIcon.set(icon, { key, name, icon, m, a });
  }
  const items = [...byIcon.values()]
    .map(({ key, name, icon, m, a }) => {
      const status = dayStatus(m, a);
      return { key, name, icon, status, label: STATUS_LABEL[status] };
    })
    .filter(it => it.status !== 'no');
  // Things to put on first, then things to pack; the sort is stable, so catalogue order holds within each group.
  items.sort((x, y) => STRONGER[y.status] - STRONGER[x.status]);
  // Keep the most important ones if there are too many for the grid.
  while (items.length > MAX_ITEMS) items.pop();
  return items;
}

// ---------- main ----------

function build(input, now) {
  const timeZone = field(input, 'time_zone', null)
    || (input && input.trmnl && input.trmnl.user && input.trmnl.user.time_zone_iana)
    || 'Europe/Oslo';
  const place = field(input, 'place', 'Tromsø');
  const forecast = findForecast(input);
  if (!forecast) {
    return { ok: false, error: 'Fant ingen værdata fra yr.no. Sjekk breddegrad og lengdegrad.', place };
  }

  const coords = (forecast.geometry && forecast.geometry.coordinates) || [];
  const lat = Number(field(input, 'lat', coords[1] || 69.6496));
  const lon = Number(field(input, 'lon', coords[0] || 18.956));

  const nowLocal = localParts(now, timeZone);
  const tomorrow = nowLocal.hour >= SWITCH_TO_TOMORROW_AT;

  const hours = forecast.properties.timeseries
    .filter(e => e.data && e.data.next_1_hours)
    .map(e => {
      const t = new Date(e.time);
      const p = localParts(t, timeZone);
      return {
        time: t, date: p.date, hour: p.hour,
        temp: e.data.instant.details.air_temperature,
        wind: e.data.instant.details.wind_speed || 0,
        precip: (e.data.next_1_hours.details && e.data.next_1_hours.details.precipitation_amount) || 0,
        symbol: e.data.next_1_hours.summary && e.data.next_1_hours.summary.symbol_code,
        dark: isDark(new Date(t.getTime() + 30 * 60000), lat, lon)
      };
    });

  const dates = [...new Set(hours.map(h => h.date))];
  const targetDate = tomorrow ? dates.find(d => d > nowLocal.date) || dates[0] : nowLocal.date;
  const day = hours.filter(h => h.date === targetDate);
  const inPeriod = p => day.filter(h => h.hour >= p.from && h.hour < p.to);

  const mHours = inPeriod(PERIODS.morning);
  const aHours = inPeriod(PERIODS.afternoon);
  if (!mHours.length && !aHours.length) {
    return { ok: false, error: 'Værdataene dekker ikke dagen i dag.', place };
  }
  const m = summarize(mHours.length ? mHours : aHours);
  const a = summarize(aHours.length ? aHours : mHours);

  const firstHour = day[0] || hours[0];
  const dayStartUtc = new Date(firstHour.time.getTime() - firstHour.hour * 3600000);
  const sun = sunTimes(dayStartUtc, lat, lon, timeZone);

  const strip = STRIP_HOURS.map(h => {
    const pair = day.filter(x => x.hour === h || x.hour === h + 1);
    const at = day.find(x => x.hour === h);
    if (!at) return null;
    const mm = pair.reduce((s, x) => s + x.precip, 0);
    return {
      hour: String(h).padStart(2, '0'),
      temp: fmtTemp(at.temp),
      precip: mm.toFixed(1).replace('.', ','),
      bar: Math.min(100, Math.round(mm / 2 * 100)),
      dark: at.dark
    };
  }).filter(Boolean);

  const items = mergeOutfits(outfit(m), outfit(a));

  let tip;
  const darkMorning = mHours.filter(h => h.dark);
  if (darkMorning.length && sun.rise) tip = `Husk refleksvesten! Det er mørkt ute til kl. ${clock(sun.rise, timeZone)}.`;
  else if (darkMorning.length || a.dark) tip = 'Husk refleksvesten! Det er mørkt ute.';
  else if (m.precip + a.precip >= 1) tip = 'Husk skiftetøy i sekken. Det blir vått i dag!';
  else if (a.tMax >= 20) tip = 'Husk solkrem og vannflaske!';
  else tip = 'Ha en fin dag!';

  const updated = forecast.properties.meta && forecast.properties.meta.updated_at;

  return {
    ok: true,
    place,
    day_label: tomorrow ? 'I morgen' : 'I dag',
    date: norwegianDate(new Date(dayStartUtc.getTime() + 12 * 3600000), timeZone),
    updated: updated ? clock(new Date(updated), timeZone) : clock(now, timeZone),
    now: {
      temp: fmtTemp(m.tMin),
      feels: `føles som ${fmtTemp(m.feels)}`,
      icon: m.kind,
      text: describe(m, 'på vei til skolen')
    },
    periods: [
      { label: PERIODS.morning.label, range: PERIODS.morning.range, temp: fmtTemp(m.tMin), text: `${KIND_TEXT[m.kind]}, vind ${fmtWind(m.wind)}`, icon: m.kind },
      { label: PERIODS.afternoon.label, range: PERIODS.afternoon.range, temp: fmtTemp(a.tMax), text: `${KIND_TEXT[a.kind]}, vind ${fmtWind(a.wind)}`, icon: a.kind }
    ],
    strip,
    sun: sun.text,
    items,
    tip
  };
}

function run(input) {
  return build(input, new Date());
}

if (typeof module !== 'undefined') module.exports = { run, build, feelsLike, sunElevation, outfit };
