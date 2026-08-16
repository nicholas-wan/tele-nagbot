// Parses "/remind" arguments: assignee mention, schedule, time, nag config.
// Deterministic pattern matching — no LLM, no external parser.

import { localParts, zonedEpoch, nextOccurrence } from './time.js';

export const DEFAULT_NAGS = [15, 30, 60];
export const MAX_CHORE_TEXT = 200;

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
    // Only a standalone @word is an assignee — not the domain of an email.
    const m = args.match(/(^|\s)@(\w+)/);
    if (m) {
      assigneeName = `@${m[2]}`;
      args = args.replace(`@${m[2]}`, ' ');
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
  let defaultH = null; // "every morning/evening" implies a time-of-day

  // "rotate": each occurrence goes to whoever has the fewest ✅ this week.
  let rotate = false;
  const rotM = args.match(/\brotate\b/i);
  if (rotM) {
    rotate = true;
    args = args.replace(rotM[0], ' ');
  }

  // "from [this|next|the] friday": anchors the first occurrence to that day.
  let fromDay = null;
  const fromM = args.match(new RegExp(`\\bfrom\\s+(?:this\\s+|next\\s+|the\\s+)?(${DAY_WORD})\\b`, 'i'));
  if (fromM) {
    fromDay = DAY_INDEX[fromM[1].slice(0, 3).toLowerCase()];
    args = args.replace(fromM[0], ' ');
  }

  // "starting [from] 29 aug" / "from aug 29" / "from 29/8": a calendar anchor
  // for the first occurrence, so a fortnightly chore can begin on a stated
  // date rather than the next matching slot.
  let fromDate = null;
  const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  // Whole month words only. Matching "mar" as a prefix turned "15 Marina Bay"
  // into 15 March — the abbreviations are the start of too many real words.
  const MON_WORD = 'january|february|march|april|august|september|october|november|december|' +
    'june|july|jan|feb|mar|apr|may|jun|jul|aug|sept|sep|oct|nov|dec';
  const startPrefix = '(?:start(?:ing)?\\s+(?:from\\s+|on\\s+)?|from\\s+|on\\s+)';
  // The word-month forms don't need the prefix — a bare "13 sep" in a chore or
  // invite is almost certainly a date, and leaving it as title text once put
  // an event on the wrong day entirely. The numeric form keeps the prefix, so
  // prose like "split 3/4 of the boxes" stays prose.
  const dateM =
    args.match(new RegExp(`\\b${startPrefix}?(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MON_WORD})\\b\\.?`, 'i'))
    || args.match(new RegExp(`\\b${startPrefix}?(${MON_WORD})\\b\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'i'))
    || args.match(new RegExp(`\\b${startPrefix}(\\d{1,2})/(\\d{1,2})\\b`, 'i'));
  if (dateM) {
    const a = dateM[1].toLowerCase();
    const b = dateM[2].toLowerCase();
    // Either order: "29 aug" or "aug 29"; and numeric "29/8" is day/month.
    const dom = MONTHS[a.slice(0, 3)] !== undefined ? +b : +a;
    const mon = MONTHS[a.slice(0, 3)] !== undefined ? MONTHS[a.slice(0, 3)]
      : MONTHS[b.slice(0, 3)] !== undefined ? MONTHS[b.slice(0, 3)]
      : +b - 1;
    if (dom >= 1 && dom <= 31 && mon >= 0 && mon <= 11) {
      fromDate = { dom, mon };
      args = args.replace(dateM[0], ' ');
    }
  }

  // "every other saturday" is a fortnightly chore anchored to that weekday —
  // the bare "every other day|week" forms have no anchor to hang it on.
  const otherDayM = args.match(new RegExp(`\\bevery\\s+other\\s+(${DAY_WORD})\\b`, 'i'));
  if (otherDayM && fromDay == null) {
    fromDay = DAY_INDEX[otherDayM[1].slice(0, 3).toLowerCase()];
  }
  const otherM = otherDayM || args.match(/\bevery\s+other\s+(day|week)\b/i);
  const monthsM = args.match(/\bevery\s+(\d+)\s+months?\b/i);
  const weekdaysM = args.match(/\b(?:every\s+|on\s+)?(weekdays?|weekends?)\b/i);
  const periodM = args.match(/\bevery\s+(morning|afternoon|evening|night)\b/i);
  const dailyM = args.match(/\b(?:daily|every\s*day)\b/i);
  const intervalM = args.match(/\bevery\s+(\d+)\s+(days?|weeks?)\b/i);
  const weeklyM = args.match(new RegExp(`\\bevery\\s+(${DAY_WORD}(?:\\s*,\\s*${DAY_WORD})*)\\b`, 'i'));
  // Bare "on the Nth" only counts as a schedule when what follows can't be
  // prose ("on the 2nd floor" stays chore text); "monthly on the Nth" always.
  const monthlyM = args.match(/\bmonthly\s+on\s+the\s+(\d{1,2})(?:st|nd|rd|th)?\b/i)
    || args.match(/\bon\s+the\s+(\d{1,2})(?:st|nd|rd|th)?\b(?!\s+(?!at\b|nag:)[a-z])/i);

  if (otherM) {
    kind = 'interval';
    // Any weekday form means fortnightly; only "every other day" is 2 days.
    detail.days = otherM[1].toLowerCase() === 'day' ? 2 : 14;
    args = args.replace(otherM[0], ' ');
  } else if (monthsM) {
    const months = +monthsM[1];
    if (months < 1 || months > 24) throw new ParseError('Every how many months? 1–24.');
    kind = 'interval';
    detail.months = months;
    args = args.replace(monthsM[0], ' ');
  } else if (weekdaysM) {
    kind = 'weekly';
    detail.days = /weekend/i.test(weekdaysM[1]) ? [0, 6] : [1, 2, 3, 4, 5];
    args = args.replace(weekdaysM[0], ' ');
  } else if (periodM) {
    kind = 'daily';
    defaultH = { morning: 8, afternoon: 15, evening: 19, night: 21 }[periodM[1].toLowerCase()];
    args = args.replace(periodM[0], ' ');
  } else if (dailyM) {
    kind = 'daily';
    args = args.replace(dailyM[0], ' ');
  } else if (intervalM) {
    const days = +intervalM[1] * (/^w/i.test(intervalM[2]) ? 7 : 1);
    if (days < 1 || days > 365) throw new ParseError('Every how many days? 1–365 (or up to 52 weeks).');
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

  // Relative one-off in words: "in an hour", "in half an hour".
  const relWordM = args.match(/\bin\s+(half\s+an?|an?)\s+hour\b/i);
  if (relWordM && kind === 'once') {
    const ms = /^half/i.test(relWordM[1]) ? 30 * 60000 : 60 * 60000;
    args = args.replace(relWordM[0], ' ');
    return finish(args, {
      kind: 'once', detail: rotate ? { rotate } : {}, firstFireAt: nowMs + ms,
      assigneeName, assigneeUserId, nagIntervals,
    });
  }

  // Relative one-off: "in 20m", "in 2 hours".
  const relM = args.match(/\bin\s+(\d+)\s*(m|min|mins|minutes|h|hr|hrs|hours)\b/i);
  if (relM && kind === 'once') {
    const n = +relM[1];
    const ms = /^m/i.test(relM[2]) ? n * 60000 : n * 3600000;
    args = args.replace(relM[0], ' ');
    return finish(args, {
      kind: 'once', detail: rotate ? { rotate } : {}, firstFireAt: nowMs + ms,
      assigneeName, assigneeUserId, nagIntervals,
    });
  }

  // Immediate one-off: "/remind feed the cats now".
  const nowKw = args.match(/\bnow\b/i);
  if (nowKw && kind === 'once') {
    args = args.replace(nowKw[0], ' ');
    return finish(args, {
      kind: 'once', detail: rotate ? { rotate } : {}, firstFireAt: nowMs,
      assigneeName, assigneeUserId, nagIntervals,
    });
  }

  // Time of day: "7pm", "9:30am", "7.30pm", "at 19:00".
  let h = null, mi = 0;
  const t12 = args.match(/\b(?:at\s+)?(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b/i);
  const t24 = t12 ? null : args.match(/\b(?:at\s+)?(\d{1,2}):(\d{2})\b/);
  if (t12) {
    // Range-check so "30pm" (a mangled "7 30pm") errors instead of silently
    // becoming 6pm via the % 12.
    if (+t12[1] < 1 || +t12[1] > 12 || +(t12[2] || 0) > 59) {
      throw new ParseError(`"${t12[0].trim()}" is not a valid time.`);
    }
    h = +t12[1] % 12 + (t12[3].toLowerCase() === 'pm' ? 12 : 0);
    mi = +(t12[2] || 0);
    args = args.replace(t12[0], ' ');
  } else if (t24) {
    h = +t24[1];
    mi = +t24[2];
    if (h > 23 || mi > 59) throw new ParseError(`"${t24[0].trim()}" is not a valid time.`);
    args = args.replace(t24[0], ' ');
  }
  // Word times: "noon", "midnight"; then the implied hour from "every morning".
  if (h === null) {
    const wordT = args.match(/\b(?:at\s+)?(noon|midday|midnight)\b/i);
    if (wordT) {
      h = /midnight/i.test(wordT[1]) ? 0 : 12;
      args = args.replace(wordT[0], ' ');
    }
  }
  // "tomorrow morning", "sat afternoon": a part of day is a usable time.
  if (h === null) {
    const dayPart = args.match(/\b(morning|afternoon|evening|tonight|night)\b/i);
    if (dayPart) {
      h = { morning: 9, afternoon: 15, evening: 19, tonight: 21, night: 21 }[dayPart[1].toLowerCase()];
      args = args.replace(dayPart[0], ' ');
    }
  }
  // Bare "at 3": no am/pm, so lean on how people speak — 1–7 means afternoon
  // or evening, 8–11 means morning. Only the "at N" form; a bare number
  // without "at" stays ordinary text ("buy 3 apples").
  if (h === null) {
    const bare = args.match(/\bat\s+(\d{1,2})\b(?!\s*(?:am|pm|[:./]|\d))/i);
    if (bare && +bare[1] >= 1 && +bare[1] <= 23) {
      const n = +bare[1];
      h = n <= 7 ? n + 12 : n;
      args = args.replace(bare[0], ' ');
    }
  }
  if (h === null && defaultH != null) h = defaultH;
  if (h === null) {
    const text = cleanText(args);
    if (text) {
      validateText(text);
      const err = new NoTimeError('missing time');
      err.partial = { text, assigneeName, assigneeUserId, nagIntervals, kind, detail };
      // A stated date survives a missing time: "13 sep lunch" knows the day,
      // which is enough for an all-day event even though it can't nag.
      if (fromDate) err.partial.date = fromDate;
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
  if (rotate) detail.rotate = true;

  let firstFireAt;
  if (fromDate) {
    // A stated calendar date wins over a weekday anchor: "every other saturday
    // starting 29 aug" begins on the 29th and repeats fortnightly from there.
    const p = localParts(nowMs, tz);
    firstFireAt = zonedEpoch(p.y, fromDate.mon + 1, fromDate.dom, h, mi, tz);
    // A date already gone this year means they mean next year's.
    if (firstFireAt <= nowMs) {
      firstFireAt = zonedEpoch(p.y + 1, fromDate.mon + 1, fromDate.dom, h, mi, tz);
    }
  } else if (fromDay != null) {
    // Anchored start: first occurrence on the coming <weekday> at h:mi; the
    // recurring cadence (if any) continues from there.
    firstFireAt = nextOccurrence('weekly', { days: [fromDay], h, mi }, nowMs, tz);
  } else if (kind === 'once') {
    // One-off date: tomorrow / today / a weekday name / default (next slot).
    const p = localParts(nowMs, tz);
    const tomorrowM = args.match(/\btomorrow\b/i);
    const todayM = args.match(/\btoday\b/i);
    // A weekday only counts as a date when marked ("on/next fri") or left
    // dangling at the end — "buy sun hat" keeps its sun.
    const wdM = args.match(new RegExp(`\\b(?:on|next)\\s+(${DAY_WORD})\\b`, 'i'))
      || args.match(new RegExp(`\\b(${DAY_WORD})\\s*$`, 'i'));

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
  } else {
    // "tomorrow 7pm daily" starts tomorrow; strip the tokens from the text.
    let after = nowMs;
    const tm = args.match(/\btomorrow\b/i);
    if (tm) {
      args = args.replace(tm[0], ' ');
      const p = localParts(nowMs, tz);
      after = zonedEpoch(p.y, p.mo, p.d, 23, 59, tz);
    }
    const td = args.match(/\btoday\b/i);
    if (td) args = args.replace(td[0], ' ');
    // Interval first occurrence: the next h:mi slot; the N-day gap follows.
    firstFireAt = kind === 'interval'
      ? nextOccurrence('daily', { h, mi }, after, tz)
      : nextOccurrence(kind, detail, after, tz);
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
  validateText(text);
  return { ...out, text };
}

function validateText(text) {
  if ([...text].length > MAX_CHORE_TEXT) {
    throw new ParseError(`Keep the chore description to ${MAX_CHORE_TEXT} characters or fewer.`);
  }
}
