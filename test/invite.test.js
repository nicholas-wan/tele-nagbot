// /invite: parsing (time, date, location, duration) and the .ics itself.
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { parseInvite, buildIcs, splitLocation, extractDuration, cmdInvite } from '../src/invite.js';
import { NoTimeError } from '../src/parse.js';

const TZ = 'Asia/Singapore';
const NOW = Date.UTC(2026, 7, 14, 4, 0); // Fri 14 Aug 2026, noon SGT
const sgt = (ms) => new Date(ms + 8 * 3600000).toISOString().slice(0, 16);

describe('parseInvite', () => {
  it('parses time, date, and a trailing location', () => {
    const inv = parseInvite('dentist tomorrow 3pm at Mount E', NOW, TZ);
    expect(inv.summary).toBe('dentist');
    expect(inv.location).toBe('Mount E');
    expect(sgt(inv.startMs)).toBe('2026-08-15T15:00');
    expect(inv.durationMs).toBe(3600000);
  });

  it('does not mistake a time for a location', () => {
    const inv = parseInvite('lunch at 1pm', NOW, TZ);
    expect(inv.summary).toBe('lunch');
    expect(inv.location).toBeNull();
    expect(sgt(inv.startMs)).toBe('2026-08-14T13:00');
  });

  it('takes the last at as the location when both appear', () => {
    const inv = parseInvite('dinner at 7pm at Lau Pa Sat', NOW, TZ);
    expect(inv.summary).toBe('dinner');
    expect(inv.location).toBe('Lau Pa Sat');
    expect(sgt(inv.startMs)).toBe('2026-08-14T19:00');
  });

  it('reads calendar dates and weekdays', () => {
    expect(sgt(parseInvite('review on 29 aug 10am', NOW, TZ).startMs)).toBe('2026-08-29T10:00');
    expect(sgt(parseInvite('standup mon 9am', NOW, TZ).startMs)).toBe('2026-08-17T09:00');
  });

  it('honours a duration and strips it from the title', () => {
    const inv = parseInvite('sync tomorrow 2pm for 30m at Level 5', NOW, TZ);
    expect(inv.durationMs).toBe(1800000);
    expect(inv.summary).toBe('sync');
    expect(inv.location).toBe('Level 5');
  });

  it('demands a time', () => {
    expect(() => parseInvite('dentist at Mount E', NOW, TZ)).toThrow(NoTimeError);
  });
});

describe('buildIcs', () => {
  it('renders UTC times, the location, and CRLF line endings', () => {
    const ics = buildIcs({
      summary: 'dentist', location: 'Mount E, Level 3',
      startMs: Date.UTC(2026, 7, 15, 7, 0), durationMs: 1800000, now: NOW,
    });
    expect(ics).toContain('DTSTART:20260815T070000Z');
    expect(ics).toContain('DTEND:20260815T073000Z');
    expect(ics).toContain('SUMMARY:dentist');
    // Commas are escaped per RFC 5545.
    expect(ics).toContain('LOCATION:Mount E\\, Level 3');
    expect(ics).toContain('METHOD:PUBLISH');
    expect(ics.split('\r\n').length).toBeGreaterThan(10);
  });

  it('omits LOCATION when there is none', () => {
    const ics = buildIcs({ summary: 'x', location: null, startMs: NOW, durationMs: 3600000, now: NOW });
    expect(ics).not.toContain('LOCATION');
  });
});

describe('splitLocation / extractDuration', () => {
  it('splits on the last at', () => {
    expect(splitLocation('meet alice at work')).toEqual({ summary: 'meet alice', location: 'work' });
    expect(splitLocation('no place here')).toEqual({ summary: 'no place here', location: null });
  });
  it('reads hours and minutes', () => {
    expect(extractDuration('x for 2h').durationMs).toBe(7200000);
    expect(extractDuration('x for 45 min').durationMs).toBe(2700000);
  });
});

describe('cmdInvite', () => {
  const calls = [];
  beforeEach(() => {
    calls.length = 0;
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      calls.push({ url: String(url), body: init && init.body });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 0, ephemeral_message_id: 7 } }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  const env = () => ({
    BOT_TOKEN: 't',
    DB: { prepare() { return { bind() { return {
      async first() { return null; }, async all() { return { results: [] }; },
      async run() { return { meta: { changes: 1, last_row_id: 1 } }; },
    }; } }; } },
  });
  const ctx = { chatId: 1, userId: 2, ephemeral: true, callbackQueryId: null, replyEphemeralId: null, at: Date.now() };

  it('sends the ics as a document addressed to the requester', async () => {
    await cmdInvite(env(), { ...ctx }, 'dentist tomorrow 3pm at Mount E', TZ);
    const sent = calls.find((c) => c.url.endsWith('/sendDocument'));
    expect(sent).toBeTruthy();
    expect(sent.body).toBeInstanceOf(FormData);
    expect(sent.body.get('receiver_user_id')).toBe('2');
    const file = sent.body.get('document');
    expect(file.name).toBe('dentist.ics');
    expect(await file.text()).toContain('SUMMARY:dentist');
    expect(sent.body.get('caption')).toContain('Mount E');
  });

  it('explains itself when the time is missing', async () => {
    await cmdInvite(env(), { ...ctx }, 'dentist at Mount E', TZ);
    expect(calls.some((c) => c.url.endsWith('/sendDocument'))).toBe(false);
    expect(calls.some((c) => c.url.endsWith('/sendMessage'))).toBe(true);
  });

  it('says so when the upload fails, instead of vanishing silently', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      calls.push({ url: String(url), body: init && init.body });
      const failing = String(url).endsWith('/sendDocument');
      return new Response(JSON.stringify(failing
        ? { ok: false, description: 'boom' }
        : { ok: true, result: { message_id: 9 } }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }));
    await cmdInvite(env(), { ...ctx }, 'dentist tomorrow 3pm', TZ);
    const note = calls.find((c) => c.url.endsWith('/sendMessage'));
    expect(note).toBeTruthy();
    expect(JSON.parse(note.body).text).toContain('didn');
  });
});
