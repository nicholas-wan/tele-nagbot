// The chat polish pass of 8 Nov 2026: how the household's real phrasings
// parse, and what the chat says back. Real SQLite behind the D1 shim, so the
// flows run end to end the way a webhook drives them.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { handleUpdate, typedSnooze } from '../src/handlers.js';
import { parseRemind, ParseError, NoTimeError, refusalHtml } from '../src/parse.js';
import { cadence, describeSchedule } from '../src/dashboard.js';
import { nicknames } from '../src/household.js';
import { d1 } from './d1.js';

const TZ = 'Asia/Singapore';
const HOUR = 3600000;
// Tuesday 10 Nov 2026, 10:00 in Singapore.
const NOW = Date.UTC(2026, 10, 10, 2);
const NICKS = nicknames({ NICKNAMES: 'nic=@anne, yx=@zack' });
const parse = (text) => parseRemind(text, `/chore ${text}`, [], NOW, TZ, NICKS);
const local = (ms) => new Date(ms + 8 * HOUR).toISOString().slice(0, 16);

describe('the parser reads chores the way people type them', () => {
  it.each([
    ['bins every tue and fri 8pm', [2, 5]],
    ['bins every tue & fri 8pm', [2, 5]],
    ['bins every mon, wed and fri 8pm', [1, 3, 5]],
    ['bins tue/fri 8pm', [2, 5]],
    ['bins mon wed fri 8pm', [1, 3, 5]],
    ['bins tue and fri 8pm', [2, 5]],
    ['bins on tuesdays 8pm', [2]],
    ['bins every tuesday and friday at 8pm', [2, 5]],
  ])('%s is a weekly chore on those days', (text, days) => {
    const p = parse(text);
    expect(p).toMatchObject({ text: 'bins', kind: 'weekly', detail: { days, h: 20, mi: 0 } });
  });

  it.each([
    ['bins weekly on mon and thu 8pm', [1, 4]],
    ['bins every week on tue and fri 8pm', [2, 5]],
  ])('%s: a cadence word beside two days is those days', (text, days) => {
    expect(parse(text)).toMatchObject({ text: 'bins', kind: 'weekly', detail: { days } });
  });

  it('refuses two days on a fortnightly chore, and a weekday of the month', () => {
    expect(() => parse('bins every 2 weeks on mon and thu 8pm')).toThrow(/one day — add the Thu one/);
    expect(() => parse('every other tue and fri 8pm bins')).toThrow(/one day — add the Fri one/);
    expect(() => parse('dentist every 2nd tuesday 3pm')).toThrow(/every 2nd tuesday/);
  });

  it('keeps days inside the text a one-off, and its other words its own', () => {
    expect(parse('pack for mon and tue trip 9pm')).toMatchObject({ text: 'pack for mon and tue trip', kind: 'once' });
    expect(parse('to do list review 9pm').text).toBe('to do list review');
    expect(parse('pay 3 bills in two parts 9pm').text).toBe('pay 3 bills in two parts');
    expect(parse('buy gift for nic and yx 7pm')).toMatchObject({ text: 'buy gift for nic and yx', assigneeName: null });
    expect(parse('nic and yx clean house 9pm')).toMatchObject({ text: 'clean house', assigneeName: null });
  });

  it('keeps a lone weekday a one-off', () => {
    expect(parse('vacuum sat 10am')).toMatchObject({ text: 'vacuum', kind: 'once' });
    expect(parse('buy sun hat 5pm')).toMatchObject({ text: 'buy sun hat', kind: 'once' });
  });

  it('drops "remind … to" around a shortcut', () => {
    expect(parse('remind yx to feed cats tmr 7am')).toMatchObject({ text: 'feed cats', assigneeName: '@zack' });
    expect(parseRemind('to pay tax friday 9am', '/remind to pay tax friday 9am', [], NOW, TZ))
      .toMatchObject({ text: 'pay tax' });
    expect(parseRemind('me to buy milk 5pm', '/remind me to buy milk 5pm', [], NOW, TZ))
      .toMatchObject({ text: 'buy milk' });
    // Only the wrapper goes: a chore about reminding someone keeps its words.
    expect(parse('remind landlord about the leak 5pm')).toMatchObject({ text: 'remind landlord about the leak' });
  });

  it.each(['tmrw', 'tomorow', 'tommorow', '2moro'])('reads "%s" as tomorrow', (word) => {
    const p = parse(`feed cats ${word} 7am`);
    expect(p.text).toBe('feed cats');
    expect(local(p.firstFireAt)).toBe('2026-11-11T07:00');
  });

  it('reads the common cadence words', () => {
    expect(parse('feed cats each day 7pm')).toMatchObject({ text: 'feed cats', kind: 'daily' });
    expect(parse('feed cats nightly')).toMatchObject({ text: 'feed cats', kind: 'daily', detail: { h: 21 } });
    expect(parse('clean fridge weekly 10am')).toMatchObject({ text: 'clean fridge', kind: 'interval', detail: { days: 7 } });
    expect(parse('clean fridge every week 10am')).toMatchObject({ kind: 'interval', detail: { days: 7 } });
    expect(parse('clean fridge fortnightly 10am')).toMatchObject({ text: 'clean fridge', detail: { days: 14 } });
    expect(parse('clean fridge biweekly 10am')).toMatchObject({ detail: { days: 14 } });
    expect(parse('water plants every three days 9am')).toMatchObject({ text: 'water plants', detail: { days: 3 } });
    expect(parse('pay rent monthly 10am')).toMatchObject({ text: 'pay rent', kind: 'interval', detail: { months: 1 } });
    expect(parse('renew passport yearly 9am')).toMatchObject({ text: 'renew passport', detail: { months: 12 } });
  });

  it('keeps a weekday beside "weekly" as the day it starts on', () => {
    const p = parse('clean fridge weekly sat 10am');
    expect(p).toMatchObject({ text: 'clean fridge', kind: 'interval', detail: { days: 7 } });
    expect(local(p.firstFireAt)).toBe('2026-11-14T10:00');
  });

  it.each([
    'pay rent monthly on the 1st 10am',
    'pay rent every 1st 10am',
    'pay rent 1st of every month 10am',
    'pay rent on the 1st of the month 10am',
  ])('%s is the 1st of each month', (text) => {
    expect(parse(text)).toMatchObject({ text: 'pay rent', kind: 'monthly', detail: { dom: 1, h: 10 } });
  });

  it('reads times written without a colon', () => {
    expect(parse('feed cats 730pm daily')).toMatchObject({ text: 'feed cats', detail: { h: 19, mi: 30 } });
    expect(parse('feed cats at 1930 daily')).toMatchObject({ text: 'feed cats', detail: { h: 19, mi: 30 } });
    expect(parse('feed cats 10pm daily')).toMatchObject({ detail: { h: 22, mi: 0 } });
  });

  it('refuses two times rather than naming the chore after the second', () => {
    expect(() => parse('take meds 8am and 8pm daily')).toThrow(/One time per chore.*8pm/);
  });

  it('reads two shortcuts named together as nobody in particular', () => {
    const p = parse('nic and yx clean house sat 10am');
    expect(p).toMatchObject({ text: 'clean house', assigneeName: null });
    expect(parse('yx clean house sat 10am')).toMatchObject({ assigneeName: '@zack' });
  });

  it('drops the "this" of "this evening"', () => {
    expect(parse('buy milk this evening')).toMatchObject({ text: 'buy milk', detail: { h: 19 } });
  });

  it('keeps the days of a time-less weekly chore for the wizard', () => {
    let err;
    try { parse('bins every tue and fri'); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(NoTimeError);
    expect(err.partial).toMatchObject({ text: 'bins', kind: 'weekly', detail: { days: [2, 5] } });
  });
});

describe('schedules read as words', () => {
  const row = (kind, detail) => ({ schedule_kind: kind, schedule_detail: JSON.stringify(detail) });
  it('says weekly, monthly and yearly instead of "every 1 week"', () => {
    expect(cadence(row('interval', { days: 7, h: 9, mi: 0 }))).toBe('weekly');
    expect(cadence(row('interval', { days: 14, h: 9, mi: 0 }))).toBe('every 2 weeks');
    expect(cadence(row('interval', { months: 1, dom: 3, h: 9, mi: 0 }))).toBe('monthly');
    expect(cadence(row('interval', { months: 12, dom: 3, h: 9, mi: 0 }))).toBe('yearly');
    expect(describeSchedule(row('interval', { months: 3, dom: 3, h: 9, mi: 0 }))).toBe('every 3 months at 9am');
    expect(describeSchedule(row('interval', { days: 7, h: 19, mi: 30 }))).toBe('weekly at 7:30pm');
  });
});

describe('typed snoozes', () => {
  it.each([
    ['snooze', HOUR],
    ['snooze 20', 20 * 60000],
    ['snooze 2h', 2 * HOUR],
    ['snooze 1 hour', HOUR],
    ['snooze for 45 minutes', 45 * 60000],
    ['snooze an hour', HOUR],
    ['snooze half an hour', 30 * 60000],
  ])('%s', (text, ms) => {
    expect(typedSnooze(text, NOW, TZ)).toEqual({ until: NOW + ms });
  });

  it('snoozes till a clock time, and postpones to tomorrow', () => {
    expect(local(typedSnooze('snooze till 9pm', NOW, TZ).until)).toBe('2026-11-10T21:00');
    expect(typedSnooze('snooze tomorrow', NOW, TZ)).toEqual({ until: NOW + 24 * HOUR, postpone: true });
    expect(typedSnooze('snooze until the cows come home', NOW, TZ)).toBeNull();
    expect(typedSnooze('done', NOW, TZ)).toBeNull();
  });
});

describe('refusals', () => {
  it('lead with a cat, like every other line', () => {
    expect(refusalHtml(new ParseError('No chore 4 here. See /list.'))).toBe('😿 No chore 4 here. See /list.');
    expect(refusalHtml(new ParseError('😼 already'))).toBe('😼 already');
    expect(refusalHtml(new ParseError('"<b>"'))).toBe('😿 "&lt;b&gt;"');
  });
});

// ---- the chat, end to end ----

let sql, env, calls;
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  sql.exec(`INSERT INTO settings (chat_id, dashboard_msg_id) VALUES (1, 99);
    INSERT INTO members (chat_id, user_id, username, first_name, last_seen) VALUES
      (1, 2, 'anne', 'Anne', ${NOW}), (1, 3, 'zack', 'Zack', ${NOW});`);
  env = { BOT_TOKEN: 'test', ALLOWED_CHATS: '1', DB: d1(sql), NICKNAMES: 'nic=@anne, yx=@zack' };
  calls = [];
  let nextId = 500;
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    const method = String(url).split('/').pop();
    const body = JSON.parse(init.body);
    const entry = { method, body };
    calls.push(entry);
    const id = nextId++;
    entry.id = id;
    const result = method === 'getMe' ? { id: 1000, username: 'bot' }
      : body.receiver_user_id ? { message_id: 0, ephemeral_message_id: id } : { message_id: id };
    return new Response(JSON.stringify({ ok: true, result }));
  }));
});
afterEach(() => { sql.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const anne = { id: 2, first_name: 'Anne', username: 'anne' };
const zack = { id: 3, first_name: 'Zack', username: 'zack' };
const say = (from, text, extra = {}) => handleUpdate(env, {
  message: { message_id: 40, chat: { id: 1 }, from, text, entities: [], ...extra },
});
const tap = (from, data, message = { chat: { id: 1 }, message_id: 77 }) => handleUpdate(env, {
  callback_query: { id: 'tap', data, from, message },
});
const sent = (method) => calls.filter((c) => c.method === method);
const texts = () => sent('sendMessage').map((c) => c.body.text);
const deleted = () => sent('deleteMessage').map((c) => c.body.message_id);

const reminder = (over = {}) => {
  const r = {
    id: 10, chat_id: 1, display_num: 1, text: 'trash', schedule_kind: 'daily', schedule_detail: '{"h":20,"mi":0}',
    nag_intervals: '[15,30,60]', next_fire_at: NOW + 10 * HOUR, paused: 0, scored: 1, created_at: NOW - 86400000,
    assignee_name: null, assignee_user_id: null, ...over,
  };
  sql.prepare(`INSERT INTO reminders (id, chat_id, display_num, text, schedule_kind, schedule_detail, nag_intervals,
    next_fire_at, paused, scored, created_at, assignee_name, assignee_user_id)
    VALUES (@id, @chat_id, @display_num, @text, @schedule_kind, @schedule_detail, @nag_intervals, @next_fire_at,
    @paused, @scored, @created_at, @assignee_name, @assignee_user_id)`).run(r);
  return r;
};
const nagging = (over = {}) => {
  const f = {
    id: 5, reminder_id: 10, chat_id: 1, reminder_text: 'trash', fired_at: NOW - HOUR, state: 'nagging',
    nag_count: 1, next_nag_at: NOW + 10 * 60000, snoozes_used: 0, last_message_id: 77, last_message_ephemeral: 0,
    nag_user_id: null, scored: 1, snoozed_until: null, ...over,
  };
  sql.prepare(`INSERT INTO firings (id, reminder_id, chat_id, reminder_text, fired_at, state, nag_count, next_nag_at,
    snoozes_used, last_message_id, last_message_ephemeral, nag_user_id, scored, snoozed_until)
    VALUES (@id, @reminder_id, @chat_id, @reminder_text, @fired_at, @state, @nag_count, @next_nag_at,
    @snoozes_used, @last_message_id, @last_message_ephemeral, @nag_user_id, @scored, @snoozed_until)`).run(f);
  return f;
};
const firing = (id = 5) => sql.prepare('SELECT * FROM firings WHERE id = ?').get(id);

describe('marking done in words', () => {
  it('credits a household shortcut in "done with"', async () => {
    reminder();
    nagging();
    await say(zack, 'done with nic 👍', { reply_to_message: { message_id: 77, chat: { id: 1 } } });
    expect(firing().state).toBe('done');
    expect(firing().done_by).toBe('@zack & @anne');
    expect(texts().some((t) => /Not in this household/.test(t))).toBe(false);
  });

  it('tells a housemate when the only nag out is someone else\'s', async () => {
    reminder({ assignee_name: '@zack', assignee_user_id: 3 });
    nagging({ last_message_ephemeral: 1, nag_user_id: 3 });
    // A plain "done" may be said to a person: the bot keeps out of it.
    await say(anne, 'done');
    expect(sent('sendMessage')).toHaveLength(0);
    await say(anne, '/done');
    expect(firing().state).toBe('nagging');
    const note = sent('sendMessage').at(-1);
    expect(note.body.text).toMatch(/Nothing of yours is nagging/);
    expect(note.body.receiver_user_id).toBe(2);
  });

  it('keeps "done together" a together when it has to ask which one', async () => {
    reminder();
    reminder({ id: 11, display_num: 2, text: 'dishes' });
    nagging();
    nagging({ id: 6, reminder_id: 11, reminder_text: 'dishes', last_message_id: 78 });
    await say(anne, 'done together');
    const ask = sent('sendMessage').at(-1);
    const data = ask.body.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
    expect(data.filter((d) => /^b:/.test(d))).toHaveLength(2);
    expect(data.some((d) => /^d:/.test(d))).toBe(false);
  });

  it('takes the typed "done" away once "which one?" has answered it', async () => {
    reminder();
    reminder({ id: 11, display_num: 2, text: 'dishes' });
    nagging();
    nagging({ id: 6, reminder_id: 11, reminder_text: 'dishes', last_message_id: 78 });
    await say(anne, 'done');
    expect(texts().at(-1)).toMatch(/which one/);
    expect(deleted()).toContain(40);
  });

  it('asks rather than finishing a chore the household parked', async () => {
    reminder();
    nagging({ snoozes_used: 1, snoozed_until: NOW + 2 * HOUR, next_nag_at: NOW + 2 * HOUR });
    await say(anne, 'done');
    expect(firing().state).toBe('nagging');
    expect(texts().at(-1)).toMatch(/which one/);
  });

  it('finishes the live nag beside a parked one', async () => {
    reminder();
    reminder({ id: 11, display_num: 2, text: 'dishes' });
    nagging({ snoozes_used: 1, snoozed_until: NOW + 2 * HOUR, next_nag_at: NOW + 2 * HOUR });
    nagging({ id: 6, reminder_id: 11, reminder_text: 'dishes', last_message_id: 78 });
    await say(anne, 'done!');
    expect(firing(6).state).toBe('done');
    expect(firing(5).state).toBe('nagging');
  });

  it('treats a bare /done like a typed "done"', async () => {
    reminder();
    nagging();
    await say(anne, '/done');
    expect(firing().state).toBe('done');
    expect(texts().some((t) => /Which chore/.test(t))).toBe(false);
    // The command goes once, by the dispatcher's tidy-up.
    expect(deleted().filter((id) => id === 40)).toHaveLength(1);
  });

  it('says so when a bare /done has nothing to finish', async () => {
    reminder();
    await say(anne, '/done');
    expect(texts().at(-1)).toMatch(/Nothing is nagging right now/);
  });

  it('snoozes a nag for "snooze 1 hour"', async () => {
    reminder();
    nagging();
    await say(anne, 'snooze 1 hour', { reply_to_message: { message_id: 77, chat: { id: 1 } } });
    expect(firing().next_nag_at).toBe(NOW + HOUR);
    expect(firing().snoozes_used).toBe(1);
  });

  it('postpones a nag for "snooze tomorrow", moving its expiry with it', async () => {
    reminder();
    nagging();
    await say(anne, 'snooze tomorrow', { reply_to_message: { message_id: 77, chat: { id: 1 } } });
    expect(firing().fired_at).toBe(NOW + 24 * HOUR);
    const card = sent('editMessageText').find((c) => c.body.message_id === 77);
    expect(card.body.text).toMatch(/Postponed by @anne — back tomorrow/);
  });
});

describe('the 8am digest', () => {
  it('is the receipt for a private chore finished from it — no second line beside it', async () => {
    reminder({ assignee_name: '@zack', assignee_user_id: 3 });
    nagging({ last_message_ephemeral: 1, nag_user_id: 3, last_message_id: 700 });
    const digest = {
      chat: { id: 1 }, message_id: 90, text: '☀️ Mrow. Still waiting on:\n• trash',
      reply_markup: { inline_keyboard: [[{ text: '✅ Done · trash', callback_data: 'dg:5' }], [{ text: '✅ OK', callback_data: 'ok' }]] },
    };
    await tap(zack, 'dg:5', digest);
    expect(firing().state).toBe('done');
    expect(sent('sendMessage').some((c) => /done by/.test(c.body.text))).toBe(false);
    const redraw = sent('editMessageText').find((c) => c.body.message_id === 90);
    expect(redraw.body.text).toContain('😻 <s>trash</s> — done by @zack');
    expect(redraw.body.reply_markup.inline_keyboard.flat().map((b) => b.callback_data)).toContain('nd:5');
  });
});

describe('command replies', () => {
  it('pauses with a ▶️ Resume to tap, which turns the reply into the resumed line', async () => {
    reminder();
    await say(anne, '/pause trash');
    const reply = sent('sendMessage').at(-1);
    expect(reply.body.text).toBe('⏸️ Paused <b>trash</b> — no nags until it\'s resumed.');
    expect(reply.body.reply_markup.inline_keyboard[0][0]).toEqual({ text: '▶️ Resume', callback_data: 'rs:10' });
    await tap(anne, 'rs:10', { chat: { id: 1 }, message_id: 0, ephemeral_message_id: reply.id });
    expect(sql.prepare('SELECT paused FROM reminders WHERE id = 10').get().paused).toBe(0);
    const edit = sent('editEphemeralMessageText').at(-1);
    expect(edit.body.ephemeral_message_id).toBe(reply.id);
    expect(edit.body.text).toBe('▶️ Resumed <b>trash</b> — next today 8:00 PM.');
  });

  it('says what a skip skipped and when the chore is next, as the board does', async () => {
    reminder();
    await say(anne, '/skip trash');
    expect(texts().at(-1)).toBe('⏭️ Skipped <b>trash</b> (today 8:00 PM)\nNext: tomorrow 8:00 PM');
  });

  it('offers the chore a typo is one letter from, without acting on it', async () => {
    reminder({ text: 'take out trash' });
    await say(anne, '/done trsh');
    expect(texts().at(-1)).toBe('😿 No chore called "trsh" — did you mean <b>take out trash</b>? <code>/done take out trash</code>');
    expect(sql.prepare('SELECT COUNT(*) AS n FROM firings').get().n).toBe(0);
  });

  it('does not guess between two near misses, or from a short word', async () => {
    reminder({ text: 'mops' });
    reminder({ id: 11, display_num: 2, text: 'maps' });
    await say(anne, '/done mpps');
    expect(texts().at(-1)).toBe('😿 The cats can\'t find a chore matching "mpps". See /list.');
    await say(anne, '/done mos');
    expect(texts().at(-1)).toBe('😿 The cats can\'t find a chore matching "mos". See /list.');
  });

  it('asks "which chore?" with one of the household\'s own', async () => {
    await say(anne, '/skip');
    expect(texts().at(-1)).toBe('😺 No chores yet — add one with <code>/chore trash 7pm daily</code>.');
    reminder({ text: 'clear poop' });
    await say(anne, '/skip');
    expect(texts().at(-1)).toBe('😿 Which chore? e.g. <code>/skip clear poop</code> — see /list.');
  });

  it('dates a done-early receipt as the board does', async () => {
    reminder();
    await say(anne, '/done trash');
    expect(texts().at(-1)).toMatch(/\nNext: tomorrow 8:00 PM$/);
  });
});

describe('the time wizard', () => {
  const card = () => sent('sendMessage').find((c) => /When should Latte/.test(c.body.text));

  it('names the assignee and the day it already has', async () => {
    await say(anne, '/chore yx fold clothes sat');
    expect(card().body.text).toContain('pester @zack about <b>fold clothes</b> (Sat)?');
  });

  it('says tomorrow for a one-off dated tomorrow, and the cadence for a repeat', async () => {
    await say(anne, '/chore pay bill tmr');
    expect(card().body.text).toContain('<b>pay bill</b> (tomorrow)?');
    calls.length = 0;
    await say(anne, '/chore bins every tue and fri');
    expect(card().body.text).toContain('<b>bins</b> (every Tue,Fri)?');
  });

  it('labels its presets as the board words times', async () => {
    await say(anne, '/chore water plants');
    const labels = card().body.reply_markup.inline_keyboard.flat().map((b) => b.text);
    expect(labels).toContain('Today 7:00 PM');
    expect(labels).toContain('Tomorrow 9:00 AM');
  });
});

describe('help', () => {
  it('names the board button the pin actually shows, and this household\'s shortcuts', async () => {
    await say(anne, '/help');
    expect(texts().at(-1)).toContain('Tap ⚙️ Manage chores on the pinned board');
    env.MINI_APP_URL = 'https://t.me/bot/chores';
    await tap(anne, 'h:schedule', { chat: { id: 1 }, message_id: 0, ephemeral_message_id: 600 });
    const page = sent('editEphemeralMessageText').at(-1).body.text;
    expect(page).toContain('<code>/chore yx feed cats tmr 7am</code>');
    expect(page).toContain('<code>/chore bins every tue and fri 8pm</code>');
    await tap(anne, 'h:home', { chat: { id: 1 }, message_id: 0, ephemeral_message_id: 600 });
    expect(sent('editEphemeralMessageText').at(-1).body.text).toContain('Tap 🐾 Chores on the pinned board');
  });
});
