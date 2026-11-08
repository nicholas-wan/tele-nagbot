// Runs every minute: fire due reminders, re-send unacknowledged nags,
// expire firings older than 24h.

import { sendMessage, deleteMessage, editMessage, esc, mentionHtml, deleteEphemeral, okButton } from './tg.js';
import { getTz, isScored, primeTz } from './household.js';
import { nagButtons, nagHtml, overdueHtml, expireFiring, nagChat, sendNag, deleteNag, deleteNagRef, isOverdue,
         EXPIRE_AFTER_MS, OVERDUE_NAG_MIN } from './nag.js';
import { updateDashboard, deferBoards, flushBoards } from './dashboard.js';
import { choreStats, winnerStreak } from './stats.js';
import { wakeChat, UNDO_WINDOW_MS } from './chores.js';
import { fireReminder } from './firing.js';
import { localParts, weekStart, deferQuietHours } from './time.js';
import { recoverUpdates, recoveryStatements, pruneOldUpdatesStatement } from './updates.js';

// What this tick has to do, in one round trip. Nearly every minute the answer
// is "nothing", and each step used to find that out with a query of its own.
// Anything that comes due after this read — seconds later, or because an
// earlier step made it so — is simply picked up by the next tick. The webhook
// inbox's recovery reads ride here too, and the chats come from `settings`
// (with their timezones, which prime the cache) plus ALLOWED_CHATS, rather
// than a DISTINCT over every firing ever kept: an idle tick is one round trip.
async function dueThisTick(env, now) {
  const exists = (sql, ...args) => env.DB.prepare(`SELECT EXISTS(${sql}) AS due`).bind(...args);
  const [wake, fire, renag, drafts, sweep, paused, chats, pending, interrupted] = await env.DB.batch([
    exists('SELECT 1 FROM settings WHERE paused_until IS NOT NULL AND paused_until <= ?', now),
    exists('SELECT 1 FROM reminders WHERE paused = 0 AND next_fire_at IS NOT NULL AND next_fire_at <= ?', now),
    exists(`SELECT 1 FROM firings WHERE state = 'nagging'
      AND ((next_nag_at IS NOT NULL AND next_nag_at <= ?) OR fired_at <= ?)`, now, now - EXPIRE_AFTER_MS),
    exists('SELECT 1 FROM drafts WHERE created_at < ? UNION ALL SELECT 1 FROM trash WHERE created_at < ?',
      now - 86400000, now - 86400000),
    exists(`SELECT 1 FROM sent_messages s WHERE s.delete_after <= ?
      AND NOT EXISTS (SELECT 1 FROM firings f WHERE f.state = 'nagging'
        AND f.chat_id = s.chat_id AND f.last_message_id = s.message_id
        AND f.last_message_ephemeral = s.is_ephemeral)`, now),
    env.DB.prepare('SELECT chat_id FROM settings WHERE paused_until > ?').bind(now),
    env.DB.prepare('SELECT chat_id, tz FROM settings'),
    ...recoveryStatements(env, now),
  ]);
  const yes = (r) => Boolean(r.results && r.results[0] && r.results[0].due);
  const known = new Set();
  for (const row of chats.results || []) {
    primeTz(env, row.chat_id, row.tz);
    known.add(row.chat_id);
  }
  for (const id of String(env.ALLOWED_CHATS || '').split(',').map((x) => x.trim()).filter(Boolean)) {
    if (Number.isSafeInteger(Number(id))) known.add(Number(id));
  }
  return {
    wake: yes(wake), fire: yes(fire), renag: yes(renag), drafts: yes(drafts), sweep: yes(sweep),
    // Disjoint from the chats the wake step ends: those are paused_until <= now.
    paused: new Set((paused.results || []).map((r) => r.chat_id)),
    chats: [...known],
    inbox: [pending, interrupted],
  };
}

