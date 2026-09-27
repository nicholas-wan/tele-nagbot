import { d1 } from './d1.js';
// A /chore or /remind stays in the group until its confirmation's ✅ OK, so a
// misread chore can be checked against what was typed and copied back after
// Undo. Real SQLite behind the D1 shim, so drafts and the sweep table are live.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { handleUpdate } from '../src/handlers.js';
import { nicknames } from '../src/household.js';

let sql, env, calls;
beforeEach(() => {
  sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  sql.exec('INSERT INTO settings (chat_id, dashboard_msg_id) VALUES (1, 99)');
  env = { BOT_TOKEN: 'test', ALLOWED_CHATS: '1', NICKNAMES: 'nic=@nicholaswan, yx=@Dodgerblueee', DB: d1(sql) };
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 99 } }));
  }));
});
afterEach(() => { sql.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const from = { id: 2, first_name: 'Nick', username: 'nicholaswan' };
const say = (message_id, text) => handleUpdate(env, {
  message: { message_id, chat: { id: 1 }, from, text, entities: [] },
});
const tap = (data) => handleUpdate(env, { callback_query: {
  id: 'tap', data, from, message: { chat: { id: 1 }, message_id: 99 },
} });
const deleted = (id) => calls.some((c) => c.url.endsWith('/deleteMessage') && c.body.message_id === id);
const okData = () => calls
  .filter((c) => /sendMessage|editMessageText/.test(c.url) && c.body.reply_markup)
  .flatMap((c) => c.body.reply_markup.inline_keyboard.flat())
  .find((b) => b.text === '✅ OK');
const swept = (id) => sql.prepare(
  'SELECT 1 FROM sent_messages WHERE chat_id = 1 AND message_id = ? AND is_ephemeral = 0'
).get(id);
const count = (table, where = '1') => sql.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get().n;

describe('a chore command outlives its parse', () => {
  it('keeps the command, points the confirmation OK at it, and sweeps it as a backstop', async () => {
    await say(5, '/chore water plants 7pm daily');
    expect(sql.prepare('SELECT text FROM reminders').get()).toMatchObject({ text: 'water plants' });
    expect(deleted(5)).toBe(false);
    expect(okData().callback_data).toBe('ok:5');
    expect(swept(5)).toBeTruthy();
  });

  it('removes the command together with the confirmation on OK', async () => {
    await say(5, '/chore water plants 7pm daily');
    calls.length = 0;
    await tap('ok:5');
    expect(deleted(5)).toBe(true);
    expect(deleted(99)).toBe(true);
  });

  it('leaves the command standing after Undo, so it can be copied back', async () => {
    await say(5, '/chore water plants 7pm daily');
    const { id } = sql.prepare('SELECT id FROM reminders').get();
    calls.length = 0;
    await tap(`u:${id}`);
    expect(count('reminders')).toBe(0);
    expect(deleted(5)).toBe(false);
  });

  it('keeps a misparsed command too', async () => {
    await say(5, '/chore dinner 7 30pm');
    expect(count('reminders')).toBe(0);
    expect(deleted(5)).toBe(false);
    expect(swept(5)).toBeTruthy();
  });

  it('still tidies a bare menu-tap /chore at once', async () => {
    await say(6, '/chore');
    expect(deleted(6)).toBe(true);
    expect(count('drafts', "text = ''")).toBe(1);
  });

  it('still tidies other commands at once', async () => {
    await say(7, '/list');
    expect(deleted(7)).toBe(true);
  });

  it('carries the command through the time wizard to the eventual OK', async () => {
    await say(8, '/chore laundry every 2 weeks');
    expect(deleted(8)).toBe(false);
    const draft = sql.prepare('SELECT id, source_msg_id FROM drafts').get();
    expect(draft.source_msg_id).toBe(8);
    calls.length = 0;
    await tap(`w:${draft.id}:h19`);
    expect(sql.prepare('SELECT text FROM reminders').get()).toMatchObject({ text: 'laundry' });
    expect(deleted(8)).toBe(false);
    expect(okData().callback_data).toBe('ok:8');
  });

  it('treats the reply to a bare /chore as the command to keep', async () => {
    await say(6, '/chore');
    calls.length = 0;
    await handleUpdate(env, { message: {
      message_id: 9, chat: { id: 1 }, from, text: 'trash 7pm daily', entities: [],
      reply_to_message: { message_id: 99, chat: { id: 1 } },
    } });
    expect(sql.prepare('SELECT text FROM reminders').get()).toMatchObject({ text: 'trash' });
    expect(deleted(9)).toBe(false);
    expect(okData().callback_data).toBe('ok:9');
  });
});

// The confirmation is the one message a chore's owner is sure to have seen:
// an assigned chore's nag is private, and a private nag sent while they were
// offline may never reach them. So the confirmation itself can finish the job.
describe('Done on the creation confirmation', () => {
  const doneData = () => calls
    .filter((c) => /sendMessage|editMessageText/.test(c.url) && c.body.reply_markup)
    .flatMap((c) => c.body.reply_markup.inline_keyboard.flat())
    .find((b) => b.text === '✅ Done');
  const tapFrom = (data, who) => handleUpdate(env, { callback_query: {
    id: 'tap', data, from: who, message: { chat: { id: 1 }, message_id: 99 },
  } });

  it('carries Done beside Undo and OK, bound to the chore and its command', async () => {
    await say(5, '/remind nic singlife tmr 10am');
    const { id } = sql.prepare('SELECT id FROM reminders').get();
    expect(doneData().callback_data).toBe(`c:${id}:5`);
    expect(okData().callback_data).toBe('ok:5');
  });

  it('completes a chore that has not nagged yet, leaving one receipt, and clears the command', async () => {
    await say(5, '/remind nic singlife tmr 10am');
    const { id } = sql.prepare('SELECT id FROM reminders').get();
    calls.length = 0;
    await tapFrom(`c:${id}:5`, from);
    // A one-off done early is spent; its completion is on the record, unscored.
    expect(count('reminders')).toBe(0);
    expect(sql.prepare('SELECT state, done_by, scored FROM firings').get())
      .toMatchObject({ state: 'done', done_by: '@nicholaswan', scored: 0 });
    // The done-early line is the receipt, with its way back; the confirmation
    // is not turned into a second one, and Done is as good as OK for the
    // command it kept — both go.
    const receipts = calls.filter((c) => /sendMessage|editMessageText/.test(c.url) && /😻/.test(c.body.text));
    expect(receipts).toHaveLength(1);
    expect(receipts[0].body.text).toContain('done early by @nicholaswan');
    const firingId = sql.prepare('SELECT id FROM firings').get().id;
    expect(receipts[0].body.reply_markup.inline_keyboard.flat().map((b) => b.callback_data))
      .toEqual([`g:${firingId}`, `ne:${firingId}`, 'ok']);
    expect(deleted(99)).toBe(true);
    expect(deleted(5)).toBe(true);
    const toast = calls.find((c) => c.url.endsWith('/answerCallbackQuery'));
    expect(toast.body.text).toBe('Purrs 😻');
  });

  it('completes the live nag once the chore has fired', async () => {
    await say(5, '/chore water plants 7pm daily');
    const { id } = sql.prepare('SELECT id FROM reminders').get();
    sql.prepare(
      "INSERT INTO firings (reminder_id, chat_id, reminder_text, fired_at, state, scored) VALUES (?, 1, 'water plants', ?, 'nagging', 1)"
    ).run(id, Date.now());
    calls.length = 0;
    await tapFrom(`c:${id}:5`, from);
    expect(sql.prepare('SELECT state, done_by FROM firings').get())
      .toMatchObject({ state: 'done', done_by: '@nicholaswan' });
    // The schedule lives on; only the occurrence is finished.
    expect(count('reminders')).toBe(1);
  });

  it('answers a second tap without completing anything twice', async () => {
    await say(5, '/remind nic singlife tmr 10am');
    const { id } = sql.prepare('SELECT id FROM reminders').get();
    await tapFrom(`c:${id}:5`, from);
    calls.length = 0;
    await tapFrom(`c:${id}:5`, from);
    expect(count('firings')).toBe(1);
    expect(calls.find((c) => c.url.endsWith('/answerCallbackQuery')).body.text).toBe('Already gone.');
  });

  it('ignores a Done forged from another chat', async () => {
    await say(5, '/remind nic singlife tmr 10am');
    const { id } = sql.prepare('SELECT id FROM reminders').get();
    calls.length = 0;
    await handleUpdate(env, { callback_query: {
      id: 'tap', data: `c:${id}:5`, from, message: { chat: { id: 2 }, message_id: 99 },
    } });
    expect(count('reminders')).toBe(1);
    expect(count('firings')).toBe(0);
  });
});

describe('assignee shortcuts', () => {
  it('parses the NICKNAMES var, skipping a malformed entry', () => {
    expect([...nicknames({ NICKNAMES: 'Nic=@nicholaswan, yx = @Dodgerblueee, junk, =x' })])
      .toEqual([['nic', '@nicholaswan'], ['yx', '@Dodgerblueee']]);
    expect(nicknames({}).size).toBe(0);
  });

  it('assigns a chore typed with a shortcut, privately', async () => {
    await say(5, '/chore yx cat fountain 7pm');
    expect(sql.prepare('SELECT text, assignee_name FROM reminders').get())
      .toMatchObject({ text: 'cat fountain', assignee_name: '@Dodgerblueee' });
    // An assigned chore is confirmed to the creator only; the board edit is
    // the one other send, and it goes to the pinned message, not the group.
    const sends = calls.filter((c) => c.url.endsWith('/sendMessage'));
    expect(sends.length).toBe(1);
    expect(sends[0].body.receiver_user_id).toBe(2);
    expect(sends[0].body.text).toContain('for @Dodgerblueee');
  });

  it('lists the shortcuts in the scheduling help', async () => {
    await say(5, '/help schedule');
    const help = calls.find((c) => c.url.endsWith('/sendMessage'));
    expect(help.body.text).toContain('<code>nic</code>, <code>yx</code>');
  });
});
