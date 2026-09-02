// The leaderboard: one /stats message with This week / Last week / 6 months
// tabs that edit in place (the st: callbacks), plus the shared stats queries
// the cron recap uses.

import { sendPrivate, editRef, answerCallback, esc } from './tg.js';
import { weekStart, fmtShort } from './time.js';
import { getTz, CREDIT_SEP } from './household.js';
import { choreEmoji } from './dashboard.js';

const STATS_MAX_PER_PERSON = 15;
const MEDALS = ['🥇', '🥈', '🥉'];

// Fetches done-history and expired count for a window; shared by the tabs
// and the Sunday recap. `until` bounds a closed week (defaults to now).
export async function choreStats(env, chatId, since, until = Date.now()) {
  const expired = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM firings WHERE chat_id = ? AND state = 'expired' AND scored = 1 AND fired_at > ? AND fired_at <= ?"
  ).bind(chatId, since, until).first();
  const history = await env.DB.prepare(
    `SELECT f.done_by, f.done_at, COALESCE(f.reminder_text, r.text, '?') AS text
     FROM firings f LEFT JOIN reminders r ON r.id = f.reminder_id
     WHERE f.chat_id = ? AND f.state = 'done' AND f.scored = 1 AND f.done_at > ? AND f.done_at <= ?
     ORDER BY f.done_at DESC`
  ).bind(chatId, since, until).all();
  const byPerson = new Map();
  const together = [];
  const solo = new Map();
  for (const h of history.results) {
    // "nick & jane" (done together) credits each person individually; the
    // boards also split shared work from solo work, so both views are kept.
    const names = String(h.done_by || '?').split(CREDIT_SEP);
    if (names.length > 1) together.push(h);
    else {
      if (!solo.has(names[0])) solo.set(names[0], []);
      solo.get(names[0]).push(h);
    }
    for (const who of names) {
      if (!byPerson.has(who)) byPerson.set(who, []);
      byPerson.get(who).push(h);
    }
  }
  const people = [...byPerson.entries()].sort((a, b) => b[1].length - a[1].length);
  return { people, together, solo, expired: (expired && expired.n) || 0, total: history.results.length };
}

// Consecutive past full weeks the given person won outright (ties break it).
// One query for the whole 26-week window, grouped into weeks here — the old
// query-per-week loop made /stats up to 26 sequential D1 round trips.
export async function winnerStreak(env, chatId, tz, leader) {
  const end = weekStart(Date.now(), tz);
  const start = end - 26 * 7 * 86400000; // fixed-offset tz; exact for Asia/Singapore
  const { results } = await env.DB.prepare(
    "SELECT done_by, done_at FROM firings WHERE chat_id = ? AND state = 'done' AND scored = 1 AND done_at > ? AND done_at <= ?"
  ).bind(chatId, start, end).all();
  let streak = 0;
  for (let w = 0; w < 26; w++) {
    const hi = end - w * 7 * 86400000;
    const lo = hi - 7 * 86400000;
    const counts = new Map();
    for (const r of results) {
      if (r.done_at <= lo || r.done_at > hi) continue;
      for (const p of String(r.done_by || '').split(CREDIT_SEP)) {
        if (p) counts.set(p, (counts.get(p) || 0) + 1);
      }
    }
    if (!counts.size) break;
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    if (sorted[0][0] !== leader) break;
    if (sorted[1] && sorted[1][1] === sorted[0][1]) break;
    streak++;
  }
  return streak;
}

// "(N solo)" on a person's total, shown only when some of it was shared —
// an all-solo count needs no qualifier.
function soloNote(s, who, items) {
  const solo = (s.solo.get(who) || []).length;
  return solo === items.length ? '' : ` (${solo} solo)`;
}

// One person's block of the board: header line plus their recent items.
function personLines(who, items, tz, header) {
  const lines = ['', header];
  for (const h of items.slice(0, STATS_MAX_PER_PERSON)) {
    lines.push(`  ${[choreEmoji(h.text), esc(h.text)].filter(Boolean).join(' ')} — ${fmtShort(h.done_at, tz)}`);
  }
  if (items.length > STATS_MAX_PER_PERSON) lines.push(`  …and ${items.length - STATS_MAX_PER_PERSON} more`);
  return lines;
}

