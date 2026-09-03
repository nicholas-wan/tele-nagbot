// Webhook update handling: the command dispatcher, nag replies and reactions,
// and the callback router. Each button family's handler lives with its
// feature — editor/manage in manage.js, wizard in wizard.js — and the nag
// lifecycle, dashboard, chore actions, and stats each have their own module.

import { sendMessage, deleteMessage, editReplyMarkup, answerCallback, esc,
         replyCtx, sendPrivate, editRef, deleteRef, callbackRef,
         isPublicMessage, sendPrivateLong, tg } from './tg.js';
import { parseRemind, ParseError, NoTimeError } from './parse.js';
import { nextOccurrence, fmtLocal, fmtShort, fmtClock, deferQuietHours } from './time.js';
import { getTz, senderName, isScored, householdRoster, canonName, creditTogether,
         rememberMember, isMember, CREDIT_SEP } from './household.js';
import { nagButtons, snoozedButtons, snoozeButtons, nagHtml, snoozedHtml,
         editNag, deleteNag, sendNag, deleteNagRef, nagChat, isEphemeralNag,
         completeFiring, showPausedCard, MAX_SNOOZES, EXPIRE_AFTER_MS } from './nag.js';
import { updateDashboard, choreListHtml } from './dashboard.js';
import { findReminder, createReminder, confirmNewChore, fireIfDue,
         deleteReminder, setReminderPaused, completeEarly, wakeChat } from './chores.js';
import { handleEditorCallback, handleManageCallback, editorText, editorButtons } from './manage.js';
import { startWizard, startTextPrompt, tryDraftTime, handleWizardCallback } from './wizard.js';
import { cmdStats, handleStatsCallback } from './stats.js';
import { cmdMakeStickers, cmdDelSticker, cmdUsePack, cmdTagSticker, cmdAutoTag, cmdTags } from './sticker-commands.js';
import { cmdInvite } from './invite.js';

// Cached getMe username, fetched only when a /cmd@bot suffix needs checking.
let botUsername = null;

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

// A household member's private chat: nothing happens here any more. Every nag
// lives in the group (an assigned one ephemerally), so a DM has nothing to
// route and no nag line to open — it just gets pointed back at the group.
async function handleMemberDm(env, update, chat) {
  const msg = update.message;
  if (!msg || !msg.text) return;
  return sendMessage(env, chat.id,
    '😺 Mrow! Everything happens in the family group — add, list, and finish chores there.');
}

export async function handleUpdate(env, update) {
  const chat = (update.message && update.message.chat)
    || (update.callback_query && update.callback_query.message && update.callback_query.message.chat)
    || (update.message_reaction && update.message_reaction.chat);
  const from = (update.message && update.message.from)
    || (update.callback_query && update.callback_query.from)
    || (update.message_reaction && update.message_reaction.user);
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
  // Learn member ids from group traffic so assigned nags can route to DMs.
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

  try {
    let result;
    let handled = true;
    if (cmd === 'start' || cmd === 'help') result = await cmdHelp(env, ctx, args);
    else if (cmd === 'chore') result = await cmdRemind(env, ctx, args, msg, tz, by, true);
    else if (cmd === 'remind') result = await cmdRemind(env, ctx, args, msg, tz, by, false);
    else if (cmd === 'list') result = await cmdList(env, ctx, tz);
    else if (cmd === 'edit') result = await cmdEdit(env, ctx, args, tz);
    else if (cmd === 'delete') result = await cmdDelete(env, ctx, args);
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

    if (!handled) {
      // A typo'd command was the one message class nothing ever swept — tidy
      // it away like any other command before the private hint.
      if (isPublicMessage(msg)) await deleteMessage(env, chatId, msg.message_id);
      return sendPrivate(env, ctx, `😿 Unknown command /${esc(cmd)}. Try /help.`);
    }
    // Legacy clients still post commands as ordinary group messages; tidy those
    // away. An ephemeral command was never public and carries message_id 0, so
    // there is nothing to delete — guard rather than calling deleteMessage(0).
    if (cmd !== 'start' && cmd !== 'help' && isPublicMessage(msg)) {
      await deleteMessage(env, chatId, msg.message_id);
    }
    return result;
  } catch (err) {
    if (err instanceof ParseError) return sendPrivate(env, ctx, esc(err.message));
    console.log(`command /${cmd} failed: ${err.stack || err}`);
    return sendPrivate(env, ctx, '🙀 The cats knocked something over — that didn\'t work. Try again?');
  }
}

