// The 8am digest names what was left nagging overnight. It used to carry only
// OK, so the one message that reached an assignee whose private nag never
// did had no way to finish the chore. Real SQLite behind the D1 shim.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { sendDigests } from '../src/cron.js';
import { handleUpdate } from '../src/handlers.js';

const EIGHT_AM = Date.UTC(2026, 8, 5, 0); // 08:00 Asia/Singapore
let sql, env, calls;
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(EIGHT_AM);
  sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  sql.exec(`INSERT INTO settings (chat_id, dashboard_msg_id) VALUES (1, 50);
    INSERT INTO reminders (id, chat_id, text, assignee_name, schedule_kind, schedule_detail, nag_intervals, created_at, scored)
    VALUES (10, 1, 'singlife', '@nicholaswan', 'once', '{}', '[15,30,60]', ${EIGHT_AM - 90000000}, 0),
           (11, 1, 'clear poop', NULL, 'daily', '{"h":21,"mi":0}', '[15,30,60]', ${EIGHT_AM - 90000000}, 1);
    INSERT INTO firings (id, reminder_id, chat_id, reminder_text, fired_at, next_nag_at, nag_user_id, last_message_ephemeral, last_message_id, scored)
    VALUES (5, 10, 1, 'singlife', ${EIGHT_AM - 90000000}, NULL, 2, 1, 777, 0),
           (6, 11, 1, 'clear poop', ${EIGHT_AM - 40000000}, ${EIGHT_AM + 60000}, NULL, 0, 778, 1);`);
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

const digest = () => calls.find((c) => c.url.endsWith('/sendMessage') && /hanging over/.test(c.body.text));
const buttons = (markup) => markup.inline_keyboard.flat().map((b) => [b.text, b.callback_data]);
const firing = (id) => sql.prepare('SELECT * FROM firings WHERE id = ?').get(id);
const tap = (data, markup, chatId = 1, from = { id: 2, first_name: 'Nick', username: 'nicholaswan' }) =>
  handleUpdate(env, { callback_query: {
    id: 'tap', data, from, message: { chat: { id: chatId }, message_id: 99, reply_markup: markup },
  } });

describe('the 8am digest', () => {
  it('names each chore left nagging with a Done button for it, silently', async () => {
    await sendDigests(env, EIGHT_AM);
    const d = digest();
    expect(d.body.disable_notification).toBe(true);
    expect(d.body.text).toContain('<b>singlife</b> (@nicholaswan)');
    expect(d.body.text).toContain('<b>clear poop</b>');
    expect(buttons(d.body.reply_markup)).toEqual([['✅ singlife', 'dg:5'], ['✅ clear poop', 'dg:6'], ['✅ OK', 'ok']]);
  });

  it('says nothing when nothing is nagging', async () => {
    sql.exec('DELETE FROM firings');
    await sendDigests(env, EIGHT_AM);
    expect(calls.some((c) => c.url.endsWith('/sendMessage'))).toBe(false);
  });

  it('completes the tapped chore and keeps the others on the digest', async () => {
    await sendDigests(env, EIGHT_AM);
    const markup = digest().body.reply_markup;
    calls.length = 0;
    await tap('dg:5', markup);
    expect(firing(5)).toMatchObject({ state: 'done', done_by: '@nicholaswan' });
    expect(firing(6)).toMatchObject({ state: 'nagging' });
    // A one-off is spent; the private nag card is redrawn as a receipt.
    expect(sql.prepare('SELECT id FROM reminders WHERE id = 10').get()).toBeUndefined();
    expect(calls.some((c) => c.url.endsWith('/editEphemeralMessageText') && c.body.ephemeral_message_id === 777)).toBe(true);
    const redraw = calls.find((c) => c.url.endsWith('/editMessageText') && c.body.message_id === 99);
    expect(redraw.body.text).toContain('<b>clear poop</b>');
    // The finished one stays on as a struck line with its way back.
    expect(redraw.body.text).toContain('<s>singlife</s> — done by @nicholaswan');
    expect(buttons(redraw.body.reply_markup)).toEqual([
      ['✅ clear poop', 'dg:6'], ['↩️ Not done · singlife', 'nd:5'], ['✅ OK', 'ok'],
    ]);
    expect(calls.find((c) => c.url.endsWith('/answerCallbackQuery')).body.text).toContain('Purrs 😻');
  });

  it('closes out with an OK once the last chore is done', async () => {
    await sendDigests(env, EIGHT_AM);
    const markup = digest().body.reply_markup;
    await tap('dg:5', markup);
    calls.length = 0;
    await tap('dg:6', { inline_keyboard: [[{ text: '✅ clear poop', callback_data: 'dg:6' }]] });
    expect(firing(6)).toMatchObject({ state: 'done' });
    const redraw = calls.find((c) => c.url.endsWith('/editMessageText') && c.body.message_id === 99);
    expect(redraw.body.text).toContain('All caught up');
    expect(buttons(redraw.body.reply_markup)).toEqual([['↩️ Not done · clear poop', 'nd:6'], ['✅ OK', 'ok']]);
  });

  it('answers a stale tap without touching anything, and redraws', async () => {
    await sendDigests(env, EIGHT_AM);
    const markup = digest().body.reply_markup;
    sql.exec("UPDATE firings SET state = 'done', done_by = 'yx' WHERE id = 5");
    calls.length = 0;
    await tap('dg:5', markup);
    expect(firing(5)).toMatchObject({ done_by: 'yx' });
    expect(calls.find((c) => c.url.endsWith('/answerCallbackQuery')).body.text).toBe('Already handled 👍');
    const redraw = calls.find((c) => c.url.endsWith('/editMessageText'));
    expect(buttons(redraw.body.reply_markup)).toEqual([['✅ clear poop', 'dg:6'], ['✅ OK', 'ok']]);
  });

  it('ignores a Done forged from another chat', async () => {
    await sendDigests(env, EIGHT_AM);
    const markup = digest().body.reply_markup;
    calls.length = 0;
    await tap('dg:5', markup, 2);
    expect(firing(5)).toMatchObject({ state: 'nagging' });
  });
});