export async function runCron(env) {
  const now = Date.now();
  // The pinned board is redrawn once per chat (deferBoards), straight after
  // the nags: the household hears first, the board catches up, and the
  // housekeeping follows.
  const tick = deferBoards(env);
  let due;
  try {
    due = await dueThisTick(env, now);
  } catch (e) {
    // Without the answer, every step looks for itself, as it always could.
    console.log(`cron due check failed: ${e.stack || e}`);
    due = { wake: true, fire: true, renag: true, drafts: true, sweep: true, inbox: null };
  }
  // Each step isolated: one failing must not starve the ones after it. The
  // wake goes first because paused_until is all that keeps the fire step off
  // a holiday's backlog until wakeChat has rolled it.
  const steps = {
    wake: () => due.wake && wakeLapsedPauses(tick, now),
    // These two read the paused chats again themselves, and only when
    // something is due: a /pause all landing mid-tick must still stop the nags.
    fire: () => due.fire && fireDueReminders(tick, now),
    renag: () => due.renag && renagPending(tick, now),
    boards: () => flushBoards(tick),
    digests: () => sendDigests(tick, now, due.paused, due.chats),
    weekly: () => sendWeeklyRecap(tick, now, due.paused, due.chats),
    updates: () => recoverUpdates(env, now, due.inbox),
    // Abandoned time-choice prompts and /delete undo stashes expire after a day.
    drafts: () => due.drafts && pruneDraftsAndTrash(env, now),
    // Everything the bot said a day ago is tidied away; the pin stays.
    sweep: () => due.sweep && sweepSentMessages(env, now),
    retention: () => pruneOldFirings(env, now),
  };
  const took = [`due ${Date.now() - now}ms`];
  for (const [name, step] of Object.entries(steps)) {
    const started = Date.now();
    try {
      await step();
    } catch (e) {
      console.log(`cron step ${name} failed: ${e.stack || e}`);
    }
    took.push(`${name} ${Date.now() - started}ms`);
  }
  // A digest's board refresh, and the sweep records of anything sent since
  // the boards step.
  const started = Date.now();
  await flushBoards(tick);
  took.push(`late boards ${Date.now() - started}ms`);
  // A slow tick says where its time went, for `wrangler tail` and Workers
  // Logs; a normal one stays quiet.
  if (Date.now() - now > SLOW_TICK_MS) console.log(`slow cron tick ${Date.now() - now}ms: ${took.join(', ')}`);
}

const SLOW_TICK_MS = 3000;

// Deletes every recorded bot message whose day is up, each through the method
// its kind requires. A message someone already dismissed with OK just makes
// Telegram refuse the delete — same outcome, so the row goes either way.
//
// A nag card is recorded with the ordinary day, but two things keep its
// firing live past that: a pause (which stops the expiry clock) and a
// postponement. Sweeping the card then left the board saying "nagging now"
// with nothing to tap. So a card that is still some nagging firing's current message is skipped — and
// its row keeps coming due, so the moment the firing ends or re-nags, the
// card goes with the next pass. Both id spaces are matched, as everywhere.
// Six deletes at a time, and the rows dropped in one statement after.
const SWEEP_PARALLEL = 6;

async function sweepSentMessages(env, now) {
  const { results } = await env.DB.prepare(
    `SELECT s.* FROM sent_messages s WHERE s.delete_after <= ?
       AND NOT EXISTS (SELECT 1 FROM firings f WHERE f.state = 'nagging'
         AND f.chat_id = s.chat_id AND f.last_message_id = s.message_id
         AND f.last_message_ephemeral = s.is_ephemeral)
     ORDER BY s.delete_after LIMIT 100`
  ).bind(now).all();
  const swept = [];
  for (let i = 0; i < results.length; i += SWEEP_PARALLEL) {
    await Promise.all(results.slice(i, i + SWEEP_PARALLEL).map(async (row) => {
      try {
        if (row.is_ephemeral) {
          // deleteEphemeral only reads chatId/userId off the ctx.
          await deleteEphemeral(env, { chatId: row.chat_id, userId: row.receiver_user_id }, row.message_id);
        } else {
          await deleteMessage(env, row.chat_id, row.message_id);
        }
        swept.push(row.id);
      } catch (e) {
        console.log(`sweep of sent message ${row.id} failed: ${e.stack || e}`);
      }
    }));
  }
  if (swept.length) {
    await env.DB.prepare(`DELETE FROM sent_messages WHERE id IN (${swept.map(() => '?').join(',')})`)
      .bind(...swept).run();
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
        `⌛ Time picker expired for <s>${esc(draft.text)}</s>. Send ${draft.scored === 0 ? '/remind' : '/chore'} to start again.`,
        { inline_keyboard: [] });
    }
    if (draft.prompt_msg_id && !draft.prompt_msg_ephemeral) {
      await deleteMessage(env, draft.chat_id, draft.prompt_msg_id);
    }
  }
  await env.DB.batch([
    env.DB.prepare('DELETE FROM drafts WHERE created_at < ?').bind(cutoff),
    env.DB.prepare('DELETE FROM trash WHERE created_at < ?').bind(cutoff),
  ]);
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

