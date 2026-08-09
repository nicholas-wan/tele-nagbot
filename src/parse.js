// Parses "/remind" arguments: assignee mention, schedule, time, nag config.
// Deterministic pattern matching — no LLM, no external parser.

import { localParts, zonedEpoch, nextOccurrence } from './time.js';

export const DEFAULT_NAGS = [15, 30, 60];

const DAY_INDEX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const DAY_WORD =
  '(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)';

export class ParseError extends Error {}

// Thrown when everything parsed except a time; .partial carries what did,
// so the bot can offer time-choice buttons instead of failing.
export class NoTimeError extends ParseError {}

// fullText/entities are the raw Telegram message + entities, used to catch
// text_mention (users without a public @username, carries their numeric id).
export function parseRemind(argsRaw, fullText, entities, nowMs, tz) {
  let args = ` ${argsRaw.trim()} `;

  // Assignee: text_mention entity first (has user id), else plain @username.
  let assigneeName = null;
  let assigneeUserId = null;
  const textMention = (entities || []).find((e) => e.type === 'text_mention');
  if (textMention) {
    const mentioned = fullText.substr(textMention.offset, textMention.length);
    if (args.includes(mentioned)) {
      assigneeName = textMention.user.first_name || mentioned;
      assigneeUserId = textMention.user.id;
      args = args.replace(mentioned, ' ');
    }
  } else {
    const m = args.match(/@(\w+)/);
    if (m) {
      assigneeName = `@${m[1]}`;
      args = args.replace(m[0], ' ');
    }
  }

  // Per-reminder nag interval override: "nag:10m" -> fixed 10-minute nags.
  let nagIntervals = DEFAULT_NAGS;
  const nagM = args.match(/\bnag:(\d+)\s*m?\b/i);
  if (nagM) {
    const n = Math.max(1, +nagM[1]);
    nagIntervals = [n];
    args = args.replace(nagM[0], ' ');
  }

  // Schedule kind.
  let kind = 'once';
  let detail = {};

  const dailyM = args.match(/\b(?:daily|every\s*day)\b/i);
  const intervalM = args.match(/\bevery\s+(\d+)\s+days?\b/i);
  const weeklyM = args.match(new RegExp(`\\bevery\\s+(${DAY_WORD}(?:\\s*,\\s*${DAY_WORD})*)\\b`, 'i'));
  const monthlyM = args.match(/\b(?:monthly\s+)?on\s+the\s+(\d{1,2})(?:st|nd|rd|th)?\b/i);

  if (dailyM) {
    kind = 'daily';
    args = args.replace(dailyM[0], ' ');
  } else if (intervalM) {
    const days = +intervalM[1];
    if (days < 1 || days > 365) throw new ParseError('Every how many days? 1–365.');
    kind = days === 1 ? 'daily' : 'interval';
    if (kind === 'interval') detail.days = days;
    args = args.replace(intervalM[0], ' ');
  } else if (weeklyM) {
    kind = 'weekly';
    const days = [...new Set(
      weeklyM[1].split(',').map((d) => DAY_INDEX[d.trim().slice(0, 3).toLowerCase()])
    )].sort();
    detail.days = days;
    args = args.replace(weeklyM[0], ' ');
  } else if (monthlyM) {
    const dom = +monthlyM[1];
    if (dom < 1 || dom > 31) throw new ParseError('Day of month must be 1–31.');
    kind = 'monthly';
    detail.dom = dom;
    args = args.replace(monthlyM[0], ' ');
  }

  // Relative one-off: "in 20m", "in 2 hours".
  const relM = args.match(/\bin\s+(\d+)\s*(m|min|mins|minutes|h|hr|hrs|hours)\b/i);
  if (relM && kind === 'once') {
    const n = +relM[1];
    const ms = /^m/i.test(relM[2]) ? n * 60000 : n * 3600000;
    args = args.replace(relM[0], ' ');
    return finish(args, {
      kind: 'once', detail: {}, firstFireAt: nowMs + ms,
      assigneeName, assigneeUserId, nagIntervals,
    });
  }

  // Immediate one-off: "/remind feed the cats now".
  const nowKw = args.match(/\bnow\b/i);
  if (nowKw && kind === 'once') {
    args = args.replace(nowKw[0], ' ');
    return finish(args, {
      kind: 'once', detail: {}, firstFireAt: nowMs,
      assigneeName, assigneeUserId, nagIntervals,
    });
  }

  // Time of day: "7pm", "9:30am", "at 19:00".
  let h = null, mi = 0;
  const t12 = args.match(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  const t24 = t12 ? null : args.match(/\b(?:at\s+)?(\d{1,2}):(\d{2})\b/);
  if (t12) {
    h = +t12[1] % 12 + (t12[3].toLowerCase() === 'pm' ? 12 : 0);
    mi = +(t12[2] || 0);
    args = args.replace(t12[0], ' ');
  } else if (t24) {
    h = +t24[1];
    mi = +t24[2];
    if (h > 23 || mi > 59) throw new ParseError(`"${t24[0].trim()}" is not a valid time.`);
    args = args.replace(t24[0], ' ');
  }
  if (h === null) {
    const text = cleanText(args);
    if (text) {
      const err = new NoTimeError('missing time');
      err.partial = { text, assigneeName, assigneeUserId, nagIntervals, kind, detail };
      throw err;
    }
    throw new ParseError(
      'I could not find a time. Examples:\n' +
      '/remind take out trash 7pm daily\n' +
      '/remind @jane water plants every mon,thu 8am\n' +
      '/remind pay rent on the 1st 10am\n' +
      '/remind call the plumber tomorrow 9:30am\n' +
      '/remind check the oven in 20m'
    );
  }
  detail.h = h;
  detail.mi = mi;

  let firstFireAt;
  if (kind === 'once') {
    // One-off date: tomorrow / today / a weekday name / default (next slot).
    const p = localParts(nowMs, tz);
    const tomorrowM = args.match(/\btomorrow\b/i);
    const todayM = args.match(/\btoday\b/i);
    const wdM = args.match(new RegExp(`\\b(?:on\\s+)?(${DAY_WORD})\\b`, 'i'));

    if (tomorrowM) {
      args = args.replace(tomorrowM[0], ' ');
      firstFireAt = nextOccurrence('daily', detail, zonedEpoch(p.y, p.mo, p.d, 23, 59, tz), tz);
    } else if (wdM && !todayM) {
      args = args.replace(wdM[0], ' ');
      const day = DAY_INDEX[wdM[1].slice(0, 3).toLowerCase()];
      firstFireAt = nextOccurrence('weekly', { ...detail, days: [day] }, nowMs, tz);
    } else {
      if (todayM) args = args.replace(todayM[0], ' ');
      firstFireAt = zonedEpoch(p.y, p.mo, p.d, h, mi, tz);
      if (firstFireAt <= nowMs) {
        if (todayM) throw new ParseError('That time has already passed today.');
        firstFireAt = nextOccurrence('daily', detail, nowMs, tz);
      }
    }
  } else if (kind === 'interval') {
    // First occurrence: the next h:mi slot; the N-day gap applies after that.
    firstFireAt = nextOccurrence('daily', { h, mi }, nowMs, tz);
  } else {
    firstFireAt = nextOccurrence(kind, detail, nowMs, tz);
  }

  return finish(args, { kind, detail, firstFireAt, assigneeName, assigneeUserId, nagIntervals });
}

function cleanText(args) {
  return args
    .replace(/\s+at\s*$/i, ' ')      // dangling "at" left by "call mom at 7pm"
    .replace(/\s+/g, ' ')
    .trim();
}

function finish(args, out) {
  const text = cleanText(args);
  if (!text) throw new ParseError('The reminder needs some text, e.g. /remind take out trash 7pm daily');
  return { ...out, text };
}
