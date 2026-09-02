import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { handleUpdate } from '../src/handlers.js';
import { nagButtons } from '../src/nag.js';
import { updateDashboard } from '../src/dashboard.js';

function dbForDashboard(reminders = []) {
  return {
    prepare(sql) {
      return {
        bind() {
          return {
            async first() {
              if (sql.includes('dashboard_msg_id, tz')) return null;
              if (sql.includes('dashboard_msg_id FROM settings')) return { dashboard_msg_id: 99 };
              if (sql.includes('paused_until')) return null;
              if (sql.includes('SELECT tz')) return null;
              return null;
            },
            async all() {
              if (sql.includes('SELECT * FROM reminders')) return { results: reminders };
              if (sql.includes('SELECT reminder_id FROM firings')) return { results: [] };
              return { results: [] };
            },
            async run() {
              return { meta: { changes: 1, last_row_id: sql.includes('INSERT INTO drafts') ? 12 : 10 } };
            },
          };
        },
      };
    },
  };
}

describe('chat UX', () => {
  const calls = [];

  beforeEach(() => {
    calls.length = 0;
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      calls.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 99 } }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }));
  });

  afterEach(() => vi.unstubAllGlobals());

  it('uses an explicit Done together label', () => {
    expect(nagButtons(7).inline_keyboard[0].map((b) => b.text))
      .toEqual(['✅ Done', '🤝 Done together', '😴 Snooze…']);
  });

  it('renders number-free chore cards and a Manage chores dashboard button', async () => {
    const reminder = {
      id: 10, display_num: 3, text: 'Water plants', paused: 0,
      next_fire_at: Date.now() + 3600000, schedule_kind: 'daily',
      schedule_detail: JSON.stringify({ h: 19, mi: 0 }), assignee_name: null,
    };
    const env = { BOT_TOKEN: 'token', DB: dbForDashboard([reminder]) };
    await updateDashboard(env, 1);
    const sent = calls.find((c) => c.url.endsWith('/sendMessage'));
    // Owner preference: display numbers stay out of the list; names are the handles.
    expect(sent.body.text).not.toContain('#3');
    expect(sent.body.text).toContain('<b>Water plants</b>');
    expect(sent.body.reply_markup.inline_keyboard[0][0].text).toBe('⚙️ Manage chores');
  });

  it('keeps the default help view lean and button-driven', async () => {
    const env = { BOT_TOKEN: 'token', ALLOWED_CHATS: '1', DB: dbForDashboard() };
    await handleUpdate(env, {
      message: { message_id: 5, chat: { id: 1 }, from: { id: 2, first_name: 'Nick' }, text: '/help' },
    });
    const sent = calls.find((c) => c.url.endsWith('/sendMessage'));
    expect(sent.body.text).toContain('/chore trash 7pm daily');
    expect(sent.body.text).not.toContain('/tagsticker');
    expect(sent.body.reply_markup.inline_keyboard.flat().map((b) => b.text))
      .toContain('⏰ Scheduling examples');
  });

  it('opens the chore picker inside the pinned dashboard', async () => {
    const reminder = {
      id: 10, display_num: 3, text: 'Water plants', paused: 0,
      next_fire_at: Date.now() + 3600000, schedule_kind: 'daily',
      schedule_detail: JSON.stringify({ h: 19, mi: 0 }), assignee_name: null,
    };
    const env = { BOT_TOKEN: 'token', ALLOWED_CHATS: '1', DB: dbForDashboard([reminder]) };
    await handleUpdate(env, {
      callback_query: {
        id: 'cb1', data: 'm:list', from: { id: 2, first_name: 'Nick' },
        message: { message_id: 99, chat: { id: 1 }, text: 'dashboard' },
      },
    });
    const edited = calls.find((c) => c.url.endsWith('/editMessageReplyMarkup'));
    const first = edited.body.reply_markup.inline_keyboard[0][0];
    expect(first.callback_data).toBe('m:item:10');
    // Buttons carry the chore's own identity, never the internal number.
    expect(first.text).toContain('Water plants');
    expect(first.text).not.toContain('#3');
  });

  it('removes successful operational command messages', async () => {
    const reminder = {
      id: 10, display_num: 3, text: 'Water plants', paused: 0,
      next_fire_at: Date.now() + 3600000, schedule_kind: 'daily',
      schedule_detail: JSON.stringify({ h: 19, mi: 0 }), assignee_name: null,
    };
    const env = { BOT_TOKEN: 'token', ALLOWED_CHATS: '1', DB: dbForDashboard([reminder]) };
    await handleUpdate(env, {
      message: { message_id: 5, chat: { id: 1 }, from: { id: 2, first_name: 'Nick' }, text: '/list' },
    });
    expect(calls.some((c) => c.url.endsWith('/deleteMessage') && c.body.message_id === 5)).toBe(true);
  });

  // Names are the handles: a chore whose name starts with digits must match by
  // name, not be parseInt'd into some other chore's legacy number.
  it('matches a digit-leading chore name by name, not by number', async () => {
    const meds = {
      id: 21, display_num: 1, text: '10pm meds', paused: 0,
      next_fire_at: Date.now() + 3600000, schedule_kind: 'daily',
      schedule_detail: JSON.stringify({ h: 22, mi: 0 }), assignee_name: null,
    };
    const plants = {
      id: 22, display_num: 10, text: 'Water plants', paused: 0,
      next_fire_at: Date.now() + 3600000, schedule_kind: 'daily',
      schedule_detail: JSON.stringify({ h: 19, mi: 0 }), assignee_name: null,
    };
    const updates = [];
    const db = {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async first() { return null; },
              async all() {
                if (sql.includes('SELECT * FROM reminders')) return { results: [meds, plants] };
                return { results: [] };
              },
              async run() { updates.push({ sql, args }); return { meta: { changes: 1, last_row_id: 1 } }; },
            };
          },
        };
      },
    };
    const env = { BOT_TOKEN: 'token', ALLOWED_CHATS: '1', DB: db };
    await handleUpdate(env, {
      message: { message_id: 5, chat: { id: 1 }, from: { id: 2, first_name: 'Nick' }, text: '/pause 10pm meds' },
    });
    const upd = updates.find((u) => u.sql.includes('SET paused'));
    expect(upd.args[2]).toBe(21); // "10pm meds" — not "Water plants" via display #10
  });

  // Harness for replies to a live nag: message 77 is the nag, firing 5 owns it.
  function nagReplyDb(runs = []) {
    const firing = {
      id: 5, reminder_id: 10, chat_id: 1, state: 'nagging', fired_at: Date.now(),
      last_message_id: 77, last_message_ephemeral: 0, snoozes_used: 0, nag_count: 0, scored: 1,
    };
    const reminder = {
      id: 10, chat_id: 1, text: 'Water plants', paused: 0, schedule_kind: 'daily',
      schedule_detail: JSON.stringify({ h: 19, mi: 0 }), assignee_name: null, scored: 1,
    };
    return {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async first() {
                if (sql.includes('FROM firings') && sql.includes('last_message_id')) return firing;
                if (sql.includes('SELECT * FROM firings WHERE id')) return firing;
                if (sql.includes('FROM reminders')) return reminder;
                if (sql.includes('SELECT tz')) return { tz: 'Asia/Singapore' };
                return null;
              },
              async all() {
                if (sql.includes('SELECT * FROM reminders')) return { results: [reminder] };
                return { results: [] };
              },
              async run() { runs.push({ sql, args }); return { meta: { changes: 1, last_row_id: 1 } }; },
            };
          },
        };
      },
    };
  }

  const nagReply = (text) => ({
    message: {
      message_id: 6, chat: { id: 1 }, from: { id: 2, first_name: 'Nick' }, text,
      reply_to_message: { message_id: 77, chat: { id: 1 } },
    },
  });

  it('does not complete a chore on a "done?" question', async () => {
    const runs = [];
    await handleUpdate({ BOT_TOKEN: 'token', ALLOWED_CHATS: '1', DB: nagReplyDb(runs) }, nagReply('done?'));
    expect(runs.some((u) => u.sql.includes("state = 'done'"))).toBe(false);
  });

  it('still completes on a real done reply', async () => {
    const runs = [];
    await handleUpdate({ BOT_TOKEN: 'token', ALLOWED_CHATS: '1', DB: nagReplyDb(runs) }, nagReply('done!'));
    expect(runs.some((u) => u.sql.includes("state = 'done'"))).toBe(true);
  });

  it('answers instead of ignoring a snooze it could not read', async () => {
    const runs = [];
    await handleUpdate({ BOT_TOKEN: 'token', ALLOWED_CHATS: '1', DB: nagReplyDb(runs) }, nagReply('snooze until 6pm'));
    expect(runs.some((u) => u.sql.includes('snoozes_used'))).toBe(false);
    const hint = calls.find((c) => c.url.endsWith('/sendMessage'));
    expect(hint.body.text).toContain('snooze 2h');
    expect(hint.body.receiver_user_id).toBe(2);
  });

  // Doing a chore ahead of the nag earns the credit instead of "is not
  // currently nagging": the upcoming occurrence completes and the schedule
  // advances past it.
  it('gives done-early credit for a chore that is not nagging yet', async () => {
    const reminder = {
      id: 10, display_num: 3, chat_id: 1, text: 'Water plants', paused: 0,
      next_fire_at: 1_900_000_000_000, schedule_kind: 'daily',
      schedule_detail: JSON.stringify({ h: 19, mi: 0 }), assignee_name: null, scored: 1,
    };
    const runs = [];
    const db = {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async first() {
                if (sql.includes("state = 'nagging'")) return null;
                if (sql.includes('SELECT next_fire_at')) return { next_fire_at: 1_900_086_400_000 };
                if (sql.includes('SELECT tz')) return { tz: 'Asia/Singapore' };
                return null;
              },
              async all() {
                if (sql.includes('SELECT * FROM reminders')) return { results: [reminder] };
                return { results: [] };
              },
              async run() { runs.push({ sql, args }); return { meta: { changes: 1, last_row_id: 1 } }; },
            };
          },
        };
      },
    };
    await handleUpdate({ BOT_TOKEN: 'token', ALLOWED_CHATS: '1', DB: db }, {
      message: { message_id: 5, chat: { id: 1 }, from: { id: 2, first_name: 'Nick' }, text: '/done water plants' },
    });
    // The upcoming slot is claimed conditionally and a done firing is recorded.
    const claim = runs.find((u) => u.sql.includes('SET next_fire_at = ? WHERE id = ? AND next_fire_at = ?'));
    expect(claim.args[1]).toBe(10);
    expect(claim.args[2]).toBe(1_900_000_000_000);
    const insert = runs.find((u) => u.sql.includes('INSERT INTO firings') && u.sql.includes("'done'"));
    expect(insert.args).toContain('Nick');
    // The receipt is public and names the next occurrence.
    const receipt = calls.find((c) => c.url.endsWith('/sendMessage') && /done early/.test(c.body.text || ''));
    expect(receipt.body.receiver_user_id).toBeUndefined();
    expect(receipt.body.text).toContain('Next:');
  });

  // The "/" autocomplete menu sends the bare command; that must ask for the
  // chore, not error, and the reply is treated as the rest of the command.
  it('asks what to nag about on a bare /remind', async () => {
    const env = { BOT_TOKEN: 'token', ALLOWED_CHATS: '1', DB: dbForDashboard() };
    await handleUpdate(env, {
      message: { message_id: 5, chat: { id: 1 }, from: { id: 2, first_name: 'Nick' }, text: '/remind' },
    });
    const prompt = calls.find((c) => c.url.endsWith('/sendMessage')
      && c.body.reply_markup && c.body.reply_markup.force_reply);
    expect(prompt.body.text).toContain('nag about');
    expect(calls.some((c) => /could not find a time/.test((c.body && c.body.text) || ''))).toBe(false);
  });

  function textPromptDb(runs) {
    const draft = {
      id: 12, chat_id: 1, text: '', scored: 1, schedule_kind: 'once', schedule_detail: '{}',
      nag_intervals: '[15,30,60]', prompt_msg_id: 77, prompt_msg_ephemeral: 0, created_at: Date.now(),
    };
    return {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async first() {
                if (sql.includes('FROM drafts') && sql.includes('prompt_msg_id = ?')) return draft;
                if (sql.includes('SELECT tz')) return { tz: 'Asia/Singapore' };
                return null;
              },
              async all() { return { results: [] }; },
              async run() { runs.push({ sql, args }); return { meta: { changes: 1, last_row_id: 30 } }; },
            };
          },
        };
      },
    };
  }

  const promptReply = (text) => ({
    message: {
      message_id: 6, chat: { id: 1 }, from: { id: 2, first_name: 'Nick' }, text,
      reply_to_message: { message_id: 77, chat: { id: 1 } },
    },
  });

  it('treats the reply to the prompt as the full command', async () => {
    const runs = [];
    await handleUpdate({ BOT_TOKEN: 'token', ALLOWED_CHATS: '1', DB: textPromptDb(runs) },
      promptReply('water plants 7pm daily'));
    const insert = runs.find((u) => u.sql.includes('INSERT INTO reminders'));
    expect(insert.args).toContain('water plants');
    expect(insert.args).toContain('daily');
  });

  it('hands a time-less prompt reply to the time wizard', async () => {
    const runs = [];
    await handleUpdate({ BOT_TOKEN: 'token', ALLOWED_CHATS: '1', DB: textPromptDb(runs) },
      promptReply('water plants'));
    expect(runs.some((u) => u.sql.includes('INSERT INTO reminders'))).toBe(false);
    const wizard = calls.find((c) => /When should Latte/.test((c.body && c.body.text) || ''));
    expect(wizard.body.text).toContain('water plants');
  });

  // A custom time for an interval draft must set the FIRST fire at the next
  // matching slot — nextOccurrence('interval') would put it a whole gap out.
  function intervalDraftDb(runs) {
    const draft = {
      id: 12, chat_id: 1, text: 'slutbed', scored: 1, schedule_kind: 'interval',
      schedule_detail: '{"days":14}', nag_intervals: '[15,30,60]',
      wizard_msg_id: 77, wizard_msg_ephemeral: 0, prompt_msg_id: null, created_at: Date.now(),
    };
    return {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async first() {
                if (sql.includes('FROM drafts') && sql.includes('prompt_msg_id = ?')) return draft;
                if (sql.includes('FROM drafts') && sql.includes("text <> ''")) return draft;
                if (sql.includes('SELECT tz')) return { tz: 'Asia/Singapore' };
                return null;
              },
              async all() { return { results: [] }; },
              async run() { runs.push({ sql, args }); return { meta: { changes: 1, last_row_id: 30 } }; },
            };
          },
        };
      },
    };
  }

  const firesSoon = (runs) => {
    const insert = runs.find((u) => u.sql.includes('INSERT INTO reminders'));
    expect(insert.args.join()).toContain('"days":14');
    expect(insert.args.join()).toContain('"h":9');
    const at = insert.args.find((a) => typeof a === 'number' && a > Date.now());
    expect(at).toBeLessThan(Date.now() + 26 * 3600000); // next 9am slot, not +14 days
  };

  it('starts an interval chore at the next slot after a typed time', async () => {
    const runs = [];
    await handleUpdate({ BOT_TOKEN: 'token', ALLOWED_CHATS: '1', DB: intervalDraftDb(runs) },
      promptReply('9am'));
    firesSoon(runs);
  });

  it('picks up a pure time typed after the wizard without a reply', async () => {
    const runs = [];
    await handleUpdate({ BOT_TOKEN: 'token', ALLOWED_CHATS: '1', DB: intervalDraftDb(runs) }, {
      message: { message_id: 6, chat: { id: 1 }, from: { id: 2, first_name: 'Nick' }, text: '9am' },
    });
    firesSoon(runs);
  });

  // One /stats: the board carries tabs for the other views and flips in place.
  it('sends one stats message with view tabs', async () => {
    const env = { BOT_TOKEN: 'token', ALLOWED_CHATS: '1', DB: dbForDashboard() };
    await handleUpdate(env, {
      message: { message_id: 5, chat: { id: 1 }, from: { id: 2, first_name: 'Nick' }, text: '/stats' },
    });
    const sent = calls.find((c) => c.url.endsWith('/sendMessage'));
    expect(sent.body.text).toContain('Fresh week');
    const data = sent.body.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
    expect(data).toContain('st:last');
    expect(data).toContain('st:all');
    expect(data).not.toContain('st:week');
  });

  it('flips the stats message to last week in place', async () => {
    const env = { BOT_TOKEN: 'token', ALLOWED_CHATS: '1', DB: dbForDashboard() };
    await handleUpdate(env, {
      callback_query: {
        id: 'cb9', data: 'st:last', from: { id: 2, first_name: 'Nick' },
        message: { message_id: 98, chat: { id: 1 }, text: 'board' },
      },
    });
    const edited = calls.find((c) => c.url.endsWith('/editMessageText'));
    expect(edited.body.message_id).toBe(98);
    expect(edited.body.text).toContain('Last week');
    const data = edited.body.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
    expect(data).toContain('st:week');
    expect(data).not.toContain('st:last');
  });

  it('tidies away a typo’d command like any other', async () => {
    const env = { BOT_TOKEN: 'token', ALLOWED_CHATS: '1', DB: dbForDashboard() };
    await handleUpdate(env, {
      message: { message_id: 5, chat: { id: 1 }, from: { id: 2, first_name: 'Nick' }, text: '/lst' },
    });
    expect(calls.some((c) => c.url.endsWith('/deleteMessage') && c.body.message_id === 5)).toBe(true);
    const reply = calls.find((c) => c.url.endsWith('/sendMessage'));
    expect(reply.body.text).toContain('Unknown command');
    expect(reply.body.receiver_user_id).toBe(2);
  });

  it('shows exact date choices and Cancel without redundant timezone copy', async () => {
    const env = { BOT_TOKEN: 'token', ALLOWED_CHATS: '1', DB: dbForDashboard() };
    await handleUpdate(env, {
      message: {
        message_id: 5, chat: { id: 1 }, from: { id: 2, first_name: 'Nick' },
        text: '/remind laundry', entities: [],
      },
    });
    const wizard = calls.find((c) => c.url.endsWith('/sendMessage'));
    const labels = wizard.body.reply_markup.inline_keyboard.flat().map((b) => b.text);
    expect(wizard.body.text).not.toContain('Asia/Singapore');
    expect(labels).toContain('✕ Cancel');
    expect(labels).not.toContain('Tonight 7pm');
    expect(labels.some((label) => /7:00 PM/.test(label))).toBe(true);
  });

  // Postponing has to outlive the 24h expiry window, unlike the hour presets.
  function dbForNag(firing) {
    const reminder = {
      id: 10, chat_id: 1, text: 'clear poop', paused: 0, next_fire_at: Date.now() + 3600000,
      schedule_kind: 'interval', nag_intervals: '[15,30,60]',
      schedule_detail: JSON.stringify({ h: 21, mi: 0, days: 8 }), assignee_name: null,
    };
    return {
      prepare(sql) {
        return {
          bind() {
            return {
              async first() {
                if (sql.includes('FROM firings')) return firing;
                if (sql.includes('FROM reminders')) return reminder;
                if (sql.includes('SELECT tz')) return { tz: 'Asia/Singapore' };
                return null;
              },
              async all() { return { results: [] }; },
              async run() { return { meta: { changes: 1, last_row_id: 1 } }; },
            };
          },
        };
      },
    };
  }

  const NAGGING = {
    id: 5, reminder_id: 10, chat_id: 1, state: 'nagging', nag_count: 0, snoozes_used: 0,
    fired_at: Date.now() - 3600000, last_message_id: 42, last_message_ephemeral: 0,
    nag_user_id: null, cat: 'both',
  };

  it('offers Tomorrow among the snooze options', async () => {
    const env = { BOT_TOKEN: 'token', ALLOWED_CHATS: '1', DB: dbForNag(NAGGING) };
    await handleUpdate(env, {
      callback_query: {
        id: 'cb1', data: 's:5', from: { id: 2, first_name: 'Nick' },
        message: { message_id: 42, chat: { id: 1 }, text: 'nag' },
      },
    });
    const edited = calls.find((c) => c.url.endsWith('/editMessageReplyMarkup'));
    expect(edited.body.reply_markup.inline_keyboard.flat().map((b) => b.text))
      .toContain('📅 Tomorrow');
  });

  it('postpones a day by carrying the expiry window forward', async () => {
    const env = { BOT_TOKEN: 'token', ALLOWED_CHATS: '1', DB: dbForNag(NAGGING) };
    await handleUpdate(env, {
      callback_query: {
        id: 'cb2', data: 'z:5:day', from: { id: 2, first_name: 'Nick' },
        message: { message_id: 42, chat: { id: 1 }, text: 'nag' },
      },
    });
    const answer = calls.find((c) => c.url.endsWith('/answerCallbackQuery'));
    // An hour preset would have been clamped to just before expiry instead.
    expect(answer.body.text).toMatch(/Postponed/);
    expect(answer.body.text).not.toMatch(/24h limit/);
  });

  it('deletes a chore from its nag and logs it publicly for both', async () => {
    const env = { BOT_TOKEN: 'token', ALLOWED_CHATS: '1', DB: dbForNag(NAGGING) };
    await handleUpdate(env, {
      callback_query: {
        id: 'cb3', data: 'x:5', from: { id: 2, first_name: 'Nick', username: 'nicholaswan' },
        message: { message_id: 42, chat: { id: 1 }, text: 'nag' },
      },
    });
    const log = calls.find((c) => c.url.endsWith('/sendMessage') && /deleted/i.test(c.body.text || ''));
    expect(log).toBeTruthy();
    // Public and attributed, even if the nag itself was private.
    expect(log.body.receiver_user_id).toBeUndefined();
    expect(log.body.text).toContain('@nicholaswan');
    expect(log.body.text).toContain('clear poop');
    expect(log.body.reply_markup.inline_keyboard[0].map((b) => b.text)).toEqual(['↩️ Undo', '✅ OK']);
  });

  it('puts an OK on bot messages that have no controls of their own', async () => {
    const env = { BOT_TOKEN: 'token', ALLOWED_CHATS: '1', DB: dbForDashboard() };
    await handleUpdate(env, {
      message: { message_id: 5, chat: { id: 1 }, from: { id: 2, first_name: 'Nick' }, text: '/list' },
    });
    const sent = calls.find((c) => c.url.endsWith('/sendMessage'));
    expect(sent.body.reply_markup.inline_keyboard[0][0]).toMatchObject({ text: '✅ OK', callback_data: 'ok' });
  });

  it('leaves messages that already have controls alone', async () => {
    const reminder = {
      id: 10, display_num: 3, text: 'Water plants', paused: 0,
      next_fire_at: Date.now() + 3600000, schedule_kind: 'daily',
      schedule_detail: JSON.stringify({ h: 19, mi: 0 }), assignee_name: null,
    };
    const env = { BOT_TOKEN: 'token', ALLOWED_CHATS: '1', DB: dbForDashboard([reminder]) };
    await updateDashboard(env, 1);
    const board = calls.find((c) => c.url.endsWith('/sendMessage'));
    // The pinned board keeps Manage chores; an OK there would delete the board.
    expect(board.body.reply_markup.inline_keyboard[0][0].text).toBe('⚙️ Manage chores');
  });

  it('dismisses a log line when OK is tapped', async () => {
    const env = { BOT_TOKEN: 'token', ALLOWED_CHATS: '1', DB: dbForNag(NAGGING) };
    await handleUpdate(env, {
      callback_query: {
        id: 'cb4', data: 'ok', from: { id: 2, first_name: 'Nick' },
        message: { message_id: 88, chat: { id: 1 }, text: 'deleted' },
      },
    });
    expect(calls.some((c) => c.url.endsWith('/deleteMessage') && c.body.message_id === 88)).toBe(true);
  });

  it('opens a button-driven chore editor without adding it to the main menu', async () => {
    const reminder = {
      id: 10, display_num: 3, text: 'Water plants', paused: 0,
      next_fire_at: Date.now() + 3600000, schedule_kind: 'daily', nag_intervals: '[15,30,60]',
      schedule_detail: JSON.stringify({ h: 19, mi: 0 }), assignee_name: null,
    };
    const env = { BOT_TOKEN: 'token', ALLOWED_CHATS: '1', DB: dbForDashboard([reminder]) };
    await handleUpdate(env, {
      message: { message_id: 5, chat: { id: 1 }, from: { id: 2, first_name: 'Nick' }, text: '/edit 3' },
    });
    const editor = calls.find((c) => c.url.endsWith('/sendMessage'));
    const labels = editor.body.reply_markup.inline_keyboard.flat().map((b) => b.text);
    expect(editor.body.text).toContain('Edit #3: Water plants');
    expect(labels).toContain('🕐 Time');
    expect(labels).toContain('😾 Nag pace');
    expect(labels).toContain('👤 Assignee');
  });
});

