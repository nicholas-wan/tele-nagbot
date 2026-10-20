// 📅 1 week and 📅 2 weeks on the snooze menu (10 Oct 2026): postponements
// like 📅 Tomorrow, which carry fired_at forward; on a recurring chore they
// also move the schedule past the postponed nag, since the occurrence they
// cross would otherwise supersede it. The board shows a parked chore by when
// it comes back, not as nagging. Real SQLite behind the D1 shim.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { handleUpdate } from '../src/handlers.js';
import { choreListHtml } from '../src/dashboard.js';
import { renagPending } from '../src/cron.js';
import { d1 } from './d1.js';

const TZ = 'Asia/Singapore';
const HOUR = 3600000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 10, 11, 30); // Sat 10 Oct 19:30 Asia/Singapore
const TUE_7PM = Date.UTC(2026, 9, 13, 11); // the chore's next slot, Tue 13 Oct 19:00

let sql, env, calls;
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  sql.exec('INSERT INTO settings (chat_id, dashboard_msg_id) VALUES (1, 99)');
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
  id: 'tap', data, from: nick, message: { chat: { id: 1 }, message_id: 700, text: '🐱 cat fountain' },
} });
const toast = () => calls.filter((c) => c.url.endsWith('/answerCallbackQuery')).at(-1).body.text;
const firing = () => sql.prepare('SELECT * FROM firings WHERE id = 5').get();
const reminder = () => sql.prepare('SELECT * FROM reminders WHERE id = 8').get();
const seed = (table, row) => {
  const keys = Object.keys(row);
  sql.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...keys.map((k) => row[k]));
};
const seedChore = (cols = {}) => seed('reminders', {
  id: 8, chat_id: 1, display_num: 1, text: 'cat fountain', schedule_kind: 'interval',
  schedule_detail: '{"days":7,"h":19,"mi":0}', nag_intervals: '[15,30,60]', next_fire_at: TUE_7PM,
  paused: 0, created_at: NOW - 30 * DAY, scored: 1, ...cols,
});
const seedNag = (cols = {}) => seed('firings', {
  id: 5, reminder_id: 8, chat_id: 1, reminder_text: 'cat fountain', fired_at: NOW - HOUR, state: 'nagging',
  nag_count: 1, next_nag_at: NOW + 15 * 60000, last_message_id: 700, scored: 1, ...cols,
});

describe('📅 1 week / 📅 2 weeks', () => {
  it('are on the snooze menu', async () => {
    seedChore(); seedNag();
    await tap('s:5');
    const menu = calls.find((c) => c.url.endsWith('/editMessageReplyMarkup'));
    const row = menu.body.reply_markup.inline_keyboard.find((r) => r.some((b) => b.callback_data === 'z:5:w1'));
    expect(row.map((b) => [b.text, b.callback_data])).toEqual([['📅 1 week', 'z:5:w1'], ['📅 2 weeks', 'z:5:w2']]);
  });

  it('postpone a one-off by a week, expiry window and all', async () => {
    seedChore({ schedule_kind: 'once', schedule_detail: '{}', next_fire_at: null });
    seedNag();
    await tap('z:5:w1');
    expect(firing()).toMatchObject({
      fired_at: NOW + 7 * DAY, next_nag_at: NOW + 7 * DAY, snoozed_until: NOW + 7 * DAY,
      snoozed_by: '@nicholaswan', snoozes_used: 1,
    });
    expect(toast()).toBe('Postponed to Oct 17, 7:30 PM 📅');
    expect(calls.find((c) => c.url.endsWith('/editMessageText') && c.body.message_id === 700).body.text).toMatch(/^😴/);
  });

  it('move a recurring schedule past the postponed nag, skipping what it crosses', async () => {
    seedChore(); seedNag();
    await tap('z:5:w2');
    expect(firing().fired_at).toBe(NOW + 14 * DAY);
    // Due Tue 13 and Tue 20 Oct 19:00 — both before Sat 24 Oct 19:30 — so the
    // next is Tue 27 Oct, still on the chore's own seven-day beat.
    expect(reminder().next_fire_at).toBe(TUE_7PM + 14 * DAY);
    expect(toast()).toBe('Postponed to Oct 24, 7:30 PM 📅 — skipping 2 scheduled times');
  });

  it('leave a schedule alone when the postponed nag returns before it', async () => {
    seedChore({ schedule_detail: '{"days":30,"h":19,"mi":0}', next_fire_at: NOW + 20 * DAY });
    seedNag();
    await tap('z:5:w1');
    expect(reminder().next_fire_at).toBe(NOW + 20 * DAY);
    expect(toast()).toBe('Postponed to Oct 17, 7:30 PM 📅');
  });

  it('wait for 8am when a week from now falls in quiet hours', async () => {
    Date.now.mockReturnValue(NOW + 4 * HOUR); // 23:30
    seedChore({ schedule_kind: 'once', schedule_detail: '{}', next_fire_at: null });
    seedNag({ fired_at: NOW + 3 * HOUR });
    await tap('z:5:w1');
    expect(firing().next_nag_at).toBe(Date.UTC(2026, 9, 18, 0)); // Sun 18 Oct 08:00
  });

  it('count against the snooze cap', async () => {
    seedChore(); seedNag({ snoozes_used: 3 });
    await tap('z:5:w2');
    expect(toast()).toBe('No more snoozes 😈 (max 3)');
    expect(firing().fired_at).toBe(NOW - HOUR);
  });
});

