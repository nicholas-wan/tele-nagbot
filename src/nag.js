// The nag message lifecycle: rendering, buttons, the public/ephemeral ref
// distinction, and the completion/expiry state transitions that end a firing.

import { sendMessage, deleteMessage, esc, mentionHtml, replyCtx, sendPrivate,
         editRef, deleteRef, msgRef, retimeSentMessage, RECEIPT_TTL_MS } from './tg.js';
import { nextOccurrence, fmtLocal, fmtClock, localParts } from './time.js';
import { sendCelebrationSticker } from './stickers.js';
import { isScored } from './household.js';
import { updateDashboard } from './dashboard.js';

export const MAX_SNOOZES = 3;
export const EXPIRE_AFTER_MS = 24 * 3600000;
// A one-off never expires: past its 24h it keeps nagging at this pace (quiet
// hours aside) until someone finishes or deletes it.
export const OVERDUE_NAG_MIN = 60;

export const emptyKeyboard = () => ({ inline_keyboard: [] });

export function nagButtons(firingId, scored = true) {
  return {
    inline_keyboard: [
      [
        { text: '✅ Done', callback_data: `d:${firingId}` },
        { text: '🤝 Done together', callback_data: `b:${firingId}` },
        { text: '😴 Snooze…', callback_data: `s:${firingId}` },
      ],
      [{ text: scored ? '🗑 Delete chore' : '🗑 Delete reminder', callback_data: `x:${firingId}` }],
    ],
  };
}

export function snoozedButtons(firingId, scored = true) {
  return { inline_keyboard: [
    [
      { text: '✅ Done', callback_data: `d:${firingId}` },
      { text: '🤝 Done together', callback_data: `b:${firingId}` },
      { text: '🕐 Change snooze', callback_data: `s:${firingId}` },
    ],
    [
      { text: scored ? '🗑 Delete chore' : '🗑 Delete reminder', callback_data: `x:${firingId}` },
      // Puts the 😴 card away while the chore stays parked (zh: in handlers).
      // It is still the firing's live card, so the daily sweep spares it — a
      // two-week postponement left it in the chat for two weeks with nothing
      // to dismiss it by. The nag comes back as a fresh card when it is due.
      { text: '✅ OK', callback_data: `zh:${firingId}` },
    ],
  ] };
}

// A Done can be a slip — the digest's ✅ sits right under the thumb — so every
// receipt can take itself back. Anyone in the household may, as anyone may
// tap Done; undoCompletion (chores.js) decides whether it is still possible.
export function receiptButtons(firingId) {
  return { inline_keyboard: [[
    { text: '↩️ Not done', callback_data: `nd:${firingId}` },
    { text: '✅ OK', callback_data: 'ok' },
  ]] };
}

// The card a live firing should be showing right now: the 😴 notice while a
// snooze or postponement is in force, the ⏰ card of a one-off past its 24h,
// else the nag.
// One place for the choice, so /poke, resume, the points toggle, ↩️ Back and
// an undone Done all draw the same thing. Rows snoozed before snoozed_by
// existed name the household.
export function firingCard(reminder, firing, tz, now = Date.now()) {
  if (isHouseholdDeferred(firing, now)) {
    return [snoozedHtml(reminder, firing.next_nag_at, firing.snoozed_by || 'the household', tz),
      snoozedButtons(firing.id, isScored(firing))];
  }
  if (isOverdue(firing, now)) return [overdueHtml(reminder), nagButtons(firing.id, isScored(firing))];
  return [nagHtml(reminder, firing.nag_count || 0, firing.cat || 'both'), nagButtons(firing.id, isScored(firing))];
}

// Keeps a reminder row for a day so a `t:` button, or an undone Done on a
// one-off, can bring it back. Returns the trash id.
//
// A stash made by a completion carries the firing it completed (`_firing`),
// and the undo looks for exactly that. Looking up the newest stash of the
// chore instead found a later deletion's: ↩️ Not done then brought a deleted
// chore back — a recurring one with nothing scheduled, for good — and took
// the stash the delete's own Undo needed. restoreReminder names its columns,
// so the marker never reaches a reminders row.
export async function stashReminder(env, r, firingId = null) {
  const payload = firingId ? { ...r, _firing: firingId } : r;
  const stash = await env.DB.prepare(
    'INSERT INTO trash (chat_id, payload, created_at) VALUES (?, ?, ?)'
  ).bind(r.chat_id, JSON.stringify(payload), Date.now()).run();
  return stash.meta.last_row_id;
}

