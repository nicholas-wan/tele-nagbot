// Regressions in the editor, the pinned board, and /setup.
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { handleUpdate } from '../src/handlers.js';
import { updateDashboard } from '../src/dashboard.js';
import { localParts, zonedEpoch } from '../src/time.js';
import worker from '../src/index.js';

const TZ = 'Asia/Singapore';

const CHORE = {
  id: 10, chat_id: 1, display_num: 3, text: 'Water plants', paused: 0,
  next_fire_at: Date.now() + 3600000, schedule_kind: 'daily', nag_intervals: '[15,30,60]',
  schedule_detail: JSON.stringify({ h: 19, mi: 0 }), assignee_name: null, scored: 1,
};

// One D1 fake for the whole file: branches on SQL substrings and records every
// write so a test can assert on what the bot actually stored.
function db(reminder = CHORE, { runs = [], dashboardMsgId = 99, firings = [] } = {}) {
  return {
    prepare(sql) {
      const stmt = (args = []) => ({
        async first() {
          if (sql.includes('dashboard_msg_id')) return { dashboard_msg_id: dashboardMsgId, tz: TZ };
          if (sql.includes('SELECT tz')) return { tz: TZ };
          if (sql.includes('paused_until')) return null;
          if (sql.includes('FROM firings')) return firings[0] || null;
          if (sql.includes('FROM reminders')) return reminder;
          return null;
        },
        async all() {
          if (sql.includes('FROM reminders')) return { results: reminder ? [reminder] : [] };
          if (sql.includes('FROM firings')) return { results: firings };
          return { results: [] };
        },
        async run() {
          runs.push({ sql, args });
          return { meta: { changes: 1, last_row_id: 1 } };
        },
      });
      return { ...stmt(), bind: (...args) => stmt(args) };
    },
  };
}

const env = (reminder, opts) => ({
  BOT_TOKEN: 'token', ALLOWED_CHATS: '1', DB: db(reminder, opts),
});

// An ephemeral message is what /edit's editor almost always is: message_id 0
// plus its own id in the ephemeral sequence.
const ephemeralTap = (data) => ({
  callback_query: {
    id: 'cb', data, from: { id: 2, first_name: 'Nick' },
    message: { message_id: 0, ephemeral_message_id: 42, chat: { id: 1 } },
  },
});

