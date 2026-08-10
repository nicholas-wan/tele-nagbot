// Fires one reminder: expires any stale nag, sends sticker + nag message,
// schedules the next occurrence. Used by the cron loop and by /remind ... now.

import { sendMessage } from './tg.js';
import { nextOccurrence, deferQuietHours, weekStart } from './time.js';
import { nagButtons, nagHtml, expireFiring, updateDashboard } from './handlers.js';
import { sendRandomSticker } from './stickers.js';

export async function fireReminder(env, r, now, tz) {
  // Claim the occurrence atomically (advance next_fire_at) before any sends:
  // an overlapping cron tick or "/remind ... now" racing the cron loses the
  // compare-and-swap. A crash mid-fire drops one nag, not the schedule.
  const next = nextOccurrence(r.schedule_kind, JSON.parse(r.schedule_detail), now, tz);
  const claim = await env.DB.prepare(
    'UPDATE reminders SET next_fire_at = ? WHERE id = ? AND next_fire_at = ?'
  ).bind(next, r.id, r.next_fire_at).run();
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

  await updateDashboard(env, r.chat_id);
}

// Household members = everyone who has ever tapped Done here (6-month window).
// Least ✅ this week wins the chore; ties go to the lower all-time count.
async function pickRotation(env, chatId, tz) {
  const { results } = await env.DB.prepare(
    `SELECT done_by, COUNT(*) AS total, SUM(CASE WHEN done_at > ? THEN 1 ELSE 0 END) AS week
     FROM firings WHERE chat_id = ? AND state = 'done' AND done_by IS NOT NULL
     GROUP BY done_by`
  ).bind(weekStart(Date.now(), tz), chatId).all();
  if (!results.length) return null;
  results.sort((a, b) => a.week - b.week || a.total - b.total
    || String(a.done_by).localeCompare(String(b.done_by)));
  return results[0].done_by;
}
