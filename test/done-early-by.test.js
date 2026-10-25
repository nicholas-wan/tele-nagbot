// 👤 Done early by… on the board's Manage menu (25 Oct 2026): credit a chore
// done ahead of its nag to the housemate who did it, not the one tapping.
// Real SQLite behind the D1 shim.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { handleUpdate } from '../src/handlers.js';
import { d1 } from './d1.js';

const HOUR = 3600000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 10, 11, 30); // Sat 10 Oct 19:30 Asia/Singapore
const TUE_7PM = Date.UTC(2026, 9, 13, 11);

let sql, env, calls;
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  sql.exec('INSERT INTO settings (chat_id, dashboard_msg_id) VALUES (1, 99)');
  sql.exec(`INSERT INTO members (chat_id, user_id, username, first_name, last_seen) VALUES
    (1, 2, 'nicholaswan', 'Nick', 0), (1, 3, 'Dodgerblueee', 'Yx', 0)`);
  sql.prepare(`INSERT INTO reminders (id, chat_id, display_num, text, schedule_kind, schedule_detail,
    nag_intervals, next_fire_at, paused, created_at, scored) VALUES (8, 1, 1, 'slutbed', 'interval',
    '{"days":7,"h":19,"mi":0}', '[15,30,60]', ?, 0, ?, 1)`).run(TUE_7PM, NOW - 30 * DAY);
  env = { BOT_TOKEN: 'test', ALLOWED_CHATS: '1', DB: d1(sql) };
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 99 } }));
  }));
});
afterEach(() => { sql.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const nick = { id: 2, first_name: 'Nick', username: 'nicholaswan' };
const tap = (data) => handleUpdate(env, { callback_query: {
  id: 'tap', data, from: nick, message: { chat: { id: 1 }, message_id: 99, text: 'board' },
} });
const keyboard = () => calls.filter((c) => c.url.endsWith('/editMessageReplyMarkup')).at(-1)
  .body.reply_markup.inline_keyboard;
const toast = () => calls.filter((c) => c.url.endsWith('/answerCallbackQuery')).at(-1).body.text;

it('sits under Done early on a chore that is not nagging yet', async () => {
  await tap('m:item:8');
  expect(keyboard().flat().map((b) => b.callback_data)).toContain('m:doneby:8');
});

it('offers everyone but the person tapping', async () => {
  await tap('m:doneby:8');
  expect(keyboard().map((row) => row.map((b) => [b.text, b.callback_data]))).toEqual([
    [['👤 @Dodgerblueee', 'm:doneas:8:3']],
    [['← Back', 'm:item:8']],
  ]);
});

it('credits the chosen housemate and advances the schedule', async () => {
  await tap('m:doneas:8:3');
  const done = sql.prepare("SELECT * FROM firings WHERE reminder_id = 8 AND state = 'done'").get();
  expect(done.done_by).toBe('@Dodgerblueee');
  expect(done.scored).toBe(1);
  expect(sql.prepare('SELECT next_fire_at FROM reminders WHERE id = 8').get().next_fire_at).toBeGreaterThan(TUE_7PM);
  expect(calls.some((c) => c.url.endsWith('/sendMessage') && /done early by @Dodgerblueee/.test(c.body.text))).toBe(true);
  expect(toast()).toBe('Done early 😻');
});

it('refuses someone who is no longer in the household', async () => {
  await tap('m:doneas:8:42');
  expect(toast()).toBe('That household member is no longer here.');
  expect(sql.prepare('SELECT COUNT(*) AS n FROM firings').get().n).toBe(0);
});
