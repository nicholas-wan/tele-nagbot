// The morning after the digest grew a ✅ per chore (26 Sep 2026): it listed a
// chore postponed to that evening, offered no OK, and a mis-tap on its ✅ was
// final — "cut nails" was marked done at 08:08 for a nag due at 21:09. So the
// digest ends with OK, leaves parked chores out, and every Done — on a digest,
// a nag card, or the public receipt of a private nag — can be taken back for
// a day. Real SQLite behind the D1 shim.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { handleUpdate } from '../src/handlers.js';
import { sendDigests } from '../src/cron.js';

const HOUR = 3600000;
const NOW = Date.UTC(2026, 8, 5, 6); // Sat 14:00 Asia/Singapore
const EIGHT_AM = Date.UTC(2026, 8, 5, 0);

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
const say = (message_id, text) => handleUpdate(env, {
  message: { message_id, chat: { id: 1 }, from: nick, text, entities: [] },
});
const tap = (data, { text = '🐱 nag', message_id = 99, markup = null } = {}) => handleUpdate(env, { callback_query: {
  id: 'tap', data, from: nick, message: { chat: { id: 1 }, message_id, text, reply_markup: markup },
} });
const sent = (re) => calls.filter((c) => c.url.endsWith('/sendMessage') && re.test(c.body.text));
const edits = (id) => calls.filter((c) => c.url.endsWith('/editMessageText') && c.body.message_id === id);
const toast = () => calls.filter((c) => c.url.endsWith('/answerCallbackQuery')).at(-1).body.text;
const buttons = (markup) => (markup ? markup.inline_keyboard.flat().map((b) => b.callback_data) : []);
const firing = (id) => sql.prepare('SELECT * FROM firings WHERE id = ?').get(id);
const reminder = (id) => sql.prepare('SELECT * FROM reminders WHERE id = ?').get(id);
const count = (table) => sql.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

const seedReminder = (cols) => {
  const row = { id: 10, chat_id: 1, text: 'clear poop', schedule_kind: 'daily', schedule_detail: '{"h":21,"mi":0}',
    nag_intervals: '[15,30,60]', next_fire_at: NOW + HOUR, paused: 0, created_at: NOW - 24 * HOUR, scored: 1, ...cols };
  const keys = Object.keys(row);
  sql.prepare(`INSERT INTO reminders (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => row[k]));
};
const seedFiring = (cols) => {
  const row = { id: 5, reminder_id: 10, chat_id: 1, reminder_text: 'clear poop', fired_at: NOW - 2 * HOUR,
    state: 'nagging', nag_count: 0, next_nag_at: NOW + 15 * 60000, last_message_id: 700, scored: 1, ...cols };
  const keys = Object.keys(row);
  sql.prepare(`INSERT INTO firings (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => row[k]));
};

describe('the 8am digest', () => {
  it('ends with OK and leaves out chores the household parked', async () => {
    Date.now.mockReturnValue(EIGHT_AM);
    seedReminder({ id: 10, text: 'clear poop' });
    seedReminder({ id: 11, text: 'cut nails' });
    seedReminder({ id: 12, text: 'dishes' });
    seedFiring({ id: 5, reminder_id: 10, fired_at: EIGHT_AM - 2 * HOUR });
    // 📅 Tomorrow carried fired_at to this evening; a snooze parked the other until 9am.
    seedFiring({ id: 6, reminder_id: 11, reminder_text: 'cut nails', fired_at: EIGHT_AM + 13 * HOUR, next_nag_at: EIGHT_AM + 13 * HOUR, last_message_id: 701 });
    seedFiring({ id: 7, reminder_id: 12, reminder_text: 'dishes', fired_at: EIGHT_AM - 2 * HOUR, next_nag_at: EIGHT_AM + HOUR, snoozed_until: EIGHT_AM + HOUR, last_message_id: 702 });
    await sendDigests(env, EIGHT_AM);
    const d = sent(/hanging over/)[0];
    expect(d.body.text).toContain('clear poop');
    expect(d.body.text).not.toContain('cut nails');
    expect(d.body.text).not.toContain('dishes');
    expect(buttons(d.body.reply_markup)).toEqual(['dg:5', 'ok']);
  });

  it('lets a Done tapped on it be taken back from the same message', async () => {
    Date.now.mockReturnValue(EIGHT_AM);
    seedReminder({});
    seedFiring({ fired_at: EIGHT_AM - 2 * HOUR });
    await sendDigests(env, EIGHT_AM);
    const markup = sent(/hanging over/)[0].body.reply_markup;
    calls.length = 0;
    await tap('dg:5', { text: '☀️ digest', markup });
    expect(firing(5)).toMatchObject({ state: 'done', done_by: '@nicholaswan' });
    const after = edits(99)[0];
    expect(after.body.text).toContain('<s>clear poop</s> — done by @nicholaswan');
    expect(buttons(after.body.reply_markup)).toEqual(['nd:5', 'ok']);
    expect(toast()).toContain('Not done is below');

    calls.length = 0;
    await tap('nd:5', { text: after.body.text, markup: after.body.reply_markup });
    expect(firing(5)).toMatchObject({ state: 'nagging', done_by: null, done_at: null, next_nag_at: EIGHT_AM + 15 * 60000 });
    // The receipt card is a nag again, the group hears, and the digest lists it once more.
    const card = edits(700)[0];
    expect(card.body.text).toMatch(/^🐱/);
    expect(buttons(card.body.reply_markup)).toContain('d:5');
    expect(sent(/not done after all, says @nicholaswan/)).toHaveLength(1);
    const digest = edits(99)[0];
    expect(digest.body.text).toContain('<b>clear poop</b>');
    expect(buttons(digest.body.reply_markup)).toEqual(['dg:5', 'ok']);
    expect(toast()).toBe('Taken back ↩️');
  });
});

