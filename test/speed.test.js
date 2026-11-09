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

let sql, env, calls, ops, tasks, answered;
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
  // Each call answers a timer tick later, as a network call would, and is
  // stamped with how many calls had answered when it started: calls that
  // start before any of their neighbours answers share a `wave`, which is one
  // round trip of waiting however many run side by side.
  ops = [];
  answered = 0;
  const db = d1(sql);
  const slow = (entry, work) => {
    ops.push({ ...entry, wave: answered });
    return new Promise((resolve) => setTimeout(resolve, 0)).then(work).finally(() => { answered++; });
  };
  env = {
    BOT_TOKEN: TOKEN, WEBHOOK_SECRET: 'hook', ALLOWED_CHATS: '1',
    DB: {
      prepare(query) {
        const wrap = (stmt) => ({
          ...stmt,
          bind: (...args) => wrap(stmt.bind(...args)),
          first: () => slow({ kind: 'first', sql: query }, () => stmt.first()),
          all: () => slow({ kind: 'all', sql: query }, () => stmt.all()),
          run: () => slow({ kind: 'run', sql: query }, () => stmt.run()),
          query,
        });
        return wrap(db.prepare(query));
      },
      batch(statements) {
        return slow({ kind: 'batch', sql: statements.map((s) => s.query) }, () => db.batch(statements));
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
// Work a test left running after its answer finishes before the database
// closes, so none of it lands in the next test's counts.
afterEach(async () => {
  for (let i = 0; i < tasks.length; i++) await tasks[i].catch(() => {});
  sql.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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

  // 9 Nov 2026: this used to be the silent tombstone. Nothing expires now —
  // the day-old nag comes down and the ⏰ card goes up in its place, hourly.
  it('turns a day-old nag into the ⏰ card instead of a tombstone', async () => {
    sql.exec(`UPDATE firings SET fired_at = ${NOW - 25 * HOUR}, next_nag_at = ${NOW - 60000} WHERE id = 5`);
    sql.exec(`UPDATE reminders SET next_fire_at = ${NOW + DAY} WHERE id = 8`);
    await worker.scheduled({}, env, ctx());
    await settle();
    expect(firing()).toMatchObject({ state: 'nagging', next_nag_at: NOW + HOUR });
    expect(calls.some((c) => c.method === 'deleteMessage' && c.body.message_id === 700)).toBe(true);
    expect(calls.some((c) => c.method === 'sendMessage' && /🪦|24 hours and nobody did it/.test(c.body.text))).toBe(false);
    const card = calls.find((c) => c.method === 'sendMessage' && /take out trash/.test(c.body.text));
    expect(card.body.text.startsWith('⏰')).toBe(true);
  });
});

// The second speed pass (8 Nov 2026, afternoon): every flow it changed, pinned
// by its round trips. A round trip is a `wave` of D1 calls (see beforeEach):
// calls started side by side cost one wait between them.
const waves = (list = ops) => new Set(list.map((o) => o.wave)).size;

describe('round trips before the toast', () => {
  // Through the update runner rather than the webhook, so the toast goes to
  // Telegram as its own call: the waves before that call are what the tapper
  // waited for, on top of the intake's one batch (pinned above).
  async function wavesBeforeToast(data, { messageId = 700, from = nick, chatId = 1 } = {}) {
    const { runClaimedUpdate } = await import('../src/updates.js');
    const inner = globalThis.fetch;
    let seen = null;
    let text = null;
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (seen == null && String(url).endsWith('/answerCallbackQuery')) {
        seen = waves();
        text = JSON.parse(init.body).text;
      }
      return inner(url, init);
    }));
    ops.length = 0;
    await runClaimedUpdate(env, { update_id: updateId++, callback_query: {
      id: `cb-${data}`, data, from, message: { message_id: messageId, chat: { id: chatId } },
    } }, { memberRecorded: true });
    await settle();
    vi.stubGlobal('fetch', inner);
    return { waves: seen, text };
  }
  const warmTz = async () => { const { getTz } = await import('../src/household.js'); await getTz(env, 1); };

  it('✅ Done and 🤝 Done together: one, the claim sent with its reads', async () => {
    expect(await wavesBeforeToast('d:5')).toEqual({ waves: 1, text: 'Purrs 😻' });
    expect(firing().state).toBe('done');
    sql.exec("UPDATE firings SET state = 'nagging', done_by = NULL, done_at = NULL WHERE id = 5");
    expect((await wavesBeforeToast('b:5')).waves).toBe(1);
    expect(firing().done_by).toBe('@nicholaswan & @Dodgerblueee');
  });

  it('😴 a snooze preset: one', async () => {
    await warmTz();
    const { waves: n, text } = await wavesBeforeToast('z:5:60');
    expect(n).toBe(1);
    expect(text).toMatch(/^Snoozed until .* · 2 snoozes left$/);
    expect(firing()).toMatchObject({ snoozes_used: 1, next_nag_at: NOW + HOUR, snoozed_until: NOW + HOUR });
  });

  // Until 9 Nov 2026 this snooze was capped a minute before the 24h expiry,
  // "as late as it goes". Nothing expires, so it runs as chosen.
  it('honours a snooze that crosses the 24h mark in full, in the same single write', async () => {
    await warmTz();
    sql.exec(`UPDATE firings SET fired_at = ${NOW - 23 * HOUR} WHERE id = 5`);
    const { waves: n, text } = await wavesBeforeToast('z:5:180');
    expect(n).toBe(1);
    expect(text).toMatch(/^Snoozed until .* · 2 snoozes left$/);
    expect(firing().next_nag_at).toBe(NOW + 3 * HOUR);
  });

  it('still refuses another household, and another member\'s private nag, in the claim itself', async () => {
    env.ALLOWED_CHATS = '1,2';
    expect((await wavesBeforeToast('d:5', { chatId: 2 })).text).toBe('Already handled 👍');
    expect((await wavesBeforeToast('z:5:60', { chatId: 2 })).text).toBe('Already handled 👍');
    sql.exec('UPDATE firings SET last_message_ephemeral = 1, nag_user_id = 3 WHERE id = 5');
    expect((await wavesBeforeToast('d:5')).text).toBe('That nag is someone else\'s 🙈');
    expect((await wavesBeforeToast('z:5:60')).text).toBe('That nag is someone else\'s 🙈');
    expect(firing()).toMatchObject({ state: 'nagging', snoozes_used: 0 });
  });

  it('✅ on the 8am digest: one, as on the nag; on a confirmation: two; Manage → Done: as soon as it is won', async () => {
    expect(await wavesBeforeToast('dg:5', { messageId: 300 })).toEqual({
      waves: 1, text: 'Purrs 😻 — ↩️ Not done is right there if that was a slip',
    });
    expect(firing().state).toBe('done');
    expect((await wavesBeforeToast('dg:5', { messageId: 300 })).text).toBe('Already handled 👍');
    // Done early from the confirmation of chore 9: its reads, then the claim.
    expect(await wavesBeforeToast('c:9', { messageId: 300 })).toEqual({ waves: 2, text: 'Purrs 😻' });
    expect(sql.prepare("SELECT COUNT(*) AS n FROM firings WHERE reminder_id = 9 AND state = 'done'").get().n).toBe(1);
    // The board's Manage → Done: the toast goes before the receipt is sent.
    sql.exec("UPDATE firings SET state = 'nagging', done_by = NULL, done_at = NULL WHERE id = 5");
    const inner = globalThis.fetch;
    let receiptFirst = null;
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const method = String(url).split('/').pop();
      if (receiptFirst == null && (method === 'answerCallbackQuery' || method === 'editMessageText')) {
        receiptFirst = method === 'editMessageText';
      }
      return inner(url, init);
    }));
    expect((await wavesBeforeToast('m:done:8', { messageId: BOARD })).text).toBe('Purrs 😻');
    expect(receiptFirst).toBe(false);
    expect(firing().state).toBe('done');
  });

  it('🗑 Delete on a nag: one, the removal sent with its reads, and its Undo puts the row back as it was', async () => {
    const before = sql.prepare('SELECT * FROM reminders WHERE id = 8').get();
    expect(await wavesBeforeToast('x:5')).toEqual({
      waves: 1, text: 'Deleted 🗑 — tap ↩️ Undo in the chat if that was a slip.',
    });
    expect(sql.prepare('SELECT COUNT(*) AS n FROM reminders WHERE id = 8').get().n).toBe(0);
    expect(sql.prepare('SELECT COUNT(*) AS n FROM firings WHERE id = 5').get().n).toBe(0);
    expect(calls.some((c) => c.method === 'deleteMessage' && c.body.message_id === 700)).toBe(true);
    // The stash is built in SQL from the row the delete found.
    const stash = sql.prepare('SELECT * FROM trash ORDER BY id DESC').get();
    const { _log: log, ...payload } = JSON.parse(stash.payload);
    expect(payload).toEqual(before);
    expect(log).toBeTruthy(); // the log's id, for an Undo from the Mini App
    await wavesBeforeToast(`t:${stash.id}`);
    // A chore that was nagging with nothing scheduled comes back due now.
    expect(sql.prepare('SELECT * FROM reminders WHERE id = 8').get()).toEqual({ ...before, next_fire_at: NOW });
  });

  it('🗑 still refuses another household, and another member\'s private nag, deleting nothing', async () => {
    env.ALLOWED_CHATS = '1,2';
    expect((await wavesBeforeToast('x:5', { chatId: 2 })).text).toBe('Already gone.');
    sql.exec('UPDATE firings SET last_message_ephemeral = 1, nag_user_id = 3 WHERE id = 5');
    expect((await wavesBeforeToast('x:5')).text).toBe('That nag is someone else\'s 🙈');
    sql.exec('UPDATE firings SET last_message_ephemeral = 0, nag_user_id = NULL WHERE id = 5');
    sql.exec('DELETE FROM reminders WHERE id = 8');
    expect((await wavesBeforeToast('x:5')).text).toBe('That chore is already gone.');
    expect(sql.prepare('SELECT COUNT(*) AS n FROM trash').get().n).toBe(0);
    expect(firing().state).toBe('nagging');
    expect(calls.some((c) => c.method === 'sendMessage')).toBe(false);
  });

  it('the stash a 🗑 builds in SQL names every column a reminder has', async () => {
    const { REMINDER_COLUMNS } = await import('../src/chores.js');
    const columns = sql.prepare("SELECT name FROM pragma_table_info('reminders')").all().map((c) => c.name);
    expect([...REMINDER_COLUMNS].sort()).toEqual(columns.sort());
  });

  it('↩️ Not done, Together too, Not done early and Restore: two', async () => {
    await warmTz();
    await wavesBeforeToast('d:5');
    expect((await wavesBeforeToast('nd:5')).waves).toBe(2);
    expect(firing().state).toBe('nagging');
    // A Done early from the confirmation, then its receipt's buttons.
    await wavesBeforeToast('c:9');
    const early = sql.prepare("SELECT id FROM firings WHERE reminder_id = 9 AND state = 'done'").get().id;
    expect((await wavesBeforeToast(`g:${early}`)).waves).toBe(2);
    expect((await wavesBeforeToast(`ne:${early}`)).waves).toBe(2);
    expect(sql.prepare('SELECT next_fire_at FROM reminders WHERE id = 9').get().next_fire_at).toBe(NOW + 14 * HOUR);
    // Undo a chore, then Restore it.
    await wavesBeforeToast('u:9');
    const stash = sql.prepare('SELECT id FROM trash ORDER BY id DESC').get().id;
    expect((await wavesBeforeToast(`t:${stash}`)).waves).toBe(2);
    expect(sql.prepare('SELECT COUNT(*) AS n FROM reminders WHERE id = 9').get().n).toBe(1);
  });

  it('help, stats tabs and editor screens answer first; an editor change once it is made', async () => {
    await warmTz();
    expect((await wavesBeforeToast('h:more', { messageId: 300 })).waves).toBe(0);
    expect((await wavesBeforeToast('st:last', { messageId: 300 })).waves).toBe(0);
    expect((await wavesBeforeToast('e:menu:9', { messageId: 300 })).waves).toBe(1);
    expect((await wavesBeforeToast('e:setnag:9:30', { messageId: 300 }))).toEqual({ waves: 2, text: 'Updated ✓' });
    expect(sql.prepare('SELECT nag_intervals FROM reminders WHERE id = 9').get().nag_intervals).toBe('[30]');
  });

  it('a wizard time: the draft read, then its claim and the new chore together', async () => {
    await warmTz();
    sql.exec(`INSERT INTO drafts (id, chat_id, text, schedule_kind, schedule_detail, nag_intervals, created_at, scored, user_id)
      VALUES (40, 1, 'feed fish', 'daily', '{}', '[15,30,60]', ${NOW}, 1, 2)`);
    expect(await wavesBeforeToast('w:40:h21', { messageId: 300 })).toEqual({ waves: 2, text: 'Scheduled 📝' });
    expect(sql.prepare("SELECT COUNT(*) AS n FROM reminders WHERE text = 'feed fish'").get().n).toBe(1);
    expect(sql.prepare('SELECT COUNT(*) AS n FROM drafts').get().n).toBe(0);
    // The same tap again finds the draft gone and creates nothing.
    expect((await wavesBeforeToast('w:40:h21', { messageId: 300 })).text).toMatch(/expired/);
    expect(sql.prepare("SELECT COUNT(*) AS n FROM reminders WHERE text = 'feed fish'").get().n).toBe(1);
  });
});