describe('📅 Tomorrow keeps its rule', () => {
  it('does not touch the schedule', async () => {
    seedChore({ schedule_kind: 'daily', schedule_detail: '{"h":19,"mi":0}', next_fire_at: NOW + 23.5 * HOUR });
    seedNag();
    await tap('z:5:day');
    expect(reminder().next_fire_at).toBe(NOW + 23.5 * HOUR);
    expect(firing().fired_at).toBe(NOW + DAY);
  });
});

describe('the board', () => {
  it('shows a parked chore by when it comes back, not as nagging', async () => {
    seedChore(); seedNag();
    await tap('z:5:w1');
    const html = await choreListHtml(env, 1, TZ);
    expect(html).toContain('😴 in 7 days · Oct 17, 7:30 PM');
    expect(html).not.toContain('nagging now');
  });

  it('still shows an ordinary pending re-nag as nagging', async () => {
    seedChore(); seedNag();
    expect(await choreListHtml(env, 1, TZ)).toContain('🔔 nagging since today 6:30 PM');
  });

  // 20 Oct 2026: the board said "nagging now" whether a chore had nagged for
  // ten minutes or two days. It now says when it first fired.
  it('says when a nagging chore first fired, looking back past today', async () => {
    seedChore(); seedNag({ fired_at: NOW - 20 * HOUR });
    expect(await choreListHtml(env, 1, TZ)).toContain('🔔 nagging since yesterday 11:30 PM');
  });
});

// OK on the 😴 card (10 Oct 2026): the card a snooze leaves is still the
// firing's live card, so the sweep spares it, and it had no way to be put away
// — for a two-week postponement, two weeks in the chat.
describe('✅ OK on a snoozed card', () => {
  const tapOn = (data, message_id) => handleUpdate(env, { callback_query: {
    id: 'tap', data, from: nick, message: { chat: { id: 1 }, message_id, text: '😴 cat fountain' },
  } });
  const deletedMsg = (id) => calls.some((c) => c.url.endsWith('/deleteMessage') && c.body.message_id === id);

  it('is on the card a snooze draws', async () => {
    seedChore(); seedNag();
    await tap('z:5:w1');
    const card = calls.find((c) => c.url.endsWith('/editMessageText') && c.body.message_id === 700);
    expect(card.body.reply_markup.inline_keyboard.flat().map((b) => b.callback_data)).toContain('zh:5');
  });

  it('puts the card away and leaves the chore parked', async () => {
    seedChore(); seedNag();
    await tap('z:5:w1');
    await tapOn('zh:5', 700);
    expect(deletedMsg(700)).toBe(true);
    expect(firing()).toMatchObject({ state: 'nagging', last_message_id: null, next_nag_at: NOW + 7 * DAY });
    expect(toast()).toBe('Hidden — back Oct 17, 7:30 PM 😴');
  });

  it('gets a fresh nag when the snooze is up', async () => {
    seedChore(); seedNag();
    await tap('z:5:30');
    await tapOn('zh:5', 700);
    calls.length = 0;
    await renagPending(env, NOW + 31 * 60000);
    expect(calls.some((c) => c.url.endsWith('/sendMessage') && /^🐱 <b>cat fountain/.test(c.body.text))).toBe(true);
    expect(firing().last_message_id).toBe(99);
  });

  it('still leaves a receipt when the hidden chore is finished from the board', async () => {
    seedChore(); seedNag();
    await tap('z:5:w1');
    await tapOn('zh:5', 700);
    calls.length = 0;
    await tapOn('m:done:8', 99);
    expect(firing().state).toBe('done');
    expect(calls.some((c) => c.url.endsWith('/sendMessage') && /done by @nicholaswan/.test(c.body.text))).toBe(true);
  });

  it('just removes an old card the firing has moved on from', async () => {
    seedChore(); seedNag({ snoozed_until: NOW + HOUR, next_nag_at: NOW + HOUR });
    await tapOn('zh:5', 650);
    expect(deletedMsg(650)).toBe(true);
    expect(firing().last_message_id).toBe(700);
  });

  it('refuses on a card whose snooze is already spent', async () => {
    seedChore(); seedNag();
    await tapOn('zh:5', 700);
    expect(toast()).toBe('Not snoozed any more — Done or snooze it again');
    expect(deletedMsg(700)).toBe(false);
    expect(firing().last_message_id).toBe(700);
  });
});
