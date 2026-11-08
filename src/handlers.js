// Webhook update handling: the command dispatcher, nag replies and reactions,
// and the callback router. Each button family's handler lives with its
// feature — editor/manage in manage.js, wizard in wizard.js — and the nag
// lifecycle, dashboard, chore actions, and stats each have their own module.

import { sendMessage, deleteMessage, editReplyMarkup, answerCallback, esc, okButton,
         replyCtx, sendPrivate, editRef, deleteRef, callbackRef,
         isPublicMessage, sendPrivateLong, keepSourceMessage, tg } from './tg.js';
import { parseRemind, ParseError, NoTimeError, refusalHtml } from './parse.js';
import { nextOccurrence, fmtLocal, deferQuietHours } from './time.js';
import { getTz, senderName, isScored, householdRoster, householdNames, householdNamesFrom, canonName,
         creditTogether, rememberMember, forgetMember, isMember, nicknames, CREDIT_SEP } from './household.js';
import { nagButtons, snoozedButtons, snoozeButtons, nagHtml, snoozedHtml, firingCard,
         editNag, deleteNag, sendNag, deleteNagRef, nagChat, isEphemeralNag,
         isHouseholdDeferred, nagBelongsTo,
         completeFiring, doneClaim, runDoneClaim, showPausedCard,
         MAX_SNOOZES, EXPIRE_AFTER_MS, SNOOZE_CODES, POSTPONE_DAYS } from './nag.js';
import { updateDashboard, choreListHtml, fmtWhen, clip } from './dashboard.js';
import { findReminder, createReminder, confirmNewChore, fireIfDue,
         deleteReminder, deleteTapped, removeReminder, restoreReminder, undoCompletion, undoEarly, earlyReceipt,
         setReminderPaused, completeEarly, wakeChat, skipPastPostponement, undoReads } from './chores.js';
import { handleEditorCallback, handleManageCallback, editorText, editorButtons } from './manage.js';
import { startWizard, startTextPrompt, tryDraftTime, handleWizardCallback } from './wizard.js';
import { cmdStats, handleStatsCallback } from './stats.js';
import { cmdMakeStickers, cmdDelSticker, cmdUsePack, cmdTagSticker, cmdAutoTag, cmdTags } from './sticker-commands.js';
import { digestView } from './cron.js';
import { coveredStatement, coveredNamesFrom } from './nesting.js';

// Cached getMe username, fetched only when a /cmd@bot suffix needs checking.
let botUsername = null;

const NOT_YOUR_NAG = 'That nag is someone else\'s 🙈';

// A typed Done, as a reply to a nag or on its own: "done", "Done!", "done 👍",
// "done together", "done with yx", or a bare ✅ (only as a reply). Only the
// whole phrase counts — "done?" and "not done ✅?" are people talking.
const DONE_TEXT = /^(?:done(?:\s+(?:together|both)\b|\s+with\s+.+?)?|✅)[\s!.✅👍]*$/iu;

// New members (or the bot itself) joining get a short intro.
async function handleNewMembers(env, msg) {
  const me = await tg(env, 'getMe', {});
  const meId = me.ok ? me.result.id : null;
  const botAdded = msg.new_chat_members.some((u) => u.id === meId);
  const humans = msg.new_chat_members.filter((u) => !u.is_bot);
  if (!botAdded && !humans.length) return;
  const hello = botAdded
    ? '🐱 Mrow! Latte &amp; Mocha here — we nag about chores until someone taps ✅ Done.'
    : `🐱 Welcome ${humans.map((u) => esc(u.first_name)).join(', ')}! We're Latte &amp; Mocha — we nag about chores until someone taps ✅ Done.`;
  // /chore is the default and the one that scores; /remind is the exception,
  // so it is labelled rather than being the example people copy.
  await sendMessage(env, msg.chat.id,
    `${hello}\nTry:\n<code>/chore take out trash 7pm daily</code>\n<code>/chore dishes now</code>\n` +
    '<code>/remind pay tax friday</code> — a reminder, no points\n/list · /stats · /help');
}

