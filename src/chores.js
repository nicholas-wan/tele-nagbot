// Chore actions shared by typed commands, dashboard buttons, and the cron:
// create, find, delete, pause/resume, complete-early, and vacation wake-up.

import { sendMessage, sendPrivate, deleteMessage, esc, mentionHtml, okButton, messageIsGone,
         RECEIPT_TTL_MS } from './tg.js';
import { nextOccurrence, advanceOccurrence, deferQuietHours, fmtLocal } from './time.js';
import { ParseError } from './parse.js';
import { isScored, CREDIT_SEP } from './household.js';
import { deleteNag, nagChat, showPausedCard, editNag, sendNag, deleteNagRef, nagHtml, nagButtons,
         snoozedHtml, snoozedButtons, completeFiring, isHouseholdDeferred } from './nag.js';
import { updateDashboard, describeSchedule } from './dashboard.js';
import { fireReminder } from './firing.js';

// Undo removes the chore that was just made; OK clears the confirmation — and
// the command it was typed in, which is kept on show until then so a misread
// chore can be compared against what was actually typed, and copied back.
// Undo deliberately leaves the command standing: that is the case where the
// parse was wrong and the text is about to be needed again.
export function undoButtons(reminderId, sourceMsgId = null) {
  return { inline_keyboard: [[
    { text: '↩️ Undo', callback_data: `u:${reminderId}` },
    okButton(sourceMsgId),
  ]] };
}

// Chores are addressed by name ("/done nails"); bare numbers still work as
// the legacy handles.
export async function findReminder(env, chatId, args, cmd = 'delete') {
  const raw = String(args).replace('#', '').trim();
  if (!raw) throw new ParseError(`Which chore? e.g. /${cmd} nails (see /list).`);
  const { results } = await env.DB.prepare('SELECT * FROM reminders WHERE chat_id = ?').bind(chatId).all();
  // Only an argument that is nothing but a number is a legacy handle — a name
  // that merely starts with digits ("10pm meds") must reach the name match.
  if (/^\d+$/.test(raw)) {
    const num = parseInt(raw, 10);
    const r = results.find((x) => x.display_num === num);
    if (r) return r;
    throw new ParseError(`No reminder ${num} here. See /list.`);
  }
  const q = raw.toLowerCase();
  const matches = results.filter((x) => x.text.toLowerCase().includes(q));
  if (matches.length === 1) return matches[0];
  if (!matches.length) throw new ParseError(`The cats can't find a chore matching "${raw}". See /list.`);
  throw new ParseError(`"${raw}" matches: ${matches.map((x) => x.text).join(', ')} — be more specific.`);
}

