// The nag message lifecycle: rendering, buttons, the public/ephemeral ref
// distinction, and the completion/expiry state transitions that end a firing.

import { sendMessage, deleteMessage, esc, mentionHtml, replyCtx, sendPrivate,
         editRef, deleteRef, msgRef, retimeSentMessage, RECEIPT_TTL_MS } from './tg.js';
import { nextOccurrence, fmtLocal, fmtClock, localParts } from './time.js';
import { pickCelebration, sendCelebration } from './stickers.js';
import { isScored } from './household.js';
import { coverChildren, coverLine, nestedReads } from './nesting.js';
import { updateDashboard, later, fmtWhen, fmtSince } from './dashboard.js';

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
      // Puts the 😴 card away while the chore stays parked (zh: in handlers).
      // It is still the firing's live card, so the daily sweep spares it — a
      // two-week postponement left it in the chat for two weeks with nothing
      // to dismiss it by. The nag comes back as a fresh card when it is due.
      // 🙈 Hide, not ✅ OK: ✅ is Done on the row above.
      { text: '🙈 Hide', callback_data: `zh:${firingId}` },
      { text: scored ? '🗑 Delete chore' : '🗑 Delete reminder', callback_data: `x:${firingId}` },
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
    return [snoozedHtml(reminder, firing.next_nag_at, firing.snoozed_by || 'the household', tz,
      firing.fired_at > now),
      snoozedButtons(firing.id, isScored(firing))];
  }
  if (isOverdue(firing, now)) return [overdueHtml(reminder, firing.fired_at, tz), nagButtons(firing.id, isScored(firing))];
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
  const stash = await stashStatement(env, r, firingId).run();
  return stash.meta.last_row_id;
}

