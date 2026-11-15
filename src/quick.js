// The quick-log pad: a second pinned message of one-tap buttons for jobs that
// are not scheduled chores ("🧹 Vacuum", "🧺 Laundry"). A tap logs a done
// firing with no chore behind it (reminder_id QUICK_TAP_ID), credited to
// whoever tapped, worth one ✅ on the leaderboard and never a bonus
// (bonus.js). /quick pins the pad, /quick add and /quick remove change it.

import { sendMessage, editMessage, deleteMessage, pinMessage, unpinMessage, answerCallback,
         sendPrivate, editRef, messageIsGone, esc, okButton, RECEIPT_TTL_MS } from './tg.js';
import { senderName, QUICK_TAP_ID, getTz } from './household.js';
import { choreEmoji } from './dashboard.js';
import { fmtClock } from './time.js';
import { UNDO_WINDOW_MS } from './chores.js';

export const QUICK_MAX = 8;
const QUICK_TEXT_MAX = 32;
// The same job by the same person counts once an hour: a double tap is one
// job, and the pad's eight buttons could otherwise be tapped round every
// minute for eight points each time (pen test, 16 Nov 2026).
export const REPEAT_MS = 3600000;

// "🧹 Vacuum": the board's keyword emoji, or the one the text leads with.
export function quickLabel(text) {
  const emoji = choreEmoji(text);
  const shown = text.charAt(0).toUpperCase() + text.slice(1);
  return emoji && emoji !== '📌' ? `${emoji} ${shown}` : shown;
}

// What a typed job is stored and matched as: spaces collapsed, and the emoji
// the pad would add anyway dropped, so "/quick remove 🧹 Vacuum" copied off a
// button finds "vacuum", and "/quick add 🧹 vacuum" is not a second Vacuum.
// An emoji of the person's own choosing ("🪴 water plants") stays.
export function quickText(typed) {
  // Invisible format characters (zero-width spaces, joiners) at either end go
  // too; inside the text they stay, since emoji sequences are built on them.
  const text = String(typed || '').replace(/\s+/g, ' ').replace(/^[\p{Cf}\s]+|[\p{Cf}\s]+$/gu, '');
  const m = text.match(/^(\p{Extended_Pictographic}️?)\s+(.+)$/u);
  return m && choreEmoji(m[2]).replace(/️/g, '') === m[1].replace(/️/g, '') ? m[2] : text;
}

