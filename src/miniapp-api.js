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
import { chatAllowed } from './handlers.js';
import { fmtLocal, fmtShort, weekStart } from './time.js';
import {
  getTz, senderName, creditTogether, nicknames, isScored, membersFrom, householdNamesFrom,
  chatMemberRole, cachedRole, rememberMemberStatement, CREDIT_SEP,
} from './household.js';
import {
  choreBoard, choreEmoji, describeSchedule, updateDashboard, loadBoard, boardStatements, boardFrom,
  deferBoards, flushBoards, later, takeRides,
} from './dashboard.js';
import { completeNow, editorPlan, flagPlan, skipPlan, JUST_FIRED, NAG_PACES } from './manage.js';
import { reminderInsert, deleteReminder, removalStatements, fireIfDue, setReminderPaused } from './chores.js';
import { parseRemind, ParseError, NoTimeError, DEFAULT_NAGS } from './parse.js';
import { choreStatsStatements, choreStatsFrom, streakStatement, streakFrom } from './stats.js';
import { parentChoicesIn, setParent } from './nesting.js';
import { chatReads } from './context.js';

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

// In the household means in the chat now, as Telegram says it
// (chatMemberRole, remembered a few minutes per isolate). The question goes
// out beside the request's reads, not in front of them, and nothing is
// written until it has been answered. When Telegram gives no answer, a
// `members` row — someone the bot has seen in the chat — is let in as before;
// anyone else is asked to try again rather than shut out (503, retry).
// Returns null to go on, or the refusal to send.
function admit(role, user, rows) {
  if (user.is_bot || role === 'none') {
    return json({ ok: false, message: 'Only the household can see its chores.' }, 403);
  }
  if (role === 'member') return null;
  if ((rows || []).some((m) => m.user_id === user.id)) return null;
  return json({ ok: false, retry: true, message: 'Telegram did not answer in time. Trying again…' }, 503);
}

// The reads a route answers from, sent as the gate's one batch. GET routes
// draw the board, so the gate is the board's own read and the whole answer is
// one round trip. A chore's POST reads the roster (who to credit, who to
// assign), the settings (timezone), the chore and its live nag. Stats read
// the week. Each returns { statements, read(results) }.
function boardGate(env, chatId) {
  return {
    statements: boardStatements(env, chatId, { members: true }),
    read: (results) => {
      const loaded = boardFrom(results);
      return { loaded, rows: loaded.members, settings: loaded.settings };
    },
  };
}

function choreGate(env, chatId, choreId) {
  const statements = [
    env.DB.prepare('SELECT user_id, username, first_name FROM members WHERE chat_id = ?').bind(chatId),
    env.DB.prepare('SELECT paused_until, dashboard_msg_id, tz FROM settings WHERE chat_id = ?').bind(chatId),
  ];
  if (choreId != null) {
    statements.push(
      env.DB.prepare('SELECT * FROM reminders WHERE id = ? AND chat_id = ?').bind(choreId, chatId),
      env.DB.prepare(
        "SELECT * FROM firings WHERE reminder_id = ? AND chat_id = ? AND state = 'nagging' ORDER BY id DESC LIMIT 1"
      ).bind(choreId, chatId),
    );
  }
  return {
    statements,
    read: ([members, settings, chore, live]) => ({
      rows: members.results || [],
      settings: (settings.results || [])[0] || null,
      chore: chore ? (chore.results || [])[0] || null : null,
      live: live ? (live.results || [])[0] || null : null,
    }),
  };
}