// The codes snoozeButtons offers, and the only ones a z: tap may carry.
// Callback data is not bound to its button: "z:5:abc" burned a snooze, wrote
// NaN into next_nag_at — a nag that never came back — and threw before the
// card was redrawn.
export const SNOOZE_CODES = ['30', '60', '120', '180', '360', 't', 'day', 'w1', 'w2', 'b'];

// The postponements, in days: moves past the 24h window that carry fired_at
// (and so the expiry) forward with the nag, rather than snoozes inside it.
export const POSTPONE_DAYS = { day: 1, w1: 7, w2: 14 };

export function snoozeButtons(firingId, tz) {
  const z = (label, code) => ({ text: label, callback_data: `z:${firingId}:${code}` });
  // The next 9pm: tonight's until it has passed, then tomorrow's.
  const now = Date.now();
  const nine = nextOccurrence('daily', { h: 21, mi: 0 }, now, tz);
  const tonight = localParts(nine, tz).d === localParts(now, tz).d;
  return {
    inline_keyboard: [
      [z('30m', '30'), z('1h', '60'), z('2h', '120')],
      [z('3h', '180'), z('6h', '360'), z(tonight ? '🌙 9pm today' : '🌙 9pm tomorrow', 't')],
      [z('📅 Tomorrow', 'day'), z('📅 1 week', 'w1'), z('📅 2 weeks', 'w2')],
      [z('↩️ Back', 'b')],
    ],
  };
}

// Escalating nag lines, matched to whichever cat is on the sticker that
// accompanies the message.
const NAG_LINES = {
  latte: [
    'Mrow! A humble request from Latte 🐾',
    'Latte is staring at you. Intensely. 👀',
    'Latte just knocked a pen off the desk in protest 😾',
    'Latte is now sitting on this chore. It has not done itself 🙀',
  ],
  mocha: [
    'Mrow! A humble request from Mocha 🐾',
    'Mocha is watching you. Unblinking. 👀',
    'Mocha just shoved a glass toward the edge of the table 😾',
    'Mocha is now sitting on this chore. It has not done itself 🙀',
  ],
  both: [
    'Mrow! A humble request from Latte &amp; Mocha 🐾',
    'Latte &amp; Mocha are staring at you. Intensely. 👀',
    'Mocha just knocked a pen off the desk. Latte approved. 😾',
    'Both cats are now sitting on this chore. It has not done itself 🙀',
  ],
};

// The title line every card leads with. A /remind looks exactly like a
// /chore, so the one that never reaches the leaderboard is the one marked —
// and marked on every card state, not just the nag: the 😴 and ⏰ cards used
// to drop it, so the flag vanished the moment the card changed.
const titleHtml = (emoji, reminder) =>
  `${emoji} <b>${esc(reminder.text)}</b>${isScored(reminder) ? '' : ' <i>(reminder — no points)</i>'}`;

const assignedLine = (reminder) => (reminder.assignee_name
  ? `\nAssigned to ${mentionHtml(reminder.assignee_name, reminder.assignee_user_id)}.`
  : '');

export function nagHtml(reminder, nagCount, cat = 'both') {
  const head = `${titleHtml('🐱', reminder)}${nagCount > 0 ? ` — nag #${nagCount + 1}` : ''}`;
  const lines = NAG_LINES[cat] || NAG_LINES.both;
  const line = lines[Math.min(nagCount, lines.length - 1)];
  // The nag itself leads with the mention, so the person is pinged.
  const who = reminder.assignee_name
    ? `${mentionHtml(reminder.assignee_name, reminder.assignee_user_id)} — `
    : '';
  return `${head}\n${who}${line}`;
}

export function snoozedHtml(reminder, until, by, tz) {
  return `${titleHtml('😴', reminder)}\nSnoozed by ${esc(by)} until ${fmtLocal(until, tz)}.${assignedLine(reminder)}`;
}

