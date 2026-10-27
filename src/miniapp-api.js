// The Mini App's API. The page is only a drawing of these answers: who is
// asking comes from Telegram's signature, which household from the launch
// link's startapp value, and every call checks that the person is in that
// chat. Inside it everyone may do everything, as on the pinned board's
// ⚙️ Manage — the household has no admins — so the app is the board's Manage
// over the chat instead of in place of its buttons. Every action goes through
// the same functions the chat buttons use, with the same refusals and the same
// messages to the group (a delete's log and its Undo, a done receipt).
// Refusals come back as { ok: false, message } with a 200, so the page has one
// way to show them; HTTP errors are kept for requests that should never have
// been made.

import { verifyInitData } from './miniapp-auth.js';
import { chatAllowed, IN_CHAT } from './handlers.js';
import { tg } from './tg.js';
import { fmtLocal, fmtShort, weekStart } from './time.js';
import {
  getTz, householdMembers, householdRoster, senderName, creditTogether, rememberMember, nicknames,
  isScored, CREDIT_SEP,
} from './household.js';
import { choreBoard, choreEmoji, describeSchedule, updateDashboard } from './dashboard.js';
import { applyEditorChoice, completeNow, setEditorFlag, skipNext, JUST_FIRED, NAG_PACES } from './manage.js';
import { createReminder, deleteReminder, fireIfDue, setReminderPaused } from './chores.js';
import { parseRemind, ParseError, NoTimeError, DEFAULT_NAGS } from './parse.js';
import { choreStats, winnerStreak } from './stats.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// "g-1004418632524": the group the board's button was pressed in.
function chatFromStartParam(env, startParam) {
  const match = String(startParam).match(/^g(-?\d+)$/);
  if (!match) return null;
  return chatAllowed(env, match[1]) ? Number(match[1]) : null;
}

// In the household means in the chat now. `members` is pruned when somebody
// leaves, so a row there is enough; a housemate the bot has not seen yet —
// joined, never typed — is asked about once, and remembered as an update
// would remember them.
async function inHousehold(env, chatId, user) {
  if (user.is_bot) return false;
  const seen = await env.DB.prepare('SELECT 1 AS x FROM members WHERE chat_id = ? AND user_id = ?')
    .bind(chatId, user.id).first();
  if (seen) return true;
  const member = await tg(env, 'getChatMember', { chat_id: chatId, user_id: user.id });
  if (!member.ok || !IN_CHAT.has(member.result.status)) return false;
  await rememberMember(env, chatId, user);
  return true;
}

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

const pad = (n) => String(n).padStart(2, '0');
const sameDays = (days, want) => Array.isArray(days)
  && [...days].sort().join(',') === [...want].sort().join(',');

// One chore as a list row: what the board says about it, as text.
function summary({ r, state, lead, live, cadence }) {
  return {
    id: r.id, text: r.text, emoji: choreEmoji(r.text), state, status: lead, live,
    cadence: cadence === 'once' ? null : cadence, assignee: r.assignee_name || null,
    scored: isScored(r), rotate: Boolean(JSON.parse(r.schedule_detail).rotate), paused: Boolean(r.paused),
  };
}

async function listing(env, chatId, tz, user) {
  const [board, members] = await Promise.all([choreBoard(env, chatId, tz), householdMembers(env, chatId)]);
  return {
    chores: board ? board.rows.map(summary) : [],
    vacation: board && board.vacationUntil ? fmtLocal(board.vacationUntil, tz) : null,
    members, me: { id: user.id, name: senderName(user) },
  };
}

// One chore with everything its screen can change, each value as the editor
// keys it. A schedule, time or nag pace the editor does not offer — "every 8
// days", a 7:45 typed in the command, "nag:15m" — has no key, and the page
// shows it as the current value beside the ones it can choose.
async function detail(env, chatId, id, tz) {
  const board = await choreBoard(env, chatId, tz);
  const row = board && board.rows.find((entry) => entry.r.id === id);
  if (!row) return null;
  const { r } = row;
  const d = JSON.parse(r.schedule_detail);
  const nags = JSON.parse(r.nag_intervals);
  const paceKey = JSON.stringify(nags) === JSON.stringify(DEFAULT_NAGS) ? 'default'
    : nags.length === 1 && NAG_PACES.includes(String(nags[0])) ? String(nags[0]) : null;
  const scheduleKey = r.schedule_kind === 'daily' ? 'daily'
    : r.schedule_kind === 'weekly' && sameDays(d.days, [1, 2, 3, 4, 5]) ? 'weekdays'
    : r.schedule_kind === 'weekly' && sameDays(d.days, [0, 6]) ? 'weekends' : null;
  return {
    ...summary(row),
    schedule: describeSchedule(r),
    next: r.next_fire_at != null ? fmtLocal(r.next_fire_at, tz) : null,
    // Time and schedule are the next slot's, so a chore nagging with nothing
    // scheduled has neither to change, as in the editor.
    timed: r.next_fire_at != null,
    time: d.h != null ? `${pad(d.h)}:${pad(d.mi || 0)}` : null,
    scheduleKey, paceKey, pace: `${nags.join('/')} min`,
    assigneeId: r.assignee_user_id ?? null,
    done: row.live ? 'now' : !r.paused && r.next_fire_at != null ? 'early' : null,
    canSkip: r.schedule_kind !== 'once' && r.next_fire_at != null,
    vacation: board.vacationUntil ? fmtLocal(board.vacationUntil, tz) : null,
  };
}

