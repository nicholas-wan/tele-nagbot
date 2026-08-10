// Timezone math without a date library. All storage is UTC epoch ms; the
// household timezone (IANA name in settings) is used for parsing and display.

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function localParts(epochMs, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false, weekday: 'short',
  });
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
    // N days after the last firing's calendar date, at the set time.
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
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'short', month: 'short', day: 'numeric',
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
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(epochMs));
}

export function fmtClock(epochMs, tz) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(epochMs));
}

export function fmtTime(h, mi) {
  const ampm = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return mi ? `${h12}:${String(mi).padStart(2, '0')}${ampm}` : `${h12}${ampm}`;
}