describe('replies, reactions and typed commands', () => {
  async function send(update) {
    await worker.fetch(new Request('https://nag.test/webhook', {
      method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': 'hook' },
      body: JSON.stringify({ update_id: updateId++, ...update }),
    }), env, ctx());
    await settle();
  }
  const typed = (id, text) => ({ message: {
    message_id: id, from: nick, chat: { id: 1 }, date: 0, text,
    entities: [{ type: 'bot_command', offset: 0, length: 6 }],
  } });

  it('a 👍 reads the nag and its chore in one round trip, then claims it', async () => {
    await send({ message_reaction: {
      chat: { id: 1 }, message_id: 700, user: nick, new_reaction: [{ type: 'emoji', emoji: '👍' }],
    } });
    expect(firing().state).toBe('done');
    const read = ops.find((o) => o.kind === 'batch' && o.sql.some((q) => /last_message_id = \?/.test(q)));
    expect(read.sql.join('\n')).toMatch(/FROM firings f[\s\S]*FROM reminders r JOIN firings f/);
    expect(ops.some((o) => o.kind === 'first' && /SELECT \* FROM reminders WHERE id = \?/.test(o.sql))).toBe(false);
    expect(ops.some((o) => /nag_chat_id/.test(String(o.sql)))).toBe(false);
  });

  it('a typed /chore writes its sweep records in one batch, after the work', async () => {
    await send(typed(950, '/chore dishes 9pm daily'));
    expect(ops.some((o) => o.kind === 'run' && /INSERT INTO sent_messages/.test(o.sql))).toBe(false);
    const records = ops.filter((o) => o.kind === 'batch' && o.sql.every((q) => /INSERT INTO sent_messages/.test(q)));
    expect(records).toHaveLength(1);
    // The kept command and its confirmation.
    expect(records[0].sql).toHaveLength(2);
    expect(sql.prepare('SELECT COUNT(*) AS n FROM sent_messages').get().n).toBe(2);
  });

  it('sends the wizard card before the AI guess, and edits the ✨ in when it comes', async () => {
    let release;
    env.AI = { run: () => new Promise((resolve) => { release = resolve; }) };
    const done = send(typed(951, '/chore feed the fish'));
    await vi.waitFor(() => expect(calls.some((c) => c.method === 'sendMessage' && /When should/.test(c.body.text))).toBe(true));
    expect(calls.some((c) => c.method === 'editMessageText')).toBe(false);
    release({ response: '{"kind":"daily","h":20,"mi":0}' });
    await done;
    const edit = calls.find((c) => c.method === 'editMessageText' && /When should/.test(c.body.text));
    expect(edit.body.reply_markup.inline_keyboard[0][0].text).toBe('✨ daily 8pm');
    expect(JSON.parse(sql.prepare('SELECT ai_json FROM drafts').get().ai_json).kind).toBe('daily');
  });

  it('never loses the card to a guess that does not come', async () => {
    env.AI = { run: () => new Promise(() => {}) };
    await send(typed(952, '/chore feed the fish'));
    const card = calls.find((c) => c.method === 'sendMessage' && /When should/.test(c.body.text));
    expect(card.body.reply_markup.inline_keyboard.flat().some((b) => /^✨/.test(b.text))).toBe(false);
    expect(calls.some((c) => c.method === 'editMessageText')).toBe(false);
    const draft = sql.prepare('SELECT ai_json, wizard_msg_id FROM drafts').get();
    expect(draft.ai_json).toBe(null);
    expect(draft.wizard_msg_id).toBeTruthy();
  }, 10000);
});

