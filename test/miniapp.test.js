// The Mini App (27 Oct 2026): the pinned board's 🐾 Chores button opens a
// sheet over the chat with the chore list, each chore's Done / Done early,
// editor, pause, skip and delete, adding a chore, and the weekly stats. The
// API believes only Telegram's signature and only people in the chat.
// Real SQLite behind the D1 shim.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import worker from '../src/index.js';
import { signInitData } from '../src/miniapp-auth.js';
import { miniAppLink } from '../src/miniapp-link.js';
import { dashboardButtons, choreListHtml } from '../src/dashboard.js';
import { d1 } from './d1.js';

const TOKEN = 'test';
const TZ = 'Asia/Singapore';
const HOUR = 3600000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 10, 11, 30); // Sat 10 Oct 19:30 Asia/Singapore
const TUE_7PM = Date.UTC(2026, 9, 13, 11);

let sql, env, calls, memberStatus;
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  sql.exec('INSERT INTO settings (chat_id, dashboard_msg_id) VALUES (1, 99)');
  sql.exec(`INSERT INTO members (chat_id, user_id, username, first_name, last_seen) VALUES
    (1, 2, 'nicholaswan', 'Nick', 0), (1, 3, 'Dodgerblueee', 'Yx', 0)`);
  // A weekly-ish chore not yet due, and a one-off nagging since an hour ago.
  seed('reminders', {
    id: 8, chat_id: 1, display_num: 1, text: 'slutbed', schedule_kind: 'interval',
    schedule_detail: '{"days":7,"h":19,"mi":0}', nag_intervals: '[15,30,60]', next_fire_at: TUE_7PM,
    paused: 0, created_at: NOW - 30 * DAY, scored: 1,
  });
  seed('reminders', {
    id: 9, chat_id: 1, display_num: 2, text: 'renew passport', schedule_kind: 'once',
    schedule_detail: '{}', nag_intervals: '[60]', next_fire_at: null,
    paused: 0, created_at: NOW - DAY, scored: 0,
  });
  seed('firings', {
    id: 5, reminder_id: 9, chat_id: 1, reminder_text: 'renew passport', fired_at: NOW - HOUR,
    state: 'nagging', nag_count: 1, next_nag_at: NOW + HOUR, last_message_id: 700, scored: 0,
  });
  env = { BOT_TOKEN: TOKEN, ALLOWED_CHATS: '1', DB: d1(sql) };
  calls = [];
  memberStatus = 'left';
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    // Telegram's answer about membership: the two housemates are in the chat;
    // anyone else answers memberStatus (asked on every request since 8 Nov
    // 2026, beside the request's reads).
    const body = JSON.parse(init.body);
    const result = String(url).endsWith('/getChatMember')
      ? { status: [2, 3].includes(body.user_id) ? 'member' : memberStatus } : { message_id: 99 };
    return new Response(JSON.stringify({ ok: true, result }));
  }));
});
afterEach(() => { sql.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function seed(table, row) {
  const keys = Object.keys(row);
  sql.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...keys.map((k) => row[k]));
}

const nick = { id: 2, first_name: 'Nick', username: 'nicholaswan' };

// Launch data the way Telegram hands it to the page: a query string whose hash
// is signed with the bot's token.
async function initData({ user = nick, startParam = 'g1', token = TOKEN, ...fields } = {}) {
  const signed = {
    auth_date: String(Math.floor(Date.now() / 1000)), start_param: startParam,
    user: JSON.stringify(user), ...fields,
  };
  signed.hash = await signInitData(token, signed);
  return new URLSearchParams(signed).toString();
}

const tasks = [];
async function call(path, body, opts = {}) {
  const auth = opts.auth === undefined ? await initData(opts) : opts.auth;
  const response = await worker.fetch(new Request(`https://nag.test/api/app/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { ...(auth ? { Authorization: `tma ${auth}` } : {}), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }), env, { waitUntil: (task) => tasks.push(task) });
  const answer = { status: response.status, ...await response.json() };
  // What follows the answer (the receipt, the board) has finished too.
  for (let i = 0; i < tasks.length; i++) await tasks[i];
  tasks.length = 0;
  return answer;
}

const reminder = (id) => sql.prepare('SELECT * FROM reminders WHERE id = ?').get(id);
const sent = (pattern) => calls.filter((c) => c.url.endsWith('/sendMessage') && pattern.test(c.body.text));

describe('who may open it', () => {
  it('refuses a request Telegram did not sign', async () => {
    expect((await call('chores', null, { auth: null })).status).toBe(401);
    const forged = (await initData()).replace(/hash=[0-9a-f]+/, `hash=${'0'.repeat(64)}`);
    expect((await call('chores', null, { auth: forged })).status).toBe(401);
    expect((await call('chores', null, { token: 'someone-elses-bot' })).status).toBe(401);
  });

  it('refuses launch data a day old', async () => {
    const stale = await initData({ auth_date: String(Math.floor((NOW - 2 * DAY) / 1000)) });
    expect((await call('chores', null, { auth: stale })).status).toBe(401);
  });

  it('refuses a group the bot does not serve', async () => {
    const res = await call('chores', null, { startParam: 'g-555' });
    expect(res.status).toBe(403);
    expect(res.message).toMatch(/not for a Nag-Bot household/);
  });

  it('refuses somebody who is not in the chat', async () => {
    const res = await call('chores', null, { user: { id: 77, first_name: 'Eve' } });
    expect(res.status).toBe(403);
    expect(res.message).toBe('Only the household can see its chores.');
  });

  it('lets in a housemate the bot has not seen yet, and remembers them', async () => {
    memberStatus = 'member';
    const res = await call('chores', null, { user: { id: 4, first_name: 'Mei' } });
    expect(res.ok).toBe(true);
    expect(sql.prepare('SELECT first_name FROM members WHERE chat_id = 1 AND user_id = 4').get().first_name).toBe('Mei');
  });
});

describe('the chore list', () => {
  it('says what the board says, in the board\'s order', async () => {
    const res = await call('chores');
    expect(res.chores.map((c) => [c.text, c.state, c.live])).toEqual([
      ['renew passport', 'nagging', true],
      ['slutbed', 'upcoming', false],
    ]);
    expect(res.chores[0].status).toBe('🔔 nagging since 6:30 PM');
    expect(res.chores[0].scored).toBe(false);
    expect(res.chores[1].cadence).toBe('weekly');
    expect(res.members.map((m) => m.name)).toEqual(['@Dodgerblueee', '@nicholaswan']);
    expect(res.me).toEqual({ id: 2, name: '@nicholaswan' });
    const board = await choreListHtml(env, 1, TZ);
    expect(board).toContain(res.chores[0].status);
  });

  it('gives each chore the editor\'s values, and offers what the board\'s Manage offers', async () => {
    const { chore } = await call('chore/8');
    expect(chore).toMatchObject({
      time: '19:00', timed: true, scheduleKey: null, schedule: 'weekly at 7pm',
      paceKey: 'default', done: 'early', canSkip: true,
    });
    const nagging = (await call('chore/9')).chore;
    expect(nagging).toMatchObject({ done: 'now', timed: false, canSkip: false, paceKey: '60' });
  });

  it('cannot reach a chore in another household', async () => {
    seed('reminders', {
      id: 20, chat_id: 2, display_num: 1, text: 'theirs', schedule_kind: 'daily',
      schedule_detail: '{"h":9,"mi":0}', nag_intervals: '[15,30,60]', next_fire_at: TUE_7PM,
      paused: 0, created_at: NOW, scored: 1,
    });
    expect(await call('chore/20')).toMatchObject({ ok: false, message: 'That chore is already gone.' });
    expect(await call('chore/20/delete', {})).toMatchObject({ ok: false });
    expect(reminder(20)).toBeTruthy();
  });
});

describe('done', () => {
  it('finishes a live nag in the tapper\'s name and returns the list without it', async () => {
    const res = await call('chore/9/done', { how: 'me' });
    expect(res).toMatchObject({ ok: true, message: 'Purrs 😻 — done.', chore: null });
    expect(sql.prepare('SELECT state, done_by FROM firings WHERE id = 5').get())
      .toEqual({ state: 'done', done_by: '@nicholaswan' });
    expect(res.chores.map((c) => c.text)).toEqual(['slutbed']);
  });

  it('does a chore early for a chosen housemate, advancing its schedule', async () => {
    const res = await call('chore/8/done', { how: 'as', member: 3 });
    expect(res.message).toBe('Done early 😻');
    const done = sql.prepare("SELECT done_by FROM firings WHERE reminder_id = 8 AND state = 'done'").get();
    expect(done.done_by).toBe('@Dodgerblueee');
    expect(reminder(8).next_fire_at).toBeGreaterThan(TUE_7PM);
    expect(sent(/done early by @Dodgerblueee/)).toHaveLength(1);
  });

  it('credits the whole household together', async () => {
    await call('chore/8/done', { how: 'together' });
    const done = sql.prepare("SELECT done_by FROM firings WHERE reminder_id = 8 AND state = 'done'").get();
    expect(done.done_by).toBe('@nicholaswan & @Dodgerblueee');
  });

  it('says so when somebody got there first', async () => {
    sql.exec("UPDATE firings SET state = 'done', done_by = '@Dodgerblueee' WHERE id = 5");
    sql.exec('UPDATE reminders SET next_fire_at = NULL WHERE id = 9');
    expect(await call('chore/9/done', { how: 'me' })).toMatchObject({
      ok: false, message: 'This chore is not nagging now.',
    });
  });

  it('refuses a housemate who has left', async () => {
    expect(await call('chore/8/done', { how: 'as', member: 42 })).toMatchObject({
      ok: false, message: 'That household member is no longer here.',
    });
  });
});

describe('the editor', () => {
  it('takes any time of day, not just the four on the buttons', async () => {
    const res = await call('chore/8/edit', { field: 'time', value: '07:45' });
    expect(res.chore.time).toBe('07:45');
    expect(JSON.parse(reminder(8).schedule_detail)).toMatchObject({ h: 7, mi: 45 });
    expect(reminder(8).next_fire_at).toBe(Date.UTC(2026, 9, 12, 23, 45)); // Tue 13 Oct 7:45 SGT
  });

  it('will not schedule a chore that is nagging with nothing scheduled', async () => {
    const res = await call('chore/9/edit', { field: 'time', value: '09:00' });
    expect(res.ok).toBe(false);
    expect(reminder(9).next_fire_at).toBeNull();
  });

  it('sets rotation and points to the value asked for, so a stale screen cannot flip them back', async () => {
    await call('chore/8/edit', { field: 'rotate', value: true });
    await call('chore/8/edit', { field: 'rotate', value: true });
    expect(JSON.parse(reminder(8).schedule_detail).rotate).toBe(true);
    await call('chore/9/edit', { field: 'score', value: true });
    expect(reminder(9).scored).toBe(1);
    expect(sql.prepare('SELECT scored FROM firings WHERE id = 5').get().scored).toBe(1);
  });

  it('assigns by user id and refuses a field or value the editor does not offer', async () => {
    await call('chore/8/edit', { field: 'assign', value: '3' });
    expect(reminder(8)).toMatchObject({ assignee_name: '@Dodgerblueee', assignee_user_id: 3 });
    expect((await call('chore/8/edit', { field: 'text', value: 'x' })).ok).toBe(false);
    expect((await call('chore/8/edit', { field: 'nag', value: 'zz' })).ok).toBe(false);
    expect((await call('chore/8/edit', { field: 'time', value: '25:00' })).ok).toBe(false);
    expect(reminder(8).nag_intervals).toBe('[15,30,60]');
  });
});

describe('pause, skip and delete', () => {
  it('pauses and resumes, refusing the one that is already so', async () => {
    expect((await call('chore/8/pause', {})).chore.state).toBe('paused');
    expect(await call('chore/8/pause', {})).toMatchObject({ ok: false, message: 'It is already paused.' });
    const resumed = await call('chore/8/resume', {});
    expect(resumed.message).toBe('▶️ Resumed — next in 3 days · Tue 7:00 PM');
    expect(reminder(8).paused).toBe(0);
  });

  it('skips the next slot of a recurring chore only', async () => {
    const res = await call('chore/8/skip', {});
    expect(reminder(8).next_fire_at).toBe(TUE_7PM + 7 * DAY);
    expect(res.message).toMatch(/^⏭️ Skipped — next /);
    expect(await call('chore/9/skip', {})).toMatchObject({ ok: false, message: 'One-off chores cannot be skipped.' });
  });

  it('deletes through the trash, logging to the group with Undo', async () => {
    const res = await call('chore/8/delete', {});
    expect(res).toMatchObject({ ok: true, chore: null });
    expect(reminder(8)).toBeUndefined();
    expect(sql.prepare('SELECT COUNT(*) AS n FROM trash').get().n).toBe(1);
    const log = sent(/deleted <s>slutbed<\/s>/)[0];
    expect(log.body.text).toBe('🗑️ @nicholaswan deleted <s>slutbed</s>');
    expect(log.body.reply_markup.inline_keyboard[0][0].callback_data).toMatch(/^t:\d+$/);
  });
});

describe('undo from the toast', () => {
  it('takes back a Done on a nag, as the receipt\'s Not done does', async () => {
    const done = await call('chore/9/done', { how: 'me' });
    expect(done.undo).toEqual({ kind: 'done', id: 5 });
    expect(reminder(9)).toBeUndefined(); // a finished one-off waits in the trash
    const res = await call('undo', done.undo);
    expect(res).toMatchObject({ ok: true, message: '↩️ renew passport — not done after all' });
    expect(sql.prepare('SELECT state, done_by FROM firings WHERE id = 5').get())
      .toEqual({ state: 'nagging', done_by: null });
    expect(reminder(9)).toBeDefined();
    expect(res.chores.map((c) => c.text)).toContain('renew passport');
    expect(sent(/not done after all, says @nicholaswan/)).toHaveLength(1);
    expect(await call('undo', done.undo)).toMatchObject({ ok: false, message: 'Too late to take that back.' });
  });

  it('takes back a Done early, putting the slot it used back', async () => {
    const done = await call('chore/8/done', { how: 'me' });
    expect(done.undo.kind).toBe('done');
    expect(reminder(8).next_fire_at).toBeGreaterThan(TUE_7PM);
    const res = await call('undo', done.undo);
    expect(res.ok).toBe(true);
    expect(reminder(8).next_fire_at).toBe(TUE_7PM);
    expect(sql.prepare('SELECT COUNT(*) AS n FROM firings WHERE reminder_id = 8').get().n).toBe(0);
  });

  it('restores a deleted chore once, and only this household\'s', async () => {
    const del = await call('chore/8/delete', {});
    expect(del.undo.kind).toBe('delete');
    expect(del.message).toBe('🗑️ Deleted slutbed');
    sql.exec(`INSERT INTO trash (id, chat_id, payload, created_at) VALUES (500, 2, '{"id":77,"chat_id":2,"text":"x"}', 0)`);
    expect((await call('undo', { kind: 'delete', id: 500 })).ok).toBe(false);
    const res = await call('undo', del.undo);
    expect(res).toMatchObject({ ok: true, message: '↩️ Restored slutbed' });
    expect(reminder(8)).toMatchObject({ text: 'slutbed', next_fire_at: TUE_7PM });
    // The group's delete log says so, and loses its Undo.
    const edit = calls.find((c) => c.url.endsWith('/editMessageText') && /Restored/.test(c.body.text));
    expect(edit.body).toMatchObject({ chat_id: 1, message_id: 99 });
    expect(JSON.stringify(edit.body.reply_markup)).not.toMatch(/Undo/);
    expect(await call('undo', del.undo)).toMatchObject({ ok: false });
  });

  it('deletes a chore once when two deletes race, with one log', async () => {
    const r = reminder(8);
    const { deleteReminder } = await import('../src/chores.js');
    expect(await deleteReminder(env, r)).toBeTruthy();
    expect(await deleteReminder(env, r)).toBeNull();
    expect(await call('chore/8/delete', {})).toMatchObject({ ok: false });
    for (let i = 0; i < tasks.length; i++) await tasks[i];
    expect(sent(/deleted|Deleted/)).toHaveLength(1);
    expect(sql.prepare('SELECT COUNT(*) AS n FROM trash').get().n).toBe(1);
  });

  it('takes back only a chore added moments ago', async () => {
    const added = await call('chores', { text: 'trash 7pm daily' });
    Date.now.mockReturnValue(NOW + 6 * 60000);
    expect(await call('undo', added.undo)).toMatchObject({ ok: false, message: 'Too late to take that back.' });
    expect(reminder(added.chore.id)).toBeDefined();
  });

  it('will not restore a Done\'s stash as if it were a delete', async () => {
    const done = await call('chore/9/done', { how: 'me' });
    const stash = sql.prepare('SELECT id FROM trash').get();
    expect(await call('undo', { kind: 'delete', id: stash.id })).toMatchObject({ ok: false });
    expect(reminder(9)).toBeUndefined();
    expect((await call('undo', done.undo)).ok).toBe(true);
  });

  it('takes back a chore just added, quietly, as the confirmation\'s Undo does', async () => {
    const added = await call('chores', { text: 'trash 7pm daily' });
    expect(added.undo).toEqual({ kind: 'add', id: added.chore.id });
    calls.length = 0;
    const res = await call('undo', added.undo);
    expect(res).toMatchObject({ ok: true, message: '↩️ Undone — trash' });
    expect(reminder(added.chore.id)).toBeUndefined();
    expect(res.chores.map((c) => c.text)).not.toContain('trash');
    expect(sent(/./)).toHaveLength(0);
  });

  it('refuses anything else', async () => {
    expect(await call('undo', { kind: 'done', id: 'x' })).toMatchObject({ ok: false });
    expect(await call('undo', { kind: 'pause', id: 8 })).toMatchObject({ ok: false, message: 'Nothing to undo.' });
    expect(await call('undo', { kind: 'add', id: 8 }, { startParam: 'g1', user: { id: 77, first_name: 'Eve' } }))
      .toMatchObject({ status: 403 });
    expect(reminder(8)).toBeDefined();
  });
});

describe('adding a chore', () => {
  it('reads what /chore reads, and puts it on the board', async () => {
    const res = await call('chores', { text: 'trash 7pm daily', scored: true });
    expect(res.ok).toBe(true);
    expect(res.message).toBe('📝 Added — first nag tomorrow 7:00 PM');
    const added = sql.prepare("SELECT * FROM reminders WHERE text = 'trash'").get();
    expect(added).toMatchObject({ schedule_kind: 'daily', scored: 1, created_by: '@nicholaswan', display_num: 3 });
    expect(res.chore.text).toBe('trash');
    expect(calls.some((c) => c.url.endsWith('/editMessageText') && c.body.text.includes('<b>trash</b>'))).toBe(true);
  });

  it('adds a reminder for a chosen housemate', async () => {
    await call('chores', { text: 'pay tax friday 9am', scored: false, assignee: '3' });
    expect(sql.prepare("SELECT * FROM reminders WHERE text = 'pay tax'").get())
      .toMatchObject({ scored: 0, assignee_name: '@Dodgerblueee', assignee_user_id: 3 });
  });

  it('asks for a time instead of opening the chat\'s wizard', async () => {
    const res = await call('chores', { text: 'descale kettle' });
    expect(res).toMatchObject({ ok: false });
    expect(res.message).toMatch(/^When\?/);
    expect(sql.prepare('SELECT COUNT(*) AS n FROM drafts').get().n).toBe(0);
  });

  it('fires a chore added for now on the spot', async () => {
    await call('chores', { text: 'feed cats now' });
    const added = sql.prepare("SELECT id FROM reminders WHERE text = 'feed cats'").get();
    expect(sql.prepare("SELECT COUNT(*) AS n FROM firings WHERE reminder_id = ? AND state = 'nagging'").get(added.id).n).toBe(1);
  });
});

describe('stats', () => {
  it('counts this week as /stats does', async () => {
    seed('firings', {
      reminder_id: 8, chat_id: 1, reminder_text: 'slutbed', fired_at: NOW - HOUR, state: 'done',
      done_by: '@Dodgerblueee', done_at: NOW - HOUR, scored: 1,
    });
    seed('firings', {
      reminder_id: 8, chat_id: 1, reminder_text: 'slutbed', fired_at: NOW - 2 * HOUR, state: 'done',
      done_by: '@nicholaswan & @Dodgerblueee', done_at: NOW - 2 * HOUR, scored: 1,
    });
    const res = await call('stats/week');
    expect(res.people).toEqual([
      { name: '@Dodgerblueee', count: 2, solo: 1 },
      { name: '@nicholaswan', count: 1, solo: 0 },
    ]);
    expect(res.together).toBe(1);
    expect(res.recent.map((r) => r.who)).toEqual(['@Dodgerblueee', '@nicholaswan & @Dodgerblueee']);
  });
});

describe('the board button', () => {
  it('opens the Mini App once MINI_APP_URL is set, and stays ⚙️ Manage until then', () => {
    expect(dashboardButtons(env, 1).inline_keyboard[0][0]).toEqual({ text: '⚙️ Manage chores', callback_data: 'm:list' });
    const withApp = { ...env, MINI_APP_URL: 'https://t.me/TwoShotsNagBot/chores' };
    expect(dashboardButtons(withApp, -1004418632524).inline_keyboard[0][0]).toEqual({
      text: '🐾 Chores', url: 'https://t.me/TwoShotsNagBot/chores?startapp=g-1004418632524&mode=compact',
    });
    expect(miniAppLink({ MINI_APP_URL: 'not a url' }, 1)).toBeNull();
  });
});

describe('nested chores', () => {
  const nest = (id, num, text, parent) => seed('reminders', {
    id, chat_id: 1, display_num: num, text, schedule_kind: 'interval', schedule_detail: '{"days":4,"h":21,"mi":0}',
    nag_intervals: '[15,30,60]', next_fire_at: TUE_7PM, paused: 0, created_at: NOW, scored: 1, parent_id: parent,
  });

  it('draws the whole family, top tier first, relative to the chore on screen', async () => {
    nest(43, 5, 'wash neakasa', null);
    nest(5, 6, 'clear poop', 43);
    nest(60, 7, 'shake neakasa', 5);
    nest(61, 8, 'scoop tray', 43);
    const rels = async (id) => (await call(`chore/${id}`)).chore.family.map((m) => [m.text, m.depth, m.rel]);
    expect(await rels(5)).toEqual([
      ['wash neakasa', 0, 'above'], ['clear poop', 1, 'self'], ['shake neakasa', 2, 'below'], ['scoop tray', 1, 'side'],
    ]);
    expect((await rels(43)).map(([, , rel]) => rel)).toEqual(['self', 'below', 'below', 'below']);
    expect((await call('chore/8')).chore.family).toEqual([]);
    expect((await call('chores')).chores.find((c) => c.id === 60).under).toBe('clear poop');
  });

  it('answers a parent\'s Done even when resetting a child cannot be written', async () => {
    nest(43, 5, 'wash neakasa', null);
    nest(5, 6, 'clear poop', 43);
    sql.exec(`UPDATE reminders SET next_fire_at = ${NOW - DAY} WHERE id = 5`);
    env.DB = d1(sql, (q, args) => {
      if (/UPDATE reminders SET next_fire_at = \? WHERE id = \? AND next_fire_at = \?/.test(q) && args[1] === 5) {
        throw new Error('D1_ERROR: cover');
      }
    });
    const reply = await call('chore/43/done', {});
    expect(reply).toMatchObject({ ok: true });
    expect(reply.chore.id).toBe(43);
  });

  it('sets and clears what a chore resets with, and refuses a loop', async () => {
    nest(43, 5, 'wash neakasa', null);
    nest(5, 6, 'clear poop', null);
    expect((await call('chore/5/edit', { field: 'parent', value: '43' })).chore.parentId).toBe(43);
    expect(await call('chore/43/edit', { field: 'parent', value: '5' })).toMatchObject({ ok: false });
    expect((await call('chore/5/edit', { field: 'parent', value: '0' })).chore.parentId).toBeNull();
  });
});
