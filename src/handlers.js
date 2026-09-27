// Webhook update handling: the command dispatcher, nag replies and reactions,
// and the callback router. Each button family's handler lives with its
// feature — editor/manage in manage.js, wizard in wizard.js — and the nag
// lifecycle, dashboard, chore actions, and stats each have their own module.

import { sendMessage, deleteMessage, editReplyMarkup, answerCallback, esc, okButton,
         replyCtx, sendPrivate, editRef, deleteRef, callbackRef,
         isPublicMessage, sendPrivateLong, keepSourceMessage, tg } from './tg.js';
import { parseRemind, ParseError, NoTimeError } from './parse.js';
import { nextOccurrence, fmtLocal, fmtShort, fmtClock, deferQuietHours } from './time.js';
import { getTz, senderName, isScored, householdRoster, householdNames, canonName, creditTogether,
         rememberMember, forgetMember, isMember, nicknames, CREDIT_SEP } from './household.js';
import { nagButtons, snoozedButtons, snoozeButtons, nagHtml, snoozedHtml,
         overdueHtml, overdueButtons, firingCard,
         editNag, deleteNag, sendNag, deleteNagRef, nagChat, isEphemeralNag,
         isHouseholdDeferred, isOverdue, nagBelongsTo,
         completeFiring, showPausedCard, MAX_SNOOZES, EXPIRE_AFTER_MS } from './nag.js';
import { updateDashboard, choreListHtml } from './dashboard.js';
import { findReminder, createReminder, confirmNewChore, fireIfDue,
         deleteReminder, removeReminder, restoreReminder, undoCompletion, undoEarly, earlyReceipt,
         setReminderPaused, completeEarly, wakeChat } from './chores.js';
import { handleEditorCallback, handleManageCallback, editorText, editorButtons } from './manage.js';
import { startWizard, startTextPrompt, tryDraftTime, handleWizardCallback } from './wizard.js';
import { cmdStats, handleStatsCallback } from './stats.js';
import { cmdMakeStickers, cmdDelSticker, cmdUsePack, cmdTagSticker, cmdAutoTag, cmdTags } from './sticker-commands.js';
import { cmdInvite } from './invite.js';
import { digestView } from './cron.js';

// Cached getMe username, fetched only when a /cmd@bot suffix needs checking.
let botUsername = null;

const NOT_YOUR_NAG = 'That nag is someone else\'s 🙈';

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
    `${hello}\nTry:\n/chore take out trash 7pm daily\n/chore dishes now\n` +
    '/remind pay tax friday — no points\n/list · /stats · /help');
}

// Household lock: only chats listed in ALLOWED_CHATS (comma-separated ids)
// are served; everything else — stranger DMs included — is dropped silently.
// Missing configuration fails closed: a deploy must explicitly name every
// chat the bot is allowed to serve.
function chatAllowed(env, chatId) {
  const allowed = String(env.ALLOWED_CHATS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return allowed.length > 0 && chatId != null && allowed.includes(String(chatId));
}

// Membership changes seen as `chat_member` updates. Only the statuses that
// mean "still here" keep a row; left and kicked take it away.
const IN_CHAT = new Set(['member', 'administrator', 'creator', 'restricted']);

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

export async function handleUpdate(env, update) {
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
  if (from && !from.is_bot) await rememberMember(env, chat.id, from);
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
  // checked against and copied (cmdRemind).
  const tidy = cmd !== 'start' && cmd !== 'help' && !KEEP_UNTIL_OK.has(cmd) && isPublicMessage(msg);
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
    else if (cmd === 'done') result = await cmdDone(env, ctx, args, by, tz);
    else if (cmd === 'poke' || cmd === 'nagall') result = await cmdPoke(env, ctx);
    else if (cmd === 'stats') result = await cmdStats(env, ctx, tz, args);
    else if (cmd === 'invite') result = await cmdInvite(env, ctx, args, tz);
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
    if (err instanceof ParseError) return sendPrivate(env, ctx, esc(err.message));
    console.log(`command /${cmd} failed: ${err.stack || err}`);
    return sendPrivate(env, ctx, '🙀 The cats knocked something over — that didn\'t work. Try again?');
  } finally {
    if (tidy) await deleteMessage(env, chatId, msg.message_id);
  }
}

