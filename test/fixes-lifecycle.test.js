// Firing-lifecycle fixes: a postponement is not a failure, a pause really
// freezes the expiry clock, resuming keeps a chore's place in the queue, an
// assignee without a Telegram username still gets a private nag, and vacation
// mode outranks "/chore … now".
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { fireReminder } from '../src/firing.js';
import { setReminderPaused, fireIfDue, wakeChat, completeEarly } from '../src/chores.js';
import { renagPending } from '../src/cron.js';
import { zonedEpoch } from '../src/time.js';
import { withBatch } from './d1.js';

const TZ = 'Asia/Singapore';
const HOUR = 3600000;
const DAY = 86400000;

const CHORE = {
  id: 10, chat_id: 1, display_num: 1, text: 'clear poop', paused: 0, scored: 1,
  schedule_kind: 'daily', schedule_detail: JSON.stringify({ h: 21, mi: 0 }),
  nag_intervals: '[15,30,60]', assignee_name: null, assignee_user_id: null,
  next_fire_at: null,
};

const INTERVAL = {
  ...CHORE, schedule_kind: 'interval',
  schedule_detail: JSON.stringify({ days: 8, h: 21, mi: 0 }),
};

// One hand-rolled D1 fake: prepare(sql) branches on SQL substrings, run() is
// recorded so a test can assert which state transitions were attempted.
function makeDb({ firings = [], reminder = null, settings = null, members = [],
                 reminders = null, credits = [] } = {}) {
  const runs = [];
  const nagging = () => firings.filter((f) => f.state === 'nagging');
  const DB = withBatch({
    async batch(statements) { const results = []; for (const stmt of statements) results.push(await stmt.run()); return results; },
    prepare(sql) {
      const stmt = (args = []) => ({
        async first() {
          if (sql.includes('FROM settings')) return settings;
          if (sql.includes('SELECT * FROM firings WHERE id')) {
            return firings.find((f) => f.id === args[0]) || null;
          }
          if (sql.includes('FROM firings')) return nagging()[0] || null;
          if (sql.includes('FROM reminders')) return reminder;
          return null;
        },
        async all() {
          // Members come back in insertion order, never sorted: picking the
          // right one among namesakes is the caller's job now, not SQL's.
          if (sql.includes('FROM members')) return { results: members };
          if (sql.includes('SELECT done_by') && sql.includes('GROUP BY done_by')) {
            // The rotation's tally, counted per credit as the SQL counts it.
            const tally = new Map();
            for (const c of credits) {
              const t = tally.get(c.done_by) || { done_by: c.done_by, total: 0, week: 0 };
              t.total++;
              if (c.done_at > args[0]) t.week++;
              tally.set(c.done_by, t);
            }
            return { results: [...tally.values()] };
          }
          if (sql.includes('SELECT done_by')) return { results: credits };
          if (sql.includes("FROM firings WHERE reminder_id")) return { results: nagging() };
          if (sql.includes("FROM firings WHERE chat_id")) return { results: nagging() };
          if (sql.includes('FROM reminders')) return { results: reminders || [] };
          return { results: [] };
        },
        async run() {
          runs.push({ sql, args });
          return { meta: { changes: 1, last_row_id: 99 } };
        },
      });
      return { ...stmt(), bind: (...args) => stmt(args) };
    },
  });
  return { DB, runs, env: { BOT_TOKEN: 'token', ALLOWED_CHATS: '1', DB } };
}

