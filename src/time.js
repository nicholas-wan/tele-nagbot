// Timezone math without a date library. All storage is UTC epoch ms; the
// household timezone (IANA name in settings) is used for parsing and display.

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const DAY_NAMES = WD;

// Building an Intl.DateTimeFormat costs ~60µs, and localParts runs several
// times per zonedEpoch, which itself runs once per schedule hop. On a Worker's
// ~10ms CPU budget that adds up fast, and the formatters are immutable — so
// keep one per (timezone, option set) for the life of the isolate.
const FORMATTERS = new Map();
function formatter(key, tz, options) {
  const cacheKey = `${key}|${tz}`;
  let dtf = FORMATTERS.get(cacheKey);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, ...options });
    FORMATTERS.set(cacheKey, dtf);
  }
  return dtf;
}

const PARTS_OPTS = {
  year: 'numeric', month: 'numeric', day: 'numeric',
  hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false, weekday: 'short',
};

export function localParts(epochMs, tz) {
  const dtf = formatter('parts', tz, PARTS_OPTS);
  const p = {};
  for (const part of dtf.formatToParts(new Date(epochMs))) p[part.type] = part.value;
  return {
    y: +p.year, mo: +p.month, d: +p.day,
    h: +p.hour % 24, mi: +p.minute, s: +p.second,
    wd: WD.indexOf(p.weekday),
  };
}

// Epoch ms for a wall-clock time in tz. Iterative offset correction; converges
// in one or two steps for every real timezone.
export function zonedEpoch(y, mo, d, h, mi, tz) {
  let guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  for (let i = 0; i < 3; i++) {
    const p = localParts(guess, tz);
    const diff = Date.UTC(y, mo - 1, d, h, mi, 0) - Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
    if (diff === 0) break;
    guess += diff;
  }
  return guess;
}

// Calendar-date arithmetic (weekday of a calendar date is tz-independent).
function dateAdd(y, mo, d, days) {
  const dt = new Date(Date.UTC(y, mo - 1, d + days));
  return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate(), wd: dt.getUTCDay() };
}