describe('daily sweep of bot messages', () => {
  const calls = [];
  let inserted;

  beforeEach(() => {
    calls.length = 0;
    inserted = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      calls.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 99 } }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  function db() {
    return {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async first() {
                if (sql.includes('dashboard_msg_id')) return null;
                return null;
              },
              async all() { return { results: [] }; },
              async run() {
                if (sql.includes('INSERT INTO sent_messages')) inserted.push(args);
                return { meta: { changes: 1, last_row_id: 1 } };
              },
            };
          },
        };
      },
    };
  }

  it('records ordinary sends for the sweep', async () => {
    const { sendMessage } = await import('../src/tg.js');
    await sendMessage({ BOT_TOKEN: 't', DB: db() }, 1, 'hello');
    expect(inserted.length).toBe(1);
    const [, , messageId, ephemeral, deleteAfter] = inserted[0];
    expect(messageId).toBe(99);
    expect(ephemeral).toBe(0);
    expect(deleteAfter).toBeGreaterThan(Date.now());
    expect(deleteAfter).toBeLessThanOrEqual(Date.now() + 86400000);
  });

  it('spares the pinned dashboard via keep', async () => {
    const { sendMessage } = await import('../src/tg.js');
    await sendMessage({ BOT_TOKEN: 't', DB: db() }, 1, 'board', null, { keep: true });
    expect(inserted.length).toBe(0);
  });
});

