import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { handleUpdate } from '../src/handlers.js';
import { buildIcs } from '../src/invite.js';

const REMINDER = {
  id: 10, chat_id: 1, text: 'clear poop', paused: 0, scored: 1,
  next_fire_at: Date.now() + 3600000, schedule_kind: 'interval', nag_intervals: '[15,30,60]',
  schedule_detail: JSON.stringify({ h: 21, mi: 0, days: 8 }), assignee_name: null,
};

const NAGGING = {
  id: 5, reminder_id: 10, chat_id: 1, state: 'nagging', nag_count: 0, snoozes_used: 0,
  fired_at: Date.now() - 3600000, last_message_id: 42, last_message_ephemeral: 0,
  nag_user_id: null, cat: 'both', scored: 1,
};

// A DB fake whose `members` rows are the household — the same table
// rememberMember writes on every update.
function db({ members = [], runs = [], firing = NAGGING, known = true, reminder = REMINDER }) {
  return {
    runs,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              // A firing lookup that names chat_id only matches its own chat.
              if (sql.includes('FROM firings')) {
                if (/chat_id = \?/.test(sql) && !sql.includes('nag_chat_id')) {
                  const chatArg = args[1];
                  return chatArg === firing.chat_id ? firing : null;
                }
                return firing;
              }
              if (sql.includes('FROM reminders')) return reminder;
              if (sql.includes('SELECT tz')) return { tz: 'Asia/Singapore' };
              if (sql.includes('FROM members')) return known ? { x: 1 } : null;
              return null;
            },
            async all() {
              if (sql.includes('FROM members')) return { results: members };
              return { results: [] };
            },
            async run() {
              runs.push({ sql, args });
              return { meta: { changes: 1, last_row_id: 1 } };
            },
          };
        },
      };
    },
  };
}

const HOUSEHOLD = [
  { username: 'nick', first_name: 'Nick' },
  { username: 'jane', first_name: 'Jane' },
  { username: null, first_name: 'Bob' },
];

// The roster spells Jane by her username; nobody types that.
const USERNAMED = [
  { username: 'nick', first_name: 'Nick' },
  { username: 'janedoe', first_name: 'Jane' },
];

const TWO_JANES = [
  { username: 'nick', first_name: 'Nick' },
  { username: 'janedoe', first_name: 'Jane' },
  { username: 'janesmith', first_name: 'Jane' },
];

const doneReply = (text) => ({
  message: {
    message_id: 7, chat: { id: 1 }, from: { id: 2, username: 'nick', first_name: 'Nick' },
    text, reply_to_message: { message_id: 42, chat: { id: 1 } },
  },
});