// Every action answers with the chore as it now stands — null once it has
// gone, as a deleted chore or a finished one-off has — and the whole list, so
// the page never has to guess what its own tap did.
async function choreReply(env, chatId, id, tz, user, extra) {
  const [chore, list] = await Promise.all([detail(env, chatId, id, tz), listing(env, chatId, tz, user)]);
  return json({ ok: true, ...extra, chore, ...list });
}

async function findChore(env, chatId, id) {
  return env.DB.prepare('SELECT * FROM reminders WHERE id = ? AND chat_id = ?').bind(id, chatId).first();
}

const GONE = { ok: false, message: 'That chore is already gone.' };
const EDIT_FIELDS = new Set(['time', 'schedule', 'nag', 'assign', 'rotate', 'score']);

// Who a Done credits: the person tapping, everyone on the roster with them,
// or one housemate chosen by user_id, as the board's 👤 Done early by… does.
async function creditFor(env, chatId, user, body) {
  const me = senderName(user);
  if (body.how === 'together') return creditTogether(me, [...await householdRoster(env, chatId)]);
  if (body.how === 'as') {
    const member = (await householdMembers(env, chatId)).find((m) => String(m.userId) === String(body.member));
    return member ? member.name : null;
  }
  return me;
}

const DONE_MESSAGES = {
  done: 'Purrs 😻 — done.', early: 'Done early 😻', raced: 'Already handled 👍',
  idle: 'This chore is not nagging now.',
};

