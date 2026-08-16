// /invite: reply with a tap-to-add calendar file for a meeting.
// No email, no external service — Telegram itself delivers the .ics; opening
// it on a phone offers "Add to Calendar" (Outlook, Google Calendar, or the
// system calendar, whichever the user picks).

import * as chrono from 'chrono-node';
import { esc, sendPrivate, sendDocument } from './tg.js';
import { NoTimeError } from './parse.js';
import { fmtLocal, zonedEpoch, localParts } from './time.js';

const DEFAULT_DURATION_MS = 3600000;

// "for 30m" / "for 2h" anywhere in the text sets the meeting length. Pulled
// out before schedule parsing, which would otherwise read it as title text.
export function extractDuration(args) {
  const m = args.match(/\bfor\s+(\d+)\s*(m|min|mins|minutes|h|hr|hrs|hours)\b/i);
  if (!m) return { args, durationMs: DEFAULT_DURATION_MS };
  const n = +m[1];
  const ms = /^h/i.test(m[2]) ? n * 3600000 : n * 60000;
  return { args: args.replace(m[0], ' '), durationMs: ms };
}

// Splits "meet alice at work" after schedule words are gone. Greedy prefix →
// the LAST " at " is the divider.
export function splitLocation(title) {
  const m = title.match(/^(.*\S)\s+at\s+(.+)$/i);
  if (!m) return { summary: title, location: null };
  return { summary: m[1], location: m[2] };
}

const STREET = new Set(['rd', 'road', 'st', 'street', 'ave', 'avenue', 'blvd', 'boulevard',
  'ln', 'lane', 'dr', 'drive', 'way', 'cres', 'crescent', 'link', 'walk', 'close', 'terrace',
  'ter', 'place', 'pl', 'quay', 'hill', 'park', 'gardens', 'garden', 'loop', 'rise', 'view',
  'green', 'circle', 'square', 'sq', 'highway', 'expressway', 'junction', 'central']);

// Words that end a title rather than begin a venue — the thing being attended.
const EVENT_WORD = new Set(['lunch', 'dinner', 'breakfast', 'brunch', 'supper', 'party',
  'bday', 'birthday', 'meeting', 'mtg', 'catchup', 'drinks', 'coffee', 'tea', 'session',
  'appointment', 'appt', 'visit', 'celebration', 'gathering', 'reunion', 'wedding', 'class',
  'training', 'interview', 'call', 'sync', 'standup', 'demo', 'review', 'checkup', 'date',
  'anniversary', 'farewell', 'steamboat', 'bbq', 'buffet', 'makan']);

const bare = (t) => t.replace(/[.,;]+$/, '').toLowerCase();

// Where a postal address begins: "80 Middle Rd", "Blk 123", "#02-15", "188966".
// The street suffix can sit a few words after the number ("80 Middle Rd", "1
// Fusionopolis View"), so scan ahead over capitalised words to find it.
function addressStart(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    const t = bare(tokens[i]);
    if (/^#\d+[-–]\d+/.test(t)) return i;
    if (/^(blk|block)$/.test(t) && /^\d/.test(bare(tokens[i + 1] || ''))) return i;
    if (/^\d{6}$/.test(t)) return i;
    if (/^\d{1,4}[a-z]?$/.test(t)) {
      for (let j = i + 1; j < Math.min(i + 5, tokens.length); j++) {
        if (STREET.has(bare(tokens[j]))) return i;
        if (!/^[A-Z]/.test(tokens[j])) break;
      }
    }
  }
  return -1;
}

