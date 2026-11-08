// How long the household waits, measured: real flows through the Worker on
// the real schema, with every D1 call and every Telegram call delayed by a
// fixed network cost. Production data is tiny (SQL itself takes under a
// millisecond), so these round trips are where the time goes.
//
//   node bench/latency.mjs            every scenario, cold and warm
//   node bench/latency.mjs done-tap   one scenario
//
// "reply" is when the person sees something: the webhook response that
// carries a tap's toast, or the Mini App's JSON. "all" is when every last
// edit, board redraw and bookkeeping write has finished. "msg" is when the
// first message or edit reached Telegram — for a typed command or a cron tick,
// what the household first sees. Cold runs in a fresh process (empty
// per-isolate caches); warm repeats it in the same process. D1_MS and TG_MS
// override the assumed costs, AI_MS the Workers AI guess (default 1500).
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const D1_MS = Number(process.env.D1_MS || 20);
const TG_MS = Number(process.env.TG_MS || 25);
const AI_MS = Number(process.env.AI_MS || 1500);
const CHAT = -1004418632524;
const HOUR = 3600000;
const DAY = 24 * HOUR;
// A Saturday evening in Singapore, outside quiet hours; time still flows from
// here so the measurements below are real elapsed milliseconds.
const BASE = Date.UTC(2026, 9, 10, 11, 30);
const started = Date.now();
const realNow = Date.now.bind(Date);
Date.now = () => BASE + (realNow() - started);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// TRACE=1 prints each call as it starts, ms from the start of the flow.
let traceStart = null;
const trace = (what) => {
  if (process.env.TRACE && traceStart != null) process.stderr.write(`${String(realNow() - traceStart).padStart(5)}  ${what}
`);
};
const short = (q) => String(q).replace(/\s+/g, ' ').trim().slice(0, 90);

function freshDb() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const now = Date.now();
  sql.prepare('INSERT INTO settings (chat_id, dashboard_msg_id) VALUES (?, 99)').run(CHAT);
  sql.prepare(`INSERT INTO members (chat_id, user_id, username, first_name, last_seen) VALUES
    (?, 2, 'nicholaswan', 'Nick', 0), (?, 3, 'Dodgerblueee', 'Yx', 0)`).run(CHAT, CHAT);
  const add = (id, text, kind, detail, next, extra = {}) => {
    const row = {
      id, chat_id: CHAT, display_num: id, text, schedule_kind: kind, schedule_detail: JSON.stringify(detail),
      nag_intervals: '[15,30,60]', next_fire_at: next, paused: 0, created_at: now - 30 * DAY, scored: 1, ...extra,
    };
    const keys = Object.keys(row);
    sql.prepare(`INSERT INTO reminders (${keys}) VALUES (${keys.map(() => '?')})`).run(...keys.map((k) => row[k]));
  };
  // Fourteen chores, as in production: a nested litter family, weeklies,
  // dailies and a one-off.
  add(1, 'wash litter box', 'interval', { days: 14, h: 10, mi: 0 }, now + 3 * DAY);
  add(2, 'clear poop', 'daily', { h: 21, mi: 0 }, now + 2 * HOUR, { parent_id: 1 });
  add(3, 'shake neakasa', 'interval', { days: 3, h: 21, mi: 0 }, now + DAY, { parent_id: 2 });
  add(4, 'take out trash', 'daily', { h: 20, mi: 0 }, null);
  for (let i = 5; i <= 13; i++) add(i, `weekly chore ${i}`, 'weekly', { days: [i % 7], h: 9, mi: 0 }, now + (i % 7 + 1) * DAY);
  add(14, 'renew passport', 'once', {}, now + 5 * DAY, { scored: 0 });
  // Trash nagging now, on a public card with a sticker beside it.
  sql.prepare(`INSERT INTO firings (id, reminder_id, chat_id, reminder_text, fired_at, state, nag_count,
    next_nag_at, last_message_id, last_sticker_id, scored) VALUES (50, 4, ?, 'take out trash', ?, 'nagging', 1, ?, 700, 701, 1)`)
    .run(CHAT, now - HOUR, now + HOUR);
  // Some history, so stats and rotation have rows to read.
  for (let i = 0; i < 80; i++) {
    sql.prepare(`INSERT INTO firings (reminder_id, chat_id, reminder_text, fired_at, state, done_by, done_at, scored)
      VALUES (?, ?, 'old', ?, 'done', ?, ?, 1)`).run(5 + (i % 9), CHAT, now - i * HOUR * 20, i % 2 ? '@nicholaswan' : '@Dodgerblueee', now - i * HOUR * 20);
  }
  sql.prepare("INSERT INTO sticker_tags (file_uid, cat) VALUES ('u1', 'latte'), ('u2', 'mocha')").run();
  return sql;
}

