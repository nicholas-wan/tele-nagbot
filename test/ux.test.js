import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { handleUpdate, nagButtons, updateDashboard } from '../src/handlers.js';

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
    const { nagHtml } = await import('../src/handlers.js');
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
