// The leaderboard: weekly stats, the 6-month log, and winner streaks.

import { sendPrivate, sendPrivateLong, esc } from './tg.js';
import { weekStart, fmtShort } from './time.js';
import { CREDIT_SEP } from './household.js';
import { choreEmoji } from './dashboard.js';

const STATS_MAX_PER_PERSON = 15;
const MEDALS = ['🥇', '🥈', '🥉'];

// Fetches done-history and expired count for a window; shared by the weekly
// leaderboard, /stats all, and the Sunday recap.
export async function choreStats(env, chatId, since) {
  const expired = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM firings WHERE chat_id = ? AND state = 'expired' AND scored = 1 AND fired_at > ?"
  ).bind(chatId, since).first();
  const history = await env.DB.prepare(
    `SELECT f.done_by, f.done_at, COALESCE(f.reminder_text, r.text, '?') AS text
     FROM firings f LEFT JOIN reminders r ON r.id = f.reminder_id
     WHERE f.chat_id = ? AND f.state = 'done' AND f.scored = 1 AND f.done_at > ?
     ORDER BY f.done_at DESC`
  ).bind(chatId, since).all();
  const byPerson = new Map();
  for (const h of history.results) {
    // "nick & jane" (done together) credits each person individually.
    for (const who of String(h.done_by || '?').split(CREDIT_SEP)) {
      if (!byPerson.has(who)) byPerson.set(who, []);
      byPerson.get(who).push(h);
    }
  }
  const people = [...byPerson.entries()].sort((a, b) => b[1].length - a[1].length);
  return { people, expired: expired.n, total: history.results.length };
}

// Consecutive past full weeks the given person won outright (ties break it).
export async function winnerStreak(env, chatId, tz, leader) {
  let streak = 0;
  let start = weekStart(Date.now(), tz);
  for (let w = 0; w < 26; w++) {
    const end = start;
    start -= 7 * 86400000; // fixed-offset tz; exact for Asia/Singapore
    const { results } = await env.DB.prepare(
      "SELECT done_by FROM firings WHERE chat_id = ? AND state = 'done' AND scored = 1 AND done_at > ? AND done_at <= ?"
    ).bind(chatId, start, end).all();
    const counts = new Map();
    for (const r of results) {
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

// One person's block of the board: header line plus their recent items.
function personLines(who, items, tz, header) {
  const lines = ['', header];
  for (const h of items.slice(0, STATS_MAX_PER_PERSON)) {
    lines.push(`  ${[choreEmoji(h.text), esc(h.text)].filter(Boolean).join(' ')} — ${fmtShort(h.done_at, tz)}`);
  }
  if (items.length > STATS_MAX_PER_PERSON) lines.push(`  …and ${items.length - STATS_MAX_PER_PERSON} more`);
  return lines;
}

export async function cmdStats(env, ctx, tz, args = '') {
  const chatId = ctx.chatId;
  if (/^\s*all\b/i.test(args)) return statsAll(env, ctx, tz);

  const since = weekStart(Date.now(), tz);
  const s = await choreStats(env, chatId, since);
  if (!s.total && !s.expired) {
    return sendPrivate(env, ctx,
      '🏆 Fresh week, empty board — first chore takes the lead! (Resets every Monday; /stats all for history.)');
  }

  const streak = s.people.length ? await winnerStreak(env, chatId, tz, s.people[0][0]) : 0;
  const lines = [`🏆 <b>Weekly leaderboard</b> — week of ${fmtShort(since, tz).replace(/,.*$/, '')}`];
  s.people.forEach(([who, items], i) => {
    const fire = i === 0 && streak >= 1 ? ` · 🔥 ${streak + 1}-week reign` : '';
    lines.push(...personLines(who, items, tz,
      `${MEDALS[i] || '•'} <b>${esc(who)}</b> — ${items.length} ✅${fire}`));
  });
  if (s.expired) {
    lines.push('');
    lines.push(`🪦 Expired unclaimed this week: ${s.expired}`);
  }
  lines.push('');
  lines.push('Resets Monday · /stats all for the 6-month log');
  await sendPrivateLong(env, ctx, lines.join('\n'));
}

async function statsAll(env, ctx, tz) {
  const chatId = ctx.chatId;
  const since = Date.now() - 183 * 24 * 3600000; // ~6 months
  const s = await choreStats(env, chatId, since);
  if (!s.total && !s.expired) {
    return sendPrivate(env, ctx, 'Nothing completed in the last 6 months yet. The cats are patient.');
  }

  const lines = ['📜 <b>Chore log — last 6 months</b>'];
  for (const [who, items] of s.people) {
    lines.push(...personLines(who, items, tz, `<b>${esc(who)}</b> — ${items.length} ✅`));
  }
  if (s.expired) {
    lines.push('');
    lines.push(`🪦 Expired unclaimed: ${s.expired}`);
  }
  await sendPrivateLong(env, ctx, lines.join('\n'));
}