// Household lock: only chats listed in ALLOWED_CHATS (comma-separated ids)
// are served; everything else — stranger DMs included — is dropped silently.
// Missing configuration fails closed: a deploy must explicitly name every
// chat the bot is allowed to serve.
export function chatAllowed(env, chatId) {
  const allowed = String(env.ALLOWED_CHATS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return allowed.length > 0 && chatId != null && allowed.includes(String(chatId));
}

// Membership changes seen as `chat_member` updates. Only the statuses that
// mean "still here" keep a row; left and kicked take it away.
export const IN_CHAT = new Set(['member', 'administrator', 'creator', 'restricted']);

async function handleChatMember(env, upd) {
  const member = upd.new_chat_member;
  const who = member && member.user;
  const status = member && member.status;
  if (!who || who.is_bot) return;
  // "restricted" alone does not mean present: ChatMemberRestricted carries
  // is_member, and someone restricted who then leaves arrives as restricted
  // with is_member false. Taking the status at face value kept them on the
  // roster, drawing rotations from a chat they had walked out of.
  const gone = status === 'left' || status === 'kicked'
    || (status === 'restricted' && member.is_member === false);
  if (gone) return forgetMember(env, upd.chat.id, who.id);
  if (IN_CHAT.has(status)) return rememberMember(env, upd.chat.id, who);
}

// A household member's private chat: nothing happens here any more. Every nag
// lives in the group (an assigned one ephemerally), so a DM has nothing to
// route and no nag line to open — it just gets pointed back at the group.
async function handleMemberDm(env, update, chat) {
  const cb = update.callback_query;
  if (cb) {
    // Nothing in a DM is actionable, but a tap that goes unanswered spins on
    // the button until Telegram gives up — which reads as a dead bot. Old DM
    // messages still carry buttons, so answer, and honour ✅ OK's one meaning.
    if (cb.data === 'ok') {
      const ctx = replyCtx(env, chat.id, cb.from && cb.from.id, { callbackQueryId: cb.id });
      await deleteRef(env, ctx, chat.id, callbackRef(cb));
    }
    return answerCallback(env, cb.id, '');
  }
  const msg = update.message;
  if (!msg || !msg.text) return;
  // No ✅ OK button: this pointer has nothing to act on, and a button whose tap
  // arrives back in the DM is exactly the loop above. The daily sweep tidies it.
  return sendMessage(env, chat.id,
    '😺 Mrow! Everything happens in the family group — add, list, and finish chores there.',
    null, { noOk: true });
}

// `memberRecorded`: the webhook already wrote the sender's roster row in the
// same round trip that claimed the delivery (acceptUpdate).
export async function handleUpdate(env, update, { memberRecorded = false } = {}) {
  const chat = (update.message && update.message.chat)
    || (update.callback_query && update.callback_query.message && update.callback_query.message.chat)
    || (update.message_reaction && update.message_reaction.chat)
    || (update.chat_member && update.chat_member.chat);
  const from = (update.message && update.message.from)
    || (update.callback_query && update.callback_query.from)
    || (update.message_reaction && update.message_reaction.user)
    || (update.chat_member && update.chat_member.from);
  if (!chatAllowed(env, chat && chat.id)) {
    // Group traffic we reject is worth a log line: the usual cause is a basic
    // group being upgraded to a supergroup, which mints a new chat id that
    // ALLOWED_CHATS doesn't name yet. DMs stay unlogged.
    if (chat && chat.id < 0) {
      console.log(`rejected chat ${chat.id} (${chat.type}) "${chat.title || ''}"`);
    }
    // Private chats: known household members get one line pointing them back
    // to the group; everyone else stays silently ignored.
    if (!env.DB || !chat || chat.id < 0 || !from || from.is_bot) return;
    if (!(await isMember(env, from.id))) return;
    return handleMemberDm(env, update, chat);
  }
  // Membership bookkeeping comes first, so someone on their way out is not
  // re-learned from the very message that announces they left.
  const leaving = update.message && update.message.left_chat_member;
  if (leaving) {
    // The bot itself leaving needs no cleanup — the whole chat goes quiet.
    if (!leaving.is_bot) await forgetMember(env, chat.id, leaving.id);
    return;
  }
  if (update.chat_member) return handleChatMember(env, update.chat_member);
  // Learn member ids from group traffic: they are the household roster, and an
  // ephemeral (in-group private) nag is addressed to one of them.
  if (from && !from.is_bot && !memberRecorded) await rememberMember(env, chat.id, from);
  if (update.message_reaction) return handleReaction(env, update.message_reaction);
  if (update.callback_query) return handleCallback(env, update.callback_query);

  const msg = update.message;
  if (!msg) return;
  if (msg.new_chat_members && msg.new_chat_members.length) return handleNewMembers(env, msg);
  if (!msg.text) return;
  if (!msg.text.startsWith('/')) return handlePlainText(env, msg);
  const m = msg.text.match(/^\/(\w+)(?:@(\w+))?\s*([\s\S]*)$/);
  if (!m) return;
  const [, cmdRaw, atBot, args] = m;
  // "/list@otherbot" is someone else's command — stay quiet.
  if (atBot) {
    if (!botUsername) {
      const me = await tg(env, 'getMe', {});
      if (me.ok) botUsername = me.result.username;
    }
    if (botUsername && atBot.toLowerCase() !== botUsername.toLowerCase()) return;
  }
  const cmd = cmdRaw.toLowerCase();
  const chatId = msg.chat.id;
  const tz = await getTz(env, chatId);
  const by = senderName(msg.from);
  // Command replies are for the person who typed the command, not the group.
  // A command that itself arrived ephemerally is replied to in kind.
  const ctx = replyCtx(env, chatId, msg.from && msg.from.id, {
    replyEphemeralId: msg.ephemeral_message_id || null,
  });

  // Legacy clients still post commands as ordinary group messages; tidy those
  // away once handled — whether the command succeeded, was refused ("no such
  // chore", "one-offs can't be skipped") or blew up. It used to go only on the
  // success path, so every refused command stayed in the group for good: not
  // deleted, and never recorded for the sweep either. An ephemeral command was
  // never public and carries message_id 0, so there is nothing to delete —
  // guard rather than calling deleteMessage(0). A /chore or /remind is the
  // exception: it stays until its confirmation's ✅ OK, so a misread one can be
  // checked against and copied (cmdRemind). /help and /start once stayed too,
  // beside a public help reply; the reply is private now, so the command was
  // the only trace left in the group — never deleted, and never swept.
  const tidy = !KEEP_UNTIL_OK.has(cmd) && isPublicMessage(msg);
  try {
    let result;
    let handled = true;
    if (cmd === 'start' || cmd === 'help') result = await cmdHelp(env, ctx, args);
    else if (cmd === 'chore') result = await cmdRemind(env, ctx, args, msg, tz, by, true);
    else if (cmd === 'remind') result = await cmdRemind(env, ctx, args, msg, tz, by, false);
    else if (cmd === 'list') result = await cmdList(env, ctx, tz);
    else if (cmd === 'edit') result = await cmdEdit(env, ctx, args, tz);
    else if (cmd === 'delete') result = await cmdDelete(env, ctx, args, by);
    else if (cmd === 'pause') result = await cmdPauseResume(env, ctx, args, tz, true, by);
    else if (cmd === 'resume') result = await cmdPauseResume(env, ctx, args, tz, false, by);
    else if (cmd === 'skip') result = await cmdSkip(env, ctx, args, tz);
    else if (cmd === 'done' && /^(?:together|both)?$/i.test(String(args).trim())) {
      // A bare /done means what a typed "done" does: the one nag in front of
      // the typer, or a "which one?" — not "Which chore? e.g. /done nails".
      // The command itself is tidied below, so the copy carries no id to delete.
      const asText = { ...msg, message_id: 0, text: `done ${String(args).trim()}`.trim() };
      if (!await bareDone(env, asText, ctx)) {
        result = await sendPrivate(env, ctx, '😺 Nothing is nagging right now — <code>/done trash</code> finishes a chore early.');
      }
    } else if (cmd === 'done') result = await cmdDone(env, ctx, args, by, tz);
    else if (cmd === 'poke' || cmd === 'nagall') result = await cmdPoke(env, ctx);
    else if (cmd === 'stats') result = await cmdStats(env, ctx, tz, args);
    // chrono-node is the biggest dependency and only /invite uses it, so the
    // module comes in when the command does, not with every isolate.
    else if (cmd === 'invite') result = await (await import('./invite.js')).cmdInvite(env, ctx, args, tz);
    else if (cmd === 'makestickers') result = await cmdMakeStickers(env, ctx, msg);
    else if (cmd === 'delsticker') result = await cmdDelSticker(env, ctx, args);
    else if (cmd === 'usepack') result = await cmdUsePack(env, ctx, args);
    else if (cmd === 'tagsticker') result = await cmdTagSticker(env, ctx, args);
    else if (cmd === 'autotag') result = await cmdAutoTag(env, ctx, args);
    else if (cmd === 'tags') result = await cmdTags(env, ctx, args);
    else handled = false;

    if (!handled) return sendPrivate(env, ctx, `😿 Unknown command /${esc(cmd)}. Try /help.`);
    return result;
  } catch (err) {
    if (err instanceof ParseError) return sendPrivate(env, ctx, refusalHtml(err));
    console.log(`command /${cmd} failed: ${err.stack || err}`);
    return sendPrivate(env, ctx, '🙀 The cats knocked something over — that didn\'t work. Try again?');
  } finally {
    if (tidy) await deleteMessage(env, chatId, msg.message_id);
  }
}

// The pinned board's one button, by the name it shows today.
const boardButtonName = (env) => (env && env.MINI_APP_URL ? '🐾 Chores' : '⚙️ Manage chores');

function helpText(section = 'home', nicks = [], board = '🐾 Chores') {
  // An example assignee from this household, when it has shortcuts.
  const who = nicks.length ? esc(nicks[nicks.length - 1]) : '@jane';
  if (section === 'schedule') return '⏰ <b>Scheduling examples</b>\n\n' +
    '<code>/chore trash 7pm daily</code>\n' +
    '<code>/chore bins every tue and fri 8pm</code>\n' +
    `<code>/chore ${who} feed cats tmr 7am</code>\n` +
    '<code>/chore rent on the 1st 10am</code>\n' +
    '<code>/chore filter every 3 months from friday</code>\n' +
    '<code>/remind plumber in 20m nag:10m</code> — a reminder, no points\n\n' +
    'Also: <code>weekdays</code>, <code>every other sat</code>, <code>every 2 weeks</code>, ' +
    '<code>monthly</code>, <code>yearly</code>, <code>starting 29 aug</code>, <code>tonight</code>, <code>noon</code>.\n' +
    'Leave out the time for a guided picker. Add <code>rotate</code> for fair-share assignment.' +
    // Shortcuts are per-household config, so the help only mentions the ones
    // this deployment actually has.
    (nicks.length ? `\nAssign with @name or a shortcut: ${nicks.map((n) => `<code>${esc(n)}</code>`).join(', ')}.` : '');
  if (section === 'more') return '🧰 <b>More controls</b>\n\n' +
    '/edit · /delete · /pause · /resume · /skip — by chore name\n' +
    '/poke — re-send everything outstanding\n' +
    '/pause all 14 · /resume all — vacation mode\n' +
    '/stats — leaderboard with This week / Last week / 6 months tabs\n' +
    '/invite dentist tomorrow 3pm at Mount E — get a calendar file to add\n\n' +
    'Reply to a nag with <code>done</code>, <code>done together</code>, ' +
    `<code>done with ${nicks.length ? esc(nicks[0]) : 'jane'}</code>, <code>snooze 2h</code> or <code>snooze till 9pm</code> — or react 👍.`;
  if (section === 'stickers') return '🐾 <b>Sticker tools</b>\n\n' +
    '/usepack &lt;link&gt; · /makestickers · /tags\n' +
    '/tagsticker N latte · /autotag · /delsticker N';
  return '🐱 <b>Latte &amp; Mocha</b>\nNagging chores until someone taps Done.\n\n' +
    '<code>/chore trash 7pm daily</code> — add a chore (counts on the leaderboard)\n' +
    '<code>/remind pick up parcel 5pm</code> — plain reminder, no points\n' +
    '/list — see the chore board\n' +
    '/done trash — mark it done, even before it nags\n\n' +
    `Tap ${board} on the pinned board for everything else, or use the buttons under a nag.`;
}

// Removes the command a confirmation kept on show (keepSourceMessage), when
// its OK or Done is tapped. Only a message the bot itself put on the sweep may
// go: the id is callback data, and the bot has Delete Messages — taken at
// face value it would remove any message in the group.
async function dismissKept(env, chatId, messageId) {
  const kept = await env.DB.prepare(
    'SELECT 1 AS kept FROM sent_messages WHERE chat_id = ? AND message_id = ? AND is_ephemeral = 0'
  ).bind(chatId, messageId).first();
  if (kept) await deleteMessage(env, chatId, messageId);
}

// The firings a digest is about: every id its ✅ and ↩️ buttons still carry,
// so a redraw keeps the same set — nothing that fires later joins a digest
// about yesterday, and a chore just un-done stays on it to be finished again.
// The command a confirmation kept on show, read off the confirmation's own
// OK (okButton). Undo leaves the command standing — the parse was wrong and
// the text is about to be needed — and the lines that replace the
// confirmation carry the id on, so their OK still clears it once it has been
// copied. Rewritten without it, the command had no way out but the sweep.
function keptSourceId(cb) {
  const rows = (cb.message.reply_markup && cb.message.reply_markup.inline_keyboard) || [];
  const hit = rows.flat().map((b) => String(b.callback_data || '').match(/^ok:([0-9]+)$/)).find(Boolean);
  return hit ? +hit[1] : null;
}

function digestIds(cb, tapped) {
  const rows = (cb.message.reply_markup && cb.message.reply_markup.inline_keyboard) || [];
  const carried = rows.flat().map((b) => String(b.callback_data || '').match(/^(?:dg|nd):([0-9]+)$/))
    .filter(Boolean).map((m) => +m[1]);
  return carried.length ? carried : [tapped];
}

// Deep link to a message in a supergroup. Only -100… chats have one, so a
// basic group (or a missing pin) simply gets no button.
function pinnedLink(chatId, msgId) {
  const s = String(chatId);
  if (!msgId || !s.startsWith('-100')) return null;
  return `https://t.me/c/${s.slice(4)}/${msgId}`;
}

function helpButtons(section = 'home', pinUrl = null) {
  const rows = section === 'home' ? [
    [{ text: '⏰ Scheduling examples', callback_data: 'h:schedule' }],
    [{ text: '🧰 More controls', callback_data: 'h:more' }, { text: '🐾 Stickers', callback_data: 'h:stickers' }],
  ] : [[{ text: '← Help', callback_data: 'h:home' }]];
  // Help is ephemeral, so the pinned dashboard is no longer one scroll away —
  // jump to it directly. OK dismisses help like any other note; its own
  // buttons don't cover that.
  if (pinUrl) rows.push([{ text: '📌 Open the chore board', url: pinUrl }]);
  rows.push([{ text: '✅ OK', callback_data: 'ok' }]);
  return { inline_keyboard: rows };
}

async function helpMarkup(env, chatId, section) {
  const row = await env.DB.prepare('SELECT dashboard_msg_id FROM settings WHERE chat_id = ?')
    .bind(chatId).first();
  return helpButtons(section, pinnedLink(chatId, row && row.dashboard_msg_id));
}

async function cmdHelp(env, ctx, args = '') {
  const raw = String(args).trim().toLowerCase();
  const section = ['schedule', 'more', 'stickers'].includes(raw) ? raw : 'home';
  await sendPrivate(env, ctx, helpText(section, [...nicknames(env).keys()], boardButtonName(env)),
    await helpMarkup(env, ctx.chatId, section));
}

// Commands whose message is kept on show until the confirmation's ✅ OK. The
// parser can misread a chore, and once the command was deleted the only copy
// of what was typed went with it — so it now outlives the parse, and goes
// with OK (or the daily sweep, if nobody taps).
const KEEP_UNTIL_OK = new Set(['chore', 'remind']);

// /chore scores on the leaderboard; /remind is an unscored utility reminder.
// Identical behavior otherwise.
async function cmdRemind(env, ctx, args, msg, tz, by, scored) {
  const chatId = ctx.chatId;
  const now = Date.now();
  // The "/" autocomplete menu sends the bare command — ask what to nag about
  // instead of erroring, and treat the reply as the rest of the command. A
  // bare command carries nothing worth keeping, so it goes at once.
  if (!String(args).trim()) {
    if (isPublicMessage(msg)) await deleteMessage(env, chatId, msg.message_id);
    return startTextPrompt(env, ctx, msg.from, scored);
  }
  const sourceMsgId = await keepSourceMessage(env, chatId, msg);
  let p;
  try {
    p = parseRemind(args, msg.text, msg.entities, now, tz, nicknames(env));
  } catch (err) {
    if (err instanceof NoTimeError) return startWizard(env, ctx, err.partial, args, tz, scored, sourceMsgId);
    // A refused chore is the misread one most worth copying back and fixing,
    // so its command stays too — and the refusal's OK takes it away, as a
    // confirmation's does. The dispatcher's plain OK could not, which left the
    // command standing until the daily sweep.
    if (err instanceof ParseError) {
      return sendPrivate(env, ctx, refusalHtml(err), { inline_keyboard: [[okButton(sourceMsgId)]] });
    }
    throw err;
  }
  p.scored = scored;
  p.sourceMsgId = sourceMsgId;
  const { id, html } = await createReminder(env, chatId, p, by, tz);
  await confirmNewChore(env, ctx, by, p, tz, id, html);
  await fireIfDue(env, id, tz, { dueAt: p.firstFireAt });
}

// Plain (non-command) text: a reply acting on a nag, a bare "done", or a
// custom time for a pending draft. Anything else is ignored (normal chat).
async function handlePlainText(env, msg) {
  const chatId = msg.chat.id;
  const ctx = replyCtx(env, chatId, msg.from && msg.from.id, {
    replyEphemeralId: msg.ephemeral_message_id || null,
  });
  const replyRef = msg.reply_to_message ? callbackRef({ message: msg.reply_to_message }) : null;

  // Replying "done" / "snooze 2h" to a nag acts on that nag. An assigned chore
  // nags ephemerally, so the reply target may be in either id space — the flag
  // has to be part of the match, since the two sequences can collide.
  if (replyRef) {
    const { firing, reminder } = await nagByMessage(env, chatId, replyRef);
    if (firing && nagBelongsTo(firing, msg.from)) return handleNagReply(env, msg, firing, null, reminder);
  }
  // Bare "done" works when exactly one chore is nagging; with several, the
  // cats ask which instead of staying confusingly silent. Only nags the typer
  // can see count — the same nagBelongsTo rule as the buttons — or a "done"
  // meant for something else quietly finished another member's private chore
  // in their name, and the "which one?" list named chores they cannot see.
  if (DONE_TEXT.test(msg.text.trim()) && !/^✅/u.test(msg.text.trim()) && await bareDone(env, msg, ctx)) return;
  // The only other text that means anything here is a time for a pending draft.
  return tryDraftTime(env, msg, ctx, replyRef);
}

// A "done" that names no chore — typed on its own, or a bare /done — finishes
// the one nag the typer can see, asks which when there are several, and says
// so when the nags out are someone else's. False when nothing is nagging.
async function bareDone(env, msg, ctx) {
  const chatId = msg.chat.id;
  const all = await env.DB.prepare(
    "SELECT * FROM firings WHERE chat_id = ? AND state = 'nagging'"
  ).bind(chatId).all();
  const mine = all.results.filter((f) => nagBelongsTo(f, msg.from));
  // A chore the household parked (snoozed or postponed to a time still ahead)
  // is not what a bare "done" is about while something else is nagging, and
  // on its own it is asked about rather than taken: the digest leaves parked
  // chores out for the same reason — a ✅ meant for nothing in particular once
  // finished a chore that was not even due.
  const live = mine.filter((f) => !isHouseholdDeferred(f));
  if (live.length === 1) {
    await handleNagReply(env, msg, live[0], ctx);
    return true;
  }
  // Something is nagging, just not at them: an assigned chore nags its
  // assignee privately, so the other housemate typing "done" for it used to
  // get silence. The board is where anyone can finish anyone's chore.
  if (!mine.length) {
    if (!all.results.length) return false;
    await sendPrivate(env, ctx, '😺 Nothing of yours is nagging — to finish someone else’s, use the pinned board.');
    return true;
  }
  const rows = await env.DB.prepare(
    `SELECT id, text FROM reminders WHERE id IN (${mine.map(() => '?').join(',')}) ORDER BY id`
  ).bind(...mine.map((f) => f.reminder_id)).all();
  const names = new Map(rows.results.map((r) => [r.id, r.text]));
  const together = /^dones+(?:together|both)/i.test(msg.text);
  const named = /^dones+with/i.test(msg.text);
  const buttons = mine.filter((f) => names.has(f.reminder_id)).sort((x, y) => x.reminder_id - y.reminder_id)
    .map((f) => [{
      text: `${together ? '🤝' : '✅'} ${clip(names.get(f.reminder_id), 30)}`,
      callback_data: `${together ? 'b' : 'd'}:${f.id}`,
    }]);
  await sendPrivate(env, ctx, named
    ? '😺 Mrow — which one? To credit someone with you, reply to that nag with <code>done with …</code>.'
    : '😺 Mrow — which one?', { inline_keyboard: [...buttons, [okButton()]] });
  // The typed "done" has been answered by the buttons, so it goes, as it does
  // when there is only one nag to finish; it used to stay in the chat.
  if (isPublicMessage(msg)) await deleteMessage(env, chatId, msg.message_id);
  return true;
}

// The live nag a message is, and its chore, in one round trip — what a reply
// or a reaction to a nag acts on. Ephemeral and public ids come from separate
// sequences, so the flag is part of the match.
async function nagByMessage(env, chatId, ref) {
  const where = `f.last_message_id = ? AND f.chat_id = ? AND f.last_message_ephemeral = ? AND f.state = 'nagging'`;
  const args = [ref.id, chatId, ref.ephemeral ? 1 : 0];
  const [f, r] = await env.DB.batch([
    env.DB.prepare(`SELECT f.* FROM firings f WHERE ${where} ORDER BY f.id DESC LIMIT 1`).bind(...args),
    env.DB.prepare(
      `SELECT r.* FROM reminders r JOIN firings f ON f.reminder_id = r.id WHERE ${where} ORDER BY f.id DESC LIMIT 1`
    ).bind(...args),
  ]);
  return { firing: (f.results || [])[0] || null, reminder: (r.results || [])[0] || null };
}

// Any thumbs-up-ish reaction on a live nag message counts as ✅ Done.
const DONE_REACTIONS = new Set(['👍', '✅', '👌', '💯', '🫡', '💪', '❤', '🔥', '🎉']);

async function handleReaction(env, rx) {
  if (!rx.user || rx.user.is_bot) return;
  const hit = (rx.new_reaction || []).some(
    (r) => r.type === 'emoji' && DONE_REACTIONS.has(r.emoji)
  );
  if (!hit) return;
  // Ephemeral and public ids come from separate sequences, so the flag has to
  // be part of the match — same rule as the reply path above.
  const ref = rx.ephemeral_message_id
    ? { id: rx.ephemeral_message_id, ephemeral: true }
    : { id: rx.message_id, ephemeral: false };
  const { firing, reminder } = await nagByMessage(env, rx.chat.id, ref);
  if (!firing || !nagBelongsTo(firing, rx.user)) return;
  if (!reminder) return;
  const tz = await getTz(env, rx.chat.id);
  await completeFiring(env, firing, reminder, senderName(rx.user), tz);
}

// Whether a snooze to `until` would outlive the firing: true only for a
// recurring chore, whose occurrence expires 24h after it fired. A one-off
// never expires, so any snooze it is given is honoured as chosen.
// `r` is the firing's chore, already in hand; a missing one counts as recurring.
function expiresBefore(firing, until, r) {
  if (until < firing.fired_at + EXPIRE_AFTER_MS) return false;
  return !r || r.schedule_kind !== 'once';
}

// A typed snooze, as people say one: "snooze" (an hour), "snooze 20",
// "snooze 2h", "snooze for 1 hour", "snooze an hour", "snooze half an hour",
// "snooze till 9pm", "snooze tomorrow". "snooze 1 hour" used to be refused —
// "hour" was not one of the units. Null when it is not one of these.
export function typedSnooze(text, now, tz) {
  const t = String(text).trim().replace(/\s+/g, ' ');
  if (!/^snooze\b/i.test(t)) return null;
  const rest = t.replace(/^snooze\s*(?:for\s+)?/i, '').replace(/[.!]+$/, '').trim();
  if (!rest) return { until: now + 3600000 };
  if (/^(?:till\s+|until\s+)?(?:tomorrow|tmr|tmrw)$/i.test(rest)) {
    return { until: deferQuietHours(now + 86400000, tz), postpone: true };
  }
  const word = rest.match(/^(half an?|an?|one) hour$/i);
  if (word) return { until: now + (/^half/i.test(word[1]) ? 30 : 60) * 60000 };
  const n = rest.match(/^(\d+)\s*(m|mins?|minutes?|h|hrs?|hours?)?$/i);
  if (n) {
    const ms = n[2] && /^h/i.test(n[2]) ? +n[1] * 3600000 : +n[1] * 60000;
    return +n[1] > 0 ? { until: now + Math.min(ms, 24 * 3600000) } : null;
  }
  const clock = rest.match(/^(?:till|until|to)\s+(.+)$/i);
  if (clock) {
    // The time reads as a chore's would ("9pm", "9:30", "at 7"): the next one.
    try {
      const p = parseRemind(`x ${clock[1]}`, `x ${clock[1]}`, [], now, tz);
      if (p.kind === 'once' && p.text === 'x' && p.firstFireAt > now && p.firstFireAt - now <= 24 * 3600000) {
        return { until: p.firstFireAt };
      }
    } catch { /* not a time */ }
  }
  return null;
}

// `known`: the firing's chore, when the caller read it alongside the firing.
async function handleNagReply(env, msg, firing, ctx, known = undefined) {
  const text = msg.text.trim();
  const chore = async () => (known !== undefined ? known
    : env.DB.prepare('SELECT * FROM reminders WHERE id = ?').bind(firing.reminder_id).first());
  const tz = await getTz(env, msg.chat.id);
  ctx = ctx || replyCtx(env, msg.chat.id, msg.from && msg.from.id);
  // Only a complete done-phrase counts — "done?", "not done ✅?" are chat
  // between people, and completing on those would credit the asker.
  if (DONE_TEXT.test(text)) {
    const reminder = await chore();
    if (!reminder) return;
    let by = senderName(msg.from);
    // "done together"/"done both" credits the whole roster; "done with @jane"
    // credits the replier plus the named helpers.
    const together = /^done\s+(?:together|both)\b/i.test(text);
    const withM = text.match(/^done\s+with\s+(.+?)[\s!.✅👍]*$/iu);
    let roster = null;
    const unknown = [];
    if (together || withM) {
      const household = await householdNames(env, msg.chat.id);
      roster = household.roster;
      let others;
      if (withM) {
        // Only real household members may be credited. A name nobody in this
        // chat answers to is dropped rather than invented: done_by is read back
        // by the leaderboard and the rotation, so a typo used to become a
        // person who then took turns and collected points. A first name counts
        // as answering to it — the roster spells Jane "@janedoe", but nobody
        // types that — unless two housemates share it, which is a guess.
        others = [];
        // The household's shortcuts count too: "done with nic" is how the
        // NICKNAMES map says they are typed, and it once came back as
        // "Not in this household: nic".
        const shortcuts = nicknames(env);
        for (const typed of withM[1].split(/\s*(?:,|&|\+|\band\b)\s*/i).map((s) => s.trim()).filter(Boolean)) {
          let hit = canonName(roster, typed, household.aliases);
          if (!roster.has(hit) && shortcuts.has(typed.toLowerCase())) {
            hit = canonName(roster, shortcuts.get(typed.toLowerCase()), household.aliases);
          }
          if (roster.has(hit)) others.push(hit);
          else unknown.push(typed);
        }
      } else {
        others = [...roster];
      }
      by = creditTogether(by, others);
    }
    const won = await completeFiring(env, firing, reminder, by, tz);
    if (!won) return sendPrivate(env, ctx, '😼 Someone beat you to it — already handled.');
    if (unknown.length) {
      const known = [...roster].sort((a, b) => a.localeCompare(b));
      await sendPrivate(env, ctx,
        `😿 Not in this household: ${unknown.map((n) => `<b>${esc(n)}</b>`).join(', ')} — credited the rest.\n` +
        (known.length ? `Household: ${known.map((n) => esc(n)).join(', ')}`
          : 'Nobody else has been seen in this chat yet.'));
    }
    if (isPublicMessage(msg)) await deleteMessage(env, msg.chat.id, msg.message_id);
    return;
  }
  const sn = typedSnooze(text, Date.now(), tz);
  if (sn) {
    if (firing.snoozes_used >= MAX_SNOOZES) {
      return sendPrivate(env, ctx, `😾 No snoozes left (${MAX_SNOOZES} used) — time to do it.`);
    }
    let until = sn.until;
    const reminder = await chore();
    // Never promise a nag past a recurring chore's 24h expiry — cap at one
    // last call before it. A one-off never expires, so it has nothing to cap.
    // "snooze tomorrow" is a postponement, as 📅 Tomorrow is: fired_at moves
    // with the nag, so the expiry window moves too.
    if (!sn.postpone && expiresBefore(firing, until, reminder)) until = firing.fired_at + EXPIRE_AFTER_MS - 60000;
    // snoozed_until is the household's choice on record; resume and the
    // editor honour it only while next_nag_at still equals it. snoozed_by
    // is who chose it, for any later redraw of the 😴 card.
    const res = await env.DB.prepare(
      `UPDATE firings SET snoozes_used = snoozes_used + 1, next_nag_at = ?, snoozed_until = ?, snoozed_by = ?
         ${sn.postpone ? ', fired_at = ?' : ''}
       WHERE id = ? AND state = 'nagging' AND snoozes_used < ?`
    ).bind(until, until, senderName(msg.from), ...(sn.postpone ? [until] : []), firing.id, MAX_SNOOZES).run();
    if (!res.meta.changes) return sendPrivate(env, ctx, '😼 That one was already handled.');
    await updateDashboard(env, firing.chat_id); // the board shows it parked
    if (reminder && firing.last_message_id) {
      await editNag(env, firing, snoozedHtml(reminder, until, senderName(msg.from), tz, sn.postpone),
        snoozedButtons(firing.id, isScored(firing)));
      if (isPublicMessage(msg)) await deleteMessage(env, msg.chat.id, msg.message_id);
      return;
    }
    return sendPrivate(env, ctx, `😴 Snoozed until ${fmtWhen(until, tz)}.`);
  }
  // A reply that starts with "snooze" but didn't parse must not die silently —
  // the person walks away sure it's snoozed while the re-nag stays scheduled.
  if (/^snooze\b/i.test(text)) {
    return sendPrivate(env, ctx,
      '😿 The cats couldn\'t read that snooze — try <code>snooze 2h</code>, <code>snooze till 9pm</code> or ' +
      '<code>snooze tomorrow</code>, or tap 😴 Snooze… under the nag.');
  }
}

async function cmdList(env, ctx, tz) {
  const html = await choreListHtml(env, ctx.chatId, tz);
  if (!html) return sendPrivate(env, ctx, '😺 No chores on the list. Add one with <code>/chore trash 7pm daily</code>.');
  // Doubles as the manual board repair: if the pin was lost — a group upgrade,
  // someone unpinning by hand — /list puts it back.
  await updateDashboard(env, ctx.chatId);
  await sendPrivateLong(env, ctx, html);
}

async function cmdEdit(env, ctx, args, tz) {
  const r = await findReminder(env, ctx.chatId, args, 'edit');
  await sendPrivate(env, ctx, editorText(r, tz), await editorButtons(env, r));
}

// A deletion changes the household's board, like vacation mode, so the log
// is public however it was triggered — the typed command used to log
// privately, leaving its Undo with the deleter alone while the 🗑 button and
// Manage logged to the group.
async function cmdDelete(env, ctx, args, by) {
  const r = await findReminder(env, ctx.chatId, args);
  await deleteReminder(env, r, null, by);
}

// Vacation mode: "/pause all 14" mutes everything for N days (auto-resumes),
// "/resume all" ends it early. Wake-up rolls recurring chores to their next
// natural slot and quietly clears their pre-vacation nags — no flood on
// return — while a one-off's nag is kept, since nothing else stands in for it.
async function cmdPauseResumeAll(env, ctx, args, tz, pause) {
  const chatId = ctx.chatId;
  if (!pause) {
    const st = await env.DB.prepare('SELECT paused_until FROM settings WHERE chat_id = ?').bind(chatId).first();
    if (!st || !st.paused_until || st.paused_until <= Date.now()) {
      return sendPrivate(env, ctx, '😺 Chores aren\'t paused — nothing to resume.');
    }
    return wakeChat(env, chatId, tz);
  }
  const days = +(String(args).match(/(\d+)/) || [])[1];
  if (!days || days < 1 || days > 90) {
    throw new ParseError('For how long? e.g. /pause all 14 (days, 1–90).');
  }
  const until = Date.now() + days * 86400000;
  await env.DB.prepare(
    'INSERT INTO settings (chat_id, paused_until) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET paused_until = excluded.paused_until'
  ).bind(chatId, until).run();
  const active = await env.DB.prepare(
    "SELECT * FROM firings WHERE chat_id = ? AND state = 'nagging'"
  ).bind(chatId).all();
  for (const firing of active.results) {
    const reminder = await env.DB.prepare('SELECT * FROM reminders WHERE id = ?').bind(firing.reminder_id).first();
    if (reminder) await showPausedCard(env, firing, reminder, 'the household', tz, until);
  }
  await updateDashboard(env, chatId);
  // Vacation mode changes the household's state, not just the caller's — this
  // one stays public on purpose.
  await sendMessage(env, chatId,
    `✈️ All chores paused until ${fmtLocal(until, tz)}. The cats will nap on your luggage.\n/resume all to end early.`);
}

async function cmdPauseResume(env, ctx, args, tz, pause, by) {
  if (/^all\b/i.test(String(args).trim())) return cmdPauseResumeAll(env, ctx, args, tz, pause);
  const r = await findReminder(env, ctx.chatId, args, pause ? 'pause' : 'resume');
  // A no-op is not a transition. setReminderPaused returns early when there is
  // nothing to resume, and the reply used to announce "▶️ Resumed … — next …"
  // for a chore whose clock had never stopped.
  if (pause && r.paused) {
    return sendPrivate(env, ctx, `😺 <b>${esc(r.text)}</b> is already paused.`);
  }
  if (!pause && !r.paused) {
    return sendPrivate(env, ctx, `😺 <b>${esc(r.text)}</b> isn't paused.`);
  }
  const state = await setReminderPaused(env, r, pause, tz, by);
  if (pause) {
    // The way back is a tap, not a command to retype.
    return sendPrivate(env, ctx, `⏸️ Paused <b>${esc(r.text)}</b> — no nags until it's resumed.`,
      { inline_keyboard: [[{ text: '▶️ Resume', callback_data: `rs:${r.id}` }, okButton()]] });
  }
  return sendPrivate(env, ctx, resumedLine(r, state, tz));
}

// What a resume did, as /resume and a ▶️ Resume tap on its reply both say it.
function resumedLine(r, state, tz) {
  if (state.firing) return `▶️ Resumed <b>${esc(r.text)}</b> — it's nagging again.`;
  if (state.next != null) return `▶️ Resumed <b>${esc(r.text)}</b> — next ${fmtWhen(state.next, tz)}.`;
  return `😼 <b>${esc(r.text)}</b> already fired and has nothing scheduled — /delete it, or add it again with /chore.`;
}

async function cmdSkip(env, ctx, args, tz) {
  const chatId = ctx.chatId;
  const r = await findReminder(env, chatId, args, 'skip');
  if (r.schedule_kind === 'once' || !r.next_fire_at) {
    throw new ParseError(`"${r.text}" is a one-off — use /delete ${r.text} instead.`);
  }
  const next = nextOccurrence(r.schedule_kind, JSON.parse(r.schedule_detail), r.next_fire_at, tz);
  // Compare-and-swap against the cron's fire claim, like every other move of
  // next_fire_at: a skip that read the slot just before it fired used to write
  // the value the cron had already written and report a skip that did nothing.
  const res = await env.DB.prepare('UPDATE reminders SET next_fire_at = ? WHERE id = ? AND next_fire_at = ?')
    .bind(next, r.id, r.next_fire_at).run();
  if (!res.meta.changes) {
    return sendPrivate(env, ctx, `😼 <b>${esc(r.text)}</b> just fired — it is nagging now, so there is nothing to skip.`);
  }
  await updateDashboard(env, chatId);
  // Which one went, and when the chore comes back, both as the board says them.
  await sendPrivate(env, ctx,
    `⏭️ Skipped <b>${esc(r.text)}</b> (${fmtWhen(r.next_fire_at, tz)})\nNext: ${fmtWhen(next, tz)}`);
}

async function cmdDone(env, ctx, args, by, tz) {
  const chatId = ctx.chatId;
  const target = String(args).replace(/\b(together|both)\b/i, '').trim();
  const r = await findReminder(env, chatId, target, 'done');
  const firing = await env.DB.prepare(
    "SELECT * FROM firings WHERE reminder_id = ? AND state = 'nagging' ORDER BY id DESC LIMIT 1"
  ).bind(r.id).first();
  let credit = by;
  if (/\b(together|both)\b/i.test(String(args))) {
    const roster = await householdRoster(env, chatId);
    credit = creditTogether(by, [...roster]);
  }
  if (!firing) {
    if (r.paused) throw new ParseError(`"${r.text}" is paused — /resume ${r.text} first.`);
    if (r.next_fire_at == null) {
      throw new ParseError(`"${r.text}" has nothing scheduled — /delete it, or add it again with /chore.`);
    }
    const early = await completeEarly(env, r, credit, tz);
    if (!early) return sendPrivate(env, ctx, '😼 Someone beat you to it — already handled.');
    return;
  }
  const won = await completeFiring(env, firing, r, credit, tz);
  if (!won) return sendPrivate(env, ctx, '😼 Someone beat you to it — already handled.');
}

// /poke: re-send every outstanding nag right now, loud. Doesn't advance the
// escalation ladder or consume snoozes — it's a manual "oi, everyone".
async function cmdPoke(env, ctx) {
  const chatId = ctx.chatId;
  const st = await env.DB.prepare('SELECT paused_until FROM settings WHERE chat_id = ?').bind(chatId).first();
  if (st && st.paused_until && st.paused_until > Date.now()) {
    return sendPrivate(env, ctx, '✈️ The household is paused — /resume all before poking chores.');
  }
  const { results } = await env.DB.prepare(
    `SELECT f.* FROM firings f JOIN reminders r ON r.id = f.reminder_id
     WHERE f.chat_id = ? AND f.state = 'nagging' AND r.paused = 0`
  ).bind(chatId).all();
  if (!results.length) {
    return sendPrivate(env, ctx, '😺 Nothing is outstanding — /list for what\'s coming up.');
  }
  const tz = await getTz(env, chatId);
  for (const f of results) {
    const r = await env.DB.prepare('SELECT * FROM reminders WHERE id = ?').bind(f.reminder_id).first();
    if (!r) continue;
    if (f.last_message_id) await deleteNag(env, f);
    if (f.last_sticker_id) await deleteMessage(env, nagChat(f), f.last_sticker_id);
    // The card comes back as whatever it already was. Re-sending everything
    // as a plain nag handed an overdue one-off a Snooze it can only refuse,
    // and turned a 😴 notice into a nag while its snooze was still in force —
    // which ↩️ Back then read as a live nag.
    const card = firingCard(r, f, tz);
    const ref = await sendNag(env, f, card[0], card[1]);
    // Bound to the message id this poke read: a cron re-nag landing in the
    // same second also re-sends, and two unconditional writes left one card
    // untracked — live buttons on a nag nothing would ever clean up.
    const upd = await env.DB.prepare(
      `UPDATE firings SET last_message_id = ?, last_message_ephemeral = ?, last_sticker_id = NULL
        WHERE id = ? AND state = 'nagging' AND last_message_id IS ? AND nag_user_id IS ?`
    ).bind(ref ? ref.id : null, ref && ref.ephemeral ? 1 : 0, f.id, f.last_message_id,
      f.nag_user_id ?? null).run();
    if (!upd.meta.changes && ref) await deleteNagRef(env, f, ref);
  }
}

// A nag button's firing and its chore, scoped to the chat the tap came from,
// in one round trip: every nag button needs both, and reading the chore only
// once the firing was back put a second D1 trip in front of every toast.
async function tappedFiring(env, firingId, chatId) {
  const [f, r] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM firings WHERE id = ? AND chat_id = ?').bind(firingId, chatId),
    env.DB.prepare(
      `SELECT r.* FROM reminders r JOIN firings f ON f.reminder_id = r.id AND r.chat_id = f.chat_id
       WHERE f.id = ? AND f.chat_id = ?`
    ).bind(firingId, chatId),
  ]);
  return { firing: f.results[0] || null, reminder: r.results[0] || null };
}

