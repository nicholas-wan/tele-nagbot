// Firing-lifecycle fixes: a postponement is not a failure, a pause really
// freezes the expiry clock, resuming keeps a chore's place in the queue, an
// assignee without a Telegram username still gets a private nag, and vacation
// mode outranks "/chore … now".
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { fireReminder } from '../src/firing.js';
import { setReminderPaused, fireIfDue, wakeChat } from '../src/chores.js';
import { zonedEpoch } from '../src/time.js';

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
function makeDb({ firings = [], reminder = null, settings = null, members = [], reminders = null } = {}) {
  const runs = [];
  const nagging = () => firings.filter((f) => f.state === 'nagging');
  // Newest member first, so a lookup that forgets ORDER BY last_seen DESC
  // would still have to pick one — and the tests below name which.
  const roster = [...members].sort((a, b) => (b.last_seen || 0) - (a.last_seen || 0));
  const DB = {
    prepare(sql) {
      const stmt = (args = []) => ({
        async first() {
          if (sql.includes('FROM members')) {
            const col = sql.includes('lower(first_name)') ? 'first_name' : 'username';
            const hit = roster.find((m) => String(m[col] || '').toLowerCase() === args[1]);
            return hit ? { user_id: hit.user_id } : null;
          }
          if (sql.includes('FROM settings')) return settings;
          if (sql.includes('SELECT * FROM firings WHERE id')) {
            return firings.find((f) => f.id === args[0]) || null;
          }
          if (sql.includes('FROM firings')) return nagging()[0] || null;
          if (sql.includes('FROM reminders')) return reminder;
          return null;
        },
        async all() {
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
  };
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

    it('still silently expires a genuinely stale firing', async () => {
      const stale = { ...postponed, fired_at: NOW - 2 * HOUR, next_nag_at: NOW - HOUR };
      const { env, runs } = makeDb({ firings: [stale] });
      await fireReminder(env, { ...CHORE, next_fire_at: NOW }, NOW, TZ);
      expect(runs.some((r) => /UPDATE firings SET state = 'expired'/.test(r.sql))).toBe(true);
      expect(runs.some((r) => /DELETE FROM firings/.test(r.sql))).toBe(false);
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
    };

    it('restarts the expiry clock on every live nag', async () => {
      const r = { ...CHORE, paused: 1, next_fire_at: Date.now() + HOUR };
      const { env, runs } = makeDb({ firings: [live], reminder: r });
      const before = Date.now();
      await setReminderPaused(env, r, false, TZ, 'Nick');
      const upd = runs.find((x) => x.sql.includes('UPDATE firings SET fired_at'));
      expect(upd).toBeTruthy();
      expect(upd.sql).toContain("state = 'nagging'");
      expect(upd.args[0]).toBeGreaterThanOrEqual(before); // fired_at = now
      expect(upd.args[2]).toBe(10);                       // every nagging firing of this chore
      // ... and the next nag is in the future, so the cron does not delete and
      // re-send the card the very minute after resume restored its buttons.
      expect(upd.args[1]).toBeGreaterThan(Date.now());
    });

    it('leaves the clock alone when pausing', async () => {
      const r = { ...CHORE, paused: 0, next_fire_at: Date.now() + HOUR };
      const { env, runs } = makeDb({ firings: [live], reminder: r });
      await setReminderPaused(env, r, true, TZ, 'Nick');
      expect(runs.some((x) => x.sql.includes('UPDATE firings SET fired_at'))).toBe(false);
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
      expect(setPaused(runs).args[1]).toBe(due);
    });

    it('advances a lapsed interval from its anchor, not from now', async () => {
      // An every-8-days 9pm chore anchored well in the past: the slot it comes
      // back on must still land on the anchor's 8-day grid, and within one gap.
      const anchor = zonedEpoch(2026, 3, 1, 21, 0, TZ);
      const r = { ...INTERVAL, paused: 1, next_fire_at: anchor };
      const { env, runs } = makeDb({ reminder: r });
      const now = Date.now();
      await setReminderPaused(env, r, false, TZ, 'Nick');
      const next = setPaused(runs).args[1];
      expect(next).toBeGreaterThan(now);
      expect(next).toBeLessThanOrEqual(now + 8 * DAY);
      expect((next - anchor) % (8 * DAY)).toBe(0);
    });

    it('rolls a daily chore whose slot went by during the pause', async () => {
      const r = { ...CHORE, paused: 1, next_fire_at: Date.now() - 2 * DAY };
      const { env, runs } = makeDb({ reminder: r });
      await setReminderPaused(env, r, false, TZ, 'Nick');
      expect(setPaused(runs).args[1]).toBeGreaterThan(Date.now());
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
