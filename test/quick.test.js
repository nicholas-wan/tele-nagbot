// The quick-log pad (15 Nov 2026): a pinned message of one-tap buttons for
// jobs that are not scheduled chores. Real SQLite behind the D1 shim.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { handleUpdate } from '../src/handlers.js';
import { statsHtml } from '../src/stats.js';
import { quickLabel, QUICK_MAX } from '../src/quick.js';
import { d1 } from './d1.js';

const NOW = Date.parse('2026-11-25T12:00:00+08:00'); // a Wednesday inside the Poppy bonus
const TZ = 'Asia/Singapore';

let sql, env, calls, nextId;
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  sql.exec('INSERT INTO settings (chat_id) VALUES (1)');
  sql.exec(`INSERT INTO members (chat_id, user_id, username, first_name, last_seen) VALUES
    (1, 2, 'nicholaswan', 'Nick', 0), (1, 3, 'Dodgerblueee', 'Yx', 0)`);
  env = { BOT_TOKEN: 'test', ALLOWED_CHATS: '1', DB: d1(sql) };
  calls = [];
  nextId = 500;
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body });
    const result = String(url).endsWith('/getChatMember') ? { status: 'member' } : { message_id: nextId++ };
    return new Response(JSON.stringify({ ok: true, result }));
  }));
});
afterEach(() => { sql.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const yx = { id: 3, first_name: 'Yx', username: 'Dodgerblueee' };
const nick = { id: 2, first_name: 'Nick', username: 'nicholaswan' };
const command = (text, from = nick) => handleUpdate(env, {
  message: { message_id: 7, chat: { id: 1, type: 'supergroup' }, from, text },
});
const tap = (data, from = yx, messageId = 500) => handleUpdate(env, { callback_query: {
  id: 'tap', data, from, message: { chat: { id: 1 }, message_id: messageId, text: 'pad' },
} });
const sentTo = (method) => calls.filter((c) => c.url.endsWith(`/${method}`));
const toast = () => sentTo('answerCallbackQuery').at(-1).body.text;
const padId = () => sql.prepare('SELECT quick_msg_id FROM settings WHERE chat_id = 1').get().quick_msg_id;
const buttons = () => sql.prepare('SELECT id, text FROM quick_taps ORDER BY id').all();
const quickLogs = () => sql.prepare('SELECT * FROM firings WHERE reminder_id = 0').all();

async function setUp() {
  await command('/quick add vacuum');
  await command('/quick add laundry');
  calls.length = 0;
}

describe('the pad', () => {
  it('is sent, pinned and kept off the sweep by the first /quick add', async () => {
    await command('/quick add vacuum');
    const pad = sentTo('sendMessage').find((c) => /Quick log/.test(c.body.text));
    expect(pad.body.reply_markup.inline_keyboard).toEqual([[{ text: '🧹 Vacuum', callback_data: `q:${buttons()[0].id}` }]]);
    expect(sentTo('pinChatMessage').map((c) => c.body.message_id)).toEqual([padId()]);
    expect(sql.prepare('SELECT COUNT(*) AS n FROM sent_messages WHERE message_id = ?').get(padId()).n).toBe(0);
  });

  it('redraws in place as buttons are added, two to a row', async () => {
    await setUp();
    await command('/quick add mop the kitchen');
    expect(sentTo('sendMessage').filter((c) => /Quick log/.test(c.body.text))).toHaveLength(0);
    const edit = sentTo('editMessageText').at(-1);
    expect(edit.body.message_id).toBe(padId());
    expect(edit.body.reply_markup.inline_keyboard.map((row) => row.map((b) => b.text)))
      .toEqual([['🧹 Vacuum', '🧺 Laundry'], ['🧹 Mop the kitchen']]);
  });

  it('refuses a duplicate in any case, and a ninth button', async () => {
    await setUp();
    await command('/quick add Vacuum');
    expect(sentTo('sendMessage').at(-1).body.text).toContain('already on the pad');
    for (let i = buttons().length; i < QUICK_MAX; i++) await command(`/quick add job ${i}`);
    await command('/quick add one too many');
    expect(sentTo('sendMessage').at(-1).body.text).toContain(`holds ${QUICK_MAX} buttons`);
    expect(buttons()).toHaveLength(QUICK_MAX);
  });

  it('loses a button to /quick remove, and goes away with the last one', async () => {
    await setUp();
    const pad = padId();
    await command('/quick remove VACUUM');
    expect(buttons().map((b) => b.text)).toEqual(['laundry']);
    await command('/quick remove laundry');
    expect(sentTo('unpinChatMessage').map((c) => c.body.message_id)).toEqual([pad]);
    expect(sentTo('deleteMessage').map((c) => c.body.message_id)).toContain(pad);
    expect(padId()).toBe(null);
  });

  it('is re-pinned by a bare /quick, and replaced only when it is gone', async () => {
    await setUp();
    await command('/quick');
    expect(sentTo('pinChatMessage').map((c) => c.body.message_id)).toEqual([padId()]);
    // A blip keeps the pad; a deleted pad is sent again.
    fetch.mockImplementationOnce(async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: false, description: 'Too Many Requests' }));
    });
    const before = padId();
    await command('/quick add dust');
    expect(padId()).toBe(before);
    fetch.mockImplementationOnce(async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: false, description: 'Bad Request: message to edit not found' }));
    });
    await command('/quick add sweep');
    expect(padId()).not.toBe(before);
  });
});

