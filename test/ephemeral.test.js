// Ephemeral interactions (Bot API 10.2): private replies in a public group.
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { handleUpdate } from '../src/handlers.js';
import worker from '../src/index.js';

const REMINDER = {
  id: 10, chat_id: 1, display_num: 3, text: 'Water plants', paused: 0,
  next_fire_at: Date.now() + 3600000, schedule_kind: 'daily', nag_intervals: '[15,30,60]',
  schedule_detail: JSON.stringify({ h: 19, mi: 0 }), assignee_name: null, scored: 1,
};

function db(reminder = REMINDER) {
  return {
    prepare(sql) {
      return {
        bind() {
          return {
            async first() {
              if (sql.includes('dashboard_msg_id')) return { dashboard_msg_id: 99, tz: 'Asia/Singapore' };
              if (sql.includes('SELECT tz')) return { tz: 'Asia/Singapore' };
              if (sql.includes('FROM reminders')) return reminder;
              return null;
            },
            async all() {
              if (sql.includes('FROM reminders')) return { results: reminder ? [reminder] : [] };
              return { results: [] };
            },
            async run() { return { meta: { changes: 1, last_row_id: 1 } }; },
          };
        },
      };
    },
  };
}

const env = () => ({ BOT_TOKEN: 'token', ALLOWED_CHATS: '1', DB: db() });

describe('ephemeral interactions', () => {
  const calls = [];

  beforeEach(() => {
    calls.length = 0;
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const body = init && init.body ? JSON.parse(init.body) : null;
      calls.push({ url: String(url), body });
      // Mirror Telegram: an ephemeral send reports message_id 0 plus its own id.
      const result = body && body.receiver_user_id
        ? { message_id: 0, ephemeral_message_id: 77 }
        : { message_id: 99 };
      return new Response(JSON.stringify({ ok: true, result }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }));
  });

  afterEach(() => vi.unstubAllGlobals());

  const find = (method) => calls.find((c) => c.url.endsWith(`/${method}`));

  it('registers every command as ephemeral', async () => {
    const res = await worker.fetch(
      new Request('https://bot.example/setup', {
        method: 'POST', headers: { Authorization: 'Bearer admin' },
      }),
      { BOT_TOKEN: 'token', ADMIN_SECRET: 'admin', WEBHOOK_SECRET: 'hook' },
      { waitUntil() {} }
    );
    expect(res.status).toBe(200);
    const cmds = find('setMyCommands').body.commands;
    expect(cmds.length).toBeGreaterThan(0);
    for (const c of cmds) expect(c.is_ephemeral).toBe(true);
  });

  it('addresses command replies to the requester', async () => {
    await handleUpdate(env(), {
      message: { message_id: 5, chat: { id: 1 }, from: { id: 2, first_name: 'Nick' }, text: '/help' },
    });
    const sent = find('sendMessage');
    expect(sent.body.receiver_user_id).toBe(2);
    expect(sent.body.chat_id).toBe(1);
  });

  it('carries the callback id so a tap can be answered privately', async () => {
    await handleUpdate(env(), {
      callback_query: {
        id: 'cb1', data: 'h:more', from: { id: 2, first_name: 'Nick' },
        message: { message_id: 0, ephemeral_message_id: 77, chat: { id: 1 } },
      },
    });
    const edited = find('editEphemeralMessageText');
    expect(edited.body.receiver_user_id).toBe(2);
  });

  it('edits an ephemeral message with editEphemeralMessageText', async () => {
    await handleUpdate(env(), {
      callback_query: {
        id: 'cb2', data: 'h:home', from: { id: 2, first_name: 'Nick' },
        message: { message_id: 0, ephemeral_message_id: 77, chat: { id: 1 } },
      },
    });
    const edited = find('editEphemeralMessageText');
    expect(edited).toBeTruthy();
    expect(edited.body.ephemeral_message_id).toBe(77);
    expect(edited.body.receiver_user_id).toBe(2);
    // The public edit methods must not be used on an ephemeral message.
    expect(find('editMessageText')).toBeUndefined();
  });

  it('drives Manage inside the pinned dashboard, not a private message', async () => {
    await handleUpdate(env(), {
      callback_query: {
        id: 'cb3', data: 'm:list', from: { id: 2, first_name: 'Nick' },
        message: { message_id: 99, chat: { id: 1 }, text: 'dashboard' },
      },
    });
    const edited = find('editMessageReplyMarkup');
    expect(edited.body.message_id).toBe(99);
    const first = edited.body.reply_markup.inline_keyboard[0][0];
    expect(first.callback_data).toBe('m:item:10');
    expect(first.text).toContain('Water plants');
    expect(first.text).not.toContain('#3');
    // Manage is a shared surface: nothing about it is sent privately.
    expect(calls.some((c) => c.url.endsWith('/sendMessage') && c.body.receiver_user_id)).toBe(false);
  });

  it('deletes a legacy public command but never an ephemeral one', async () => {
    await handleUpdate(env(), {
      message: { message_id: 5, chat: { id: 1 }, from: { id: 2, first_name: 'Nick' }, text: '/list' },
    });
    expect(calls.some((c) => c.url.endsWith('/deleteMessage') && c.body.message_id === 5)).toBe(true);

    calls.length = 0;
    // An ephemeral command reports message_id 0 — there is no public copy to
    // remove, and deleteMessage(0) would be an error.
    await handleUpdate(env(), {
      message: {
        message_id: 0, ephemeral_message_id: 42, chat: { id: 1 },
        from: { id: 2, first_name: 'Nick' }, text: '/list',
      },
    });
    expect(calls.some((c) => c.url.endsWith('/deleteMessage'))).toBe(false);
  });

  it('announces a new chore publicly even though the confirmation is private', async () => {
    await handleUpdate(env(), {
      message: {
        message_id: 5, chat: { id: 1 }, from: { id: 2, first_name: 'Nick' },
        text: '/chore water plants 7pm daily', entities: [],
      },
    });
    const sends = calls.filter((c) => c.url.endsWith('/sendMessage'));
    const confirmation = sends.find((c) => c.body.receiver_user_id);
    const announcement = sends.find((c) => !c.body.receiver_user_id && /added/.test(c.body.text || ''));
    expect(confirmation).toBeTruthy();
    expect(announcement).toBeTruthy();
    expect(announcement.body.text).toContain('water plants');
  });

  it('falls back to a public reply when ephemeral delivery is refused', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const body = init && init.body ? JSON.parse(init.body) : null;
      calls.push({ url: String(url), body });
      if (body && body.receiver_user_id) {
        return new Response(JSON.stringify({ ok: false, error_code: 400, description: 'user is offline' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 99 } }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }));
    await handleUpdate(env(), {
      message: { message_id: 5, chat: { id: 1 }, from: { id: 2, first_name: 'Nick' }, text: '/help' },
    });
    const sends = calls.filter((c) => c.url.endsWith('/sendMessage'));
    expect(sends.some((c) => c.body.receiver_user_id)).toBe(true);
    expect(sends.some((c) => !c.body.receiver_user_id)).toBe(true);
  });

  it('EPHEMERAL=0 turns everything back to public', async () => {
    await handleUpdate({ ...env(), EPHEMERAL: '0' }, {
      message: { message_id: 5, chat: { id: 1 }, from: { id: 2, first_name: 'Nick' }, text: '/help' },
    });
    expect(find('sendMessage').body.receiver_user_id).toBeUndefined();
  });
});
