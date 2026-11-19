// "Nag-Bot pinned this message": the notice Telegram posts for the bot's own
// pins is deleted as soon as it arrives (19 Nov 2026; it waited a day for the
// sweep before), falling back to the sweep if Telegram refuses. A person's pin
// notice stays.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { handleUpdate } from '../src/handlers.js';
import { SENT_TTL_MS } from '../src/tg.js';
import { d1 } from './d1.js';

const NOW = Date.parse('2026-11-18T15:00:00+08:00');
const BOT = { id: 8953332058, is_bot: true, first_name: 'TwoShotsNagBot', username: 'TwoShotsNagBot' };

let sql, env;
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  env = { BOT_TOKEN: `${BOT.id}:secret`, ALLOWED_CHATS: '1', DB: d1(sql) };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, result: true }))));
});
afterEach(() => { sql.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const notice = (from, messageId = 742) => handleUpdate(env, { message: {
  message_id: messageId, from, chat: { id: 1, type: 'supergroup' }, date: NOW / 1000,
  pinned_message: { message_id: 738, from: BOT, chat: { id: 1, type: 'supergroup' }, date: NOW / 1000, text: '⚡ Quick log' },
} });
const swept = () => sql.prepare('SELECT chat_id, message_id, is_ephemeral, delete_after FROM sent_messages').all();

const calls = () => fetch.mock.calls.map(([url, init]) => [url.split('/').pop(), JSON.parse(init.body)]);

it("deletes the bot's own pin notice at once", async () => {
  await notice(BOT);
  expect(calls()).toEqual([['deleteMessage', { chat_id: 1, message_id: 742 }]]);
  expect(swept()).toEqual([]);
});

it('puts the notice on the daily sweep when Telegram will not delete it', async () => {
  fetch.mockImplementation(async () => new Response(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: message can't be deleted" })));
  await notice(BOT);
  expect(swept()).toEqual([{ chat_id: 1, message_id: 742, is_ephemeral: 0, delete_after: NOW + SENT_TTL_MS }]);
});

it("leaves a person's pin notice, and another bot's", async () => {
  await notice({ id: 2, is_bot: false, first_name: 'Nick', username: 'nicholaswan' }, 743);
  await notice({ id: 99, is_bot: true, first_name: 'Other', username: 'otherbot' }, 744);
  expect(swept()).toEqual([]);
  expect(calls()).toEqual([]);
});
