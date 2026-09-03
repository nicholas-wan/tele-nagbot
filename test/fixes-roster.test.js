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
function db({ members = [], runs = [], firing = NAGGING, known = true }) {
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
              if (sql.includes('FROM reminders')) return REMINDER;
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

  it('routes nothing from a DM callback', async () => {
    const runs = [];
    const env = { BOT_TOKEN: 'token', ALLOWED_CHATS: '1', DB: db({ runs }) };
    await handleUpdate(env, {
      callback_query: {
        id: 'cb', data: 'd:5', from: { id: 2, username: 'nick' },
        message: { message_id: 42, chat: { id: 555, type: 'private' }, text: 'nag' },
      },
    });
    expect(calls).toEqual([]);
    expect(runs).toEqual([]);
  });

  it('still ignores a stranger silently', async () => {
    const env = { BOT_TOKEN: 'token', ALLOWED_CHATS: '1', DB: db({ known: false }) };
    await handleUpdate(env, dm('/start'));
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