describe('the intake when its batch answers with an error', () => {
  it('handles an update whose batch committed anyway, and asks Telegram to retry one that did not', async () => {
    const real = env.DB.batch;
    let fail = 'after';
    env.DB.batch = async (statements) => {
      if (fail && statements[0].query.includes('INSERT INTO webhook_updates')) {
        const mode = fail;
        fail = null;
        if (mode === 'after') await real(statements);
        throw new Error('D1_ERROR: Network connection lost.');
      }
      return real(statements);
    };
    const answer = await tap('d:5');
    await settle();
    expect(answer.text).toBe('Purrs 😻');
    expect(firing().state).toBe('done');

    fail = 'before';
    const response = await worker.fetch(new Request('https://nag.test/webhook', {
      method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': 'hook' },
      body: JSON.stringify({ update_id: 5555, callback_query: {
        id: 'cb-x', data: 'ok', from: nick, message: { message_id: 900, chat: { id: 1 } },
      } }),
    }), env, ctx());
    expect(response.status).toBe(503);
    expect(sql.prepare('SELECT COUNT(*) AS n FROM webhook_updates WHERE update_id = 5555').get().n).toBe(0);
  });
});

describe('the Mini App, round trips before its answer', () => {
  // The answer is ready when the API builds its JSON response: the waves by
  // then are what the page waited for. Telegram's own answers are built by
  // the fetch stub and carry no Cache-Control, so they are not counted.
  async function appWaves(path, body, user = nick) {
    const fields = { auth_date: String(Math.floor(NOW / 1000)), start_param: 'g1', user: JSON.stringify(user) };
    fields.hash = await signInitData(TOKEN, fields);
    const Real = globalThis.Response;
    let atReply = null;
    globalThis.Response = class extends Real {
      constructor(b, init) {
        super(b, init);
        if (atReply == null && init && init.headers && init.headers['Cache-Control'] === 'no-store') atReply = waves();
      }
    };
    ops.length = 0;
    try {
      const response = await worker.fetch(new Request(`https://nag.test/api/app/${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: `tma ${new URLSearchParams(fields)}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      }), env, ctx());
      return { reply: { status: response.status, ...(await response.json()) }, waves: atReply };
    } finally {
      globalThis.Response = Real;
    }
  }
  const asked = () => calls.filter((c) => c.method === 'getChatMember').length;

  it('the list and a chore\'s screen: one, with Telegram asked once in a while', async () => {
    const inner = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (url, init) => (String(url).endsWith('/getChatMember')
      ? (calls.push({ method: 'getChatMember' }), new Response(JSON.stringify({ ok: true, result: { status: 'member' } })))
      : inner(url, init))));
    const list = await appWaves('chores');
    expect(list.reply.ok).toBe(true);
    expect(list.waves).toBe(1);
    expect((await appWaves('chore/9')).waves).toBe(1);
    expect(asked()).toBe(1);
    expect(ops.some((o) => /SELECT tz FROM settings/.test(String(o.sql)))).toBe(false);
  });

  it('asks Telegram beside the reads, not in front of them', async () => {
    const inner = globalThis.fetch;
    let readsStarted = null;
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const res = await inner(url, init);
      if (String(url).endsWith('/getChatMember')) readsStarted = ops.length;
      return res;
    }));
    await appWaves('chores');
    expect(readsStarted).toBe(1);
  });

  it('Done on a live nag: three — the gate, the claim, the answer — and the card after', async () => {
    const { reply, waves: n } = await appWaves('chore/8/done', { expect: 'now' });
    expect(reply).toMatchObject({ ok: true, message: 'Purrs 😻 — done.' });
    expect(n).toBe(3);
    expect(calls.some((c) => c.method === 'editMessageText' && c.body.message_id === 700)).toBe(false);
    await settle();
    expect(calls.find((c) => c.method === 'editMessageText' && c.body.message_id === 700).body.text).toMatch(/done by @nicholaswan/);
    expect(boardEdits()).toHaveLength(1);
  });

  it('Done early: three as well', async () => {
    const { reply, waves: n } = await appWaves('chore/9/done', {});
    expect(reply).toMatchObject({ ok: true, message: 'Done early 😻' });
    expect(n).toBe(3);
  });

  it('Done early on a parent: three, the reset of the chore under it inside the answer\'s batch', async () => {
    sql.exec(`INSERT INTO reminders (id, chat_id, display_num, text, schedule_kind, schedule_detail, nag_intervals,
        next_fire_at, paused, created_at, scored, parent_id)
      VALUES (10, 1, 3, 'shake neakasa', 'interval', '{"days":3,"h":21,"mi":0}', '[15,30,60]', ${NOW + DAY}, 0,
        ${NOW - 30 * DAY}, 1, 9)`);
    const before = (await appWaves('chore/10')).reply.chore.status;
    const { reply, waves: n } = await appWaves('chore/9/done', {});
    expect(reply).toMatchObject({ ok: true, message: 'Done early 😻' });
    expect(n).toBe(3);
    // The answer already shows the child restarted from now.
    expect(sql.prepare('SELECT next_fire_at FROM reminders WHERE id = 10').get().next_fire_at).toBeGreaterThan(NOW + DAY);
    expect(reply.chores.find((c) => c.id === 10).status).not.toBe(before);
    await settle();
    const receipt = calls.find((c) => c.method === 'sendMessage' && /done early/.test(c.body.text));
    expect(receipt.body.text).toMatch(/Resets too: shake neakasa/);
    expect(sql.prepare("SELECT COUNT(*) AS n FROM trash WHERE json_extract(payload, '$._cover') IS NOT NULL").get().n).toBe(1);
  });

  it('a skip: two, its compare-and-swap inside the answer\'s batch; a pause: three, the flag with its nag', async () => {
    const skip = await appWaves('chore/9/skip', {});
    expect(skip.reply).toMatchObject({ ok: true });
    expect(skip.reply.message).toMatch(/^⏭️ Skipped — next /);
    expect(skip.waves).toBe(2);
    expect(sql.prepare('SELECT next_fire_at FROM reminders WHERE id = 9').get().next_fire_at).toBe(NOW + 14 * HOUR + DAY - HOUR / 2);
    // A slot the cron claimed meanwhile: the swap loses, and says so.
    sql.exec(`UPDATE reminders SET next_fire_at = ${NOW + 3 * DAY} WHERE id = 9`);
    const { skipPlan } = await import('../src/manage.js');
    const stale = { ...sql.prepare('SELECT * FROM reminders WHERE id = 9').get(), next_fire_at: NOW + 14 * HOUR };
    expect((await skipPlan(env, stale, 'Asia/Singapore').statement.run()).meta.changes).toBe(0);
    const pause = await appWaves('chore/8/pause', {});
    expect(pause.reply).toMatchObject({ ok: true, message: '⏸️ Paused' });
    expect(pause.waves).toBe(3);
    await settle();
    expect(calls.find((c) => c.method === 'editMessageText' && c.body.message_id === 700).body.text).toMatch(/Paused by/);
  });

  it('an edit and an add: two, the write inside the answer\'s batch', async () => {
    const edit = await appWaves('chore/9/edit', { field: 'nag', value: '30' });
    expect(edit.reply.chore.paceKey).toBe('30');
    expect(edit.waves).toBe(2);
    const add = await appWaves('chores', { text: 'feed fish 9pm daily' });
    expect(add.reply.ok).toBe(true);
    expect(add.reply.chore.text).toBe('feed fish');
    expect(add.waves).toBe(2);
  });

  it('a delete: two, the removal inside the answer\'s batch, the cards and the log after', async () => {
    const { reply, waves: n } = await appWaves('chore/8/delete', {});
    expect(reply).toMatchObject({ ok: true, chore: null });
    expect(reply.chores.map((c) => c.id)).toEqual([9]);
    expect(n).toBe(2);
    expect(calls.some((c) => (c.method === 'sendMessage' || c.method === 'deleteMessage') && c.done)).toBe(false);
    await settle();
    expect(calls.some((c) => c.method === 'deleteMessage' && c.body.message_id === 700)).toBe(true);
    const log = calls.find((c) => c.method === 'sendMessage' && /deleted/.test(c.body.text));
    const stash = sql.prepare('SELECT id FROM trash ORDER BY id DESC').get().id;
    expect(log.body.reply_markup.inline_keyboard[0][0].callback_data).toBe(`t:${stash}`);
    expect(sql.prepare('SELECT COUNT(*) AS n FROM firings WHERE reminder_id = 8').get().n).toBe(0);
  });

  it('turns away someone Telegram says has left, even with a members row, writing nothing', async () => {
    const inner = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (url, init) => (String(url).endsWith('/getChatMember')
      ? new Response(JSON.stringify({ ok: true, result: { status: 'left' } }))
      : inner(url, init))));
    const { reply } = await appWaves('chore/8/done', {});
    await settle();
    expect(reply.status).toBe(403);
    expect(firing().state).toBe('nagging');
    expect(ops.filter((o) => o.kind !== 'batch' || o.sql.some((q) => !/^\s*SELECT/i.test(q)))).toHaveLength(0);
    expect(sql.prepare('SELECT last_seen FROM members WHERE user_id = 2').get().last_seen).toBe(0);
  });

  it('when Telegram does not answer: lets a known housemate in, and asks anyone else to retry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, error_code: 502 }))));
    expect((await appWaves('chores')).reply.ok).toBe(true);
    const stranger = await appWaves('chores', null, { id: 9, first_name: 'Mei' });
    await settle();
    expect(stranger.reply).toMatchObject({ status: 503, retry: true });
    expect(sql.prepare('SELECT COUNT(*) AS n FROM members WHERE user_id = 9').get().n).toBe(0);
    // Nothing was remembered: the next request asks again.
    const { chatMemberRole } = await import('../src/household.js');
    expect(await chatMemberRole(env, 1, 2)).toBe('unknown');
  });

  it('asks again before putting someone a remembered answer lets in back on the roster', async () => {
    let status = 'member';
    const inner = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (url, init) => (String(url).endsWith('/getChatMember')
      ? (calls.push({ method: 'getChatMember' }), new Response(JSON.stringify({ ok: true, result: { status } })))
      : inner(url, init))));
    expect((await appWaves('chores')).reply.ok).toBe(true);
    // They leave; the update that removes the row lands on another isolate,
    // so this one still remembers them as in.
    status = 'left';
    sql.exec('DELETE FROM members WHERE user_id = 2');
    const { reply } = await appWaves('chore/8/done', {});
    await settle();
    expect(reply.status).toBe(403);
    expect(asked()).toBe(2);
    expect(sql.prepare('SELECT COUNT(*) AS n FROM members WHERE user_id = 2').get().n).toBe(0);
    expect(firing().state).toBe('nagging');
  });

  it('forgets a remembered answer when the person leaves', async () => {
    const { chatMemberRole, cachedRole, forgetMember } = await import('../src/household.js');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { status: 'member' } }))));
    expect(await chatMemberRole(env, 1, 2)).toBe('member');
    expect(cachedRole(env, 1, 2)).toBe(true);
    await forgetMember(env, 1, 2);
    expect(cachedRole(env, 1, 2)).toBe(false);
  });
});

