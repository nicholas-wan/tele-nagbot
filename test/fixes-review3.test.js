// Regression tests for the 27 Sep 2026 review: ↩️ Not done bringing back a
// chore deleted since (a recurring one with nothing scheduled), vacation wake
// deleting one-offs outright, rotation lost in the time wizard, an exact chore
// name losing to a longer one, a fire failing after its claim but before the
// firing existed, unchecked snooze codes, and commands left standing in the
// group (/help, a refused /chore, a cancelled wizard, Undo and Restore).
// Real SQLite behind the D1 shim.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { handleUpdate } from '../src/handlers.js';
import { wakeChat } from '../src/chores.js';
import { fireReminder } from '../src/firing.js';

const TZ = 'Asia/Singapore';
const HOUR = 3600000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 8, 5, 6); // Sat 14:00 Asia/Singapore

let sql, env, calls, failOn;
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  sql.exec('INSERT INTO settings (chat_id, dashboard_msg_id) VALUES (1, 99)');
  failOn = null;
  env = { BOT_TOKEN: 'test', ALLOWED_CHATS: '1', DB: {
    prepare(query) {
      // A D1 error on demand, for the statements a test names.
      if (failOn && failOn.test(query)) throw new Error('D1_ERROR: simulated');
      const stmt = sql.prepare(query);
      const bound = (args = []) => ({
        bind: (...values) => bound(values),
        first: async () => stmt.get(...args) || null,
        all: async () => ({ results: stmt.all(...args) }),
        run: async () => {
          const r = stmt.run(...args);
          return { meta: { changes: r.changes, last_row_id: r.lastInsertRowid } };
        },
      });
      return bound();
    },
  } };
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 99 } }));
  }));
});
afterEach(() => { sql.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const nick = { id: 2, first_name: 'Nick', username: 'nicholaswan' };
const say = (message_id, text) => handleUpdate(env, {
  message: { message_id, chat: { id: 1 }, from: nick, text, entities: [] },
});
// Taps land on message 600 unless told otherwise, clear of the board's 99.
const tap = (data, message = {}) => handleUpdate(env, { callback_query: {
  id: 'tap', data, from: nick, message: { chat: { id: 1 }, message_id: 600, text: 'x', ...message },
} });
const deleted = (id) => calls.some((c) => c.url.endsWith('/deleteMessage') && c.body.message_id === id);
const sent = (re) => calls.filter((c) => c.url.endsWith('/sendMessage') && re.test(c.body.text));
const edits = (id) => calls.filter((c) => c.url.endsWith('/editMessageText') && c.body.message_id === id);
const toast = () => calls.filter((c) => c.url.endsWith('/answerCallbackQuery')).at(-1).body.text;
const buttons = (markup) => (markup ? markup.inline_keyboard.flat().map((b) => b.callback_data) : []);
const count = (table, where = '1') => sql.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get().n;
const reminder = (where) => sql.prepare(`SELECT * FROM reminders WHERE ${where}`).get();
const firing = (id) => sql.prepare('SELECT * FROM firings WHERE id = ?').get(id);

const seed = (table, row) => {
  const keys = Object.keys(row);
  sql.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...keys.map((k) => row[k]));
  return row;
};
const seedReminder = (cols) => seed('reminders', {
  id: 10, chat_id: 1, display_num: 1, text: 'clear poop', schedule_kind: 'daily',
  schedule_detail: '{"h":21,"mi":0}', nag_intervals: '[15,30,60]', next_fire_at: NOW + HOUR,
  paused: 0, created_at: NOW - DAY, scored: 1, ...cols,
});
const seedFiring = (cols) => seed('firings', {
  id: 5, reminder_id: 10, chat_id: 1, reminder_text: 'clear poop', fired_at: NOW - 2 * HOUR,
  state: 'nagging', nag_count: 0, next_nag_at: NOW + 15 * 60000, last_message_id: 700, scored: 1, ...cols,
});

describe('↩️ Not done after the chore was deleted', () => {
  it('leaves a deleted recurring chore deleted, and its own Undo still restores it', async () => {
    seedReminder({});
    seedFiring({ state: 'done', done_by: '@nicholaswan', done_at: NOW - HOUR, next_nag_at: null });
    await say(5, '/delete clear poop');
    const trashId = sql.prepare('SELECT id FROM trash').get().id;
    await tap('nd:5', { text: '😻 receipt', message_id: 700 });
    expect(toast()).toBe('That chore is gone for good.');
    expect(reminder('id = 10')).toBeUndefined();
    expect(firing(5).state).toBe('done');
    await tap(`t:${trashId}`, { text: '🗑️ deleted' });
    expect(toast()).toBe('Restored 😺');
    expect(reminder('id = 10')).toMatchObject({ schedule_kind: 'daily', next_fire_at: NOW + HOUR });
  });

  it('does not bring back a recurring chore deleted after it was done early', async () => {
    seedReminder({});
    await say(5, '/done clear poop');
    const firingId = sql.prepare('SELECT id FROM firings').get().id;
    await say(6, '/delete clear poop');
    const deletion = sql.prepare("SELECT id FROM trash WHERE json_extract(payload, '$._firing') IS NULL").get().id;
    await tap(`ne:${firingId}`, { text: '😻 receipt' });
    expect(toast()).toBe('That chore is gone for good.');
    expect(reminder('id = 10')).toBeUndefined();
    expect(firing(firingId).state).toBe('done');
    await tap(`t:${deletion}`, { text: '🗑️ deleted' });
    expect(reminder('id = 10')).toMatchObject({ text: 'clear poop' });
  });
});

describe('vacation wake keeps one-offs', () => {
  beforeEach(() => {
    sql.prepare('UPDATE settings SET paused_until = ? WHERE chat_id = 1').run(NOW - 1000);
  });
  const oneOff = (cols = {}) => seedReminder({
    id: 20, display_num: 2, text: 'renew passport', schedule_kind: 'once', schedule_detail: '{}', next_fire_at: null, ...cols,
  });

  it('keeps an overdue one-off and puts its card back with Done, while a recurring nag goes', async () => {
    oneOff();
    seedFiring({ id: 7, reminder_id: 20, reminder_text: 'renew passport', fired_at: NOW - 3 * DAY, next_nag_at: null });
    seedReminder({ next_fire_at: NOW - DAY });
    seedFiring({ id: 8, last_message_id: 701 });
    await wakeChat(env, 1, TZ);
    expect(reminder('id = 20')).toMatchObject({ text: 'renew passport' });
    expect(firing(7)).toMatchObject({ state: 'nagging', next_nag_at: null });
    const card = edits(700).at(-1);
    expect(card.body.text).toMatch(/^⏰/);
    expect(buttons(card.body.reply_markup)).toContain('d:7');
    expect(firing(8)).toBeUndefined();
  });

  it('brings a one-off that was nagging when the holiday began back as quietly overdue', async () => {
    oneOff();
    seedFiring({ id: 7, reminder_id: 20, reminder_text: 'renew passport', fired_at: NOW - 2 * DAY, next_nag_at: NOW - DAY });
    await wakeChat(env, 1, TZ);
    expect(firing(7)).toMatchObject({ state: 'nagging', next_nag_at: null });
    expect(edits(700).at(-1).body.text).toMatch(/^⏰/);
  });

  it('leaves a one-off paused on its own paused, and says so on its card', async () => {
    oneOff({ paused: 1 });
    seedFiring({ id: 7, reminder_id: 20, reminder_text: 'renew passport', fired_at: NOW - 2 * DAY, next_nag_at: NOW - DAY });
    await wakeChat(env, 1, TZ);
    expect(firing(7)).toMatchObject({ state: 'nagging', next_nag_at: NOW - DAY });
    const card = edits(700).at(-1);
    expect(card.body.text).toBe('⏸️ <b>renew passport</b>\nPaused.');
    expect(buttons(card.body.reply_markup)).toEqual([]);
  });
});

describe('rotation survives the time wizard', () => {
  it.each([
    ['/chore rotate dishes daily', 'h19'],
    ['/chore rotate dishes', 'r15'],
    ['/chore rotate dishes', 'd19'],
  ])('%s, then %s', async (typed, code) => {
    await say(5, typed);
    const draft = sql.prepare('SELECT id FROM drafts').get();
    await tap(`w:${draft.id}:${code}`, { text: 'wizard' });
    expect(JSON.parse(reminder('1').schedule_detail).rotate).toBe(true);
  });

  it('keeps it through a typed time', async () => {
    await say(5, '/chore rotate dishes daily');
    await say(6, '7pm');
    expect(reminder('1')).toMatchObject({ text: 'dishes', schedule_kind: 'daily' });
    expect(JSON.parse(reminder('1').schedule_detail)).toMatchObject({ h: 19, rotate: true });
  });
});

describe('an exact chore name wins', () => {
  it('finds "trash" beside "trash bins"', async () => {
    await say(5, '/chore trash 7pm daily');
    await say(6, '/chore trash bins 8pm daily');
    await say(7, '/done trash');
    expect(sql.prepare("SELECT reminder_text FROM firings WHERE state = 'done'").all().map((r) => r.reminder_text))
      .toEqual(['trash']);
  });

  it('names the numbers when two chores share a name exactly', async () => {
    await say(5, '/chore trash 7pm daily');
    await say(6, '/chore trash 8pm daily');
    calls.length = 0;
    await say(7, '/done trash');
    expect(sent(/matches/)[0].body.text).toBe('"trash" matches: trash (/done 1), trash (/done 2) — use the number.');
  });
});

describe('a fire that fails before its firing exists', () => {
  it.each([
    ['the rotation pick', /FROM members/, '{"h":14,"mi":0,"rotate":true}'],
    ['the stale-nag sweep', /FROM firings WHERE reminder_id = \? AND state = 'nagging'/, '{"h":14,"mi":0}'],
  ])('releases its claim when %s throws, so the next tick fires it', async (_, re, detail) => {
    const r = seedReminder({ schedule_detail: detail, next_fire_at: NOW - 1000 });
    failOn = re;
    await expect(fireReminder(env, r, NOW, TZ)).rejects.toThrow('simulated');
    expect(reminder('id = 10').next_fire_at).toBe(NOW - 1000);
    expect(count('firings')).toBe(0);
    failOn = null;
    await fireReminder(env, reminder('id = 10'), NOW, TZ);
    expect(count('firings', "state = 'nagging'")).toBe(1);
  });
});

describe('snooze codes', () => {
  it.each(['abc', '99999', '0'])('refuses z:5:%s and changes nothing', async (code) => {
    seedReminder({});
    seedFiring({});
    await tap(`z:5:${code}`, { text: '🐱 clear poop', message_id: 700 });
    expect(toast()).toBe('That option is not on this menu.');
    expect(firing(5)).toMatchObject({ snoozes_used: 0, next_nag_at: NOW + 15 * 60000, snoozed_until: null });
  });

  it('still takes a code the menu offers', async () => {
    seedReminder({});
    seedFiring({});
    await tap('z:5:30', { text: '🐱 clear poop', message_id: 700 });
    expect(firing(5)).toMatchObject({ snoozes_used: 1, next_nag_at: NOW + 30 * 60000 });
  });
});

describe('commands are not left in the group', () => {
  it('tidies away a typed /help and /start', async () => {
    await say(30, '/help');
    await say(31, '/start');
    expect(deleted(30)).toBe(true);
    expect(deleted(31)).toBe(true);
  });

  it('keeps a refused /chore to be copied, and its refusal\'s OK clears it', async () => {
    await say(40, '/chore trash 30pm daily');
    expect(deleted(40)).toBe(false);
    const refusal = sent(/not a valid time/)[0];
    expect(buttons(refusal.body.reply_markup)).toEqual(['ok:40']);
    await tap('ok:40', { text: refusal.body.text });
    expect(deleted(40)).toBe(true);
  });

  it('keeps the command through a wizard Cancel, and the cancelled line\'s OK clears it', async () => {
    await say(41, '/chore dishes daily');
    const draft = sql.prepare('SELECT id FROM drafts').get();
    await tap(`w:${draft.id}:cancel`, { text: 'wizard' });
    expect(deleted(41)).toBe(false);
    const cancelled = edits(600).at(-1);
    expect(cancelled.body.text).toContain('Cancelled');
    expect(buttons(cancelled.body.reply_markup)).toEqual(['ok:41']);
    await tap('ok:41', { text: cancelled.body.text });
    expect(deleted(41)).toBe(true);
  });

  it('carries the kept command through Undo and Restore', async () => {
    await say(5, '/chore water plants 7pm daily');
    const confirmation = sent(/added <b>water plants/)[0];
    const { id } = reminder('1');
    expect(buttons(confirmation.body.reply_markup)).toEqual([`c:${id}:5`, `u:${id}`, 'ok:5']);
    await tap(`u:${id}`, { text: confirmation.body.text, reply_markup: confirmation.body.reply_markup });
    expect(deleted(5)).toBe(false);
    const undone = edits(600).at(-1);
    const trashId = sql.prepare('SELECT id FROM trash').get().id;
    expect(buttons(undone.body.reply_markup)).toEqual([`t:${trashId}`, 'ok:5']);
    await tap(`t:${trashId}`, { text: undone.body.text, reply_markup: undone.body.reply_markup });
    expect(buttons(edits(600).at(-1).body.reply_markup)).toEqual(['ok:5']);
    await tap('ok:5');
    expect(deleted(5)).toBe(true);
  });
});
