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
