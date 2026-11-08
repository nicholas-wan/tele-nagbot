// The speed pass (8 Nov 2026), held in place. Latency here is round trips —
// D1 in Marseille, Telegram in Amsterdam, both a network hop from the Worker
// — so these pin the shapes that keep them few: one intake batch per update,
// the toast before the redrawing, one board redraw per piece of work and
// after it, and the timezone read once. They go through the Worker's own
// entry points, since that is where the deferral lives.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import worker from '../src/index.js';
import { signInitData } from '../src/miniapp-auth.js';
import { d1 } from './d1.js';

const TOKEN = 'test';
const HOUR = 3600000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 10, 11, 30); // Sat 10 Oct 19:30 Asia/Singapore
const BOARD = 99;

let sql, env, calls, ops, tasks;
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  sql.exec(`INSERT INTO settings (chat_id, dashboard_msg_id) VALUES (1, ${BOARD})`);
  sql.exec(`INSERT INTO members (chat_id, user_id, username, first_name, last_seen) VALUES
    (1, 2, 'nicholaswan', 'Nick', 0), (1, 3, 'Dodgerblueee', 'Yx', 0)`);
  sql.exec(`INSERT INTO reminders (id, chat_id, display_num, text, schedule_kind, schedule_detail,
      nag_intervals, next_fire_at, paused, created_at, scored)
    VALUES (8, 1, 1, 'take out trash', 'daily', '{"h":20,"mi":0}', '[15,30,60]', NULL, 0, ${NOW - 30 * DAY}, 1),
           (9, 1, 2, 'water plants', 'daily', '{"h":9,"mi":0}', '[15,30,60]', ${NOW + 14 * HOUR}, 0, ${NOW - 30 * DAY}, 1)`);
  sql.exec(`INSERT INTO firings (id, reminder_id, chat_id, reminder_text, fired_at, state, nag_count,
      next_nag_at, last_message_id, scored)
    VALUES (5, 8, 1, 'take out trash', ${NOW - HOUR}, 'nagging', 1, ${NOW + HOUR}, 700, 1)`);
  // Every D1 call in order: a batch is one entry, as it is one round trip.
  ops = [];
  const db = d1(sql);
  env = {
    BOT_TOKEN: TOKEN, WEBHOOK_SECRET: 'hook', ALLOWED_CHATS: '1',
    DB: {
      prepare(query) {
        const wrap = (stmt) => ({
          ...stmt,
          bind: (...args) => wrap(stmt.bind(...args)),
          first: () => { ops.push({ kind: 'first', sql: query }); return stmt.first(); },
          all: () => { ops.push({ kind: 'all', sql: query }); return stmt.all(); },
          run: () => { ops.push({ kind: 'run', sql: query }); return stmt.run(); },
          query,
        });
        return wrap(db.prepare(query));
      },
      batch(statements) {
        ops.push({ kind: 'batch', sql: statements.map((s) => s.query) });
        return db.batch(statements);
      },
    },
  };
  calls = [];
  tasks = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    const entry = { method: String(url).split('/').pop(), body: JSON.parse(init.body), done: false };
    calls.push(entry);
    // A Telegram call takes real time, so none can have finished by the time
    // a toast that does not wait for it is sent.
    await new Promise((resolve) => setTimeout(resolve, 5));
    entry.done = true;
    return new Response(JSON.stringify({ ok: true, result: { message_id: 500 + calls.length } }));
  }));
});
afterEach(() => { sql.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const nick = { id: 2, first_name: 'Nick', username: 'nicholaswan' };
let updateId = 1000;
const ctx = () => ({ waitUntil: (task) => tasks.push(task) });
const settle = async () => { for (let i = 0; i < tasks.length; i++) await tasks[i]; };

async function tap(data, messageId = 700, update = {}) {
  const response = await worker.fetch(new Request('https://nag.test/webhook', {
    method: 'POST',
    headers: { 'X-Telegram-Bot-Api-Secret-Token': 'hook' },
    body: JSON.stringify({ update_id: update.update_id || updateId++, callback_query: {
      id: `cb-${data}`, data, from: update.from || nick, message: { message_id: messageId, chat: { id: 1 } },
    } }),
  }), env, ctx());
  const text = await response.text();
  return text === 'ok' ? null : JSON.parse(text);
}

const finished = (method) => calls.some((c) => c.method === method && c.done);
const boardEdits = () => calls.filter((c) => c.method === 'editMessageText' && c.body.message_id === BOARD);
const firing = () => sql.prepare('SELECT * FROM firings WHERE id = 5').get();

describe('the webhook intake', () => {
  it('stores, claims and records the sender in one round trip', async () => {
    await tap('d:5');
    await settle();
    expect(ops[0].kind).toBe('batch');
    expect(ops[0].sql.join('\n')).toMatch(/INSERT INTO webhook_updates[\s\S]*INSERT INTO members/);
    expect(sql.prepare('SELECT state FROM webhook_updates').get().state).toBe('done');
    expect(sql.prepare('SELECT last_seen FROM members WHERE user_id = 2').get().last_seen).toBe(NOW);
  });

  it('writes nothing for a repeated delivery, and only acknowledges it', async () => {
    await tap('d:5', 700, { update_id: 77 });
    await settle();
    Date.now.mockReturnValue(NOW + 60000);
    const answer = await tap('d:5', 700, { update_id: 77 });
    await settle();
    expect(answer.text).toBe('Already received 👍');
    expect(sql.prepare('SELECT last_seen FROM members WHERE user_id = 2').get().last_seen).toBe(NOW);
  });

  it('never puts a bot on the roster', async () => {
    await tap('ok', 900, { from: { id: 66, first_name: 'Robo', is_bot: true } });
    await settle();
    expect(sql.prepare('SELECT COUNT(*) AS n FROM members WHERE user_id = 66').get().n).toBe(0);
  });
});

describe('a tap is answered before the redrawing', () => {
  it('sends Purrs on the response before the card or the board is touched', async () => {
    const answer = await tap('d:5');
    expect(answer).toMatchObject({ method: 'answerCallbackQuery', text: 'Purrs 😻' });
    expect(finished('editMessageText')).toBe(false);
    await settle();
    // ...and the redrawing still happens, the board exactly once.
    expect(calls.find((c) => c.method === 'editMessageText' && c.body.message_id === 700).body.text)
      .toMatch(/done by @nicholaswan/);
    expect(boardEdits()).toHaveLength(1);
    expect(firing().state).toBe('done');
  });

  it('says Already handled when the Done was lost, and redraws nothing', async () => {
    sql.exec("UPDATE firings SET state = 'done' WHERE id = 5");
    const answer = await tap('d:5');
    await settle();
    expect(answer.text).toBe('Already handled 👍');
    expect(calls.some((c) => c.method === 'editMessageText')).toBe(false);
  });

  it('confirms a snooze before redrawing its card', async () => {
    const answer = await tap('z:5:60');
    expect(answer.text).toMatch(/^Snoozed until/);
    expect(finished('editMessageText')).toBe(false);
    await settle();
    expect(firing().snoozes_used).toBe(1);
    expect(boardEdits()).toHaveLength(1);
  });

  it('confirms a delete before the log and the board', async () => {
    const answer = await tap('x:5');
    expect(answer.text).toBe('Deleted 🗑 — tap ↩️ Undo in the chat if that was a slip.');
    expect(finished('sendMessage')).toBe(false);
    await settle();
    expect(calls.some((c) => c.method === 'sendMessage' && /deleted/.test(c.body.text))).toBe(true);
    expect(sql.prepare('SELECT COUNT(*) AS n FROM reminders WHERE id = 8').get().n).toBe(0);
  });
});

describe('the pinned board', () => {
  it('is redrawn once per update, however many steps asked', async () => {
    // A private editor's ⏸️ Pause: the pause redraws the board, and so does
    // the editor after it. One edit is enough.
    await tap('e:pause:9', 300);
    await settle();
    expect(sql.prepare('SELECT paused FROM reminders WHERE id = 9').get().paused).toBe(1);
    expect(boardEdits()).toHaveLength(1);
  });

  it('keeps the editor open when the editor lives on the pin', async () => {
    await tap('e:setnag:9:30', BOARD);
    await settle();
    const last = boardEdits().at(-1);
    expect(last.body.reply_markup.inline_keyboard.flat().some((b) => /^e:/.test(b.callback_data))).toBe(true);
  });

  it('is drawn from one round trip', async () => {
    await tap('d:5');
    await settle();
    const reads = ops.filter((o) => o.kind !== 'batch' && /FROM (reminders|settings|firings) WHERE chat_id/.test(o.sql));
    expect(reads.filter((o) => /paused_until|dashboard_msg_id/.test(o.sql))).toHaveLength(0);
  });
});

describe('the timezone', () => {
  it('is read once, not on every tap', async () => {
    await tap('z:5:60');
    await tap('z:5:120');
    await settle();
    expect(ops.filter((o) => /SELECT tz FROM settings/.test(String(o.sql)))).toHaveLength(1);
  });
});

describe('the Mini App', () => {
  async function app(path, body) {
    const fields = { auth_date: String(Math.floor(NOW / 1000)), start_param: 'g1', user: JSON.stringify(nick) };
    fields.hash = await signInitData(TOKEN, fields);
    const response = await worker.fetch(new Request(`https://nag.test/api/app/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `tma ${new URLSearchParams(fields)}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }), env, ctx());
    return response.json();
  }

  it('answers from one board read, and redraws the pin after, once', async () => {
    const reply = await app('chore/9/edit', { field: 'time', value: '20:00' });
    expect(reply.ok).toBe(true);
    expect(reply.chore.time).toBe('20:00');
    expect(reply.chores).toHaveLength(2);
    expect(boardEdits().some((c) => c.done)).toBe(false);
    await settle();
    expect(boardEdits()).toHaveLength(1);
    // The gate, the reply's board and the pin's redraw: three batches.
    expect(ops.filter((o) => o.kind === 'batch')).toHaveLength(3);
  });

  it('never turns a Done on a nag that has gone into a Done early on the next one', async () => {
    // Water plants (9) is not nagging: a Done the page sent for a live nag is
    // a second tap, or a nag finished from the chat meanwhile.
    const raced = await app('chore/9/done', { how: 'me', expect: 'now' });
    expect(raced.ok).toBe(false);
    expect(raced.message).toBe('Already handled 👍');
    expect(sql.prepare("SELECT COUNT(*) AS n FROM firings WHERE reminder_id = 9 AND state = 'done'").get().n).toBe(0);
    // Asked for plainly, it is the Done early it always was.
    expect((await app('chore/9/done', { how: 'me' })).ok).toBe(true);
    await settle();
    expect(sql.prepare("SELECT COUNT(*) AS n FROM firings WHERE reminder_id = 9 AND state = 'done'").get().n).toBe(1);
  });

  it('still refuses someone who is not in the household', async () => {
    sql.exec('DELETE FROM members WHERE user_id = 2');
    calls.length = 0;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { status: 'left' } }))));
    const reply = await app('chore/9/done', {});
    expect(reply.ok).toBe(false);
    expect(firing().state).toBe('nagging');
    expect(sql.prepare('SELECT COUNT(*) AS n FROM members WHERE user_id = 2').get().n).toBe(0);
  });

  it('refreshes the member\'s name as it lets them in', async () => {
    const renamed = { ...nick, username: 'nic' };
    const fields = { auth_date: String(Math.floor(NOW / 1000)), start_param: 'g1', user: JSON.stringify(renamed) };
    fields.hash = await signInitData(TOKEN, fields);
    const response = await worker.fetch(new Request('https://nag.test/api/app/chore/9/done', {
      method: 'POST',
      headers: { Authorization: `tma ${new URLSearchParams(fields)}`, 'Content-Type': 'application/json' },
      body: '{}',
    }), env, ctx());
    expect((await response.json()).ok).toBe(true);
    await settle();
    expect(sql.prepare('SELECT username FROM members WHERE user_id = 2').get().username).toBe('nic');
    expect(sql.prepare("SELECT done_by FROM firings WHERE reminder_id = 9 AND state = 'done'").get().done_by).toBe('@nic');
  });
});

