// The nag message lifecycle: rendering, buttons, the public/ephemeral ref
// distinction, and the completion/expiry state transitions that end a firing.

import { sendMessage, deleteMessage, esc, mentionHtml, replyCtx, sendPrivate,
         editRef, deleteRef, msgRef, retimeSentMessage, RECEIPT_TTL_MS } from './tg.js';
import { nextOccurrence, fmtLocal, fmtShort } from './time.js';
import { sendCelebrationSticker } from './stickers.js';
import { isScored } from './household.js';
import { updateDashboard } from './dashboard.js';

export const MAX_SNOOZES = 3;
export const EXPIRE_AFTER_MS = 24 * 3600000;

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
    [{ text: scored ? '🗑 Delete chore' : '🗑 Delete reminder', callback_data: `x:${firingId}` }],
  ] };
}

export function snoozeButtons(firingId, tz) {
  const z = (label, code) => ({ text: label, callback_data: `z:${firingId}:${code}` });
  const nine = nextOccurrence('daily', { h: 21, mi: 0 }, Date.now(), tz);
  return {
    inline_keyboard: [
      [z('30m', '30'), z('1h', '60'), z('2h', '120')],
      [z(fmtShort(nine, tz), 't'), z('📅 Tomorrow', 'day')],
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

export function nagHtml(reminder, nagCount, cat = 'both') {
  // Whether this counts is decided here, at the moment someone taps Done.
  const kind = isScored(reminder) ? '' : ' <i>(reminder — no points)</i>';
  const head = `🐱 <b>${esc(reminder.text)}</b>${kind}${nagCount > 0 ? ` — nag #${nagCount + 1}` : ''}`;
  const lines = NAG_LINES[cat] || NAG_LINES.both;
  const line = lines[Math.min(nagCount, lines.length - 1)];
  const who = reminder.assignee_name
    ? `${mentionHtml(reminder.assignee_name, reminder.assignee_user_id)} — `
    : '';
  return `${head}\n${who}${line}`;
}

export function snoozedHtml(reminder, until, by, tz) {
  const who = reminder.assignee_name
    ? `\nAssigned to ${mentionHtml(reminder.assignee_name, reminder.assignee_user_id)}.`
    : '';
  return `😴 <b>${esc(reminder.text)}</b>\nSnoozed by ${esc(by)} until ${fmtLocal(until, tz)}.${who}`;
}

// Every nag now lives in the group; only its visibility differs. Kept as a
// function because nag_chat_id still exists for pre-ephemeral rows, all NULL.
export const nagChat = (firing) => firing.nag_chat_id || firing.chat_id;

// A nag is public or ephemeral, and the two use different id spaces and
// different edit/delete methods. These three keep that distinction in one
// place so the lifecycle below never has to care which kind it is holding.
const nagRef = (firing) => (firing.last_message_id
  ? { id: firing.last_message_id, ephemeral: Boolean(firing.last_message_ephemeral) }
  : null);
const nagCtx = (env, firing) => replyCtx(env, nagChat(firing), firing.nag_user_id);
export const isEphemeralNag = (firing) => Boolean(firing.last_message_ephemeral);

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
  const state = until
    ? `Household paused until ${fmtLocal(until, tz)}.`
    : `Paused by ${esc(by)}.`;
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
    "UPDATE firings SET state = 'done', done_by = ?, done_at = ?, next_nag_at = NULL WHERE id = ? AND state = 'nagging'"
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
    await editNag(env, firing,
      `😻 <s>${esc(reminder.text)}</s>\nDone by ${esc(byName)} at ${fmtLocal(now, tz)}. ${purr}`,
      emptyKeyboard());
    // The nag earned a day; its receipt only needs to be glanced at.
    await retimeSentMessage(env, nagChat(firing), nagRef(firing), RECEIPT_TTL_MS);
  }
  // A privately-nagged chore leaves a quiet public receipt: the household still
  // gets to see the chore was done, just not that it was pending.
  if (isEphemeralNag(firing) || nagChat(firing) !== firing.chat_id) {
    await sendMessage(env, firing.chat_id,
      `😻 <s>${esc(reminder.text)}</s> — done by ${esc(byName)}.`, null,
      { silent: true, ttl: RECEIPT_TTL_MS });
  }
  if (reminder.schedule_kind === 'once') {
    await env.DB.prepare('DELETE FROM reminders WHERE id = ?').bind(reminder.id).run();
  }
  await updateDashboard(env, firing.chat_id);
  return true;
}

// The claim binds fired_at as well as state, because fired_at is the clock the
// caller read to decide this firing was 24h old. A resume restamps it, so
// without that column in the WHERE a cron tick that had already made up its
// mind expired a nag the household had just brought back to life.
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
  if (reminder.schedule_kind === 'once') {
    await env.DB.prepare('DELETE FROM reminders WHERE id = ?').bind(reminder.id).run();
  }
  await updateDashboard(env, firing.chat_id);
  return true;
}
