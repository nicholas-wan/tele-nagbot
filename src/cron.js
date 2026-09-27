// Runs every minute: fire due reminders, re-send unacknowledged nags,
// expire firings older than 24h.

import { sendMessage, deleteMessage, editMessage, esc, mentionHtml, deleteEphemeral, okButton } from './tg.js';
import { getTz, isScored } from './household.js';
import { nagButtons, nagHtml, expireFiring, nagChat, sendNag, deleteNag, deleteNagRef, EXPIRE_AFTER_MS } from './nag.js';
import { updateDashboard } from './dashboard.js';
import { choreStats, winnerStreak } from './stats.js';
import { wakeChat, UNDO_WINDOW_MS } from './chores.js';
import { fireReminder } from './firing.js';
import { localParts, weekStart, deferQuietHours } from './time.js';

export async function runCron(env) {
  const now = Date.now();
  // Each step isolated: one failing must not starve the ones after it.
  const steps = {
    wake: () => wakeLapsedPauses(env, now),
    digests: () => sendDigests(env, now),
    weekly: () => sendWeeklyRecap(env, now),
    fire: () => fireDueReminders(env, now),
    renag: () => renagPending(env, now),
    // Abandoned time-choice prompts and /delete undo stashes expire after a day.
    drafts: () => pruneDraftsAndTrash(env, now),
    // Everything the bot said a day ago is tidied away; the pin stays.
    sweep: () => sweepSentMessages(env, now),
    retention: () => pruneOldFirings(env, now),
  };
  for (const [name, step] of Object.entries(steps)) {
    try {
      await step();
    } catch (e) {
      console.log(`cron step ${name} failed: ${e.stack || e}`);
    }
  }
}

// Deletes every recorded bot message whose day is up, each through the method
// its kind requires. A message someone already dismissed with OK just makes
// Telegram refuse the delete — same outcome, so the row goes either way.
//
// A nag card is recorded with the ordinary day, but three things keep its
// firing live past that: a pause (which stops the expiry clock), a
// postponement, and an overdue one-off, which is never re-nagged. Sweeping
// the card then left the board saying "nagging now" with nothing to tap. So a
// card that is still some nagging firing's current message is skipped — and
// its row keeps coming due, so the moment the firing ends or re-nags, the
// card goes with the next pass. Both id spaces are matched, as everywhere.
async function sweepSentMessages(env, now) {
  const { results } = await env.DB.prepare(
    `SELECT s.* FROM sent_messages s WHERE s.delete_after <= ?
       AND NOT EXISTS (SELECT 1 FROM firings f WHERE f.state = 'nagging'
         AND f.chat_id = s.chat_id AND f.last_message_id = s.message_id
         AND f.last_message_ephemeral = s.is_ephemeral)
     ORDER BY s.delete_after LIMIT 100`
  ).bind(now).all();
  for (const row of results) {
    try {
      if (row.is_ephemeral) {
        // deleteEphemeral only reads chatId/userId off the ctx.
        await deleteEphemeral(env, { chatId: row.chat_id, userId: row.receiver_user_id }, row.message_id);
      } else {
        await deleteMessage(env, row.chat_id, row.message_id);
      }
      await env.DB.prepare('DELETE FROM sent_messages WHERE id = ?').bind(row.id).run();
    } catch (e) {
      console.log(`sweep of sent message ${row.id} failed: ${e.stack || e}`);
    }
  }
}

async function pruneDraftsAndTrash(env, now) {
  const cutoff = now - 86400000;
  const { results } = await env.DB.prepare(
    'SELECT * FROM drafts WHERE created_at < ?'
  ).bind(cutoff).all();
  for (const draft of results) {
    // Ephemeral wizard/prompt ids live in their own sequence: the public
    // edit/delete here could hit an unrelated group message wearing the same
    // number. Those messages are recorded in sent_messages at send time, so
    // the sweep already removes them — only public ones need tidying here.
    if (draft.wizard_msg_id && !draft.wizard_msg_ephemeral) {
      await editMessage(env, draft.chat_id, draft.wizard_msg_id,
        `⌛ Time picker expired for <s>${esc(draft.text)}</s>. Send /remind to start again.`,
        { inline_keyboard: [] });
    }
    if (draft.prompt_msg_id && !draft.prompt_msg_ephemeral) {
      await deleteMessage(env, draft.chat_id, draft.prompt_msg_id);
    }
  }
  await env.DB.prepare('DELETE FROM drafts WHERE created_at < ?').bind(cutoff).run();
  await env.DB.prepare('DELETE FROM trash WHERE created_at < ?').bind(cutoff).run();
}

