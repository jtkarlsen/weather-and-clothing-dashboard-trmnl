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
  ['parkdress', 'Parkdress', 'parkdress'],
  ['regnjakke_foret', 'Fôret regnjakke', 'regnjakke'],
  ['regnbukse_foret', 'Fôret regnbukse', 'regnbukse'],
  ['regnjakke', 'Regnjakke', 'regnjakke'],
  ['regnbukse', 'Regnbukse', 'regnbukse'],
  ['lett_jakke', 'Lett jakke', 'jakke'],
  ['ullgenser_tykk', 'Tykk ullgenser', 'genser'],
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

// snowOnGround: winter suits are only for snow; on bare ground they get torn, so kids wear
// a shell suit (parkdress) with fleece or thick wool under instead.
function outfit(s, { snowOnGround = false } = {}) {
  const out = {};
  const f = s.feels;
  const wet = (['rain', 'sleet', 'thunder'].includes(s.kind) && s.precip >= 0.2) || s.precip >= 0.5;
  const rainy = ['rain', 'sleet', 'thunder'].includes(s.kind);

  const frost = s.tMin <= -1 && !rainy;
  if (frost && snowOnGround) out.vinterdress = 'on';
  else if (frost) out.parkdress = 'on';
  else if (f <= 6) { out.regnjakke_foret = 'on'; out.regnbukse_foret = 'on'; }
  else if (wet) { out.regnjakke = 'on'; out.regnbukse = 'on'; }
  else if (f <= 14) out.lett_jakke = 'on';

  if (f <= 0 && out.vinterdress) out.ullgenser = 'on';
  else if (f <= -5 && out.parkdress) out.ullgenser_tykk = 'on';
  else if (f <= 10) out.fleece = 'on';
  else if (f <= 14) out.fleece = 'bag';

  if (frost) out.vinterstovler = 'on';
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
// "Ha på" if it is needed in the morning, "I sekken" if it is only
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

// ---------- calendar (iCal) ----------

const MAX_EVENTS = 3;
const ICS_DAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

// The calendar arrives as a second polled URL. Depending on how TRMNL wraps a
// non-JSON response it may be a plain string or sit under a key, so look for it.
function findIcs(input, depth = 0) {
  if (typeof input === 'string') return input.includes('BEGIN:VCALENDAR') ? input : null;
  if (!input || typeof input !== 'object' || depth > 3) return null;
  for (const key of Object.keys(input)) {
    if (key === 'trmnl' || key === 'properties') continue;
    const found = findIcs(input[key], depth + 1);
    if (found) return found;
  }
  return null;
}

// TRMNL's polling only accepts JSON, so the iCal feed is fetched here instead.
// webcal:// links (iCloud) are the same feed over https.
async function fetchCalendar(url, fetchFn = globalThis.fetch) {
  url = String(url || '').trim().replace(/^webcal:\/\//i, 'https://');
  if (!fetchFn || !/^https?:\/\//i.test(url)) return null;
  try {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl && setTimeout(() => ctrl.abort(), 3000);
    const res = await fetchFn(url, ctrl ? { signal: ctrl.signal } : undefined);
    if (timer) clearTimeout(timer);
    if (!res.ok) return null;
    const text = await res.text();
    return text.includes('BEGIN:VCALENDAR') ? text : null;
  } catch (e) {
    return null;
  }
}

function parseIcs(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const events = [];
  let ev = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { ev = { exdates: [] }; continue; }
    if (line === 'END:VEVENT') { if (ev && ev.start) events.push(ev); ev = null; continue; }
    if (!ev) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const [name, ...params] = line.slice(0, colon).split(';');
    const value = line.slice(colon + 1);
    const tzid = (params.find(p => p.startsWith('TZID=')) || '').slice(5) || null;
    if (name === 'SUMMARY') ev.title = value.replace(/\\([,;\\])/g, '$1').replace(/\\n/gi, ' ').trim();
    else if (name === 'DTSTART') ev.start = icsTime(value, tzid);
    else if (name === 'DTEND') ev.end = icsTime(value, tzid);
    else if (name === 'RRULE') ev.rrule = Object.fromEntries(value.split(';').map(kv => kv.split('=')));
    else if (name === 'EXDATE') value.split(',').forEach(v => ev.exdates.push(icsTime(v, tzid)));
    else if (name === 'STATUS') ev.status = value;
    else if (name === 'RECURRENCE-ID') ev.recurrenceId = icsTime(value, tzid);
    else if (name === 'UID') ev.uid = value;
  }
  return events.filter(e => e.status !== 'CANCELLED');
}

// A time from iCal: all-day (DATE), UTC (…Z) or wall-clock time in a zone.
function icsTime(value, tzid) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, , z] = m;
  if (h === undefined) return { allDay: true, date: `${y}-${mo}-${d}` };
  return { allDay: false, utc: !!z, tzid, y: +y, mo: +mo, d: +d, h: +h, mi: +mi };
}