// The same stash as a statement, for a batch.
export function stashStatement(env, r, firingId = null) {
  const payload = firingId ? { ...r, _firing: firingId } : r;
  return env.DB.prepare(
    'INSERT INTO trash (chat_id, payload, created_at) VALUES (?, ?, ?)'
  ).bind(r.chat_id, JSON.stringify(payload), Date.now());
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
      [z('← Back', 'b')],
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

// A 📅 postponement says so, as the toast that set it did. The time reads as
// the board does ("tomorrow 9:00 PM"), not as a full date for tonight.
export function snoozedHtml(reminder, until, by, tz, postponed = false) {
  const when = postponed ? `— back ${fmtWhen(until, tz)}` : `until ${fmtWhen(until, tz)}`;
  return `${titleHtml('😴', reminder)}\n${postponed ? 'Postponed' : 'Snoozed'} by ${esc(by)} ${when}.`
    + assignedLine(reminder);
}

// Says since when, as the board does: "24 hours and counting" read the same
// a week later.
export function overdueHtml(reminder, firedAt, tz) {
  const since = firedAt != null && tz ? `Nagging since ${fmtSince(firedAt, tz)}` : 'Over 24 hours now';
  return `${titleHtml('⏰', reminder)}\n${since} — the cats are still waiting.${assignedLine(reminder)}`;
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
  await editNag(env, firing, `⏸️ <b>${esc(reminder.text)}</b>\n${state}`, until ? emptyKeyboard()
    : { inline_keyboard: [[{ text: '▶️ Resume', callback_data: `rs:${reminder.id}` }]] });
}

// The Done claim, so a tap can send it with the reads it needs in one round
// trip. Conditional on the state, like every transition. `chatId` scopes it to
// the household the tap came from; `userId` refuses another member's
// ephemeral nag (nagBelongsTo, in SQL); `needReminder` refuses a firing whose
// chore has gone. `reminder`, when the caller already holds it, puts a
// one-off's stash and removal in the same transaction, gated on the claim.
// After the claim come the firing as it now stands, then any `extra` reads.
const OWNS = '(last_message_ephemeral = 0 OR nag_user_id IS NULL OR nag_user_id = ?)';
const HAS_CHORE = 'EXISTS (SELECT 1 FROM reminders r WHERE r.id = firings.reminder_id AND r.chat_id = firings.chat_id)';

export function doneClaim(env, firingId, byName, now,
  { chatId = null, userId = null, needReminder = false, reminder = null, extra = [] } = {}) {
  const where = ['id = ?', "state = 'nagging'"];
  const args = [byName, now, firingId];
  if (chatId != null) { where.push('chat_id = ?'); args.push(chatId); }
  if (userId != null) { where.push(OWNS); args.push(userId); }
  if (needReminder) where.push(HAS_CHORE);
  const statements = [env.DB.prepare(
    `UPDATE firings SET state = 'done', done_by = ?, done_at = ?,
       snoozed_until = CASE WHEN next_nag_at = snoozed_until THEN snoozed_until ELSE NULL END,
       next_nag_at = NULL WHERE ${where.join(' AND ')}`
  ).bind(...args)];
  const stashes = Boolean(reminder && reminder.schedule_kind === 'once');
  if (stashes) {
    statements.push(
      env.DB.prepare(
        'INSERT INTO trash (chat_id, payload, created_at) SELECT ?, ?, ? WHERE changes() = 1'
      ).bind(reminder.chat_id, JSON.stringify({ ...reminder, _firing: firingId }), now),
      env.DB.prepare('DELETE FROM reminders WHERE id = ? AND changes() = 1').bind(reminder.id),
    );
  }
  const at = statements.length;
  statements.push(env.DB.prepare('SELECT * FROM firings WHERE id = ?').bind(firingId), ...extra);
  return {
    statements,
    chatId: chatId ?? (reminder && reminder.chat_id),
    read: (results) => ({
      won: Boolean(results[0].meta.changes),
      stashed: stashes,
      firing: (results[at].results || [])[0] || null,
      extra: results.slice(at + 1),
    }),
  };
}

// Sends a doneClaim. The chat's nested chores, which the cover of a won Done
// walks, are read alongside rather than inside it: the same wall time, and a
// read that fails (a database without parent_id yet) can never cost the Done.
export async function runDoneClaim(env, claim) {
  const [results, nested] = await Promise.all([
    env.DB.batch(claim.statements),
    claim.chatId == null ? null : readNested(env, claim.chatId),
  ]);
  return { ...claim.read(results), nested };
}

// nestedReads, never rejecting: a failure leaves the cover to try for itself.
export function readNested(env, chatId) {
  return Promise.resolve().then(() => nestedReads(env, chatId)).catch((e) => {
    console.log(`nested chores read failed: ${e}`);
    return null;
  });
}

// `onClaim` runs the moment the Done is won, before any of the redrawing: it
// is where a tap's toast goes, so the person hears "Purrs" as soon as it is
// true rather than after the sticker, the card and the board.
// `claimed` is a claim the caller already won in a batch of its own (doneClaim:
// a nag button sends it with the reads it needs).
// `receipt: false`: the message the Done came from already records it — the
// 8am digest, which redraws the chore as a struck line with ↩️ Not done — so
// a privately nagged chore sends no second, public receipt beside it.
export async function completeFiring(env, firing, reminder, byName, tz, { onClaim, claimed = null, receipt: publicReceipt = true } = {}) {
  let now = Date.now();
  if (!claimed) {
    // Only the winner of this state transition performs the side effects: a
    // concurrent cron expiry or second Done tap loses here and returns false.
    // The row is read back in the same batch (one round trip), so message ids
    // reflect a re-nag that landed after our caller's SELECT.
    claimed = await runDoneClaim(env, doneClaim(env, firing.id, byName, now, { reminder }));
    if (!claimed.won) return false;
  } else if (claimed.firing && claimed.firing.done_at != null) {
    now = claimed.firing.done_at;
  }
  firing = claimed.firing || firing;
  if (onClaim) await onClaim();
  // What the receipt says: the chores under this one are covered by it
  // (nesting.js) and the receipt names them; the celebration sticker is
  // chosen (not yet sent) so the purr line can name its cat. The cover is
  // part of the Done — what it resets is what the board and the Mini App's
  // answer show — while the sticker choice only feeds the receipt, so it is
  // started now and waited for with the receipt.
  // An ephemeral nag had no sticker to begin with — one now would be visible to
  // the whole group and give away a chore only one person could see.
  const picking = isEphemeralNag(firing) ? Promise.resolve(null) : pickCelebration(env, nagChat(firing), firing.id);
  const covered = await coverChildren(env, reminder, firing.id, tz, { nested: claimed.nested });
  const also = coverLine(covered);
  // A finished one-off goes to the trash rather than straight out, so that
  // ↩️ Not done can bring it back for as long as the trash keeps it. Stash
  // and removal are one batch: the claim's own, unless the claim was made
  // before the chore was known (a nag button), and then right after it.
  const stash = async () => {
    if (reminder.schedule_kind !== 'once' || claimed.stashed) return;
    await env.DB.batch([
      stashStatement(env, reminder, firing.id),
      env.DB.prepare('DELETE FROM reminders WHERE id = ?').bind(reminder.id),
    ]);
  };
  // The card, the receipt and the stickers. In the Mini App they wait for the
  // page's answer (later): the database already says the chore is done, and
  // these only show it.
  const show = async () => {
    const pick = await picking;
    const purr = pick && pick.cat === 'latte' ? 'Latte purrs approvingly.'
      : pick && pick.cat === 'mocha' ? 'Mocha purrs approvingly.'
      : 'The cats purr approvingly.';
    const line = `😻 <s>${esc(reminder.text)}</s> — done by ${esc(byName)} at ${fmtClock(now, tz)}. ${purr}${also}`;
    // The card and the public receipt touch different things, so they go out
    // together rather than one round trip after another.
    const card = async () => {
      if (isEphemeralNag(firing)) {
        // A private nag's card is put away, not turned into a receipt: the
        // public receipt below tells the whole household, and the one who did
        // the chore was seeing both (20 Oct 2026). Forgetting the card is what
        // lets ↩️ Not done on that receipt send them a fresh private nag (see
        // redrawNag).
        await Promise.all([
          deleteNag(env, firing),
          env.DB.prepare(
            'UPDATE firings SET last_message_id = NULL, last_message_ephemeral = 0 WHERE id = ? AND last_message_id = ?'
          ).bind(firing.id, firing.last_message_id).run(),
        ]);
      } else if (firing.last_message_id) {
        // A receipt lives two hours; the clock time is all it needs. The nag
        // earned a day; its receipt only needs to be glanced at.
        await Promise.all([
          editNag(env, firing, line, receiptButtons(firing.id)),
          retimeSentMessage(env, nagChat(firing), nagRef(firing), RECEIPT_TTL_MS),
        ]);
      }
    };
    // A privately-nagged chore leaves a quiet public receipt: the household
    // still gets to see the chore was done, just not that it was pending.
    // So does one with no card left to edit — a parked chore whose 😴 card was
    // put away with OK, then finished from the board.
    const receipt = async () => {
      if (!publicReceipt) return;
      if (isEphemeralNag(firing) || nagChat(firing) !== firing.chat_id || !firing.last_message_id) {
        await sendMessage(env, firing.chat_id, line, receiptButtons(firing.id),
          { silent: true, ttl: RECEIPT_TTL_MS });
      }
    };
    // The nag's own sticker goes and the celebration arrives alongside.
    await Promise.all([
      card(), receipt(),
      pick ? sendCelebration(env, nagChat(firing), pick) : null,
      firing.last_sticker_id ? deleteMessage(env, nagChat(firing), firing.last_sticker_id) : null,
    ]);
  };
  await Promise.all([stash(), later(env, show)]);
  await updateDashboard(env, firing.chat_id);
  return true;
}

// The claim binds fired_at as well as state, because fired_at is the clock the
// caller read to decide this firing was 24h old. A resume restamps it, so
// without that column in the WHERE a cron tick that had already made up its
// mind expired a nag the household had just brought back to life.
// Recurring firings only: a one-off is never expired (see renagPending).
export async function expireFiring(env, firing, reminder, { silent } = {}) {
  const [claim, after] = await env.DB.batch([
    env.DB.prepare(
      "UPDATE firings SET state = 'expired', next_nag_at = NULL WHERE id = ? AND state = 'nagging' AND fired_at = ?"
    ).bind(firing.id, firing.fired_at),
    env.DB.prepare('SELECT * FROM firings WHERE id = ?').bind(firing.id),
  ]);
  if (!claim.meta.changes) return false;
  firing = (after.results || [])[0] || firing;
  // The card goes rather than staying struck through beside the tombstone:
  // one message says what happened, and a superseded nag (silent) is simply
  // replaced by the new one.
  await Promise.all([
    firing.last_message_id ? deleteNag(env, firing) : null,
    firing.last_sticker_id ? deleteMessage(env, nagChat(firing), firing.last_sticker_id) : null,
  ]);
  if (!silent) {
    // The tombstone always lands in the group — accountability is household-wide.
    await sendMessage(env, firing.chat_id,
      `🪦 <s>${esc(reminder.text)}</s> — 24 hours and nobody did it. Latte &amp; Mocha are deeply disappointed.`,
      null, { silent: true });
  }
  await updateDashboard(env, firing.chat_id);
  return true;
}