async function handleCallback(env, cb) {
  // The tap authorizes a private reply for the next 15 seconds even if the bot
  // has no other recent contact with this member.
  const ctx = replyCtx(env, cb.message && cb.message.chat.id, cb.from && cb.from.id, {
    callbackQueryId: cb.id,
  });
  const ref = callbackRef(cb);
  const data = cb.data || '';
  if (!cb.message) return answerCallback(env, cb.id, '');

  // Each button family routes to the module that owns it; anything
  // unrecognized is answered blank so the button never spins.
  if (data.startsWith('e:')) return handleEditorCallback(env, cb, ctx, ref);
  if (data.startsWith('m:')) return handleManageCallback(env, cb);
  if (data.startsWith('w:')) return handleWizardCallback(env, cb, ctx, ref);
  if (data.startsWith('st:')) return handleStatsCallback(env, cb, ctx, ref);

  const help = data.match(/^h:(home|schedule|more|stickers)$/);
  if (help) {
    // Nothing to decide: the spinner stops at once, the page turns after.
    await answerCallback(env, cb.id, '');
    await editRef(env, ctx, cb.message.chat.id, ref,
      helpText(help[1], [...nicknames(env).keys()], boardButtonName(env)), await helpMarkup(env, cb.message.chat.id, help[1]));
    return;
  }

  // Undo a just-created reminder: remove it and any live nag it produced. The
  // confirmation keeps this button for up to a day, and the chore may have
  // fired several times by then — so it goes through the same trash stash as
  // /delete, and the Undone line carries Restore, rather than being the one
  // removal in the bot with no way back.
  const um = data.match(/^u:(\d+)$/);
  if (um) {
    const r = await env.DB.prepare('SELECT * FROM reminders WHERE id = ? AND chat_id = ?')
      .bind(+um[1], cb.message.chat.id).first();
    if (!r) return answerCallback(env, cb.id, 'Already gone.');
    // Said as soon as it is true; the cards, the line and the board follow.
    const trashId = await removeReminder(env, r, { onClaim: () => answerCallback(env, cb.id, 'Undone') });
    await editRef(env, ctx, r.chat_id, ref, `↩️ Undone — <s>${esc(r.text)}</s>`, { inline_keyboard: [[
      { text: '↩️ Restore', callback_data: `t:${trashId}` },
      okButton(keptSourceId(cb)),
    ]] });
    await updateDashboard(env, r.chat_id);
    return;
  }

  // Done from a creation confirmation. Completes whatever the chore is up to:
  // the live nag if it has fired, otherwise the upcoming occurrence (done
  // early), exactly as the board's Manage → Done does. Scoped to the chat the
  // tap came from like every other lookup here. The receipt replaces the
  // confirmation and keeps its OK, so the kept command still goes with it.
  const cm = data.match(/^c:([0-9]+)(?::([0-9]+))?$/);
  if (cm) {
    // The chore and its live nag in one round trip; the claim is the second.
    const [rows, live] = await env.DB.batch([
      env.DB.prepare('SELECT * FROM reminders WHERE id = ? AND chat_id = ?').bind(+cm[1], cb.message.chat.id),
      env.DB.prepare(
        "SELECT * FROM firings WHERE reminder_id = ? AND chat_id = ? AND state = 'nagging' ORDER BY id DESC LIMIT 1"
      ).bind(+cm[1], cb.message.chat.id),
    ]);
    const r = (rows.results || [])[0] || null;
    if (!r) return answerCallback(env, cb.id, 'Already gone.');
    const tz = await getTz(env, r.chat_id);
    const credit = senderName(cb.from);
    const firing = (live.results || [])[0] || null;
    let won;
    const onClaim = async () => {
      await answerCallback(env, cb.id, 'Purrs 😻');
      // The completion draws its own receipt — the card's, or the done-early
      // line — with ↩️ Not done on it. Turning this confirmation into a second
      // receipt left two 😻 lines for one tap, so it goes instead, and takes the
      // command it kept with it: Done is the strongest OK there is for a parse.
      await Promise.all([
        cm[2] ? dismissKept(env, r.chat_id, +cm[2]) : null,
        deleteRef(env, ctx, r.chat_id, ref),
      ]);
    };
    if (firing) won = await completeFiring(env, firing, r, credit, tz, { onClaim });
    else if (r.paused || r.next_fire_at == null) return answerCallback(env, cb.id, 'This chore is not nagging now.');
    else won = await completeEarly(env, r, credit, tz, { onClaim });
    if (!won) return answerCallback(env, cb.id, 'Already handled 👍');
    return;
  }

  // Done from the 8am digest. The digest names what was left hanging, and the
  // person it names is the one reading it, so the line that told them must
  // let them answer — it used to carry only OK. Completes the firing the way
  // the nag card's Done does (so the card, receipt and board all follow),
  // then redraws the digest from the ids its buttons still carry, so the
  // other lines stay put and the finished one drops off. Anyone in the
  // household may finish anyone's chore here, as on the board's Manage.
  const dg = data.match(/^dg:([0-9]+)$/);
  if (dg) {
    const chatId = cb.message.chat.id;
    const by = senderName(cb.from);
    // The claim goes with the reads it needs, as a nag's ✅ does (doneClaim):
    // this chat's firing, still nagging, with its chore. Anyone may finish it.
    const claim = doneClaim(env, +dg[1], by, Date.now(), {
      chatId, needReminder: true,
      extra: [env.DB.prepare(
        `SELECT r.* FROM reminders r JOIN firings f ON f.reminder_id = r.id AND r.chat_id = f.chat_id
         WHERE f.id = ? AND f.chat_id = ?`
      ).bind(+dg[1], chatId)],
    });
    const [got, tz] = await Promise.all([runDoneClaim(env, claim), tzOrDefault(env, chatId)]);
    const firing = got.firing && got.firing.chat_id === chatId ? got.firing : null;
    const r = (got.extra[0].results || [])[0] || null;
    const redraw = async () => {
      const view = await digestView(env, chatId, digestIds(cb, +dg[1]));
      await editRef(env, ctx, chatId, ref, view.html, view.markup);
    };
    if (got.won && firing && r) {
      await completeFiring(env, firing, r, by, tz, {
        claimed: got,
        onClaim: () => answerCallback(env, cb.id, 'Purrs 😻 — ↩️ Not done is right there if that was a slip'),
        // The digest is redrawn below with the chore struck through and its
        // ↩️ Not done: that is the receipt, so a private nag gets no second one.
        receipt: false,
      });
    } else {
      if (firing && firing.state === 'nagging' && !r) return answerCallback(env, cb.id, 'That one is gone.');
      await answerCallback(env, cb.id, 'Already handled 👍');
    }
    await redraw();
    return;
  }

  // Take a Done back. The receipt it came from is redrawn by undoCompletion
  // when it is the nag card itself; a digest is redrawn from the ids its
  // buttons carry, like a ✅ on it; a public receipt of a private nag just
  // says so. Scoped to the chat like every firing lookup here.
  const nd = data.match(/^nd:([0-9]+)$/);
  if (nd) {
    const chatId = cb.message.chat.id;
    // The firing, its chore and its stash in one round trip (undoReads).
    const [{ firing, read }, tz] = await Promise.all([undoReads(env, +nd[1], chatId), getTz(env, chatId)]);
    if (!firing || firing.state !== 'done') return answerCallback(env, cb.id, 'Nothing to take back.');
    const by = senderName(cb.from);
    const digest = String(cb.message.text || '').startsWith('☀️');
    const card = ref && ref.id === firing.last_message_id && ref.ephemeral === Boolean(firing.last_message_ephemeral);
    const res = await undoCompletion(env, firing, by, tz, {
      onClaim: () => answerCallback(env, cb.id, 'Taken back ↩️'),
      announce: digest || card,
      read,
    });
    if (!res.ok) {
      return answerCallback(env, cb.id,
        res.why === 'gone' ? 'That chore is gone for good.' : 'Too late to take that back.');
    }
    if (digest) {
      const view = await digestView(env, chatId, digestIds(cb, firing.id));
      await editRef(env, ctx, chatId, ref, view.html, view.markup);
    } else if (!card) {
      await editRef(env, ctx, chatId, ref,
        `↩️ <b>${esc(firing.reminder_text || 'chore')}</b> — not done after all, says ${esc(by)}.`,
        { inline_keyboard: [[okButton()]] });
    }
    return;
  }

  // Take a Done early back: the receipt it sits on says so.
  const ne = data.match(/^ne:([0-9]+)$/);
  if (ne) {
    const chatId = cb.message.chat.id;
    const [{ firing, read }, tz] = await Promise.all([undoReads(env, +ne[1], chatId), getTz(env, chatId)]);
    if (!firing || firing.state !== 'done') return answerCallback(env, cb.id, 'Nothing to take back.');
    const by = senderName(cb.from);
    const res = await undoEarly(env, firing, by, tz, {
      onClaim: () => answerCallback(env, cb.id, 'Taken back ↩️'),
      announce: false,
      read,
    });
    if (!res.ok) {
      return answerCallback(env, cb.id,
        res.why === 'gone' ? 'That chore is gone for good.' : 'Too late to take that back.');
    }
    await editRef(env, ctx, chatId, ref,
      `↩️ <b>${esc(firing.reminder_text || 'chore')}</b> — not done after all, says ${esc(by)}.`,
      { inline_keyboard: [[okButton()]] });
    return;
  }

  // Undo a /delete: restore the stashed reminder row.
  const tr = data.match(/^t:(\d+)$/);
  if (tr) {
    // The stash is read and claimed in one round trip: two taps on the same
    // Undo used to restore twice. Only a stashed chore can be claimed — a
    // nested chore's reset record (`_cover`, nesting.js) lives in trash too,
    // and ↩️ Not done needs it.
    const [read, claim] = await env.DB.batch([
      env.DB.prepare('SELECT * FROM trash WHERE id = ? AND chat_id = ?').bind(+tr[1], cb.message.chat.id),
      env.DB.prepare(
        `DELETE FROM trash WHERE id = ? AND chat_id = ? AND json_extract(payload, '$._cover') IS NULL
           AND json_extract(payload, '$.id') IS NOT NULL`
      ).bind(+tr[1], cb.message.chat.id),
    ]);
    const row = (read.results || [])[0];
    if (!row) return answerCallback(env, cb.id, 'Too late — that one is gone for good.');
    const r = JSON.parse(row.payload);
    if (r._cover != null || r.id == null) return answerCallback(env, cb.id, 'Too late — that one is gone for good.');
    if (!claim.meta.changes) return answerCallback(env, cb.id, 'Already restored.');
    await restoreReminder(env, r);
    await answerCallback(env, cb.id, 'Restored 😺');
    await updateDashboard(env, r.chat_id);
    // An OK to put the line away — and, after an Undo, the command it kept.
    await editRef(env, ctx, r.chat_id, ref, `↩️ Restored <b>${esc(r.text)}</b>`,
      { inline_keyboard: [[okButton(keptSourceId(cb))]] });
    return;
  }

  // Upgrade a done receipt's credit to the whole household — the fix for
  // tapping Done early solo when the work was actually shared.
  const gm = data.match(/^g:(\d+)$/);
  if (gm) {
    // Scoped to the chat the tap came from, like every other firing lookup
    // here: an id from another household must not be actionable.
    // Everything the widened receipt needs comes back with the firing, in one
    // round trip; the credit's write is the second, and the toast follows it.
    const chatId = cb.message.chat.id;
    const [[f, m, n, c], tz] = await Promise.all([env.DB.batch([
      env.DB.prepare("SELECT * FROM firings WHERE id = ? AND chat_id = ? AND state = 'done'").bind(+gm[1], chatId),
      env.DB.prepare('SELECT username, first_name FROM members WHERE chat_id = ?').bind(chatId),
      env.DB.prepare(
        'SELECT r.next_fire_at FROM reminders r JOIN firings f ON f.reminder_id = r.id WHERE f.id = ? AND f.chat_id = ?'
      ).bind(+gm[1], chatId),
      coveredStatement(env, chatId, +gm[1]),
    ]), getTz(env, chatId)]);
    const firing = (f.results || [])[0];
    if (!firing) return answerCallback(env, cb.id, 'That one is gone.');
    const names = String(firing.done_by || '').split(CREDIT_SEP).filter(Boolean);
    const { roster } = householdNamesFrom(m.results);
    const credit = creditTogether(names[0] || senderName(cb.from), [...names.slice(1), ...roster]);
    await env.DB.prepare("UPDATE firings SET done_by = ? WHERE id = ? AND state = 'done'")
      .bind(credit, firing.id).run();
    await answerCallback(env, cb.id, 'Shared credit 🤝');
    const next = (n.results || [])[0] || null;
    const covered = coveredNamesFrom((c.results || [])[0] || null);
    // Same receipt as the one being widened, so ↩️ Not done stays on it.
    const receipt = earlyReceipt(firing.reminder_text || 'chore', credit, next && next.next_fire_at, tz, firing.id,
      covered);
    await editRef(env, ctx, firing.chat_id, ref, receipt.html, receipt.markup);
    return;
  }

  // Dismiss a log line. Works on either kind of message, since deleteRef picks
  // the method from the ref rather than assuming a public message id. An OK
  // that names a source message is a chore confirmation: the command it was
  // typed in was kept on show for exactly this tap, and goes with it.
  // OK on a 😴 card: put it away while the chore stays parked. The firing lets
  // go of the card first (bound to the card it holds, so a re-nag that got
  // there first keeps its own), and the cron sends a fresh nag when the snooze
  // is up. A card that is no longer the firing's own just goes.
  const zh = data.match(/^zh:([0-9]+)$/);
  if (zh) {
    const firing = await env.DB.prepare('SELECT * FROM firings WHERE id = ? AND chat_id = ?')
      .bind(+zh[1], cb.message.chat.id).first();
    if (firing && !nagBelongsTo(firing, cb.from)) return answerCallback(env, cb.id, NOT_YOUR_NAG);
    const ownCard = firing && firing.state === 'nagging' && ref
      && firing.last_message_id === ref.id && Boolean(firing.last_message_ephemeral) === ref.ephemeral;
    if (ownCard && !isHouseholdDeferred(firing)) {
      await answerCallback(env, cb.id, 'It’s nagging again — card updated');
      const rem = await env.DB.prepare('SELECT * FROM reminders WHERE id = ?').bind(firing.reminder_id).first();
      if (rem) {
        const [html, buttons] = firingCard(rem, firing, await getTz(env, firing.chat_id));
        await editNag(env, firing, html, buttons);
      }
      return;
    }
    if (ownCard) {
      const release = await env.DB.prepare(
        `UPDATE firings SET last_message_id = NULL, last_message_ephemeral = 0, last_sticker_id = NULL
         WHERE id = ? AND state = 'nagging' AND last_message_id = ? AND last_message_ephemeral = ?`
      ).bind(firing.id, ref.id, ref.ephemeral ? 1 : 0).run();
      if (!release.meta.changes) return answerCallback(env, cb.id, 'Already moved on 👍');
      if (firing.last_sticker_id) await deleteMessage(env, nagChat(firing), firing.last_sticker_id);
    }
    await deleteRef(env, ctx, cb.message.chat.id, ref);
    if (!ownCard) return answerCallback(env, cb.id, '');
    const tz = await getTz(env, firing.chat_id);
    return answerCallback(env, cb.id, `Hidden — back ${fmtWhen(firing.next_nag_at, tz)} 😴`);
  }

  // The spinner stops at once; the message itself goes a moment later, and the
  // command it kept goes alongside it.
  const okm = data.match(/^ok(?::(\d+))?$/);
  if (okm) {
    await answerCallback(env, cb.id, '');
    await Promise.all([
      okm[1] ? dismissKept(env, cb.message.chat.id, +okm[1]) : null,
      deleteRef(env, ctx, cb.message.chat.id, ref),
    ]);
    return;
  }

  // 🗑 on a nag removes the chore outright. One tap, because the log line it
  // leaves carries Undo — a mis-tap is recoverable for a day.
  const xm = data.match(/^x:(\d+)$/);
  if (xm) {
    // The delete is sent with the reads that used to come before it, as a
    // Done is: one round trip after the intake (deleteTapped).
    const { won, firing, reminder: r, removed } = await deleteTapped(env, +xm[1], cb.message.chat.id, cb.from.id);
    if (!won) {
      if (!firing) return answerCallback(env, cb.id, 'Already gone.');
      if (!nagBelongsTo(firing, cb.from)) return answerCallback(env, cb.id, NOT_YOUR_NAG);
      return answerCallback(env, cb.id, 'That chore is already gone.');
    }
    // No ctx: the log is public on purpose, whoever the nag belonged to.
    await deleteReminder(env, r, null, senderName(cb.from), {
      removed,
      onClaim: () => answerCallback(env, cb.id, 'Deleted 🗑 — tap ↩️ Undo in the chat if that was a slip.'),
    });
    return;
  }

  // ▶️ Resume on a paused chore's card. Scoped to the chat like every lookup.
  const rs = data.match(/^rs:([0-9]+)$/);
  if (rs) {
    const r = await env.DB.prepare('SELECT * FROM reminders WHERE id = ? AND chat_id = ?')
      .bind(+rs[1], cb.message.chat.id).first();
    if (!r) return answerCallback(env, cb.id, 'That chore is already gone.');
    if (!r.paused) return answerCallback(env, cb.id, 'It isn’t paused.');
    await answerCallback(env, cb.id, 'Resumed ▶️');
    const tz = await getTz(env, r.chat_id);
    const state = await setReminderPaused(env, r, false, tz, senderName(cb.from));
    // The ⏸️ card is redrawn as the nag it is again; any other message the
    // button sat on — /pause's own reply — becomes the resumed line.
    const f = state.firing;
    const onCard = f && ref && f.last_message_id === ref.id && Boolean(f.last_message_ephemeral) === ref.ephemeral;
    if (!onCard) await editRef(env, ctx, r.chat_id, ref, resumedLine(r, state, tz), { inline_keyboard: [[okButton()]] });
    return;
  }

  // Snooze preset picked (or Back to the main buttons).
  const zm = data.match(/^z:(\d+):(\w+)$/);
  if (zm) {
    if (!SNOOZE_CODES.includes(zm[2])) return answerCallback(env, cb.id, 'That option is not on this menu.');
    if (zm[2] === 'b') {
      const { firing, reminder } = await tappedFiring(env, +zm[1], cb.message.chat.id);
      if (!firing || firing.state !== 'nagging') return answerCallback(env, cb.id, 'Already handled 👍');
      if (!nagBelongsTo(firing, cb.from)) return answerCallback(env, cb.id, NOT_YOUR_NAG);
      // Back to whatever the firing is now — decided from its state, like
      // every other redraw, not from the card's own text: a 😴 card whose
      // snooze the cron had already spent read as still snoozed, and a card
      // that crossed the 24h mark with its menu open came back offering a
      // Snooze the next tap only refused. An ephemeral message has no
      // reply-markup-only edit, so its text is re-rendered alongside.
      const rem = reminder;
      if (rem) {
        const [html, buttons] = firingCard(rem, firing, await getTz(env, firing.chat_id));
        if (isEphemeralNag(firing)) await editNag(env, firing, html, buttons);
        else await editReplyMarkup(env, nagChat(firing), cb.message.message_id, buttons);
      }
      return answerCallback(env, cb.id, '');
    }
    return snoozeTapped(env, cb, +zm[1], zm[2]);
  }

  const m = data.match(/^([dsb]):(\d+)$/);
  if (!m) return answerCallback(env, cb.id, '');
  if (m[1] === 'd' || m[1] === 'b') return doneTapped(env, cb, +m[2], m[1] === 'b');
  const { firing, reminder } = await tappedFiring(env, +m[2], cb.message.chat.id);
  if (!firing || firing.state !== 'nagging') {
    return answerCallback(env, cb.id, 'Already handled 👍');
  }
  if (!nagBelongsTo(firing, cb.from)) return answerCallback(env, cb.id, NOT_YOUR_NAG);
  if (!reminder) {
    // Same compare-and-swap as every other state change: the row was read a
    // moment ago, and a cron tick or a second tap may have moved it since.
    await env.DB.prepare(
      "UPDATE firings SET state = 'expired', next_nag_at = NULL WHERE id = ? AND state = 'nagging'"
    ).bind(firing.id).run();
    return answerCallback(env, cb.id, 'That reminder was deleted.');
  }
  const tz = await getTz(env, firing.chat_id);

  // Snooze tapped: swap the keyboard for duration presets.
  if (firing.snoozes_used >= MAX_SNOOZES) {
    return answerCallback(env, cb.id, `😾 No snoozes left (${MAX_SNOOZES} used) — time to do it.`);
  }
  if (isEphemeralNag(firing)) {
    // No reply-markup-only edit for an ephemeral message, so the text is
    // re-rendered too — and it has to stay the card it already is. Rendering
    // a parked chore's 😴 notice as a nag turned "🕐 Change snooze → ↩️ Back"
    // into a live nag, since Back reads the card's own text to pick a keyboard.
    // firingCard picks the text, so an overdue one-off keeps its ⏰ line.
    const [html] = firingCard(reminder, firing, tz);
    await editNag(env, firing, html, snoozeButtons(firing.id, tz));
  } else {
    await editReplyMarkup(env, nagChat(firing), cb.message.message_id, snoozeButtons(firing.id, tz));
  }
  return answerCallback(env, cb.id, '');
}