export async function createReminder(env, chatId, p, by, tz) {
  // Smallest unused per-chat number, so numbering starts at 1 and fills gaps.
  const { results } = await env.DB.prepare(
    'SELECT display_num FROM reminders WHERE chat_id = ?'
  ).bind(chatId).all();
  const used = new Set(results.map((r) => r.display_num));
  let num = 1;
  while (used.has(num)) num++;

  const res = await env.DB.prepare(
    `INSERT INTO reminders (chat_id, display_num, text, assignee_name, assignee_user_id, schedule_kind,
       schedule_detail, next_fire_at, nag_intervals, created_by, created_at, scored)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    chatId, num, p.text, p.assigneeName, p.assigneeUserId, p.kind,
    JSON.stringify(p.detail), p.firstFireAt, JSON.stringify(p.nagIntervals), by, Date.now(),
    p.scored != null ? (p.scored ? 1 : 0) : 1
  ).run();
  const id = res.meta.last_row_id;
  await updateDashboard(env, chatId);
  const forWho = p.assigneeName ? ` for ${mentionHtml(p.assigneeName, p.assigneeUserId)}` : '';
  const html = `📝 <b>${esc(p.text)}</b>${forWho}\nFirst reminder: ${fmtLocal(p.firstFireAt, tz)}` +
    (p.kind !== 'once' ? ` (${describeSchedule({ schedule_kind: p.kind, schedule_detail: JSON.stringify(p.detail) })})` : '');
  return { id, html };
}

// Exactly one confirmation per new chore, never two saying the same thing.
//
// An unassigned chore is the household's problem, so the public line is the
// confirmation and carries the Undo. An assigned one is deliberately not
// announced — that would hand the group what its private nag hides — so the
// creator's own private copy is the only one. Either way the pinned dashboard
// lists it, so nothing is lost by keeping this to a single message.
export async function confirmNewChore(env, ctx, by, p, tz, id, html) {
  const buttons = undoButtons(id, p.sourceMsgId);
  if (p.assigneeName || p.assigneeUserId) return sendPrivate(env, ctx, html, buttons);
  return sendMessage(env, ctx.chatId,
    `📝 ${esc(by)} added <b>${esc(p.text)}</b> — ${fmtLocal(p.firstFireAt, tz)}`, buttons);
}

// "now" reminders fire on the spot instead of waiting for the next cron tick.
export async function fireIfDue(env, id, tz) {
  const row = await env.DB.prepare('SELECT * FROM reminders WHERE id = ?').bind(id).first();
  if (!row || row.next_fire_at == null || row.next_fire_at > Date.now() + 500) return;
  // Vacation mode is a household-wide "not now", and this is the one fire path
  // that doesn't go through the cron loop's paused-chat filter. Without the
  // check a chore added during /pause all nagged once on the spot and wakeChat
  // then deleted the nag — a reminder that shouted and vanished. Leaving
  // next_fire_at alone means the wake rolls it and the cron picks it up.
  if (await chatPaused(env, row.chat_id)) return;
  await fireReminder(env, row, Date.now(), tz);
}

// Vacation mode: the whole household said "not now". Exported because three
// other paths need exactly this predicate and a fourth copy of it would be the
// one that drifts.
export async function chatPaused(env, chatId) {
  const st = await env.DB.prepare('SELECT paused_until FROM settings WHERE chat_id = ?')
    .bind(chatId).first();
  return Boolean(st && st.paused_until && st.paused_until > Date.now());
}

// `by` names the person in the log line. A deletion removes the chore for
// everyone, so when it is triggered from a nag the log goes to the group even
// though the nag itself may have been private — both of you need to see it.
export async function deleteReminder(env, r, ctx = null, by = null) {
  const chatId = r.chat_id;
  // Like Undo: remove live nag messages and hard-delete the nagging firings,
  // so an intentional delete never counts as "expired unclaimed" in stats.
  const firings = await env.DB.prepare(
    "SELECT * FROM firings WHERE reminder_id = ? AND state = 'nagging'"
  ).bind(r.id).all();
  for (const f of firings.results) {
    if (f.last_message_id) await deleteNag(env, f);
    if (f.last_sticker_id) await deleteMessage(env, nagChat(f), f.last_sticker_id);
  }
  await env.DB.prepare("DELETE FROM firings WHERE reminder_id = ? AND state = 'nagging'").bind(r.id).run();
  await env.DB.prepare('DELETE FROM reminders WHERE id = ?').bind(r.id).run();
  // Stash the row for a day so the Undo button can bring it back.
  const stash = await env.DB.prepare(
    'INSERT INTO trash (chat_id, payload, created_at) VALUES (?, ?, ?)'
  ).bind(chatId, JSON.stringify(r), Date.now()).run();
  // OK dismisses the log once everyone has seen it; Undo restores the chore.
  const undo = { inline_keyboard: [[
    { text: '↩️ Undo', callback_data: `t:${stash.meta.last_row_id}` },
    { text: '✅ OK', callback_data: 'ok' },
  ]] };
  const html = by
    ? `🗑️ ${esc(by)} deleted <s>${esc(r.text)}</s>`
    : `🗑️ Deleted <s>${esc(r.text)}</s>`;
  if (ctx) await sendPrivate(env, ctx, html, undo);
  else await sendMessage(env, chatId, html, undo);
  await updateDashboard(env, chatId);
}

// Where a resumed chore's schedule lands. A pause must not cost the chore its
// place in the queue: an "every 8 days" chore that was due tomorrow is still
// due tomorrow. Only a slot that went by during the pause is recomputed, and
// an interval is advanced from its own anchor so the pause never shifts the
// date it has always fired on.
function resumeNextFire(r, now, tz) {
  if (r.next_fire_at != null && r.next_fire_at > now) return r.next_fire_at;
  // Nothing to advance from: a one-off is spent, and a null anchor handed to
  // an interval would count its gaps from 1970.
  if (r.schedule_kind === 'once' || r.next_fire_at == null) return r.next_fire_at;
  const next = advanceOccurrence(
    r.schedule_kind, JSON.parse(r.schedule_detail), r.next_fire_at, now, tz
  );
  return next != null ? next : r.next_fire_at;
}

// A pause freezes an in-flight nag, but fired_at kept ticking underneath it:
// pause a nagging chore for a day and the first tick after resume expired it
// with a public tombstone and a scored failure, for time nobody was asked to
// act in. Resuming hands each live nag a fresh 24h window, and a next_nag_at in
// the future — otherwise the cron would delete and re-send the card the very
// next minute, right after resume restored its buttons.
//
// What resume must not do is overwrite a time somebody chose. A firing snoozed
// into the future, or postponed with 📅 Tomorrow (which carries fired_at
// forward), already says when the household wants to hear about it; a resume
// that restamped those dragged a chore parked until tomorrow back to right now.
// Each restamp binds the pair it read, so a Done, a snooze, or a re-nag landing
// mid-resume simply wins.
//
// A *future* next_nag_at is not by itself a choice, though. The cron pushes one
// to 08:00 whenever a re-nag comes due in quiet hours, and an ordinary pending
// re-nag is always ahead of now — both are the bot's own scheduling. Nor is
// snoozes_used: it is a cap, and stayed set after a snooze had elapsed and the
// cron had pushed the next nag past the expiry, so a chore the household had
// just resumed was tombstoned hours later on that stale clock. What tells them
// apart is isHouseholdDeferred: the snooze's own time, still in force.
//
// Returns a Map of firing id → whether it was restamped, so the caller can tell
// a revived nag from one that kept the household's own deferral.
async function restampLiveNags(env, r, now, tz) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM firings WHERE reminder_id = ? AND state = 'nagging'"
  ).bind(r.id).all();
  const intervals = JSON.parse(r.nag_intervals);
  const nextNag = deferQuietHours(now + intervals[0] * 60000, tz);
  const restamped = new Map();
  for (const f of results || []) {
    if (isHouseholdDeferred(f, now)) {
      restamped.set(f.id, false);
      continue;
    }
    await env.DB.prepare(
      `UPDATE firings SET fired_at = ?, next_nag_at = ?, snoozed_until = NULL
       WHERE id = ? AND state = 'nagging' AND fired_at = ? AND next_nag_at IS ?`
    ).bind(now, nextNag, f.id, f.fired_at, f.next_nag_at != null ? f.next_nag_at : null).run();
    restamped.set(f.id, true);
  }
  return restamped;
}

// Put a resumed firing's card back on screen. Normally an edit of the card
// that has been sitting there reading "⏸️ Paused"; but a card recorded before
// the sweep learned to spare live nags was deleted a day into the pause, and
// an edit of a deleted message leaves the board saying "nagging now" with
// nothing to tap until the next re-nag — or 08:00, if the resume landed in
// quiet hours. Only a message Telegram says is gone earns a replacement.
async function redrawResumedNag(env, firing, html, markup) {
  const res = await editNag(env, firing, html, markup);
  if (res.ok || String(res.description || '').includes('not modified')) return;
  if (!messageIsGone(res.description)) return;
  const ref = await sendNag(env, firing, html, markup, { silent: true });
  const upd = await env.DB.prepare(
    `UPDATE firings SET last_message_id = ?, last_message_ephemeral = ?
     WHERE id = ? AND state = 'nagging' AND last_message_id = ?`
  ).bind(ref ? ref.id : null, ref && ref.ephemeral ? 1 : 0, firing.id, firing.last_message_id).run();
  if (!upd.meta.changes && ref) await deleteNagRef(env, firing, ref);
}

export async function setReminderPaused(env, r, pause, tz, by) {
  const now = Date.now();
  // Resuming what was never paused is not an event. /resume does not check
  // first, so a stray one used to restamp every live nag — handing a chore
  // that had been nagging since morning a fresh 24 hours and pushing its next
  // nag away — and to recompute a schedule nobody had frozen.
  if (!pause && !r.paused) return { firing: null, next: r.next_fire_at };
  let next = r.next_fire_at;
  let restamped = null;
  // Firings first: paused = 0 is what re-arms the cron, so a tick that sees it
  // must already be looking at the restamped clock.
  if (!pause) {
    next = resumeNextFire(r, now, tz);
    restamped = await restampLiveNags(env, r, now, tz);
  }
  await env.DB.prepare('UPDATE reminders SET paused = ?, next_fire_at = ? WHERE id = ?')
    .bind(pause ? 1 : 0, next, r.id).run();
  const firing = await env.DB.prepare(
    "SELECT * FROM firings WHERE reminder_id = ? AND state = 'nagging' ORDER BY id DESC LIMIT 1"
  ).bind(r.id).first();
  if (firing) {
    if (pause) {
      await showPausedCard(env, firing, r, by, tz);
    } else if (firing.last_message_id) {
      // A firing whose deferral survived the resume must not come back wearing a
      // plain nag: that would claim the chore is due now, and the ↩️ Back handler
      // (which reads the card's own text) would then hand it the wrong keyboard.
      // Redraw the snooze notice it still is.
      if (restamped && restamped.get(firing.id) === false) {
        await redrawResumedNag(env, firing,
          snoozedHtml(r, firing.next_nag_at, by, tz), snoozedButtons(firing.id, isScored(firing)));
      } else {
        await redrawResumedNag(env, firing,
          nagHtml(r, firing.nag_count, firing.cat || 'both'), nagButtons(firing.id, isScored(firing)));
      }
    }
  }
  await updateDashboard(env, r.chat_id);
  return { firing, next };
}

// Doing a chore before it nags still deserves the credit: complete the
// upcoming occurrence now and advance the schedule past it, so the diligent
// never have to wait for the nag just to tap Done. Returns false when a race
// got there first and nothing else could be completed.
export async function completeEarly(env, r, credit, tz) {
  const now = Date.now();
  const detail = JSON.parse(r.schedule_detail);
  // Day intervals describe the gap between completed chores. When one is done
  // early, restart that gap from today; advancing from the skipped due slot
  // would make an every-two-weeks chore due more than two weeks after the work
  // was actually done. Calendar schedules still advance past their claimed
  // slot, and a one-off is spent outright.
  const nextFireAt = r.schedule_kind === 'interval' && detail.days
    ? nextOccurrence(r.schedule_kind, detail, now, tz)
    : nextOccurrence(r.schedule_kind, detail, r.next_fire_at, tz);
  const claim = r.schedule_kind === 'once'
    ? await env.DB.prepare('DELETE FROM reminders WHERE id = ? AND next_fire_at = ?')
        .bind(r.id, r.next_fire_at).run()
    : await env.DB.prepare('UPDATE reminders SET next_fire_at = ? WHERE id = ? AND next_fire_at = ?')
        .bind(nextFireAt, r.id, r.next_fire_at).run();
  if (!claim.meta.changes) {
    // The occurrence fired while we looked — complete its live nag instead.
    const firing = await env.DB.prepare(
      "SELECT * FROM firings WHERE reminder_id = ? AND state = 'nagging' ORDER BY id DESC LIMIT 1"
    ).bind(r.id).first();
    return Boolean(firing && await completeFiring(env, firing, r, credit, tz));
  }
  const ins = await env.DB.prepare(
    `INSERT INTO firings (reminder_id, chat_id, reminder_text, fired_at, state, done_by, done_at, scored)
     VALUES (?, ?, ?, ?, 'done', ?, ?, ?)`
  ).bind(r.id, r.chat_id, r.text, now, credit, now, r.scored != null ? r.scored : 1).run();
  // The receipt is the shared record — there is no nag message to edit. A solo
  // credit carries a fix-up button, because tapping Done early when the work
  // was actually shared shouldn't need an admin to repair.
  const next = r.schedule_kind === 'once' ? null
    : await env.DB.prepare('SELECT next_fire_at FROM reminders WHERE id = ?').bind(r.id).first();
  const markup = credit.includes(CREDIT_SEP) ? null : { inline_keyboard: [[
    { text: '🤝 Together too', callback_data: `g:${ins.meta.last_row_id}` },
    { text: '✅ OK', callback_data: 'ok' },
  ]] };
  await sendMessage(env, r.chat_id,
    `😻 <s>${esc(r.text)}</s> — done early by ${esc(credit)}. The cats are impressed.` +
    (next && next.next_fire_at ? `\nNext: ${fmtLocal(next.next_fire_at, tz)}` : ''),
    markup, { silent: true, ttl: RECEIPT_TTL_MS });
  await updateDashboard(env, r.chat_id);
  return true;
}

// Ends vacation mode: clears the flag, removes stale pre-vacation nags (and
// their spent one-off reminders), rolls recurring schedules past the gap.
export async function wakeChat(env, chatId, tz) {
  const now = Date.now();
  await env.DB.prepare('UPDATE settings SET paused_until = NULL WHERE chat_id = ?').bind(chatId).run();
  const firings = await env.DB.prepare(
    "SELECT * FROM firings WHERE chat_id = ? AND state = 'nagging'"
  ).bind(chatId).all();
  for (const f of firings.results) {
    if (f.last_message_id) await deleteNag(env, f);
    if (f.last_sticker_id) await deleteMessage(env, nagChat(f), f.last_sticker_id);
    await env.DB.prepare('DELETE FROM firings WHERE id = ?').bind(f.id).run();
    const r = await env.DB.prepare('SELECT * FROM reminders WHERE id = ?').bind(f.reminder_id).first();
    if (r && r.schedule_kind === 'once' && r.next_fire_at == null) {
      await env.DB.prepare('DELETE FROM reminders WHERE id = ?').bind(r.id).run();
    }
  }
  const rems = await env.DB.prepare(
    "SELECT * FROM reminders WHERE chat_id = ? AND schedule_kind != 'once' AND next_fire_at IS NOT NULL AND next_fire_at <= ?"
  ).bind(chatId, now).all();
  for (const r of rems.results) {
    // Intervals roll from their own anchor, never from the wake-up moment: the
    // gap counts from the date the chore was due, so a fortnight of vacation
    // doesn't quietly move an "every 8 days" chore onto a new day forever.
    // advanceOccurrence does that branch itself; every other kind ignores the
    // anchor, which is why a null one still has to be kept away from it.
    if (r.next_fire_at == null) continue;
    const next = advanceOccurrence(
      r.schedule_kind, JSON.parse(r.schedule_detail), r.next_fire_at, now, tz
    );
    await env.DB.prepare('UPDATE reminders SET next_fire_at = ? WHERE id = ?').bind(next, r.id).run();
  }
  await updateDashboard(env, chatId);
  await sendMessage(env, chatId, '😺 The cats are back on duty — chores resume. /list to see what\'s up.');
}
