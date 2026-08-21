// Ephemeral interactions (Bot API 10.2): private replies in a public group.
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { handleUpdate } from '../src/handlers.js';
import { fireReminder } from '../src/firing.js';
import { runCron } from '../src/cron.js';
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

  // Commands must NOT be ephemeral: Telegram never delivers an ephemeral
  // command to a bot with Group Privacy on, so registering one silently breaks
  // every command. Reply privacy comes from receiver_user_id instead.
  it('registers commands as ordinary, not ephemeral', async () => {
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
    for (const c of cmds) expect(c.is_ephemeral).toBeUndefined();
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

  // One confirmation, never two saying the same thing: an unassigned chore is
  // announced publicly and that public line IS the confirmation.
  it('confirms an unassigned chore once, publicly', async () => {
    await handleUpdate(env(), {
      message: {
        message_id: 5, chat: { id: 1 }, from: { id: 2, first_name: 'Nick' },
        text: '/chore water plants 7pm daily', entities: [],
      },
    });
    const sends = calls.filter((c) => c.url.endsWith('/sendMessage'));
    const announcement = sends.find((c) => !c.body.receiver_user_id && /added/.test(c.body.text || ''));
    expect(announcement).toBeTruthy();
    expect(announcement.body.text).toContain('water plants');
    // The Undo rides on the public line rather than a second private copy.
    expect(JSON.stringify(announcement.body.reply_markup)).toContain('u:');
    expect(sends.some((c) => c.body.receiver_user_id)).toBe(false);
  });

  // An assigned chore nags privately, so announcing it would leak exactly what
  // that nag is meant to keep between the bot and one person.
  it('stays quiet in the group when the chore is assigned to someone', async () => {
    await handleUpdate(env(), {
      message: {
        message_id: 5, chat: { id: 1 }, from: { id: 2, first_name: 'Nick' },
        text: '/remind @nicholaswan testing 7pm', entities: [],
      },
    });
    const sends = calls.filter((c) => c.url.endsWith('/sendMessage'));
    expect(sends.some((c) => !c.body.receiver_user_id && /added/.test(c.body.text || ''))).toBe(false);
    expect(sends.some((c) => c.body.receiver_user_id)).toBe(true);
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

  // An assigned chore nags only its assignee; an unassigned one is everyone's.
  function fireEnv(reminder, member) {
    return {
      BOT_TOKEN: 'token', ALLOWED_CHATS: '1',
      DB: {
        prepare(sql) {
          return {
            bind() {
              return {
                async first() {
                  if (sql.includes('FROM members')) return member;
                  if (sql.includes('SELECT tz')) return { tz: 'Asia/Singapore' };
                  if (sql.includes('dashboard_msg_id')) return { dashboard_msg_id: 99 };
                  return null;
                },
                async all() { return { results: [] }; },
                async run() { return { meta: { changes: 1, last_row_id: 77 } }; },
              };
            },
          };
        },
      },
    };
  }

  const CHORE = {
    id: 10, chat_id: 1, text: 'clear poop', schedule_kind: 'interval',
    schedule_detail: JSON.stringify({ h: 21, mi: 0, days: 8 }),
    nag_intervals: '[15,30,60]', next_fire_at: 1_600_000_000_000, scored: 1,
  };

  it('nags only the assignee when a chore is assigned', async () => {
    const env = fireEnv(null, { user_id: 246334575 });
    await fireReminder(env, { ...CHORE, assignee_name: '@nicholaswan', assignee_user_id: null },
      1_600_000_000_000, 'Asia/Singapore');
    const nag = calls.find((c) => c.url.endsWith('/sendMessage') && /clear poop/.test(c.body.text || ''));
    expect(nag.body.receiver_user_id).toBe(246334575);
    // A visible sticker beside an invisible nag would give the chore away.
    expect(calls.some((c) => c.url.endsWith('/sendSticker'))).toBe(false);
  });

  it('keeps an unassigned chore public', async () => {
    const env = fireEnv(null, null);
    await fireReminder(env, { ...CHORE, assignee_name: null, assignee_user_id: null },
      1_600_000_000_000, 'Asia/Singapore');
    const nag = calls.find((c) => c.url.endsWith('/sendMessage') && /clear poop/.test(c.body.text || ''));
    expect(nag.body.receiver_user_id).toBeUndefined();
  });

  it('EPHEMERAL=0 turns everything back to public', async () => {
    await handleUpdate({ ...env(), EPHEMERAL: '0' }, {
      message: { message_id: 5, chat: { id: 1 }, from: { id: 2, first_name: 'Nick' }, text: '/help' },
    });
    expect(find('sendMessage').body.receiver_user_id).toBeUndefined();
  });

  // Ephemeral and public message ids are separate sequences that can collide.
  // A 👍 on an ordinary public message must never complete an ephemeral nag
  // that happens to wear the same number.
  it('ignores a public reaction that collides with an ephemeral nag id', async () => {
    const firing = {
      id: 5, reminder_id: 10, chat_id: 1, state: 'nagging',
      last_message_id: 77, last_message_ephemeral: 1, nag_user_id: 2,
      snoozes_used: 0, nag_count: 0, fired_at: Date.now(), scored: 1,
    };
    const runs = [];
    const DB = {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async first() {
                if (sql.includes('FROM firings')) {
                  // One ephemeral nag with id 77: a correct lookup binds the
                  // ephemeral flag alongside the id and only matches on 1.
                  if (!sql.includes('last_message_ephemeral')) return firing;
                  return args[3] === 1 ? firing : null;
                }
                if (sql.includes('SELECT tz')) return { tz: 'Asia/Singapore' };
                if (sql.includes('FROM reminders')) return REMINDER;
                return null;
              },
              async all() { return { results: [] }; },
              async run() { runs.push(sql); return { meta: { changes: 1, last_row_id: 1 } }; },
            };
          },
        };
      },
    };
    await handleUpdate({ BOT_TOKEN: 'token', ALLOWED_CHATS: '1', DB }, {
      message_reaction: {
        chat: { id: 1 }, message_id: 77, user: { id: 2, first_name: 'Nick' },
        new_reaction: [{ type: 'emoji', emoji: '👍' }],
      },
    });
    expect(runs.some((sql) => sql.includes("state = 'done'"))).toBe(false);
  });

  // The draft sweep must not aim public edit/delete calls at ephemeral ids —
  // in the public sequence the same number is someone else's message. The
  // sent_messages sweep owns removing those.
  it('leaves ephemeral wizard messages to the sent-messages sweep', async () => {
    const stmt = (sql, drafts) => ({
      async first() { return null; },
      async all() {
        if (sql.includes('FROM drafts')) return { results: drafts };
        return { results: [] };
      },
      async run() { return { meta: { changes: 1 } }; },
    });
    const cronDb = (drafts) => ({
      prepare(sql) { return { ...stmt(sql, drafts), bind: () => stmt(sql, drafts) }; },
    });
    const draft = {
      id: 1, chat_id: 1, text: 'laundry',
      wizard_msg_id: 77, wizard_msg_ephemeral: 1,
      prompt_msg_id: 78, prompt_msg_ephemeral: 1,
    };
    await runCron({ BOT_TOKEN: 'token', DB: cronDb([draft]) });
    expect(find('editMessageText')).toBeUndefined();
    expect(find('deleteMessage')).toBeUndefined();

    calls.length = 0;
    // A draft whose messages were genuinely public still gets tidied here.
    await runCron({
      BOT_TOKEN: 'token',
      DB: cronDb([{ ...draft, wizard_msg_ephemeral: 0, prompt_msg_ephemeral: 0 }]),
    });
    expect(find('editMessageText').body.message_id).toBe(77);
    expect(find('deleteMessage').body.message_id).toBe(78);
  });
});