describe('phone-sized board', () => {
  const calls = [];
  beforeEach(() => {
    calls.length = 0;
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      calls.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 99 } }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('renders when and what on their own short lines, and drops "once"', async () => {
    const chores = [
      { id: 1, display_num: 1, text: 'clear poop', paused: 0, next_fire_at: Date.now() + 3600000,
        schedule_kind: 'interval', schedule_detail: JSON.stringify({ days: 8, h: 21, mi: 0 }), assignee_name: null },
      { id: 2, display_num: 2, text: 'starhub booth', paused: 0, next_fire_at: Date.now() + 7200000,
        schedule_kind: 'once', schedule_detail: JSON.stringify({ h: 14, mi: 0 }), assignee_name: null },
    ];
    const env = { BOT_TOKEN: 'token', DB: dbForDashboard(chores) };
    await updateDashboard(env, 1);
    const text = calls.find((c) => c.url.endsWith('/sendMessage')).body.text;
    const lines = text.split('\n');
    // The chore name starts its line — the timing lives on the line above it.
    const nameLine = lines.find((l) => l.includes('clear poop'));
    expect(nameLine.startsWith('💩')).toBe(true);
    expect(nameLine).toContain('every 8 days');
    // One-offs carry no cadence; "once" is the absence of one.
    expect(text).not.toContain('once');
    expect(lines.find((l) => l.includes('starhub booth'))).not.toContain('·  ');
  });
});