function helpText(section = 'home', nicks = []) {
  if (section === 'schedule') return '⏰ <b>Scheduling examples</b>\n\n' +
    '<code>/remind trash 7pm daily</code>\n' +
    '<code>/remind @jane dishes now</code>\n' +
    '<code>/remind plants every mon,thu 8am</code>\n' +
    '<code>/remind filter every 3 months from friday</code>\n' +
    '<code>/remind plumber in 20m nag:10m</code>\n\n' +
    'Leave out the time for a guided picker. Add <code>rotate</code> for fair-share assignment.' +
    // Shortcuts are per-household config, so the help only mentions the ones
    // this deployment actually has.
    (nicks.length ? `\nAssign with @name or a shortcut: ${nicks.map((n) => `<code>${esc(n)}</code>`).join(', ')}` +
      ` — e.g. <code>/chore ${esc(nicks[0])} dishes 9pm</code>.` : '');
  if (section === 'more') return '🧰 <b>More controls</b>\n\n' +
    '/edit · /delete · /pause · /resume · /skip — use a chore name or number\n' +
    '/poke — re-send everything outstanding\n' +
    '/pause all 14 · /resume all — vacation mode\n' +
    '/stats — leaderboard with This week / Last week / 6 months tabs\n' +
    '/invite dentist tomorrow 3pm at Mount E — get a calendar file to add\n\n' +
    'Reply <code>done</code>, <code>done together</code>, or <code>snooze 2h</code> directly to a nag.';
  if (section === 'stickers') return '🐾 <b>Sticker tools</b>\n\n' +
    '/usepack &lt;link&gt; · /makestickers · /tags\n' +
    '/tagsticker N latte · /autotag · /delsticker N';
  return '🐱 <b>Latte &amp; Mocha</b>\nNagging chores until someone taps Done.\n\n' +
    '<code>/chore trash 7pm daily</code> — add a chore (counts on the leaderboard)\n' +
    '<code>/remind pick up parcel 5pm</code> — plain reminder, no points\n' +
    '/list — see the board\n' +
    '/done trash — mark it done\n\n' +
    'Most actions are available from the pinned dashboard or directly under a nag.';
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
  if (pinUrl) rows.push([{ text: '📌 View pinned dashboard', url: pinUrl }]);
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
  await sendPrivate(env, ctx, helpText(section, [...nicknames(env).keys()]),
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
    throw err;
  }
  p.scored = scored;
  p.sourceMsgId = sourceMsgId;
  const { id, html } = await createReminder(env, chatId, p, by, tz);
  await confirmNewChore(env, ctx, by, p, tz, id, html);
  await fireIfDue(env, id, tz);
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
    const firing = await env.DB.prepare(
      `SELECT * FROM firings WHERE (chat_id = ? OR nag_chat_id = ?)
         AND last_message_id = ? AND last_message_ephemeral = ? AND state = 'nagging'`
    ).bind(chatId, chatId, replyRef.id, replyRef.ephemeral ? 1 : 0).first();
    if (firing && nagBelongsTo(firing, msg.from)) return handleNagReply(env, msg, firing);
  }
  // Bare "done" works when exactly one chore is nagging; with several, the
  // cats ask which instead of staying confusingly silent. Only nags the typer
  // can see count — the same nagBelongsTo rule as the buttons — or a "done"
  // meant for something else quietly finished another member's private chore
  // in their name, and the "which one?" list named chores they cannot see.
  if (/^done(?:\s+(?:together|both|with\s+.+?))?\s*!*$/i.test(msg.text)) {
    const all = await env.DB.prepare(
      "SELECT * FROM firings WHERE (chat_id = ? OR nag_chat_id = ?) AND state = 'nagging'"
    ).bind(chatId, chatId).all();
    const mine = all.results.filter((f) => nagBelongsTo(f, msg.from));
    if (mine.length === 1) return handleNagReply(env, msg, mine[0], ctx);
    if (mine.length > 1) {
      const rows = await env.DB.prepare(
        `SELECT text FROM reminders WHERE id IN (${mine.map(() => '?').join(',')}) ORDER BY id`
      ).bind(...mine.map((f) => f.reminder_id)).all();
      return sendPrivate(env, ctx, '😺 Mrow — which one?\n' +
        rows.results.map((r) => `/done ${esc(r.text)}`).join('\n'));
    }
  }
  // The only other text that means anything here is a time for a pending draft.
  return tryDraftTime(env, msg, ctx, replyRef);
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
  const firing = await env.DB.prepare(
    `SELECT * FROM firings WHERE (chat_id = ? OR nag_chat_id = ?)
       AND last_message_id = ? AND last_message_ephemeral = ? AND state = 'nagging'`
  ).bind(rx.chat.id, rx.chat.id, ref.id, ref.ephemeral ? 1 : 0).first();
  if (!firing || !nagBelongsTo(firing, rx.user)) return;
  const reminder = await env.DB.prepare('SELECT * FROM reminders WHERE id = ?').bind(firing.reminder_id).first();
  if (!reminder) return;
  const tz = await getTz(env, rx.chat.id);
  await completeFiring(env, firing, reminder, senderName(rx.user), tz);
}