describe('editor, board, and setup fixes', () => {
  const calls = [];

  beforeEach(() => {
    calls.length = 0;
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const body = init && init.body ? JSON.parse(init.body) : null;
      calls.push({ url: String(url), body });
      const result = body && body.receiver_user_id
        ? { message_id: 0, ephemeral_message_id: 42 }
        : { message_id: 99 };
      return new Response(JSON.stringify({ ok: true, result }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }));
  });

  afterEach(() => vi.unstubAllGlobals());

  const find = (method) => calls.find((c) => c.url.endsWith(`/${method}`));
  const all = (method) => calls.filter((c) => c.url.endsWith(`/${method}`));

  // 1. The /edit editor arrives ephemeral, so every later tap carries
  // message_id 0. Editing it with the public method is a no-op Telegram
  // rejects — the screen freezes while the toast still claims success.
  it('redraws an ephemeral editor with the ephemeral edit method', async () => {
    await handleUpdate(env(), ephemeralTap('e:time:10'));
    const edited = find('editEphemeralMessageText');
    expect(edited).toBeTruthy();
    expect(edited.body.ephemeral_message_id).toBe(42);
    expect(edited.body.receiver_user_id).toBe(2);
    // The submenu really is the new screen, not the old menu.
    expect(JSON.stringify(edited.body.reply_markup)).toContain('e:settime:10:8');
    expect(find('editMessageText')).toBeUndefined();
  });

  it('redraws an ephemeral editor on menu, value, and toggle taps alike', async () => {
    for (const data of ['e:menu:10', 'e:settime:10:8', 'e:rotate:10', 'e:score:10', 'e:pause:10']) {
      calls.length = 0;
      await handleUpdate(env(), ephemeralTap(data));
      const edited = all('editEphemeralMessageText');
      expect(edited.length, `${data} redrew the editor`).toBeGreaterThan(0);
      expect(edited[edited.length - 1].body.ephemeral_message_id).toBe(42);
      // The board is public and may be edited; the editor never is by id 0.
      expect(all('editMessageText').some((c) => c.body.message_id === 0)).toBe(false);
    }
  });

  // The dashboard is a genuinely public message and must keep being edited
  // in place, with the chore list as its text.
  it('still edits the pinned dashboard in place when the editor lives there', async () => {
    await handleUpdate(env(), {
      callback_query: {
        id: 'cb', data: 'e:time:10', from: { id: 2, first_name: 'Nick' },
        message: { message_id: 99, chat: { id: 1 }, text: 'dashboard' },
      },
    });
    const edited = find('editMessageText');
    expect(edited.body.message_id).toBe(99);
    expect(edited.body.text).toContain('Water plants');
    expect(find('editEphemeralMessageText')).toBeUndefined();
  });

  // 2. A failed edit is not evidence the board is gone. Recreating on every
  // failure pins a second board beside the first.
  const boardDb = () => ({
    prepare(sql) {
      const stmt = () => ({
        async first() {
          if (sql.includes('dashboard_msg_id')) return { dashboard_msg_id: 99, tz: TZ };
          return null;
        },
        async all() {
          if (sql.includes('FROM reminders')) return { results: [CHORE] };
          return { results: [] };
        },
        async run() { return { meta: { changes: 1 } }; },
      });
      return { ...stmt(), bind: () => stmt() };
    },
  });

  function failEdits(description, errorCode) {
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const body = init && init.body ? JSON.parse(init.body) : null;
      calls.push({ url: String(url), body });
      if (String(url).endsWith('/editMessageText')) {
        return new Response(JSON.stringify({ ok: false, error_code: errorCode, description }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 100 } }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }));
  }

  it('does not spawn a second board when a board edit fails transiently', async () => {
    for (const description of [
      'TypeError: Failed to fetch',
      'Too Many Requests: retry after 30',
      'Bad Request: chat not found',
    ]) {
      calls.length = 0;
      failEdits(description, 400);
      await updateDashboard({ BOT_TOKEN: 'token', DB: boardDb() }, 1);
      expect(find('editMessageText'), description).toBeTruthy();
      expect(find('sendMessage'), description).toBeUndefined();
      expect(find('pinChatMessage'), description).toBeUndefined();
    }
  });

  it('still recreates the board when Telegram says the message is gone', async () => {
    for (const description of [
      'Bad Request: message to edit not found',
      'Bad Request: MESSAGE_ID_INVALID',
      "Bad Request: message can't be edited",
    ]) {
      calls.length = 0;
      failEdits(description, 400);
      await updateDashboard({ BOT_TOKEN: 'token', DB: boardDb() }, 1);
      expect(find('sendMessage'), description).toBeTruthy();
      expect(find('pinChatMessage'), description).toBeTruthy();
    }
  });

  it('leaves an unchanged board alone', async () => {
    calls.length = 0;
    failEdits('Bad Request: message is not modified', 400);
    await updateDashboard({ BOT_TOKEN: 'token', DB: boardDb() }, 1);
    expect(find('sendMessage')).toBeUndefined();
  });

  // 3. Editing a one-off's time must keep its date. Next Friday 3pm moved to
  // 8am is next Friday 8am, not tomorrow.
  it('keeps a one-off on its own date when only the time changes', async () => {
    const runs = [];
    const scheduled = zonedEpoch(
      ...(() => {
        const p = localParts(Date.now() + 5 * 86400000, TZ);
        return [p.y, p.mo, p.d];
      })(), 15, 0, TZ
    );
    const once = {
      ...CHORE, schedule_kind: 'once', next_fire_at: scheduled,
      schedule_detail: JSON.stringify({ h: 15, mi: 0 }),
    };
    await handleUpdate(env(once, { runs }), ephemeralTap('e:settime:10:8'));
    const write = runs.find((r) => r.sql.includes('UPDATE reminders SET schedule_detail'));
    expect(write).toBeTruthy();
    const next = write.args[1];
    const p = localParts(scheduled, TZ);
    expect(localParts(next, TZ)).toMatchObject({ y: p.y, mo: p.mo, d: p.d, h: 8, mi: 0 });
    expect(next).toBe(zonedEpoch(p.y, p.mo, p.d, 8, 0, TZ));
  });

  it('falls back to the next daily slot when that time has already passed', async () => {
    const runs = [];
    // Yesterday's one-off, still on the books: 8am on it is long gone, so the
    // edit has to land on the next 8am instead of in the past.
    const y = localParts(Date.now() - 86400000, TZ);
    const once = {
      ...CHORE, schedule_kind: 'once', next_fire_at: zonedEpoch(y.y, y.mo, y.d, 15, 0, TZ),
      schedule_detail: JSON.stringify({ h: 15, mi: 0 }),
    };
    await handleUpdate(env(once, { runs }), ephemeralTap('e:settime:10:8'));
    const write = runs.find((r) => r.sql.includes('UPDATE reminders SET schedule_detail'));
    expect(write.args[1]).toBeGreaterThan(Date.now());
    expect(localParts(write.args[1], TZ)).toMatchObject({ h: 8, mi: 0 });
  });

  // 4. A firing snapshots scored at fire time; flipping points on the chore
  // has to move the live nag with it or the nag keeps the old answer.
  it('carries a points toggle into the live nag', async () => {
    const runs = [];
    const firing = { id: 5, reminder_id: 10, chat_id: 1, state: 'nagging', scored: 1 };
    await handleUpdate(env(CHORE, { runs, firings: [firing] }), ephemeralTap('e:score:10'));
    const reminderWrite = runs.find((r) => r.sql.includes('UPDATE reminders SET scored'));
    expect(reminderWrite.args).toEqual([0, 10]);
    const firingWrite = runs.find((r) => r.sql.includes('UPDATE firings SET scored'));
    expect(firingWrite, 'the live firing was updated too').toBeTruthy();
    expect(firingWrite.sql).toContain("state = 'nagging'");
    expect(firingWrite.args).toEqual([0, 10]);
  });

  it('turns points back on for the live nag as well', async () => {
    const runs = [];
    const firing = { id: 5, reminder_id: 10, chat_id: 1, state: 'nagging', scored: 0 };
    await handleUpdate(env({ ...CHORE, scored: 0 }, { runs, firings: [firing] }),
      ephemeralTap('e:score:10'));
    expect(runs.find((r) => r.sql.includes('UPDATE firings SET scored')).args).toEqual([1, 10]);
  });

  // 5. Registering a webhook with no secret token makes every later delivery
  // fail the header check — a bot that is live and completely deaf.
  const setup = (secrets) => worker.fetch(
    new Request('https://bot.example/setup', {
      method: 'POST', headers: { Authorization: 'Bearer admin' },
    }),
    { BOT_TOKEN: 'token', ADMIN_SECRET: 'admin', ...secrets },
    { waitUntil() {} }
  );

  it('refuses /setup when WEBHOOK_SECRET is missing', async () => {
    for (const secrets of [{}, { WEBHOOK_SECRET: '' }, { WEBHOOK_SECRET: '   ' }]) {
      calls.length = 0;
      const res = await setup(secrets);
      expect(res.status).toBe(500);
      expect(await res.text()).toMatch(/WEBHOOK_SECRET/);
      // Nothing was registered, so the working webhook (if any) survives.
      expect(find('setWebhook')).toBeUndefined();
    }
  });

  it('registers the webhook with its secret token when one is set', async () => {
    const res = await setup({ WEBHOOK_SECRET: 'hook' });
    expect(res.status).toBe(200);
    expect(find('setWebhook').body.secret_token).toBe('hook');
  });
});
