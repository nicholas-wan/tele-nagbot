// Regression tests for the 26 Sep 2026 review: refused commands left in the
// group, an Undo with no way back, the vacation-wake race, a digest naming
// chores the same tick tombstones, /poke and ↩️ Back redrawing the wrong card,
// bare "done" reaching another member's private nag, unchecked wizard codes,
// a relative reply flattening a recurring draft, restore dropping `paused`,
// pause writing next_fire_at back, and a deleted chore's card outliving it.
// Real SQLite behind the D1 shim; every statement is logged for the tests
// that care about order.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { handleUpdate } from '../src/handlers.js';
import { sendDigests, renagPending } from '../src/cron.js';
import { wakeChat, setReminderPaused } from '../src/chores.js';

const TZ = 'Asia/Singapore';
const HOUR = 3600000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 8, 5, 6); // Sat 14:00 Asia/Singapore
const EIGHT_AM = Date.UTC(2026, 8, 5, 0);

let sql, env, calls, runs;
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  sql.exec('INSERT INTO settings (chat_id, dashboard_msg_id) VALUES (1, 99)');
  runs = [];
  env = { BOT_TOKEN: 'test', ALLOWED_CHATS: '1', DB: {
    prepare(query) {
      const stmt = sql.prepare(query);
      const bound = (args = []) => ({
        bind: (...values) => bound(values),
        first: async () => stmt.get(...args) || null,
        all: async () => ({ results: stmt.all(...args) }),
        run: async () => {
          runs.push({ sql: query, args });
          const r = stmt.run(...args);
          return { meta: { changes: r.changes, last_row_id: r.lastInsertRowid } };
        },
      });
      return bound();
    },
  } };
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 99 } }));
  }));
});
afterEach(() => { sql.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const nick = { id: 2, first_name: 'Nick', username: 'nicholaswan' };
const jane = { id: 3, first_name: 'Jane', username: 'jane' };
const say = (message_id, text, from = nick, extra = {}) => handleUpdate(env, {
  message: { message_id, chat: { id: 1 }, from, text, entities: [], ...extra },
});
const tap = (data, text = '🐱 nag', from = nick) => handleUpdate(env, { callback_query: {
  id: 'tap', data, from, message: { chat: { id: 1 }, message_id: 99, text },
} });
const deleted = (id) => calls.some((c) => c.url.endsWith('/deleteMessage') && c.body.message_id === id);
const swept = (id) => sql.prepare(
  'SELECT 1 FROM sent_messages WHERE chat_id = 1 AND message_id = ? AND is_ephemeral = 0'
).get(id);
const sent = (re) => calls.filter((c) => c.url.endsWith('/sendMessage') && re.test(c.body.text));
const toast = () => calls.filter((c) => c.url.endsWith('/answerCallbackQuery')).at(-1).body.text;
const buttons = (markup) => (markup ? markup.inline_keyboard.flat().map((b) => b.callback_data) : []);
const count = (table, where = '1') => sql.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get().n;
const reminder = (where) => sql.prepare(`SELECT * FROM reminders WHERE ${where}`).get();
const firing = (id) => sql.prepare('SELECT * FROM firings WHERE id = ?').get(id);

const seedReminder = (cols) => {
  const row = { id: 10, chat_id: 1, text: 'clear poop', schedule_kind: 'daily', schedule_detail: '{"h":21,"mi":0}',
    nag_intervals: '[15,30,60]', next_fire_at: NOW + HOUR, paused: 0, created_at: NOW - DAY, scored: 1, ...cols };
  const keys = Object.keys(row);
  sql.prepare(`INSERT INTO reminders (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => row[k]));
  return row;
};
const seedFiring = (cols) => {
  const row = { id: 5, reminder_id: 10, chat_id: 1, reminder_text: 'clear poop', fired_at: NOW - 2 * HOUR,
    state: 'nagging', nag_count: 0, next_nag_at: NOW + 15 * 60000, last_message_id: 700, scored: 1, ...cols };
  const keys = Object.keys(row);
  sql.prepare(`INSERT INTO firings (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => row[k]));
  return row;
};

describe('a refused command is still tidied away', () => {
  it('deletes the command when the chore is not found, the days are bad, or a one-off is skipped', async () => {
    await say(7, '/chore dishes 11:59pm');
    calls.length = 0;
    await say(5, '/done nonexistent');
    await say(6, '/pause all abc');
    await say(8, '/skip dishes');
    expect(deleted(5)).toBe(true);
    expect(deleted(6)).toBe(true);
    expect(deleted(8)).toBe(true);
  });

  it('still keeps a misparsed /chore on the sweep rather than deleting it', async () => {
    await say(9, '/chore dinner 7 30pm');
    expect(deleted(9)).toBe(false);
    expect(swept(9)).toBeTruthy();
  });
});

describe('Undo goes through the trash', () => {
  it('stashes the chore and offers Restore on the Undone line', async () => {
    await say(5, '/chore water plants 7pm daily');
    const { id } = reminder('1');
    calls.length = 0;
    await tap(`u:${id}`);
    expect(count('reminders')).toBe(0);
    expect(count('trash')).toBe(1);
    const undone = calls.find((c) => c.url.endsWith('/editMessageText'));
    expect(undone.body.text).toContain('Undone');
    const trashId = sql.prepare('SELECT id FROM trash').get().id;
    expect(buttons(undone.body.reply_markup)).toEqual([`t:${trashId}`, 'ok']);
    await tap(`t:${trashId}`);
    expect(reminder('1')).toMatchObject({ text: 'water plants', schedule_kind: 'daily' });
    expect(count('trash')).toBe(0);
  });

  it('restores a paused chore paused', async () => {
    seedReminder({ paused: 1, display_num: 1 });
    await say(5, '/delete clear poop');
    const trashId = sql.prepare('SELECT id FROM trash').get().id;
    await tap(`t:${trashId}`);
    expect(reminder('1')).toMatchObject({ text: 'clear poop', paused: 1 });
  });
});

describe('pause and vacation wake', () => {
  it('pausing writes only the flag, so a slot the cron consumed meanwhile stays consumed', async () => {
    const r = seedReminder({});
    const advanced = NOW + DAY;
    sql.prepare('UPDATE reminders SET next_fire_at = ? WHERE id = 10').run(advanced); // the cron fired it
    await setReminderPaused(env, r, true, TZ, 'Nick'); // with the stale read
    expect(reminder('id = 10')).toMatchObject({ paused: 1, next_fire_at: advanced });
  });

  it('clears paused_until only after the backlog is rolled and the old nags are gone', async () => {
    sql.prepare('UPDATE settings SET paused_until = ? WHERE chat_id = 1').run(NOW - 1000);
    seedReminder({ next_fire_at: NOW - DAY });
    seedFiring({});
    await wakeChat(env, 1, TZ);
    const at = (re) => runs.findIndex((x) => re.test(x.sql));
    const cleared = at(/paused_until = NULL/);
    expect(cleared).toBeGreaterThan(at(/DELETE FROM firings/));
    expect(cleared).toBeGreaterThan(at(/UPDATE reminders SET next_fire_at/));
    expect(reminder('id = 10').next_fire_at).toBeGreaterThan(NOW);
    expect(sql.prepare('SELECT paused_until FROM settings').get().paused_until).toBeNull();
  });
});

describe('the 8am digest', () => {
  it('leaves out a recurring firing the same tick is about to tombstone', async () => {
    Date.now.mockReturnValue(EIGHT_AM);
    seedReminder({ id: 10, text: 'singlife', schedule_kind: 'once', schedule_detail: '{}', next_fire_at: null });
    seedReminder({ id: 11, text: 'clear poop' });
    seedReminder({ id: 12, text: 'dishes' });
    seedFiring({ id: 5, reminder_id: 10, reminder_text: 'singlife', fired_at: EIGHT_AM - 25 * HOUR, next_nag_at: null });
    seedFiring({ id: 6, reminder_id: 11, fired_at: EIGHT_AM - 25 * HOUR, next_nag_at: EIGHT_AM, last_message_id: 701 });
    seedFiring({ id: 7, reminder_id: 12, reminder_text: 'dishes', fired_at: EIGHT_AM - 2 * HOUR, last_message_id: 702 });
    await sendDigests(env, EIGHT_AM);
    const digest = sent(/hanging over/)[0];
    expect(digest.body.text).toContain('singlife');
    expect(digest.body.text).toContain('dishes');
    expect(digest.body.text).not.toContain('clear poop');
    expect(buttons(digest.body.reply_markup)).toEqual(['dg:5', 'dg:7', 'ok']);
  });
});

describe('cards come back as what they are', () => {
  it('/poke re-sends an overdue one-off as the ⏰ card and a snoozed nag as its 😴 notice', async () => {
    seedReminder({ id: 10, text: 'singlife', schedule_kind: 'once', schedule_detail: '{}', next_fire_at: null });
    seedReminder({ id: 11, text: 'clear poop' });
    seedFiring({ id: 5, reminder_id: 10, reminder_text: 'singlife', fired_at: NOW - 25 * HOUR, next_nag_at: null });
    seedFiring({ id: 6, reminder_id: 11, next_nag_at: NOW + HOUR, snoozed_until: NOW + HOUR, snoozes_used: 1, last_message_id: 701 });
    await say(5, '/poke');
    const overdue = sent(/^⏰/)[0];
    expect(overdue.body.text).toContain('singlife');
    expect(buttons(overdue.body.reply_markup)).toEqual(['d:5', 'b:5', 'x:5']);
    const snoozed = sent(/^😴/)[0];
    expect(snoozed.body.text).toContain('the household');
    expect(buttons(snoozed.body.reply_markup)).toContain('s:6');
    expect(sent(/^🐱/)).toHaveLength(0);
  });

  it('↩️ Back on a card that went overdue restores the ⏰ keyboard, not a Snooze', async () => {
    seedReminder({ id: 10, text: 'singlife', schedule_kind: 'once', schedule_detail: '{}', next_fire_at: null });
    seedFiring({ id: 5, reminder_text: 'singlife', fired_at: NOW - 25 * HOUR, next_nag_at: null });
    await tap('z:5:b', '🐱 singlife');
    const edit = calls.find((c) => c.url.endsWith('/editMessageReplyMarkup'));
    expect(buttons(edit.body.reply_markup)).toEqual(['d:5', 'b:5', 'x:5']);
  });
});

describe('bare "done" respects who a nag belongs to', () => {
  it('ignores another member\'s private nag and completes one\'s own', async () => {
    seedReminder({});
    seedFiring({ nag_user_id: 3, last_message_ephemeral: 1 });
    await say(5, 'done', nick);
    expect(firing(5).state).toBe('nagging');
    await say(6, 'done', jane);
    expect(firing(5)).toMatchObject({ state: 'done', done_by: '@jane' });
  });
});

describe('the wizard checks what it is handed', () => {
  it('refuses an hour that is not on the menu and a preset from the other keyboard', async () => {
    await say(5, '/chore plants every mon');
    const weekly = sql.prepare("SELECT id FROM drafts WHERE schedule_kind = 'weekly'").get().id;
    await tap(`w:${weekly}:h25`);
    expect(toast()).toContain('not on this menu');
    expect(count('reminders')).toBe(0);
    await say(6, '/chore dishes');
    const once = sql.prepare("SELECT id FROM drafts WHERE schedule_kind = 'once'").get().id;
    await tap(`w:${once}:h8`);
    expect(toast()).toContain('not on this menu');
    expect(count('reminders')).toBe(0);
    await tap(`w:${weekly}:h8`);
    expect(reminder("text = 'plants'")).toMatchObject({ schedule_kind: 'weekly' });
    await tap(`w:${once}:r15`);
    expect(reminder("text = 'dishes'")).toMatchObject({ schedule_kind: 'once', next_fire_at: NOW + 15 * 60000 });
  });

  it('asks for a time of day when a relative time is given for a recurring draft', async () => {
    await say(5, '/chore plants every mon');
    calls.length = 0;
    await say(6, 'in 30m', nick, { reply_to_message: { message_id: 99, chat: { id: 1 } } });
    expect(sent(/needs a time of day/)).toHaveLength(1);
    expect(count('reminders')).toBe(0);
    expect(count('drafts')).toBe(1);
    await say(7, '10am', nick, { reply_to_message: { message_id: 99, chat: { id: 1 } } });
    expect(reminder('1')).toMatchObject({ text: 'plants', schedule_kind: 'weekly', schedule_detail: '{"days":[1],"h":10,"mi":0}' });
  });
});

describe('a chore deleted under a live nag', () => {
  it('takes the orphaned card down when the cron expires the firing', async () => {
    seedFiring({ reminder_id: 999, next_nag_at: NOW - 60000, last_sticker_id: 701 });
    await renagPending(env, NOW);
    expect(firing(5).state).toBe('expired');
    expect(deleted(700)).toBe(true);
    expect(deleted(701)).toBe(true);
  });
});