describe('chore confirmation buttons', () => {
  const calls = [];
  beforeEach(() => {
    calls.length = 0;
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      calls.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 99 } }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('offers both Undo and OK on the creation confirmation', async () => {
    const env = { BOT_TOKEN: 'token', ALLOWED_CHATS: '1', DB: dbForDashboard() };
    await handleUpdate(env, {
      message: {
        message_id: 5, chat: { id: 1 }, from: { id: 2, first_name: 'Nick' },
        text: '/chore water plants 7pm daily', entities: [],
      },
    });
    const confirmation = calls.find((c) => c.url.endsWith('/sendMessage')
      && c.body.reply_markup && JSON.stringify(c.body.reply_markup).includes('u:'));
    expect(confirmation.body.reply_markup.inline_keyboard[0].map((b) => b.text))
      .toEqual(['↩️ Undo', '✅ OK']);
  });
});

describe('receipt lifetimes', () => {
  const calls = [];
  let inserted;
  beforeEach(() => {
    calls.length = 0;
    inserted = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      calls.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 99 } }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('records a short TTL when asked', async () => {
    const db = {
      prepare(sql) {
        return { bind(...args) { return {
          async first() { return null; },
          async all() { return { results: [] }; },
          async run() {
            if (sql.includes('INSERT INTO sent_messages')) inserted.push(args);
            return { meta: { changes: 1, last_row_id: 1 } };
          },
        }; } };
      },
    };
    const { sendMessage } = await import('../src/tg.js');
    await sendMessage({ BOT_TOKEN: 't', DB: db }, 1, 'receipt', null, { ttl: 7200000 });
    const [, , , , deleteAfter] = inserted[0];
    expect(deleteAfter).toBeLessThanOrEqual(Date.now() + 7200000);
    expect(deleteAfter).toBeGreaterThan(Date.now() + 7000000);
  });
});