describe('a tap', () => {
  it('logs one done job for whoever tapped, with a receipt that can take it back', async () => {
    await setUp();
    await tap(`q:${buttons()[0].id}`);
    expect(quickLogs()).toMatchObject([{ reminder_text: 'vacuum', state: 'done', done_by: '@Dodgerblueee', done_at: NOW, scored: 1 }]);
    expect(toast()).toBe('🧹 Vacuum: logged, 1 ✅');
    const receipt = sentTo('sendMessage').at(-1);
    expect(receipt.body.text).toBe('😻 <s>🧹 Vacuum</s> — done by @Dodgerblueee at 12:00 PM.');
    const undo = receipt.body.reply_markup.inline_keyboard[0][0];
    expect(undo).toEqual({ text: '↩️ Not done', callback_data: `qu:${quickLogs()[0].id}` });

    await tap(undo.callback_data, nick, 501);
    expect(quickLogs()).toEqual([]);
    expect(toast()).toBe('Taken back ↩️');
    expect(sentTo('editMessageText').at(-1).body.text).toBe('↩️ <b>🧹 Vacuum</b> — not done after all, says @nicholaswan.');
  });

  it('counts the same job by the same person once an hour, but by someone else twice', async () => {
    await setUp();
    const id = buttons()[1].id;
    await tap(`q:${id}`);
    await tap(`q:${id}`);
    expect(toast()).toBe('You logged that in the last hour already.');
    await tap(`q:${id}`, nick);
    Date.now.mockReturnValue(NOW + 59 * 60000);
    await tap(`q:${id}`);
    expect(toast()).toBe('You logged that in the last hour already.');
    Date.now.mockReturnValue(NOW + 61 * 60000);
    await tap(`q:${id}`);
    expect(quickLogs().map((f) => f.done_by)).toEqual(['@Dodgerblueee', '@nicholaswan', '@Dodgerblueee']);
  });

  it('scores 1 ✅ on the board, never the Poppy bonus', async () => {
    await setUp();
    await tap(`q:${buttons()[0].id}`);
    const html = await statsHtml(env, 1, TZ, 'week');
    expect(html).toContain('🥇 <b>@Dodgerblueee</b> — 1 ✅');
    expect(html).toContain('🧹 vacuum');
  });

  it('answers a removed button and redraws the pad without it', async () => {
    await setUp();
    const [vacuum] = buttons();
    sql.prepare('DELETE FROM quick_taps WHERE id = ?').run(vacuum.id);
    await tap(`q:${vacuum.id}`);
    expect(toast()).toBe('That button is gone.');
    expect(quickLogs()).toEqual([]);
    expect(sentTo('editMessageText').at(-1).body.reply_markup.inline_keyboard).toEqual([[{ text: '🧺 Laundry', callback_data: `q:${buttons()[0].id}` }]]);
  });

  it('cannot take back a chore, or a log from another chat, or one past the window', async () => {
    await setUp();
    sql.exec(`INSERT INTO firings (id, reminder_id, chat_id, reminder_text, fired_at, state, done_by, done_at, scored)
      VALUES (90, 8, 1, 'clear poop', ${NOW}, 'done', '@Dodgerblueee', ${NOW}, 1),
             (91, 0, 2, 'vacuum', ${NOW}, 'done', '@Dodgerblueee', ${NOW}, 1),
             (92, 0, 1, 'vacuum', ${NOW - 2 * 86400000}, 'done', '@Dodgerblueee', ${NOW - 2 * 86400000}, 1)`);
    const answers = [];
    for (const id of [90, 91, 92]) {
      await tap(`qu:${id}`);
      answers.push(toast());
    }
    expect(answers).toEqual(['Nothing to take back.', 'Already taken back.', 'Too late to take that back.']);
    expect(sql.prepare('SELECT COUNT(*) AS n FROM firings').get().n).toBe(3);
  });

  it('says a second ↩️ already took it back', async () => {
    await setUp();
    await tap(`q:${buttons()[0].id}`);
    const id = quickLogs()[0].id;
    await tap(`qu:${id}`, nick, 501);
    await tap(`qu:${id}`, nick, 501);
    expect(toast()).toBe('Already taken back.');
  });

  it('logs nothing for a button from another chat', async () => {
    await setUp();
    sql.prepare("INSERT INTO quick_taps (chat_id, text, created_at) VALUES (2, 'mop', 0)").run();
    const other = sql.prepare('SELECT id FROM quick_taps WHERE chat_id = 2').get().id;
    await tap(`q:${other}`);
    expect(toast()).toBe('That button is gone.');
    expect(quickLogs()).toEqual([]);
  });

  it('scores 1 in the winning streak, never the bonus', async () => {
    await setUp();
    // Last week: her one chore against his two quick taps of laundry would
    // win it only if her quick taps were doubled; here his chores decide.
    const lastWeek = NOW - 6 * 86400000;
    Date.now.mockReturnValue(lastWeek);
    await tap(`q:${buttons()[0].id}`);
    await tap(`q:${buttons()[1].id}`);
    await tap(`q:${buttons()[0].id}`, nick);
    Date.now.mockReturnValue(NOW);
    const { streakFrom, streakStatement } = await import('../src/stats.js');
    const { results } = await streakStatement(env, 1, TZ).all();
    expect(results.every((r) => r.reminder_id === 0)).toBe(true);
    // Two taps against one: hers count 2, not 4, so she won it outright.
    expect(streakFrom(results, TZ, '@Dodgerblueee')).toBe(1);
    expect(streakFrom([...results, { done_by: '@nicholaswan', done_at: lastWeek, reminder_id: 0 }], TZ, '@Dodgerblueee')).toBe(0);
  });
});

