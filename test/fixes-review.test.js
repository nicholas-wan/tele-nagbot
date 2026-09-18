// Regression tests from the September 2026 adversarial review. Real SQLite
// behind the D1 shim, so the new columns (firings.snoozed_until,
// drafts.user_id) and the sweep's cross-table guard are exercised for real.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { handleUpdate } from '../src/handlers.js';
import { setReminderPaused } from '../src/chores.js';
import { runCron, renagPending } from '../src/cron.js';
import { fireReminder } from '../src/firing.js';

const TZ = 'Asia/Singapore';
const HOUR = 3600000;
// 14:00 Singapore on a Tuesday: outside quiet hours, mid-week for rotation.
const NOW = Date.UTC(2026, 8, 15, 6);

let sql, env, calls, refuse;
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  sql.exec(`INSERT INTO settings (chat_id, dashboard_msg_id) VALUES (1, 99);
    INSERT INTO members (chat_id, user_id, username, first_name, last_seen) VALUES
      (1, 2, 'anne', 'Anne', ${NOW}), (1, 3, 'zack', 'Zack', ${NOW});`);
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
  // refuse(method, body) → a Telegram error description, or null to succeed.
  refuse = () => null;
  let nextId = 500;
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    const method = String(url).split('/').pop();
    const body = JSON.parse(init.body);
    calls.push({ method, body });
    const description = refuse(method, body);
    if (description) return new Response(JSON.stringify({ ok: false, error_code: 400, description }));
    const id = nextId++;
    const result = body.receiver_user_id
      ? { message_id: 0, ephemeral_message_id: id }
      : { message_id: id };
    return new Response(JSON.stringify({ ok: true, result }));
  }));
});
afterEach(() => { sql.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const anne = { id: 2, first_name: 'Anne', username: 'anne' };
const zack = { id: 3, first_name: 'Zack', username: 'zack' };
const say = (from, text, message_id = 40) => handleUpdate(env, {
  message: { message_id, chat: { id: 1 }, from, text, entities: [] },
});
const tap = (from, data, message = { chat: { id: 1 }, message_id: 77 }) => handleUpdate(env, {
  callback_query: { id: 'tap', data, from, message },
});
const sent = (method) => calls.filter((c) => c.method === method);
const toast = () => sent('answerCallbackQuery').at(-1).body.text;
const firing = (id = 5) => sql.prepare('SELECT * FROM firings WHERE id = ?').get(id);

const reminder = (over = {}) => {
  const r = {
    id: 10, chat_id: 1, text: 'clear poop', schedule_kind: 'daily', schedule_detail: '{"h":21,"mi":0}',
    nag_intervals: '[15,30,60]', next_fire_at: NOW + 7 * HOUR, paused: 0, scored: 1, created_at: NOW - 86400000,
    assignee_name: null, assignee_user_id: null, ...over,
  };
  sql.prepare(`INSERT INTO reminders (id, chat_id, text, schedule_kind, schedule_detail, nag_intervals,
    next_fire_at, paused, scored, created_at, assignee_name, assignee_user_id)
    VALUES (@id, @chat_id, @text, @schedule_kind, @schedule_detail, @nag_intervals, @next_fire_at,
    @paused, @scored, @created_at, @assignee_name, @assignee_user_id)`).run(r);
  return r;
};
const nagging = (over = {}) => {
  const f = {
    id: 5, reminder_id: 10, chat_id: 1, reminder_text: 'clear poop', fired_at: NOW - HOUR, state: 'nagging',
    nag_count: 1, next_nag_at: NOW + 10 * 60000, snoozes_used: 0, last_message_id: 77, last_message_ephemeral: 0,
    nag_user_id: null, scored: 1, snoozed_until: null, ...over,
  };
  sql.prepare(`INSERT INTO firings (id, reminder_id, chat_id, reminder_text, fired_at, state, nag_count, next_nag_at,
    snoozes_used, last_message_id, last_message_ephemeral, nag_user_id, scored, snoozed_until)
    VALUES (@id, @reminder_id, @chat_id, @reminder_text, @fired_at, @state, @nag_count, @next_nag_at,
    @snoozes_used, @last_message_id, @last_message_ephemeral, @nag_user_id, @scored, @snoozed_until)`).run(f);
  return f;
};

// 1. /resume misread the bot's own quiet-hours deferral as a household snooze.
// snoozes_used stays 1 forever after one snooze, and the cron pushing next_nag_at
// past 08:00 looked identical to a snooze still in force — so the firing kept its
// stale fired_at and was tombstoned hours after the household revived it.
describe('resume tells a spent snooze from one still in force', () => {
  it('restamps a once-snoozed firing the cron has since moved on', async () => {
    const r = reminder({ paused: 1 });
    // Snoozed 10h ago (elapsed), then re-nagged, then pushed over the quiet line.
    nagging({ fired_at: NOW - 20 * HOUR, snoozes_used: 1, snoozed_until: NOW - 10 * HOUR, next_nag_at: NOW + 3 * HOUR });
    await setReminderPaused(env, r, false, TZ, 'Anne');
    const f = firing();
    expect(f.fired_at).toBe(NOW);
    expect(f.snoozed_until).toBeNull();
    // Nothing for the next tick to expire.
    await renagPending(env, NOW + 60000);
    expect(firing().state).toBe('nagging');
    expect(sent('sendMessage').some((c) => /nobody did it/.test(c.body.text))).toBe(false);
  });

  it('keeps a snooze whose chosen time is still ahead', async () => {
    const r = reminder({ paused: 1 });
    nagging({ fired_at: NOW - 2 * HOUR, snoozes_used: 1, snoozed_until: NOW + 2 * HOUR, next_nag_at: NOW + 2 * HOUR });
    await setReminderPaused(env, r, false, TZ, 'Anne');
    expect(firing().fired_at).toBe(NOW - 2 * HOUR);
    const card = sent('editMessageText').find((c) => c.body.message_id === 77);
    expect(card.body.text.startsWith('😴')).toBe(true);
  });

  it('records the chosen time on a snooze tap and a snooze reply', async () => {
    reminder();
    nagging();
    await tap(anne, 'z:5:30');
    expect(firing().snoozed_until).toBe(NOW + 30 * 60000);
    expect(firing().next_nag_at).toBe(NOW + 30 * 60000);
    await handleUpdate(env, { message: {
      message_id: 41, chat: { id: 1 }, from: anne, text: 'snooze 2h', entities: [],
      reply_to_message: { message_id: 77, chat: { id: 1 } },
    } });
    expect(firing().snoozed_until).toBe(NOW + 2 * HOUR);
    expect(firing().snoozes_used).toBe(2);
  });
});

// 2. A bare typed time resolved whichever draft was newest in the chat.
describe('a typed time resolves only the typer\'s own draft', () => {
  it('schedules the typer\'s chore, not the other wizard\'s', async () => {
    await say(anne, '/chore wash the dishes', 40);
    await say(zack, '/chore fold the laundry', 41);
    expect(sql.prepare('SELECT COUNT(*) AS n FROM drafts').get().n).toBe(2);
    await say(anne, '10am', 42);
    const made = sql.prepare('SELECT text, created_by FROM reminders').all();
    expect(made).toEqual([{ text: 'wash the dishes', created_by: '@anne' }]);
    expect(sql.prepare('SELECT text FROM drafts').all()).toEqual([{ text: 'fold the laundry' }]);
    // The card that was cleared away was Anne's own, addressed to her.
    const cleared = sent('deleteEphemeralMessage').at(-1);
    expect(cleared.body.receiver_user_id).toBe(2);
  });

  it('ignores a bare time from someone with no wizard open', async () => {
    await say(anne, '/chore wash the dishes', 40);
    await say(zack, '10am', 41);
    expect(sql.prepare('SELECT COUNT(*) AS n FROM reminders').get().n).toBe(0);
    expect(sql.prepare('SELECT COUNT(*) AS n FROM drafts').get().n).toBe(1);
  });

  it('still confirms an assigned chore when the wizard card cannot be edited', async () => {
    await say(anne, '/chore @zack fold the laundry', 40);
    refuse = (method) => (method === 'editEphemeralMessageText' ? 'Bad Request: message to edit not found' : null);
    await say(anne, '10am', 42);
    expect(sql.prepare('SELECT text FROM reminders').get()).toEqual({ text: 'fold the laundry' });
    const confirmation = sent('sendMessage').find((c) => c.body.receiver_user_id === 2 && /First reminder/.test(c.body.text));
    expect(confirmation, 'a private confirmation was sent instead').toBeTruthy();
    expect(JSON.stringify(confirmation.body.reply_markup)).toContain('Undo');
  });
});

// 3. The sweep deleted the card of any nag older than a day, though a pause,
// a postponement, or an overdue one-off keeps the firing live far longer.
describe('the sweep spares a live nag\'s card', () => {
  const recorded = (message_id, over = {}) => sql.prepare(
    `INSERT INTO sent_messages (chat_id, receiver_user_id, message_id, is_ephemeral, delete_after, created_at)
     VALUES (1, NULL, ?, 0, ?, ?)`
  ).run(message_id, over.delete_after ?? NOW - HOUR, NOW - 25 * HOUR);
  const deleted = (id) => sent('deleteMessage').some((c) => c.body.message_id === id);

  it('skips the current card of a nagging firing and sweeps other overdue rows', async () => {
    reminder({ paused: 1 });
    nagging({ fired_at: NOW - 30 * HOUR, last_message_id: 77 });
    recorded(77);
    recorded(78);
    await runCron(env);
    expect(deleted(77)).toBe(false);
    expect(deleted(78)).toBe(true);
    expect(sql.prepare('SELECT message_id FROM sent_messages').all()).toEqual([{ message_id: 77 }]);
  });

  it('sweeps the card once the firing is no longer nagging', async () => {
    reminder();
    nagging({ state: 'done', last_message_id: 77 });
    recorded(77);
    await runCron(env);
    expect(deleted(77)).toBe(true);
  });

  it('matches the id space, so a public id equal to an ephemeral one is not spared', async () => {
    reminder({ paused: 1 });
    nagging({ last_message_id: 77, last_message_ephemeral: 1, nag_user_id: 2 });
    recorded(77); // a public message that happens to share the number
    await runCron(env);
    expect(deleted(77)).toBe(true);
  });

  it('re-sends the card on resume when Telegram says it is gone', async () => {
    const r = reminder({ paused: 1 });
    nagging({ fired_at: NOW - 30 * HOUR, last_message_id: 77 });
    refuse = (method, body) => (method === 'editMessageText' && body.message_id === 77
      ? 'Bad Request: message to edit not found' : null);
    await setReminderPaused(env, r, false, TZ, 'Anne');
    const fresh = sent('sendMessage').find((c) => /clear poop/.test(c.body.text) && /nag #/.test(c.body.text));
    expect(fresh, 'a fresh nag card was sent').toBeTruthy();
    expect(firing().last_message_id).not.toBe(77);
  });

  it('does not re-send on a transient edit failure', async () => {
    const r = reminder({ paused: 1 });
    nagging({ last_message_id: 77 });
    refuse = (method) => (method === 'editMessageText' ? 'Too Many Requests: retry after 30' : null);
    await setReminderPaused(env, r, false, TZ, 'Anne');
    expect(sent('sendMessage').some((c) => /nag #/.test(c.body.text))).toBe(false);
    expect(firing().last_message_id).toBe(77);
  });
});

// 4. Snooze… on an ephemeral nag re-rendered the text as a plain nag, and
// ↩️ Back reads the card's text to choose a keyboard — so a parked chore came
// back with Done / Snooze as if due now.
describe('the snooze picker keeps a parked ephemeral card parked', () => {
  const ephemeral = () => nagging({ last_message_ephemeral: 1, nag_user_id: 2, snoozes_used: 1,
    snoozed_until: NOW + 2 * HOUR, next_nag_at: NOW + 2 * HOUR });
  const cbMessage = { chat: { id: 1 }, message_id: 0, ephemeral_message_id: 77, text: '😴 clear poop' };

  it('renders the snooze notice behind the presets', async () => {
    reminder({ assignee_name: '@anne', assignee_user_id: 2 });
    ephemeral();
    await tap(anne, 's:5', cbMessage);
    const edit = sent('editEphemeralMessageText').at(-1);
    expect(edit.body.text.startsWith('😴')).toBe(true);
    expect(JSON.stringify(edit.body.reply_markup)).toContain('↩️ Back');
  });

  it('renders a live nag as a nag', async () => {
    reminder({ assignee_name: '@anne', assignee_user_id: 2 });
    nagging({ last_message_ephemeral: 1, nag_user_id: 2 });
    await tap(anne, 's:5', { ...cbMessage, text: '🐱 clear poop' });
    expect(sent('editEphemeralMessageText').at(-1).body.text.startsWith('🐱')).toBe(true);
  });
});

// 5. Snoozing an overdue one-off wrote next_nag_at into the past, burned a
// snooze, and promised a time already gone; the next tick silently undid it.
describe('an overdue one-off cannot be snoozed', () => {
  const overdue = () => {
    reminder({ schedule_kind: 'once', schedule_detail: '{}', next_fire_at: null });
    nagging({ fired_at: NOW - 25 * HOUR, next_nag_at: null });
  };

  it('refuses the preset tap and the reply', async () => {
    overdue();
    await tap(anne, 'z:5:30');
    expect(toast()).toMatch(/overdue/i);
    expect(firing()).toMatchObject({ snoozes_used: 0, next_nag_at: null });
    await handleUpdate(env, { message: {
      message_id: 41, chat: { id: 1 }, from: anne, text: 'snooze 2h', entities: [],
      reply_to_message: { message_id: 77, chat: { id: 1 } },
    } });
    expect(firing()).toMatchObject({ snoozes_used: 0, next_nag_at: null });
    expect(sent('sendMessage').some((c) => /overdue/i.test(c.body.text))).toBe(true);
  });

  it('refuses to open the presets', async () => {
    overdue();
    await tap(anne, 's:5');
    expect(toast()).toMatch(/overdue/i);
    expect(sent('editMessageReplyMarkup')).toHaveLength(0);
  });

  it('redraws the card as overdue, without Snooze, when the window closes', async () => {
    reminder({ schedule_kind: 'once', schedule_detail: '{}', next_fire_at: null });
    nagging({ fired_at: NOW - 25 * HOUR, next_nag_at: NOW - 60000 });
    await renagPending(env, NOW);
    expect(firing()).toMatchObject({ state: 'nagging', next_nag_at: null });
    const card = sent('editMessageText').find((c) => c.body.message_id === 77);
    expect(card.body.text.startsWith('⏰')).toBe(true);
    const labels = card.body.reply_markup.inline_keyboard.flat().map((b) => b.text);
    expect(labels).toContain('✅ Done');
    expect(labels.some((l) => /Snooze/.test(l))).toBe(false);
  });

  it('still lets Done through', async () => {
    overdue();
    await tap(anne, 'd:5');
    expect(firing().state).toBe('done');
  });
});

// 6. Rotation counted only scored completions, so a rotating /remind chore
// sat at 0/0 for everyone and the alphabetical tiebreak picked the same
// person every time.
describe('rotation counts unscored completions', () => {
  it('hands the turn to whoever has done less, points or not', async () => {
    const r = reminder({ scored: 0, schedule_detail: '{"h":21,"mi":0,"rotate":true}', next_fire_at: NOW });
    for (let i = 0; i < 3; i++) {
      sql.prepare(`INSERT INTO firings (reminder_id, chat_id, reminder_text, fired_at, state, done_by, done_at, scored)
        VALUES (10, 1, 'clear poop', ?, 'done', '@anne', ?, 0)`).run(NOW - (i + 1) * HOUR, NOW - i * HOUR);
    }
    await fireReminder(env, r, NOW, TZ);
    expect(sql.prepare('SELECT assignee_name FROM reminders WHERE id = 10').get().assignee_name).toBe('@zack');
  });
});
