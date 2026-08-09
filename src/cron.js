// Runs every minute: fire due reminders, re-send unacknowledged nags,
// expire firings older than 24h.

import { sendMessage, editMessage, esc } from './tg.js';
import { getTz, nagButtons, nagHtml, expireFiring, EXPIRE_AFTER_MS } from './handlers.js';
import { sendRandomSticker } from './stickers.js';
import { fireReminder } from './firing.js';

export async function runCron(env) {
  const now = Date.now();
  await fireDueReminders(env, now);
  await renagPending(env, now);
  // Abandoned time-choice prompts expire after a day.
  await env.DB.prepare('DELETE FROM drafts WHERE created_at < ?').bind(now - 86400000).run();
}

async function fireDueReminders(env, now) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM reminders WHERE paused = 0 AND next_fire_at IS NOT NULL AND next_fire_at <= ?'
  ).bind(now).all();

  for (const r of results) {
    const tz = await getTz(env, r.chat_id);
    await fireReminder(env, r, now, tz);
  }
}

async function renagPending(env, now) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM firings WHERE state = 'nagging' AND next_nag_at IS NOT NULL AND next_nag_at <= ?"
  ).bind(now).all();

  for (const f of results) {
    const r = await env.DB.prepare('SELECT * FROM reminders WHERE id = ?').bind(f.reminder_id).first();
    if (!r) {
      await env.DB.prepare("UPDATE firings SET state = 'expired', next_nag_at = NULL WHERE id = ?").bind(f.id).run();
      continue;
    }

    if (now - f.fired_at > EXPIRE_AFTER_MS) {
      await expireFiring(env, f, r);
      continue;
    }

    // Strike through the previous nag so only the newest message is live.
    if (f.last_message_id) {
      await editMessage(env, f.chat_id, f.last_message_id, `🔕 <s>${esc(r.text)}</s>`);
    }

    const intervals = JSON.parse(r.nag_intervals);
    const nagCount = f.nag_count + 1;
    const interval = intervals[Math.min(nagCount, intervals.length - 1)];
    const cat = await sendRandomSticker(env, f.chat_id, f.id * 7 + nagCount);
    const sent = await sendMessage(env, f.chat_id, nagHtml(r, nagCount, cat), nagButtons(f.id));
    await env.DB.prepare(
      'UPDATE firings SET nag_count = ?, next_nag_at = ?, last_message_id = ? WHERE id = ?'
    ).bind(
      nagCount, now + interval * 60000,
      sent.ok ? sent.result.message_id : f.last_message_id, f.id
    ).run();
  }
}