describe('household roster comes from members, not from past credits', () => {
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

  const creditOf = (runs) => {
    const done = runs.find((r) => r.sql.includes("SET state = 'done'"));
    return done && done.args[0];
  };

  it('credits every seen member on "done together", rendered as senderName would', async () => {
    const runs = [];
    const env = { BOT_TOKEN: 'token', ALLOWED_CHATS: '1', DB: db({ members: HOUSEHOLD, runs }) };
    await handleUpdate(env, doneReply('done together'));
    expect(creditOf(runs)).toBe('@nick & @jane & Bob');
  });

  it('never queries firings.done_by to build the roster', async () => {
    const seen = [];
    const base = db({ members: HOUSEHOLD });
    const env = {
      BOT_TOKEN: 'token', ALLOWED_CHATS: '1',
      DB: { prepare(sql) { seen.push(sql); return base.prepare(sql); } },
    };
    await handleUpdate(env, doneReply('done together'));
    expect(seen.some((s) => s.includes('DISTINCT done_by'))).toBe(false);
    expect(seen.some((s) => s.includes('FROM members WHERE chat_id'))).toBe(true);
  });

  it('matches a hand-typed "jane" to the roster\'s "@jane"', async () => {
    const runs = [];
    const env = { BOT_TOKEN: 'token', ALLOWED_CHATS: '1', DB: db({ members: HOUSEHOLD, runs }) };
    await handleUpdate(env, doneReply('done with jane'));
    expect(creditOf(runs)).toBe('@nick & @jane');
  });

  it('drops an unknown name instead of inventing a housemate', async () => {
    const runs = [];
    const env = { BOT_TOKEN: 'token', ALLOWED_CHATS: '1', DB: db({ members: HOUSEHOLD, runs }) };
    await handleUpdate(env, doneReply('done with jane and brian'));
    // The chore still completes, credited to the people who really exist.
    expect(creditOf(runs)).toBe('@nick & @jane');
    expect(creditOf(runs)).not.toContain('brian');
    // …and the replier is told privately, with the roster to choose from.
    const note = calls.find((c) => c.url.endsWith('/sendMessage') && /Not in this household/.test(c.body.text || ''));
    expect(note).toBeTruthy();
    expect(note.body.receiver_user_id).toBe(2);
    expect(note.body.text).toContain('brian');
    expect(note.body.text).toContain('@jane');
    expect(note.body.text).toContain('Bob');
  });

  it('credits "@janedoe" when the reply says "done with Jane"', async () => {
    const runs = [];
    const env = { BOT_TOKEN: 'token', ALLOWED_CHATS: '1', DB: db({ members: USERNAMED, runs }) };
    await handleUpdate(env, doneReply('done with Jane'));
    expect(creditOf(runs)).toBe('@nick & @janedoe');
    expect(calls.some((c) => /Not in this household/.test((c.body && c.body.text) || ''))).toBe(false);
  });

  it('treats a first name two housemates share as unknown', async () => {
    const runs = [];
    const env = { BOT_TOKEN: 'token', ALLOWED_CHATS: '1', DB: db({ members: TWO_JANES, runs }) };
    await handleUpdate(env, doneReply('done with Jane'));
    // Better to credit nobody than to pick a Jane at random.
    expect(creditOf(runs)).toBe('@nick');
    const note = calls.find((c) => c.url.endsWith('/sendMessage') && /Not in this household/.test(c.body.text || ''));
    expect(note).toBeTruthy();
    expect(note.body.text).toContain('Jane');
    expect(note.body.text).toContain('@janedoe');
    expect(note.body.text).toContain('@janesmith');
  });

  it('says nothing extra when every name is recognised', async () => {
    const env = { BOT_TOKEN: 'token', ALLOWED_CHATS: '1', DB: db({ members: HOUSEHOLD }) };
    await handleUpdate(env, doneReply('done with @jane'));
    expect(calls.some((c) => /Not in this household/.test((c.body && c.body.text) || ''))).toBe(false);
  });
});

describe('callbacks act only on their own chat', () => {
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

  const tap = (data, chatId) => ({
    callback_query: {
      id: 'cb', data, from: { id: 3, username: 'mallory' },
      message: { message_id: 42, chat: { id: chatId }, text: 'nag' },
    },
  });

  it('completes a Done tap from the firing\'s own chat', async () => {
    const runs = [];
    const env = { BOT_TOKEN: 'token', ALLOWED_CHATS: '1,2', DB: db({ members: HOUSEHOLD, runs }) };
    await handleUpdate(env, tap('d:5', 1));
    expect(runs.some((r) => r.sql.includes("SET state = 'done'"))).toBe(true);
  });

  for (const [label, data, marker] of [
    ['Done', 'd:5', "SET state = 'done'"],
    ['Done together', 'b:5', "SET state = 'done'"],
    ['Snooze', 's:5', 'snoozes_used'],
    ['a snooze preset', 'z:5:30', 'snoozes_used'],
    ['Delete chore', 'x:5', 'DELETE FROM reminders'],
    ['Together-too on a receipt', 'g:5', 'SET done_by'],
  ]) {
    it(`ignores ${label} tapped from another chat`, async () => {
      const runs = [];
      const env = { BOT_TOKEN: 'token', ALLOWED_CHATS: '1,2', DB: db({ members: HOUSEHOLD, runs }) };
      await handleUpdate(env, tap(data, 2));
      expect(runs.some((r) => r.sql.includes(marker))).toBe(false);
      expect(calls.some((c) => c.url.endsWith('/answerCallbackQuery'))).toBe(true);
    });
  }
});