const tzOrDefault = (env, chatId) => getTz(env, chatId).catch((e) => {
  console.log(`timezone read failed, using the default: ${e}`);
  return 'Asia/Singapore';
});

// ✅ Done and 🤝 Done together on a nag: the claim goes with the reads it
// needs, so the toast is one round trip after the webhook's own intake. The
// claim itself refuses what the old reads refused — another household's
// firing, another member's private nag, a chore that has gone — and only when
// it loses are the rows it read back looked at to say why. Together's credit
// needs the roster, which rides in the batch; the claim records the tapper
// and the wider credit is written straight after the toast, before anything
// reads it back.
async function doneTapped(env, cb, firingId, together) {
  const chatId = cb.message.chat.id;
  const by = senderName(cb.from);
  const claim = doneClaim(env, firingId, by, Date.now(), {
    chatId, userId: cb.from.id, needReminder: true,
    extra: [
      env.DB.prepare(
        `SELECT r.* FROM reminders r JOIN firings f ON f.reminder_id = r.id AND r.chat_id = f.chat_id
         WHERE f.id = ? AND f.chat_id = ?`
      ).bind(firingId, chatId),
      ...(together ? [env.DB.prepare('SELECT username, first_name FROM members WHERE chat_id = ?').bind(chatId)] : []),
    ],
  });
  // The timezone rides beside a write, so a failed read must not turn a Done
  // that happened into an error: it falls back to the default.
  const [got, tz] = await Promise.all([runDoneClaim(env, claim), tzOrDefault(env, chatId)]);
  // The read-back is by id alone; a firing from another chat is not this tap's.
  const firing = got.firing && got.firing.chat_id === chatId ? got.firing : null;
  const reminder = (got.extra[0].results || [])[0] || null;
  if (!got.won || !firing) {
    if (!firing || firing.state !== 'nagging') return answerCallback(env, cb.id, 'Already handled 👍');
    if (!nagBelongsTo(firing, cb.from)) return answerCallback(env, cb.id, NOT_YOUR_NAG);
    if (!reminder) {
      // Same compare-and-swap as every other state change: the row was read a
      // moment ago, and a cron tick or a second tap may have moved it since.
      await env.DB.prepare(
        "UPDATE firings SET state = 'expired', next_nag_at = NULL WHERE id = ? AND state = 'nagging'"
      ).bind(firing.id).run();
      return answerCallback(env, cb.id, 'That reminder was deleted.');
    }
    return answerCallback(env, cb.id, 'Already handled 👍');
  }
  if (!reminder) {
    // Cannot happen — the claim required the chore, in the same transaction.
    await answerCallback(env, cb.id, 'Purrs 😻');
    return updateDashboard(env, chatId);
  }
  const credit = together ? creditTogether(by, [...householdNamesFrom(got.extra[1].results).roster]) : by;
  // "Purrs" goes out the moment the Done is won (onClaim), not after the
  // sticker, the receipt and the board.
  await completeFiring(env, firing, reminder, credit, tz, {
    claimed: got,
    onClaim: async () => {
      await answerCallback(env, cb.id, 'Purrs 😻');
      if (credit !== by) {
        await env.DB.prepare(
          "UPDATE firings SET done_by = ? WHERE id = ? AND state = 'done' AND done_by = ? AND done_at = ?"
        ).bind(credit, firing.id, by, firing.done_at).run();
      }
    },
  });
}