// An address in the text means everything from the venue name onward is the
// place, with no "at" needed. The venue name is found by walking back from the
// street number over capitalised words — "Fu Yuan Restaurant" — and stopping
// at the event itself, so "Ahma Bday Lunch" is never swallowed.
export function detectLocation(title) {
  const tokens = title.split(/\s+/).filter(Boolean);
  const addr = addressStart(tokens);
  if (addr < 1) return { summary: title, location: null };
  let start = addr;
  while (start > 1) {
    const prev = tokens[start - 1];
    if (EVENT_WORD.has(bare(prev))) break;
    // Venue names are capitalised; a lowercase word is prose ("with", "for").
    if (!/^[A-Z#]/.test(prev)) break;
    start--;
  }
  const summary = tokens.slice(0, start).join(' ').replace(/[,\s]+$/, '');
  if (!summary) return { summary: title, location: null };
  return { summary, location: tokens.slice(start).join(' ') };
}

// Everything the command needs, or a NoTimeError/ParseError for the caller.
//
// Location and time fight over the word "at", and a place name can even look
// like a date — "Lau Pa Sat" ends in a weekday. So: peel the trailing " at X"
// off FIRST and try to parse the rest. If the rest still has a valid time, X
// was a place and the parser never gets to misread it. If the rest has no
// time, X was the time clause after all — reparse the full text and pull the
// location out of whatever title the parser leaves behind.

// An explicit "at" wins; otherwise an address in the text is found on its own.
const placeOf = (title) => {
  const viaAt = splitLocation(title);
  return viaAt.location ? viaAt : detectLocation(title);
};

// Rebuilds an epoch from chrono's calendar components using the chat's
// timezone. chrono resolves against the system clock, which is UTC in a
// Worker, so trusting its Date directly would put a 3pm meeting at 11pm.
function epochFrom(comp, tz) {
  return zonedEpoch(comp.get('year'), comp.get('month'), comp.get('day'),
    comp.get('hour') || 0, comp.get('minute') || 0, tz);
}

// Dates and times come from chrono-node — a maintained NL date parser that
// already knows "sat 2pm", "13 sep", "next tue", and ranges like "12pm to
// 2pm". The chore parser stays where it is: it owns recurrence, which chrono
// does not do, and an invite is always a one-off.
// chrono implies an hour even for a bare date, so "is this timed?" has to look
// at what was actually written. A part of the day counts as a time.
const DAY_PART = /\b(morning|afternoon|evening|tonight|night|noon|midnight)\b/i;
const PART_HOUR = { morning: 9, afternoon: 15, evening: 19, tonight: 21, night: 21, noon: 12, midnight: 0 };

export function parseInvite(args, now, tz) {
  const { args: rest, durationMs: statedDuration } = extractDuration(String(args).trim());
  // chrono reasons in the system timezone, which is UTC in a Worker and
  // something else on a laptop. Hand it a reference whose *local* components
  // are the chat's wall clock, and convert the answer back with zonedEpoch —
  // then neither "tomorrow" nor 3pm depends on where this runs.
  const p = localParts(now, tz);
  const ref = new Date(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  const results = chrono.parse(rest, ref, { forwardDate: true });
  if (!results.length) throw new NoTimeError('missing time');

  // A date and a time can land in separate matches when something sits between
  // them ("13 sep <address> 12pm"). Take the date from the first and the clock
  // from whichever match actually states one, and cut both out of the text.
  const dateR = results[0];
  const timeR = results.find((x) => x.start.isCertain('hour') || DAY_PART.test(x.text)) || null;
  const spans = [dateR, ...(timeR && timeR !== dateR ? [timeR] : [])];

  const part = timeR && (timeR.text.match(DAY_PART) || [])[1];
  const timed = Boolean(timeR);
  let hour = 0;
  let minute = 0;
  if (timed) {
    hour = part ? PART_HOUR[part.toLowerCase()] : timeR.start.get('hour');
    minute = part ? 0 : (timeR.start.get('minute') || 0);
    // "at 3" means the afternoon: chrono reads a bare hour literally.
    if (!part && !timeR.start.isCertain('meridiem') && hour >= 1 && hour <= 7) hour += 12;
  }
  const startMs = zonedEpoch(dateR.start.get('year'), dateR.start.get('month'),
    dateR.start.get('day'), hour, minute, tz);

  // "12pm to 2pm" carries its own end; otherwise "for 30m", else an hour.
  const durationMs = timeR && timeR.end && timed
    ? Math.max(epochFrom(timeR.end, tz) - epochFrom(timeR.start, tz), 60000)
    : statedDuration;

  let leftover = rest;
  for (const s of spans.sort((a, b) => b.index - a.index)) {
    leftover = `${leftover.slice(0, s.index)} ${leftover.slice(s.index + s.text.length)}`;
  }
  leftover = leftover.replace(/\s+/g, ' ').replace(/\s+,/g, ',').replace(/^[,\s]+|[,\s]+$/g, '').trim();
  const { summary, location } = placeOf(leftover);
  return {
    summary: summary || 'Event',
    location,
    startMs,
    durationMs,
    ...(timed ? {} : { allDay: true }),
  };
}

const pad = (n) => String(n).padStart(2, '0');
function icsUtc(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`;
}

// RFC 5545: CRLF line endings, escaped text values.
const icsEscape = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,');

// METHOD:PUBLISH, no attendees: this is a "save this event" file, not a
// request awaiting a response — phones offer Add to Calendar directly.
// An all-day VALUE=DATE is a calendar date, not an instant: midnight in
// Singapore is 4pm UTC the day before, so this must read the local day.
const icsDate = (ms, tz) => {
  const p = localParts(ms, tz);
  return `${p.y}${pad(p.mo)}${pad(p.d)}`;
};

export function buildIcs({ summary, location, startMs, durationMs, allDay = false,
  tz = 'Asia/Singapore', now = Date.now() }) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//nag-bot//invite//EN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:invite-${startMs}-${durationMs}@nag-bot`,
    `DTSTAMP:${icsUtc(now)}`,
    // An all-day event is a DATE value, and DTEND is the morning after.
    ...(allDay
      ? [`DTSTART;VALUE=DATE:${icsDate(startMs, tz)}`, `DTEND;VALUE=DATE:${icsDate(startMs + 86400000, tz)}`]
      : [`DTSTART:${icsUtc(startMs)}`, `DTEND:${icsUtc(startMs + durationMs)}`]),
    `SUMMARY:${icsEscape(summary)}`,
  ];
  if (location) lines.push(`LOCATION:${icsEscape(location)}`);
  lines.push('STATUS:CONFIRMED', 'END:VEVENT', 'END:VCALENDAR');
  return lines.join('\r\n');
}

const fileSlug = (s) => (String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  || 'invite').slice(0, 40);

export async function cmdInvite(env, ctx, args, tz) {
  if (!String(args).trim()) {
    return sendPrivate(env, ctx,
      '📅 Usage: /invite bday lunch 13 sep 12pm at Fu Yuan Restaurant, 80 Middle Rd\n' +
      'Needs a time; dates like <code>13 sep</code>, <code>tomorrow</code>, <code>mon</code> work. ' +
      'Put the place after <code>at</code>, and <code>for 30m</code>/<code>for 2h</code> sets the length (default 1h).');
  }
  let inv;
  try {
    inv = parseInvite(args, Date.now(), tz);
  } catch (err) {
    if (err instanceof NoTimeError) {
      return sendPrivate(env, ctx,
        '⏰ When is it? Give a time — e.g. /invite dentist tomorrow 3pm, /invite standup mon 9am.');
    }
    throw err; // ParseError → the dispatcher's private error reply
  }
  const ics = buildIcs({ ...inv, tz });
  // The caption doubles as the confirmation: it reads back exactly what was
  // parsed, so a misread time or a swallowed location shows up right here.
  const when = inv.allDay
    ? `${fmtLocal(inv.startMs, tz).replace(/,?\s*\d{1,2}:\d{2}\s*[AP]M$/i, '')} · all day`
    : `${fmtLocal(inv.startMs, tz)} · ${Math.round(inv.durationMs / 60000)} min`;
  const caption = `📅 <b>${esc(inv.summary)}</b>\n${when}` +
    (inv.location ? `\n📍 ${esc(inv.location)}` : '') +
    '\nTap the file → Add to Calendar.' +
    (inv.allDay ? '\n<i>Add a time to make it a timed event.</i>' : '');
  // The file goes to the whole group on purpose: a calendar entry is usually
  // for both of you, and either phone can tap it. Usage hints and errors stay
  // private — only the sender can act on those.
  const sent = await sendDocument(env, { ...ctx, ephemeral: false },
    `${fileSlug(inv.summary)}.ics`, ics, caption);
  // The command message is already gone by now — a failed upload must say so,
  // or the whole exchange vanishes without a trace.
  if (!sent.ok) {
    return sendPrivate(env, ctx,
      '🙀 The calendar file didn\'t go through — try /invite again in a moment.');
  }
  return sent;
}
