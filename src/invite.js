// /invite: reply with a tap-to-add calendar file for a meeting.
// No email, no external service — Telegram itself delivers the .ics; opening
// it on a phone offers "Add to Calendar" (Outlook, Google Calendar, or the
// system calendar, whichever the user picks).

import { esc, sendPrivate, sendDocument } from './tg.js';
import { parseRemind, NoTimeError } from './parse.js';
import { fmtLocal } from './time.js';

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

// Everything the command needs, or a NoTimeError/ParseError for the caller.
//
// Location and time fight over the word "at", and a place name can even look
// like a date — "Lau Pa Sat" ends in a weekday. So: peel the trailing " at X"
// off FIRST and try to parse the rest. If the rest still has a valid time, X
// was a place and the parser never gets to misread it. If the rest has no
// time, X was the time clause after all — reparse the full text and pull the
// location out of whatever title the parser leaves behind.
// Invites have no assignee concept — a chore parser strips "@name" as one, so
// hand the mention back to the title ("call with @boss" stays whole).
const withMention = (p) => (p.assigneeName ? `${p.text} ${p.assigneeName}` : p.text);

export function parseInvite(args, now, tz) {
  const { args: rest, durationMs } = extractDuration(String(args).trim());
  const trailing = rest.match(/^(.*\S)\s+at\s+(\S.*)$/i);
  if (trailing) {
    try {
      const p = parseRemind(trailing[1], `/invite ${trailing[1]}`, [], now, tz);
      return { summary: withMention(p), location: trailing[2], startMs: p.firstFireAt, durationMs };
    } catch (err) {
      if (!(err instanceof NoTimeError)) throw err;
    }
  }
  const p = parseRemind(rest, `/invite ${rest}`, [], now, tz);
  const { summary, location } = splitLocation(withMention(p));
  return { summary, location, startMs: p.firstFireAt, durationMs };
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
export function buildIcs({ summary, location, startMs, durationMs, now = Date.now() }) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//nag-bot//invite//EN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:invite-${startMs}-${durationMs}@nag-bot`,
    `DTSTAMP:${icsUtc(now)}`,
    `DTSTART:${icsUtc(startMs)}`,
    `DTEND:${icsUtc(startMs + durationMs)}`,
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
  const ics = buildIcs(inv);
  // The caption doubles as the confirmation: it reads back exactly what was
  // parsed, so a misread time or a swallowed location shows up right here.
  const caption = `📅 <b>${esc(inv.summary)}</b>\n` +
    `${fmtLocal(inv.startMs, tz)} · ${Math.round(inv.durationMs / 60000)} min` +
    (inv.location ? ` · ${esc(inv.location)}` : '') +
    '\nTap the file → Add to Calendar.';
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
