// Workers-AI fallback for /remind texts the regex parser couldn't schedule.
// Returns {kind, detail, firstFireAt, label} or null. The model's output is
// strictly validated here and only ever applied after the user taps a
// confirmation button in the wizard — it can never schedule silently.

import { localParts, nextOccurrence, fmtTime } from './time.js';

const MODEL = '@cf/meta/llama-3.1-8b-instruct';
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export async function suggestSchedule(env, text, tz, now) {
  const p = localParts(now, tz);
  const pad = (n) => String(n).padStart(2, '0');
  const res = await env.AI.run(MODEL, {
    max_tokens: 150,
    messages: [
      { role: 'system', content:
        `You extract chore-reminder schedules. Current local time: ${DAY_NAMES[p.wd]} ` +
        `${p.y}-${pad(p.mo)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)} (${tz}). ` +
        'Reply with ONLY a JSON object, no prose: ' +
        '{"kind":"once"|"daily"|"weekly"|"monthly"|"interval"|null,' +
        '"h":hour 0-23,"mi":minute 0-59,' +
        '"days":[weekday numbers 0-6, 0=Sunday] (weekly only),' +
        '"dom":1-31 (monthly only),"every_days":2-365 (interval only),' +
        '"in_minutes":positive integer (once only, for relative times)}. ' +
        'Use {"kind":null} when no time or schedule can be inferred.' },
      { role: 'user', content: String(text).slice(0, 300) },
    ],
  });
  const m = String((res && res.response) || '').match(/\{[\s\S]*?\}/);
  if (!m) return null;
  let j;
  try { j = JSON.parse(m[0]); } catch { return null; }
  return validate(j, tz, now);
}

function validate(j, tz, now) {
  const int = Number.isInteger;
  const h = int(j.h) && j.h >= 0 && j.h <= 23 ? j.h : null;
  const mi = int(j.mi) && j.mi >= 0 && j.mi <= 59 ? j.mi : 0;

  if (j.kind === 'once' && int(j.in_minutes) && j.in_minutes > 0 && j.in_minutes <= 7 * 1440) {
    return { kind: 'once', detail: {}, firstFireAt: now + j.in_minutes * 60000, label: `in ${fmtDur(j.in_minutes)}` };
  }
  if (h === null) return null;
  const detail = { h, mi };
  if (j.kind === 'once') {
    const firstFireAt = nextOccurrence('daily', detail, now, tz);
    const today = localParts(firstFireAt, tz).d === localParts(now, tz).d;
    return { kind: 'once', detail, firstFireAt, label: `${today ? 'today' : 'tomorrow'} ${fmtTime(h, mi)}` };
  }
  if (j.kind === 'daily') {
    return withNext('daily', detail, tz, now, `daily ${fmtTime(h, mi)}`);
  }
  if (j.kind === 'weekly' && Array.isArray(j.days)) {
    const days = [...new Set(j.days.filter((d) => int(d) && d >= 0 && d <= 6))].sort();
    if (!days.length) return null;
    return withNext('weekly', { ...detail, days }, tz, now,
      `every ${days.map((d) => DAY_NAMES[d]).join(',')} ${fmtTime(h, mi)}`);
  }
  if (j.kind === 'monthly' && int(j.dom) && j.dom >= 1 && j.dom <= 31) {
    return withNext('monthly', { ...detail, dom: j.dom }, tz, now, `on the ${j.dom} at ${fmtTime(h, mi)}`);
  }
  if (j.kind === 'interval' && int(j.every_days) && j.every_days >= 2 && j.every_days <= 365) {
    // First occurrence at the next h:mi slot, matching the parser's interval rule.
    return { kind: 'interval', detail: { ...detail, days: j.every_days },
      firstFireAt: nextOccurrence('daily', detail, now, tz), label: `every ${j.every_days} days ${fmtTime(h, mi)}` };
  }
  return null;
}

function withNext(kind, detail, tz, now, label) {
  const firstFireAt = nextOccurrence(kind, detail, now, tz);
  return firstFireAt ? { kind, detail, firstFireAt, label } : null;
}

function fmtDur(min) {
  if (min % 60 === 0) return `${min / 60}h`;
  return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h${min % 60}m`;
}