describe('pins', () => {
  it('keeps the chore board the top pin: the pad goes under it', async () => {
    sql.exec('UPDATE settings SET dashboard_msg_id = 42 WHERE chat_id = 1');
    await command('/quick add vacuum');
    expect(sentTo('pinChatMessage').map((c) => c.body.message_id)).toEqual([padId(), 42]);
    calls.length = 0;
    await command('/quick');
    expect(sentTo('pinChatMessage').map((c) => c.body.message_id)).toEqual([padId(), 42]);
    expect(sentTo('sendMessage').at(-1).body.text).toBe('📌 Quick log pad pinned, under the chore board.');
  });

  it('says so when it cannot pin, rather than claiming it did', async () => {
    fetch.mockImplementation(async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url: String(url), body });
      if (String(url).endsWith('/pinChatMessage')) {
        return new Response(JSON.stringify({ ok: false, description: 'Bad Request: not enough rights to manage pinned messages' }));
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: nextId++ } }));
    });
    await command('/quick add vacuum');
    expect(sentTo('sendMessage').at(-1).body.text).toContain('Pin Messages admin right');
    await command('/quick');
    expect(sentTo('sendMessage').at(-1).body.text).toBe('The pad is there, but I could not pin it: give me the Pin Messages admin right, then send /quick.');
  });

  it('leaves one pad when two draws race to create it', async () => {
    sql.prepare("INSERT INTO quick_taps (chat_id, text, created_at) VALUES (1, 'vacuum', 0)").run();
    // Another draw claims its pad while this one is sending.
    fetch.mockImplementation(async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url: String(url), body });
      if (String(url).endsWith('/sendMessage') && /Quick log/.test(body.text)) {
        sql.exec('UPDATE settings SET quick_msg_id = 777 WHERE chat_id = 1');
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: nextId++ } }));
    });
    const { drawPad } = await import('../src/quick.js');
    await drawPad(env, 1);
    expect(padId()).toBe(777);
    expect(sentTo('deleteMessage').map((c) => c.body.message_id)).toEqual([500]);
    expect(sentTo('pinChatMessage')).toEqual([]);
  });

  it('is spared, redrawn and re-pinned under the board by POST /admin?board', async () => {
    const worker = (await import('../src/index.js')).default;
    await setUp();
    const pad = padId();
    sql.exec('UPDATE settings SET dashboard_msg_id = 42 WHERE chat_id = 1');
    // A chore, so the board has something to show and stays.
    sql.prepare(`INSERT INTO reminders (id, chat_id, display_num, text, schedule_kind, schedule_detail,
      nag_intervals, next_fire_at, paused, created_at, scored) VALUES (8, 1, 1, 'slutbed', 'interval',
      '{"days":7,"h":19,"mi":0}', '[15,30,60]', ?, 0, ?, 1)`).run(NOW + 86400000, NOW - 86400000);
    // The pin stack, top first: the board, the pad, a stale board.
    const stack = [42, pad, 41];
    fetch.mockImplementation(async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url: String(url), body });
      const method = String(url).split('/').at(-1);
      if (method === 'getMe') return new Response(JSON.stringify({ ok: true, result: { id: 99 } }));
      if (method === 'getChat') {
        const top = stack[0];
        return new Response(JSON.stringify({ ok: true, result: top ? { pinned_message: { message_id: top, from: { id: 99 } } } : {} }));
      }
      if (method === 'unpinChatMessage') stack.splice(stack.indexOf(body.message_id), 1);
      return new Response(JSON.stringify({ ok: true, result: { message_id: nextId++ } }));
    });
    const res = await worker.fetch(new Request('https://nag.test/admin?board', {
      method: 'POST', headers: { Authorization: 'Bearer s3cret' },
    }), { ...env, ADMIN_SECRET: 's3cret' }, { waitUntil: () => {} });
    expect(await res.text()).toContain(`quick_msg_id=${pad}`);
    expect(sentTo('deleteMessage').map((c) => c.body.message_id)).toEqual([41]);
    expect(sentTo('pinChatMessage').map((c) => c.body.message_id).slice(-2)).toEqual([pad, 42]);
  });
});

it('labels a job with the board emoji, or its own', () => {
  expect(quickLabel('vacuum')).toBe('🧹 Vacuum');
  expect(quickLabel('laundry')).toBe('🧺 Laundry');
  expect(quickLabel('🪴 water plants')).toBe('🪴 water plants');
  expect(quickLabel('call grandma')).toBe('📞 Call grandma');
  expect(quickLabel('fix the hinge')).toBe('Fix the hinge');
});

it('matches a job typed with the emoji its button shows', async () => {
  const { quickText } = await import('../src/quick.js');
  expect(quickText('🧹  Vacuum ')).toBe('Vacuum');
  expect(quickText('🧺 laundry')).toBe('laundry');
  expect(quickText('🦄 water plants')).toBe('🦄 water plants');
  expect(quickText('🧹 laundry')).toBe('🧹 laundry');
  await command('/quick add vacuum');
  await command('/quick add 🧹 Vacuum');
  expect(sentTo('sendMessage').at(-1).body.text).toContain('already on the pad');
  await command('/quick remove 🧹 Vacuum');
  expect(buttons()).toEqual([]);
});