// Local date and minutes-after-midnight in the display time zone.
function toLocal(t, timeZone) {
  if (t.allDay) return { date: t.date, min: 0 };
  if (t.utc || (t.tzid && t.tzid !== timeZone)) {
    let utcMs = Date.UTC(t.y, t.mo - 1, t.d, t.h, t.mi);
    if (!t.utc) {
      // Wall time in another zone: correct by that zone's offset at that moment.
      const p = localParts(new Date(utcMs), t.tzid);
      const [py, pm, pd] = p.date.split('-').map(Number);
      utcMs -= Date.UTC(py, pm - 1, pd, p.hour, p.minute) - utcMs;
    }
    const p = localParts(new Date(utcMs), timeZone);
    return { date: p.date, min: p.hour * 60 + p.minute };
  }
  const pad = n => String(n).padStart(2, '0');
  return { date: `${t.y}-${pad(t.mo)}-${pad(t.d)}`, min: t.h * 60 + t.mi };
}

const dayNumber = date => Math.round(Date.parse(`${date}T00:00:00Z`) / 86400000);

// Does a recurring event (DAILY / WEEKLY / MONTHLY / YEARLY) have an occurrence starting on `date`?
function occursOn(ev, startDate, date) {
  const r = ev.rrule;
  const diff = dayNumber(date) - dayNumber(startDate);
  if (diff < 0) return false;
  if (r.UNTIL) {
    const until = toLocal(icsTime(r.UNTIL, null), 'UTC').date;
    if (date > until) return false;
  }
  const interval = Number(r.INTERVAL || 1);
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  let ok;
  switch (r.FREQ) {
    case 'DAILY': ok = diff % interval === 0; break;
    case 'WEEKLY': {
      const days = r.BYDAY ? r.BYDAY.split(',').map(d => ICS_DAYS[d.slice(-2)]) : [new Date(`${startDate}T00:00:00Z`).getUTCDay()];
      const startMonday = dayNumber(startDate) - ((new Date(`${startDate}T00:00:00Z`).getUTCDay() + 6) % 7);
      const week = Math.floor((dayNumber(date) - startMonday) / 7);
      ok = days.includes(weekday) && week % interval === 0;
      break;
    }
    case 'MONTHLY': ok = date.slice(8) === startDate.slice(8); break;
    case 'YEARLY': ok = date.slice(5) === startDate.slice(5); break;
    default: ok = false;
  }
  if (!ok) return false;
  if (r.COUNT) {
    // Count occurrences up to and including this date (cheap for the rules handled here).
    let n = 0;
    for (let i = 0; i <= diff; i++) {
      const d = new Date((dayNumber(startDate) + i) * 86400000).toISOString().slice(0, 10);
      if (occursOn({ rrule: { ...r, COUNT: undefined } }, startDate, d)) n++;
    }
    if (n > Number(r.COUNT)) return false;
  }
  return true;
}