function daysInMonth(y, mo) {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

// Next fire time strictly after afterMs, or null for one-offs.
export function nextOccurrence(kind, detail, afterMs, tz) {
  if (kind === 'once') return null;
  const p = localParts(afterMs, tz);

  if (kind === 'daily') {
    for (let i = 0; i <= 1; i++) {
      const c = dateAdd(p.y, p.mo, p.d, i);
      const t = zonedEpoch(c.y, c.mo, c.d, detail.h, detail.mi, tz);
      if (t > afterMs) return t;
    }
  }

  if (kind === 'weekly') {
    for (let i = 0; i <= 7; i++) {
      const c = dateAdd(p.y, p.mo, p.d, i);
      if (!detail.days.includes(c.wd)) continue;
      const t = zonedEpoch(c.y, c.mo, c.d, detail.h, detail.mi, tz);
      if (t > afterMs) return t;
    }
  }

  if (kind === 'interval') {
    // N months after the last firing's calendar date (day clamped), or
    // N days after it, at the set time.
    if (detail.months) {
      let y = p.y, mo = p.mo + detail.months;
      while (mo > 12) { mo -= 12; y++; }
      // Re-clamp from the *intended* day, not from the last hop's clamped one:
      // clamping "the 31st" against February and then carrying the 28th forward
      // walks a monthly chore off the end of the month and leaves it there.
      // Rows written before detail.dom existed fall back to the old behaviour.
      const d = Math.min(detail.dom ?? p.d, daysInMonth(y, mo));
      return zonedEpoch(y, mo, d, detail.h, detail.mi, tz);
    }
    const c = dateAdd(p.y, p.mo, p.d, detail.days);
    return zonedEpoch(c.y, c.mo, c.d, detail.h, detail.mi, tz);
  }

  if (kind === 'monthly') {
    for (let i = 0; i <= 1; i++) {
      let y = p.y, mo = p.mo + i;
      if (mo > 12) { mo -= 12; y++; }
      const d = Math.min(detail.dom, daysInMonth(y, mo));
      const t = zonedEpoch(y, mo, d, detail.h, detail.mi, tz);
      if (t > afterMs) return t;
    }
  }

  return null;
}

// Advance a schedule after a due occurrence is processed. Calendar schedules
// can skip straight past an outage, but intervals must stay anchored to the
// scheduled occurrence or a late cron tick can permanently shift their date.
//
// The gap can be enormous — a start date months in the past, or a chore that
// slept through a long outage — so the hop count is computed arithmetically
// rather than walked. Hopping cost ~0.18ms each; 400 of them blew three times
// through a Worker's CPU budget and killed the request outright.
export function advanceOccurrence(kind, detail, scheduledAt, processedAt, tz) {
  if (kind !== 'interval') return nextOccurrence(kind, detail, processedAt, tz);
  if (detail.months) return advanceMonths(detail, scheduledAt, processedAt, tz);
  if (detail.days) return advanceDays(detail, scheduledAt, processedAt, tz);
  return nextOccurrence(kind, detail, scheduledAt, tz);
}

// Occurrence k is the anchor's calendar date plus k*days at h:mi, so the first
// k past processedAt is one division away. floor() can only land on or before
// the answer (a whole hop is at least two days, the wall-clock and DST slack
// under 25h), so the correction only ever steps forward, once or twice.
function advanceDays(detail, scheduledAt, processedAt, tz) {
  const a = localParts(scheduledAt, tz);
  const k = Math.max(1, Math.floor((processedAt - scheduledAt) / (detail.days * 86400000)));
  const c = dateAdd(a.y, a.mo, a.d, k * detail.days);
  let next = zonedEpoch(c.y, c.mo, c.d, detail.h, detail.mi, tz);
  for (let i = 0; i < 4 && next <= processedAt; i++) {
    next = nextOccurrence('interval', detail, next, tz);
  }
  return next;
}

// Same idea on the calendar: count whole months from the anchor to the month
// processedAt falls in, round up to a multiple of the cadence, and clamp the
// day once. Landing in processedAt's own month may still be too early, so at
// most one corrective hop follows.
function advanceMonths(detail, scheduledAt, processedAt, tz) {
  const a = localParts(scheduledAt, tz);
  const p = localParts(processedAt, tz);
  const dom = detail.dom ?? a.d;
  const gap = (p.y - a.y) * 12 + (p.mo - a.mo);
  const k = Math.max(1, Math.ceil(gap / detail.months));
  let y = a.y, mo = a.mo + k * detail.months;
  y += Math.floor((mo - 1) / 12);
  mo = ((mo - 1) % 12) + 1;
  const stable = { ...detail, dom };
  let next = zonedEpoch(y, mo, Math.min(dom, daysInMonth(y, mo)), detail.h, detail.mi, tz);
  for (let i = 0; i < 2 && next <= processedAt; i++) {
    next = nextOccurrence('interval', stable, next, tz);
  }
  return next;
}

// Household quiet hours: bot-initiated re-nags never land between 11pm and
// 8am local — anything due in that window waits for 8am. Scheduled reminder
// times themselves are honored as set.
export function deferQuietHours(ms, tz) {
  const p = localParts(ms, tz);
  if (p.h >= 23) {
    const c = dateAdd(p.y, p.mo, p.d, 1);
    return zonedEpoch(c.y, c.mo, c.d, 8, 0, tz);
  }
  if (p.h < 8) return zonedEpoch(p.y, p.mo, p.d, 8, 0, tz);
  return ms;
}

export function fmtLocal(epochMs, tz) {
  return formatter('local', tz, {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(epochMs));
}

// Midnight at the start of the current week (Monday) in tz.
export function weekStart(epochMs, tz) {
  const p = localParts(epochMs, tz);
  const dt = new Date(Date.UTC(p.y, p.mo - 1, p.d - ((p.wd + 6) % 7)));
  return zonedEpoch(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate(), 0, 0, tz);
}

export function fmtShort(epochMs, tz) {
  return formatter('short', tz, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(epochMs));
}

export function fmtClock(epochMs, tz) {
  return formatter('clock', tz, {
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(epochMs));
}

export function fmtTime(h, mi) {
  const ampm = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return mi ? `${h12}:${String(mi).padStart(2, '0')}${ampm}` : `${h12}${ampm}`;
}