// Every chat the bot keeps settings for, and every allowed one (dueThisTick
// reads the same list in its batch).
async function cronChats(env) {
  const { results } = await env.DB.prepare('SELECT chat_id FROM settings').all();
  const chats = new Set((results || []).map((r) => r.chat_id));
  for (const id of String(env.ALLOWED_CHATS || '').split(',').map((x) => x.trim()).filter(Boolean)) {
    if (Number.isSafeInteger(Number(id))) chats.add(Number(id));
  }
  return [...chats];
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
// The webhook inbox's week-old rows go in the same window: they used to be
// deleted every minute, a write on every idle tick.
async function pruneOldFirings(env, now) {
  const d = new Date(now);
  if (d.getUTCHours() !== 3 || d.getUTCMinutes() >= RETENTION_WINDOW_MIN) return;
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM firings WHERE state IN ('done', 'expired') AND fired_at < ?"
    ).bind(now - 183 * 86400000),
    pruneOldUpdatesStatement(env, now),
  ]);
}

// Sunday 8pm local: the cats crown the week's winner before Monday's reset.
async function sendWeeklyRecap(env, now, paused = null, chats = null) {
  paused ??= await pausedChats(env, now);
  chats ??= await cronChats(env);
  for (const chat_id of chats) {
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
        const top = s.people.filter(([, items]) => items.length === winnerItems.length);
        const tie = top.length > 1;
        const streak = tie ? 0 : await winnerStreak(env, chat_id, tz, winner);
        lines.push(tie
          ? `It's a tie between ${top.map(([who]) => esc(who)).join(' and ')} at ${winnerItems.length} ✅ each — the cats demand a tiebreaker chore.`
          : `🥇 ${esc(winner)} takes the week with ${winnerItems.length} ✅!` +
            (streak >= 1 ? ` 🔥 ${streak + 1} weeks running!` : ''));
        for (const [who, items] of s.people.slice(top.length)) lines.push(`• ${esc(who)}: ${items.length} ✅`);
      }
      if (s.expired) lines.push(`🪦 ${s.expired} expired unclaimed. The cats saw everything.`);
      lines.push('Scores reset Monday. /stats anytime.');
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
    const lines = ['☀️ All caught up. The cats approve 😻'];
    for (const r of undone) lines.push(`😻 <s>${esc(r.text)}</s> — done by ${esc(r.done_by || 'someone')}`);
    return { html: lines.join('\n'), markup: { inline_keyboard: buttons } };
  }
  const who = (r) => r.assignee_name ? ` (${mentionHtml(r.assignee_name, r.assignee_user_id)})` : '';
  const lines = ['☀️ Mrow. Still waiting on:'];
  for (const r of nagging) lines.push(`• <b>${esc(r.text)}</b>${who(r)}`);
  for (const r of undone) lines.push(`😻 <s>${esc(r.text)}</s> — done by ${esc(r.done_by || 'someone')}`);
  const rows2 = nagging.slice(0, DIGEST_BUTTONS).map((r) => [{ text: `✅ Done · ${label(r.text)}`, callback_data: `dg:${r.id}` }]);
  if (nagging.length > DIGEST_BUTTONS) lines.push('<i>The rest can be finished from the pinned board.</i>');
  return { html: lines.join('\n'), markup: { inline_keyboard: [...rows2, ...buttons] } };
}