const routes = [
  ['GET', /^chores$/, async ({ env, chatId, tz, user }) => json({ ok: true, ...await listing(env, chatId, tz, user) })],

  ['GET', /^chore\/(\d+)$/, async ({ env, chatId, tz, match }) => {
    const chore = await detail(env, chatId, Number(match[1]), tz);
    if (!chore) return json(GONE);
    return json({ ok: true, chore, members: await householdMembers(env, chatId) });
  }],

  ['POST', /^chore\/(\d+)\/done$/, async ({ env, chatId, tz, user, r, body }) => {
    const credit = await creditFor(env, chatId, user, body);
    if (!credit) return json({ ok: false, message: 'That household member is no longer here.' });
    const outcome = await completeNow(env, r, credit, tz);
    if (outcome === 'idle') return json({ ok: false, message: DONE_MESSAGES.idle });
    return choreReply(env, chatId, r.id, tz, user, { ok: outcome !== 'raced', message: DONE_MESSAGES[outcome] });
  }, { chore: true }],

  ['POST', /^chore\/(\d+)\/skip$/, async ({ env, chatId, tz, user, r }) => {
    const next = await skipNext(env, r, tz);
    if (next === 'once') return json({ ok: false, message: 'One-off chores cannot be skipped.' });
    if (next == null) return json({ ok: false, message: JUST_FIRED });
    return choreReply(env, chatId, r.id, tz, user, { message: `⏭️ Skipped — next ${fmtLocal(next, tz)}` });
  }, { chore: true }],

  ['POST', /^chore\/(\d+)\/(pause|resume)$/, async ({ env, chatId, tz, user, r, match }) => {
    const pause = match[2] === 'pause';
    if (pause && r.paused) return json({ ok: false, message: 'It is already paused.' });
    if (!pause && !r.paused) return json({ ok: false, message: 'It isn\'t paused.' });
    const state = await setReminderPaused(env, r, pause, tz, senderName(user));
    const message = pause ? '⏸️ Paused'
      : state.next != null ? `▶️ Resumed — next ${fmtLocal(state.next, tz)}`
      : state.firing ? '▶️ Resumed — it is nagging again'
      : '▶️ Resumed, but it already fired and has nothing scheduled.';
    return choreReply(env, chatId, r.id, tz, user, { message });
  }, { chore: true }],

  // A deletion changes the household's board, so its log goes to the group,
  // with the Undo that brings the chore back for a day.
  ['POST', /^chore\/(\d+)\/delete$/, async ({ env, chatId, tz, user, r }) => {
    await deleteReminder(env, r, null, senderName(user));
    return choreReply(env, chatId, r.id, tz, user, { message: '🗑️ Deleted — Undo is in the chat for a day.' });
  }, { chore: true }],

  ['POST', /^chore\/(\d+)\/edit$/, async ({ env, chatId, tz, user, r, body }) => {
    const field = String(body.field || '');
    if (!EDIT_FIELDS.has(field)) return json({ ok: false, message: 'Not something the editor changes.' });
    if (field === 'rotate' || field === 'score') {
      await setEditorFlag(env, r, field, Boolean(body.value), tz);
    } else {
      if ((field === 'time' || field === 'schedule') && r.next_fire_at == null) {
        return json({ ok: false, message: 'It is nagging now — change its time once it is done.' });
      }
      const problem = await applyEditorChoice(env, r, field, String(body.value ?? ''), tz);
      if (problem) return json({ ok: false, message: problem });
    }
    await updateDashboard(env, chatId);
    return choreReply(env, chatId, r.id, tz, user, { message: 'Updated ✓' });
  }, { chore: true }],

  // Adding takes what /chore takes after the command — "trash 7pm daily" —
  // through the same parser. The chat's no-time wizard has no place in a form,
  // so a missing time is asked for instead. The page shows the confirmation
  // the chat would have posted, and the board lists the chore for everyone.
  ['POST', /^chores$/, async ({ env, chatId, tz, user, body, now }) => {
    const args = String(body.text || '').trim();
    if (!args) return json({ ok: false, message: 'Say what to nag about and when — e.g. trash 7pm daily.' });
    let p;
    try {
      p = parseRemind(args, args, [], now, tz, nicknames(env));
    } catch (error) {
      if (error instanceof NoTimeError) {
        return json({ ok: false, message: 'When? Add a time — e.g. 7pm daily, every mon 8am, tomorrow 9am.' });
      }
      throw error;
    }
    if (body.assignee) {
      const member = (await householdMembers(env, chatId)).find((m) => String(m.userId) === String(body.assignee));
      if (!member) return json({ ok: false, message: 'That household member is no longer here.' });
      p.assigneeName = member.name;
      p.assigneeUserId = member.userId;
    }
    p.scored = body.scored !== false;
    const { id } = await createReminder(env, chatId, p, senderName(user), tz);
    await fireIfDue(env, id, tz);
    return choreReply(env, chatId, id, tz, user, {
      message: `📝 Added — first reminder ${fmtLocal(p.firstFireAt, tz)}`,
    });
  }],

  // The leaderboard's two weekly tabs, counted as /stats counts them.
  ['GET', /^stats\/(week|last)$/, async ({ env, chatId, tz, match }) => {
    const view = match[1];
    const now = Date.now();
    const thisWeek = weekStart(now, tz);
    const since = view === 'last' ? thisWeek - 7 * 86400000 : thisWeek;
    const s = await choreStats(env, chatId, since, view === 'last' ? thisWeek : now);
    const streak = view === 'week' && s.people.length
      ? await winnerStreak(env, chatId, tz, s.people[0][0]) : 0;
    const recent = [...s.together, ...[...s.solo.values()].flat()]
      .sort((a, b) => b.done_at - a.done_at).slice(0, 15)
      .map((h) => ({
        text: h.text, emoji: choreEmoji(h.text), who: String(h.done_by || '?').split(CREDIT_SEP).join(' & '),
        when: fmtShort(h.done_at, tz),
      }));
    return json({
      ok: true, view, week: fmtShort(since, tz).replace(/,.*$/, ''), streak,
      people: s.people.map(([name, items]) => ({
        name, count: items.length, solo: (s.solo.get(name) || []).length,
      })),
      together: s.together.length, expired: s.expired, total: s.total, recent,
    });
  }],
];

export async function handleMiniAppApi(request, env, path, now = Date.now()) {
  const header = request.headers.get('Authorization') || '';
  const session = header.startsWith('tma ')
    ? await verifyInitData(env, header.slice(4), now) : null;
  if (!session) return json({ ok: false, message: 'Open this from the 🐾 Chores button on the pinned board.' }, 401);
  const chatId = chatFromStartParam(env, session.startParam);
  if (!chatId) return json({ ok: false, message: 'This link is not for a Nag-Bot household.' }, 403);
  const { user } = session;
  for (const [method, pattern, handler, { chore = false } = {}] of routes) {
    const match = path.match(pattern);
    if (!match || request.method !== method) continue;
    if (!await inHousehold(env, chatId, user)) {
      return json({ ok: false, message: 'Only the household can see its chores.' }, 403);
    }
    try {
      // What a tap in the chat does first: keep the name the household sees
      // for this person current, since credits are written in it.
      if (method === 'POST') await rememberMember(env, chatId, user);
      const body = method === 'POST' ? await readBody(request) : {};
      const tz = await getTz(env, chatId);
      let r = null;
      if (chore) {
        r = await findChore(env, chatId, Number(match[1]));
        if (!r) return json(GONE);
      }
      return await handler({ env, chatId, tz, match, body, user, r, now });
    } catch (error) {
      if (error instanceof ParseError) return json({ ok: false, message: error.message });
      console.log(`Mini App ${method} ${path} failed: ${error.stack || error}`);
      return json({ ok: false, message: 'Something went wrong. Please try again.' }, 500);
    }
  }
  return json({ ok: false, message: 'Not found.' }, 404);
}
