// Fires one reminder: expires any stale nag, sends sticker + nag message,
// schedules the next occurrence. Used by the cron loop and by /remind ... now.

import { sendMessage, pinMessage } from './tg.js';
import { nextOccurrence } from './time.js';
import { nagButtons, nagHtml, expireFiring } from './handlers.js';
import { sendRandomSticker } from './stickers.js';

export async function fireReminder(env, r, now, tz) {
  // A previous occurrence still nagging when the next one fires gets
  // quietly expired so only one live nag exists per reminder.
  const stale = await env.DB.prepare(
    "SELECT * FROM firings WHERE reminder_id = ? AND state = 'nagging'"
  ).bind(r.id).all();
  for (const f of stale.results) await expireFiring(env, f, r, { silent: true });

  const intervals = JSON.parse(r.nag_intervals);
  const ins = await env.DB.prepare(
    'INSERT INTO firings (reminder_id, chat_id, fired_at, next_nag_at) VALUES (?, ?, ?, ?)'
  ).bind(r.id, r.chat_id, now, now + intervals[0] * 60000).run();
  const firingId = ins.meta.last_row_id;

  const cat = await sendRandomSticker(env, r.chat_id, firingId);
  const sent = await sendMessage(env, r.chat_id, nagHtml(r, 0, cat), nagButtons(firingId));
  if (sent.ok) {
    await env.DB.prepare('UPDATE firings SET last_message_id = ? WHERE id = ?')
      .bind(sent.result.message_id, firingId).run();
    await pinMessage(env, r.chat_id, sent.result.message_id);
  }

  const next = nextOccurrence(r.schedule_kind, JSON.parse(r.schedule_detail), now, tz);
  await env.DB.prepare('UPDATE reminders SET next_fire_at = ? WHERE id = ?').bind(next, r.id).run();
}