async function handleNagReply(env, msg, firing, ctx) {
  const text = msg.text.trim();
  const tz = await getTz(env, msg.chat.id);
  ctx = ctx || replyCtx(env, msg.chat.id, msg.from && msg.from.id);
  // Only a complete done-phrase counts — "done?", "not done ✅?" are chat
  // between people, and completing on those would credit the asker.
  if (/^(?:done(?:\s+(?:together|both)\b|\s+with\s+.+?)?|✅)[\s!.✅]*$/i.test(text)) {
    const reminder = await env.DB.prepare('SELECT * FROM reminders WHERE id = ?').bind(firing.reminder_id).first();
    if (!reminder) return;
    let by = senderName(msg.from);
    // "done together"/"done both" credits the whole roster; "done with @jane"
    // credits the replier plus the named helpers.
    const together = /^done\s+(?:together|both)\b/i.test(text);
    const withM = text.match(/^done\s+with\s+(.+?)[\s!.✅]*$/i);
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
        for (const typed of withM[1].split(/\s*(?:,|&|\+|\band\b)\s*/i).map((s) => s.trim()).filter(Boolean)) {
          const hit = canonName(roster, typed, household.aliases);
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
  const sn = text.match(/^snooze(?:\s+(\d+)\s*(m|min|mins|minutes|h|hr|hrs|hours)?)?\s*$/i);
  if (sn) {
    if (firing.snoozes_used >= MAX_SNOOZES) {
      return sendPrivate(env, ctx, `😾 No more snoozes (max ${MAX_SNOOZES}). The chore remains.`);
    }
    // An overdue one-off has no window left to snooze inside: the cap below
    // would land the "snooze" in the past, burn a count, and promise a time
    // already gone by, which the next cron tick then silently undid.
    if (isOverdue(firing)) {
      return sendPrivate(env, ctx, '⏰ That one is already overdue — reply <code>done</code>, or delete it.');
    }
    const n = sn[1] ? +sn[1] : 60;
    const ms = sn[2] && /^h/i.test(sn[2]) ? n * 3600000 : n * 60000;
    // Never promise a nag past the 24h expiry — cap at one last call before it.
    const expiresAt = firing.fired_at + EXPIRE_AFTER_MS;
    let until = Date.now() + Math.min(ms, 24 * 3600000);
    const capped = until >= expiresAt;
    if (capped) until = expiresAt - 60000;
    // snoozed_until is the household's choice on record; resume and the
    // editor honour it only while next_nag_at still equals it. snoozed_by
    // is who chose it, for any later redraw of the 😴 card.
    const res = await env.DB.prepare(
      `UPDATE firings SET snoozes_used = snoozes_used + 1, next_nag_at = ?, snoozed_until = ?, snoozed_by = ?
       WHERE id = ? AND state = 'nagging' AND snoozes_used < ?`
    ).bind(until, until, senderName(msg.from), firing.id, MAX_SNOOZES).run();
    if (!res.meta.changes) return sendPrivate(env, ctx, '😼 That one was already handled.');
    const reminder = await env.DB.prepare('SELECT * FROM reminders WHERE id = ?').bind(firing.reminder_id).first();
    if (reminder && firing.last_message_id) {
      await editNag(env, firing,
        snoozedHtml(reminder, until, senderName(msg.from), tz), snoozedButtons(firing.id, isScored(firing)));
      if (isPublicMessage(msg)) await deleteMessage(env, msg.chat.id, msg.message_id);
      return;
    }
    return sendPrivate(env, ctx, `😴 Snoozed until ${fmtLocal(until, tz)}.`);
  }
  // A reply that starts with "snooze" but didn't parse must not die silently —
  // the person walks away sure it's snoozed while the re-nag stays scheduled.
  if (/^snooze\b/i.test(text)) {
    return sendPrivate(env, ctx,
      '😿 The cats couldn\'t read that snooze — try <code>snooze 2h</code> or <code>snooze 30m</code>, or tap 😴 Snooze… under the nag.');
  }
}

async function cmdList(env, ctx, tz) {
  const html = await choreListHtml(env, ctx.chatId, tz);
  if (!html) return sendPrivate(env, ctx, '😺 No chores on the list. Add one with /remind.');
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
// natural slot and quietly clears pre-vacation nags — no flood on return.
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
  if (state.firing) return;
  if (pause) {
    await sendPrivate(env, ctx, `⏸️ Paused <b>${esc(r.text)}</b>. /resume ${esc(r.text)} to re-enable.`);
  } else {
    if (state.next != null) {
      return sendPrivate(env, ctx, `▶️ Resumed <b>${esc(r.text)}</b> — next ${fmtLocal(state.next, tz)}`);
    }
    await sendPrivate(env, ctx,
      `😼 <b>${esc(r.text)}</b> already fired and has nothing scheduled — /delete it or make a new /remind.`);
  }
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
  await sendPrivate(env, ctx, `⏭️ Skipping next <b>${esc(r.text)}</b> — next ${fmtLocal(next, tz)}`);
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
      throw new ParseError(`"${r.text}" has nothing scheduled — /delete it or make a new /remind.`);
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
       WHERE id = ? AND state = 'nagging' AND last_message_id IS ?`
    ).bind(ref ? ref.id : null, ref && ref.ephemeral ? 1 : 0, f.id, f.last_message_id).run();
    if (!upd.meta.changes && ref) await deleteNagRef(env, f, ref);
  }
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
    await editRef(env, ctx, cb.message.chat.id, ref,
      helpText(help[1], [...nicknames(env).keys()]), await helpMarkup(env, cb.message.chat.id, help[1]));
    return answerCallback(env, cb.id, '');
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
    const trashId = await removeReminder(env, r);
    await editRef(env, ctx, r.chat_id, ref, `↩️ Undone — <s>${esc(r.text)}</s>`, { inline_keyboard: [[
      { text: '↩️ Restore', callback_data: `t:${trashId}` },
      { text: '✅ OK', callback_data: 'ok' },
    ]] });
    await updateDashboard(env, r.chat_id);
    return answerCallback(env, cb.id, 'Undone');
  }

  // Done from a creation confirmation. Completes whatever the chore is up to:
  // the live nag if it has fired, otherwise the upcoming occurrence (done
  // early), exactly as the board's Manage → Done does. Scoped to the chat the
  // tap came from like every other lookup here. The receipt replaces the
  // confirmation and keeps its OK, so the kept command still goes with it.
  const cm = data.match(/^c:([0-9]+)(?::([0-9]+))?$/);
  if (cm) {
    const r = await env.DB.prepare('SELECT * FROM reminders WHERE id = ? AND chat_id = ?')
      .bind(+cm[1], cb.message.chat.id).first();
    if (!r) return answerCallback(env, cb.id, 'Already gone.');
    const tz = await getTz(env, r.chat_id);
    const credit = senderName(cb.from);
    const firing = await env.DB.prepare(
      "SELECT * FROM firings WHERE reminder_id = ? AND state = 'nagging' ORDER BY id DESC LIMIT 1"
    ).bind(r.id).first();
    let won;
    if (firing) won = await completeFiring(env, firing, r, credit, tz);
    else if (r.paused || r.next_fire_at == null) return answerCallback(env, cb.id, 'This chore is not nagging now.');
    else won = await completeEarly(env, r, credit, tz);
    if (!won) return answerCallback(env, cb.id, 'Already handled 👍');
    // The completion drew its own receipt — the card's, or the done-early
    // line — with ↩️ Not done on it. Turning this confirmation into a second
    // receipt left two 😻 lines for one tap, so it goes instead, and takes the
    // command it kept with it: Done is the strongest OK there is for a parse.
    if (cm[2]) await dismissKept(env, r.chat_id, +cm[2]);
    await deleteRef(env, ctx, r.chat_id, ref);
    return answerCallback(env, cb.id, 'Purrs 😻');
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
    const firing = await env.DB.prepare(
      "SELECT * FROM firings WHERE id = ? AND chat_id = ? AND state = 'nagging'"
    ).bind(+dg[1], chatId).first();
    let toast = 'Already handled 👍';
    if (firing) {
      const r = await env.DB.prepare('SELECT * FROM reminders WHERE id = ?').bind(firing.reminder_id).first();
      if (!r) return answerCallback(env, cb.id, 'That one is gone.');
      const won = await completeFiring(env, firing, r, senderName(cb.from), await getTz(env, chatId));
      if (won) toast = 'Purrs 😻';
    }
    const view = await digestView(env, chatId, digestIds(cb, +dg[1]));
    await editRef(env, ctx, chatId, ref, view.html, view.markup);
    return answerCallback(env, cb.id, toast === 'Purrs 😻' ? 'Purrs 😻 — ↩️ Not done is below if that was a slip' : toast);
  }

  // Take a Done back. The receipt it came from is redrawn by undoCompletion
  // when it is the nag card itself; a digest is redrawn from the ids its
  // buttons carry, like a ✅ on it; a public receipt of a private nag just
  // says so. Scoped to the chat like every firing lookup here.
  const nd = data.match(/^nd:([0-9]+)$/);
  if (nd) {
    const chatId = cb.message.chat.id;
    const firing = await env.DB.prepare('SELECT * FROM firings WHERE id = ? AND chat_id = ?')
      .bind(+nd[1], chatId).first();
    if (!firing || firing.state !== 'done') return answerCallback(env, cb.id, 'Nothing to take back.');
    const tz = await getTz(env, chatId);
    const res = await undoCompletion(env, firing, senderName(cb.from), tz);
    if (!res.ok) {
      return answerCallback(env, cb.id,
        res.why === 'gone' ? 'That chore is gone for good.' : 'Too late to take that back.');
    }
    if (String(cb.message.text || '').startsWith('☀️')) {
      const view = await digestView(env, chatId, digestIds(cb, firing.id));
      await editRef(env, ctx, chatId, ref, view.html, view.markup);
    } else if (!(ref && ref.id === firing.last_message_id && ref.ephemeral === Boolean(firing.last_message_ephemeral))) {
      await editRef(env, ctx, chatId, ref,
        `↩️ <b>${esc(firing.reminder_text || 'chore')}</b> — not done after all.`,
        { inline_keyboard: [[okButton()]] });
    }
    return answerCallback(env, cb.id, 'Taken back ↩️');
  }

  // Take a Done early back: the receipt it sits on says so.
  const ne = data.match(/^ne:([0-9]+)$/);
  if (ne) {
    const chatId = cb.message.chat.id;
    const firing = await env.DB.prepare('SELECT * FROM firings WHERE id = ? AND chat_id = ?')
      .bind(+ne[1], chatId).first();
    if (!firing || firing.state !== 'done') return answerCallback(env, cb.id, 'Nothing to take back.');
    const res = await undoEarly(env, firing, senderName(cb.from), await getTz(env, chatId));
    if (!res.ok) {
      return answerCallback(env, cb.id,
        res.why === 'gone' ? 'That chore is gone for good.' : 'Too late to take that back.');
    }
    await editRef(env, ctx, chatId, ref,
      `↩️ <b>${esc(firing.reminder_text || 'chore')}</b> — not done after all.`,
      { inline_keyboard: [[okButton()]] });
    return answerCallback(env, cb.id, 'Taken back ↩️');
  }

  // Undo a /delete: restore the stashed reminder row.
  const tr = data.match(/^t:(\d+)$/);
  if (tr) {
    const row = await env.DB.prepare('SELECT * FROM trash WHERE id = ? AND chat_id = ?')
      .bind(+tr[1], cb.message.chat.id).first();
    if (!row) return answerCallback(env, cb.id, 'Too late — that one is gone for good.');
    const r = JSON.parse(row.payload);
    // Claim the stash first: two taps on the same Undo used to restore twice.
    const claim = await env.DB.prepare('DELETE FROM trash WHERE id = ?').bind(row.id).run();
    if (!claim.meta.changes) return answerCallback(env, cb.id, 'Already restored.');
    await restoreReminder(env, r);
    await updateDashboard(env, r.chat_id);
    await editRef(env, ctx, r.chat_id, ref, `↩️ Restored <b>${esc(r.text)}</b>`);
    return answerCallback(env, cb.id, 'Restored 😺');
  }

  // Upgrade a done receipt's credit to the whole household — the fix for
  // tapping Done early solo when the work was actually shared.
  const gm = data.match(/^g:(\d+)$/);
  if (gm) {
    // Scoped to the chat the tap came from, like every other firing lookup
    // here: an id from another household must not be actionable.
    const firing = await env.DB.prepare(
      "SELECT * FROM firings WHERE id = ? AND chat_id = ? AND state = 'done'"
    ).bind(+gm[1], cb.message.chat.id).first();
    if (!firing) return answerCallback(env, cb.id, 'That one is gone.');
    const names = String(firing.done_by || '').split(CREDIT_SEP).filter(Boolean);
    const roster = await householdRoster(env, firing.chat_id);
    const credit = creditTogether(names[0] || senderName(cb.from), [...names.slice(1), ...roster]);
    await env.DB.prepare("UPDATE firings SET done_by = ? WHERE id = ? AND state = 'done'")
      .bind(credit, firing.id).run();
    const tz = await getTz(env, firing.chat_id);
    const next = await env.DB.prepare('SELECT next_fire_at FROM reminders WHERE id = ?')
      .bind(firing.reminder_id).first();
    // Same receipt as the one being widened, so ↩️ Not done stays on it.
    const receipt = earlyReceipt(firing.reminder_text || 'chore', credit, next && next.next_fire_at, tz, firing.id);
    await editRef(env, ctx, firing.chat_id, ref, receipt.html, receipt.markup);
    return answerCallback(env, cb.id, 'Shared credit 🤝');
  }

  // Dismiss a log line. Works on either kind of message, since deleteRef picks
  // the method from the ref rather than assuming a public message id. An OK
  // that names a source message is a chore confirmation: the command it was
  // typed in was kept on show for exactly this tap, and goes with it.
  const okm = data.match(/^ok(?::(\d+))?$/);
  if (okm) {
    if (okm[1]) await dismissKept(env, cb.message.chat.id, +okm[1]);
    await deleteRef(env, ctx, cb.message.chat.id, ref);
    return answerCallback(env, cb.id, '');
  }

  // 🗑 on a nag removes the chore outright. One tap, because the log line it
  // leaves carries Undo — a mis-tap is recoverable for a day.
  const xm = data.match(/^x:(\d+)$/);
  if (xm) {
    const firing = await env.DB.prepare('SELECT * FROM firings WHERE id = ? AND chat_id = ?')
      .bind(+xm[1], cb.message.chat.id).first();
    if (!firing) return answerCallback(env, cb.id, 'Already gone.');
    if (!nagBelongsTo(firing, cb.from)) return answerCallback(env, cb.id, NOT_YOUR_NAG);
    const r = await env.DB.prepare('SELECT * FROM reminders WHERE id = ? AND chat_id = ?')
      .bind(firing.reminder_id, firing.chat_id).first();
    if (!r) return answerCallback(env, cb.id, 'That chore is already gone.');
    // No ctx: the log is public on purpose, whoever the nag belonged to.
    await deleteReminder(env, r, null, senderName(cb.from));
    return answerCallback(env, cb.id, 'Deleted — Undo is in the group.');
  }

  // Snooze preset picked (or Back to the main buttons).
  const zm = data.match(/^z:(\d+):(\w+)$/);
  if (zm) {
    const firing = await env.DB.prepare('SELECT * FROM firings WHERE id = ? AND chat_id = ?')
      .bind(+zm[1], cb.message.chat.id).first();
    if (!firing || firing.state !== 'nagging') return answerCallback(env, cb.id, 'Already handled 👍');
    if (!nagBelongsTo(firing, cb.from)) return answerCallback(env, cb.id, NOT_YOUR_NAG);
    if (zm[2] === 'b') {
      // Back to whatever the firing is now — decided from its state, like
      // every other redraw, not from the card's own text: a 😴 card whose
      // snooze the cron had already spent read as still snoozed, and a card
      // that crossed the 24h mark with its menu open came back offering a
      // Snooze the next tap only refused. An ephemeral message has no
      // reply-markup-only edit, so its text is re-rendered alongside.
      const rem = await env.DB.prepare('SELECT * FROM reminders WHERE id = ?')
        .bind(firing.reminder_id).first();
      if (rem) {
        const [html, buttons] = firingCard(rem, firing, await getTz(env, firing.chat_id));
        if (isEphemeralNag(firing)) await editNag(env, firing, html, buttons);
        else await editReplyMarkup(env, nagChat(firing), cb.message.message_id, buttons);
      }
      return answerCallback(env, cb.id, '');
    }
    if (firing.snoozes_used >= MAX_SNOOZES) {
      return answerCallback(env, cb.id, `No more snoozes 😈 (max ${MAX_SNOOZES})`);
    }
    // An overdue one-off's card no longer offers these, but an older card may
    // still be showing them. See handleNagReply for why the snooze is refused.
    if (isOverdue(firing)) return answerCallback(env, cb.id, 'Already overdue ⏰ — Done or Delete it');
    const tz = await getTz(env, firing.chat_id);
    // "Tomorrow" is a postponement, not a snooze: the hour presets are clamped
    // to the 24h expiry, which would collapse a full day down to "just before
    // this expires". Carrying fired_at forward moves the expiry window with the
    // nag, so the chore survives the night and still gets its own 24h once it
    // comes back. Asia/Singapore has no DST, so +24h is the same clock time.
    const postpone = zm[2] === 'day';
    const expiresAt = firing.fired_at + EXPIRE_AFTER_MS;
    let until = postpone ? deferQuietHours(Date.now() + 86400000, tz)
      : zm[2] === 't' ? nextOccurrence('daily', { h: 21, mi: 0 }, Date.now(), tz)
      : Date.now() + (+zm[2]) * 60000;
    const capped = !postpone && until >= expiresAt;
    if (capped) until = expiresAt - 60000;
    // snoozed_until records the household's choice; it holds only while
    // next_nag_at still equals it (see isHouseholdDeferred).
    const by = senderName(cb.from);
    const res = postpone
      ? await env.DB.prepare(
        `UPDATE firings SET snoozes_used = snoozes_used + 1, next_nag_at = ?, fired_at = ?, snoozed_until = ?, snoozed_by = ?
         WHERE id = ? AND state = 'nagging' AND snoozes_used < ?`
      ).bind(until, until, until, by, firing.id, MAX_SNOOZES).run()
      : await env.DB.prepare(
        `UPDATE firings SET snoozes_used = snoozes_used + 1, next_nag_at = ?, snoozed_until = ?, snoozed_by = ?
         WHERE id = ? AND state = 'nagging' AND snoozes_used < ?`
      ).bind(until, until, by, firing.id, MAX_SNOOZES).run();
    if (!res.meta.changes) return answerCallback(env, cb.id, 'Already handled 👍');
    const reminder = await env.DB.prepare('SELECT * FROM reminders WHERE id = ?').bind(firing.reminder_id).first();
    if (reminder && firing.last_message_id) {
      await editNag(env, firing, snoozedHtml(reminder, until, by, tz), snoozedButtons(firing.id, isScored(firing)));
    }
    if (postpone) {
      return answerCallback(env, cb.id, `Postponed to ${fmtShort(until, tz)} 📅`);
    }
    return answerCallback(env, cb.id,
      `Snoozed until ${fmtClock(until, tz)} 😴${capped ? ' (24h limit — last call)' : ''}`);
  }

  const m = data.match(/^([dsb]):(\d+)$/);
  if (!m) return answerCallback(env, cb.id, '');
  const firing = await env.DB.prepare('SELECT * FROM firings WHERE id = ? AND chat_id = ?')
    .bind(+m[2], cb.message.chat.id).first();
  if (!firing || firing.state !== 'nagging') {
    return answerCallback(env, cb.id, 'Already handled 👍');
  }
  if (!nagBelongsTo(firing, cb.from)) return answerCallback(env, cb.id, NOT_YOUR_NAG);
  const reminder = await env.DB.prepare('SELECT * FROM reminders WHERE id = ?').bind(firing.reminder_id).first();
  if (!reminder) {
    // Same compare-and-swap as every other state change: the row was read a
    // moment ago, and a cron tick or a second tap may have moved it since.
    await env.DB.prepare(
      "UPDATE firings SET state = 'expired', next_nag_at = NULL WHERE id = ? AND state = 'nagging'"
    ).bind(firing.id).run();
    return answerCallback(env, cb.id, 'That reminder was deleted.');
  }
  const tz = await getTz(env, firing.chat_id);
  const by = senderName(cb.from);

  if (m[1] === 'd' || m[1] === 'b') {
    let credit = by;
    if (m[1] === 'b') {
      const roster = await householdRoster(env, firing.chat_id);
      credit = creditTogether(by, [...roster]);
    }
    const won = await completeFiring(env, firing, reminder, credit, tz);
    return answerCallback(env, cb.id, won ? 'Purrs 😻' : 'Already handled 👍');
  }

  // Snooze tapped: swap the keyboard for duration presets.
  if (firing.snoozes_used >= MAX_SNOOZES) {
    return answerCallback(env, cb.id, `No more snoozes 😈 (max ${MAX_SNOOZES})`);
  }
  if (isOverdue(firing)) return answerCallback(env, cb.id, 'Already overdue ⏰ — Done or Delete it');
  if (isEphemeralNag(firing)) {
    // No reply-markup-only edit for an ephemeral message, so the text is
    // re-rendered too — and it has to stay the card it already is. Rendering
    // a parked chore's 😴 notice as a nag turned "🕐 Change snooze → ↩️ Back"
    // into a live nag, since Back reads the card's own text to pick a keyboard.
    // The snoozer's name is not stored, so the notice names the household.
    const html = isHouseholdDeferred(firing)
      ? snoozedHtml(reminder, firing.next_nag_at, 'the household', tz)
      : nagHtml(reminder, firing.nag_count, firing.cat || 'both');
    await editNag(env, firing, html, snoozeButtons(firing.id, tz));
  } else {
    await editReplyMarkup(env, nagChat(firing), cb.message.message_id, snoozeButtons(firing.id, tz));
  }
  return answerCallback(env, cb.id, '');
}