function eventsForDate(icsText, date, timeZone) {
  const all = parseIcs(icsText);
  // Moved or edited single occurrences of a recurring event replace the original one.
  const overridden = new Set(all.filter(e => e.recurrenceId)
    .map(e => `${e.uid}|${toLocal(e.recurrenceId, timeZone).date}`));
  const out = [];
  for (const ev of all) {
    const s = toLocal(ev.start, timeZone);
    const e = ev.end ? toLocal(ev.end, timeZone) : s;
    const lengthDays = dayNumber(e.date) - dayNumber(s.date);
    let startsToday;
    if (ev.rrule && !ev.recurrenceId) {
      if (overridden.has(`${ev.uid}|${date}`)) continue;
      if (ev.exdates.some(x => x && toLocal(x, timeZone).date === date)) continue;
      startsToday = occursOn(ev, s.date, date);
    } else {
      startsToday = s.date === date;
    }
    const spansToday = !ev.rrule && s.date < date && (e.date > date || (e.date === date && !ev.start.allDay && e.min > 0));
    if (!startsToday && !spansToday) continue;
    const allDay = ev.start.allDay || spansToday || (lengthDays >= 1 && !ev.rrule);
    const clockOf = min => `${String(Math.floor(min / 60)).padStart(2, '0')}.${String(min % 60).padStart(2, '0')}`;
    out.push({
      title: ev.title || 'Uten tittel',
      sort: allDay ? -1 : s.min,
      time: allDay ? 'Hele dagen' : (ev.end && e.min !== s.min ? `${clockOf(s.min)}–${clockOf(e.min)}` : clockOf(s.min))
    });
  }
  out.sort((x, y) => x.sort - y.sort);
  return {
    events: out.slice(0, MAX_EVENTS).map(({ title, time }) => ({ title, time })),
    more: Math.max(0, out.length - MAX_EVENTS)
  };
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

  // If NVE can't be reached we assume bare ground: a shell suit is the safer guess for the clothes.
  const snowCm = snowDepthOn(input && input.snow_depth, targetDate);
  // In midwinter we don't trust a missing or odd NVE value: winter suit regardless.
  const midwinter = WINTER_MONTHS.includes(Number(targetDate.slice(5, 7)));
  const snowOnGround = midwinter || (snowCm !== null && snowCm >= SNOW_DEPTH_CM);
  const items = mergeOutfits(outfit(m, { snowOnGround }), outfit(a, { snowOnGround }));

  const ics = findIcs(input);
  const calendar = ics ? eventsForDate(ics, targetDate, timeZone) : { events: [], more: 0 };

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
      text: describe(m, 'i formiddag')
    },
    periods: [
      {
        label: PERIODS.morning.label, range: PERIODS.morning.range, icon: m.kind,
        temp: fmtTemp(m.tMin), feels: `føles som ${fmtTemp(m.feels)}`, wind: `Vind ${fmtWind(m.wind)}`,
        text: `${KIND_TEXT[m.kind]}, vind ${fmtWind(m.wind)}`, say: describe(m, 'i formiddag')
      },
      {
        label: PERIODS.afternoon.label, range: PERIODS.afternoon.range, icon: a.kind,
        temp: fmtTemp(a.tMax), feels: `føles som ${fmtTemp(a.feels)}`, wind: `Vind ${fmtWind(a.wind)}`,
        text: `${KIND_TEXT[a.kind]}, vind ${fmtWind(a.wind)}`, say: describe(a, 'i ettermiddag')
      }
    ],
    strip,
    sun: sun.text,
    items,
    has_calendar: !!ics,
    events: calendar.events,
    more_events: calendar.more,
    tip
  };
}

// ---------- snow depth (NVE seNorge) ----------
// Yr's forecast says nothing about snow lying on the ground, so we ask NVE's seNorge
// model (daily snow depth on a 1×1 km grid, open data under NLOD, Norway only).
// The API wants UTM zone 33N coordinates.