// The test suite's D1 shim, with each call paying one network round trip. A
// batch is one round trip however many statements it carries, as on D1.
function slowD1(sql, counts) {
  const runStatement = (query, args) => {
    const st = sql.prepare(query);
    if (/^\s*(SELECT|WITH)\b/i.test(query) || /\bRETURNING\b/i.test(query)) {
      return { results: st.all(...args), meta: { changes: 0 } };
    }
    const r = st.run(...args);
    return { results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  };
  return {
    prepare(query) {
      const bound = (args = []) => ({
        query,
        bind: (...values) => bound(values),
        runSync: () => runStatement(query, args),
        first: async () => { counts.d1++; trace(`D1 first  ${short(query)}`); await sleep(D1_MS); return sql.prepare(query).get(...args) || null; },
        all: async () => { counts.d1++; trace(`D1 all    ${short(query)}`); await sleep(D1_MS); return { results: sql.prepare(query).all(...args) }; },
        run: async () => { counts.d1++; trace(`D1 run    ${short(query)}`); await sleep(D1_MS); return runStatement(query, args); },
      });
      return bound();
    },
    async batch(statements) {
      counts.d1++;
      trace(`D1 batch  ${statements.length}: ${statements.map((st) => short(st.query).slice(0, 40)).join(' | ')}`);
      await sleep(D1_MS);
      sql.exec('BEGIN');
      try {
        const out = statements.map((s) => s.runSync());
        sql.exec('COMMIT');
        return out;
      } catch (e) {
        sql.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

let nextMessageId = 5000;
function stubTelegram(counts) {
  globalThis.fetch = async (url, init = {}) => {
    const method = String(url).split('/').pop();
    counts.tg++;
    counts.methods.push(method);
    trace(`TG ${method}`);
    if (counts.firstMsg == null && /^(send|edit)/.test(method)) counts.firstMsg = realNow();
    await sleep(TG_MS);
    const result = method === 'getMe' ? { id: 1000, username: 'TwoShotsNagBot' }
      : method === 'getStickerSet' ? { stickers: [{ file_id: 's1', file_unique_id: 'u1' }, { file_id: 's2', file_unique_id: 'u2' }] }
      : method === 'getChatMember' ? { status: 'member' }
      : /^send/.test(method) ? { message_id: nextMessageId++ }
      : true;
    return new Response(JSON.stringify({ ok: true, result }), { headers: { 'Content-Type': 'application/json' } });
  };
}

const { default: worker } = await import('../src/index.js');
const { signInitData } = await import('../src/miniapp-auth.js');

let updateId = 1;
const nick = { id: 2, is_bot: false, first_name: 'Nick', username: 'nicholaswan' };

function tap(data, messageId = 700) {
  return new Request('https://nag.test/webhook', {
    method: 'POST',
    headers: { 'X-Telegram-Bot-Api-Secret-Token': 'hook' },
    body: JSON.stringify({ update_id: updateId++, callback_query: {
      id: `cb${updateId}`, data, from: nick, message: { message_id: messageId, chat: { id: CHAT, type: 'supergroup' } },
    } }),
  });
}

function typed(text) {
  return new Request('https://nag.test/webhook', {
    method: 'POST',
    headers: { 'X-Telegram-Bot-Api-Secret-Token': 'hook' },
    body: JSON.stringify({ update_id: updateId++, message: {
      message_id: 800 + updateId, from: nick, chat: { id: CHAT, type: 'supergroup' }, date: 0, text,
      entities: text.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] : [],
    } }),
  });
}

async function app(path, body) {
  const fields = { auth_date: String(Math.floor(Date.now() / 1000)), start_param: `g${CHAT}`, user: JSON.stringify(nick) };
  fields.hash = await signInitData('token', fields);
  return new Request(`https://nag.test/api/app/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `tma ${new URLSearchParams(fields)}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const SCENARIOS = {
  'done-tap': { label: '✅ Done on a nag', run: () => tap('d:50') },
  'snooze-tap': { label: '😴 Snooze 1h', run: () => tap('z:50:60') },
  'ok-tap': { label: '✅ OK on a note', run: () => tap('ok', 900) },
  'delete-tap': { label: '🗑 Delete on a nag', run: () => tap('x:50') },
  'chore-cmd': { label: '/chore dishes 9pm daily', run: () => typed('/chore dishes 9pm daily') },
  'done-parent': { label: '✅ Done early on a parent (app)', run: () => app('chore/1/done', {}) },
  'app-list': { label: 'Mini App: open list', run: () => app('chores') },
  'app-chore': { label: 'Mini App: open a chore', run: () => app('chore/4') },
  'app-done': { label: 'Mini App: Done', run: () => app('chore/4/done', {}) },
  'app-delete': { label: 'Mini App: delete', run: () => app('chore/4/delete', {}) },
  'app-edit': { label: 'Mini App: change time', run: () => app('chore/5/edit', { field: 'time', value: '20:00' }) },
  'app-add': { label: 'Mini App: add a chore', run: () => app('chores', { text: 'dishes 9pm daily' }) },
  'wizard': { label: '/chore with no time (wizard)', run: () => typed('/chore water the cat') },
  'cron-renag': { label: 'Cron tick, one re-nag due', cron: true, renag: true },
  'cron-idle': { label: 'Cron tick, nothing due', cron: true },
  'cron-fire': { label: 'Cron tick, one chore due', cron: true, due: 6 },
};

async function measure(name) {
  const scenario = SCENARIOS[name];
  const counts = { d1: 0, tg: 0, methods: [], firstMsg: null };
  const sql = freshDb();
  if (scenario.due) sql.prepare('UPDATE reminders SET next_fire_at = ? WHERE id = ?').run(Date.now() - 1000, scenario.due);
  if (scenario.renag) sql.prepare('UPDATE firings SET next_nag_at = ? WHERE id = 50').run(Date.now() - 1000);
  const env = {
    BOT_TOKEN: 'token', WEBHOOK_SECRET: 'hook', ALLOWED_CHATS: String(CHAT),
    MINI_APP_URL: 'https://t.me/TwoShotsNagBot/chores', DB: slowD1(sql, counts),
    // Workers AI's schedule guess, which only the wizard asks for.
    AI: { run: async () => { await sleep(AI_MS); return { response: '{"kind":"daily","h":20,"mi":0}' }; } },
  };
  stubTelegram(counts);
  const tasks = [];
  const ctx = { waitUntil: (p) => tasks.push(p) };
  const t0 = realNow();
  traceStart = t0;
  let reply;
  if (scenario.cron) {
    await worker.scheduled({}, env, ctx);
    reply = realNow() - t0;
  } else {
    const request = await scenario.run();
    const response = await worker.fetch(request, env, ctx);
    reply = realNow() - t0;
    trace('-- reply');
    await response.text();
  }
  for (let i = 0; i < tasks.length; i++) await tasks[i];
  const all = realNow() - t0;
  sql.close();
  const msg = counts.firstMsg == null ? null : counts.firstMsg - t0;
  return { reply, all, msg, d1: counts.d1, tg: counts.tg, methods: counts.methods };
}

const self = fileURLToPath(import.meta.url);
const [mode, only] = process.argv.slice(2);
if (mode === '--one') {
  const cold = await measure(only);
  const warm = await measure(only);
  process.stdout.write(JSON.stringify({ cold, warm }));
} else {
  const names = mode ? [mode] : Object.keys(SCENARIOS);
  const rows = [];
  for (const name of names) {
    const out = spawnSync(process.execPath, [self, '--one', name], { encoding: 'utf8', env: process.env });
    if (out.status !== 0) { console.error(out.stderr); process.exit(1); }
    const { cold, warm } = JSON.parse(out.stdout.trim().split('\n').pop());
    rows.push({ name, label: SCENARIOS[name].label, cold, warm });
  }
  console.log(`D1 ${D1_MS}ms and Telegram ${TG_MS}ms per call\n`);
  console.log('scenario                          reply cold/warm   msg cold/warm    all cold/warm    D1   TG');
  const ms = (n) => String(n == null ? '-' : n).padStart(5);
  for (const { label, cold, warm } of rows) {
    console.log(`${label.padEnd(33)} ${ms(cold.reply)} /${ms(warm.reply)} ms  ${ms(cold.msg)} /${ms(warm.msg)} ms`
      + `  ${ms(cold.all)} /${ms(warm.all)} ms  ${String(warm.d1).padStart(4)} ${String(warm.tg).padStart(4)}`);
  }
  if (process.env.VERBOSE) for (const r of rows) console.log(r.name, r.warm.methods.join(' '));
}