// The cron's own fake: renagPending starts from a chat-wide SELECT over every
// nagging firing rather than one reminder's, and it looks the reminder up per
// firing — which is exactly the row a missing-reminder test has to withhold.
function makeCronDb({ firings = [], reminder = null, pausedChats = [] } = {}) {
  const runs = [];
  const DB = withBatch({
    prepare(sql) {
      const stmt = (args = []) => ({
        async first() {
          if (sql.includes('SELECT tz FROM settings')) return { tz: TZ };
          if (sql.includes('FROM settings')) return null;
          if (sql.includes('SELECT * FROM firings WHERE id')) {
            return firings.find((f) => f.id === args[0]) || null;
          }
          if (sql.includes('FROM reminders')) return reminder;
          return null;
        },
        async all() {
          if (sql.includes("FROM firings WHERE state = 'nagging'")) return { results: firings };
          if (sql.includes('FROM settings')) return { results: pausedChats.map((chat_id) => ({ chat_id })) };
          if (sql.includes('FROM reminders')) return { results: reminder ? [reminder] : [] };
          return { results: [] };
        },
        async run() {
          runs.push({ sql, args });
          return { meta: { changes: 1, last_row_id: 1 } };
        },
      });
      return { ...stmt(), bind: (...args) => stmt(args) };
    },
  });
  return { DB, runs, env: { BOT_TOKEN: 'token', ALLOWED_CHATS: '1', DB } };
}