describe('a Telegram call that never answers', () => {
  it('is cut off, and a private send is not then repeated in public', async () => {
    const { sendPrivate, replyCtx } = await import('../src/tg.js');
    const seen = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      seen.push(JSON.parse(init.body));
      expect(init.signal).toBeDefined();
      throw new DOMException('The operation timed out.', 'TimeoutError');
    }));
    const res = await sendPrivate(env, replyCtx(env, 1, 2), 'only for Nick');
    expect(res.ok).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0].receiver_user_id).toBe(2);
  });
});

describe('the cron tick', () => {
  const tick = async () => { await worker.scheduled({}, env, ctx()); await settle(); };

  it('finds out there is nothing to do in one round trip, cold or warm', async () => {
    sql.exec("UPDATE firings SET next_nag_at = next_nag_at + 86400000, fired_at = fired_at + 86400000");
    // The due check reads the chats' timezones and the webhook inbox too, and
    // the inbox's week-old rows wait for the 03:00 window.
    await tick();
    expect(ops).toHaveLength(1);
    expect(ops[0].kind).toBe('batch');
    ops.length = 0;
    await tick();
    expect(ops).toHaveLength(1);
    expect(calls).toHaveLength(0);
  });

  it('still fires a chore that is due, and redraws the board once', async () => {
    sql.exec(`UPDATE reminders SET next_fire_at = ${NOW - 1000} WHERE id = 9`);
    await tick();
    expect(sql.prepare("SELECT COUNT(*) AS n FROM firings WHERE reminder_id = 9 AND state = 'nagging'").get().n).toBe(1);
    expect(calls.some((c) => c.method === 'sendMessage' && /water plants/.test(c.body.text))).toBe(true);
    expect(boardEdits()).toHaveLength(1);
  });
});