const SNOW_DEPTH_CM = 5; // at least this much snow before a winter suit makes sense
const WINTER_MONTHS = [12, 1, 2]; // always winter suit in frost, whatever NVE says

function utm33(lat, lon) {
  const a = 6378137, f = 1 / 298.257222101, k0 = 0.9996, lon0 = 15 * Math.PI / 180;
  const e2 = f * (2 - f), ep2 = e2 / (1 - e2);
  const phi = lat * Math.PI / 180, lam = lon * Math.PI / 180;
  const N = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
  const T = Math.tan(phi) ** 2, C = ep2 * Math.cos(phi) ** 2, A = Math.cos(phi) * (lam - lon0);
  const M = a * ((1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * phi
    - (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * Math.sin(2 * phi)
    + (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * Math.sin(4 * phi)
    - (35 * e2 ** 3 / 3072) * Math.sin(6 * phi));
  const x = k0 * N * (A + (1 - T + C) * A ** 3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5 / 120) + 500000;
  const y = k0 * (M + N * Math.tan(phi) * (A * A / 2 + (5 - T + 9 * C + 4 * C * C) * A ** 4 / 24
    + (61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6 / 720));
  return { x: Math.round(x), y: Math.round(y) };
}

// Returns { 'YYYY-MM-DD': cm } for the last few days, or null if NVE can't be reached.
async function fetchSnowDepth(lat, lon, now, timeZone, fetchFn = globalThis.fetch) {
  if (!fetchFn || !isFinite(lat) || !isFinite(lon)) return null;
  const { x, y } = utm33(lat, lon);
  const to = localParts(now, timeZone).date;
  const from = localParts(new Date(now.getTime() - 3 * 86400000), timeZone).date;
  const url = `https://gts.nve.no/api/GridTimeSeries/${x}/${y}/${from}/${to}/sd.json`;
  try {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl && setTimeout(() => ctrl.abort(), 2500);
    const res = await fetchFn(url, ctrl ? { signal: ctrl.signal } : undefined);
    if (timer) clearTimeout(timer);
    if (!res.ok) return null;
    return parseSnowDepth(await res.json(), from);
  } catch (e) {
    return null;
  }
}

function parseSnowDepth(json, from) {
  if (!json || !Array.isArray(json.Data)) return null;
  const out = {};
  const start = new Date(from + 'T12:00:00Z');
  json.Data.forEach((v, i) => {
    if (typeof v !== 'number' || v === json.NoDataValue || v < 0 || v > 10000) return;
    out[new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10)] = v;
  });
  return Object.keys(out).length ? out : null;
}

// Latest known depth on or before the given date.
function snowDepthOn(depths, date) {
  if (!depths) return null;
  const days = Object.keys(depths).filter(d => d <= date).sort();
  const day = days.length ? days[days.length - 1] : Object.keys(depths).sort()[0];
  return day ? depths[day] : null;
}

async function run(input) {
  const now = new Date();
  const forecast = findForecast(input);
  const coords = (forecast && forecast.geometry && forecast.geometry.coordinates) || [];
  const lat = Number(field(input, 'lat', coords[1]));
  const lon = Number(field(input, 'lon', coords[0]));
  const timeZone = field(input, 'time_zone', null)
    || (input && input.trmnl && input.trmnl.user && input.trmnl.user.time_zone_iana)
    || 'Europe/Oslo';
  const [snow_depth, calendar_ics] = await Promise.all([
    fetchSnowDepth(lat, lon, now, timeZone),
    fetchCalendar(field(input, 'calendar_url', ''))
  ]);
  return build({ ...input, snow_depth, calendar_ics }, now);
}

if (typeof module !== 'undefined') module.exports = { run, build, feelsLike, sunElevation, outfit, eventsForDate, utm33, fetchSnowDepth, fetchCalendar };
