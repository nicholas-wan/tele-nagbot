// Fires one reminder: expires any stale nag, sends sticker + nag message,
// schedules the next occurrence. Used by the cron loop and by /remind ... now.

import { sendMessage } from './tg.js';
import { advanceOccurrence, deferQuietHours, weekStart } from './time.js';
import { nagButtons, nagHtml, expireFiring, updateDashboard } from './handlers.js';
import { sendRandomSticker } from './stickers.js';

// How long a one-off's fire claim holds before an unfinished fire retries.
const ONCE_LEASE_MS = 5 * 60000;

export async function fireReminder(env, r, now, tz) {
  // Claim the occurrence atomically (advance next_fire_at) before any sends:
  // an overlapping cron tick or "/remind ... now" racing the cron loses the
  // compare-and-swap. Recurring kinds advance to their next slot, so a crash
  // mid-fire drops one nag but keeps the schedule. A one-off has no next slot
  // to fall back on — NULLing at claim would kill it permanently — so it
  // takes a short lease instead, and only a completed fire finalizes to NULL.
  const next = advanceOccurrence(
    r.schedule_kind, JSON.parse(r.schedule_detail), r.next_fire_at, now, tz
  );
  const claimTo = next != null ? next : now + ONCE_LEASE_MS;
  const claim = await env.DB.prepare(
    'UPDATE reminders SET next_fire_at = ? WHERE id = ? AND next_fire_at = ?'
  ).bind(claimTo, r.id, r.next_fire_at).run();
  if (!claim.meta.changes) return;

  // Rotation: this occurrence goes to whoever has the fewest ✅ this week.
  if (JSON.parse(r.schedule_detail).rotate) {
    const who = await pickRotation(env, r.chat_id, tz);
    if (who) {
      await env.DB.prepare('UPDATE reminders SET assignee_name = ?, assignee_user_id = NULL WHERE id = ?')
        .bind(who, r.id).run();
      r.assignee_name = who;
      r.assignee_user_id = null;
    }
  }

  // A previous occurrence still nagging when the next one fires gets
  // quietly expired so only one live nag exists per reminder.
  const stale = await env.DB.prepare(
    "SELECT * FROM firings WHERE reminder_id = ? AND state = 'nagging'"
  ).bind(r.id).all();
  for (const f of stale.results) await expireFiring(env, f, r, { silent: true });

  const intervals = JSON.parse(r.nag_intervals);
  const ins = await env.DB.prepare(
    'INSERT INTO firings (reminder_id, chat_id, reminder_text, fired_at, next_nag_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(r.id, r.chat_id, r.text, now, deferQuietHours(now + intervals[0] * 60000, tz)).run();
  const firingId = ins.meta.last_row_id;

  const s = await sendRandomSticker(env, r.chat_id, firingId);
  const sent = await sendMessage(env, r.chat_id, nagHtml(r, 0, s.cat), nagButtons(firingId));
  await env.DB.prepare('UPDATE firings SET last_message_id = ?, last_sticker_id = ?, cat = ? WHERE id = ?')
    .bind(sent.ok ? sent.result.message_id : null, s.messageId, s.cat, firingId).run();

  // Fire completed: a one-off releases its lease and goes dormant. If the
  // lease expired mid-fire and a retry re-fired, the stale sweep above has
  // already replaced the earlier nag.
  if (next == null) {
    await env.DB.prepare(
      'UPDATE reminders SET next_fire_at = NULL WHERE id = ? AND next_fire_at = ?'
    ).bind(r.id, claimTo).run();
  }

  await updateDashboard(env, r.chat_id);
}

// Household members = everyone who has ever tapped Done here. Least ✅ this
// week wins the chore; ties go to the lower all-time count. Combined credits
// ("nick & jane" from done-together) count for each person.
async function pickRotation(env, chatId, tz) {
  const { results } = await env.DB.prepare(
    "SELECT done_by, done_at FROM firings WHERE chat_id = ? AND state = 'done' AND done_by IS NOT NULL"
  ).bind(chatId).all();
  const ws = weekStart(Date.now(), tz);
  const stats = new Map();
  for (const row of results) {
    for (const p of String(row.done_by).split(' & ')) {
      if (!p.trim()) continue;
      const s = stats.get(p) || { week: 0, total: 0 };
      s.total++;
      if (row.done_at > ws) s.week++;
      stats.set(p, s);
    }
  }
  if (!stats.size) return null;
  const sorted = [...stats.entries()].sort((a, b) =>
    a[1].week - b[1].week || a[1].total - b[1].total || a[0].localeCompare(b[0]));
  return sorted[0][0];
}