export function overdueHtml(reminder) {
  return `${titleHtml('⏰', reminder)}\n24 hours and counting — the cats are still waiting.${assignedLine(reminder)}`;
}

// Past the 24h window. A recurring firing is expired here; a one-off stays
// 'nagging' and is re-nagged hourly on the ⏰ card (OVERDUE_NAG_MIN).
export const isOverdue = (firing, now = Date.now()) => now >= firing.fired_at + EXPIRE_AFTER_MS;

// A firing the household itself parked — snoozed or postponed to a time still
// ahead — as opposed to one the bot is merely holding. The two look alike on
// next_nag_at alone: the cron pushes a re-nag due in quiet hours out to 08:00,
// and an ordinary pending re-nag is always ahead of now. snoozes_used cannot
// tell them apart either — it is a cap, and stays set after the snooze it
// counted has elapsed and the cron has moved on. So a snooze records the time
// it chose in snoozed_until, and the choice counts only while next_nag_at
// still equals it. A postponement carries fired_at into the future instead.
export function isHouseholdDeferred(firing, now = Date.now()) {
  if (firing.fired_at > now) return true;
  return firing.snoozed_until != null && firing.next_nag_at != null
    && firing.next_nag_at === firing.snoozed_until && firing.next_nag_at > now;
}

// Every nag now lives in the group; only its visibility differs. Kept as a
// function because nag_chat_id still exists for pre-ephemeral rows, all NULL.
export const nagChat = (firing) => firing.nag_chat_id || firing.chat_id;

// A nag is public or ephemeral, and the two use different id spaces and
// different edit/delete methods. These three keep that distinction in one
// place so the lifecycle below never has to care which kind it is holding.
export const nagRef = (firing) => (firing.last_message_id
  ? { id: firing.last_message_id, ephemeral: Boolean(firing.last_message_ephemeral) }
  : null);
const nagCtx = (env, firing) => replyCtx(env, nagChat(firing), firing.nag_user_id);
export const isEphemeralNag = (firing) => Boolean(firing.last_message_ephemeral);

// An ephemeral nag is one person's: only they can see it, so only they can
// tap it. A callback for it from anyone else is forged data, not a tap — and
// acting on it let one member Done or snooze another's private chore and take
// the credit. Public nags are the household's and stay open to everyone.
export const nagBelongsTo = (firing, from) =>
  !isEphemeralNag(firing) || !firing.nag_user_id || Boolean(from && from.id === firing.nag_user_id);

export function editNag(env, firing, html, markup) {
  return editRef(env, nagCtx(env, firing), nagChat(firing), nagRef(firing), html, markup);
}

export function deleteNag(env, firing) {
  return deleteRef(env, nagCtx(env, firing), nagChat(firing), nagRef(firing));
}

// Re-send a firing's nag with the same visibility as the original, so a re-nag
// or a /poke never quietly promotes a private chore into public view.
export async function sendNag(env, firing, html, markup, opts = {}) {
  if (firing.nag_user_id) {
    return msgRef(await sendPrivate(env, nagCtx(env, firing), html, markup, opts));
  }
  return msgRef(await sendMessage(env, nagChat(firing), html, markup, opts));
}

// Remove a nag message that lost its compare-and-swap after being sent.
export function deleteNagRef(env, firing, ref) {
  return deleteRef(env, nagCtx(env, firing), nagChat(firing), ref);
}

export async function showPausedCard(env, firing, reminder, by, tz, until = null) {
  if (firing.last_sticker_id) await deleteMessage(env, nagChat(firing), firing.last_sticker_id);
  await env.DB.prepare('UPDATE firings SET last_sticker_id = NULL WHERE id = ?').bind(firing.id).run();
  if (!firing.last_message_id) return;
  // No name when nobody on hand knows it: a chore's own pause, redrawn when
  // vacation mode ends over the top of it, was set by whoever it was.
  const state = until
    ? `Household paused until ${fmtLocal(until, tz)}.`
    : by ? `Paused by ${esc(by)}.` : 'Paused.';
  await editNag(env, firing, `⏸️ <b>${esc(reminder.text)}</b>\n${state}`, emptyKeyboard());
}

async function silenceOldNag(env, firing, text, note) {
  if (!firing.last_message_id) return;
  await editNag(env, firing, `${note} <s>${esc(text)}</s>`, emptyKeyboard());
}