// 8am local: one summary of the day's chores per chat. Skipped when there is
// nothing due today and nothing still nagging.
export async function sendDigests(env, now, paused = null, chats = null) {
  paused ??= await pausedChats(env, now);
  chats ??= await cronChats(env);
  for (const chat_id of chats) {
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
      // held its expiry back to 08:00, and the renag step tombstones it at
      // 08:00 too — so the digest used to hand out a ✅ for a chore that was
      // already gone by the time anyone read it. The tombstone says what
      // happened to it. An overdue one-off
      // stays: it is never expired, and Done here still counts.
      //
      // Nor is a chore the household parked "hanging": one postponed with
      // 📅 Tomorrow (fired_at ahead of now) or snoozed to a time still to
      // come (isHouseholdDeferred, in SQL) is due when they said, not this
      // morning — listing it with a ✅ under the thumb is how a chore that
      // was not even due got marked done by mistake.
      const nagging = await env.DB.prepare(
        `SELECT f.id FROM firings f JOIN reminders r ON r.id = f.reminder_id
         WHERE f.chat_id = ? AND f.state = 'nagging' AND r.paused = 0
           AND (r.schedule_kind = 'once' OR f.fired_at > ?)
           AND f.fired_at < ?
           AND NOT (f.snoozed_until IS NOT NULL AND f.next_nag_at IS NOT NULL
                    AND f.next_nag_at = f.snoozed_until AND f.next_nag_at > ?)`
      ).bind(chat_id, now - EXPIRE_AFTER_MS, now, now).all();
      if (!nagging.results.length) continue;
      const view = await digestView(env, chat_id, nagging.results.map((f) => f.id));
      await sendMessage(env, chat_id, view.html, view.markup, { silent: true });
    } catch (e) {
      console.log(`digest for chat ${chat_id} failed: ${e.stack || e}`);
    }
  }
}