describe('the cron, round trips per job', () => {
  it('fires a chore in three batches: claim and reads, the new nag, its ids and records', async () => {
    const { fireReminder } = await import('../src/firing.js');
    const { deferBoards } = await import('../src/dashboard.js');
    sql.exec(`UPDATE reminders SET next_fire_at = ${NOW - 1000}, schedule_detail = '{"h":9,"mi":0,"rotate":true}' WHERE id = 9`);
    const r = sql.prepare('SELECT * FROM reminders WHERE id = 9').get();
    ops.length = 0;
    await fireReminder(deferBoards(env), r, NOW, 'Asia/Singapore');
    const batches = ops.filter((o) => o.kind === 'batch');
    expect(batches).toHaveLength(3);
    expect(batches[0].sql.join('\n')).toMatch(/UPDATE reminders SET next_fire_at[\s\S]*FROM firings WHERE reminder_id[\s\S]*FROM members[\s\S]*GROUP BY done_by/);
    expect(batches[1].sql.join('\n')).toMatch(/INSERT INTO firings/);
    expect(batches[2].sql.join('\n')).toMatch(/UPDATE firings SET last_message_id[\s\S]*INSERT INTO sent_messages/);
    expect(sql.prepare("SELECT last_message_id FROM firings WHERE reminder_id = 9 AND state = 'nagging'").get().last_message_id)
      .toBeTruthy();
  });

  it('never posts to the group a private nag whose send timed out', async () => {
    const { fireReminder } = await import('../src/firing.js');
    sql.exec(`UPDATE reminders SET next_fire_at = ${NOW - 1000}, assignee_name = '@nicholaswan' WHERE id = 9`);
    const r = sql.prepare('SELECT * FROM reminders WHERE id = 9').get();
    const seen = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      seen.push({ method: String(url).split('/').pop(), body: JSON.parse(init.body) });
      if (JSON.parse(init.body).receiver_user_id) throw new DOMException('The operation timed out.', 'TimeoutError');
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    }));
    await fireReminder(env, r, NOW, 'Asia/Singapore');
    const sends = seen.filter((c) => /^send/.test(c.method));
    expect(sends).toHaveLength(1);
    expect(sends[0].body.receiver_user_id).toBe(2);
  });

  it('re-nags from one read, taking the old card down beside the new send', async () => {
    const { renagPending } = await import('../src/cron.js');
    sql.exec(`UPDATE firings SET next_nag_at = ${NOW - 1000} WHERE id = 5`);
    let open = 0;
    let most = 0;
    const inner = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      open++;
      most = Math.max(most, open);
      try { return await inner(url, init); } finally { open--; }
    }));
    ops.length = 0;
    await renagPending(env, NOW);
    expect(ops[0].kind).toBe('batch');
    expect(ops[0].sql.join('\n')).toMatch(/FROM firings WHERE[\s\S]*FROM reminders r WHERE r.id IN/);
    expect(ops.some((o) => /SELECT \* FROM reminders WHERE id = \?/.test(String(o.sql)))).toBe(false);
    expect(most).toBeGreaterThanOrEqual(2);
    expect(firing().nag_count).toBe(2);
    expect(firing().last_message_id).not.toBe(700);
  });

  it('a /pause landing after the tick read the chore stops its re-nag', async () => {
    const { renagPending } = await import('../src/cron.js');
    sql.exec(`UPDATE firings SET next_nag_at = ${NOW - 1000} WHERE id = 5`);
    // The tick's read sees the chore unpaused; the pause lands just after.
    const real = env.DB.batch;
    env.DB.batch = async (statements) => {
      const out = await real(statements);
      if (statements.some((s) => /FROM reminders r WHERE r.id IN/.test(s.query))) sql.exec('UPDATE reminders SET paused = 1 WHERE id = 8');
      return out;
    };
    await renagPending(env, NOW);
    expect(firing().nag_count).toBe(1);
    expect(calls.some((c) => c.method === 'sendMessage')).toBe(false);
  });

  it('sweeps six at a time and drops the rows in one statement', async () => {
    for (let i = 0; i < 9; i++) {
      sql.exec(`INSERT INTO sent_messages (chat_id, message_id, is_ephemeral, delete_after, created_at)
        VALUES (1, ${2000 + i}, 0, ${NOW - 1000}, ${NOW - DAY})`);
    }
    let open = 0;
    let most = 0;
    const inner = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      open++;
      most = Math.max(most, open);
      try { return await inner(url, init); } finally { open--; }
    }));
    sql.exec("UPDATE firings SET next_nag_at = next_nag_at + 86400000, fired_at = fired_at + 86400000");
    await worker.scheduled({}, env, ctx());
    await settle();
    expect(most).toBe(6);
    expect(sql.prepare('SELECT COUNT(*) AS n FROM sent_messages').get().n).toBe(0);
    expect(ops.filter((o) => /DELETE FROM sent_messages/.test(String(o.sql)))).toHaveLength(1);
  });

  it('the 8am digest leaves out a chore that fired in the same tick', async () => {
    const { sendDigests } = await import('../src/cron.js');
    const EIGHT = Date.UTC(2026, 9, 11, 0, 0); // Sun 11 Oct 08:00 Asia/Singapore
    Date.now.mockReturnValue(EIGHT);
    sql.exec("UPDATE firings SET state = 'done' WHERE id = 5");
    sql.exec(`INSERT INTO firings (id, reminder_id, chat_id, reminder_text, fired_at, state, nag_count, next_nag_at, scored)
      VALUES (6, 9, 1, 'water plants', ${EIGHT}, 'nagging', 0, ${EIGHT + 15 * 60000}, 1)`);
    await sendDigests(env, EIGHT);
    expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(0);
    // One left from before the tick still gets its digest.
    sql.exec(`UPDATE firings SET fired_at = ${EIGHT - HOUR} WHERE id = 6`);
    sql.exec('UPDATE settings SET last_digest = NULL');
    await sendDigests(env, EIGHT);
    expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(1);
  });

  it('a fire whose last batch fails puts the other sweep records in the scope back', async () => {
    const { fireReminder } = await import('../src/firing.js');
    const { deferBoards, flushBoards } = await import('../src/dashboard.js');
    const { recordForSweep } = await import('../src/tg.js');
    sql.exec(`UPDATE reminders SET next_fire_at = ${NOW - 1000} WHERE id = 9`);
    const r = sql.prepare('SELECT * FROM reminders WHERE id = 9').get();
    const batch = env.DB.batch;
    env.DB.batch = (statements) => (statements.some((st) => /SET last_message_id/.test(st.query))
      ? Promise.reject(new Error('D1_ERROR: network lost'))
      : batch(statements));
    const tick = deferBoards(env);
    await recordForSweep(tick, 1, 4242);
    await expect(fireReminder(tick, r, NOW, 'Asia/Singapore')).rejects.toThrow(/network lost/);
    env.DB.batch = batch;
    await flushBoards(tick);
    expect(sql.prepare('SELECT COUNT(*) AS n FROM sent_messages WHERE message_id = 4242').get().n).toBe(1);
  });

  it('a claim batch that fails is not swapped back, so a racing fire keeps its claim', async () => {
    const { fireReminder } = await import('../src/firing.js');
    sql.exec(`UPDATE reminders SET next_fire_at = ${NOW - 1000} WHERE id = 9`);
    const r = sql.prepare('SELECT * FROM reminders WHERE id = 9').get();
    const batch = env.DB.batch;
    // The other fire's claim commits; this one's batch errors.
    env.DB.batch = async (statements) => {
      if (!statements.some((st) => /UPDATE reminders SET next_fire_at = \? WHERE id = \? AND next_fire_at = \?/.test(st.query))) return batch(statements);
      await batch(statements);
      throw new Error('D1_ERROR: network lost');
    };
    await expect(fireReminder(env, r, NOW, 'Asia/Singapore')).rejects.toThrow(/network lost/);
    env.DB.batch = batch;
    expect(sql.prepare('SELECT next_fire_at FROM reminders WHERE id = 9').get().next_fire_at).toBeGreaterThan(NOW);
  });
});

