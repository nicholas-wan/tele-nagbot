// Webhook update handling: commands and inline-button callbacks.

import { sendMessage, editMessage, deleteMessage, editReplyMarkup, answerCallback, esc, mentionHtml, pinMessage, unpinMessage,
         replyCtx, sendPrivate, deleteEphemeral, editRef, deleteRef, msgRef, callbackRef,
         recordSentMessage, retimeSentMessage, RECEIPT_TTL_MS } from './tg.js';
import { parseRemind, ParseError, NoTimeError, DEFAULT_NAGS } from './parse.js';
import { nextOccurrence, fmtLocal, fmtShort, fmtTime, fmtClock, localParts, zonedEpoch, weekStart, deferQuietHours } from './time.js';
import { createStickerSet, deleteSticker, lookupPack, tagSticker, autoTagPack, listTags, sendCelebrationSticker } from './stickers.js';
import { tg } from './tg.js';
import { fireReminder } from './firing.js';
import { suggestSchedule } from './ai.js';
import { cmdInvite } from './invite.js';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MAX_SNOOZES = 3;
export const EXPIRE_AFTER_MS = 24 * 3600000;

// Cached getMe username, fetched only when a /cmd@bot suffix needs checking.
let botUsername = null;

export async function getTz(env, chatId) {
  const row = await env.DB.prepare('SELECT tz FROM settings WHERE chat_id = ?').bind(chatId).first();
  return row ? row.tz : 'Asia/Singapore';
}

function senderName(from) {
  return from.username ? `@${from.username}` : from.first_name || 'someone';
}

// /chore and /remind are different things and their nags say so. A reminder is
// unscored, so "Done together" — which exists only to split leaderboard credit
// — has nothing to split and is left off.
export const isScored = (row) => (row && row.scored != null ? Boolean(row.scored) : true);

export function nagButtons(firingId, scored = true) {
  const first = [{ text: '✅ Done', callback_data: `d:${firingId}` }];
  if (scored) first.push({ text: '🤝 Done together', callback_data: `b:${firingId}` });
  first.push({ text: '😴 Snooze…', callback_data: `s:${firingId}` });
  return {
    inline_keyboard: [
      first,
      [{ text: scored ? '🗑 Delete chore' : '🗑 Delete reminder', callback_data: `x:${firingId}` }],
    ],
  };
}

const emptyKeyboard = () => ({ inline_keyboard: [] });

function snoozedButtons(firingId, scored = true) {
  const first = [{ text: '✅ Done', callback_data: `d:${firingId}` }];
  if (scored) first.push({ text: '🤝 Done together', callback_data: `b:${firingId}` });
  first.push({ text: '🕐 Change snooze', callback_data: `s:${firingId}` });
  return { inline_keyboard: [
    first,
    [{ text: scored ? '🗑 Delete chore' : '🗑 Delete reminder', callback_data: `x:${firingId}` }],
  ] };
}

// Everyone the cats have seen tap Done in this chat (combined credits split).
const CREDIT_SEP = ' & ';
async function householdRoster(env, chatId) {
  const { results } = await env.DB.prepare(
    "SELECT DISTINCT done_by FROM firings WHERE chat_id = ? AND state = 'done' AND done_by IS NOT NULL"
  ).bind(chatId).all();
  const set = new Set();
  for (const r of results) {
    for (const p of String(r.done_by).split(CREDIT_SEP)) if (p.trim()) set.add(p.trim());
  }
  return set;
}

// "jane" typed by hand matches the roster's "@jane" spelling.
function canonName(roster, name) {
  const norm = (s) => String(s).replace(/^@/, '').toLowerCase();
  for (const r of roster) if (norm(r) === norm(name)) return r;
  return name;
}

// Combined credit: the actor first, then the given others, deduped.
function creditTogether(by, others) {
  const seen = new Set([by]);
  for (const o of others) seen.add(o);
  return [...seen].join(CREDIT_SEP);
}

function snoozeButtons(firingId, tz) {
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

// Undo removes the chore that was just made; OK just clears the confirmation.
function undoButtons(reminderId) {
  return { inline_keyboard: [[
    { text: '↩️ Undo', callback_data: `u:${reminderId}` },
    { text: '✅ OK', callback_data: 'ok' },
  ]] };
}

function dashboardButtons() {
  return { inline_keyboard: [[{ text: '⚙️ Manage chores', callback_data: 'm:list' }]] };
}

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
  await sendMessage(env, msg.chat.id,
    `${hello}\nTry:\n/remind take out trash 7pm daily\n/remind dishes now\n/list · /stats · /help`);
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
  const head = `🐱 <b>${esc(reminder.text)}</b>${nagCount > 0 ? ` — nag #${nagCount + 1}` : ''}`;
  const lines = NAG_LINES[cat] || NAG_LINES.both;
  const line = lines[Math.min(nagCount, lines.length - 1)];
  const who = reminder.assignee_name
    ? `${mentionHtml(reminder.assignee_name, reminder.assignee_user_id)} — `
    : '';
  return `${head}\n${who}${line}`;
}

