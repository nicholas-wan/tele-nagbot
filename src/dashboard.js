// The pinned dashboard: the chore-list card shared by /list and the pin, and
// the schedule/emoji text helpers everything renders chores with.

import { sendMessage, editMessage, deleteMessage, esc, pinMessage, unpinMessage, messageIsGone,
         SWEEP_QUEUE, flushSweepRecords } from './tg.js';
import { fmtLocal, fmtShort, fmtClock, fmtTime, localParts, DAY_NAMES } from './time.js';
import { isScored } from './household.js';
// A function declaration, so the import cycle with nag.js (which refreshes the
// board) resolves at call time rather than at load.
import { isHouseholdDeferred, isOverdue } from './nag.js';
import { miniAppLink } from './miniapp-link.js';

// Once MINI_APP_URL is set, the board's one button opens the Mini App over the
// chat; until then it is ⚙️ Manage, which swaps the board's own buttons.
export function dashboardButtons(env, chatId) {
  const app = miniAppLink(env, chatId);
  return { inline_keyboard: [[app
    ? { text: '🐾 Chores', url: app }
    : { text: '⚙️ Manage chores', callback_data: 'm:list' }]] };
}

// Best-guess emoji for a chore, by keyword. Falls back to a paw.
const CHORE_EMOJI = [
  [/nails?|trim|groom/i, '✂️'],
  [/vaccin|nexgard|flea|tick|deworm|jab|injection/i, '💉'],
  [/fountain|aquarium|tank/i, '💧'],
  [/wifi|internet|router|broadband|modem|myrepublic/i, '🌐'],
  [/dish|plate|dishwasher|bowl|cutlery/i, '🍽️'],
  [/poop|litter|litterbox|scoop/i, '💩'],
  [/trash|garbage|rubbish|bin\b/i, '🗑️'],
  [/laundry|clothes|fold|iron/i, '🧺'],
  [/plant|water the|garden|flower/i, '🪴'],
  [/vacuum|sweep|mop|clean|dust|scrub|wipe/i, '🧹'],
  [/rent|pay|bill|tax|insurance/i, '💸'],
  [/cook|dinner|lunch|breakfast|meal|oven|bake/i, '🍳'],
  [/groceries|grocery|shop|buy|market/i, '🛒'],
  [/feed|food|treat/i, '🍚'],
  [/cat|latte|mocha|vet/i, '🐱'],
  [/car|gas|fuel|tire|oil/i, '🚗'],
  [/bed|sheet|pillow|blanket/i, '🛏️'],
  [/gym|run|walk|exercise/i, '🏃'],
  [/call|phone|email|message/i, '📞'],
  [/doctor|dentist|meds|medicine|pill/i, '💊'],
];

export function choreEmoji(text) {
  // A chore typed with its own leading emoji is self-labeled — no second icon.
  if (/^\p{Extended_Pictographic}/u.test(text)) return '';
  for (const [re, emoji] of CHORE_EMOJI) if (re.test(text)) return emoji;
  return '📌';
}

// 1st, 2nd, 3rd, 4th … 11th, 12th, 13th … 21st: "on the 1 at 9am" read wrong.
export function ordinal(n) {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 10] || 'th';
  return `${n}${suffix}`;
}

// An interval in words: "weekly", "every 2 weeks", "every 3 days", "monthly",
// "every 3 months", "yearly" — never "every 1 week".
export function intervalWords(d) {
  if (d.months) {
    if (d.months === 1) return 'monthly';
    if (d.months === 12) return 'yearly';
    return `every ${d.months} months`;
  }
  const w = d.days % 7 === 0 ? d.days / 7 : 0;
  if (w === 1) return 'weekly';
  return w ? `every ${w} weeks` : `every ${d.days} days`;
}

export function describeSchedule(r) {
  const d = JSON.parse(r.schedule_detail);
  if (r.schedule_kind === 'daily') return `daily ${fmtTime(d.h, d.mi)}`;
  if (r.schedule_kind === 'weekly') {
    return `every ${d.days.map((i) => DAY_NAMES[i]).join(',')} ${fmtTime(d.h, d.mi)}`;
  }
  if (r.schedule_kind === 'monthly') return `on the ${ordinal(d.dom)} at ${fmtTime(d.h, d.mi)}`;
  if (r.schedule_kind === 'interval') return `${intervalWords(d)} at ${fmtTime(d.h, d.mi)}`;
  return 'once';
}

// Schedule cadence without the time-of-day (list cards lead with the time).
export function cadence(r) {
  const d = JSON.parse(r.schedule_detail);
  if (r.schedule_kind === 'daily') return 'daily';
  if (r.schedule_kind === 'weekly') return `every ${d.days.map((i) => DAY_NAMES[i]).join(',')}`;
  if (r.schedule_kind === 'monthly') return `on the ${ordinal(d.dom)}`;
  if (r.schedule_kind === 'interval') return intervalWords(d);
  return 'once';
}