export async function completeFiring(env, firing, reminder, byName, tz) {
  const now = Date.now();
  // Only the winner of this state transition performs the side effects: a
  // concurrent cron expiry or second Done tap loses here and returns false.
  const res = await env.DB.prepare(
    `UPDATE firings SET state = 'done', done_by = ?, done_at = ?,
       snoozed_until = CASE WHEN next_nag_at = snoozed_until THEN snoozed_until ELSE NULL END,
       next_nag_at = NULL WHERE id = ? AND state = 'nagging'`
  ).bind(byName, now, firing.id).run();
  if (!res.meta.changes) return false;
  // Re-read so message ids reflect a re-nag that landed after our caller's SELECT.
  firing = await env.DB.prepare('SELECT * FROM firings WHERE id = ?').bind(firing.id).first() || firing;
  if (firing.last_sticker_id) await deleteMessage(env, nagChat(firing), firing.last_sticker_id);
  // An ephemeral nag had no sticker to begin with — one now would be visible to
  // the whole group and give away a chore only one person could see.
  const celebration = isEphemeralNag(firing)
    ? { cat: 'both' }
    : await sendCelebrationSticker(env, nagChat(firing), firing.id);
  const purr = celebration.cat === 'latte' ? 'Latte purrs approvingly.'
    : celebration.cat === 'mocha' ? 'Mocha purrs approvingly.'
    : 'The cats purr approvingly.';
  if (firing.last_message_id) {
    // A receipt lives two hours; the clock time is all it needs.
    await editNag(env, firing,
      `😻 <s>${esc(reminder.text)}</s>\nDone by ${esc(byName)} at ${fmtClock(now, tz)}. ${purr}`,
      receiptButtons(firing.id));
    // The nag earned a day; its receipt only needs to be glanced at.
    await retimeSentMessage(env, nagChat(firing), nagRef(firing), RECEIPT_TTL_MS);
  }
  // A privately-nagged chore leaves a quiet public receipt: the household still
  // gets to see the chore was done, just not that it was pending.
  // So does one with no card left to edit — a parked chore whose 😴 card was
  // put away with OK, then finished from the board.
  if (isEphemeralNag(firing) || nagChat(firing) !== firing.chat_id || !firing.last_message_id) {
    await sendMessage(env, firing.chat_id,
      `😻 <s>${esc(reminder.text)}</s> — done by ${esc(byName)}.`, receiptButtons(firing.id),
      { silent: true, ttl: RECEIPT_TTL_MS });
  }
  // A finished one-off goes to the trash rather than straight out, so that
  // ↩️ Not done can bring it back for as long as the trash keeps it.
  if (reminder.schedule_kind === 'once') {
    await stashReminder(env, reminder, firing.id);
    await env.DB.prepare('DELETE FROM reminders WHERE id = ?').bind(reminder.id).run();
  }
  await updateDashboard(env, firing.chat_id);
  return true;
}

// The claim binds fired_at as well as state, because fired_at is the clock the
// caller read to decide this firing was 24h old. A resume restamps it, so
// without that column in the WHERE a cron tick that had already made up its
// mind expired a nag the household had just brought back to life.
// Recurring firings only: a one-off is never expired (see renagPending).
export async function expireFiring(env, firing, reminder, { silent } = {}) {
  const res = await env.DB.prepare(
    "UPDATE firings SET state = 'expired', next_nag_at = NULL WHERE id = ? AND state = 'nagging' AND fired_at = ?"
  ).bind(firing.id, firing.fired_at).run();
  if (!res.meta.changes) return false;
  firing = await env.DB.prepare('SELECT * FROM firings WHERE id = ?').bind(firing.id).first() || firing;
  await silenceOldNag(env, firing, reminder.text, '🙀');
  if (firing.last_sticker_id) await deleteMessage(env, nagChat(firing), firing.last_sticker_id);
  if (!silent) {
    // The tombstone always lands in the group — accountability is household-wide.
    await sendMessage(env, firing.chat_id,
      `🙀 <s>${esc(reminder.text)}</s> — 24 hours and nobody did it. Latte &amp; Mocha are deeply disappointed.`);
  }
  await updateDashboard(env, firing.chat_id);
  return true;
}