async function fireDueReminders(env, now, paused = null) {
  const [due, pausedRows] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM reminders WHERE paused = 0 AND next_fire_at IS NOT NULL AND next_fire_at <= ?').bind(now),
    env.DB.prepare('SELECT chat_id FROM settings WHERE paused_until > ?').bind(now),
  ]);
  const results = due.results || [];
  if (!results.length) return;

  paused ??= new Set((pausedRows.results || []).map((r) => r.chat_id));
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
//
// The due firings, their chores and the paused chats are one round trip; the
// chore used to be read again for every firing. Each re-nag is then its claim,
// the old card coming down while the new one goes up, and the new card's ids.
export async function renagPending(env, now, paused = null) {
  // Due re-nags, plus anything past the 24h deadline regardless of snoozes —
  // expiry must not wait for the next nag slot to come due.
  const due = "state = 'nagging' AND ((next_nag_at IS NOT NULL AND next_nag_at <= ?) OR fired_at <= ?)";
  const [firings, chores, pausedRows] = await env.DB.batch([
    env.DB.prepare(`SELECT * FROM firings WHERE ${due}`).bind(now, now - EXPIRE_AFTER_MS),
    env.DB.prepare(
      `SELECT r.* FROM reminders r WHERE r.id IN (SELECT f.reminder_id FROM firings f WHERE f.state = 'nagging'
         AND ((f.next_nag_at IS NOT NULL AND f.next_nag_at <= ?) OR f.fired_at <= ?))`
    ).bind(now, now - EXPIRE_AFTER_MS),
    env.DB.prepare('SELECT chat_id FROM settings WHERE paused_until > ?').bind(now),
  ]);
  const results = firings.results || [];
  if (!results.length) return;
  const byId = new Map((chores.results || []).map((r) => [r.id, r]));

  paused ??= new Set((pausedRows.results || []).map((r) => r.chat_id));
  for (const f of results) {
    try {
      if (paused.has(f.chat_id)) continue; // vacation freezes nags and expiry
      const r = byId.get(f.reminder_id) || null;
      if (!r) {
        // Same conditional claim as expireFiring, for the same reason: this
        // tick's fired_at is a snapshot, and a resume may have moved it. The
        // winner also takes the card down — it kept live buttons for a chore
        // that no longer existed until the sweep reached it a day later.
        const claim = await env.DB.prepare(
          "UPDATE firings SET state = 'expired', next_nag_at = NULL WHERE id = ? AND state = 'nagging' AND fired_at = ?"
        ).bind(f.id, f.fired_at).run();
        if (claim.meta.changes) {
          await Promise.all([
            f.last_message_id ? deleteNag(env, f) : null,
            f.last_sticker_id ? deleteMessage(env, nagChat(f), f.last_sticker_id) : null,
          ]);
        }
        continue;
      }
      // /pause freezes in-flight nags too (no re-nags, no expiry ticking).
      if (r.paused) continue;
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

      // A one-off is never expired: past its 24h it keeps nagging hourly on
      // the ⏰ card until someone finishes or deletes it. (Until 20 Oct 2026 it
      // went quiet instead, parked with next_nag_at NULL — such a row is
      // simply due, and picks the hourly nag back up.)
      const once = r.schedule_kind === 'once';
      const overdue = isOverdue(f, now);
      if (overdue && !once) {
        await expireFiring(env, f, r);
        continue;
      }
      // Row was selected by the expiry clause only; its next nag isn't due yet.
      if (f.next_nag_at == null ? !once : f.next_nag_at > now) continue;

      const intervals = JSON.parse(r.nag_intervals);
      const nagCount = f.nag_count + 1;
      // Never below a minute: a row poisoned with [null] or [0] (the editor
      // once stored any value it was handed) re-nagged every tick forever.
      const interval = overdue ? OVERDUE_NAG_MIN
        : Math.max(1, Number(intervals[Math.min(nagCount, intervals.length - 1)]) || 15);
      // Claim this re-nag before any sends: an overlapping cron tick loses the
      // compare-and-swap, and a Done/snooze landing mid-send isn't clobbered.
      // The chore was read at the top of the tick, so the claim also checks it
      // is still unpaused: a /pause landing since must not be answered with a
      // fresh nag.
      const claim = await env.DB.prepare(
        `UPDATE firings SET nag_count = ?, next_nag_at = ? WHERE id = ? AND state = 'nagging' AND next_nag_at IS ?
           AND EXISTS (SELECT 1 FROM reminders WHERE id = firings.reminder_id AND paused = 0)`
      ).bind(nagCount, deferQuietHours(now + interval * 60000, tz), f.id, f.next_nag_at).run();
      if (!claim.meta.changes) continue;

      // One live nag per chore: the previous nag and its sticker come down
      // while the new one goes out. Re-nags follow the first nag's home.
      // Loudness ladder: first re-nag is silent; later ones notify again.
      // sendNag keeps an assigned chore's re-nag as private as its first nag.
      const [ref] = await Promise.all([
        sendNag(env, f,
          overdue ? overdueHtml(r, f.fired_at, tz) : nagHtml(r, nagCount, f.cat || 'both'),
          nagButtons(f.id, isScored(f)), { silent: nagCount === 1 }),
        f.last_message_id ? deleteNag(env, f) : null,
        f.last_sticker_id ? deleteMessage(env, nagChat(f), f.last_sticker_id) : null,
      ]);
      // Bound to the message id this tick read as well as the state: a /poke
      // re-sending in the same second is the other writer, and two
      // unconditional writes left one of the two cards untracked with live
      // buttons that nothing would ever clean up.
      const upd = await env.DB.prepare(
        `UPDATE firings SET last_message_id = ?, last_message_ephemeral = ?, last_sticker_id = NULL
          WHERE id = ? AND state = 'nagging' AND last_message_id IS ? AND nag_user_id IS ?`
      ).bind(ref ? ref.id : null, ref && ref.ephemeral ? 1 : 0, f.id, f.last_message_id,
        f.nag_user_id ?? null).run();
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