function helpText(section = 'home') {
  if (section === 'schedule') return '⏰ <b>Scheduling examples</b>\n\n' +
    '<code>/remind trash 7pm daily</code>\n' +
    '<code>/remind @jane dishes now</code>\n' +
    '<code>/remind plants every mon,thu 8am</code>\n' +
    '<code>/remind filter every 3 months from friday</code>\n' +
    '<code>/remind plumber in 20m nag:10m</code>\n\n' +
    'Leave out the time for a guided picker. Add <code>rotate</code> for fair-share assignment.';
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
  await sendPrivate(env, ctx, helpText(section), await helpMarkup(env, ctx.chatId, section));
}

// /chore scores on the leaderboard; /remind is an unscored utility reminder.
// Identical behavior otherwise.
async function cmdRemind(env, ctx, args, msg, tz, by, scored) {
  const chatId = ctx.chatId;
  const now = Date.now();
  // The "/" autocomplete menu sends the bare command — ask what to nag about
  // instead of erroring, and treat the reply as the rest of the command.
  if (!String(args).trim()) return startTextPrompt(env, ctx, msg.from, scored);
  let p;
  try {
    p = parseRemind(args, msg.text, msg.entities, now, tz);
  } catch (err) {
    if (err instanceof NoTimeError) return startWizard(env, ctx, err.partial, args, tz, scored);
    throw err;
  }
  p.scored = scored;
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
    if (firing) return handleNagReply(env, msg, firing);
  }
  // Bare "done" works when exactly one chore is nagging; with several, the
  // cats ask which instead of staying confusingly silent.
  if (/^done(?:\s+(?:together|both|with\s+.+?))?\s*!*$/i.test(msg.text)) {
    const all = await env.DB.prepare(
      "SELECT * FROM firings WHERE (chat_id = ? OR nag_chat_id = ?) AND state = 'nagging'"
    ).bind(chatId, chatId).all();
    if (all.results.length === 1) return handleNagReply(env, msg, all.results[0], ctx);
    if (all.results.length > 1) {
      const rows = await env.DB.prepare(
        "SELECT r.text FROM firings f JOIN reminders r ON r.id = f.reminder_id WHERE f.chat_id = ? AND f.state = 'nagging' ORDER BY r.id"
      ).bind(chatId).all();
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
  if (!firing) return;
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
      roster = await householdRoster(env, msg.chat.id);
      let others;
      if (withM) {
        // Only real household members may be credited. A name nobody in this
        // chat answers to is dropped rather than invented: done_by is read back
        // by the leaderboard and the rotation, so a typo used to become a
        // person who then took turns and collected points.
        others = [];
        for (const typed of withM[1].split(/\s*(?:,|&|\+|\band\b)\s*/i).map((s) => s.trim()).filter(Boolean)) {
          const hit = canonName(roster, typed);
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
    const n = sn[1] ? +sn[1] : 60;
    const ms = sn[2] && /^h/i.test(sn[2]) ? n * 3600000 : n * 60000;
    // Never promise a nag past the 24h expiry — cap at one last call before it.
    const expiresAt = firing.fired_at + EXPIRE_AFTER_MS;
    let until = Date.now() + Math.min(ms, 24 * 3600000);
    const capped = until >= expiresAt;
    if (capped) until = expiresAt - 60000;
    const res = await env.DB.prepare(
      "UPDATE firings SET snoozes_used = snoozes_used + 1, next_nag_at = ? WHERE id = ? AND state = 'nagging' AND snoozes_used < ?"
    ).bind(until, firing.id, MAX_SNOOZES).run();
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

async function cmdDelete(env, ctx, args) {
  const r = await findReminder(env, ctx.chatId, args);
  await deleteReminder(env, r, ctx);
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
  await env.DB.prepare('UPDATE reminders SET next_fire_at = ? WHERE id = ?').bind(next, r.id).run();
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
  for (const f of results) {
    const r = await env.DB.prepare('SELECT * FROM reminders WHERE id = ?').bind(f.reminder_id).first();
    if (!r) continue;
    if (f.last_message_id) await deleteNag(env, f);
    if (f.last_sticker_id) await deleteMessage(env, nagChat(f), f.last_sticker_id);
    const ref = await sendNag(env, f, nagHtml(r, f.nag_count, f.cat || 'both'), nagButtons(f.id, isScored(f)));
    const upd = await env.DB.prepare(
      `UPDATE firings SET last_message_id = ?, last_message_ephemeral = ?, last_sticker_id = NULL
       WHERE id = ? AND state = 'nagging'`
    ).bind(ref ? ref.id : null, ref && ref.ephemeral ? 1 : 0, f.id).run();
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
      helpText(help[1]), await helpMarkup(env, cb.message.chat.id, help[1]));
    return answerCallback(env, cb.id, '');
  }

  // Undo a just-created reminder: remove it and any live nag it produced.
  const um = data.match(/^u:(\d+)$/);
  if (um) {
    const r = await env.DB.prepare('SELECT * FROM reminders WHERE id = ? AND chat_id = ?')
      .bind(+um[1], cb.message.chat.id).first();
    if (!r) return answerCallback(env, cb.id, 'Already gone.');
    const firings = await env.DB.prepare(
      "SELECT * FROM firings WHERE reminder_id = ? AND state = 'nagging'"
    ).bind(r.id).all();
    for (const f of firings.results) {
      if (f.last_message_id) await deleteNag(env, f);
      if (f.last_sticker_id) await deleteMessage(env, nagChat(f), f.last_sticker_id);
    }
    await env.DB.prepare("DELETE FROM firings WHERE reminder_id = ? AND state = 'nagging'").bind(r.id).run();
    await env.DB.prepare('DELETE FROM reminders WHERE id = ?').bind(r.id).run();
    await editRef(env, ctx, r.chat_id, ref, `↩️ Undone — <s>${esc(r.text)}</s>`);
    await updateDashboard(env, r.chat_id);
    return answerCallback(env, cb.id, 'Undone');
  }

  // Undo a /delete: restore the stashed reminder row.
  const tr = data.match(/^t:(\d+)$/);
  if (tr) {
    const row = await env.DB.prepare('SELECT * FROM trash WHERE id = ? AND chat_id = ?')
      .bind(+tr[1], cb.message.chat.id).first();
    if (!row) return answerCallback(env, cb.id, 'Too late — that one is gone for good.');
    const r = JSON.parse(row.payload);
    // Reclaim the old number if still free, else take the smallest unused.
    const { results } = await env.DB.prepare('SELECT display_num FROM reminders WHERE chat_id = ?').bind(r.chat_id).all();
    const used = new Set(results.map((x) => x.display_num));
    let num = r.display_num;
    if (used.has(num)) { num = 1; while (used.has(num)) num++; }
    await env.DB.prepare(
      `INSERT INTO reminders (chat_id, display_num, text, assignee_name, assignee_user_id, schedule_kind,
         schedule_detail, next_fire_at, nag_intervals, created_by, created_at, scored)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      r.chat_id, num, r.text, r.assignee_name, r.assignee_user_id, r.schedule_kind,
      r.schedule_detail, r.next_fire_at != null ? r.next_fire_at : Date.now(), r.nag_intervals,
      r.created_by, r.created_at, r.scored != null ? r.scored : 1
    ).run();
    await env.DB.prepare('DELETE FROM trash WHERE id = ?').bind(row.id).run();
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
    await editRef(env, ctx, firing.chat_id, ref,
      `😻 <s>${esc(firing.reminder_text || 'chore')}</s> — done early by ${esc(credit)}. The cats are impressed.` +
      (next && next.next_fire_at ? `\nNext: ${fmtLocal(next.next_fire_at, tz)}` : ''),
      { inline_keyboard: [[{ text: '✅ OK', callback_data: 'ok' }]] });
    return answerCallback(env, cb.id, 'Shared credit 🤝');
  }

  // Dismiss a log line. Works on either kind of message, since deleteRef picks
  // the method from the ref rather than assuming a public message id.
  if (data === 'ok') {
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
    if (zm[2] === 'b') {
      const wasSnoozed = String(cb.message.text || '').startsWith('😴');
      const buttons = wasSnoozed ? snoozedButtons(firing.id, isScored(firing)) : nagButtons(firing.id, isScored(firing));
      // An ephemeral message has no reply-markup-only edit, so its text has to
      // be re-rendered alongside the keyboard.
      if (isEphemeralNag(firing)) {
        const rem = await env.DB.prepare('SELECT * FROM reminders WHERE id = ?')
          .bind(firing.reminder_id).first();
        if (rem) {
          const ztz = await getTz(env, firing.chat_id);
          await editNag(env, firing, wasSnoozed
            ? snoozedHtml(rem, firing.next_nag_at, senderName(cb.from), ztz)
            : nagHtml(rem, firing.nag_count, firing.cat || 'both'), buttons);
        }
      } else {
        await editReplyMarkup(env, nagChat(firing), cb.message.message_id, buttons);
      }
      return answerCallback(env, cb.id, '');
    }
    if (firing.snoozes_used >= MAX_SNOOZES) {
      return answerCallback(env, cb.id, `No more snoozes 😈 (max ${MAX_SNOOZES})`);
    }
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
    const res = postpone
      ? await env.DB.prepare(
        `UPDATE firings SET snoozes_used = snoozes_used + 1, next_nag_at = ?, fired_at = ?
         WHERE id = ? AND state = 'nagging' AND snoozes_used < ?`
      ).bind(until, until, firing.id, MAX_SNOOZES).run()
      : await env.DB.prepare(
        "UPDATE firings SET snoozes_used = snoozes_used + 1, next_nag_at = ? WHERE id = ? AND state = 'nagging' AND snoozes_used < ?"
      ).bind(until, firing.id, MAX_SNOOZES).run();
    if (!res.meta.changes) return answerCallback(env, cb.id, 'Already handled 👍');
    const reminder = await env.DB.prepare('SELECT * FROM reminders WHERE id = ?').bind(firing.reminder_id).first();
    if (reminder && firing.last_message_id) {
      await editNag(env, firing,
        snoozedHtml(reminder, until, senderName(cb.from), tz), snoozedButtons(firing.id, isScored(firing)));
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
  const reminder = await env.DB.prepare('SELECT * FROM reminders WHERE id = ?').bind(firing.reminder_id).first();
  if (!reminder) {
    await env.DB.prepare("UPDATE firings SET state = 'expired', next_nag_at = NULL WHERE id = ?").bind(firing.id).run();
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
  if (isEphemeralNag(firing)) {
    await editNag(env, firing, nagHtml(reminder, firing.nag_count, firing.cat || 'both'),
      snoozeButtons(firing.id, tz));
  } else {
    await editReplyMarkup(env, nagChat(firing), cb.message.message_id, snoozeButtons(firing.id, tz));
  }
  return answerCallback(env, cb.id, '');
}