// A snooze or postponement preset. The write is decided in SQL from the row
// as it stands — the expiry cap needs the firing's fired_at and whether its
// chore is a one-off — and read back in the same batch with the chore, so the
// toast is one round trip after the intake, as Done's is. The refusals the old
// reads made (another chat, another member's private nag, no snoozes left,
// already handled) are the claim's conditions, and its read-back says which.
async function snoozeTapped(env, cb, firingId, code) {
  const chatId = cb.message.chat.id;
  // The timezone decides the time only for a postponement and "9pm"; for the
  // others it is only needed for the toast, so it is read beside the write.
  const zone = tzOrDefault(env, chatId);
  const now = Date.now();
  // "Tomorrow" is a postponement, not a snooze: the hour presets are clamped
  // to the 24h expiry, which would collapse a full day down to "just before
  // this expires". Carrying fired_at forward moves the expiry window with the
  // nag, so the chore survives the night and still gets its own 24h once it
  // comes back. Asia/Singapore has no DST, so +24h is the same clock time.
  // 📅 1 week and 📅 2 weeks are the same move, further out.
  const days = POSTPONE_DAYS[code];
  const postpone = days != null;
  const want = postpone ? deferQuietHours(now + days * 86400000, await zone)
    : code === 't' ? nextOccurrence('daily', { h: 21, mi: 0 }, now, await zone)
    : now + (+code) * 60000;
  // Never promise a nag past a recurring chore's 24h expiry — capped at one
  // last call before it (expiresBefore, in SQL). A one-off never expires.
  const until = `CASE WHEN ? >= fired_at + ${EXPIRE_AFTER_MS}
      AND COALESCE((SELECT schedule_kind FROM reminders WHERE id = firings.reminder_id), '') <> 'once'
    THEN fired_at + ${EXPIRE_AFTER_MS - 60000} ELSE ? END`;
  const by = senderName(cb.from);
  // snoozed_until records the household's choice; it holds only while
  // next_nag_at still equals it (see isHouseholdDeferred).
  const set = postpone
    ? { sql: 'next_nag_at = ?, fired_at = ?, snoozed_until = ?', args: [want, want, want] }
    : { sql: `next_nag_at = ${until}, snoozed_until = ${until}`, args: [want, want, want, want] };
  const [[res, f, r], local] = await Promise.all([env.DB.batch([
    env.DB.prepare(
      `UPDATE firings SET snoozes_used = snoozes_used + 1, ${set.sql}, snoozed_by = ?
       WHERE id = ? AND chat_id = ? AND state = 'nagging' AND snoozes_used < ?
         AND (last_message_ephemeral = 0 OR nag_user_id IS NULL OR nag_user_id = ?)`
    ).bind(...set.args, by, firingId, chatId, MAX_SNOOZES, cb.from.id),
    env.DB.prepare('SELECT * FROM firings WHERE id = ? AND chat_id = ?').bind(firingId, chatId),
    env.DB.prepare(
      `SELECT r.* FROM reminders r JOIN firings f ON f.reminder_id = r.id AND r.chat_id = f.chat_id
       WHERE f.id = ? AND f.chat_id = ?`
    ).bind(firingId, chatId),
  ]), zone]);
  const firing = (f.results || [])[0] || null;
  const reminder = (r.results || [])[0] || null;
  if (!res.meta.changes || !firing) {
    if (!firing || firing.state !== 'nagging') return answerCallback(env, cb.id, 'Already handled 👍');
    if (!nagBelongsTo(firing, cb.from)) return answerCallback(env, cb.id, NOT_YOUR_NAG);
    if (firing.snoozes_used >= MAX_SNOOZES) {
      return answerCallback(env, cb.id, `😾 No snoozes left (${MAX_SNOOZES} used) — time to do it.`);
    }
    return answerCallback(env, cb.id, 'Already handled 👍');
  }
  // What the write chose, worked out again from the row it wrote (the cap
  // reads only fired_at, which a snooze leaves alone, and the chore's kind).
  const capped = !postpone && expiresBefore(firing, want, reminder);
  const at = capped ? firing.fired_at + EXPIRE_AFTER_MS - 60000 : want;
  // Tomorrow keeps its old rule (the next occurrence, if it comes first,
  // supersedes it); a week or two out moves the schedule past it.
  const skipped = reminder && days >= 7 ? await skipPastPostponement(env, reminder, at, local) : 0;
  // The toast as soon as the snooze is decided; the card and the board follow.
  const left = MAX_SNOOZES - firing.snoozes_used;
  const remaining = left > 0 ? ` · ${left} ${left === 1 ? 'snooze' : 'snoozes'} left` : ' · last snooze';
  await answerCallback(env, cb.id, (postpone
    ? `Postponed — back ${fmtWhen(at, local)} 📅` +
      (skipped ? ` — skipping ${skipped} scheduled ${skipped === 1 ? 'time' : 'times'}` : '')
    : `Snoozed until ${fmtWhen(at, local)} 😴${capped ? ' — as late as it goes before it expires' : ''}`) + remaining);
  if (reminder && firing.last_message_id) {
    await editNag(env, firing, snoozedHtml(reminder, at, by, local, postpone), snoozedButtons(firing.id, isScored(firing)));
  }
  // The board shows a parked chore by when it comes back.
  await updateDashboard(env, chatId);
}