describe('Done together availability', () => {
  // Removing this from unscored reminders once cost a real reminder its shared
  // credit: the button simply was not there, so Done was tapped instead.
  it('offers Done together on reminders as well as chores', () => {
    for (const scored of [true, false]) {
      expect(nagButtons(7, scored).inline_keyboard[0].map((b) => b.text))
        .toEqual(['✅ Done', '🤝 Done together', '😴 Snooze…']);
    }
  });

  it('still names the delete button after the kind', () => {
    expect(nagButtons(7, true).inline_keyboard[1][0].text).toBe('🗑 Delete chore');
    expect(nagButtons(7, false).inline_keyboard[1][0].text).toBe('🗑 Delete reminder');
  });
});

describe('telling chores and reminders apart', () => {
  const calls = [];
  beforeEach(() => {
    calls.length = 0;
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      calls.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 99 } }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('flags a reminder on its nag, and leaves a chore unmarked', async () => {
    const { nagHtml } = await import('../src/nag.js');
    expect(nagHtml({ text: 'brush cattos teeth', scored: 0 }, 0)).toContain('reminder');
    expect(nagHtml({ text: 'clear poop', scored: 1 }, 0)).not.toContain('reminder');
  });

  it('flags a reminder on the pinned board', async () => {
    const base = {
      display_num: 1, paused: 0, next_fire_at: Date.now() + 3600000, schedule_kind: 'daily',
      schedule_detail: JSON.stringify({ h: 19, mi: 0 }), assignee_name: null,
    };
    const env = {
      BOT_TOKEN: 'token',
      DB: dbForDashboard([{ ...base, id: 1, text: 'clear poop', scored: 1 },
        { ...base, id: 2, text: 'brush cattos teeth', scored: 0 }]),
    };
    await updateDashboard(env, 1);
    const text = calls.find((c) => c.url.endsWith('/sendMessage')).body.text;
    const lines = text.split('\n');
    expect(lines.find((l) => l.includes('brush cattos teeth'))).toContain('<i>reminder</i>');
    expect(lines.find((l) => l.includes('clear poop'))).not.toContain('<i>reminder</i>');
  });
});