describe('firing lifecycle fixes', () => {
  const calls = [];

  beforeEach(() => {
    calls.length = 0;
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const body = init && init.body ? JSON.parse(init.body) : null;
      calls.push({ url: String(url), body });
      const result = body && body.receiver_user_id
        ? { message_id: 0, ephemeral_message_id: 77 }
        : { message_id: 99 };
      return new Response(JSON.stringify({ ok: true, result }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }));
  });

  afterEach(() => vi.unstubAllGlobals());

  const sentTo = (method) => calls.filter((c) => c.url.endsWith(`/${method}`));
  const deleted = (id) => calls.some((c) => c.url.endsWith('/deleteMessage') && c.body.message_id === id);

  // 1. "📅 Tomorrow" carries fired_at forward, so a postponed nag is still
  // nagging when the next scheduled occurrence fires (9pm daily, postponed at
  // 9:05pm, back at 9:05pm tomorrow — five minutes after tomorrow's 9pm slot).
  // Sweeping it through expireFiring scored a deliberate postponement as
  // "expired unclaimed".
  describe('a postponed firing superseded by the next occurrence', () => {
    const NOW = 1_700_000_000_000;
    const postponed = {
      id: 5, reminder_id: 10, chat_id: 1, state: 'nagging',
      fired_at: NOW + 23 * HOUR, next_nag_at: NOW + 23 * HOUR,
      last_message_id: 77, last_message_ephemeral: 0, last_sticker_id: 88,
      nag_count: 0, snoozes_used: 1, scored: 1,
    };

    it('is deleted, never expired', async () => {
      const { env, runs } = makeDb({ firings: [postponed] });
      await fireReminder(env, { ...CHORE, next_fire_at: NOW }, NOW, TZ);
      const del = runs.find((r) => /DELETE FROM firings/.test(r.sql));
      expect(del).toBeTruthy();
      // The delete stays a conditional claim, like every other transition.
      expect(del.sql).toContain("state = 'nagging'");
      expect(del.args[0]).toBe(5);
      expect(runs.some((r) => /UPDATE firings SET state = 'expired'/.test(r.sql))).toBe(false);
    });

    it('takes its nag message and sticker with it', async () => {
      const { env } = makeDb({ firings: [postponed] });
      await fireReminder(env, { ...CHORE, next_fire_at: NOW }, NOW, TZ);
      expect(deleted(77)).toBe(true);
      expect(deleted(88)).toBe(true);
      // No tombstone: nobody failed anything.
      expect(sentTo('sendMessage').some((c) => /24 hours/.test(c.body.text || ''))).toBe(false);
      // The new occurrence still nags.
      expect(sentTo('sendMessage').some((c) => /clear poop/.test(c.body.text || ''))).toBe(true);
    });

    // 9 Nov 2026: a genuinely stale firing — the previous occurrence, never
    // marked done — used to be expired here, silently, as "expired unclaimed".
    // Nothing expires now: it is superseded like a postponed one, and the
    // chore carries on nagging on the new card.
    it('drops a stale previous occurrence the same way, never expiring it', async () => {
      const stale = { ...postponed, fired_at: NOW - 2 * HOUR, next_nag_at: NOW - HOUR };
      const { env, runs } = makeDb({ firings: [stale] });
      await fireReminder(env, { ...CHORE, next_fire_at: NOW }, NOW, TZ);
      expect(runs.some((r) => /UPDATE firings SET state = 'expired'/.test(r.sql))).toBe(false);
      const del = runs.find((r) => /DELETE FROM firings/.test(r.sql));
      expect(del.sql).toContain("state = 'nagging'");
      expect(del.args[0]).toBe(5);
      expect(deleted(77)).toBe(true);
      expect(sentTo('sendMessage').some((c) => /24 hours/.test(c.body.text || ''))).toBe(false);
      expect(sentTo('sendMessage').some((c) => /clear poop/.test(c.body.text || ''))).toBe(true);
    });
  });

  // 2. A pause froze the nags but not fired_at, so a chore paused for more than
  // a day expired on the first tick after resume — a public tombstone and a
  // scored failure for time nobody was asked to act in.
  describe('resuming a paused chore', () => {
    const live = {
      id: 5, reminder_id: 10, chat_id: 1, state: 'nagging',
      fired_at: Date.now() - 40 * HOUR, next_nag_at: Date.now() - 30 * HOUR,
      last_message_id: 77, last_message_ephemeral: 0, nag_count: 2, scored: 1,
      snoozes_used: 0,
    };
    const restamp = (runs) => runs.find((x) => x.sql.includes('UPDATE firings SET fired_at'));
    const card = () => calls.find((c) => c.url.endsWith('/editMessageText') && c.body.message_id === 77);

    it('restarts the expiry clock on a live nag whose time has passed', async () => {
      const r = { ...CHORE, paused: 1, next_fire_at: Date.now() + HOUR };
      const { env, runs } = makeDb({ firings: [live], reminder: r });
      const before = Date.now();
      await setReminderPaused(env, r, false, TZ, 'Nick');
      const upd = restamp(runs);
      expect(upd).toBeTruthy();
      expect(upd.sql).toContain("state = 'nagging'");
      expect(upd.args[0]).toBeGreaterThanOrEqual(before); // fired_at = now
      expect(upd.args[2]).toBe(5);                        // this firing, one at a time
      // ... and the next nag is in the future, so the cron does not delete and
      // re-send the card the very minute after resume restored its buttons.
      expect(upd.args[1]).toBeGreaterThan(Date.now());
      // The restamp is a compare-and-swap on the pair it read, so a Done, a
      // snooze, or a re-nag landing mid-resume wins instead of being clobbered.
      expect(upd.sql).toContain('fired_at = ?');
      expect(upd.sql).toContain('next_nag_at IS ?');
      expect(upd.args[3]).toBe(live.fired_at);
      expect(upd.args[4]).toBe(live.next_nag_at);
    });

    // paused = 0 is what re-arms the cron: a tick that sees it must already be
    // looking at the new clock, or it expires the nag we just brought back.
    it('restamps the firings before it clears the paused flag', async () => {
      const r = { ...CHORE, paused: 1, next_fire_at: Date.now() + HOUR };
      const { env, runs } = makeDb({ firings: [live], reminder: r });
      await setReminderPaused(env, r, false, TZ, 'Nick');
      const fired = runs.findIndex((x) => x.sql.includes('UPDATE firings SET fired_at'));
      const paused = runs.findIndex((x) => x.sql.includes('SET paused'));
      expect(fired).toBeGreaterThanOrEqual(0);
      expect(paused).toBeGreaterThan(fired);
    });

    // 2a. /resume does not check whether the chore was paused, so a stray one
    // handed a nag that had been up since morning a fresh 24 hours and pushed
    // its next nag away. Resuming what is already running is not an event.
    it('touches nothing when the chore was never paused', async () => {
      const r = { ...CHORE, paused: 0, next_fire_at: Date.now() + HOUR };
      const { env, runs } = makeDb({ firings: [live], reminder: r });
      const state = await setReminderPaused(env, r, false, TZ, 'Nick');
      expect(runs).toEqual([]);
      expect(calls).toEqual([]); // no card redraw, no dashboard rewrite
      expect(state.firing).toBe(null);
      expect(state.next).toBe(r.next_fire_at);
    });

    it('brings the card back as a plain nag when it did restamp', async () => {
      const r = { ...CHORE, paused: 1, next_fire_at: Date.now() + HOUR };
      const { env } = makeDb({ firings: [live], reminder: r });
      await setReminderPaused(env, r, false, TZ, 'Nick');
      expect(card().body.text).toContain('🐱');
      expect(JSON.stringify(card().body.reply_markup)).toContain('😴 Snooze…');
    });

    // 2b. A snooze and a "📅 Tomorrow" are the household saying when it wants
    // to hear about this again. Resume must not drag either back to now.
    // snoozed_until, still equal to next_nag_at, is what marks a snooze as
    // chosen and still in force — see the quiet-hours cases below.
    const snoozed = () => {
      const until = Date.now() + 2 * HOUR;
      return { ...live, snoozes_used: 1, fired_at: Date.now() - HOUR, next_nag_at: until, snoozed_until: until };
    };

    it('keeps a firing that is snoozed into the future', async () => {
      const r = { ...CHORE, paused: 1, next_fire_at: Date.now() + HOUR };
      const { env, runs } = makeDb({ firings: [snoozed()], reminder: r });
      await setReminderPaused(env, r, false, TZ, 'Nick');
      expect(restamp(runs)).toBeUndefined();
      expect(runs.some((x) => x.sql.includes('SET paused'))).toBe(true);
    });

    // ... and the card it left parked has to keep reading as parked. Redrawing
    // it as a plain nag claimed the chore was due now, and the ↩️ Back handler
    // reads the card's own text to decide which keyboard to restore — so the
    // wrong text also cost it the "🕐 Change snooze" button.
    it('redraws the kept firing as the snooze notice it still is', async () => {
      const r = { ...CHORE, paused: 1, next_fire_at: Date.now() + HOUR };
      const { env } = makeDb({ firings: [snoozed()], reminder: r });
      await setReminderPaused(env, r, false, TZ, 'Nick');
      const edited = card();
      expect(edited, 'the kept card was redrawn').toBeTruthy();
      expect(edited.body.text.startsWith('😴')).toBe(true);
      expect(edited.body.text).toContain('clear poop');
      expect(JSON.stringify(edited.body.reply_markup)).toContain('Change snooze');
      expect(JSON.stringify(edited.body.reply_markup)).not.toContain('😴 Snooze…');
    });

    it('keeps a firing that was postponed to tomorrow', async () => {
      const postponed = {
        ...live, snoozes_used: 1,
        fired_at: Date.now() + 20 * HOUR, next_nag_at: Date.now() + 20 * HOUR,
      };
      const r = { ...CHORE, paused: 1, next_fire_at: Date.now() + HOUR };
      const { env, runs } = makeDb({ firings: [postponed], reminder: r });
      await setReminderPaused(env, r, false, TZ, 'Nick');
      expect(restamp(runs)).toBeUndefined();
    });

    // 2c. Not every future next_nag_at is somebody's decision. The cron pushes
    // one to 08:00 whenever a re-nag comes due in quiet hours, and an ordinary
    // pending re-nag is always ahead of now. Reading either as a snooze left the
    // firing on its pre-pause 24h clock — the very expiry the restamp exists to
    // prevent. snoozes_used = 0 says nobody chose this.
    it('restamps a firing the cron merely deferred to 8am', async () => {
      const deferred = {
        ...live, snoozes_used: 0,
        fired_at: Date.now() - 20 * HOUR, next_nag_at: Date.now() + 3 * HOUR,
      };
      const r = { ...CHORE, paused: 1, next_fire_at: Date.now() + HOUR };
      const { env, runs } = makeDb({ firings: [deferred], reminder: r });
      const before = Date.now();
      await setReminderPaused(env, r, false, TZ, 'Nick');
      const upd = restamp(runs);
      expect(upd, 'a quiet-hours deferral is not a snooze').toBeTruthy();
      expect(upd.args[0]).toBeGreaterThanOrEqual(before);
      // Still a compare-and-swap on the pair it read, deferred value included.
      expect(upd.args[3]).toBe(deferred.fired_at);
      expect(upd.args[4]).toBe(deferred.next_nag_at);
      // And the revived card is a nag again, not a snooze notice.
      expect(card().body.text).toContain('🐱');
    });

    it('restamps a firing whose next re-nag is simply not due yet', async () => {
      const pending = {
        ...live, snoozes_used: 0,
        fired_at: Date.now() - 30 * HOUR, next_nag_at: Date.now() + 10 * 60000,
      };
      const r = { ...CHORE, paused: 1, next_fire_at: Date.now() + HOUR };
      const { env, runs } = makeDb({ firings: [pending], reminder: r });
      await setReminderPaused(env, r, false, TZ, 'Nick');
      expect(restamp(runs)).toBeTruthy();
    });

    it('leaves the clock alone when pausing', async () => {
      const r = { ...CHORE, paused: 0, next_fire_at: Date.now() + HOUR };
      const { env, runs } = makeDb({ firings: [live], reminder: r });
      await setReminderPaused(env, r, true, TZ, 'Nick');
      expect(restamp(runs)).toBeUndefined();
    });
  });

  // 3. Resume recomputed next_fire_at from "now", which pushed an "every 8
  // days" chore due tomorrow out by another eight days.
  describe('a resumed schedule keeps its place', () => {
    const setPaused = (runs) => runs.find((x) => x.sql.includes('SET paused'));

    it('keeps a next_fire_at that is still in the future', async () => {
      const due = Date.now() + DAY;
      const r = { ...INTERVAL, paused: 1, next_fire_at: due };
      const { env, runs } = makeDb({ reminder: r });
      await setReminderPaused(env, r, false, TZ, 'Nick');
      expect(setPaused(runs).args[0]).toBe(due);
    });

    it('advances a lapsed interval from its anchor, not from now', async () => {
      // An every-8-days 9pm chore anchored well in the past: the slot it comes
      // back on must still land on the anchor's 8-day grid, and within one gap.
      const anchor = zonedEpoch(2026, 3, 1, 21, 0, TZ);
      const r = { ...INTERVAL, paused: 1, next_fire_at: anchor };
      const { env, runs } = makeDb({ reminder: r });
      const now = Date.now();
      await setReminderPaused(env, r, false, TZ, 'Nick');
      const next = setPaused(runs).args[0];
      expect(next).toBeGreaterThan(now);
      expect(next).toBeLessThanOrEqual(now + 8 * DAY);
      expect((next - anchor) % (8 * DAY)).toBe(0);
    });

    it('rolls a daily chore whose slot went by during the pause', async () => {
      const r = { ...CHORE, paused: 1, next_fire_at: Date.now() - 2 * DAY };
      const { env, runs } = makeDb({ reminder: r });
      await setReminderPaused(env, r, false, TZ, 'Nick');
      expect(setPaused(runs).args[0]).toBeGreaterThan(Date.now());
    });

    it('anchors intervals the same way when vacation ends', async () => {
      const anchor = zonedEpoch(2026, 3, 1, 21, 0, TZ);
      const r = { ...INTERVAL, next_fire_at: anchor };
      const { env, runs } = makeDb({ reminders: [r], reminder: r });
      await wakeChat(env, 1, TZ);
      const upd = runs.find((x) => x.sql.includes('UPDATE reminders SET next_fire_at = ? WHERE id = ?'));
      expect(upd).toBeTruthy();
      expect(upd.args[0]).toBeGreaterThan(Date.now());
      expect((upd.args[0] - anchor) % (8 * DAY)).toBe(0);
    });
  });

  describe('an early-completed day interval restarts today', () => {
    it('puts cat fountain two weeks after the date it was marked done', async () => {
      const markedAt = zonedEpoch(2026, 9, 4, 10, 30, TZ);
      const due = zonedEpoch(2026, 9, 11, 19, 0, TZ);
      const r = {
        ...INTERVAL,
        text: 'cat fountain',
        schedule_detail: JSON.stringify({ days: 14, h: 19, mi: 0 }),
        next_fire_at: due,
      };
      const { env, runs } = makeDb({ reminder: r });
      const clock = vi.spyOn(Date, 'now').mockReturnValue(markedAt);
      try {
        await completeEarly(env, r, 'Nick', TZ);
      } finally {
        clock.mockRestore();
      }

      const claim = runs.find((x) =>
        x.sql.includes('SET next_fire_at = ? WHERE id = ? AND next_fire_at = ?'));
      expect(claim.args).toEqual([
        zonedEpoch(2026, 9, 18, 19, 0, TZ),
        r.id,
        due,
      ]);
    });
  });

  // 4. Assignment stores a roster display name, which for a member without a
  // Telegram username is their first name. Matching only on username left them
  // unresolved, and their nag went public with a sticker beside it.
  describe('resolving an assignee to a private nag', () => {
    const fire = async (assignee, members) => {
      const { env } = makeDb({ members });
      await fireReminder(env, { ...CHORE, next_fire_at: 1_700_000_000_000, assignee_name: assignee },
        1_700_000_000_000, TZ);
      return calls.find((c) => c.url.endsWith('/sendMessage') && /clear poop/.test(c.body.text || ''));
    };

    it('matches a member who has no username by first name', async () => {
      const nag = await fire('Jane', [{ user_id: 42, username: null, first_name: 'Jane', last_seen: 1 }]);
      expect(nag.body.receiver_user_id).toBe(42);
      // A sticker beside a private nag would announce the chore it hides.
      expect(sentTo('sendSticker').length).toBe(0);
    });

    it('still matches an @handle by username', async () => {
      const nag = await fire('@jane', [{ user_id: 7, username: 'jane', first_name: 'Jane', last_seen: 1 }]);
      expect(nag.body.receiver_user_id).toBe(7);
    });

    it('falls back to the username for a bare handle', async () => {
      const nag = await fire('jane', [{ user_id: 7, username: 'jane', first_name: 'Janet', last_seen: 1 }]);
      expect(nag.body.receiver_user_id).toBe(7);
    });

    it('prefers the most recently seen of two members sharing a first name', async () => {
      const nag = await fire('Jane', [
        { user_id: 1, username: null, first_name: 'Jane', last_seen: 100 },
        { user_id: 2, username: null, first_name: 'Jane', last_seen: 900 },
      ]);
      expect(nag.body.receiver_user_id).toBe(2);
    });

    it('keeps a nag public when nobody matches', async () => {
      const nag = await fire('Ghost', [{ user_id: 42, username: 'jane', first_name: 'Jane', last_seen: 1 }]);
      expect(nag.body.receiver_user_id).toBeUndefined();
    });

    // D1 is plain SQLite, whose lower() is ASCII-only: lower('Élodie') is
    // still 'Élodie', so it never equalled the JS-lowercased name and the
    // assigned nag went public — with a sticker beside it.
    it('matches an accented first name', async () => {
      const nag = await fire('Élodie', [{ user_id: 8, username: null, first_name: 'Élodie', last_seen: 1 }]);
      expect(nag.body.receiver_user_id).toBe(8);
      expect(sentTo('sendSticker').length).toBe(0);
    });

    it('matches an accented name across case', async () => {
      const nag = await fire('élodie', [{ user_id: 8, username: null, first_name: 'Élodie', last_seen: 1 }]);
      expect(nag.body.receiver_user_id).toBe(8);
    });
  });

  // 5. Rotation counted historical done_by strings, so "brian" — minted by one
  // mistyped "done with brian" — kept winning turns nobody could do, while a
  // real member who had never tapped Done was not a candidate at all.
  describe('rotation draws from the household roster', () => {
    const NOW = 1_700_000_000_000;
    const ROTATING = {
      ...CHORE, next_fire_at: NOW,
      schedule_detail: JSON.stringify({ h: 21, mi: 0, rotate: true }),
    };
    const HOUSE = [
      { user_id: 1, username: 'nick', first_name: 'Nick', last_seen: 2 },
      { user_id: 2, username: 'jane', first_name: 'Jane', last_seen: 1 },
    ];
    const credit = (who) => ({ done_by: who, done_at: Date.now() });
    const assigned = async (opts) => {
      const { env, runs } = makeDb(opts);
      await fireReminder(env, { ...ROTATING }, NOW, TZ);
      const upd = runs.find((x) => x.sql.includes('SET assignee_name'));
      return upd ? upd.args[0] : null;
    };

    it('gives a member with no credits the turn', async () => {
      // Alphabetically @jane would win; the whole point is that @nick's empty
      // record beats her two ✅.
      expect(await assigned({ members: HOUSE, credits: [credit('@jane'), credit('@jane')] }))
        .toBe('@nick');
    });

    it('never picks a phantom, however few credits it has', async () => {
      expect(await assigned({
        members: HOUSE,
        credits: [credit('brian'), credit('@nick'), credit('@nick'),
                  credit('@jane'), credit('@jane'), credit('@jane')],
      })).toBe('@nick');
    });

    it('counts a hand-typed credit against the roster spelling it belongs to', async () => {
      // "done with jane" is @jane's ✅, so the turn goes to @nick.
      expect(await assigned({ members: HOUSE, credits: [credit('jane')] })).toBe('@nick');
    });

    it('assigns nobody when the chat has no roster yet', async () => {
      expect(await assigned({ members: [], credits: [credit('brian')] })).toBe(null);
    });
  });

  // 5b. The cron is where the 24h mark is noticed. Until 9 Nov 2026 it
  // expired a recurring firing there, with a public tombstone; now the firing
  // stays nagging — hourly, on the ⏰ card — until someone marks it done. The
  // one claim that still writes 'expired' is for a firing whose chore has
  // gone, and it binds the fired_at this tick read: a resume moves that
  // column, so a tick that made up its mind minutes ago must lose.
  describe('the cron keeping an overdue firing nagging', () => {
    // Noon in Singapore: quiet hours would defer the whole decision to 8am and
    // nothing below would run.
    const NOON = zonedEpoch(2026, 3, 10, 12, 0, TZ);
    const overdue = {
      id: 5, reminder_id: 10, chat_id: 1, state: 'nagging',
      fired_at: NOON - 25 * HOUR, next_nag_at: NOON - HOUR,
      last_message_id: 77, last_message_ephemeral: 0, nag_count: 3,
      snoozes_used: 0, scored: 1,
    };
    const expiry = (runs) => runs.find((x) => /UPDATE firings SET state = 'expired'/.test(x.sql));

    const renag = (runs) => runs.find((x) => /UPDATE firings SET nag_count = \?, next_nag_at = \?/.test(x.sql));

    it('re-nags a 25h-old recurring firing hourly on the ⏰ card, with no tombstone', async () => {
      const { env, runs } = makeCronDb({ firings: [overdue], reminder: { ...CHORE, paused: 0 } });
      await renagPending(env, NOON);
      expect(expiry(runs), 'nothing expires').toBeUndefined();
      const claim = renag(runs);
      expect(claim, 'the overdue firing is re-nagged').toBeTruthy();
      // Hourly from here, the claim bound to the nag slot this tick read.
      expect(claim.args).toEqual([4, NOON + HOUR, 5, NOON - HOUR]);
      const card = sentTo('sendMessage').find((c) => /clear poop/.test(c.body.text || ''));
      expect(card.body.text).toMatch(/^⏰/);
      expect(card.body.text).toMatch(/Nagging since/);
      expect(sentTo('sendMessage').some((c) => /24 hours and nobody/.test(c.body.text || ''))).toBe(false);
    });

    // The 24h mark on its own is not an event any more: a firing whose next
    // nag is still ahead is not even in the tick's result set.
    it('does nothing to an overdue firing whose next nag is still ahead', async () => {
      const parked = { ...overdue, next_nag_at: NOON + 2 * HOUR };
      const { env, runs } = makeCronDb({ firings: [parked], reminder: { ...CHORE, paused: 0 } });
      await renagPending(env, NOON);
      expect(expiry(runs)).toBeUndefined();
      expect(renag(runs)).toBeUndefined();
      expect(sentTo('sendMessage')).toHaveLength(0);
    });

    it('nags a firing inside its 24 hours as an ordinary nag', async () => {
      const fresh = { ...overdue, fired_at: NOON - 2 * HOUR, next_nag_at: NOON - 60000 };
      const { env, runs } = makeCronDb({ firings: [fresh], reminder: { ...CHORE, paused: 0 } });
      await renagPending(env, NOON);
      expect(expiry(runs)).toBeUndefined();
      const card = sentTo('sendMessage').find((c) => /clear poop/.test(c.body.text || ''));
      expect(card.body.text).toMatch(/^🐱/);
    });

    // A firing whose reminder row has vanished has no card, no tombstone and no
    // schedule to advance — just a row to close. It still needs both guards, or
    // the same stale decision kills a resumed nag by the back door.
    it('carries both guards when the reminder row is gone', async () => {
      const { env, runs } = makeCronDb({ firings: [overdue], reminder: null });
      await renagPending(env, NOON);
      const exp = expiry(runs);
      expect(exp, 'an orphaned firing is closed').toBeTruthy();
      expect(exp.sql).toContain("state = 'nagging'");
      expect(exp.sql).toContain('fired_at = ?');
      expect(exp.args).toEqual([5, NOON - 25 * HOUR]);
      // Nothing is announced for a chore nobody can name any more.
      expect(sentTo('sendMessage').some((c) => /24 hours/.test(c.body.text || ''))).toBe(false);
    });

    it('closes an orphan even before its 24 hours are up, once its nag is due', async () => {
      const fresh = { ...overdue, fired_at: NOON - 2 * HOUR, next_nag_at: NOON - 60000 };
      const { env, runs } = makeCronDb({ firings: [fresh], reminder: null });
      await renagPending(env, NOON);
      expect(expiry(runs).args).toEqual([5, NOON - 2 * HOUR]);
    });

    it('freezes the overdue nag while the household is on vacation', async () => {
      const { env, runs } = makeCronDb({
        firings: [overdue], reminder: { ...CHORE, paused: 0 }, pausedChats: [1],
      });
      await renagPending(env, NOON);
      expect(expiry(runs)).toBeUndefined();
      expect(renag(runs)).toBeUndefined();
      expect(sentTo('sendMessage')).toHaveLength(0);
    });

    it('freezes the overdue nag while the chore itself is paused', async () => {
      const { env, runs } = makeCronDb({ firings: [overdue], reminder: { ...CHORE, paused: 1 } });
      await renagPending(env, NOON);
      expect(expiry(runs)).toBeUndefined();
      expect(renag(runs)).toBeUndefined();
      expect(sentTo('sendMessage')).toHaveLength(0);
    });
  });

  // 6. "/chore … now" fired through fireReminder directly, bypassing the cron's
  // paused-chat filter: a chore added during "/pause all" nagged once and then
  // wakeChat silently deleted the nag.
  describe('"now" during vacation mode', () => {
    const due = { ...CHORE, next_fire_at: Date.now() - 100 };

    it('does not fire while the household is paused', async () => {
      const { env, runs } = makeDb({ reminder: due, settings: { paused_until: Date.now() + DAY } });
      await fireIfDue(env, 10, TZ);
      expect(sentTo('sendMessage').length).toBe(0);
      // The occurrence is untouched, so the wake rolls it and the cron fires it.
      expect(runs.some((x) => x.sql.includes('UPDATE reminders SET next_fire_at'))).toBe(false);
    });

    it('fires normally once the pause has lapsed', async () => {
      const { env } = makeDb({ reminder: due, settings: { paused_until: Date.now() - DAY } });
      await fireIfDue(env, 10, TZ);
      expect(sentTo('sendMessage').some((c) => /clear poop/.test(c.body.text || ''))).toBe(true);
    });

    it('fires normally when the chat has no pause at all', async () => {
      const { env } = makeDb({ reminder: due, settings: null });
      await fireIfDue(env, 10, TZ);
      expect(sentTo('sendMessage').some((c) => /clear poop/.test(c.body.text || ''))).toBe(true);
    });
  });
});