// The leaderboard needs the week's bounds, which need the timezone first —
// cached per isolate, so nearly always free.
function statsGate(env, chatId, tz, view) {
  const now = Date.now();
  const thisWeek = weekStart(now, tz);
  const since = view === 'last' ? thisWeek - 7 * 86400000 : thisWeek;
  return {
    statements: [
      env.DB.prepare('SELECT user_id, username, first_name FROM members WHERE chat_id = ?').bind(chatId),
      ...choreStatsStatements(env, chatId, since, view === 'last' ? thisWeek : now),
      ...(view === 'week' ? [streakStatement(env, chatId, tz)] : []),
    ],
    read: ([members, expired, history, past]) => ({
      rows: members.results || [],
      week: { since, stats: choreStatsFrom(expired, history), past: past ? past.results || [] : null },
    }),
  };
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

const choreNames = (board) => new Map(board.rows.map(({ r }) => [r.id, r.text]));

// One chore as a list row: what the board says about it, as text. `under` is
// the chore it sits under (nesting.js), named.
function summary({ r, state, lead, live, cadence }, names = new Map()) {
  return {
    under: r.parent_id != null ? names.get(r.parent_id) || null : null,
    id: r.id, text: r.text, emoji: choreEmoji(r.text), state, status: lead, live,
    cadence: cadence === 'once' ? null : cadence, assignee: r.assignee_name || null,
    scored: isScored(r), rotate: Boolean(JSON.parse(r.schedule_detail).rotate), paused: Boolean(r.paused),
  };
}

// The chores, the board's view of them and the roster, from one D1 batch:
// everything a reply draws. A reply used to build the board twice — once for
// the list, once for the chore — at three round trips apiece.
// `before`: writes that ride in the same batch, ahead of the reads (an edit,
// the roster refresh), answered in `before`.
// Writes queued to ride with the answer (withReply: a nested chore's cover)
// go last among them, and get their results back from it.
async function snapshot(env, chatId, tz, before = []) {
  const rides = takeRides(env);
  let loaded;
  try {
    loaded = await loadBoard(env, chatId, { members: true, before: [...before, ...rides.statements] });
  } catch (error) {
    rides.fail(error);
    throw error;
  }
  rides.settle(loaded.before.slice(before.length));
  loaded.before = loaded.before.slice(0, before.length);
  return snapshotFrom(env, chatId, tz, loaded);
}

async function snapshotFrom(env, chatId, tz, loaded) {
  return {
    loaded,
    before: loaded.before || [],
    board: await choreBoard(env, chatId, tz, loaded),
    members: membersFrom(loaded.members),
  };
}

function listing(snap, tz, user) {
  const { board, members } = snap;
  return {
    chores: board ? board.rows.map((row) => summary(row, choreNames(board))) : [],
    vacation: board && board.vacationUntil ? fmtLocal(board.vacationUntil, tz) : null,
    members, me: { id: user.id, name: senderName(user) },
  };
}

// The nested family a chore belongs to (nesting.js), top tier first and each
// chore under its own parent, drawn from the board's rows. `rel` says how each
// one relates to the chore on screen: 'above' (doing it resets this one),
// 'self', 'below' (reset when this one is done), or 'side' (same family, other
// branch). A chore on its own has no family: [].
function family(board, r) {
  const rows = new Map(board.rows.map((entry) => [entry.r.id, entry]));
  const kids = (id) => board.rows.filter((entry) => entry.r.parent_id === id).sort((a, b) => a.r.id - b.r.id);
  const above = new Set();
  let root = r;
  while (root.parent_id != null && rows.has(root.parent_id) && !above.has(root.parent_id) && root.parent_id !== r.id) {
    above.add(root.parent_id);
    root = rows.get(root.parent_id).r;
  }
  const below = new Set();
  const out = [];
  const seen = new Set();
  const walk = (entry, depth, underSelf) => {
    if (seen.has(entry.r.id)) return;
    seen.add(entry.r.id);
    if (underSelf) below.add(entry.r.id);
    out.push({ entry, depth });
    for (const kid of kids(entry.r.id)) walk(kid, depth + 1, underSelf || entry.r.id === r.id);
  };
  walk(rows.get(root.id), 0, false);
  if (out.length < 2) return [];
  return out.map(({ entry, depth }) => ({
    id: entry.r.id, text: entry.r.text, emoji: choreEmoji(entry.r.text), depth, status: entry.lead,
    rel: entry.r.id === r.id ? 'self' : above.has(entry.r.id) ? 'above' : below.has(entry.r.id) ? 'below' : 'side',
  }));
}

// One chore with everything its screen can change, each value as the editor
// keys it. A schedule, time or nag pace the editor does not offer — "every 8
// days", a 7:45 typed in the command, "nag:15m" — has no key, and the page
// shows it as the current value beside the ones it can choose.
function detail(snap, id, tz) {
  const { board, loaded } = snap;
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
    ...summary(row, choreNames(board)),
    // Nesting: the chore this one sits under, the ones it may sit under, and
    // the whole family it belongs to.
    parentId: r.parent_id ?? null,
    parents: parentChoicesIn(loaded.reminders, r),
    family: family(board, r),
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
// The roster refresh (see the gate) rides in this batch when the route gets
// this far; `pending` hands it over, and anything left is written after.
async function choreReply(env, chatId, id, tz, user, extra, pending = [], snap = null) {
  snap = snap || await snapshot(env, chatId, tz, pending.splice(0));
  return json({ ok: true, ...extra, chore: detail(snap, id, tz), ...listing(snap, tz, user) });
}

const GONE = { ok: false, message: 'That chore is already gone.' };
const EDIT_FIELDS = new Set(['time', 'schedule', 'nag', 'assign', 'rotate', 'score', 'parent']);

// Who a Done credits: the person tapping, everyone on the roster with them,
// or one housemate chosen by user_id, as the board's 👤 Done early by… does.
// The roster is the gate's read.
function creditFor(rows, user, body) {
  const me = senderName(user);
  if (body.how === 'together') return creditTogether(me, [...householdNamesFrom(rows).roster]);
  if (body.how === 'as') {
    const member = membersFrom(rows).find((m) => String(m.userId) === String(body.member));
    return member ? member.name : null;
  }
  return me;
}

const DONE_MESSAGES = {
  done: 'Purrs 😻 — done.', early: 'Done early 😻', raced: 'Already handled 👍',
  idle: 'This chore is not nagging now.',
};

const routes = [
  ['GET', /^chores$/, async ({ env, chatId, tz, user, gate }) => (
    json({ ok: true, ...listing(await snapshotFrom(env, chatId, tz, gate.loaded), tz, user) })
  ), { gate: 'board' }],

  ['GET', /^chore\/(\d+)$/, async ({ env, chatId, tz, match, gate }) => {
    const snap = await snapshotFrom(env, chatId, tz, gate.loaded);
    const chore = detail(snap, Number(match[1]), tz);
    if (!chore) return json(GONE);
    return json({ ok: true, chore, members: snap.members });
  }, { gate: 'board' }],

  ['POST', /^chore\/(\d+)\/done$/, async ({ env, chatId, tz, user, r, body, gate, pending }) => {
    const credit = creditFor(gate.rows, user, body);
    if (!credit) return json({ ok: false, message: 'That household member is no longer here.' });
    const outcome = await completeNow(env, r, credit, tz,
      { expect: body.expect === 'now' ? 'now' : undefined, live: gate.live });
    if (outcome === 'idle') return json({ ok: false, message: DONE_MESSAGES.idle });
    return choreReply(env, chatId, r.id, tz, user, { ok: outcome !== 'raced', message: DONE_MESSAGES[outcome] }, pending);
  }, { chore: true }],

  // The skip's compare-and-swap rides in the batch the reply reads.
  ['POST', /^chore\/(\d+)\/skip$/, async ({ env, chatId, tz, user, r, pending }) => {
    const plan = skipPlan(env, r, tz);
    if (plan === 'once') return json({ ok: false, message: 'One-off chores cannot be skipped.' });
    const snap = await snapshot(env, chatId, tz, [plan.statement, ...pending.splice(0)]);
    if (!snap.before[0].meta.changes) return json({ ok: false, message: JUST_FIRED });
    await updateDashboard(env, chatId);
    return choreReply(env, chatId, r.id, tz, user, { message: `⏭️ Skipped — next ${fmtLocal(plan.next, tz)}` }, [], snap);
  }, { chore: true }],

  ['POST', /^chore\/(\d+)\/(pause|resume)$/, async ({ env, chatId, tz, user, r, match, pending }) => {
    const pause = match[2] === 'pause';
    if (pause && r.paused) return json({ ok: false, message: 'It is already paused.' });
    if (!pause && !r.paused) return json({ ok: false, message: 'It isn\'t paused.' });
    const state = await setReminderPaused(env, r, pause, tz, senderName(user));
    const message = pause ? '⏸️ Paused'
      : state.next != null ? `▶️ Resumed — next ${fmtLocal(state.next, tz)}`
      : state.firing ? '▶️ Resumed — it is nagging again'
      : '▶️ Resumed, but it already fired and has nothing scheduled.';
    return choreReply(env, chatId, r.id, tz, user, { message }, pending);
  }, { chore: true }],

  // A deletion changes the household's board, so its log goes to the group,
  // with the Undo that brings the chore back for a day. The removal rides in
  // the batch the reply reads, as an edit does; the cards and the log follow.
  ['POST', /^chore\/(\d+)\/delete$/, async ({ env, chatId, tz, user, r, pending }) => {
    const removal = removalStatements(env, r);
    const snap = await snapshot(env, chatId, tz, [...removal.statements, ...pending.splice(0)]);
    await deleteReminder(env, r, null, senderName(user),
      { removed: removal.read(snap.before.slice(0, removal.statements.length)) });
    return choreReply(env, chatId, r.id, tz, user, { message: '🗑️ Deleted — Undo is in the chat for a day.' }, [], snap);
  }, { chore: true }],

  // An edit's write goes in the batch the reply reads, so the answer is one
  // round trip after the gate; what Telegram has to show of it (a moved or
  // re-labelled nag) follows the reply.
  ['POST', /^chore\/(\d+)\/edit$/, async ({ env, chatId, tz, user, r, body, gate, pending }) => {
    const field = String(body.field || '');
    if (!EDIT_FIELDS.has(field)) return json({ ok: false, message: 'Not something the editor changes.' });
    let plan;
    if (field === 'rotate' || field === 'score') {
      plan = flagPlan(env, r, field, Boolean(body.value), tz);
    } else if (field === 'parent') {
      const problem = await setParent(env, r, body.value == null ? null : String(body.value));
      if (problem) return json({ ok: false, message: problem });
      plan = { statements: [], check: () => null, after: async () => {} };
    } else {
      if ((field === 'time' || field === 'schedule') && r.next_fire_at == null) {
        return json({ ok: false, message: 'It is nagging now — change its time once it is done.' });
      }
      plan = await editorPlan(env, r, field, String(body.value ?? ''), tz, { members: membersFrom(gate.rows) });
    }
    if (plan.problem) return json({ ok: false, message: plan.problem });
    const snap = await snapshot(env, chatId, tz, [...plan.statements, ...pending.splice(0)]);
    const problem = plan.check(snap.before.slice(0, plan.statements.length));
    if (problem) return json({ ok: false, message: problem });
    await later(env, plan.after);
    await updateDashboard(env, chatId);
    return choreReply(env, chatId, r.id, tz, user, { message: 'Updated ✓' }, [], snap);
  }, { chore: true }],

  // Adding takes what /chore takes after the command — "trash 7pm daily" —
  // through the same parser. The chat's no-time wizard has no place in a form,
  // so a missing time is asked for instead. The page shows the confirmation
  // the chat would have posted, and the board lists the chore for everyone.
  // A chore due now fires after the reply.
  ['POST', /^chores$/, async ({ env, chatId, tz, user, body, now, gate, pending }) => {
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
      const member = membersFrom(gate.rows).find((m) => String(m.userId) === String(body.assignee));
      if (!member) return json({ ok: false, message: 'That household member is no longer here.' });
      p.assigneeName = member.name;
      p.assigneeUserId = member.userId;
    }
    p.scored = body.scored !== false;
    // The chore's INSERT rides in the batch the reply reads.
    const snap = await snapshot(env, chatId, tz, [reminderInsert(env, chatId, p, senderName(user)), ...pending.splice(0)]);
    const id = snap.before[0].meta.last_row_id;
    await updateDashboard(env, chatId);
    await later(env, () => fireIfDue(env, id, tz, { dueAt: p.firstFireAt }));
    return choreReply(env, chatId, id, tz, user, {
      message: `📝 Added — first reminder ${fmtLocal(p.firstFireAt, tz)}`,
    }, [], snap);
  }],

  // The leaderboard's two weekly tabs, counted as /stats counts them, read in
  // the gate's batch.
  ['GET', /^stats\/(week|last)$/, async ({ tz, match, gate }) => {
    const view = match[1];
    const { since, stats: s, past } = gate.week;
    const streak = view === 'week' && s.people.length ? streakFrom(past || [], tz, s.people[0][0]) : 0;
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
  }, { gate: 'stats' }],
];

// The pinned board is the group's, not the page's: the page draws its answer
// from the database, so the pin's redraw (a D1 read and a Telegram edit) goes
// after the response, through ctx.waitUntil, instead of in front of it. So does
// everything else Telegram has to show of a change (later, in dashboard.js) —
// a card edited, a receipt, a sticker, a log line — and the sweep records of
// whatever was sent.
export async function handleMiniAppApi(request, env, path, now = Date.now(), ctx = null) {
  const header = request.headers.get('Authorization') || '';
  const session = header.startsWith('tma ')
    ? await verifyInitData(env, header.slice(4), now) : null;
  if (!session) return json({ ok: false, message: 'Open this from the 🐾 Chores button on the pinned board.' }, 401);
  const chatId = chatFromStartParam(env, session.startParam);
  if (!chatId) return json({ ok: false, message: 'This link is not for a Nag-Bot household.' }, 403);
  const { user } = session;
  for (const [method, pattern, handler, { chore = false, gate: kind = 'chore' } = {}] of routes) {
    const match = path.match(pattern);
    if (!match || request.method !== method) continue;
    const scoped = deferBoards(env, { afterReply: true });
    const pending = [];
    try {
      const statsTz = kind === 'stats' ? await getTz(env, chatId) : null;
      const reads = kind === 'board' ? boardGate(env, chatId)
        : kind === 'stats' ? statsGate(env, chatId, statsTz, match[1])
        : choreGate(env, chatId, chore ? Number(match[1]) : null);
      // The membership question, the route's reads and the body all at once.
      // A change's stickers (a Done's celebration) are read with them when
      // this isolate's copy is stale (chatReads).
      const context = method === 'POST' ? chatReads(env, chatId) : null;
      const fromCache = !user.is_bot && cachedRole(env, chatId, user.id);
      let [role, results, body] = await Promise.all([
        user.is_bot ? 'none' : chatMemberRole(env, chatId, user.id),
        env.DB.batch(context ? [...reads.statements, ...context.statements] : reads.statements),
        method === 'POST' ? readBody(request) : {},
      ]);
      if (context) context.prime(results.slice(reads.statements.length));
      const gate = reads.read(results.slice(0, reads.statements.length));
      const known = (gate.rows || []).some((m) => m.user_id === user.id);
      // Remembered as in, but off the roster: a leave since then (seen on any
      // isolate) removed the row, so Telegram is asked again before the row
      // is written back.
      if (role === 'member' && fromCache && !known) role = await chatMemberRole(env, chatId, user.id, { fresh: true });
      const refused = admit(role, user, gate.rows);
      if (refused) return refused;
      // Let in: the name the household sees for this person is refreshed, since
      // credits are written in it — what a tap in the chat does first. A POST
      // sends it with its reply's batch; a GET writes it after, and only for a
      // housemate the roster has not met yet.
      if (method === 'POST' || !known) pending.push(rememberMemberStatement(scoped, chatId, user, now));
      const tz = statsTz || (gate.settings && gate.settings.tz) || 'Asia/Singapore';
      if (chore && !gate.chore) return json(GONE);
      return await handler({
        env: scoped, chatId, tz, match, body, user, r: gate.chore, now, gate, pending,
      });
    } catch (error) {
      if (error instanceof ParseError) return json({ ok: false, message: error.message });
      console.log(`Mini App ${method} ${path} failed: ${error.stack || error}`);
      return json({ ok: false, message: 'Something went wrong. Please try again.' }, 500);
    } finally {
      // A refresh no reply carried is written after, never before the check.
      if (pending.length) {
        const rest = pending.splice(0);
        await later(scoped, () => scoped.DB.batch(rest));
      }
      const boards = flushBoards(scoped);
      if (ctx) ctx.waitUntil(boards);
      else await boards;
    }
  }
  return json({ ok: false, message: 'Not found.' }, 404);
}