// The third speed pass (8 Nov 2026): what a sticker pick and a typed command
// used to read on their own — the chat's pack, the cats' tags, the timezone —
// rides in the first batch each entry point sends, when the isolate's copy is
// stale.
describe('the chat\'s timezone and stickers', () => {
  const cached = (o) => /sticker_tags|sticker_set FROM settings|SELECT tz FROM settings/.test(String(o.sql));
  beforeEach(() => {
    // A pack of the chat's own, so the bot's username never comes into it.
    sql.exec("UPDATE settings SET sticker_set = 'testpack'");
    sql.exec("INSERT INTO sticker_tags (file_uid, cat) VALUES ('u1', 'latte'), ('u2', 'latte')");
    const inner = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (url, init) => (String(url).endsWith('/getStickerSet')
      ? new Response(JSON.stringify({ ok: true, result: { stickers: [
        { file_id: 's1', file_unique_id: 'u1' }, { file_id: 's2', file_unique_id: 'u2' }] } }))
      : inner(url, init))));
  });

  it('ride in the intake, so a Done\'s card and sticker wait on no read of their own', async () => {
    await tap('d:5');
    await settle();
    expect(cached(ops[0])).toBe(true);
    expect(ops.slice(1).some(cached)).toBe(false);
    expect(calls.some((c) => c.method === 'sendSticker')).toBe(true);
    const card = calls.find((c) => c.method === 'editMessageText' && c.body.message_id === 700);
    expect(card.body.text).toMatch(/Latte purrs approvingly/);
    // Fresh now: the next intake carries none of them.
    ops.length = 0;
    await tap('ok', 900);
    await settle();
    expect(ops.some(cached)).toBe(false);
  });

  it('make a typed /chore one round trip after the intake', async () => {
    await worker.fetch(new Request('https://nag.test/webhook', {
      method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': 'hook' },
      body: JSON.stringify({ update_id: updateId++, message: {
        message_id: 801, from: nick, chat: { id: 1, type: 'supergroup' }, date: 0, text: '/chore feed fish 9pm daily',
        entities: [{ type: 'bot_command', offset: 0, length: 6 }],
      } }),
    }), env, ctx());
    await settle();
    expect(ops[1].sql).toMatch(/INSERT INTO reminders/);
    expect(ops[1].wave).toBe(1);
    expect(ops.slice(1).some(cached)).toBe(false);
  });

  it('ride in the Mini App\'s gate for a change', async () => {
    const fields = { auth_date: String(Math.floor(NOW / 1000)), start_param: 'g1', user: JSON.stringify(nick) };
    fields.hash = await signInitData(TOKEN, fields);
    await worker.fetch(new Request('https://nag.test/api/app/chore/8/done', {
      method: 'POST',
      headers: { Authorization: `tma ${new URLSearchParams(fields)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expect: 'now' }),
    }), env, ctx());
    await settle();
    expect(cached(ops[0])).toBe(true);
    expect(ops.slice(1).some(cached)).toBe(false);
    expect(calls.some((c) => c.method === 'sendSticker')).toBe(true);
  });

  it('ride in the cron\'s due check, so a fire picks its sticker and its cat without a read', async () => {
    sql.exec(`UPDATE reminders SET next_fire_at = ${NOW - 1000} WHERE id = 9`);
    await worker.scheduled({}, env, ctx());
    await settle();
    expect(String(ops[0].sql)).toMatch(/sticker_tags/);
    expect(ops.slice(1).some(cached)).toBe(false);
    expect(calls.findIndex((c) => c.method === 'sendSticker'))
      .toBeLessThan(calls.findIndex((c) => c.method === 'sendMessage'));
    expect(calls.find((c) => c.method === 'sendMessage').body.text).toMatch(/water plants[\s\S]*Latte/);
  });
});