describe('a member DM points back at the group', () => {
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

  const dm = (text) => ({
    message: {
      message_id: 5, chat: { id: 555, type: 'private' },
      from: { id: 2, username: 'nick', first_name: 'Nick' }, text,
    },
  });

  it('answers /start without promising a personal nag line', async () => {
    const runs = [];
    const env = { BOT_TOKEN: 'token', ALLOWED_CHATS: '1', DB: db({ runs }) };
    await handleUpdate(env, dm('/start'));
    const sent = calls.find((c) => c.url.endsWith('/sendMessage'));
    expect(sent.body.text).toMatch(/family group/);
    expect(sent.body.text).not.toMatch(/nag line/);
    // dm_ok is vestigial: nothing routes to a DM any more, so nothing is stored.
    expect(runs.some((r) => r.sql.includes('dm_ok'))).toBe(false);
  });

  it('gives any other DM text the same single reply', async () => {
    const env = { BOT_TOKEN: 'token', ALLOWED_CHATS: '1', DB: db({}) };
    await handleUpdate(env, dm('done'));
    const sends = calls.filter((c) => c.url.endsWith('/sendMessage'));
    expect(sends.length).toBe(1);
    expect(sends[0].body.text).toMatch(/family group/);
  });

  const dmTap = (data) => ({
    callback_query: {
      id: 'cb', data, from: { id: 2, username: 'nick' },
      message: { message_id: 42, chat: { id: 555, type: 'private' }, text: 'nag' },
    },
  });

  it('carries no button on the pointer, so there is nothing to leave spinning', async () => {
    const env = { BOT_TOKEN: 'token', ALLOWED_CHATS: '1', DB: db({}) };
    await handleUpdate(env, dm('hello'));
    const sent = calls.find((c) => c.url.endsWith('/sendMessage'));
    expect(sent.body.reply_markup).toBeUndefined();
  });

  it('answers a DM callback instead of leaving the button spinning', async () => {
    const runs = [];
    const env = { BOT_TOKEN: 'token', ALLOWED_CHATS: '1', DB: db({ runs }) };
    await handleUpdate(env, dmTap('d:5'));
    // Nothing is actionable in a DM — but the tap still gets its answer.
    expect(calls.map((c) => c.url.replace(/.*\//, ''))).toEqual(['answerCallbackQuery']);
    expect(runs).toEqual([]);
  });

  it('clears the tapped message when a leftover ✅ OK is tapped in a DM', async () => {
    const env = { BOT_TOKEN: 'token', ALLOWED_CHATS: '1', DB: db({}) };
    await handleUpdate(env, dmTap('ok'));
    const del = calls.find((c) => c.url.endsWith('/deleteMessage'));
    expect(del).toBeTruthy();
    expect(del.body).toMatchObject({ chat_id: 555, message_id: 42 });
    expect(calls.some((c) => c.url.endsWith('/answerCallbackQuery'))).toBe(true);
  });

  it('still ignores a stranger silently', async () => {
    const env = { BOT_TOKEN: 'token', ALLOWED_CHATS: '1', DB: db({ known: false }) };
    await handleUpdate(env, dm('/start'));
    expect(calls).toEqual([]);
  });
});

describe('leaving the group leaves the roster', () => {
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

  const JANE = { id: 4, username: 'janedoe', first_name: 'Jane' };
  const forgot = (runs) => runs.find((r) => /DELETE FROM members/.test(r.sql));
  const remembered = (runs) => runs.find((r) => /INSERT INTO members/.test(r.sql));

  const memberUpdate = (status, chatId = 1) => ({
    chat_member: {
      chat: { id: chatId, type: 'supergroup' }, date: 1,
      from: { id: 2, username: 'nick', first_name: 'Nick' },
      old_chat_member: { user: JANE, status: 'member' },
      new_chat_member: { user: JANE, status },
    },
  });

  it('drops the row on a left_chat_member service message', async () => {
    const runs = [];
    const env = { BOT_TOKEN: 'token', ALLOWED_CHATS: '1', DB: db({ members: HOUSEHOLD, runs }) };
    await handleUpdate(env, {
      message: {
        message_id: 8, chat: { id: 1 },
        from: { id: 4, username: 'janedoe', first_name: 'Jane' }, left_chat_member: JANE,
      },
    });
    expect(forgot(runs).args).toEqual([1, 4]);
    // The message announcing the departure must not re-learn the leaver.
    expect(remembered(runs)).toBeUndefined();
  });

  it('ignores the bot removing itself', async () => {
    const runs = [];
    const env = { BOT_TOKEN: 'token', ALLOWED_CHATS: '1', DB: db({ members: HOUSEHOLD, runs }) };
    await handleUpdate(env, {
      message: {
        message_id: 8, chat: { id: 1 }, from: { id: 2, username: 'nick' },
        left_chat_member: { id: 77, is_bot: true, first_name: 'TwoShotsNagBot' },
      },
    });
    expect(runs).toEqual([]);
  });

  for (const status of ['left', 'kicked']) {
    it(`drops the row when a chat_member update says ${status}`, async () => {
      const runs = [];
      const env = { BOT_TOKEN: 'token', ALLOWED_CHATS: '1', DB: db({ members: HOUSEHOLD, runs }) };
      await handleUpdate(env, memberUpdate(status));
      expect(forgot(runs).args).toEqual([1, 4]);
      expect(remembered(runs)).toBeUndefined();
    });
  }

  for (const status of ['member', 'administrator', 'creator', 'restricted']) {
    it(`keeps the row when a chat_member update says ${status}`, async () => {
      const runs = [];
      const env = { BOT_TOKEN: 'token', ALLOWED_CHATS: '1', DB: db({ members: HOUSEHOLD, runs }) };
      await handleUpdate(env, memberUpdate(status));
      expect(forgot(runs)).toBeUndefined();
      expect(remembered(runs).args.slice(0, 4)).toEqual([1, 4, 'janedoe', 'Jane']);
    });
  }

  it('ignores a chat_member update from a chat outside ALLOWED_CHATS', async () => {
    const runs = [];
    const env = { BOT_TOKEN: 'token', ALLOWED_CHATS: '1', DB: db({ members: HOUSEHOLD, runs }) };
    await handleUpdate(env, memberUpdate('left', -9));
    expect(runs).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe('ICS identity and single-line values', () => {
  const base = { summary: 'dentist', location: 'Mount E', startMs: 1_700_000_000_000, durationMs: 3600000 };
  const uidOf = (ics) => ics.split('\r\n').find((l) => l.startsWith('UID:'));

  it('gives two same-start, same-length events different UIDs', () => {
    const a = uidOf(buildIcs({ ...base, now: 1_700_000_000_000 }));
    const b = uidOf(buildIcs({ ...base, now: 1_700_000_000_000 }));
    expect(a).not.toBe(b);
    expect(a.endsWith('@nag-bot')).toBe(true);
  });

  it('honours an explicit uid so a test can pin one', () => {
    expect(uidOf(buildIcs({ ...base, uid: 'fixed@nag-bot' }))).toBe('UID:fixed@nag-bot');
  });

  it('collapses newlines in SUMMARY and LOCATION', () => {
    const ics = buildIcs({
      ...base, summary: 'bday\nlunch', location: 'Fu Yuan\n80 Middle Rd', uid: 'u@nag-bot',
    });
    // A raw newline would end the property and corrupt every line after it.
    for (const line of ics.split('\r\n')) expect(line).not.toContain('\n');
    expect(ics).toContain('SUMMARY:bday lunch');
    expect(ics).toContain('LOCATION:Fu Yuan 80 Middle Rd');
  });
});

// Two spellings that normalise the same are a coin flip, whichever tables they
// come from. The roster used to be consulted before the aliases, so a name a
// roster spelling and someone else's first name both answered to silently went
// to whichever row the database handed back first.
describe('a name two housemates answer to credits nobody', () => {
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

  const creditOf = (runs) => {
    const done = runs.find((r) => r.sql.includes("SET state = 'done'"));
    return done && done.args[0];
  };
  const notedUnknown = () => calls.find((c) => c.url.endsWith('/sendMessage')
    && /Not in this household/.test((c.body && c.body.text) || ''));

  // @jane is spelled "@jane" on the roster; @janedoe's first name is Jane too.
  const ALIAS_VS_ROSTER = [
    { username: 'nick', first_name: 'Nick' },
    { username: 'jane', first_name: 'Jane' },
    { username: 'janedoe', first_name: 'Jane' },
  ];

  // @brian, and a housemate with no username whose first name is Brian — so
  // the roster itself holds two spellings of "brian".
  const TWO_BRIANS = [
    { username: 'nick', first_name: 'Nick' },
    { username: 'brian', first_name: 'Brian' },
    { username: null, first_name: 'Brian' },
  ];

  it('does not hand "jane" to @jane when @janedoe answers to it as well', async () => {
    const runs = [];
    const env = { BOT_TOKEN: 'token', ALLOWED_CHATS: '1', DB: db({ members: ALIAS_VS_ROSTER, runs }) };
    await handleUpdate(env, doneReply('done with jane'));
    expect(creditOf(runs)).toBe('@nick');
    const note = notedUnknown();
    expect(note.body.text).toContain('jane');
    expect(note.body.text).toContain('@janedoe');
  });

  it('does not fold @brian and a username-less Brian into one person', async () => {
    const runs = [];
    const env = { BOT_TOKEN: 'token', ALLOWED_CHATS: '1', DB: db({ members: TWO_BRIANS, runs }) };
    await handleUpdate(env, doneReply('done with brian'));
    expect(creditOf(runs)).toBe('@nick');
    expect(notedUnknown()).toBeTruthy();
  });

  it('still resolves a first name only one housemate answers to', async () => {
    const runs = [];
    const env = { BOT_TOKEN: 'token', ALLOWED_CHATS: '1', DB: db({ members: USERNAMED, runs }) };
    await handleUpdate(env, doneReply('done with jane'));
    expect(creditOf(runs)).toBe('@nick & @janedoe');
    expect(notedUnknown()).toBeUndefined();
  });

  it('still resolves an unshared roster spelling', async () => {
    const runs = [];
    const env = { BOT_TOKEN: 'token', ALLOWED_CHATS: '1', DB: db({ members: ALIAS_VS_ROSTER, runs }) };
    await handleUpdate(env, doneReply('done with @janedoe'));
    expect(creditOf(runs)).toBe('@nick & @janedoe');
    expect(notedUnknown()).toBeUndefined();
  });
});

describe('a restricted member is only in the chat while is_member says so', () => {
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

  const JANE = { id: 4, username: 'janedoe', first_name: 'Jane' };
  const restricted = (isMember) => ({
    chat_member: {
      chat: { id: 1, type: 'supergroup' }, date: 1,
      from: { id: 2, username: 'nick', first_name: 'Nick' },
      old_chat_member: { user: JANE, status: 'member' },
      new_chat_member: { user: JANE, status: 'restricted', is_member: isMember },
    },
  });

  // ChatMemberRestricted carries is_member: someone restricted who then leaves
  // arrives as restricted with is_member false, and taking the status at face
  // value kept them drawing rotations from a chat they had walked out of.
  it('drops the row for a restricted member who is no longer in the chat', async () => {
    const runs = [];
    const env = { BOT_TOKEN: 'token', ALLOWED_CHATS: '1', DB: db({ members: HOUSEHOLD, runs }) };
    await handleUpdate(env, restricted(false));
    expect(runs.find((r) => /DELETE FROM members/.test(r.sql)).args).toEqual([1, 4]);
    expect(runs.some((r) => /INSERT INTO members/.test(r.sql))).toBe(false);
  });

  it('keeps a restricted member who is still in the chat', async () => {
    const runs = [];
    const env = { BOT_TOKEN: 'token', ALLOWED_CHATS: '1', DB: db({ members: HOUSEHOLD, runs }) };
    await handleUpdate(env, restricted(true));
    expect(runs.some((r) => /DELETE FROM members/.test(r.sql))).toBe(false);
    expect(runs.find((r) => /INSERT INTO members/.test(r.sql)).args.slice(0, 4))
      .toEqual([1, 4, 'janedoe', 'Jane']);
  });
});

describe('/resume on a chore that was never paused', () => {
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

  function choreDb(runs, paused) {
    const r = { ...REMINDER, display_num: 1, paused };
    return {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async first() {
                if (sql.includes('SELECT tz')) return { tz: 'Asia/Singapore' };
                return null;
              },
              async all() {
                if (sql.includes('SELECT * FROM reminders')) return { results: [r] };
                return { results: [] };
              },
              async run() { runs.push({ sql, args }); return { meta: { changes: 1, last_row_id: 1 } }; },
            };
          },
        };
      },
    };
  }

  const cmd = (text) => ({
    message: { message_id: 5, chat: { id: 1 }, from: { id: 2, username: 'nick', first_name: 'Nick' }, text },
  });
  // Learning the sender and logging the bot's own message are bookkeeping
  // every update does; neither is a change to the chore.
  const choreWrites = (runs) => runs.filter((r) => /reminders|firings|settings/.test(r.sql));
  const said = () => calls.filter((c) => c.url.endsWith('/sendMessage'))
    .map((c) => c.body.text).join('\n');

  it('says it is not paused instead of announcing a resume', async () => {
    const runs = [];
    await handleUpdate({ BOT_TOKEN: 'token', ALLOWED_CHATS: '1', DB: choreDb(runs, 0) }, cmd('/resume poop'));
    expect(said()).toContain("isn't paused");
    expect(said()).not.toContain('Resumed');
    // Nothing was frozen, so nothing is restamped, rescheduled, or redrawn.
    expect(choreWrites(runs)).toEqual([]);
  });

  it('says the same about /pause on a chore already paused', async () => {
    const runs = [];
    await handleUpdate({ BOT_TOKEN: 'token', ALLOWED_CHATS: '1', DB: choreDb(runs, 1) }, cmd('/pause poop'));
    expect(said()).toContain('already paused');
    expect(choreWrites(runs)).toEqual([]);
  });

  it('still announces the real transitions', async () => {
    const runs = [];
    await handleUpdate({ BOT_TOKEN: 'token', ALLOWED_CHATS: '1', DB: choreDb(runs, 1) }, cmd('/resume poop'));
    expect(said()).toContain('Resumed');
    expect(choreWrites(runs).some((r) => /UPDATE reminders SET paused/.test(r.sql))).toBe(true);
  });
});

describe('an orphaned firing expires under the same compare-and-swap', () => {
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

  it("guards the expiry on state = 'nagging'", async () => {
    const runs = [];
    const env = {
      BOT_TOKEN: 'token', ALLOWED_CHATS: '1',
      DB: db({ members: HOUSEHOLD, runs, reminder: null }),
    };
    await handleUpdate(env, {
      callback_query: {
        id: 'cb', data: 'd:5', from: { id: 2, username: 'nick' },
        message: { message_id: 42, chat: { id: 1 }, text: 'nag' },
      },
    });
    const expiry = runs.find((r) => /state = 'expired'/.test(r.sql));
    // Without the guard a cron tick that expired this firing a moment earlier
    // would be overwritten by the tap — the rule every other state change here
    // already follows.
    expect(expiry.sql).toContain("state = 'nagging'");
    const answered = calls.find((c) => c.url.endsWith('/answerCallbackQuery'));
    expect(answered.body.text).toBe('That reminder was deleted.');
  });
});
