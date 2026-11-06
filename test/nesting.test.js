// Nested chores (6 Nov 2026): wash neakasa > clear poop > shake neakasa.
// Doing a parent, on time or early, resets every chore under it; ↩️ Not done
// on the parent puts them back. Real SQLite behind the D1 shim.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { handleUpdate } from '../src/handlers.js';
import { setParent, parentChoices } from '../src/nesting.js';
import { d1 } from './d1.js';

const HOUR = 3600000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 6, 14, 30); // Fri 6 Nov 22:30 Asia/Singapore
const at9pm = (daysFromNow) => Date.UTC(2026, 10, 6 + daysFromNow, 13); // 21:00 SGT

let sql, env, calls;
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  sql.exec('INSERT INTO settings (chat_id, dashboard_msg_id) VALUES (1, 99)');
  sql.exec(`INSERT INTO members (chat_id, user_id, username, first_name, last_seen) VALUES
    (1, 2, 'nicholaswan', 'Nick', 0), (1, 3, 'Dodgerblueee', 'Yx', 0)`);
  const add = sql.prepare(`INSERT INTO reminders (id, chat_id, display_num, text, schedule_kind, schedule_detail,
    nag_intervals, next_fire_at, paused, created_at, scored, parent_id) VALUES (?, 1, ?, ?, 'interval', ?, '[15,30,60]', ?, 0, 0, 1, ?)`);
  add.run(43, 8, 'wash neakasa', '{"days":42,"h":21,"mi":0}', at9pm(15), null);
  add.run(5, 1, 'clear poop', '{"days":8,"h":21,"mi":0}', at9pm(3), 43);
  add.run(60, 14, 'shake neakasa', '{"days":4,"h":21,"mi":0}', at9pm(1), 5);
  add.run(8, 3, 'cat fountain', '{"days":7,"h":19,"mi":0}', at9pm(1), null);
  env = { BOT_TOKEN: 'test', ALLOWED_CHATS: '1', DB: d1(sql) };
  calls = [];
  let mid = 100;
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: ++mid } }));
  }));
});
afterEach(() => { sql.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const nick = { id: 2, first_name: 'Nick', username: 'nicholaswan' };
const tap = (data, messageId = 99) => handleUpdate(env, { callback_query: {
  id: 'tap', data, from: nick, message: { chat: { id: 1 }, message_id: messageId, text: 'x' },
} });
const next = (id) => sql.prepare('SELECT next_fire_at FROM reminders WHERE id = ?').get(id).next_fire_at;
const sent = () => calls.filter((c) => /\/(sendMessage|editMessageText)$/.test(c.url)).map((c) => c.body.text);
const liveNag = (reminderId, fired = NOW - HOUR) => sql.prepare(
  `INSERT INTO firings (reminder_id, chat_id, reminder_text, fired_at, next_nag_at, last_message_id)
   VALUES (?, 1, (SELECT text FROM reminders WHERE id = ?), ?, ?, 555)`
).run(reminderId, reminderId, fired, NOW + 15 * 60000).lastInsertRowid;

it('done early on the top tier restarts both tiers under it from today', async () => {
  await tap('m:done:43');
  expect(next(5)).toBe(at9pm(8));
  expect(next(60)).toBe(at9pm(4));
  expect(next(8)).toBe(at9pm(1)); // not nested, untouched
  // Covered, not completed: one done row, the wash's.
  expect(sql.prepare("SELECT reminder_id FROM firings WHERE state = 'done'").all().map((r) => r.reminder_id))
    .toEqual([43]);
  expect(sent().some((t) => /done early.*\n.*Resets too: clear poop, shake neakasa/s.test(t))).toBe(true);
});

it('a middle tier resets only what is under it', async () => {
  await tap('m:done:5');
  expect(next(60)).toBe(at9pm(4));
  expect(next(43)).toBe(at9pm(15));
});

it('a live nag on a child is taken down when the parent is done', async () => {
  const poop = liveNag(5);
  const wash = liveNag(43);
  await tap(`d:${wash}`, 555);
  expect(sql.prepare('SELECT * FROM firings WHERE id = ?').get(poop)).toBeUndefined();
  expect(calls.some((c) => c.url.endsWith('/deleteMessage') && c.body.message_id === 555)).toBe(true);
  expect(next(5)).toBe(at9pm(8));
  expect(sent().some((t) => /Done by @nicholaswan.*Resets too: clear poop, shake neakasa/s.test(t))).toBe(true);
});

it('Not done on the parent puts the children back, nag included', async () => {
  const poop = liveNag(5);
  const wash = liveNag(43);
  const poopNext = next(5);
  const shakeNext = next(60);
  await tap(`d:${wash}`, 555);
  calls = [];
  await tap(`nd:${wash}`, 555);
  expect(next(5)).toBe(poopNext);
  expect(next(60)).toBe(shakeNext);
  const back = sql.prepare('SELECT * FROM firings WHERE id = ?').get(poop);
  expect(back.state).toBe('nagging');
  expect(back.last_message_id).not.toBeNull();
  expect(sent().some((t) => /clear poop/.test(t))).toBe(true);
  expect(sql.prepare("SELECT COUNT(*) AS n FROM trash WHERE json_extract(payload, '$._cover') IS NOT NULL").get().n)
    .toBe(0);
});

it('Not done on a done early puts the children back', async () => {
  await tap('m:done:43');
  const early = sql.prepare("SELECT id FROM firings WHERE state = 'done'").get().id;
  await tap(`ne:${early}`);
  expect(next(5)).toBe(at9pm(3));
  expect(next(60)).toBe(at9pm(1));
});

it('never pulls a child earlier than a slot it was already moved to', async () => {
  sql.prepare('UPDATE reminders SET next_fire_at = ? WHERE id = 60').run(at9pm(10));
  await tap('m:done:5');
  expect(next(60)).toBe(at9pm(10));
});

it('leaves a paused child alone', async () => {
  sql.exec('UPDATE reminders SET paused = 1 WHERE id = 5');
  await tap('m:done:43');
  expect(next(5)).toBe(at9pm(3));
  expect(next(60)).toBe(at9pm(4)); // the grandchild is still covered
});

it('refuses a loop and a one-off child', async () => {
  const wash = sql.prepare('SELECT * FROM reminders WHERE id = 43').get();
  expect((await parentChoices(env, wash)).map((c) => c.id)).toEqual([8]);
  expect(await setParent(env, wash, '60')).toMatch(/cannot sit under/);
  sql.exec(`INSERT INTO reminders (id, chat_id, display_num, text, schedule_kind, schedule_detail, nag_intervals,
    next_fire_at, created_at) VALUES (70, 1, 20, 'vet', 'once', '{"h":9,"mi":0}', '[60]', ${at9pm(2)}, 0)`);
  const vet = sql.prepare('SELECT * FROM reminders WHERE id = 70').get();
  expect(await setParent(env, vet, '43')).toMatch(/one-off/);
  expect(await setParent(env, wash, '8')).toBeNull();
  expect(await setParent(env, wash, '0')).toBeNull();
  expect(sql.prepare('SELECT parent_id FROM reminders WHERE id = 43').get().parent_id).toBeNull();
});

it('a restored nag gets back the hours it was hidden', async () => {
  const poop = liveNag(5, NOW - 20 * HOUR);
  const wash = liveNag(43);
  await tap(`d:${wash}`, 555);
  Date.now.mockReturnValue(NOW + 6 * HOUR);
  await tap(`nd:${wash}`, 555);
  expect(sql.prepare('SELECT fired_at FROM firings WHERE id = ?').get(poop).fired_at).toBe(NOW - 14 * HOUR);
});

it('a child paused since gets its nag back without a card', async () => {
  const poop = liveNag(5);
  const wash = liveNag(43);
  await tap(`d:${wash}`, 555);
  sql.exec('UPDATE reminders SET paused = 1 WHERE id = 5');
  calls = [];
  await tap(`nd:${wash}`, 555);
  const back = sql.prepare('SELECT * FROM firings WHERE id = ?').get(poop);
  expect(back.state).toBe('nagging');
  expect(back.last_message_id).toBeNull();
  // The pinned board lists it as paused; no nag card for it goes out.
  expect(sent().some((t) => /clear poop/.test(t) && !t.startsWith('🐾 <b>Chores'))).toBe(false);
});

it('does not put a nag back over a newer one', async () => {
  const poop = liveNag(5);
  const wash = liveNag(43);
  await tap(`d:${wash}`, 555);
  const fresh = liveNag(5, NOW);
  await tap(`nd:${wash}`, 555);
  expect(sql.prepare('SELECT * FROM firings WHERE id = ?').get(poop)).toBeUndefined();
  expect(sql.prepare("SELECT id FROM firings WHERE reminder_id = 5 AND state = 'nagging'").all().map((r) => r.id))
    .toEqual([Number(fresh)]);
});

it('a one-off is never offered as a parent, and a reset record is no Undo', async () => {
  sql.exec(`INSERT INTO reminders (id, chat_id, display_num, text, schedule_kind, schedule_detail, nag_intervals,
    next_fire_at, created_at) VALUES (70, 1, 20, 'vet', 'once', '{"h":9,"mi":0}', '[60]', ${at9pm(2)}, 0)`);
  const poop = sql.prepare('SELECT * FROM reminders WHERE id = 5').get();
  expect((await parentChoices(env, poop)).map((c) => c.id)).not.toContain(70);
  await tap('m:done:43');
  const cover = sql.prepare("SELECT id FROM trash WHERE json_extract(payload, '$._cover') IS NOT NULL").get();
  await tap(`t:${cover.id}`);
  expect(sql.prepare('SELECT COUNT(*) AS n FROM trash WHERE id = ?').get(cover.id).n).toBe(1);
});

it('a failing reset never blocks the parent Done', async () => {
  const wash = liveNag(43);
  const real = env.DB;
  env.DB = { ...real, prepare: (q) => {
    if (/parent_id = \?/.test(q)) throw new Error('no such column: parent_id');
    return real.prepare(q);
  } };
  await tap(`d:${wash}`, 555);
  expect(sql.prepare('SELECT state FROM firings WHERE id = ?').get(wash).state).toBe('done');
  expect(sent().some((t) => /Done by @nicholaswan/.test(t))).toBe(true);
});

it('a deleted and restored child keeps its place', async () => {
  const shake = sql.prepare('SELECT * FROM reminders WHERE id = 60').get();
  const { removeReminder, restoreReminder } = await import('../src/chores.js');
  await removeReminder(env, shake);
  await restoreReminder(env, shake);
  expect(sql.prepare('SELECT parent_id FROM reminders WHERE id = 60').get().parent_id).toBe(5);
});
