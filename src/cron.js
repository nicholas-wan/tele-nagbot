// Runs every minute: fire due reminders, re-send unacknowledged nags,
// expire firings older than 24h.

import { sendMessage, editMessage, esc, pinMessage, unpinMessage, mentionHtml } from './tg.js';
import { getTz, nagButtons, nagHtml, expireFiring, EXPIRE_AFTER_MS } from './handlers.js';
import { sendRandomSticker } from './stickers.js';
import { fireReminder } from './firing.js';
import { localParts, zonedEpoch, fmtClock } from './time.js';

export async function runCron(env) {
  const now = Date.now();
  await sendDigests(env, now);
  await fireDueReminders(env, now);
  await renagPending(env, now);
  // Abandoned time-choice prompts expire after a day.
  await env.DB.prepare('DELETE FROM drafts WHERE created_at < ?').bind(now - 86400000).run();
}

// 8am local: one summary of the day's chores per chat. Skipped when there is
// nothing due today and nothing still nagging.
async function sendDigests(env, now) {
  const { results } = await env.DB.prepare('SELECT DISTINCT chat_id FROM reminders').all();
  for (const { chat_id } of results) {
    const tz = await getTz(env, chat_id);
    const p = localParts(now, tz);
    if (p.h !== 8) continue;
    const ymd = `${p.y}-${p.mo}-${p.d}`;
    const row = await env.DB.prepare('SELECT last_digest FROM settings WHERE chat_id = ?').bind(chat_id).first();
    if (row && row.last_digest === ymd) continue;
    await env.DB.prepare(
      'INSERT INTO settings (chat_id, last_digest) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET last_digest = excluded.last_digest'
    ).bind(chat_id, ymd).run();

    const endOfDay = zonedEpoch(p.y, p.mo, p.d, 23, 59, tz);
    const due = await env.DB.prepare(
      'SELECT * FROM reminders WHERE chat_id = ? AND paused = 0 AND next_fire_at IS NOT NULL AND next_fire_at <= ? ORDER BY next_fire_at'
    ).bind(chat_id, endOfDay).all();
    const nagging = await env.DB.prepare(
      "SELECT r.text, r.assignee_name, r.assignee_user_id FROM firings f JOIN reminders r ON r.id = f.reminder_id WHERE f.chat_id = ? AND f.state = 'nagging'"
    ).bind(chat_id).all();
    if (!due.results.length && !nagging.results.length) continue;

    const who = (r) => r.assignee_name ? ` (${mentionHtml(r.assignee_name, r.assignee_user_id)})` : '';
    const lines = ['☀️ Mrow. Today\'s agenda from Latte &amp; Mocha:'];
    for (const r of due.results) lines.push(`• ${fmtClock(r.next_fire_at, tz)} — <b>${esc(r.text)}</b>${who(r)}`);
    if (nagging.results.length) {
      lines.push('Still hanging over you:');
      for (const r of nagging.results) lines.push(`• <b>${esc(r.text)}</b>${who(r)}`);
    }
    await sendMessage(env, chat_id, lines.join('\n'));
  }
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
    // Keep the pin on the newest live nag.
    if (sent.ok) {
      if (f.last_message_id) await unpinMessage(env, f.chat_id, f.last_message_id);
      await pinMessage(env, f.chat_id, sent.result.message_id);
    }
  }
}