// The chat review (8 Nov 2026): the changes that act, not just reword.
describe('chat polish', () => {
  async function say(text) {
    await worker.fetch(new Request('https://nag.test/webhook', {
      method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': 'hook' },
      body: JSON.stringify({ update_id: updateId++, message: {
        message_id: 900 + updateId, from: nick, chat: { id: 1 }, date: 0, text,
      } }),
    }), env, ctx());
    await settle();
  }

  it('puts ▶️ Resume on a chore paused on its own, and the button resumes it', async () => {
    await say('/pause take out trash');
    const card = calls.filter((c) => c.method === 'editMessageText' && c.body.message_id === 700).at(-1);
    expect(card.body.reply_markup.inline_keyboard.flat().map((b) => b.callback_data)).toEqual(['rs:8']);
    const answer = await tap('rs:8');
    await settle();
    expect(answer.text).toBe('Resumed ▶️');
    expect(sql.prepare('SELECT paused FROM reminders WHERE id = 8').get().paused).toBe(0);
  });

  it('tells the typer a nagging chore was resumed', async () => {
    sql.exec('UPDATE reminders SET paused = 1 WHERE id = 8');
    await say('/resume take out trash');
    expect(calls.some((c) => c.method === 'sendMessage' && /Resumed <b>take out trash<\/b> — it's nagging again/.test(c.body.text)))
      .toBe(true);
  });

  it('answers a bare "done" with two chores nagging by offering a Done for each', async () => {
    sql.exec(`INSERT INTO firings (id, reminder_id, chat_id, reminder_text, fired_at, state, next_nag_at, last_message_id, scored)
      VALUES (6, 9, 1, 'water plants', ${NOW - HOUR}, 'nagging', ${NOW + HOUR}, 701, 1)`);
    await say('done');
    const ask = calls.find((c) => c.method === 'sendMessage' && /which one/.test(c.body.text));
    expect(ask.body.reply_markup.inline_keyboard.map((row) => row[0].callback_data)).toEqual(['d:5', 'd:6', 'ok']);
  });

  it('lets an expired nag go quietly: the card comes down, the tombstone is silent', async () => {
    sql.exec(`UPDATE firings SET fired_at = ${NOW - 25 * HOUR}, next_nag_at = ${NOW - 60000} WHERE id = 5`);
    sql.exec(`UPDATE reminders SET next_fire_at = ${NOW + DAY} WHERE id = 8`);
    await worker.scheduled({}, env, ctx());
    await settle();
    expect(firing().state).toBe('expired');
    expect(calls.some((c) => c.method === 'deleteMessage' && c.body.message_id === 700)).toBe(true);
    const tomb = calls.find((c) => c.method === 'sendMessage' && /24 hours and nobody did it/.test(c.body.text));
    expect(tomb.body.text.startsWith('🪦')).toBe(true);
    expect(tomb.body.disable_notification).toBe(true);
  });
});