describe('↩️ Not done', () => {
  it('is on every nag receipt, and brings a finished one-off back from the trash unscheduled', async () => {
    seedReminder({ schedule_kind: 'once', schedule_detail: '{}', next_fire_at: null });
    seedFiring({});
    await tap('d:5');
    expect(reminder(10)).toBeUndefined();
    expect(count('trash')).toBe(1);
    const receipt = edits(700)[0];
    expect(receipt.body.text).toContain('Done by @nicholaswan');
    expect(buttons(receipt.body.reply_markup)).toEqual(['nd:5', 'ok']);

    calls.length = 0;
    await tap('nd:5', { text: receipt.body.text, message_id: 700 });
    expect(reminder(10)).toMatchObject({ text: 'clear poop', schedule_kind: 'once', next_fire_at: null });
    expect(count('trash')).toBe(0);
    expect(firing(5)).toMatchObject({ state: 'nagging', next_nag_at: NOW + 15 * 60000 });
    expect(edits(700)).toHaveLength(1);
    expect(edits(700)[0].body.text).toMatch(/^🐱/);
    expect(toast()).toBe('Taken back ↩️');
  });

  it('waits for the time the household chose when a postponed nag is taken back', async () => {
    seedReminder({});
    seedFiring({ state: 'done', done_by: '@nicholaswan', done_at: NOW - HOUR, fired_at: NOW + 7 * HOUR, next_nag_at: null });
    await tap('nd:5', { text: '😻 receipt', message_id: 700 });
    expect(firing(5)).toMatchObject({ state: 'nagging', next_nag_at: NOW + 7 * HOUR });
    expect(edits(700)[0].body.text).toMatch(/^😴/);
  });

  it('is refused after a day, and for a second tap', async () => {
    seedReminder({});
    seedFiring({ state: 'done', done_by: '@nicholaswan', done_at: NOW - 25 * HOUR, next_nag_at: null });
    await tap('nd:5', { text: '😻 receipt', message_id: 700 });
    expect(toast()).toBe('Too late to take that back.');
    expect(firing(5).state).toBe('done');
    sql.prepare('UPDATE firings SET done_at = ? WHERE id = 5').run(NOW - HOUR);
    await tap('nd:5', { text: '😻 receipt', message_id: 700 });
    expect(firing(5).state).toBe('nagging');
    await tap('nd:5', { text: '😻 receipt', message_id: 700 });
    expect(toast()).toBe('Nothing to take back.');
  });

  it('sits on the public receipt of a private nag, which then says so', async () => {
    seedReminder({ assignee_name: '@nicholaswan' });
    seedFiring({ nag_user_id: 2, last_message_ephemeral: 1, last_message_id: 777 });
    await tap('d:5');
    const receipt = sent(/done by @nicholaswan/)[0];
    expect(buttons(receipt.body.reply_markup)).toEqual(['nd:5', 'ok']);
    calls.length = 0;
    await tap('nd:5', { text: receipt.body.text, message_id: 99 });
    expect(firing(5).state).toBe('nagging');
    expect(edits(99)[0].body.text).toContain('not done after all');
    expect(calls.some((c) => c.url.endsWith('/editEphemeralMessageText') && c.body.ephemeral_message_id === 777)).toBe(true);
  });
});

describe('Restore', () => {
  it('is claimed once, so a double tap restores a single chore', async () => {
    await say(5, '/chore water plants 7pm daily');
    await say(6, '/delete water plants');
    const trashId = sql.prepare('SELECT id FROM trash').get().id;
    await tap(`t:${trashId}`);
    await tap(`t:${trashId}`);
    expect(toast()).toBe('Too late — that one is gone for good.');
    expect(count('reminders')).toBe(1);
  });
});
