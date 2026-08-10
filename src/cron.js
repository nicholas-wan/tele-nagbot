// Runs every minute: fire due reminders, re-send unacknowledged nags,
// expire firings older than 24h.

import { sendMessage, sendLong, deleteMessage, esc, mentionHtml } from './tg.js';
import { getTz, nagButtons, nagHtml, expireFiring, updateDashboard, choreStats, EXPIRE_AFTER_MS } from './handlers.js';
import { fireReminder } from './firing.js';
import { localParts, zonedEpoch, fmtClock, weekStart } from './time.js';

export async function runCron(env) {
  const now = Date.now();
  // Each step isolated: one failing must not starve the ones after it.
  const steps = {
    digests: () => sendDigests(env, now),
    weekly: () => sendWeeklyRecap(env, now),
    fire: () => fireDueReminders(env, now),
    renag: () => renagPending(env, now),
    // Abandoned time-choice prompts expire after a day.
    drafts: () => env.DB.prepare('DELETE FROM drafts WHERE created_at < ?').bind(now - 86400000).run(),
  };
  for (const [name, step] of Object.entries(steps)) {
    try {
      await step();
    } catch (e) {
      console.log(`cron step ${name} failed: ${e.stack || e}`);
    }
  }
}

// Sunday 8pm local: the cats crown the week's winner before Monday's reset.
async function sendWeeklyRecap(env, now) {
  const { results } = await env.DB.prepare('SELECT DISTINCT chat_id FROM firings').all();
  for (const { chat_id } of results) {
    try {
      const tz = await getTz(env, chat_id);
      const p = localParts(now, tz);
      if (p.wd !== 0 || p.h !== 20) continue;
      const ymd = `${p.y}-${p.mo}-${p.d}`;
      // The WHERE on the upsert makes the once-per-day claim atomic, so
      // overlapping cron invocations can't both send the recap.
      const claim = await env.DB.prepare(
        `INSERT INTO settings (chat_id, last_weekly) VALUES (?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET last_weekly = excluded.last_weekly
         WHERE settings.last_weekly IS NOT excluded.last_weekly`
      ).bind(chat_id, ymd).run();
      if (!claim.meta.changes) continue;

      const s = await choreStats(env, chat_id, weekStart(now, tz));
      if (!s.total && !s.expired) continue;

      const lines = ['🏁 <b>Weekly wrap from Latte &amp; Mocha</b>'];
      if (s.people.length) {
        const [winner, winnerItems] = s.people[0];
        const tie = s.people.length > 1 && s.people[1][1].length === winnerItems.length;
        lines.push(tie
          ? `It's a tie at ${winnerItems.length} ✅ each — the cats demand a tiebreaker chore.`
          : `🥇 ${esc(winner)} takes the week with ${winnerItems.length} ✅!`);
        for (const [who, items] of s.people) lines.push(`• ${esc(who)}: ${items.length} ✅`);
      }
      if (s.expired) lines.push(`🪦 ${s.expired} expired unclaimed. The cats saw everything.`);
      lines.push('Fresh board Monday. /stats anytime.');
      await sendMessage(env, chat_id, lines.join('\n'), null, { silent: true });
    } catch (e) {
      console.log(`weekly recap for chat ${chat_id} failed: ${e.stack || e}`);
    }
  }
}

// 8am local: one summary of the day's chores per chat. Skipped when there is
// nothing due today and nothing still nagging.
async function sendDigests(env, now) {
  const { results } = await env.DB.prepare('SELECT DISTINCT chat_id FROM reminders').all();
  for (const { chat_id } of results) {
    try {
      const tz = await getTz(env, chat_id);
      const p = localParts(now, tz);
      if (p.h !== 8) continue;
      const ymd = `${p.y}-${p.mo}-${p.d}`;
      // Same atomic once-per-day claim as the weekly recap.
      const claim = await env.DB.prepare(
        `INSERT INTO settings (chat_id, last_digest) VALUES (?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET last_digest = excluded.last_digest
         WHERE settings.last_digest IS NOT excluded.last_digest`
      ).bind(chat_id, ymd).run();
      if (!claim.meta.changes) continue;

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
      await sendLong(env, chat_id, lines.join('\n'), { silent: true });
    } catch (e) {
      console.log(`digest for chat ${chat_id} failed: ${e.stack || e}`);
    }
  }
}

async function fireDueReminders(env, now) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM reminders WHERE paused = 0 AND next_fire_at IS NOT NULL AND next_fire_at <= ?'
  ).bind(now).all();

  for (const r of results) {
    try {
      const tz = await getTz(env, r.chat_id);
      await fireReminder(env, r, now, tz);
    } catch (e) {
      console.log(`firing reminder ${r.id} failed: ${e.stack || e}`);
    }
  }
}

async function renagPending(env, now) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM firings WHERE state = 'nagging' AND next_nag_at IS NOT NULL AND next_nag_at <= ?"
  ).bind(now).all();

  for (const f of results) {
    try {
      const r = await env.DB.prepare('SELECT * FROM reminders WHERE id = ?').bind(f.reminder_id).first();
      if (!r) {
        await env.DB.prepare("UPDATE firings SET state = 'expired', next_nag_at = NULL WHERE id = ?").bind(f.id).run();
        continue;
      }
      // /pause freezes in-flight nags too (no re-nags, no expiry ticking).
      if (r.paused) continue;

      if (now - f.fired_at > EXPIRE_AFTER_MS) {
        await expireFiring(env, f, r);
        continue;
      }

      const intervals = JSON.parse(r.nag_intervals);
      const nagCount = f.nag_count + 1;
      const interval = intervals[Math.min(nagCount, intervals.length - 1)];
      // Claim this re-nag before any sends: an overlapping cron tick loses the
      // compare-and-swap, and a Done/snooze landing mid-send isn't clobbered.
      const claim = await env.DB.prepare(
        "UPDATE firings SET nag_count = ?, next_nag_at = ? WHERE id = ? AND state = 'nagging' AND next_nag_at = ?"
      ).bind(nagCount, now + interval * 60000, f.id, f.next_nag_at).run();
      if (!claim.meta.changes) continue;

      // One live nag per chore: remove the previous nag and its sticker.
      if (f.last_message_id) await deleteMessage(env, f.chat_id, f.last_message_id);
      if (f.last_sticker_id) await deleteMessage(env, f.chat_id, f.last_sticker_id);

      // Loudness ladder: first re-nag is silent; later ones notify again.
      const sent = await sendMessage(env, f.chat_id, nagHtml(r, nagCount, f.cat || 'both'),
        nagButtons(f.id), { silent: nagCount === 1 });
      const upd = await env.DB.prepare(
        "UPDATE firings SET last_message_id = ?, last_sticker_id = NULL WHERE id = ? AND state = 'nagging'"
      ).bind(sent.ok ? sent.result.message_id : null, f.id).run();
      // Done/expired won the race while we were sending — remove the orphan nag.
      if (!upd.meta.changes && sent.ok) await deleteMessage(env, f.chat_id, sent.result.message_id);
      // Self-heal: recreate the dashboard if it is missing (e.g. deleted by hand
      // or the nag predates the dashboard feature).
      await updateDashboard(env, f.chat_id);
    } catch (e) {
      console.log(`re-nag for firing ${f.id} failed: ${e.stack || e}`);
    }
  }
}