// Hybrid countdown + absolute: "today 9:00 PM" / "tomorrow 9:00 AM" /
// "in 3 days · Fri 5:00 PM" / "in 13 days · Aug 24, 7:00 PM".
export function fmtWhen(ms, tz) {
  const time = fmtClock(ms, tz);
  const t = localParts(ms, tz);
  const n = localParts(Date.now(), tz);
  const days = Math.round((Date.UTC(t.y, t.mo - 1, t.d) - Date.UTC(n.y, n.mo - 1, n.d)) / 86400000);
  if (days <= 0) return `today ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  const when = days < 7 ? `${DAY_NAMES[t.wd]} ${time}` : fmtShort(ms, tz);
  return `in ${days} days · ${when}`;
}

// fmtWhen looking back: "today 9:00 AM" / "yesterday 11:00 PM" /
// "Sun 11:00 PM" / "Oct 3, 7:00 PM".
export function fmtSince(ms, tz) {
  const time = fmtClock(ms, tz);
  const t = localParts(ms, tz);
  const n = localParts(Date.now(), tz);
  const days = Math.round((Date.UTC(n.y, n.mo - 1, n.d) - Date.UTC(t.y, t.mo - 1, t.d)) / 86400000);
  if (days <= 0) return `today ${time}`;
  if (days === 1) return `yesterday ${time}`;
  return days < 7 ? `${DAY_NAMES[t.wd]} ${time}` : fmtShort(ms, tz);
}

// Every management button carries the chore's own identity — name plus when —
// because the pinned board's text never changes while you navigate. Internal
// numbers stay out of labels; the name is the handle everywhere else too.
export function buttonText(r, tz = 'Asia/Singapore') {
  const when = r.paused ? 'paused'
    : r.next_fire_at ? fmtWhen(r.next_fire_at, tz)
    : 'pending';
  return clip(`${[choreEmoji(r.text), r.text].filter(Boolean).join(' ')} · ${when}`);
}

export function clip(text, max = 42) {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
}

// Every chore in board order, each with the status line the board leads it
// with — shared by the pinned board, /list and the Mini App, so the three
// never disagree about what a chore is doing. `state` is that line as a key:
// paused | parked | overdue | nagging | upcoming. `live` is whether a nag is
// out, which is what Done (rather than Done early) acts on. Null when there
// are no chores at all.
// Everything the board is drawn from, in one D1 batch — one round trip where
// it used to be three (four with the pin's own settings read). `members` adds
// the roster, for the Mini App, which shows both.
// `before`: writes to send in the same batch, ahead of the reads, so the board
// they return already shows them (the Mini App's edit, its roster refresh);
// their answers come back as `before`.
export async function loadBoard(env, chatId, { members = false, before = [] } = {}) {
  const results = await env.DB.batch([...before, ...boardStatements(env, chatId, { members })]);
  return { ...boardFrom(results.slice(before.length)), before: results.slice(0, before.length) };
}

// loadBoard's reads as statements, and their answers, for a caller that sends
// them in a batch of its own (the Mini App's gate).
export function boardStatements(env, chatId, { members = false } = {}) {
  const statements = [
    env.DB.prepare('SELECT * FROM reminders WHERE chat_id = ? ORDER BY id').bind(chatId),
    env.DB.prepare('SELECT paused_until, dashboard_msg_id, tz FROM settings WHERE chat_id = ?').bind(chatId),
    env.DB.prepare(
      "SELECT reminder_id, fired_at, next_nag_at, snoozed_until FROM firings WHERE chat_id = ? AND state = 'nagging'"
    ).bind(chatId),
  ];
  if (members) {
    statements.push(env.DB.prepare('SELECT user_id, username, first_name FROM members WHERE chat_id = ?').bind(chatId));
  }
  return statements;
}

export function boardFrom([reminders, settings, live, roster]) {
  return {
    reminders: reminders.results || [],
    settings: (settings.results || [])[0] || null,
    live: live.results || [],
    members: roster ? roster.results || [] : null,
  };
}

export async function choreBoard(env, chatId, tz, loaded = null) {
  const data = loaded || await loadBoard(env, chatId);
  // A copy: the sort below must not reorder rows a caller still holds.
  const results = [...data.reminders];
  if (!results.length) return null;
  const st = data.settings;
  const { live } = data;
  const nagging = new Set(live.map((f) => f.reminder_id));
  const overdue = new Set(live.filter((f) => isOverdue(f)).map((f) => f.reminder_id));
  // When each live chore first nagged, so the board says how long it has been
  // hanging rather than just that it is.
  const since = new Map();
  for (const f of live) {
    if (!since.has(f.reminder_id) || f.fired_at < since.get(f.reminder_id)) since.set(f.reminder_id, f.fired_at);
  }
  const sinceText = (r) => (since.has(r.id) ? ` since ${fmtSince(since.get(r.id), tz).replace(/^today /, '')}` : '');
  // Parked by the household — snoozed, or postponed up to two weeks — and
  // keyed to when it comes back. "🔔 nagging now" for a fortnight said the
  // opposite of what was chosen.
  const parked = new Map(live.filter((f) => isHouseholdDeferred(f))
    .map((f) => [f.reminder_id, f.next_nag_at ?? f.fired_at]));
  // Nagging first, then upcoming soonest-first (a parked chore by its return),
  // paused last.
  const rank = (r) => r.paused ? 2 : parked.has(r.id) ? 1
    : (nagging.has(r.id) || !r.next_fire_at) ? 0 : 1;
  const when = (r) => parked.get(r.id) ?? r.next_fire_at ?? 0;
  results.sort((a, b) => rank(a) - rank(b)
    || when(a) - when(b)
    || a.display_num - b.display_num);
  const rows = results.map((r) => {
    const [state, lead] = r.paused ? ['paused', '⏸️ paused']
      : parked.has(r.id) ? ['parked', `😴 ${fmtWhen(parked.get(r.id), tz)}`]
      : overdue.has(r.id) ? ['overdue', `⏰ overdue · nagging${sinceText(r)}`]
      : nagging.has(r.id) ? ['nagging', `🔔 nagging${sinceText(r)}`]
      : !r.next_fire_at ? ['nagging', '🔔 nagging now']
      : ['upcoming', fmtWhen(r.next_fire_at, tz)];
    return { r, state, lead, live: nagging.has(r.id), cadence: cadence(r) };
  });
  const vacationUntil = st && st.paused_until && st.paused_until > Date.now() ? st.paused_until : null;
  return { rows, vacationUntil };
}

// Renders the chore-card list shared by /list and the pinned dashboard.
// Null when there are no chores at all.
export async function choreListHtml(env, chatId, tz, loaded = null) {
  const board = await choreBoard(env, chatId, tz, loaded);
  if (!board) return null;
  const lines = ['🐾 <b>Chores</b>'];
  if (board.vacationUntil) {
    lines.push(`✈️ All paused until ${fmtLocal(board.vacationUntil, tz)} — /resume all to wake the cats.`);
  }
  // Two short lines per chore — when, then what — so nothing wraps on a phone
  // (squashbot's board layout). "once" says nothing a missing cadence doesn't.
  for (const { r, lead, cadence: each } of board.rows) {
    const rot = r.schedule_detail.includes('"rotate"') ? ' 🔄' : '';
    const who = r.assignee_name ? ` · ${esc(r.assignee_name)}` : '';
    lines.push('');
    lines.push(lead);
    // Chores are the default here; a reminder is the thing worth flagging,
    // since it looks identical but never reaches the leaderboard.
    const kind = isScored(r) ? '' : ' · <i>reminder</i>';
    lines.push(`${[choreEmoji(r.text), `<b>${esc(r.text)}</b>`].filter(Boolean).join(' ')}${rot}${who}` +
      (each === 'once' ? '' : ` · <i>${each}</i>`) + kind);
  }
  return lines.join('\n');
}

// Board redraws asked for while one update or Mini App request is being
// handled are collected and drawn once, when the work that changed things is
// done. A tap used to redraw the pin in the middle of its own work — before
// the card it was changing, and often twice — and each redraw is a D1 read
// plus a Telegram edit. deferBoards gives that piece of work its own env;
// flushBoards draws whatever it asked for. The webhook, the Mini App and each
// cron tick use one; anything without one (/admin, the tests that call
// handlers directly) draws at once.
const BOARDS = Symbol('boards');
const AFTER = Symbol('after');
const RIDE = Symbol('ride');

// `afterReply`: the Mini App's scope. Work handed to later() — the Telegram
// edits, receipts and stickers that only show what the database already says
// — waits until the page has its answer, then runs before the boards. Without
// it (the webhook, where the toast has already gone, and the cron) later()
// runs the work at once, in order.
export function deferBoards(env, { afterReply = false } = {}) {
  const scoped = Object.create(env);
  scoped[BOARDS] = new Set();
  scoped[SWEEP_QUEUE] = [];
  if (afterReply) {
    scoped[AFTER] = [];
    scoped[RIDE] = [];
  }
  return scoped;
}

// Writes that can wait for the batch the Mini App's answer reads (a nested
// chore's cover): queued there, so the answer already shows them, and their
// results come back once that batch has run. Without that scope they are a
// batch of their own, sent at once. Nothing in the request may wait on the
// promise before its answer is built — only work handed to later().
export function withReply(env, statements) {
  if (!env[RIDE]) return env.DB.batch(statements);
  return new Promise((resolve, reject) => env[RIDE].push({ statements, resolve, reject }));
}

// The queued writes, for the batch that carries them: `statements` to send,
// `settle(results)` with their answers, `fail(error)` if the batch failed.
export function takeRides(env) {
  const rides = env[RIDE] ? env[RIDE].splice(0) : [];
  return {
    statements: rides.flatMap((ride) => ride.statements),
    settle(results) {
      let at = 0;
      for (const ride of rides) {
        ride.resolve(results.slice(at, at + ride.statements.length));
        at += ride.statements.length;
      }
    },
    fail(error) { for (const ride of rides) ride.reject(error); },
  };
}

export async function later(env, task) {
  if (env[AFTER]) {
    env[AFTER].push(task);
    return;
  }
  await task();
}

// For a caller that has just drawn the board message itself, chore list and
// all — the editor, when it lives on the pin. A pending redraw would run
// after it and put the board's own button back over the editor's.
export function boardDrawn(env, chatId) {
  if (env[BOARDS]) env[BOARDS].delete(chatId);
}

// Everything the scope put off, in order: the after-reply work, each board
// once, then the sweep records of every message sent along the way.
export async function flushBoards(env) {
  // Writes no answer carried (a route that refused, or failed) go first.
  const rides = takeRides(env);
  if (rides.statements.length) {
    try {
      rides.settle(await env.DB.batch(rides.statements));
    } catch (e) {
      rides.fail(e);
    }
  }
  const after = env[AFTER];
  while (after && after.length) {
    try {
      await after.shift()();
    } catch (e) {
      console.log(`after-reply work failed: ${e.stack || e}`);
    }
  }
  const chats = env[BOARDS];
  if (chats) {
    while (chats.size) {
      const [chatId] = chats;
      chats.delete(chatId);
      await drawDashboard(env, chatId);
    }
  }
  await flushSweepRecords(env);
}

// One pinned message per chat, silently edited in place: the full chore list
// (nagging marked 🔔, paused included). Created on first need, unpinned and
// removed only when the chore list is empty.
export async function updateDashboard(env, chatId) {
  if (env[BOARDS]) {
    env[BOARDS].add(chatId);
    return;
  }
  await drawDashboard(env, chatId);
}

async function drawDashboard(env, chatId) {
  try {
    const loaded = await loadBoard(env, chatId);
    const row = loaded.settings;
    const msgId = row && row.dashboard_msg_id;
    const tz = (row && row.tz) || 'Asia/Singapore';
    let html = await choreListHtml(env, chatId, tz, loaded);

    if (!html) {
      if (msgId) {
        await unpinMessage(env, chatId, msgId);
        await deleteMessage(env, chatId, msgId);
        await env.DB.prepare('UPDATE settings SET dashboard_msg_id = NULL WHERE chat_id = ?').bind(chatId).run();
      }
      return;
    }
    // A pin is a single message; past the 4096 cap, trim on a line boundary.
    if (html.length > 4000) {
      html = html.slice(0, html.lastIndexOf('\n', 3980)) + '\n… more — /list';
    }

    if (msgId) {
      const res = await editMessage(env, chatId, msgId, html, dashboardButtons(env, chatId));
      if (res.ok || String(res.description || '').includes('not modified')) return;
      // Only a board that is genuinely gone earns a replacement. Anything else
      // — a network blip, a 429 that outlived tg()'s one retry, any other
      // Telegram error — is transient, and recreating on it pins a second
      // board beside the first every time it happens.
      if (!messageIsGone(res.description)) {
        console.log(`dashboard edit failed for chat ${chatId}: ${res.description || 'unknown'} ` +
          '— keeping the existing board');
        return;
      }
      // Message was deleted by hand — fall through and recreate it.
    }
    // keep: the pinned dashboard is the one message the daily sweep spares.
    const sent = await sendMessage(env, chatId, html, dashboardButtons(env, chatId), { silent: true, keep: true });
    if (sent.ok) {
      // A board that exists but isn't pinned is worse than a missing one: it
      // scrolls away and nobody notices it stopped being the board. Say so
      // loudly rather than failing silently.
      const pinned = await pinMessage(env, chatId, sent.result.message_id);
      if (!pinned.ok) {
        console.log(`dashboard pin FAILED for chat ${chatId}: ${pinned.description || 'unknown'} ` +
          '— bot needs the Pin Messages admin right');
      }
      await env.DB.prepare(
        'INSERT INTO settings (chat_id, dashboard_msg_id) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET dashboard_msg_id = excluded.dashboard_msg_id'
      ).bind(chatId, sent.result.message_id).run();
    } else {
      console.log(`dashboard send failed for chat ${chatId}: ${sent.description || 'unknown'}`);
    }
  } catch (e) {
    console.log(`updateDashboard failed: ${e}`);
  }
}