// The two tabs that aren't showing, plus OK. Tapping edits in place.
function statsButtons(view) {
  const tabs = [['week', '🏆 This week'], ['last', '📅 Last week'], ['all', '📜 6 months']]
    .filter(([v]) => v !== view)
    .map(([v, text]) => ({ text, callback_data: `st:${v}` }));
  return { inline_keyboard: [tabs, [{ text: '✅ OK', callback_data: 'ok' }]] };
}

async function statsHtml(env, chatId, tz, view) {
  const now = Date.now();
  let html;
  if (view === 'all') {
    const s = await choreStats(env, chatId, now - 183 * 24 * 3600000, now); // ~6 months
    if (!s.total && !s.expired) {
      return 'Nothing completed in the last 6 months yet. The cats are patient.';
    }
    const lines = ['📜 <b>Chore log — last 6 months</b>'];
    if (s.together.length) {
      lines.push(...personLines('', s.together, tz, `🤝 <b>Done together</b> — ${s.together.length} ✅`));
    }
    for (const [who, items] of s.people) {
      lines.push(...personLines(who, s.solo.get(who) || [], tz,
        `<b>${esc(who)}</b> — ${items.length} ✅${soloNote(s, who, items)}`));
    }
    if (s.expired) {
      lines.push('');
      lines.push(`🪦 Expired unclaimed: ${s.expired}`);
    }
    html = lines.join('\n');
  } else {
    const thisWeek = weekStart(now, tz);
    const since = view === 'last' ? thisWeek - 7 * 86400000 : thisWeek; // fixed-offset tz
    const until = view === 'last' ? thisWeek : now;
    const s = await choreStats(env, chatId, since, until);
    const ofWeek = `week of ${fmtShort(since, tz).replace(/,.*$/, '')}`;
    if (!s.total && !s.expired) {
      return view === 'last'
        ? `📅 <b>Last week</b> — ${ofWeek}\n\nNothing was completed. The cats pretend not to remember.`
        : '🏆 Fresh week, empty board — first chore takes the lead! (Resets every Monday.)';
    }
    const streak = view === 'week' && s.people.length
      ? await winnerStreak(env, chatId, tz, s.people[0][0]) : 0;
    const lines = [view === 'last'
      ? `📅 <b>Last week</b> — ${ofWeek}`
      : `🏆 <b>Weekly leaderboard</b> — ${ofWeek}`];
    if (s.together.length) {
      lines.push(...personLines('', s.together, tz, `🤝 <b>Done together</b> — ${s.together.length} ✅`));
    }
    s.people.forEach(([who, items], i) => {
      const fire = i === 0 && streak >= 1 ? ` · 🔥 ${streak + 1}-week reign` : '';
      lines.push(...personLines(who, s.solo.get(who) || [], tz,
        `${MEDALS[i] || '•'} <b>${esc(who)}</b> — ${items.length} ✅${soloNote(s, who, items)}${fire}`));
    });
    if (s.expired) {
      lines.push('');
      lines.push(`🪦 Expired unclaimed${view === 'week' ? ' this week' : ''}: ${s.expired}`);
    }
    if (view === 'week') {
      lines.push('');
      lines.push('Resets Monday');
    }
    html = lines.join('\n');
  }
  // One message with tabs cannot chunk; past the cap, trim on a line boundary.
  if (html.length > 4000) html = html.slice(0, html.lastIndexOf('\n', 3980)) + '\n…';
  return html;
}

export async function cmdStats(env, ctx, tz, args = '') {
  // "/stats all" and "/stats last" still work as deep links into the tabs.
  const view = /\b(all|6)/i.test(args) ? 'all' : /\b(last|prev)/i.test(args) ? 'last' : 'week';
  await sendPrivate(env, ctx, await statsHtml(env, ctx.chatId, tz, view), statsButtons(view));
}

// The st: callback family: flip the message to another tab in place.
export async function handleStatsCallback(env, cb, ctx, ref) {
  const m = (cb.data || '').match(/^st:(week|last|all)$/);
  if (!m) return answerCallback(env, cb.id, '');
  const chatId = cb.message.chat.id;
  const tz = await getTz(env, chatId);
  await editRef(env, ctx, chatId, ref, await statsHtml(env, chatId, tz, m[1]), statsButtons(m[1]));
  return answerCallback(env, cb.id, '');
}
