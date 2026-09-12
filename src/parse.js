// Parses "/remind" arguments: assignee mention, schedule, time, nag config.
// Deterministic pattern matching — no LLM, no external parser.

import { localParts, zonedEpoch, nextOccurrence, advanceOccurrence } from './time.js';

export const DEFAULT_NAGS = [15, 30, 60];
export const MAX_CHORE_TEXT = 200;

const DAY_INDEX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const DAY_WORD =
  '(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)';

export class ParseError extends Error {}

// Thrown when everything parsed except a time; .partial carries what did,
// so the bot can offer time-choice buttons instead of failing.
export class NoTimeError extends ParseError {}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// fullText/entities are the raw Telegram message + entities, used to catch
// text_mention (users without a public @username, carries their numeric id).
// nicknames maps a typed shortcut ("nic") to a roster spelling ("@nicholaswan")
// so an assignee can be named without an @-mention; see household.nicknames.
export function parseRemind(argsRaw, fullText, entities, nowMs, tz, nicknames = null) {
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
  // A configured nickname is an assignee too: "nic clear poop 9pm", "clear
  // poop for yx 9pm". Only a whole word counts (the "nic" in "picnic" is
  // text), an explicit mention still wins, and the earliest shortcut in the
  // message is the one meant. A leading "for" goes with it.
  if (!assigneeName && nicknames && nicknames.size) {
    let hit = null;
    for (const [nick, spelling] of nicknames) {
      const m = args.match(new RegExp(`(^|\\s)((?:for\\s+)?${escapeRe(nick)})(?=\\s|$)`, 'i'));
      if (m && (!hit || m.index < hit.index)) {
        hit = { index: m.index + m[1].length, length: m[2].length, spelling };
      }
    }
    if (hit) {
      assigneeName = hit.spelling;
      // Splice by position: a plain replace could hit the same letters inside
      // an earlier word.
      args = `${args.slice(0, hit.index)} ${args.slice(hit.index + hit.length)}`;
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

  // "from [this|next|the] friday" (or "starting friday"): anchors the first
  // occurrence to that day.
  let fromDay = null;
  const fromM = args.match(new RegExp(`\\b(?:from|start(?:ing)?)\\s+(?:this\\s+|next\\s+|the\\s+)?(${DAY_WORD})\\b`, 'i'));
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
  // The count is optional: "every month" is the way people say "every 1
  // month", and leaving it out used to drop the whole phrase into the chore
  // text — "rent every month" became a one-off named "rent every month".
  const monthsM = args.match(/\bevery\s+(?:(\d+)\s+)?months?\b/i);
  const weekdaysM = args.match(/\b(?:every\s+|on\s+)?(weekdays?|weekends?)\b/i);
  const periodM = args.match(/\bevery\s+(morning|afternoon|evening|night)\b/i);
  const dailyM = args.match(/\b(?:daily|every\s*day)\b/i);
  const intervalM = args.match(/\bevery\s+(\d+)\s+(days?|weeks?)\b/i);
  const weeklyM = args.match(new RegExp(`\\bevery\\s+(${DAY_WORD}(?:\\s*,\\s*${DAY_WORD})*)\\b`, 'i'));
  // Bare "on the Nth" only counts as a schedule when what follows can't be
  // prose ("on the 2nd floor" stays chore text); "monthly on the Nth" always.
  const monthlyM = args.match(/\bmonthly\s+on\s+the\s+(\d{1,2})(?:st|nd|rd|th)?\b/i)
    || args.match(/\bon\s+the\s+(\d{1,2})(?:st|nd|rd|th)?\b(?!\s+(?!at\b|nag:)[a-z])/i);

  // A day-of-month can qualify a month interval as well as stand on its own:
  // "every month on the 1st" is one schedule, not an interval followed by
  // title text. Validate it before cadence precedence chooses monthsM.
  const requestedDom = monthlyM ? +monthlyM[1] : null;
  if (requestedDom != null && (requestedDom < 1 || requestedDom > 31)) {
    throw new ParseError('Day of month must be 1–31.');
  }

  if (otherM) {
    kind = 'interval';
    // Any weekday form means fortnightly; only "every other day" is 2 days.
    detail.days = otherM[1].toLowerCase() === 'day' ? 2 : 14;
    args = args.replace(otherM[0], ' ');
  } else if (monthsM) {
    const months = monthsM[1] ? +monthsM[1] : 1;
    if (months < 1 || months > 24) throw new ParseError('Every how many months? 1–24.');
    // A monthly cadence on a named calendar day is the calendar rule itself.
    // Longer cadences remain anchored month intervals (for example, every
    // three months on the 2nd).
    if (months === 1 && requestedDom != null) {
      kind = 'monthly';
      detail.dom = requestedDom;
    } else {
      kind = 'interval';
      detail.months = months;
      if (requestedDom != null) detail.dom = requestedDom;
    }
    args = args.replace(monthsM[0], ' ');
    if (monthlyM) args = args.replace(monthlyM[0], ' ');
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
    kind = 'monthly';
    detail.dom = requestedDom;
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
      // A months interval re-clamps from a fixed day of the month each hop, and
      // that day is decided here — not after a time arrives. Handing the wizard
      // a bare { months: 1 } reintroduced the February drift the moment the
      // draft became a chore, so the anchor rides along in the partial: the
      // stated start date's day if there is one, else today's.
      if (kind === 'interval' && detail.months) {
        detail.dom ??= fromDate ? fromDate.dom : localParts(nowMs, tz).d;
      }
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
  // A month interval re-clamps from this day each hop, so "starting 31 jan"
  // keeps meaning the 31st instead of sliding down to February's 28th and
  // staying there. The anchor's own day wins; otherwise the first fire's.
  let intendedDom = detail.months ? detail.dom ?? null : null;
  if (fromDate) {
    // A stated calendar date wins over a weekday anchor: "every other saturday
    // starting 29 aug" begins on the 29th and repeats fortnightly from there.
    const p = localParts(nowMs, tz);
    intendedDom = fromDate.dom;
    firstFireAt = zonedEpoch(p.y, fromDate.mon + 1, fromDate.dom, h, mi, tz);
    if (firstFireAt <= nowMs) {
      if (kind === 'once') {
        // A one-off date already gone this year means they mean next year's.
        firstFireAt = zonedEpoch(p.y + 1, fromDate.mon + 1, fromDate.dom, h, mi, tz);
      } else if (kind === 'interval') {
        // A recurring chore's start date is the anchor its cadence counts from,
        // not a first fire that has to be in the future: "every 2 weeks starting
        // 29 aug" typed in September means the fortnight begun on the 29th, so
        // step forward from that past anchor instead of jumping a whole year.
        // advanceOccurrence does that jump arithmetically — walking it hop by
        // hop cost ~31ms for a New Year's anchor typed in December, three times
        // a Worker's CPU budget, so the webhook died and Telegram retried it
        // forever.
        if (detail.months) detail.dom = intendedDom;
        const next = advanceOccurrence('interval', detail, firstFireAt, nowMs, tz);
        if (next != null) firstFireAt = next;
      } else {
        // daily / weekly / monthly repeat on their own calendar terms, so a
        // past anchor has nothing left to contribute.
        const next = nextOccurrence(kind, detail, nowMs, tz);
        if (next != null) firstFireAt = next;
      }
    }
  } else if (fromDay != null) {
    // Anchored start: first occurrence on the coming <weekday> at h:mi; the
    // recurring cadence (if any) continues from there.
    firstFireAt = nextOccurrence('weekly', { days: [fromDay], h, mi }, nowMs, tz);
  } else if (kind === 'once') {
    // One-off date: tomorrow / today / a weekday name / default (next slot).
    const p = localParts(nowMs, tz);
    // "tmr" is ordinary chat shorthand for tomorrow. Consume a directly
    // attached "this" too, so "train ticket this tmr" does not leave a task
    // named "train ticket this"; a meaningful "this" elsewhere is untouched.
    const tomorrowM = args.match(/\b(?:this\s+)?(?:tomorrow|tmr)\b/i);
    const todayM = args.match(/\btoday\b/i);
    // A weekday only counts as a date when marked ("on/next/this fri") or
    // left dangling at the end — "buy sun hat" keeps its sun. The marker is
    // consumed too, or "book something this saturday" kept its "this".
    const wdM = args.match(new RegExp(`\\b(?:on|next|this)\\s+(${DAY_WORD})\\b`, 'i'))
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
    const tm = args.match(/\b(?:this\s+)?(?:tomorrow|tmr)\b/i);
    if (tm) {
      args = args.replace(tm[0], ' ');
      const p = localParts(nowMs, tz);
      after = zonedEpoch(p.y, p.mo, p.d, 23, 59, tz);
    }
    const td = args.match(/\btoday\b/i);
    if (td) args = args.replace(td[0], ' ');
    // Interval first occurrence: the next h:mi slot; the N-day gap follows.
    firstFireAt = kind === 'interval'
      ? detail.months && intendedDom != null
        // An explicit "on the Nth" determines the interval's first anchor.
        // Without one, month intervals retain their existing next-time-slot
        // behaviour and take that first fire's calendar day as the anchor.
        ? nextOccurrence('monthly', { dom: intendedDom, h, mi }, after, tz)
        : nextOccurrence('daily', { h, mi }, after, tz)
      : nextOccurrence(kind, detail, after, tz);
    // A stated "today" is a promise, not a hint: when the schedule's first
    // slot can't land today any more, say so instead of silently starting
    // tomorrow — "every 2 weeks today 6pm" sent at 6:22pm once became a
    // Sunday chore with no warning.
    if (td && !tm) {
      const f = localParts(firstFireAt, tz);
      const n = localParts(nowMs, tz);
      if (f.y !== n.y || f.mo !== n.mo || f.d !== n.d) {
        throw new ParseError('That can\'t start today — the time has already passed. Drop "today" or pick a later time.');
      }
    }
  }

  if (kind === 'interval' && detail.months && firstFireAt != null) {
    detail.dom = intendedDom ?? localParts(firstFireAt, tz).d;
  }

  return finish(args, { kind, detail, firstFireAt, assigneeName, assigneeUserId, nagIntervals });
}

function cleanText(args) {
  let text = args
    .replace(/\s+at\s*$/i, ' ')      // dangling "at" left by "call mom at 7pm"
    .replace(/\s+/g, ' ')
    .trim();

  // Chatty command wrappers are not part of the task name. Peel them from the
  // edges only: "please remind me to buy milk" becomes "buy milk", while a
  // meaningful word in the middle of a title is left alone. Repeat because
  // people naturally stack wrappers ("could you please remind me to ...").
  const leadingFiller = /^(?:(?:please|pls|plz|kindly)\s+|(?:can|could|would)\s+you\s+(?:please\s+)?|remind\s+me\s+to\s+|remember\s+to\s+|i\s+(?:need|have|want)\s+to\s+|help\s+me\s+(?:to\s+)?)/i;
  const trailingFiller = /\s+(?:please|pls|plz|thanks|thank\s+you)[.!]*$/i;
  let before;
  do {
    before = text;
    text = text.replace(leadingFiller, '').replace(trailingFiller, '').trim();
  } while (text !== before);
  return text;
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
