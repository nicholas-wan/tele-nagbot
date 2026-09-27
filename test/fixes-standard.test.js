// Standardization pass (27 Sep 2026): every redraw draws the same card
// (firingCard), one confirmation shape, one done-early receipt with its own
// way back, the reminder marker on every card state, the snoozer's name kept,
// receipts with a clock time, and a public deletion log however it was
// triggered. Real SQLite behind the D1 shim.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { handleUpdate } from '../src/handlers.js';

const HOUR = 3600000;
const NOW = Date.UTC(2026, 8, 5, 6); // Sat 14:00 Asia/Singapore

let sql, env, calls;
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  sql.exec('INSERT INTO settings (chat_id, dashboard_msg_id) VALUES (1, 50)');
  env = { BOT_TOKEN: 'test', ALLOWED_CHATS: '1', DB: {
    prepare(query) {
      const stmt = sql.prepare(query);
      const bound = (args = []) => ({
        bind: (...values) => bound(values),
        first: async () => stmt.get(...args) || null,
        all: async () => ({ results: stmt.all(...args) }),
        run: async () => { const r = stmt.run(...args); return { meta: { changes: r.changes, last_row_id: r.lastInsertRowid } }; },
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
const say = (message_id, text, from = nick) => handleUpdate(env, {
  message: { message_id, chat: { id: 1 }, from, text, entities: [] },
});
const tap = (data, { text = '🐱 nag', message_id = 99, from = nick } = {}) => handleUpdate(env, { callback_query: {
  id: 'tap', data, from, message: { chat: { id: 1 }, message_id, text },
} });
const sent = (re) => calls.filter((c) => c.url.endsWith('/sendMessage') && re.test(c.body.text));
const edits = (id) => calls.filter((c) => c.url.endsWith('/editMessageText') && c.body.message_id === id);
const markups = (id) => calls.filter((c) => c.url.endsWith('/editMessageReplyMarkup') && c.body.message_id === id);
const toast = () => calls.filter((c) => c.url.endsWith('/answerCallbackQuery')).at(-1).body.text;
const buttons = (markup) => (markup ? markup.inline_keyboard.flat().map((b) => b.callback_data) : []);
const firing = (id) => sql.prepare('SELECT * FROM firings WHERE id = ?').get(id);
const reminder = (id) => sql.prepare('SELECT * FROM reminders WHERE id = ?').get(id);
const count = (table) => sql.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

const seedReminder = (cols) => {
  const row = { id: 10, chat_id: 1, text: 'clear poop', schedule_kind: 'daily', schedule_detail: '{"h":21,"mi":0}',
    nag_intervals: '[15,30,60]', next_fire_at: NOW + 7 * HOUR, paused: 0, created_at: NOW - 24 * HOUR, scored: 1, ...cols };
  const keys = Object.keys(row);
  sql.prepare(`INSERT INTO reminders (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => row[k]));
};
const seedFiring = (cols) => {
  const row = { id: 5, reminder_id: 10, chat_id: 1, reminder_text: 'clear poop', fired_at: NOW - 2 * HOUR,
    state: 'nagging', nag_count: 0, next_nag_at: NOW + 15 * 60000, last_message_id: 700, scored: 1, ...cols };
  const keys = Object.keys(row);
  sql.prepare(`INSERT INTO firings (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => row[k]));
};

describe('one confirmation shape', () => {
  it('says who added what, the cadence, and marks a reminder — silently', async () => {
    await say(5, '/remind pay tax 7pm daily');
    const c = sent(/added/)[0];
    expect(c.body.text).toBe('📝 @nicholaswan added <b>pay tax</b> · <i>reminder</i>\nFirst reminder: Sat, Sep 5, 7:00 PM (daily 7pm)');
    expect(c.body.disable_notification).toBe(true);
    calls.length = 0;
    await say(6, '/chore dishes 8pm');
    expect(sent(/added/)[0].body.text).toBe('📝 @nicholaswan added <b>dishes</b>\nFirst reminder: Sat, Sep 5, 8:00 PM');
  });
});

describe('every card state carries the reminder marker and the snoozer', () => {
  it('keeps "(reminder — no points)" on the 😴 card and names who snoozed it on every redraw', async () => {
    seedReminder({ scored: 0 });
    seedFiring({ scored: 0 });
    await tap('z:5:30', { message_id: 700, from: jane });
    expect(firing(5)).toMatchObject({ snoozed_by: '@jane', snoozed_until: NOW + 30 * 60000 });
    const card = edits(700)[0];
    expect(card.body.text).toContain('😴 <b>clear poop</b> <i>(reminder — no points)</i>');
    expect(card.body.text).toContain('Snoozed by @jane');
    // /poke and a points toggle redraw from the row, and still say Jane.
    calls.length = 0;
    await say(6, '/poke');
    expect(sent(/^😴/)[0].body.text).toContain('Snoozed by @jane');
  });

  it('draws the ⏰ card, not a nag, when Points is toggled on an overdue one-off', async () => {
    seedReminder({ schedule_kind: 'once', schedule_detail: '{}', next_fire_at: null });
    seedFiring({ fired_at: NOW - 25 * HOUR, next_nag_at: null });
    await tap('e:score:10', { message_id: 50, text: 'board' });
    const card = edits(700)[0];
    expect(card.body.text).toMatch(/^⏰/);
    expect(card.body.text).toContain('(reminder — no points)');
    expect(buttons(card.body.reply_markup)).toEqual(['d:5', 'b:5', 'x:5']);
  });

  it('↩️ Back goes by the firing, not the card text, once a snooze has been spent', async () => {
    seedReminder({});
    seedFiring({ snoozed_until: NOW - HOUR, next_nag_at: NOW + 15 * 60000, snoozes_used: 1 });
    await tap('z:5:b', { message_id: 700, text: '😴 clear poop\nSnoozed by @jane until earlier.' });
    expect(buttons(markups(700)[0].body.reply_markup)).toContain('s:5');
    expect(markups(700)[0].body.reply_markup.inline_keyboard[0][2].text).toBe('😴 Snooze…');
  });

  it('resume redraws a surviving snooze in the snoozer\'s name, not the resumer\'s', async () => {
    seedReminder({});
    seedFiring({ snoozed_until: NOW + HOUR, next_nag_at: NOW + HOUR, snoozed_by: '@jane', snoozes_used: 1 });
    await say(5, '/pause clear poop');
    calls.length = 0;
    await say(6, '/resume clear poop');
    expect(edits(700)[0].body.text).toContain('Snoozed by @jane');
  });
});

describe('receipts', () => {
  it('stamps the card receipt with a clock time', async () => {
    seedReminder({});
    seedFiring({});
    await tap('d:5', { message_id: 700 });
    expect(edits(700)[0].body.text).toContain('Done by @nicholaswan at 2:00 PM.');
  });

  it('gives a Done early its way back: the slot returns and the credit goes', async () => {
    seedReminder({});
    await say(5, '/done clear poop');
    expect(reminder(10).next_fire_at).toBe(NOW + 31 * HOUR);
    expect(count('trash')).toBe(1);
    const receipt = sent(/done early by @nicholaswan/)[0];
    const firingId = sql.prepare('SELECT id FROM firings').get().id;
    expect(buttons(receipt.body.reply_markup)).toEqual([`g:${firingId}`, `ne:${firingId}`, 'ok']);
    calls.length = 0;
    await tap(`ne:${firingId}`, { text: receipt.body.text });
    expect(count('firings')).toBe(0);
    expect(reminder(10).next_fire_at).toBe(NOW + 7 * HOUR);
    expect(count('trash')).toBe(0);
    expect(edits(99)[0].body.text).toContain('not done after all');
    expect(sent(/not done after all, says @nicholaswan/)).toHaveLength(1);
    expect(toast()).toBe('Taken back ↩️');
  });

  it('brings a one-off done early back whole, and keeps Not done after Together too', async () => {
    seedReminder({ schedule_kind: 'once', schedule_detail: '{}', next_fire_at: NOW + 7 * HOUR });
    await say(4, 'hello', jane); // on the roster, so Together too has someone to add
    await say(5, '/done clear poop');
    expect(reminder(10)).toBeUndefined();
    const firingId = sql.prepare('SELECT id FROM firings').get().id;
    await tap(`g:${firingId}`, { text: '😻 receipt' });
    const widened = edits(99).at(-1);
    expect(widened.body.text).toContain('done early by @nicholaswan');
    expect(buttons(widened.body.reply_markup)).toEqual([`ne:${firingId}`, 'ok']);
    await tap(`ne:${firingId}`, { text: widened.body.text });
    expect(reminder(10)).toMatchObject({ text: 'clear poop', schedule_kind: 'once', next_fire_at: NOW + 7 * HOUR });
    expect(count('firings')).toBe(0);
  });

  it('refuses to take a Done early back once a later occurrence has fired', async () => {
    seedReminder({});
    await say(5, '/done clear poop');
    const firingId = sql.prepare('SELECT id FROM firings').get().id;
    seedFiring({ id: firingId + 1, fired_at: NOW });
    await tap(`ne:${firingId}`, { text: '😻 receipt' });
    expect(toast()).toBe('Too late to take that back.');
    expect(firing(firingId).state).toBe('done');
  });
});

describe('deletion logs to the group however it was asked', () => {
  it('logs a typed /delete publicly, with Undo', async () => {
    seedReminder({});
    await say(5, '/delete clear poop');
    const log = sent(/deleted <s>clear poop<\/s>/)[0];
    expect(log.body.receiver_user_id).toBeUndefined();
    expect(log.body.text).toContain('@nicholaswan deleted');
    expect(buttons(log.body.reply_markup)[0]).toMatch(/^t:\d+$/);
  });
});