function snoozedHtml(reminder, until, by, tz) {
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
const isEphemeralNag = (firing) => Boolean(firing.last_message_ephemeral);

function editNag(env, firing, html, markup) {
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

async function showPausedCard(env, firing, reminder, by, tz, until = null) {
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

export async function expireFiring(env, firing, reminder, { silent } = {}) {
  const res = await env.DB.prepare(
    "UPDATE firings SET state = 'expired', next_nag_at = NULL WHERE id = ? AND state = 'nagging'"
  ).bind(firing.id).run();
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

// One pinned message per chat, silently edited in place: the full chore list
// (nagging marked 🔔, paused included). Created on first need, unpinned and
// removed only when the chore list is empty.
export async function updateDashboard(env, chatId) {
  try {
    const row = await env.DB.prepare(
      'SELECT dashboard_msg_id, tz FROM settings WHERE chat_id = ?'
    ).bind(chatId).first();
    const msgId = row && row.dashboard_msg_id;
    const tz = (row && row.tz) || 'Asia/Singapore';
    let html = await choreListHtml(env, chatId, tz);

    if (!html) {
      if (msgId) {
        await unpinMessage(env, chatId, msgId);
        await deleteMessage(env, chatId, msgId);
        await env.DB.prepare('UPDATE settings SET dashboard_msg_id = NULL WHERE chat_id = ?').bind(chatId).run();
      }
      return;
    }
    // A pin is a single message; past the 4096 cap, trim on a line boundary.
    if (html.length > 4000) {
      html = html.slice(0, html.lastIndexOf('\n', 3980)) + '\n… more — /list';
    }

    if (msgId) {
      const res = await editMessage(env, chatId, msgId, html, dashboardButtons());
      if (res.ok || String(res.description || '').includes('not modified')) return;
      // Message was deleted by hand — fall through and recreate it.
    }
    // keep: the pinned dashboard is the one message the daily sweep spares.
    const sent = await sendMessage(env, chatId, html, dashboardButtons(), { silent: true, keep: true });
    if (sent.ok) {
      // A board that exists but isn't pinned is worse than a missing one: it
      // scrolls away and nobody notices it stopped being the board. Say so
      // loudly rather than failing silently.
      const pinned = await pinMessage(env, chatId, sent.result.message_id);
      if (!pinned.ok) {
        console.log(`dashboard pin FAILED for chat ${chatId}: ${pinned.description || 'unknown'} ` +
          '— bot needs the Pin Messages admin right');
      }
      await env.DB.prepare(
        'INSERT INTO settings (chat_id, dashboard_msg_id) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET dashboard_msg_id = excluded.dashboard_msg_id'
      ).bind(chatId, sent.result.message_id).run();
    } else {
      console.log(`dashboard send failed for chat ${chatId}: ${sent.description || 'unknown'}`);
    }
  } catch (e) {
    console.log(`updateDashboard failed: ${e}`);
  }
}

function describeSchedule(r) {
  const d = JSON.parse(r.schedule_detail);
  if (r.schedule_kind === 'daily') return `daily ${fmtTime(d.h, d.mi)}`;
  if (r.schedule_kind === 'weekly') {
    return `every ${d.days.map((i) => DAY_NAMES[i]).join(',')} ${fmtTime(d.h, d.mi)}`;
  }
  if (r.schedule_kind === 'monthly') return `on the ${d.dom} at ${fmtTime(d.h, d.mi)}`;
  if (r.schedule_kind === 'interval') {
    if (d.months) return `every ${d.months} month${d.months > 1 ? 's' : ''} at ${fmtTime(d.h, d.mi)}`;
    const w = d.days % 7 === 0 ? d.days / 7 : 0;
    return w ? `every ${w} week${w > 1 ? 's' : ''} at ${fmtTime(d.h, d.mi)}`
             : `every ${d.days} days at ${fmtTime(d.h, d.mi)}`;
  }
  return 'once';
}

// Household lock: only chats listed in ALLOWED_CHATS (comma-separated ids)
// are served; everything else — stranger DMs included — is dropped silently.
// Missing configuration fails closed: a deploy must explicitly name every
// chat the bot is allowed to serve.
function chatAllowed(env, chatId) {
  const allowed = String(env.ALLOWED_CHATS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return allowed.length > 0 && chatId != null && allowed.includes(String(chatId));
}

// Group members the bot has seen; source of DM routing for assigned nags.
async function rememberMember(env, chatId, from) {
  await env.DB.prepare(
    `INSERT INTO members (chat_id, user_id, username, first_name, last_seen) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(chat_id, user_id) DO UPDATE SET username = excluded.username,
       first_name = excluded.first_name, last_seen = excluded.last_seen`
  ).bind(chatId, from.id, from.username || null, from.first_name || null, Date.now()).run();
}

async function isMember(env, userId) {
  const row = await env.DB.prepare('SELECT 1 AS x FROM members WHERE user_id = ?').bind(userId).first();
  return Boolean(row);
}

// A household member's private chat: nag interactions work (buttons arrive as
// callbacks regardless, replies and reactions resolve via nag_chat_id); chore
// management stays in the group. Any DM opens their nag line.
async function handleMemberDm(env, update, chat, from) {
  await env.DB.prepare('UPDATE members SET dm_ok = 1 WHERE user_id = ?').bind(from.id).run();
  if (update.message_reaction) return handleReaction(env, update.message_reaction);
  if (update.callback_query) return handleCallback(env, update.callback_query);
  const msg = update.message;
  if (!msg || !msg.text) return;
  if (/^\/start\b/i.test(msg.text)) {
    return sendMessage(env, chat.id,
      '😺 Mrow! Your personal nag line is open — chores assigned to you will pester you here.\nManage the chore list in the family group.');
  }
  if (msg.text.startsWith('/')) {
    return sendMessage(env, chat.id, '😺 Manage chores in the family group — this DM is just for your nags.');
  }
  return handlePlainText(env, msg);
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
    // Private chats: known household members get their DM nag line; everyone
    // else stays silently ignored.
    if (!env.DB || !chat || chat.id < 0 || !from || from.is_bot) return;
    if (!(await isMember(env, from.id))) return;
    return handleMemberDm(env, update, chat, from);
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

    if (!handled) return sendPrivate(env, ctx, `😿 Unknown command /${esc(cmd)}. Try /help.`);
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

// True only for a real public group message. Ephemeral messages report
// message_id 0, so a falsy check is the guard — not `!== undefined`.
function isPublicMessage(msg) {
  return Boolean(msg && msg.message_id && !msg.ephemeral_message_id);
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
    '/stats · /stats all — weekly board and history\n' +
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
  let p;
  try {
    p = parseRemind(args, msg.text, msg.entities, now, tz);
  } catch (err) {
    if (err instanceof NoTimeError) return startWizard(env, ctx, err.partial, args, tz, scored);
    throw err;
  }
  p.scored = scored;
  const { id, html } = await createReminder(env, chatId, p, by, tz);
  await sendPrivate(env, ctx, html, undoButtons(id));
  await announceNewChore(env, chatId, by, p, tz);
  // "now" reminders fire on the spot instead of waiting for the next cron tick.
  if (p.firstFireAt <= Date.now() + 500) {
    const row = await env.DB.prepare('SELECT * FROM reminders WHERE id = ?').bind(id).first();
    if (row) await fireReminder(env, row, Date.now(), tz);
  }
}

// An unassigned chore is the household's problem, so its arrival is announced:
// the creator's own confirmation is private and nobody else would see it
// otherwise. An assigned one is not — it will nag its person privately, so
// announcing it here would hand the group the very thing that nag hides. The
// pinned dashboard still lists both.
async function announceNewChore(env, chatId, by, p, tz) {
  if (p.assigneeName || p.assigneeUserId) return;
  await sendMessage(env, chatId,
    `📝 ${esc(by)} added <b>${esc(p.text)}</b> — ${fmtLocal(p.firstFireAt, tz)}`);
}

async function createReminder(env, chatId, p, by, tz) {
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

// No time given: park the parsed pieces as a draft and offer tap-to-choose
// times instead of an error. Workers AI gets one shot at guessing the intent;
// a valid guess becomes the top button — applied only if someone taps it.
async function startWizard(env, ctx, partial, rawArgs, tz, scored) {
  const chatId = ctx.chatId;
  const now = Date.now();
  let ai = null;
  if (rawArgs && env.AI) {
    try {
      ai = await suggestSchedule(env, rawArgs, tz, now);
    } catch (e) {
      console.log(`ai suggest failed: ${e}`);
    }
  }
  const res = await env.DB.prepare(
    `INSERT INTO drafts (chat_id, text, assignee_name, assignee_user_id, schedule_kind,
       schedule_detail, nag_intervals, ai_json, created_at, scored)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    chatId, partial.text, partial.assigneeName, partial.assigneeUserId, partial.kind,
    JSON.stringify(partial.detail), JSON.stringify(partial.nagIntervals),
    ai ? JSON.stringify(ai) : null, Date.now(), scored ? 1 : 0
  ).run();
  const id = res.meta.last_row_id;

  const btn = (label, code) => ({ text: label, callback_data: `w:${id}:${code}` });
  const seven = nextOccurrence('daily', { h: 19, mi: 0 }, now, tz);
  const p = localParts(now, tz);
  const endOfToday = zonedEpoch(p.y, p.mo, p.d, 23, 59, tz);
  const tomorrowNine = nextOccurrence('daily', { h: 9, mi: 0 }, endOfToday, tz);
  const keyboard = partial.kind === 'once'
    ? [
        [btn('In 15 min', 'r15'), btn('In 1 hour', 'r60')],
        [btn(fmtShort(seven, tz), `a${seven}`), btn(fmtShort(tomorrowNine, tz), `a${tomorrowNine}`)],
        [btn('Every day 7pm', 'd19'), btn('✏️ Type a time', 'custom')],
      ]
    : [
        [btn('8am', 'h8'), btn('12pm', 'h12'), btn('7pm', 'h19'), btn('9pm', 'h21')],
        [btn('✏️ Type a time', 'custom')],
      ];
  if (ai) keyboard.unshift([btn(`✨ ${ai.label}`, 'ai')]);
  keyboard.push([btn('✕ Cancel', 'cancel')]);

  const kindNote = partial.kind === 'once' ? '' :
    ` (${partial.kind === 'weekly' ? 'every ' + partial.detail.days.map((i) => DAY_NAMES[i]).join(',') :
        partial.kind === 'monthly' ? 'on the ' + partial.detail.dom :
        partial.kind === 'interval' ? `every ${partial.detail.days} days` : 'daily'})`;
  const sent = await sendPrivate(env, ctx,
    `🐾 When should Latte &amp; Mocha pester you about <b>${esc(partial.text)}</b>${kindNote}?\n` +
    'Tap an option, or reply with a custom time.',
    { inline_keyboard: keyboard }
  );
  const ref = msgRef(sent);
  if (ref) {
    await env.DB.prepare('UPDATE drafts SET wizard_msg_id = ?, wizard_msg_ephemeral = ? WHERE id = ?')
      .bind(ref.id, ref.ephemeral ? 1 : 0, id).run();
  }
}

// Rebuild a stored { id, ephemeral } pair from a drafts row.
function draftRef(draft, field) {
  const id = draft[`${field}_msg_id`];
  return id ? { id, ephemeral: Boolean(draft[`${field}_msg_ephemeral`]) } : null;
}

// Plain (non-command) text: only meaningful as a custom time for a pending
// draft — either a reply to the wizard/prompt message, or freshly typed
// after a recent popup. Anything else is ignored (normal chat).
async function handlePlainText(env, msg) {
  const chatId = msg.chat.id;
  const now = Date.now();
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

  // A draft accepts a time sent as a reply to its wizard/prompt message.
  // Safety net: after "✏️ Type a time" was tapped (prompt exists), a message
  // that is PURELY a time also counts — some group clients never surface the
  // forced reply. Ambient chat ("movie at 8pm") has leftover words and is
  // rejected below.
  let draft = null;
  let bareTime = false;
  if (replyRef) {
    // Ephemeral and public ids come from separate sequences, so the flag has to
    // be part of the match or a stray collision could resolve the wrong draft.
    const eph = replyRef.ephemeral ? 1 : 0;
    draft = await env.DB.prepare(
      `SELECT * FROM drafts WHERE chat_id = ?
         AND ((prompt_msg_id = ? AND prompt_msg_ephemeral = ?)
           OR (wizard_msg_id = ? AND wizard_msg_ephemeral = ?))`
    ).bind(chatId, replyRef.id, eph, replyRef.id, eph).first();
  }
  if (!draft) {
    draft = await env.DB.prepare(
      'SELECT * FROM drafts WHERE chat_id = ? AND prompt_msg_id IS NOT NULL AND created_at > ? ORDER BY id DESC LIMIT 1'
    ).bind(chatId, now - 15 * 60000).first();
    bareTime = true;
  }
  if (!draft) return;

  const tz = await getTz(env, chatId);
  let parsed;
  try {
    // Dummy task word satisfies the parser; we only want the schedule.
    parsed = parseRemind(`x ${msg.text}`, `x ${msg.text}`, [], now, tz);
  } catch (err) {
    if (!bareTime && err instanceof ParseError) {
      await sendPrivate(env, ctx,
        '😿 The cats couldn\'t read that as a time — try <code>10am</code>, <code>tomorrow 9:30am</code>, or <code>in 30m</code>.');
    }
    return;
  }
  // Non-reply path: anything beyond the bare time means normal conversation.
  if (bareTime && parsed.text !== 'x') return;

  // The typed reply carries the time; the draft carries everything else.
  let { kind, detail, firstFireAt } = parsed;
  if (kind === 'once' && draft.schedule_kind !== 'once' && parsed.detail.h != null) {
    kind = draft.schedule_kind;
    detail = { ...JSON.parse(draft.schedule_detail), h: parsed.detail.h, mi: parsed.detail.mi };
    firstFireAt = nextOccurrence(kind, detail, now, tz);
  }
  const p = {
    text: draft.text, assigneeName: draft.assignee_name, assigneeUserId: draft.assignee_user_id,
    nagIntervals: JSON.parse(draft.nag_intervals), kind, detail, firstFireAt, scored: draft.scored,
  };
  // Claim the draft before creating anything. A second reply or wizard tap
  // racing this one loses the conditional delete and cannot create a duplicate.
  const claim = await env.DB.prepare('DELETE FROM drafts WHERE id = ? AND chat_id = ?')
    .bind(draft.id, chatId).run();
  if (!claim.meta.changes) return;
  const by = senderName(msg.from);
  const { id, html } = await createReminder(env, chatId, p, by, tz);
  const wizardRef = draftRef(draft, 'wizard');
  if (wizardRef) await editRef(env, ctx, chatId, wizardRef, html, undoButtons(id));
  else await sendPrivate(env, ctx, html, undoButtons(id));
  const promptRef = draftRef(draft, 'prompt');
  if (promptRef) await deleteRef(env, ctx, chatId, promptRef);
  if (isPublicMessage(msg)) await deleteMessage(env, chatId, msg.message_id);
  await announceNewChore(env, chatId, by, p, tz);
  if (p.firstFireAt <= Date.now() + 500) {
    const row = await env.DB.prepare('SELECT * FROM reminders WHERE id = ?').bind(id).first();
    if (row) await fireReminder(env, row, Date.now(), tz);
  }
}

// Any thumbs-up-ish reaction on a live nag message counts as ✅ Done.
const DONE_REACTIONS = new Set(['👍', '✅', '👌', '💯', '🫡', '💪', '❤', '🔥', '🎉']);

async function handleReaction(env, rx) {
  if (!rx.user || rx.user.is_bot) return;
  const hit = (rx.new_reaction || []).some(
    (r) => r.type === 'emoji' && DONE_REACTIONS.has(r.emoji)
  );
  if (!hit) return;
  const firing = await env.DB.prepare(
    "SELECT * FROM firings WHERE (chat_id = ? OR nag_chat_id = ?) AND last_message_id = ? AND state = 'nagging'"
  ).bind(rx.chat.id, rx.chat.id, rx.message_id).first();
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
  if (/^done\b/i.test(text) || text.includes('✅')) {
    const reminder = await env.DB.prepare('SELECT * FROM reminders WHERE id = ?').bind(firing.reminder_id).first();
    if (!reminder) return;
    let by = senderName(msg.from);
    // "done together"/"done both" credits the whole roster; "done with @jane"
    // credits the replier plus the named helpers.
    const together = /^done\s+(?:together|both)\b/i.test(text);
    const withM = text.match(/^done\s+with\s+(.+?)\s*!*$/i);
    if (together || withM) {
      const roster = await householdRoster(env, msg.chat.id);
      const others = withM
        ? withM[1].split(/\s*(?:,|&|\+|\band\b)\s*/i).map((s) => s.trim()).filter(Boolean)
            .map((n) => canonName(roster, n))
        : [...roster];
      by = creditTogether(by, others);
    }
    const won = await completeFiring(env, firing, reminder, by, tz);
    if (!won) return sendPrivate(env, ctx, '😼 Someone beat you to it — already handled.');
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
}

function scheduleFromCode(code, draft, now, tz) {
  const kind = draft.schedule_kind;
  const detail = JSON.parse(draft.schedule_detail);
  const absolute = code.match(/^a(\d+)$/);
  if (absolute) {
    const firstFireAt = +absolute[1];
    return firstFireAt > now ? { kind: 'once', detail: {}, firstFireAt } : null;
  }
  if (code === 'r15' || code === 'r60') {
    return { kind: 'once', detail: {}, firstFireAt: now + (code === 'r15' ? 15 : 60) * 60000 };
  }
  if (code === 't19') {
    const d = { h: 19, mi: 0 };
    return { kind: 'once', detail: d, firstFireAt: nextOccurrence('daily', d, now, tz) };
  }
  if (code === 'm9') {
    const d = { h: 9, mi: 0 };
    const p = localParts(now, tz);
    const endOfToday = zonedEpoch(p.y, p.mo, p.d, 23, 59, tz);
    return { kind: 'once', detail: d, firstFireAt: nextOccurrence('daily', d, endOfToday, tz) };
  }
  if (code === 'd19') {
    const d = { h: 19, mi: 0 };
    return { kind: 'daily', detail: d, firstFireAt: nextOccurrence('daily', d, now, tz) };
  }
  const hm = code.match(/^h(\d+)$/);
  if (hm) {
    const d = { ...detail, h: +hm[1], mi: 0 };
    return { kind, detail: d, firstFireAt: nextOccurrence(kind, d, now, tz) };
  }
  return null;
}

// Schedule cadence without the time-of-day (list cards lead with the time).
function cadence(r) {
  const d = JSON.parse(r.schedule_detail);
  if (r.schedule_kind === 'daily') return 'daily';
  if (r.schedule_kind === 'weekly') return `every ${d.days.map((i) => DAY_NAMES[i]).join(',')}`;
  if (r.schedule_kind === 'monthly') return `on the ${d.dom}`;
  if (r.schedule_kind === 'interval') {
    if (d.months) return `every ${d.months} month${d.months > 1 ? 's' : ''}`;
    const w = d.days % 7 === 0 ? d.days / 7 : 0;
    return w ? `every ${w} week${w > 1 ? 's' : ''}` : `every ${d.days} days`;
  }
  return 'once';
}

// Hybrid countdown + absolute: "today 9:00 PM" / "tomorrow 9:00 AM" /
// "in 3 days · Fri 5:00 PM" / "in 13 days · Aug 24, 7:00 PM".
function fmtWhen(ms, tz) {
  const time = fmtClock(ms, tz);
  const t = localParts(ms, tz);
  const n = localParts(Date.now(), tz);
  const days = Math.round((Date.UTC(t.y, t.mo - 1, t.d) - Date.UTC(n.y, n.mo - 1, n.d)) / 86400000);
  if (days <= 0) return `today ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  const when = days < 7 ? `${DAY_NAMES[t.wd]} ${time}` : fmtShort(ms, tz);
  return `in ${days} days · ${when}`;
}

// Renders the chore-card list shared by /list and the pinned dashboard.
// Null when there are no chores at all.
async function choreListHtml(env, chatId, tz) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM reminders WHERE chat_id = ? ORDER BY id'
  ).bind(chatId).all();
  if (!results.length) return null;
  const st = await env.DB.prepare('SELECT paused_until FROM settings WHERE chat_id = ?').bind(chatId).first();
  const nagging = new Set((await env.DB.prepare(
    "SELECT reminder_id FROM firings WHERE chat_id = ? AND state = 'nagging'"
  ).bind(chatId).all()).results.map((f) => f.reminder_id));
  const lines = ['🐾 <b>Chores</b>'];
  if (st && st.paused_until && st.paused_until > Date.now()) {
    lines.push(`✈️ All paused until ${fmtLocal(st.paused_until, tz)} — /resume all to wake the cats.`);
  }
  // Nagging first, then upcoming soonest-first, paused last.
  const rank = (r) => r.paused ? 2 : (nagging.has(r.id) || !r.next_fire_at) ? 0 : 1;
  results.sort((a, b) => rank(a) - rank(b)
    || (a.next_fire_at || 0) - (b.next_fire_at || 0)
    || a.display_num - b.display_num);
  // Two short lines per chore — when, then what — so nothing wraps on a phone
  // (squashbot's board layout). "once" says nothing a missing cadence doesn't.
  for (const r of results) {
    const rot = r.schedule_detail.includes('"rotate"') ? ' 🔄' : '';
    const who = r.assignee_name ? ` · ${esc(r.assignee_name)}` : '';
    const lead = r.paused ? '⏸️ paused'
      : nagging.has(r.id) || !r.next_fire_at ? '🔔 nagging now'
      : fmtWhen(r.next_fire_at, tz);
    const each = cadence(r);
    lines.push('');
    lines.push(lead);
    lines.push(`${[choreEmoji(r.text), `<b>${esc(r.text)}</b>`].filter(Boolean).join(' ')}${rot}${who}` +
      (each === 'once' ? '' : ` · <i>${each}</i>`));
  }
  return lines.join('\n');
}

async function cmdList(env, ctx, tz) {
  const html = await choreListHtml(env, ctx.chatId, tz);
  if (!html) return sendPrivate(env, ctx, '😺 No chores on the list. Add one with /remind.');
  // Doubles as the manual board repair: if the pin was lost — a group upgrade,
  // someone unpinning by hand — /list puts it back.
  await updateDashboard(env, ctx.chatId);
  await sendPrivateLong(env, ctx, html);
}

// sendLong's chunking, but private. Only the final chunk keeps the callback
// credential, which sendPrivate consumes on first use anyway.
const TG_MAX = 4096;
async function sendPrivateLong(env, ctx, html) {
  if (html.length <= TG_MAX) return sendPrivate(env, ctx, html);
  let last;
  let chunk = '';
  for (const line of html.split('\n')) {
    if (chunk && chunk.length + 1 + line.length > TG_MAX) {
      last = await sendPrivate(env, ctx, chunk);
      chunk = '';
    }
    chunk = chunk ? `${chunk}\n${line}` : line;
  }
  if (chunk) last = await sendPrivate(env, ctx, chunk);
  return last;
}

async function cmdEdit(env, ctx, args, tz) {
  const r = await findReminder(env, ctx.chatId, args, 'edit');
  await sendPrivate(env, ctx, editorText(r, tz), await editorButtons(env, r));
}

// Chores are addressed by name ("/done nails"); bare numbers still work as
// the legacy handles.
async function findReminder(env, chatId, args, cmd = 'delete') {
  const raw = String(args).replace('#', '').trim();
  if (!raw) throw new ParseError(`Which chore? e.g. /${cmd} nails (see /list).`);
  const { results } = await env.DB.prepare('SELECT * FROM reminders WHERE chat_id = ?').bind(chatId).all();
  const num = parseInt(raw, 10);
  if (num) {
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

async function cmdDelete(env, ctx, args) {
  const r = await findReminder(env, ctx.chatId, args);
  await deleteReminder(env, r, ctx);
}

// `by` names the person in the log line. A deletion removes the chore for
// everyone, so when it is triggered from a nag the log goes to the group even
// though the nag itself may have been private — both of you need to see it.
async function deleteReminder(env, r, ctx = null, by = null) {
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

async function setReminderPaused(env, r, pause, tz, by) {
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
  if (!firing) throw new ParseError(`"${r.text}" is not currently nagging.`);
  let credit = by;
  if (/\b(together|both)\b/i.test(String(args))) {
    const roster = await householdRoster(env, chatId);
    credit = creditTogether(by, [...roster]);
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

async function cmdMakeStickers(env, ctx, msg) {
  const res = await createStickerSet(env, msg.from.id);
  if (res.ok) {
    const link = `https://t.me/addstickers/${res.name}`;
    await sendPrivate(env, ctx, res.already
      ? (res.added
          ? `🐾 Added ${res.added} new sticker${res.added > 1 ? 's' : ''} to <a href="${link}">Latte &amp; Mocha</a>.`
          : `🐾 The pack already exists and is up to date: <a href="${link}">Latte &amp; Mocha</a>`)
      : `🎉 Sticker pack created: <a href="${link}">Latte &amp; Mocha</a>\n` +
        'Random cat stickers now accompany every nag. Tap the link to add them to your own sticker keyboard too!');
  } else {
    await sendPrivate(env, ctx, `😿 Telegram refused: ${esc(res.description || 'unknown error')}`);
  }
}

async function cmdDelSticker(env, ctx, args) {
  const index = parseInt(args, 10);
  if (!index) throw new ParseError('Which one? e.g. /delsticker 3 (position in the pack, per /tags).');
  const res = await deleteSticker(env, ctx.chatId, index);
  if (res.ok) {
    await sendPrivate(env, ctx, `🗑️ Sticker ${index} removed — ${res.remaining} left in the pack.`);
  } else {
    await sendPrivate(env, ctx,
      `😿 ${esc(res.description || 'Telegram refused.')}\n` +
      'Note: only packs created by this bot can be edited here — packs made via @Stickers are edited there.');
  }
}

async function cmdTagSticker(env, ctx, args) {
  const m = args.trim().match(/^#?(\d+)\s+(latte|mocha|both)$/i);
  if (!m) throw new ParseError('Usage: /tagsticker 3 latte (or mocha, or both) — position in the active pack.');
  const res = await tagSticker(env, ctx.chatId, +m[1], m[2].toLowerCase());
  if (!res.ok) return sendPrivate(env, ctx, `😿 ${esc(res.description)}`);
  const label = m[2].toLowerCase() === 'both' ? 'Latte &amp; Mocha' : m[2][0].toUpperCase() + m[2].slice(1).toLowerCase();
  await sendPrivate(env, ctx, `🏷️ Sticker ${+m[1]} is ${label}. The nag lines will match.`);
}

async function cmdAutoTag(env, ctx, args = '') {
  const redo = /\bredo\b/i.test(args);
  await sendPrivate(env, ctx, redo
    ? '🔎 Wiping old tags — the cats are re-inspecting the pack…'
    : '🔎 The cats are inspecting the sticker pack…');
  const res = await autoTagPack(env, ctx.chatId, { redo });
  if (!res.ok) return sendPrivate(env, ctx, `😿 ${esc(res.description)}`);
  const c = res.counts;
  if (!res.processed && !c.skipped) {
    return sendPrivate(env, ctx, '🏷️ Everything in the pack is already tagged.');
  }
  let msg = `🤖 Tagged ${res.processed} sticker${res.processed === 1 ? '' : 's'}: ` +
    `${c.latte} Latte, ${c.mocha} Mocha, ${c.both} both` +
    (c.skipped ? `, ${c.skipped} skipped` : '') + '.';
  if (res.remaining) msg += `\n${res.remaining} to go — run /autotag again.`;
  msg += '\nFix any misses with /tagsticker N latte (position in the pack).';
  await sendPrivate(env, ctx, msg);
}

const CAT_LABEL = { latte: 'Latte 🥛', mocha: 'Mocha 🍫', both: 'Latte &amp; Mocha 🐈🐈' };

async function cmdTags(env, ctx, args) {
  const chatId = ctx.chatId;
  const res = await listTags(env, chatId);
  if (!res.ok) return sendPrivate(env, ctx, `😿 ${esc(res.description)}`);
  const n = parseInt(args, 10);
  if (n) {
    const e = res.entries.find((x) => x.pos === n);
    if (!e) throw new ParseError(`The pack has ${res.entries.length} stickers — pick 1 to ${res.entries.length}.`);
    // A sticker cannot be sent ephemerally with a caption attached, so the
    // preview itself is public; the label that follows is not.
    await recordSentMessage(env, chatId, await tg(env, 'sendSticker', { chat_id: chatId, sticker: e.fileId }));
    return sendPrivate(env, ctx,
      `☝️ Sticker ${n}: ${e.cat ? CAT_LABEL[e.cat] : 'untagged'} — change with /tagsticker ${n} latte|mocha|both`);
  }
  const lines = res.entries.map((e) => `${e.pos}. ${e.cat ? CAT_LABEL[e.cat] : '—'}`);
  await sendPrivate(env, ctx,
    `🏷️ <b>${esc(res.name)}</b> (order as shown in the pack)\n${lines.join('\n')}\n` +
    'Peek at one with /tags N · fix with /tagsticker N latte');
}

async function cmdUsePack(env, ctx, args) {
  const chatId = ctx.chatId;
  const raw = args.trim();
  if (!raw) {
    const row = await env.DB.prepare('SELECT sticker_set FROM settings WHERE chat_id = ?').bind(chatId).first();
    return sendPrivate(env, ctx,
      `Current nag stickers: <code>${esc((row && row.sticker_set) || 'Latte & Mocha (default)')}</code>\n` +
      'Switch with /usepack &lt;pack link or name&gt; — get the link by tapping any sticker → the pack name → share.\n' +
      'Back to the cats: /usepack reset');
  }
  if (raw.toLowerCase() === 'reset') {
    await env.DB.prepare(
      'INSERT INTO settings (chat_id, sticker_set) VALUES (?, NULL) ON CONFLICT(chat_id) DO UPDATE SET sticker_set = NULL'
    ).bind(chatId).run();
    return sendPrivate(env, ctx, '🐾 Back to the Latte &amp; Mocha pack.');
  }
  const pack = await lookupPack(env, raw);
  if (!pack.ok) {
    throw new ParseError(`Couldn't find a sticker pack called "${pack.name || raw}". Paste the t.me/addstickers/... link.`);
  }
  await env.DB.prepare(
    'INSERT INTO settings (chat_id, sticker_set) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET sticker_set = excluded.sticker_set'
  ).bind(chatId, pack.name).run();
  await sendPrivate(env, ctx,
    `🐾 Nag stickers switched to <b>${esc(pack.title)}</b> (${pack.count} stickers).`);
}

const STATS_MAX_PER_PERSON = 15;
const MEDALS = ['🥇', '🥈', '🥉'];

// Best-guess emoji for a chore, by keyword. Falls back to a paw.
const CHORE_EMOJI = [
  [/nails?|trim|groom/i, '✂️'],
  [/vaccin|nexgard|flea|tick|deworm|jab|injection/i, '💉'],
  [/fountain|aquarium|tank/i, '💧'],
  [/wifi|internet|router|broadband|modem|myrepublic/i, '🌐'],
  [/dish|plate|dishwasher|bowl|cutlery/i, '🍽️'],
  [/poop|litter|litterbox|scoop/i, '💩'],
  [/trash|garbage|rubbish|bin\b/i, '🗑️'],
  [/laundry|clothes|fold|iron/i, '🧺'],
  [/plant|water the|garden|flower/i, '🪴'],
  [/vacuum|sweep|mop|clean|dust|scrub|wipe/i, '🧹'],
  [/rent|pay|bill|tax|insurance/i, '💸'],
  [/cook|dinner|lunch|breakfast|meal|oven|bake/i, '🍳'],
  [/groceries|grocery|shop|buy|market/i, '🛒'],
  [/feed|food|treat/i, '🍚'],
  [/cat|latte|mocha|vet/i, '🐱'],
  [/car|gas|fuel|tire|oil/i, '🚗'],
  [/bed|sheet|pillow|blanket/i, '🛏️'],
  [/gym|run|walk|exercise/i, '🏃'],
  [/call|phone|email|message/i, '📞'],
  [/doctor|dentist|meds|medicine|pill/i, '💊'],
];

function choreEmoji(text) {
  // A chore typed with its own leading emoji is self-labeled — no second icon.
  if (/^\p{Extended_Pictographic}/u.test(text)) return '';
  for (const [re, emoji] of CHORE_EMOJI) if (re.test(text)) return emoji;
  return '📌';
}

// Fetches done-history and expired count for a window; shared by the weekly
// leaderboard, /stats all, and the Sunday recap.
export async function choreStats(env, chatId, since) {
  const expired = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM firings WHERE chat_id = ? AND state = 'expired' AND scored = 1 AND fired_at > ?"
  ).bind(chatId, since).first();
  const history = await env.DB.prepare(
    `SELECT f.done_by, f.done_at, COALESCE(f.reminder_text, r.text, '?') AS text
     FROM firings f LEFT JOIN reminders r ON r.id = f.reminder_id
     WHERE f.chat_id = ? AND f.state = 'done' AND f.scored = 1 AND f.done_at > ?
     ORDER BY f.done_at DESC`
  ).bind(chatId, since).all();
  const byPerson = new Map();
  for (const h of history.results) {
    // "nick & jane" (done together) credits each person individually.
    for (const who of String(h.done_by || '?').split(CREDIT_SEP)) {
      if (!byPerson.has(who)) byPerson.set(who, []);
      byPerson.get(who).push(h);
    }
  }
  const people = [...byPerson.entries()].sort((a, b) => b[1].length - a[1].length);
  return { people, expired: expired.n, total: history.results.length };
}

// Consecutive past full weeks the given person won outright (ties break it).
export async function winnerStreak(env, chatId, tz, leader) {
  let streak = 0;
  let start = weekStart(Date.now(), tz);
  for (let w = 0; w < 26; w++) {
    const end = start;
    start -= 7 * 86400000; // fixed-offset tz; exact for Asia/Singapore
    const { results } = await env.DB.prepare(
      "SELECT done_by FROM firings WHERE chat_id = ? AND state = 'done' AND scored = 1 AND done_at > ? AND done_at <= ?"
    ).bind(chatId, start, end).all();
    const counts = new Map();
    for (const r of results) {
      for (const p of String(r.done_by || '').split(CREDIT_SEP)) {
        if (p) counts.set(p, (counts.get(p) || 0) + 1);
      }
    }
    if (!counts.size) break;
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    if (sorted[0][0] !== leader) break;
    if (sorted[1] && sorted[1][1] === sorted[0][1]) break;
    streak++;
  }
  return streak;
}

async function cmdStats(env, ctx, tz, args = '') {
  const chatId = ctx.chatId;
  if (/^\s*all\b/i.test(args)) return statsAll(env, ctx, tz);

  const since = weekStart(Date.now(), tz);
  const s = await choreStats(env, chatId, since);
  if (!s.total && !s.expired) {
    return sendPrivate(env, ctx,
      '🏆 Fresh week, empty board — first chore takes the lead! (Resets every Monday; /stats all for history.)');
  }

  const streak = s.people.length ? await winnerStreak(env, chatId, tz, s.people[0][0]) : 0;
  const lines = [`🏆 <b>Weekly leaderboard</b> — week of ${fmtShort(since, tz).replace(/,.*$/, '')}`];
  s.people.forEach(([who, items], i) => {
    lines.push('');
    const fire = i === 0 && streak >= 1 ? ` · 🔥 ${streak + 1}-week reign` : '';
    lines.push(`${MEDALS[i] || '•'} <b>${esc(who)}</b> — ${items.length} ✅${fire}`);
    for (const h of items.slice(0, STATS_MAX_PER_PERSON)) {
      lines.push(`  ${[choreEmoji(h.text), esc(h.text)].filter(Boolean).join(" ")} — ${fmtShort(h.done_at, tz)}`);
    }
    if (items.length > STATS_MAX_PER_PERSON) lines.push(`  …and ${items.length - STATS_MAX_PER_PERSON} more`);
  });
  if (s.expired) {
    lines.push('');
    lines.push(`🪦 Expired unclaimed this week: ${s.expired}`);
  }
  lines.push('');
  lines.push('Resets Monday · /stats all for the 6-month log');
  await sendPrivateLong(env, ctx, lines.join('\n'));
}

async function statsAll(env, ctx, tz) {
  const chatId = ctx.chatId;
  const since = Date.now() - 183 * 24 * 3600000; // ~6 months
  const expired = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM firings WHERE chat_id = ? AND state = 'expired' AND scored = 1 AND fired_at > ?"
  ).bind(chatId, since).first();
  const history = await env.DB.prepare(
    `SELECT f.done_by, f.done_at, COALESCE(f.reminder_text, r.text, '?') AS text
     FROM firings f LEFT JOIN reminders r ON r.id = f.reminder_id
     WHERE f.chat_id = ? AND f.state = 'done' AND f.scored = 1 AND f.done_at > ?
     ORDER BY f.done_at DESC`
  ).bind(chatId, since).all();

  if (!history.results.length && !expired.n) {
    return sendPrivate(env, ctx, 'Nothing completed in the last 6 months yet. The cats are patient.');
  }

  // Group by person, most completions first; combined credits split.
  const byPerson = new Map();
  for (const h of history.results) {
    for (const who of String(h.done_by || '?').split(CREDIT_SEP)) {
      if (!byPerson.has(who)) byPerson.set(who, []);
      byPerson.get(who).push(h);
    }
  }
  const people = [...byPerson.entries()].sort((a, b) => b[1].length - a[1].length);

  const lines = ['📜 <b>Chore log — last 6 months</b>'];
  for (const [who, items] of people) {
    lines.push('');
    lines.push(`<b>${esc(who)}</b> — ${items.length} ✅`);
    for (const h of items.slice(0, STATS_MAX_PER_PERSON)) {
      lines.push(`  ${[choreEmoji(h.text), esc(h.text)].filter(Boolean).join(" ")} — ${fmtShort(h.done_at, tz)}`);
    }
    if (items.length > STATS_MAX_PER_PERSON) {
      lines.push(`  …and ${items.length - STATS_MAX_PER_PERSON} more`);
    }
  }
  if (expired.n) {
    lines.push('');
    lines.push(`🪦 Expired unclaimed: ${expired.n}`);
  }
  await sendPrivateLong(env, ctx, lines.join('\n'));
}

function editorText(r, tz) {
  const d = JSON.parse(r.schedule_detail);
  const nags = JSON.parse(r.nag_intervals).join('/');
  const assignee = r.assignee_name ? esc(r.assignee_name) : 'Anyone';
  const next = r.next_fire_at != null ? fmtLocal(r.next_fire_at, tz) : 'nagging now';
  return `✏️ <b>Edit #${r.display_num}: ${esc(r.text)}</b>\n` +
    `Schedule: ${esc(describeSchedule(r))}\n` +
    `Next: ${next}\n` +
    `Assigned: ${assignee}\n` +
    `Nag pace: ${nags} min\n` +
    `Rotation: ${d.rotate ? 'on' : 'off'}\n` +
    `Points: ${r.scored ? 'counts on the board' : 'no points'}${r.paused ? '\nStatus: paused' : ''}`;
}

async function editorButtons(env, r) {
  const d = JSON.parse(r.schedule_detail);
  const rows = [];
  if (r.next_fire_at != null) rows.push([
    { text: '🕐 Time', callback_data: `e:time:${r.id}` },
    { text: '🔁 Schedule', callback_data: `e:schedule:${r.id}` },
  ]);
  rows.push([
    { text: '😾 Nag pace', callback_data: `e:nag:${r.id}` },
    { text: '👤 Assignee', callback_data: `e:assign:${r.id}` },
  ]);
  rows.push([
    { text: `🔄 Rotation: ${d.rotate ? 'on' : 'off'}`, callback_data: `e:rotate:${r.id}` },
    { text: `🏆 Points: ${r.scored ? 'on' : 'off'}`, callback_data: `e:score:${r.id}` },
  ]);
  rows.push([{ text: r.paused ? '▶️ Resume' : '⏸️ Pause', callback_data: `e:pause:${r.id}` }]);
  rows.push([{ text: '✕ Close', callback_data: `e:close:${r.id}` }]);
  return { inline_keyboard: rows };
}

function editorSubmenu(kind, r, roster = []) {
  const b = (text, value) => ({ text, callback_data: `e:set${kind}:${r.id}:${value}` });
  let rows;
  if (kind === 'time') rows = [
    [b('8:00 AM', '8'), b('12:00 PM', '12')],
    [b('7:00 PM', '19'), b('9:00 PM', '21')],
  ];
  else if (kind === 'schedule') rows = [
    [b('Daily', 'daily'), b('Weekdays', 'weekdays'), b('Weekends', 'weekends')],
  ];
  else if (kind === 'nag') rows = [
    [b('Every 10m', '10'), b('15/30/60m', 'default')],
    [b('Every 30m', '30'), b('Every 60m', '60')],
  ];
  else {
    rows = [[b('Anyone', '0')]];
    roster.slice(0, 8).forEach((name, i) => rows.push([b(name, String(i + 1))]));
  }
  rows.push([{ text: '← Edit chore', callback_data: `e:menu:${r.id}` }]);
  return { inline_keyboard: rows };
}

async function editorIsDashboard(env, cb) {
  if (!cb.message.message_id) return false;
  const row = await env.DB.prepare('SELECT dashboard_msg_id FROM settings WHERE chat_id = ?')
    .bind(cb.message.chat.id).first();
  return Boolean(row && row.dashboard_msg_id === cb.message.message_id);
}

async function refreshEditor(env, cb, r, tz, buttons = null) {
  const markup = buttons || await editorButtons(env, r);
  if (await editorIsDashboard(env, cb)) {
    const html = await choreListHtml(env, r.chat_id, tz);
    return editMessage(env, r.chat_id, cb.message.message_id, html, markup);
  }
  return editMessage(env, r.chat_id, cb.message.message_id, editorText(r, tz), markup);
}

async function applyEditorChoice(env, r, kind, value, tz) {
  if (kind === 'time') {
    const detail = { ...JSON.parse(r.schedule_detail), h: +value, mi: 0 };
    const next = r.schedule_kind === 'once'
      ? nextOccurrence('daily', { h: +value, mi: 0 }, Date.now(), tz)
      : nextOccurrence(r.schedule_kind, detail, Date.now(), tz);
    await env.DB.prepare('UPDATE reminders SET schedule_detail = ?, next_fire_at = ? WHERE id = ?')
      .bind(JSON.stringify(detail), next, r.id).run();
  } else if (kind === 'schedule') {
    const old = JSON.parse(r.schedule_detail);
    const base = { h: old.h ?? 9, mi: old.mi ?? 0, ...(old.rotate ? { rotate: true } : {}) };
    const schedule = value === 'daily'
      ? { kind: 'daily', detail: base }
      : { kind: 'weekly', detail: { ...base, days: value === 'weekdays' ? [1, 2, 3, 4, 5] : [0, 6] } };
    const next = nextOccurrence(schedule.kind, schedule.detail, Date.now(), tz);
    await env.DB.prepare(
      'UPDATE reminders SET schedule_kind = ?, schedule_detail = ?, next_fire_at = ? WHERE id = ?'
    ).bind(schedule.kind, JSON.stringify(schedule.detail), next, r.id).run();
  } else if (kind === 'nag') {
    const intervals = value === 'default' ? DEFAULT_NAGS : [+value];
    await env.DB.prepare('UPDATE reminders SET nag_intervals = ? WHERE id = ?')
      .bind(JSON.stringify(intervals), r.id).run();
  } else if (kind === 'assign') {
    const roster = [...await householdRoster(env, r.chat_id)].sort((a, b) => a.localeCompare(b));
    const name = value === '0' ? null : roster[+value - 1];
    if (value !== '0' && !name) return false;
    await env.DB.prepare('UPDATE reminders SET assignee_name = ?, assignee_user_id = NULL WHERE id = ?')
      .bind(name, r.id).run();
  }
  return true;
}

// Every management button carries the chore's own identity — name plus when —
// because the pinned board's text never changes while you navigate. Internal
// numbers stay out of labels; the name is the handle everywhere else too.
function buttonText(r, tz = 'Asia/Singapore') {
  const when = r.paused ? 'paused'
    : r.next_fire_at ? fmtWhen(r.next_fire_at, tz)
    : 'nagging now';
  return clip(`${[choreEmoji(r.text), r.text].filter(Boolean).join(' ')} · ${when}`);
}

function clip(text, max = 42) {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
}

async function dashboardCallbackAllowed(env, cb) {
  const row = await env.DB.prepare('SELECT dashboard_msg_id FROM settings WHERE chat_id = ?')
    .bind(cb.message.chat.id).first();
  return row && row.dashboard_msg_id === cb.message.message_id;
}

async function chorePickerMarkup(env, chatId, tz) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM reminders WHERE chat_id = ? ORDER BY display_num'
  ).bind(chatId).all();
  const rows = results.slice(0, 20).map((r) => [
    { text: `✏️ ${buttonText(r, tz)}`, callback_data: `m:item:${r.id}` },
  ]);
  if (results.length > 20) rows.push([{ text: '…use /list for the rest', callback_data: 'm:close' }]);
  rows.push([{ text: '← Done', callback_data: 'm:close' }]);
  return { inline_keyboard: rows };
}

async function choreActionsMarkup(env, r, tz) {
  const firing = await env.DB.prepare(
    "SELECT id FROM firings WHERE reminder_id = ? AND state = 'nagging' ORDER BY id DESC LIMIT 1"
  ).bind(r.id).first();
  // First row names what you are acting on, so the board's unchanged text is
  // never the only thing telling you where you are. Tapping it is a no-op.
  const rows = [[{ text: buttonText(r, tz), callback_data: `m:item:${r.id}` }]];
  if (firing) rows.push([
    { text: '✅ Done', callback_data: `m:done:${r.id}` },
    { text: '🤝 Together', callback_data: `m:doneall:${r.id}` },
  ]);
  rows.push([{ text: '✏️ Edit details', callback_data: `m:edit:${r.id}` }]);
  rows.push([{ text: r.paused ? '▶️ Resume' : '⏸️ Pause', callback_data: `m:${r.paused ? 'resume' : 'pause'}:${r.id}` }]);
  if (r.schedule_kind !== 'once' && r.next_fire_at != null) {
    rows.push([{ text: '⏭️ Skip next', callback_data: `m:skip:${r.id}` }]);
  }
  rows.push([{ text: '🗑️ Delete…', callback_data: `m:delete:${r.id}` }]);
  rows.push([
    { text: '← Back to chores', callback_data: 'm:list' },
    { text: '✕ Close', callback_data: 'm:close' },
  ]);
  return { inline_keyboard: rows };
}

// Manage runs inside the pinned dashboard itself: swap its buttons, leave its
// text alone. Deliberately a shared surface — anyone in the household can pick
// up where another left off, and there is nothing private on it.
function renderManager(env, cb, markup) {
  return editReplyMarkup(env, cb.message.chat.id, cb.message.message_id, markup);
}

async function handleCallback(env, cb) {
  // The tap authorizes a private reply for the next 15 seconds even if the bot
  // has no other recent contact with this member.
  const ctx = replyCtx(env, cb.message && cb.message.chat.id, cb.from && cb.from.id, {
    callbackQueryId: cb.id,
  });
  const ref = callbackRef(cb);
  const editNav = (cb.data || '').match(/^e:(menu|time|schedule|nag|assign|rotate|score|pause|close):(\d+)$/);
  const editSet = (cb.data || '').match(/^e:set(time|schedule|nag|assign):(\d+):([a-z0-9]+)$/);
  if ((editNav || editSet) && cb.message) {
    const reminderId = +(editNav ? editNav[2] : editSet[2]);
    let r = await env.DB.prepare('SELECT * FROM reminders WHERE id = ? AND chat_id = ?')
      .bind(reminderId, cb.message.chat.id).first();
    if (!r) return answerCallback(env, cb.id, 'That chore is already gone.');
    const tz = await getTz(env, r.chat_id);

    if (editNav) {
      const action = editNav[1];
      if (action === 'close') {
        if (ref && ref.ephemeral) await deleteEphemeral(env, ctx, ref.id);
        else if (await editorIsDashboard(env, cb)) await updateDashboard(env, r.chat_id);
        else await deleteMessage(env, r.chat_id, cb.message.message_id);
        return answerCallback(env, cb.id, 'Closed');
      }
      if (action === 'menu') {
        await refreshEditor(env, cb, r, tz);
        return answerCallback(env, cb.id, '');
      }
      if (['time', 'schedule', 'nag', 'assign'].includes(action)) {
        const roster = action === 'assign'
          ? [...await householdRoster(env, r.chat_id)].sort((a, b) => a.localeCompare(b)) : [];
        await refreshEditor(env, cb, r, tz, editorSubmenu(action, r, roster));
        return answerCallback(env, cb.id, '');
      }
      if (action === 'rotate') {
        const detail = JSON.parse(r.schedule_detail);
        if (detail.rotate) delete detail.rotate;
        else detail.rotate = true;
        await env.DB.prepare('UPDATE reminders SET schedule_detail = ? WHERE id = ?')
          .bind(JSON.stringify(detail), r.id).run();
      } else if (action === 'score') {
        await env.DB.prepare('UPDATE reminders SET scored = ? WHERE id = ?')
          .bind(r.scored ? 0 : 1, r.id).run();
      } else if (action === 'pause') {
        await setReminderPaused(env, r, !r.paused, tz, senderName(cb.from));
      }
    } else {
      const ok = await applyEditorChoice(env, r, editSet[1], editSet[3], tz);
      if (!ok) return answerCallback(env, cb.id, 'That household member is no longer available.');
    }

    r = await env.DB.prepare('SELECT * FROM reminders WHERE id = ?').bind(r.id).first();
    if (!r) return answerCallback(env, cb.id, 'That chore is already gone.');
    await updateDashboard(env, r.chat_id);
    await refreshEditor(env, cb, r, tz);
    return answerCallback(env, cb.id, 'Updated ✓');
  }

  const help = (cb.data || '').match(/^h:(home|schedule|more|stickers)$/);
  if (help && cb.message) {
    await editRef(env, ctx, cb.message.chat.id, ref,
      helpText(help[1]), await helpMarkup(env, cb.message.chat.id, help[1]));
    return answerCallback(env, cb.id, '');
  }

  const manage = (cb.data || '').match(/^m:(list|close)$/);
  const manageItem = (cb.data || '').match(/^m:(item|edit|pause|resume|skip|done|doneall|delete|confirm):(\d+)$/);
  if ((manage || manageItem) && cb.message) {
    if (!await dashboardCallbackAllowed(env, cb)) {
      return answerCallback(env, cb.id, 'That dashboard is no longer active.');
    }
    if (manage) {
      if (manage[1] === 'close') {
        await editReplyMarkup(env, cb.message.chat.id, cb.message.message_id, dashboardButtons());
      } else {
        const listTz = await getTz(env, cb.message.chat.id);
        await renderManager(env, cb, await chorePickerMarkup(env, cb.message.chat.id, listTz));
      }
      return answerCallback(env, cb.id, '');
    }

    const action = manageItem[1];
    const r = await env.DB.prepare('SELECT * FROM reminders WHERE id = ? AND chat_id = ?')
      .bind(+manageItem[2], cb.message.chat.id).first();
    if (!r) {
      await updateDashboard(env, cb.message.chat.id);
      return answerCallback(env, cb.id, 'That chore is already gone.');
    }
    const tz = await getTz(env, r.chat_id);
    if (action === 'item') {
      await renderManager(env, cb, await choreActionsMarkup(env, r, tz));
      return answerCallback(env, cb.id, buttonText(r, tz));
    }
    if (action === 'edit') {
      await renderManager(env, cb, await editorButtons(env, r));
      return answerCallback(env, cb.id, `Editing ${r.text}`);
    }
    if (action === 'delete') {
      // The confirm button says exactly what it will delete — the board's text
      // is unchanged and cannot be relied on to say which chore this is.
      await renderManager(env, cb, { inline_keyboard: [
        [{ text: clip(`🗑 Delete · ${r.text}`), callback_data: `m:confirm:${r.id}` }],
        [{ text: '← Back to chores', callback_data: `m:item:${r.id}` }],
      ] });
      return answerCallback(env, cb.id, 'This removes the chore for everyone.');
    }
    if (action === 'confirm') {
      await deleteReminder(env, r);
      return answerCallback(env, cb.id, 'Deleted — Undo is available below.');
    }

    if (action === 'pause' || action === 'resume') {
      await setReminderPaused(env, r, action === 'pause', tz, senderName(cb.from));
      return answerCallback(env, cb.id, action === 'pause' ? 'Paused ⏸️' : 'Resumed ▶️');
    }
    if (action === 'skip') {
      if (r.schedule_kind === 'once' || !r.next_fire_at) {
        return answerCallback(env, cb.id, 'One-off chores cannot be skipped.');
      }
      const next = nextOccurrence(r.schedule_kind, JSON.parse(r.schedule_detail), r.next_fire_at, tz);
      await env.DB.prepare('UPDATE reminders SET next_fire_at = ? WHERE id = ?').bind(next, r.id).run();
      await updateDashboard(env, r.chat_id);
      return answerCallback(env, cb.id, `Next: ${fmtLocal(next, tz)}`);
    }
    if (action === 'done' || action === 'doneall') {
      const firing = await env.DB.prepare(
        "SELECT * FROM firings WHERE reminder_id = ? AND state = 'nagging' ORDER BY id DESC LIMIT 1"
      ).bind(r.id).first();
      if (!firing) return answerCallback(env, cb.id, 'This chore is not nagging now.');
      let credit = senderName(cb.from);
      if (action === 'doneall') credit = creditTogether(credit, [...await householdRoster(env, r.chat_id)]);
      const won = await completeFiring(env, firing, r, credit, tz);
      return answerCallback(env, cb.id, won ? 'Purrs 😻' : 'Already handled 👍');
    }
  }

  const wiz = (cb.data || '').match(/^w:(\d+):([a-z]+\d*)$/);
  if (wiz && cb.message) {
    const draft = await env.DB.prepare('SELECT * FROM drafts WHERE id = ? AND chat_id = ?')
      .bind(+wiz[1], cb.message.chat.id).first();
    if (!draft) return answerCallback(env, cb.id, 'That one expired — send /remind again.');
    const tz = await getTz(env, draft.chat_id);
    if (wiz[2] === 'cancel') {
      const claim = await env.DB.prepare('DELETE FROM drafts WHERE id = ? AND chat_id = ?')
        .bind(draft.id, draft.chat_id).run();
      if (!claim.meta.changes) return answerCallback(env, cb.id, 'Already closed.');
      const promptRef = draftRef(draft, 'prompt');
      if (promptRef) await deleteRef(env, ctx, draft.chat_id, promptRef);
      await editRef(env, ctx, draft.chat_id, ref,
        `✕ Cancelled <s>${esc(draft.text)}</s>`, emptyKeyboard());
      return answerCallback(env, cb.id, 'Cancelled');
    }
    if (wiz[2] === 'custom') {
      // selective force_reply only auto-opens the reply box for a mentioned
      // user in groups — so mention whoever tapped the button.
      const mention = cb.from.username
        ? `@${cb.from.username}`
        : mentionHtml(cb.from.first_name || 'you', cb.from.id);
      const prompt = await sendPrivate(env, ctx,
        `⏰ ${mention} — reply with a time for <b>${esc(draft.text)}</b> — e.g. <code>10am</code>, ` +
        '<code>tomorrow 9:30am</code>, <code>in 30m</code>, or <code>now</code>.',
        { force_reply: true, selective: true });
      const pRef = msgRef(prompt);
      if (pRef) {
        await env.DB.prepare('UPDATE drafts SET prompt_msg_id = ?, prompt_msg_ephemeral = ? WHERE id = ?')
          .bind(pRef.id, pRef.ephemeral ? 1 : 0, draft.id).run();
        await editRef(env, ctx, draft.chat_id, ref,
          `🐾 Waiting for a time for <b>${esc(draft.text)}</b>…`,
          { inline_keyboard: [[{ text: '✕ Cancel', callback_data: `w:${draft.id}:cancel` }]] });
      }
      return answerCallback(env, cb.id, 'Type the time as a reply ⏰');
    }
    let sched;
    if (wiz[2] === 'ai') {
      // Apply the confirmed AI suggestion; recompute recurring first-fires so
      // a late tap doesn't schedule into the past.
      let ai = null;
      try { ai = draft.ai_json && JSON.parse(draft.ai_json); } catch { /* fall through */ }
      if (!ai) return answerCallback(env, cb.id, 'That suggestion expired — pick a time below.');
      if (ai.kind === 'once' && ai.firstFireAt <= Date.now()) {
        return answerCallback(env, cb.id, 'That suggested time has passed — choose another.');
      }
      const firstFireAt = ai.kind === 'once'
        ? ai.firstFireAt
        : nextOccurrence(ai.kind, ai.detail, Date.now(), tz);
      sched = { kind: ai.kind, detail: ai.detail, firstFireAt };
    } else {
      sched = scheduleFromCode(wiz[2], draft, Date.now(), tz);
    }
    if (!sched) return answerCallback(env, cb.id, 'That time has passed — choose another.');
    // Claim the draft before creating anything. Telegram can deliver multiple
    // taps close together; only the first conditional delete may proceed.
    const claim = await env.DB.prepare('DELETE FROM drafts WHERE id = ? AND chat_id = ?')
      .bind(draft.id, draft.chat_id).run();
    if (!claim.meta.changes) return answerCallback(env, cb.id, 'Already scheduled.');
    const wizBy = senderName(cb.from);
    const wizP = {
      text: draft.text, assigneeName: draft.assignee_name, assigneeUserId: draft.assignee_user_id,
      nagIntervals: JSON.parse(draft.nag_intervals), scored: draft.scored, ...sched,
    };
    const { id: newId, html } = await createReminder(env, draft.chat_id, wizP, wizBy, tz);
    await editRef(env, ctx, draft.chat_id, ref, html, undoButtons(newId));
    await announceNewChore(env, draft.chat_id, wizBy, wizP, tz);
    return answerCallback(env, cb.id, 'Scheduled 📝');
  }

  // Undo a just-created reminder: remove it and any live nag it produced.
  const um = (cb.data || '').match(/^u:(\d+)$/);
  if (um && cb.message) {
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
  const tr = (cb.data || '').match(/^t:(\d+)$/);
  if (tr && cb.message) {
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

  // Dismiss a log line. Works on either kind of message, since deleteRef picks
  // the method from the ref rather than assuming a public message id.
  if (cb.data === 'ok' && cb.message) {
    await deleteRef(env, ctx, cb.message.chat.id, ref);
    return answerCallback(env, cb.id, '');
  }

  // 🗑 on a nag removes the chore outright. One tap, because the log line it
  // leaves carries Undo — a mis-tap is recoverable for a day.
  const xm = (cb.data || '').match(/^x:(\d+)$/);
  if (xm && cb.message) {
    const firing = await env.DB.prepare('SELECT * FROM firings WHERE id = ?').bind(+xm[1]).first();
    if (!firing) return answerCallback(env, cb.id, 'Already gone.');
    const r = await env.DB.prepare('SELECT * FROM reminders WHERE id = ? AND chat_id = ?')
      .bind(firing.reminder_id, firing.chat_id).first();
    if (!r) return answerCallback(env, cb.id, 'That chore is already gone.');
    // No ctx: the log is public on purpose, whoever the nag belonged to.
    await deleteReminder(env, r, null, senderName(cb.from));
    return answerCallback(env, cb.id, 'Deleted — Undo is in the group.');
  }

  // Snooze preset picked (or Back to the main buttons).
  const zm = (cb.data || '').match(/^z:(\d+):(\w+)$/);
  if (zm && cb.message) {
    const firing = await env.DB.prepare('SELECT * FROM firings WHERE id = ?').bind(+zm[1]).first();
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

  const m = (cb.data || '').match(/^([dsb]):(\d+)$/);
  if (!m || !cb.message) return answerCallback(env, cb.id, '');
  const firing = await env.DB.prepare('SELECT * FROM firings WHERE id = ?').bind(+m[2]).first();
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
