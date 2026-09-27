import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { d1 } from './d1.js';
import worker from '../src/index.js';
import { handleUpdate } from '../src/handlers.js';
import { completeEarly, createReminder, restoreReminder, undoCompletion } from '../src/chores.js';
import { sendDigests, renagPending } from '../src/cron.js';
import { enqueueUpdate, recoverUpdates } from '../src/updates.js';
import { parseRemind } from '../src/parse.js';

const HOUR = 3600000, NOW = Date.UTC(2026, 8, 5, 6), TZ = 'Asia/Singapore';
const alice = { id: 2, username: 'alice', first_name: 'Alice' };
let sql, env, calls, beforeQuery, beforeSend;
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  sql.exec('INSERT INTO settings (chat_id, dashboard_msg_id) VALUES (-1001, 50)');
  beforeQuery = () => {}; beforeSend = async () => {};
  env = { BOT_TOKEN: 'fake', WEBHOOK_SECRET: 'fake-secret', ALLOWED_CHATS: '-1001',
    DB: d1(sql, (q, args) => beforeQuery(q, args)) };
  calls = [];
  let messageId = 1000;
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    const method = String(url).split('/').at(-1), body = JSON.parse(init.body);
    const id = ++messageId;
    calls.push({ method, body, id });
    await beforeSend(method, body);
    let result = true;
    if (method === 'getMe') result = { id: 999, username: 'test_bot' };
    else if (method === 'getStickerSet') result = { stickers: [] };
    else if (method === 'sendMessage') result = body.receiver_user_id
      ? { message_id: 0, ephemeral_message_id: id } : { message_id: id };
    return Response.json({ ok: true, result });
  }));
});
afterEach(() => { sql.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const seed = (table, row) => {
  const keys = Object.keys(row);
  sql.prepare(`INSERT INTO ${table} (${keys}) VALUES (${keys.map(() => '?')})`).run(...Object.values(row));
};
const reminder = (extra = {}) => seed('reminders', {
  id: 10, chat_id: -1001, display_num: 1, text: 'dishes', schedule_kind: 'daily',
  schedule_detail: '{"h":21,"mi":0}', nag_intervals: '[15,30,60]', next_fire_at: Date.now() + 7 * HOUR,
  paused: 0, created_at: Date.now() - HOUR, scored: 1, ...extra,
});
const firing = (extra = {}) => seed('firings', {
  id: 5, reminder_id: 10, chat_id: -1001, reminder_text: 'dishes', fired_at: Date.now() - HOUR,
  state: 'nagging', nag_count: 0, next_nag_at: Date.now() + 900000, last_message_id: 700, scored: 1, ...extra,
});
const r = () => sql.prepare('SELECT * FROM reminders WHERE id = 10').get();
const f = () => sql.prepare('SELECT * FROM firings WHERE id = 5').get();
const count = (table) => sql.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
const say = (text) => handleUpdate(env, { message: { message_id: 100, chat: { id: -1001 }, from: alice, text, entities: [] } });
const tap = (data) => handleUpdate(env, { callback_query: { id: 'cb', data, from: alice,
  message: { chat: { id: -1001 }, message_id: 700, text: 'card' } } });
const sends = (prefix) => calls.filter((c) => c.method === 'sendMessage' && c.body.text.startsWith(prefix));

describe('atomic early completion', () => {
  for (const kind of ['once', 'daily']) {
    for (const fail of [/DELETE FROM reminders|UPDATE reminders SET next_fire_at/, /INSERT INTO firings/, /INSERT INTO trash/]) {
      it(`rolls back ${kind} when ${fail} fails`, async () => {
        reminder({ schedule_kind: kind });
        const before = r();
        beforeQuery = (q) => { if (fail.test(q)) throw new Error('D1 failure'); };
        await expect(completeEarly(env, before, '@alice', TZ)).rejects.toThrow('D1 failure');
        expect(r()).toEqual(before);
        expect(count('firings')).toBe(0);
        expect(count('trash')).toBe(0);
        beforeQuery = () => {};
        const id = await completeEarly(env, r(), '@alice', TZ);
        expect(id).toBeTruthy();
        expect(JSON.parse(sql.prepare('SELECT payload FROM trash').get().payload)._firing).toBe(id);
      });
    }
  }
  it('allows only one completion and undo snapshot for the same slot', async () => {
    reminder(); const before = r();
    await Promise.all([completeEarly(env, before, '@alice', TZ), completeEarly(env, before, '@bob', TZ)]);
    expect(count('firings')).toBe(1);
    expect(count('trash')).toBe(1);
  });
});

describe('dates survive the wizard', () => {
  it.each([
    ['buy milk tomorrow', '7pm', 'buy milk tomorrow 7pm', 'buy milk'],
    ['bedsheets every other saturday', '8am', 'bedsheets every other saturday 8am', 'bedsheets'],
    ['plants daily starting monday', '9am', 'plants daily starting monday 9am', 'plants'],
    ['call mom friday', '10am', 'call mom friday 10am', 'call mom'],
    ['trash daily tmr', '7pm', 'trash daily tmr 7pm', 'trash'],
  ])('%s + %s matches the complete command', async (command, time, whole, title) => {
    await say(`/chore ${command}`); await say(time);
    const made = sql.prepare('SELECT * FROM reminders').get();
    const expected = parseRemind(whole, whole, [], NOW, TZ);
    expect(made.next_fire_at).toBe(expected.firstFireAt);
    expect(made.text).toBe(title);
    expect(JSON.parse(made.schedule_detail)).toEqual(expected.detail);
  });
  it.each(['bedsheets every other saturday', 'buy milk tomorrow', 'call mom friday'])
   ('preserves %s with an hour button too', async (command) => {
      await say(`/chore ${command}`);
      const draft = sql.prepare('SELECT id FROM drafts').get();
      await tap(`w:${draft.id}:h8`);
      expect(sql.prepare('SELECT next_fire_at FROM reminders').get().next_fire_at)
        .toBe(parseRemind(`${command} 8am`, '', [], NOW, TZ).firstFireAt);
    });
  it('rejects a passed explicit date without consuming the draft', async () => {
    await say('/chore buy milk today'); await say('8am');
    expect(count('reminders')).toBe(0); expect(count('drafts')).toBe(1);
    expect(sends('😿').at(-1).body.text).toContain('passed');
  });
  it('resolves tomorrow relative to the original command day', async () => {
    await say('/chore buy milk tomorrow');
    Date.now.mockReturnValue(NOW + 20 * HOUR);
    const draft = sql.prepare('SELECT * FROM drafts').get();
    await handleUpdate(env, { message: { message_id: 101, chat: { id: -1001 }, from: alice,
      text: '7pm', reply_to_message: { message_id: 0, ephemeral_message_id: draft.wizard_msg_id } } });
    expect(sql.prepare('SELECT next_fire_at FROM reminders').get().next_fire_at).toBe(NOW + 29 * HOUR);
  });
});

describe('active assignment', () => {
  const setup = (extra = {}) => {
    reminder({ assignee_name: '@alice', assignee_user_id: 2, ...extra });
    firing({ nag_user_id: 2, last_message_ephemeral: 1, snoozes_used: 1,
      snoozed_until: NOW + 2 * HOUR, next_nag_at: NOW + 2 * HOUR });
    seed('members', { chat_id: -1001, user_id: 3, username: 'bob', first_name: 'Bob', last_seen: NOW });
  };
  it('moves a snoozed card and later re-nags to its new assignee', async () => {
    setup(); await tap('e:setassign:10:3');
    expect(r().assignee_user_id).toBe(3);
    expect(f()).toMatchObject({ nag_user_id: 3, next_nag_at: NOW + 2 * HOUR, snoozes_used: 1 });
    expect(sends('😴').at(-1).body.receiver_user_id).toBe(3);
    expect(calls.some((c) => c.method === 'deleteEphemeralMessage' && c.body.receiver_user_id === 2)).toBe(true);
    Date.now.mockReturnValue(NOW + 2 * HOUR); await renagPending(env, Date.now());
    expect(sends('🐱').at(-1).body.receiver_user_id).toBe(3);
  });
  it('makes the replacement public when assignment is cleared', async () => {
    setup(); await tap('e:setassign:10:0');
    expect(f().nag_user_id).toBeNull();
    expect(sends('😴').at(-1).body.receiver_user_id).toBeUndefined();
  });
  it('keeps the replacement paused', async () => {
    setup({ paused: 1 }); await tap('e:setassign:10:3');
    expect(sends('⏸️').at(-1).body.reply_markup.inline_keyboard).toEqual([]);
  });
  it('discards a cron send addressed to the old recipient during reassignment', async () => {
    setup(); sql.prepare('UPDATE firings SET next_nag_at = ? WHERE id = 5').run(NOW);
    let changed = false;
    beforeSend = async (method, body) => {
      if (!changed && method === 'sendMessage' && body.text.startsWith('🐱')) {
        changed = true; await tap('e:setassign:10:3');
      }
    };
    await renagPending(env, NOW);
    const old = sends('🐱').find((c) => c.body.receiver_user_id === 2);
    const current = sends('🐱').find((c) => c.body.receiver_user_id === 3);
    expect(f().last_message_id).toBe(current.id);
    expect(calls.some((c) => c.method === 'deleteEphemeralMessage' && c.body.ephemeral_message_id === old.id)).toBe(true);
  });
});

describe('undo and digest guards', () => {
  it('restores an ordinary unelapsed snooze after Done is taken back', async () => {
    reminder(); firing({ snoozed_until: NOW + 2 * HOUR, next_nag_at: NOW + 2 * HOUR, snoozes_used: 1 });
    await tap('d:5'); await tap('nd:5');
    expect(f().next_nag_at).toBe(NOW + 2 * HOUR);
    expect(calls.some((c) => c.method === 'editMessageText' && c.body.text.startsWith('😴'))).toBe(true);
  });
  it('does not resurrect a snooze already replaced by the cron', async () => {
    reminder(); firing({ snoozed_until: NOW + HOUR, next_nag_at: NOW + 2 * HOUR });
    await tap('d:5'); await tap('nd:5');
    expect(f().next_nag_at).toBe(NOW + 900000);
  });
  it('rejects normal undo when a newer occurrence wins immediately before its claim', async () => {
    reminder(); firing({ state: 'done', done_at: NOW - 1000, done_by: '@alice', next_nag_at: null });
    const old = f();
    beforeQuery = (q) => {
      if (q.includes("UPDATE firings SET state = 'nagging'")) {
        beforeQuery = () => {}; firing({ id: 6, last_message_id: 701 });
      }
    };
    expect(await undoCompletion(env, old, '@alice', TZ)).toEqual({ ok: false, why: 'late' });
    expect(f().state).toBe('done');
    expect(sql.prepare("SELECT COUNT(*) n FROM firings WHERE state = 'nagging'").get().n).toBe(1);
  });
  it('excludes paused chores but includes overdue previously snoozed one-offs', async () => {
    Date.now.mockReturnValue(Date.UTC(2026, 8, 5, 0));
    reminder({ paused: 1 }); firing();
    reminder({ id: 11, display_num: 2, text: 'milk', schedule_kind: 'once', next_fire_at: null });
    firing({ id: 6, reminder_id: 11, fired_at: Date.now() - 30 * HOUR,
      next_nag_at: null, snoozed_until: Date.now() - 29 * HOUR });
    await sendDigests(env, Date.now());
    const digest = sends('☀️')[0].body;
    expect(digest.text).toContain('milk'); expect(digest.text).not.toContain('dishes');
    expect(digest.reply_markup.inline_keyboard.flat().map((b) => b.callback_data)).toEqual(['dg:6', 'ok']);
  });
});

describe('unique chore numbers', () => {
  it('allocates distinct numbers for concurrent additions and fills gaps', async () => {
    reminder({ display_num: 2 });
    const p = parseRemind('laundry 9pm', '', [], NOW, TZ);
    await Promise.all([createReminder(env, -1001, p, '@alice', TZ), createReminder(env, -1001, p, '@bob', TZ)]);
    expect(sql.prepare('SELECT display_num n FROM reminders ORDER BY display_num').all().map((x) => x.n)).toEqual([1, 2, 3]);
  });
  it('allocates safely when two restores request the same old number', async () => {
    reminder(); const before = r(); sql.exec('DELETE FROM reminders');
    await Promise.all([restoreReminder(env, before), restoreReminder(env, { ...before, id: 11 })]);
    expect(sql.prepare('SELECT display_num n FROM reminders ORDER BY display_num').all().map((x) => x.n)).toEqual([1, 2]);
  });
  it('migrates duplicate legacy numbers without changing the first owner', () => {
    sql.exec('DROP INDEX idx_reminders_chat_number');
    reminder(); reminder({ id: 11 }); reminder({ id: 12, display_num: 2 }); reminder({ id: 13, display_num: 2 });
    const migration = readFileSync(new URL('../migrations/0001_adversarial_review.sql', import.meta.url), 'utf8');
    sql.exec(migration); sql.exec(migration);
    expect(sql.prepare('SELECT display_num n FROM reminders ORDER BY id').all().map((x) => x.n)).toEqual([1, 3, 2, 4]);
    expect(() => reminder({ id: 14 })).toThrow(/UNIQUE/);
  });
});

describe('durable webhook deduplication', () => {
  const update = () => ({ update_id: 42, message: { message_id: 100, chat: { id: -1001 },
    from: alice, text: '/chore dishes 9pm', entities: [] } });
  const deliver = async (value = update()) => {
    const tasks = [];
    const response = await worker.fetch(new Request('https://example.test/webhook', {
      method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'fake-secret' }, body: JSON.stringify(value),
    }), env, { waitUntil: (task) => tasks.push(task) });
    await Promise.all(tasks); return response;
  };
  it('processes concurrent and repeated copies of one update only once', async () => {
    await Promise.all([deliver(), deliver()]); await deliver();
    expect(count('reminders')).toBe(1);
    expect(sql.prepare('SELECT state FROM webhook_updates').get().state).toBe('done');
  });
  it('answers a repeated button tap without applying it twice', async () => {
    reminder(); firing();
    const cb = { update_id: 43, callback_query: { id: 'repeated', data: 'z:5:60', from: alice,
      message: { chat: { id: -1001 }, message_id: 700, text: 'nag' } } };
    await deliver(cb);
    const response = await deliver(cb);
    expect((await response.json()).text).toBe('Already received 👍');
    expect(f().snoozes_used).toBe(1);
  });
  it('returns 503 without mutation when persistence is unavailable', async () => {
    beforeQuery = () => { throw new Error('D1 down'); };
    expect((await deliver()).status).toBe(503); expect(count('reminders')).toBe(0);
    beforeQuery = () => {}; expect((await deliver()).status).toBe(200); expect(count('reminders')).toBe(1);
  });
  it('recovers a persisted delivery that never started', async () => {
    await enqueueUpdate(env, update()); Date.now.mockReturnValue(NOW + 60000);
    await recoverUpdates(env, Date.now()); await recoverUpdates(env, Date.now()); await deliver();
    expect(count('reminders')).toBe(1);
  });
  it('reports an interrupted handler without replaying partial mutations', async () => {
    await enqueueUpdate(env, update());
    sql.prepare("UPDATE webhook_updates SET state = 'processing', started_at = ?").run(NOW - HOUR);
    reminder(); await recoverUpdates(env, NOW); await recoverUpdates(env, NOW); await deliver();
    expect(count('reminders')).toBe(1); expect(sends('⚠️')).toHaveLength(1);
    expect(sql.prepare('SELECT state FROM webhook_updates').get().state).toBe('failed');
  });
  it('rejects updates without a stable delivery identifier', async () => {
    expect((await deliver({ message: update().message })).status).toBe(400);
    expect(count('reminders')).toBe(0);
  });
  it('does not store traffic from an unapproved group', async () => {
    const stranger = update(); stranger.message.chat.id = -999;
    expect((await deliver(stranger)).status).toBe(200);
    expect(count('webhook_updates')).toBe(0);
    expect(count('members')).toBe(0);
  });
  it('still logs the rejected group, so a supergroup upgrade shows its new chat id', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const upgraded = update(); upgraded.message.chat = { id: -1009999, type: 'supergroup', title: 'Home' };
    await deliver(upgraded);
    expect(log.mock.calls.flat().some((line) => String(line).includes('rejected chat -1009999 (supergroup) "Home"'))).toBe(true);
  });
});
