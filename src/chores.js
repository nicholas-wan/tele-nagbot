// Chore actions shared by typed commands, dashboard buttons, and the cron:
// create, find, delete, pause/resume, complete-early, and vacation wake-up.

import { sendMessage, sendPrivate, deleteMessage, esc, mentionHtml, RECEIPT_TTL_MS } from './tg.js';
import { nextOccurrence, fmtLocal } from './time.js';
import { ParseError } from './parse.js';
import { isScored } from './household.js';
import { deleteNag, nagChat, showPausedCard, editNag, nagHtml, nagButtons, completeFiring } from './nag.js';
import { updateDashboard, describeSchedule } from './dashboard.js';
import { fireReminder } from './firing.js';

// Undo removes the chore that was just made; OK just clears the confirmation.
export function undoButtons(reminderId) {
  return { inline_keyboard: [[
    { text: '↩️ Undo', callback_data: `u:${reminderId}` },
    { text: '✅ OK', callback_data: 'ok' },
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
  const buttons = undoButtons(id);
  if (p.assigneeName || p.assigneeUserId) return sendPrivate(env, ctx, html, buttons);
  return sendMessage(env, ctx.chatId,
    `📝 ${esc(by)} added <b>${esc(p.text)}</b> — ${fmtLocal(p.firstFireAt, tz)}`, buttons);
}

// "now" reminders fire on the spot instead of waiting for the next cron tick.
export async function fireIfDue(env, id, tz) {
  const row = await env.DB.prepare('SELECT * FROM reminders WHERE id = ?').bind(id).first();
  if (row && row.next_fire_at != null && row.next_fire_at <= Date.now() + 500) {
    await fireReminder(env, row, Date.now(), tz);
  }
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

export async function setReminderPaused(env, r, pause, tz, by) {
  let next = r.next_fire_at;
  if (!pause) next = nextOccurrence(r.schedule_kind, JSON.parse(r.schedule_detail), Date.now(), tz) || next;
  await env.DB.prepare('UPDATE reminders SET paused = ?, next_fire_at = ? WHERE id = ?')
    .bind(pause ? 1 : 0, next, r.id).run();
  const firing = await env.DB.prepare(
    "SELECT * FROM firings WHERE reminder_id = ? AND state = 'nagging' ORDER BY id DESC LIMIT 1"
  ).bind(r.id).first();
  if (firing) {
    if (pause) {
      await showPausedCard(env, firing, r, by, tz);
    } else if (firing.last_message_id) {
      await editNag(env, firing,
        nagHtml(r, firing.nag_count, firing.cat || 'both'), nagButtons(firing.id, isScored(firing)));
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
  // Claim the upcoming occurrence with the usual compare-and-swap. Recurring
  // chores advance past the claimed slot (the /skip rule); a one-off is spent
  // outright, so its conditional delete is the claim.
  const claim = r.schedule_kind === 'once'
    ? await env.DB.prepare('DELETE FROM reminders WHERE id = ? AND next_fire_at = ?')
        .bind(r.id, r.next_fire_at).run()
    : await env.DB.prepare('UPDATE reminders SET next_fire_at = ? WHERE id = ? AND next_fire_at = ?')
        .bind(nextOccurrence(r.schedule_kind, JSON.parse(r.schedule_detail), r.next_fire_at, tz),
          r.id, r.next_fire_at).run();
  if (!claim.meta.changes) {
    // The occurrence fired while we looked — complete its live nag instead.
    const firing = await env.DB.prepare(
      "SELECT * FROM firings WHERE reminder_id = ? AND state = 'nagging' ORDER BY id DESC LIMIT 1"
    ).bind(r.id).first();
    return Boolean(firing && await completeFiring(env, firing, r, credit, tz));
  }
  await env.DB.prepare(
    `INSERT INTO firings (reminder_id, chat_id, reminder_text, fired_at, state, done_by, done_at, scored)
     VALUES (?, ?, ?, ?, 'done', ?, ?, ?)`
  ).bind(r.id, r.chat_id, r.text, now, credit, now, r.scored != null ? r.scored : 1).run();
  // The receipt is the shared record — there is no nag message to edit.
  const next = r.schedule_kind === 'once' ? null
    : await env.DB.prepare('SELECT next_fire_at FROM reminders WHERE id = ?').bind(r.id).first();
  await sendMessage(env, r.chat_id,
    `😻 <s>${esc(r.text)}</s> — done early by ${esc(credit)}. The cats are impressed.` +
    (next && next.next_fire_at ? `\nNext: ${fmtLocal(next.next_fire_at, tz)}` : ''),
    null, { silent: true, ttl: RECEIPT_TTL_MS });
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
    const next = nextOccurrence(r.schedule_kind, JSON.parse(r.schedule_detail), now, tz);
    await env.DB.prepare('UPDATE reminders SET next_fire_at = ? WHERE id = ?').bind(next, r.id).run();
  }
  await updateDashboard(env, chatId);
  await sendMessage(env, chatId, '😺 The cats are back on duty — chores resume. /list to see what\'s up.');
}
