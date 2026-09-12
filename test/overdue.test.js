import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { renagPending } from '../src/cron.js';
import { expireFiring } from '../src/nag.js';
import { choreListHtml } from '../src/dashboard.js';
import { handleUpdate } from '../src/handlers.js';

const NOW = Date.UTC(2026, 8, 5, 6);
let sql, env, calls;
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  sql.exec(`INSERT INTO settings (chat_id, dashboard_msg_id) VALUES (1, 99);
    INSERT INTO reminders (id, chat_id, text, schedule_kind, schedule_detail, nag_intervals, created_at, scored)
    VALUES (10, 1, 'test reminder', 'once', '{}', '[15,30,60]', ${NOW - 90000000}, 0);
    INSERT INTO firings (id, reminder_id, chat_id, reminder_text, fired_at, next_nag_at, nag_user_id, last_message_ephemeral, scored)
    VALUES (5, 10, 1, 'test reminder', ${NOW - 90000000}, ${NOW - 60000}, 2, 1, 0);`);
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
const firing = () => sql.prepare('SELECT * FROM firings WHERE id = 5').get();
const reminder = () => sql.prepare('SELECT * FROM reminders WHERE id = 10').get();
const tap = (data) => handleUpdate(env, { callback_query: {
  id: 'tap', data, from: { id: 2, first_name: 'Nick' },
  message: { chat: { id: 1 }, message_id: 99 },
} });

it('keeps a one-off overdue across cron ticks without failure notices or repeated nags', async () => {
  await renagPending(env, NOW);
  expect(reminder()).toBeTruthy();
  expect(firing()).toMatchObject({ state: 'nagging', next_nag_at: null });
  expect(await choreListHtml(env, 1, 'Asia/Singapore')).toContain('⏰ overdue');
  expect(calls.some(c => c.url.endsWith('/sendMessage'))).toBe(false);
  calls.length = 0;
  await renagPending(env, NOW + 86400000);
  expect(calls).toHaveLength(0);
  expect(reminder()).toBeTruthy();
});

it.each(['m:done:10', 'd:5'])('allows completion after expiry via %s', async (button) => {
  await renagPending(env, NOW);
  await tap(button);
  expect(firing()).toMatchObject({ state: 'done', done_by: 'Nick', scored: 0 });
  expect(reminder()).toBeUndefined();
  await tap(button);
  expect(sql.prepare("SELECT count(*) AS n FROM firings WHERE state='done'").get().n).toBe(1);
});

it('keeps Done and Delete available in the pinned manager', async () => {
  await renagPending(env, NOW);
  await tap('m:item:10');
  const keys = calls.find(c => c.url.endsWith('/editMessageReplyMarkup')).body.reply_markup.inline_keyboard.flat();
  expect(keys.some(k => k.callback_data === 'm:done:10')).toBe(true);
  expect(keys.some(k => k.callback_data === 'm:delete:10')).toBe(true);
  await tap('m:confirm:10');
  expect(reminder()).toBeUndefined();
  expect(firing()).toBeUndefined();
});

it('does not override a completion or a refreshed expiry window', async () => {
  const stale = firing();
  sql.exec(`UPDATE firings SET fired_at = ${NOW}, next_nag_at = ${NOW + 60000}`);
  expect(await expireFiring(env, stale, reminder())).toBe(false);
  expect(firing().next_nag_at).toBe(NOW + 60000);
  sql.exec("UPDATE firings SET state = 'done'");
  expect(await expireFiring(env, firing(), reminder())).toBe(false);
  expect(firing().state).toBe('done');
});

it('still expires recurring occurrences while keeping their reminder', async () => {
  sql.exec(`UPDATE reminders SET schedule_kind='daily', schedule_detail='{"h":14,"mi":0}', next_fire_at=${NOW + 86400000}`);
  await renagPending(env, NOW);
  expect(firing().state).toBe('expired');
  expect(reminder()).toBeTruthy();
});