// Vacation mode ("/pause all N"): end any chat pause whose deadline passed.
async function wakeLapsedPauses(env, now) {
  const { results } = await env.DB.prepare(
    'SELECT chat_id FROM settings WHERE paused_until IS NOT NULL AND paused_until <= ?'
  ).bind(now).all();
  for (const { chat_id } of results) {
    try {
      await wakeChat(env, chat_id, await getTz(env, chat_id));
    } catch (e) {
      console.log(`wake for chat ${chat_id} failed: ${e.stack || e}`);
    }
  }
}

// Chats currently in vacation mode; everything below skips them.
async function pausedChats(env, now) {
  const { results } = await env.DB.prepare(
    'SELECT chat_id FROM settings WHERE paused_until > ?'
  ).bind(now).all();
  return new Set(results.map((r) => r.chat_id));
}

// Once a day (the 03:00 UTC hour): drop settled firings older than the
// 6-month /stats window so the table doesn't grow forever on the free tier.
// A five-minute window rather than the 03:00 minute exactly: a cron tick that
// runs late or is skipped altogether used to cost the whole day's retention,
// and repeating this DELETE is idempotent and cheap.
const RETENTION_WINDOW_MIN = 5;
async function pruneOldFirings(env, now) {
  const d = new Date(now);
  if (d.getUTCHours() !== 3 || d.getUTCMinutes() >= RETENTION_WINDOW_MIN) return;
  await env.DB.prepare(
    "DELETE FROM firings WHERE state IN ('done', 'expired') AND fired_at < ?"
  ).bind(now - 183 * 86400000).run();
}