// Something a person can see on a button.
const visible = (text) => /[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(text);

// The same job in any case, in any script: SQLite's NOCASE folds ASCII only,
// so "Äpfel" and "äpfel" were two buttons.
const sameJob = (a, b) => a.normalize('NFKC').toLocaleLowerCase() === b.normalize('NFKC').toLocaleLowerCase();

const PAD_HTML = '⚡ <b>Quick log</b>\nDone one of these? Tap it: 1 ✅ for whoever taps.';

function padButtons(rows) {
  const keyboard = [];
  for (let i = 0; i < rows.length; i += 2) {
    keyboard.push(rows.slice(i, i + 2).map((r) => ({ text: quickLabel(r.text), callback_data: `q:${r.id}` })));
  }
  return { inline_keyboard: keyboard };
}

// Pin the pad, then the board back over it: the board stays the top pin, as
// POST /admin?board leaves them, and the pad is one tap down the pin bar.
async function pinUnderBoard(env, chatId, padId, boardId) {
  const pinned = await pinMessage(env, chatId, padId);
  if (!pinned.ok) {
    console.log(`quick pad pin FAILED for chat ${chatId}: ${pinned.description || 'unknown'} ` +
      '— bot needs the Pin Messages admin right');
    return false;
  }
  if (boardId) await pinMessage(env, chatId, boardId);
  return true;
}

// Draw the pad in place, or send and pin a new one when it is missing; `repin`
// pins the one that is there (/quick). An empty pad is unpinned and removed.
// Mirrors drawDashboard: only a pad Telegram says is gone is replaced, so a
// blip never pins a second one. Kept off the sweep (keep: true); the other
// message ?board's repair spares. Returns { ok, pinned, empty }.
export async function drawPad(env, chatId, { repin = false } = {}) {
  const [taps, settings] = await env.DB.batch([
    env.DB.prepare('SELECT id, text FROM quick_taps WHERE chat_id = ? ORDER BY id').bind(chatId),
    env.DB.prepare('SELECT quick_msg_id, dashboard_msg_id FROM settings WHERE chat_id = ?').bind(chatId),
  ]);
  const rows = taps.results || [];
  const row = settings.results[0] || {};
  const msgId = row.quick_msg_id || null;
  if (!rows.length) {
    if (msgId) {
      await unpinMessage(env, chatId, msgId);
      await deleteMessage(env, chatId, msgId);
      await env.DB.prepare('UPDATE settings SET quick_msg_id = NULL WHERE chat_id = ? AND quick_msg_id = ?')
        .bind(chatId, msgId).run();
    }
    return { ok: true, empty: true };
  }
  if (msgId) {
    const res = await editMessage(env, chatId, msgId, PAD_HTML, padButtons(rows));
    if (res.ok || String(res.description || '').includes('not modified')) {
      return { ok: true, pinned: repin ? await pinUnderBoard(env, chatId, msgId, row.dashboard_msg_id) : true };
    }
    if (!messageIsGone(res.description)) {
      console.log(`quick pad edit failed for chat ${chatId}: ${res.description || 'unknown'} — keeping it`);
      return { ok: false };
    }
  }
  const sent = await sendMessage(env, chatId, PAD_HTML, padButtons(rows), { silent: true, keep: true });
  if (!sent.ok) {
    console.log(`quick pad send failed for chat ${chatId}: ${sent.description || 'unknown'}`);
    return { ok: false };
  }
  const newId = sent.result.message_id;
  // Claimed only over the pad this draw read: two draws that both found none
  // (two /quick adds at once) would otherwise both pin one, and the loser
  // would stay pinned, unswept and never redrawn.
  const claim = await env.DB.prepare(
    `INSERT INTO settings (chat_id, quick_msg_id) VALUES (?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET quick_msg_id = excluded.quick_msg_id WHERE settings.quick_msg_id IS ?`
  ).bind(chatId, newId, msgId).run();
  if (!claim.meta.changes) {
    await deleteMessage(env, chatId, newId);
    return { ok: true, pinned: true };
  }
  return { ok: true, pinned: await pinUnderBoard(env, chatId, newId, row.dashboard_msg_id) };
}

const USAGE = '⚡ <b>Quick log</b>\n' +
  '<code>/quick</code> — pin the pad (again)\n' +
  '<code>/quick add vacuum</code> — add a button\n' +
  '<code>/quick remove vacuum</code> — take one off\n' +
  'A tap logs 1 ✅ for whoever taps. Never a bonus.';

const NO_PIN = 'I could not pin it: give me the Pin Messages admin right, then send /quick.';

// What a draw left to say after a change, if anything went wrong.
const drawNote = (res) => (!res.ok ? '\nThe pad did not update just now; send /quick to fix it.'
  : res.pinned === false ? `\n${NO_PIN}` : '');

// /quick, /quick add <job>, /quick remove <job>.
export async function cmdQuick(env, ctx, args) {
  const chatId = ctx.chatId;
  const typed = String(args || '').trim();
  if (!typed) {
    const res = await drawPad(env, chatId, { repin: true });
    if (res.empty) return sendPrivate(env, ctx, `The pad has no buttons yet.\n\n${USAGE}`);
    if (!res.ok) return sendPrivate(env, ctx, 'Could not draw the pad just now. Try again in a minute.');
    return sendPrivate(env, ctx, res.pinned ? '📌 Quick log pad pinned, under the chore board.' : `The pad is there, but ${NO_PIN}`);
  }
  const m = typed.match(/^(add|remove|rm|del|delete)\s+(.+)$/i);
  if (!m) return sendPrivate(env, ctx, USAGE);
  const text = quickText(m[2]);
  const { results: rows } = await env.DB.prepare('SELECT id, text FROM quick_taps WHERE chat_id = ?').bind(chatId).all();
  const match = (rows || []).find((r) => sameJob(r.text, text));
  if (/^add$/i.test(m[1])) {
    if (!visible(text)) return sendPrivate(env, ctx, 'That job has nothing to show on a button.');
    if (text.length > QUICK_TEXT_MAX) {
      return sendPrivate(env, ctx, `Keep it to ${QUICK_TEXT_MAX} characters or fewer, so it fits a button.`);
    }
    if (match) return sendPrivate(env, ctx, `${esc(quickLabel(match.text))} is already on the pad.`);
    // Under the cap and not already there, in one conditional write.
    const added = await env.DB.prepare(
      `INSERT INTO quick_taps (chat_id, text, created_at)
       SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM quick_taps WHERE chat_id = ?) < ?
       ON CONFLICT DO NOTHING`
    ).bind(chatId, text, Date.now(), chatId, QUICK_MAX).run();
    if (!added.meta.changes) {
      const there = await env.DB.prepare('SELECT 1 FROM quick_taps WHERE chat_id = ? AND text = ? COLLATE NOCASE')
        .bind(chatId, text).first();
      return sendPrivate(env, ctx, there ? `${esc(quickLabel(text))} is already on the pad.`
        : `The pad holds ${QUICK_MAX} buttons. <code>/quick remove</code> one first.`);
    }
    const res = await drawPad(env, chatId);
    return sendPrivate(env, ctx, `Added ${esc(quickLabel(text))} to the quick log pad.${drawNote(res)}`);
  }
  const removed = match && await env.DB.prepare('DELETE FROM quick_taps WHERE id = ? AND chat_id = ?')
    .bind(match.id, chatId).run();
  if (!removed || !removed.meta.changes) return sendPrivate(env, ctx, `No ${esc(text)} button on the pad.`);
  const res = await drawPad(env, chatId);
  return sendPrivate(env, ctx,
    `Took ${esc(quickLabel(match.text))} off the quick log pad. What it logged stays logged.${res.empty ? '' : drawNote(res)}`);
}

function receiptButtons(firingId) {
  return { inline_keyboard: [[{ text: '↩️ Not done', callback_data: `qu:${firingId}` }, okButton()]] };
}

// q:<button id> logs the job; qu:<firing id> takes a log back.
export async function handleQuickCallback(env, cb, ctx, ref) {
  const chatId = cb.message.chat.id;
  const data = cb.data || '';
  const by = senderName(cb.from);
  const tap = data.match(/^q:(\d+)$/);
  if (tap) {
    const now = Date.now();
    // The button, the double-tap check and the log are one conditional write,
    // and the timezone rides beside it: the toast waits on one round trip.
    const [logged, tz] = await Promise.all([
      env.DB.prepare(
        `INSERT INTO firings (reminder_id, chat_id, reminder_text, fired_at, state, done_by, done_at, scored)
         SELECT ?, qt.chat_id, qt.text, ?, 'done', ?, ?, 1 FROM quick_taps qt
         WHERE qt.id = ? AND qt.chat_id = ?
           AND NOT EXISTS (SELECT 1 FROM firings f WHERE f.chat_id = qt.chat_id AND f.reminder_id = ?
             AND f.state = 'done' AND f.reminder_text = qt.text AND f.done_by = ? AND f.done_at > ?)
         RETURNING id, reminder_text`
      ).bind(QUICK_TAP_ID, now, by, now, +tap[1], chatId, QUICK_TAP_ID, by, now - REPEAT_MS).run(),
      getTz(env, chatId),
    ]);
    const log = logged.results && logged.results[0];
    if (!log) {
      const button = await env.DB.prepare('SELECT 1 FROM quick_taps WHERE id = ? AND chat_id = ?')
        .bind(+tap[1], chatId).first();
      if (button) return answerCallback(env, cb.id, 'You logged that in the last hour already.');
      await answerCallback(env, cb.id, 'That button is gone.');
      return drawPad(env, chatId);
    }
    const label = quickLabel(log.reminder_text);
    await answerCallback(env, cb.id, `${label}: logged, 1 ✅`);
    await sendMessage(env, chatId, `😻 <s>${esc(label)}</s> — done by ${esc(by)} at ${fmtClock(now, tz)}.`,
      receiptButtons(log.id), { silent: true, ttl: RECEIPT_TTL_MS });
    return;
  }
  const undo = data.match(/^qu:(\d+)$/);
  if (undo) {
    const gone = await env.DB.prepare(
      `DELETE FROM firings WHERE id = ? AND chat_id = ? AND reminder_id = ? AND state = 'done' AND done_at > ?
       RETURNING reminder_text`
    ).bind(+undo[1], chatId, QUICK_TAP_ID, Date.now() - UNDO_WINDOW_MS).run();
    const row = gone.results && gone.results[0];
    if (!row) {
      const still = await env.DB.prepare('SELECT reminder_id FROM firings WHERE id = ? AND chat_id = ?')
        .bind(+undo[1], chatId).first();
      return answerCallback(env, cb.id, !still ? 'Already taken back.'
        : still.reminder_id === QUICK_TAP_ID ? 'Too late to take that back.' : 'Nothing to take back.');
    }
    await answerCallback(env, cb.id, 'Taken back ↩️');
    await editRef(env, ctx, chatId, ref,
      `↩️ <b>${esc(quickLabel(row.reminder_text || 'job'))}</b> — not done after all, says ${esc(by)}.`,
      { inline_keyboard: [[okButton()]] });
    return;
  }
  return answerCallback(env, cb.id, '');
}