// Sunday 8pm local: the cats crown the week's winner before Monday's reset.
async function sendWeeklyRecap(env, now) {
  const paused = await pausedChats(env, now);
  const { results } = await env.DB.prepare('SELECT DISTINCT chat_id FROM firings').all();
  for (const { chat_id } of results) {
    try {
      if (paused.has(chat_id)) continue;
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
        const streak = tie ? 0 : await winnerStreak(env, chat_id, tz, winner);
        lines.push(tie
          ? `It's a tie at ${winnerItems.length} ✅ each — the cats demand a tiebreaker chore.`
          : `🥇 ${esc(winner)} takes the week with ${winnerItems.length} ✅!` +
            (streak >= 1 ? ` 🔥 ${streak + 1} weeks running!` : ''));
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

// The digest's text and buttons for a given set of firings: one line and one
// ✅ button per chore still nagging, so the message that says "this is still
// hanging over you" is also the place to say it no longer is — and, for a
// chore finished from this digest within the undo window, a struck line with
// ↩️ Not done, because that ✅ sits right under the thumb and a slip used to
// be final. The 8am send and every redraw after a tap go through here, with
// the ids the digest's buttons still carry, so a chore that fires later in
// the day never joins a digest about yesterday. Firings finished by another
// route drop off; scoped to the chat like every firing lookup. Always ends
// with OK: a digest with only ✅ buttons could not be put away without
// finishing something.
const DIGEST_BUTTONS = 25;
export async function digestView(env, chatId, firingIds, now = Date.now()) {
  const ids = [...new Set(firingIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  const rows = ids.length ? (await env.DB.prepare(
    `SELECT f.id, f.state, f.done_at, f.done_by, COALESCE(r.text, f.reminder_text, '?') AS text,
            r.assignee_name, r.assignee_user_id
     FROM firings f LEFT JOIN reminders r ON r.id = f.reminder_id
     WHERE f.chat_id = ? AND f.state IN ('nagging', 'done') AND f.id IN (${ids.map(() => '?').join(',')})
     ORDER BY f.id`
  ).bind(chatId, ...ids).all()).results : [];
  const nagging = rows.filter((r) => r.state === 'nagging');
  const undone = rows.filter((r) => r.state === 'done' && r.done_at != null && now - r.done_at <= UNDO_WINDOW_MS);
  const label = (text) => (text.length > 28 ? `${text.slice(0, 27)}…` : text);
  const buttons = undone.map((r) => [{ text: `↩️ Not done · ${label(r.text)}`, callback_data: `nd:${r.id}` }]);
  buttons.push([okButton()]);
  if (!nagging.length) {
    const lines = ['☀️ All caught up — nothing left hanging over from yesterday. The cats approve 😻'];
    for (const r of undone) lines.push(`😻 <s>${esc(r.text)}</s> — done by ${esc(r.done_by || 'someone')}`);
    return { html: lines.join('\n'), markup: { inline_keyboard: buttons } };
  }
  const who = (r) => r.assignee_name ? ` (${mentionHtml(r.assignee_name, r.assignee_user_id)})` : '';
  const lines = ['☀️ Mrow. Still hanging over you from yesterday:'];
  for (const r of nagging) lines.push(`• <b>${esc(r.text)}</b>${who(r)}`);
  for (const r of undone) lines.push(`😻 <s>${esc(r.text)}</s> — done by ${esc(r.done_by || 'someone')}`);
  const rows2 = nagging.slice(0, DIGEST_BUTTONS).map((r) => [{ text: `✅ ${label(r.text)}`, callback_data: `dg:${r.id}` }]);
  if (nagging.length > DIGEST_BUTTONS) lines.push('<i>The rest can be finished from the pinned board.</i>');
  return { html: lines.join('\n'), markup: { inline_keyboard: [...rows2, ...buttons] } };
}

// 8am local: one summary of the day's chores per chat. Skipped when there is
// nothing due today and nothing still nagging.
export async function sendDigests(env, now) {
  const paused = await pausedChats(env, now);
  const { results } = await env.DB.prepare('SELECT DISTINCT chat_id FROM reminders').all();
  for (const { chat_id } of results) {
    try {
      if (paused.has(chat_id)) continue;
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

      // Once-a-day dashboard refresh keeps the pinned countdowns honest even
      // when no chore event has touched it.
      await updateDashboard(env, chat_id);

      // The pinned board is refreshed this same minute and already carries
      // today's agenda, so a routine bulletin would only repeat it. The digest
      // speaks only when something was left hanging overnight.
      //
      // A recurring firing past its 24h is not "still hanging": quiet hours
      // held its expiry back to 08:00, and the renag step of this very tick
      // tombstones it seconds after the digest goes out — so the digest used
      // to hand out a ✅ for a chore that was already gone by the time anyone
      // read it. The tombstone says what happened to it. An overdue one-off
      // stays: it is never expired, and Done here still counts.
      //
      // Nor is a chore the household parked "hanging": one postponed with
      // 📅 Tomorrow (fired_at ahead of now) or snoozed to a time still to
      // come (isHouseholdDeferred, in SQL) is due when they said, not this
      // morning — listing it with a ✅ under the thumb is how a chore that
      // was not even due got marked done by mistake.
      const nagging = await env.DB.prepare(
        `SELECT f.id FROM firings f JOIN reminders r ON r.id = f.reminder_id
         WHERE f.chat_id = ? AND f.state = 'nagging'
           AND (r.schedule_kind = 'once' OR f.fired_at > ?)
           AND f.fired_at <= ?
           AND NOT (f.snoozed_until IS NOT NULL AND f.next_nag_at = f.snoozed_until AND f.next_nag_at > ?)`
      ).bind(chat_id, now - EXPIRE_AFTER_MS, now, now).all();
      if (!nagging.results.length) continue;
      const view = await digestView(env, chat_id, nagging.results.map((f) => f.id));
      await sendMessage(env, chat_id, view.html, view.markup, { silent: true });
    } catch (e) {
      console.log(`digest for chat ${chat_id} failed: ${e.stack || e}`);
    }
  }
}

async function fireDueReminders(env, now) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM reminders WHERE paused = 0 AND next_fire_at IS NOT NULL AND next_fire_at <= ?'
  ).bind(now).all();

  const paused = await pausedChats(env, now);
  for (const r of results) {
    try {
      if (paused.has(r.chat_id)) continue;
      const tz = await getTz(env, r.chat_id);
      await fireReminder(env, r, now, tz);
    } catch (e) {
      console.log(`firing reminder ${r.id} failed: ${e.stack || e}`);
    }
  }
}

// Exported so the expiry claims below can be pinned directly, without driving
// eight unrelated cron steps to reach them.
export async function renagPending(env, now) {
  // Due re-nags, plus anything past the 24h deadline regardless of snoozes —
  // expiry must not wait for the next nag slot to come due.
  const { results } = await env.DB.prepare(
    "SELECT * FROM firings WHERE state = 'nagging' AND ((next_nag_at IS NOT NULL AND next_nag_at <= ?) OR fired_at <= ?)"
  ).bind(now, now - EXPIRE_AFTER_MS).all();

  const paused = await pausedChats(env, now);
  for (const f of results) {
    try {
      if (paused.has(f.chat_id)) continue; // vacation freezes nags and expiry
      const r = await env.DB.prepare('SELECT * FROM reminders WHERE id = ?').bind(f.reminder_id).first();
      if (!r) {
        // Same conditional claim as expireFiring, for the same reason: this
        // tick's fired_at is a snapshot, and a resume may have moved it. The
        // winner also takes the card down — it kept live buttons for a chore
        // that no longer existed until the sweep reached it a day later.
        const claim = await env.DB.prepare(
          "UPDATE firings SET state = 'expired', next_nag_at = NULL WHERE id = ? AND state = 'nagging' AND fired_at = ?"
        ).bind(f.id, f.fired_at).run();
        if (claim.meta.changes) {
          if (f.last_message_id) await deleteNag(env, f);
          if (f.last_sticker_id) await deleteMessage(env, nagChat(f), f.last_sticker_id);
        }
        continue;
      }
      // /pause freezes in-flight nags too (no re-nags, no expiry ticking).
      if (r.paused) continue;
      // Quiet overdue one-offs remain available on the board and to /done.
      if (r.schedule_kind === 'once' && f.next_nag_at == null) continue;

      const tz = await getTz(env, f.chat_id);
      // Quiet hours: nothing nags (or announces expiry) overnight — anything
      // due now waits for 8am instead.
      const wake = deferQuietHours(now, tz);
      if (wake > now) {
        if (f.next_nag_at != null && f.next_nag_at <= now) {
          await env.DB.prepare(
            "UPDATE firings SET next_nag_at = ? WHERE id = ? AND state = 'nagging' AND next_nag_at = ?"
          ).bind(wake, f.id, f.next_nag_at).run();
        }
        continue;
      }

      if (now - f.fired_at > EXPIRE_AFTER_MS) {
        await expireFiring(env, f, r);
        continue;
      }
      // Row was selected by the expiry clause only; its next nag isn't due yet.
      if (f.next_nag_at == null || f.next_nag_at > now) continue;

      const intervals = JSON.parse(r.nag_intervals);
      const nagCount = f.nag_count + 1;
      // Never below a minute: a row poisoned with [null] or [0] (the editor
      // once stored any value it was handed) re-nagged every tick forever.
      const interval = Math.max(1, Number(intervals[Math.min(nagCount, intervals.length - 1)]) || 15);
      // Claim this re-nag before any sends: an overlapping cron tick loses the
      // compare-and-swap, and a Done/snooze landing mid-send isn't clobbered.
      const claim = await env.DB.prepare(
        "UPDATE firings SET nag_count = ?, next_nag_at = ? WHERE id = ? AND state = 'nagging' AND next_nag_at = ?"
      ).bind(nagCount, deferQuietHours(now + interval * 60000, tz), f.id, f.next_nag_at).run();
      if (!claim.meta.changes) continue;

      // One live nag per chore: remove the previous nag and its sticker.
      // Re-nags follow the first nag's home (assignee DM or the group).
      if (f.last_message_id) await deleteNag(env, f);
      if (f.last_sticker_id) await deleteMessage(env, nagChat(f), f.last_sticker_id);

      // Loudness ladder: first re-nag is silent; later ones notify again.
      // sendNag keeps an assigned chore's re-nag as private as its first nag.
      const ref = await sendNag(env, f, nagHtml(r, nagCount, f.cat || 'both'),
        nagButtons(f.id, isScored(f)), { silent: nagCount === 1 });
      // Bound to the message id this tick read as well as the state: a /poke
      // re-sending in the same second is the other writer, and two
      // unconditional writes left one of the two cards untracked with live
      // buttons that nothing would ever clean up.
      const upd = await env.DB.prepare(
        `UPDATE firings SET last_message_id = ?, last_message_ephemeral = ?, last_sticker_id = NULL
         WHERE id = ? AND state = 'nagging' AND last_message_id IS ?`
      ).bind(ref ? ref.id : null, ref && ref.ephemeral ? 1 : 0, f.id, f.last_message_id).run();
      // Done/expired (or the other writer) won the race while we were sending
      // — remove the orphan nag.
      if (!upd.meta.changes && ref) await deleteNagRef(env, f, ref);
      // Self-heal: recreate the dashboard if it is missing (e.g. deleted by hand
      // or the nag predates the dashboard feature).
      await updateDashboard(env, f.chat_id);
    } catch (e) {
      console.log(`re-nag for firing ${f.id} failed: ${e.stack || e}`);
    }
  }
}
