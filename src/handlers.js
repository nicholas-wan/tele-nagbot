// Webhook update handling: commands and inline-button callbacks.

import { sendMessage, editMessage, deleteMessage, answerCallback, esc, mentionHtml, pinMessage, unpinMessage } from './tg.js';
import { parseRemind, ParseError, NoTimeError, DEFAULT_NAGS } from './parse.js';
import { nextOccurrence, fmtLocal, fmtShort, fmtTime, fmtClock, localParts, zonedEpoch, weekStart } from './time.js';
import { createStickerSet, deleteSticker, lookupPack, tagSticker, autoTagPack, listTags, sendCelebrationSticker } from './stickers.js';
import { tg } from './tg.js';
import { fireReminder } from './firing.js';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MAX_SNOOZES = 3;
export const EXPIRE_AFTER_MS = 24 * 3600000;

export async function getTz(env, chatId) {
  const row = await env.DB.prepare('SELECT tz FROM settings WHERE chat_id = ?').bind(chatId).first();
  return row ? row.tz : 'Asia/Singapore';
}

function senderName(from) {
  return from.username ? `@${from.username}` : from.first_name || 'someone';
}

export function nagButtons(firingId) {
  return {
    inline_keyboard: [[
      { text: '✅ Done', callback_data: `d:${firingId}` },
      { text: '😴 Snooze 1h', callback_data: `s:${firingId}` },
    ]],
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
  const head = `🐱 <b>${esc(reminder.text)}</b>${nagCount > 0 ? ` — nag #${nagCount + 1}` : ''}`;
  const lines = NAG_LINES[cat] || NAG_LINES.both;
  const line = lines[Math.min(nagCount, lines.length - 1)];
  const who = reminder.assignee_name
    ? `${mentionHtml(reminder.assignee_name, reminder.assignee_user_id)} — `
    : '';
  return `${head}\n${who}${line}`;
}

async function silenceOldNag(env, firing, text, note) {
  if (!firing.last_message_id) return;
  await editMessage(env, firing.chat_id, firing.last_message_id, `${note} <s>${esc(text)}</s>`);
}

export async function completeFiring(env, firing, reminder, byName, tz) {
  const now = Date.now();
  await env.DB.prepare(
    "UPDATE firings SET state = 'done', done_by = ?, done_at = ?, next_nag_at = NULL WHERE id = ?"
  ).bind(byName, now, firing.id).run();
  if (firing.last_sticker_id) await deleteMessage(env, firing.chat_id, firing.last_sticker_id);
  const celebration = await sendCelebrationSticker(env, firing.chat_id, firing.id);
  const purr = celebration.cat === 'latte' ? 'Latte purrs approvingly.'
    : celebration.cat === 'mocha' ? 'Mocha purrs approvingly.'
    : 'The cats purr approvingly.';
  if (firing.last_message_id) {
    await editMessage(
      env, firing.chat_id, firing.last_message_id,
      `😻 <s>${esc(reminder.text)}</s>\nDone by ${esc(byName)} at ${fmtLocal(now, tz)}. ${purr}`
    );
  }
  if (reminder.schedule_kind === 'once') {
    await env.DB.prepare('DELETE FROM reminders WHERE id = ?').bind(reminder.id).run();
  }
  await updateDashboard(env, firing.chat_id);
}

export async function expireFiring(env, firing, reminder, { silent } = {}) {
  await env.DB.prepare(
    "UPDATE firings SET state = 'expired', next_nag_at = NULL WHERE id = ?"
  ).bind(firing.id).run();
  await silenceOldNag(env, firing, reminder.text, '🙀');
  if (firing.last_sticker_id) await deleteMessage(env, firing.chat_id, firing.last_sticker_id);
  if (!silent) {
    await sendMessage(env, firing.chat_id,
      `🙀 <s>${esc(reminder.text)}</s> — 24 hours and nobody did it. Latte &amp; Mocha are deeply disappointed.`);
  }
  if (reminder.schedule_kind === 'once') {
    await env.DB.prepare('DELETE FROM reminders WHERE id = ?').bind(reminder.id).run();
  }
  await updateDashboard(env, firing.chat_id);
}

// One pinned message per chat, silently edited in place, listing everything
// currently nagging. Created on first need, unpinned and removed when clear.
export async function updateDashboard(env, chatId) {
  try {
    const { results } = await env.DB.prepare(
      `SELECT r.text, r.assignee_name, r.assignee_user_id, f.fired_at
       FROM firings f JOIN reminders r ON r.id = f.reminder_id
       WHERE f.chat_id = ? AND f.state = 'nagging' ORDER BY f.fired_at`
    ).bind(chatId).all();
    const row = await env.DB.prepare(
      'SELECT dashboard_msg_id, tz FROM settings WHERE chat_id = ?'
    ).bind(chatId).first();
    const msgId = row && row.dashboard_msg_id;

    if (!results.length) {
      if (msgId) {
        await unpinMessage(env, chatId, msgId);
        await deleteMessage(env, chatId, msgId);
        await env.DB.prepare('UPDATE settings SET dashboard_msg_id = NULL WHERE chat_id = ?').bind(chatId).run();
      }
      return;
    }

    const tz = (row && row.tz) || 'Asia/Singapore';
    const lines = ['📋 <b>Outstanding chores</b>'];
    for (const r of results) {
      const who = r.assignee_name ? ` (${mentionHtml(r.assignee_name, r.assignee_user_id)})` : '';
      lines.push(`• <b>${esc(r.text)}</b>${who} — since ${fmtClock(r.fired_at, tz)}`);
    }
    const html = lines.join('\n');

    if (msgId) {
      const res = await editMessage(env, chatId, msgId, html);
      if (res.ok || String(res.description || '').includes('not modified')) return;
      // Message was deleted by hand — fall through and recreate it.
    }
    const sent = await sendMessage(env, chatId, html, null, { silent: true });
    if (sent.ok) {
      await pinMessage(env, chatId, sent.result.message_id);
      await env.DB.prepare(
        'INSERT INTO settings (chat_id, dashboard_msg_id) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET dashboard_msg_id = excluded.dashboard_msg_id'
      ).bind(chatId, sent.result.message_id).run();
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
  if (r.schedule_kind === 'interval') return `every ${d.days} days at ${fmtTime(d.h, d.mi)}`;
  return 'once';
}

export async function handleUpdate(env, update) {
  if (update.callback_query) return handleCallback(env, update.callback_query);

  const msg = update.message;
  if (!msg || !msg.text) return;
  if (!msg.text.startsWith('/')) return handlePlainText(env, msg);
  const m = msg.text.match(/^\/(\w+)(?:@\w+)?\s*([\s\S]*)$/);
  if (!m) return;
  const [, cmdRaw, args] = m;
  const cmd = cmdRaw.toLowerCase();
  const chatId = msg.chat.id;
  const tz = await getTz(env, chatId);
  const by = senderName(msg.from);

  try {
    if (cmd === 'start' || cmd === 'help') return await cmdHelp(env, chatId, tz);
    if (cmd === 'remind') return await cmdRemind(env, chatId, args, msg, tz, by);
    if (cmd === 'list') return await cmdList(env, chatId, tz);
    if (cmd === 'delete') return await cmdDelete(env, chatId, args);
    if (cmd === 'pause') return await cmdPauseResume(env, chatId, args, tz, true);
    if (cmd === 'resume') return await cmdPauseResume(env, chatId, args, tz, false);
    if (cmd === 'skip') return await cmdSkip(env, chatId, args, tz);
    if (cmd === 'done') return await cmdDone(env, chatId, args, by, tz);
    if (cmd === 'tz') return await cmdTz(env, chatId, args);
    if (cmd === 'stats') return await cmdStats(env, chatId, tz, args);
    if (cmd === 'makestickers') return await cmdMakeStickers(env, chatId, msg);
    if (cmd === 'delsticker') return await cmdDelSticker(env, chatId, args);
    if (cmd === 'usepack') return await cmdUsePack(env, chatId, args);
    if (cmd === 'tagsticker') return await cmdTagSticker(env, chatId, args);
    if (cmd === 'autotag') return await cmdAutoTag(env, chatId, args);
    if (cmd === 'tags') return await cmdTags(env, chatId, args);
  } catch (err) {
    if (err instanceof ParseError) return sendMessage(env, chatId, esc(err.message));
    console.log(`command /${cmd} failed: ${err.stack || err}`);
    return sendMessage(env, chatId, 'Something went wrong handling that. 🐛');
  }
}

async function cmdHelp(env, chatId, tz) {
  await sendMessage(env, chatId,
    '🐱 <b>Latte &amp; Mocha</b> nag until someone taps ✅ Done.\n\n' +
    '/remind trash 7pm daily · @jane dishes now · plumber in 20m\n' +
    '(also: <code>every mon,thu 8am</code>, <code>on the 1st</code>, <code>tomorrow 9am</code>, <code>nag:10m</code>)\n' +
    '/list · /delete N · /pause N · /done N · /stats\n' +
    `/usepack &lt;link&gt; — nag stickers · /tz — timezone (<code>${esc(tz)}</code>)`
  );
}

async function cmdRemind(env, chatId, args, msg, tz, by) {
  const now = Date.now();
  let p;
  try {
    p = parseRemind(args, msg.text, msg.entities, now, tz);
  } catch (err) {
    if (err instanceof NoTimeError) return startWizard(env, chatId, err.partial);
    throw err;
  }
  const { id, html } = await createReminder(env, chatId, p, by, tz);
  await sendMessage(env, chatId, html);
  // "now" reminders fire on the spot instead of waiting for the next cron tick.
  if (p.firstFireAt <= Date.now() + 500) {
    const row = await env.DB.prepare('SELECT * FROM reminders WHERE id = ?').bind(id).first();
    if (row) await fireReminder(env, row, Date.now(), tz);
  }
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
       schedule_detail, next_fire_at, nag_intervals, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    chatId, num, p.text, p.assigneeName, p.assigneeUserId, p.kind,
    JSON.stringify(p.detail), p.firstFireAt, JSON.stringify(p.nagIntervals), by, Date.now()
  ).run();
  const id = res.meta.last_row_id;
  const forWho = p.assigneeName ? ` for ${mentionHtml(p.assigneeName, p.assigneeUserId)}` : '';
  const html = `📝 #${num} <b>${esc(p.text)}</b>${forWho}\nFirst reminder: ${fmtLocal(p.firstFireAt, tz)}` +
    (p.kind !== 'once' ? ` (${describeSchedule({ schedule_kind: p.kind, schedule_detail: JSON.stringify(p.detail) })})` : '');
  return { id, html };
}

// No time given: park the parsed pieces as a draft and offer tap-to-choose
// times instead of an error.
async function startWizard(env, chatId, partial) {
  const res = await env.DB.prepare(
    `INSERT INTO drafts (chat_id, text, assignee_name, assignee_user_id, schedule_kind,
       schedule_detail, nag_intervals, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    chatId, partial.text, partial.assigneeName, partial.assigneeUserId, partial.kind,
    JSON.stringify(partial.detail), JSON.stringify(partial.nagIntervals), Date.now()
  ).run();
  const id = res.meta.last_row_id;

  const btn = (label, code) => ({ text: label, callback_data: `w:${id}:${code}` });
  const keyboard = partial.kind === 'once'
    ? [
        [btn('In 15 min', 'r15'), btn('In 1 hour', 'r60')],
        [btn('Tonight 7pm', 't19'), btn('Tomorrow 9am', 'm9')],
        [btn('Every day 7pm', 'd19'), btn('✏️ Type a time', 'custom')],
      ]
    : [
        [btn('8am', 'h8'), btn('12pm', 'h12'), btn('7pm', 'h19'), btn('9pm', 'h21')],
        [btn('✏️ Type a time', 'custom')],
      ];

  const kindNote = partial.kind === 'once' ? '' :
    ` (${partial.kind === 'weekly' ? 'every ' + partial.detail.days.map((i) => DAY_NAMES[i]).join(',') :
        partial.kind === 'monthly' ? 'on the ' + partial.detail.dom :
        partial.kind === 'interval' ? `every ${partial.detail.days} days` : 'daily'})`;
  const sent = await sendMessage(env, chatId,
    `🐾 When should Latte &amp; Mocha pester you about <b>${esc(partial.text)}</b>${kindNote}?\n` +
    'Tap an option, or ✏️ to type your own time.',
    { inline_keyboard: keyboard }
  );
  if (sent.ok) {
    await env.DB.prepare('UPDATE drafts SET wizard_msg_id = ? WHERE id = ?')
      .bind(sent.result.message_id, id).run();
  }
}

// Plain (non-command) text: only meaningful as a custom time for a pending
// draft — either a reply to the wizard/prompt message, or freshly typed
// after a recent popup. Anything else is ignored (normal chat).
async function handlePlainText(env, msg) {
  const chatId = msg.chat.id;
  const now = Date.now();
  const replyId = msg.reply_to_message && msg.reply_to_message.message_id;
  let draft = null;
  if (replyId) {
    draft = await env.DB.prepare(
      'SELECT * FROM drafts WHERE chat_id = ? AND (prompt_msg_id = ? OR wizard_msg_id = ?)'
    ).bind(chatId, replyId, replyId).first();
  }
  const explicit = !!draft;
  if (!draft) {
    draft = await env.DB.prepare(
      'SELECT * FROM drafts WHERE chat_id = ? AND created_at > ? ORDER BY id DESC LIMIT 1'
    ).bind(chatId, now - 15 * 60000).first();
  }
  if (!draft) return;

  const tz = await getTz(env, chatId);
  let parsed;
  try {
    // Dummy task word satisfies the parser; we only want the schedule.
    parsed = parseRemind(`x ${msg.text}`, `x ${msg.text}`, [], now, tz);
  } catch (err) {
    if (explicit && err instanceof ParseError) {
      await sendMessage(env, chatId,
        'I couldn\'t read that as a time — try <code>10am</code>, <code>tomorrow 9:30am</code>, or <code>in 30m</code>.');
    }
    return; // non-time chatter near a popup is ignored silently
  }

  // The typed reply carries the time; the draft carries everything else.
  let { kind, detail, firstFireAt } = parsed;
  if (kind === 'once' && draft.schedule_kind !== 'once' && parsed.detail.h != null) {
    kind = draft.schedule_kind;
    detail = { ...JSON.parse(draft.schedule_detail), h: parsed.detail.h, mi: parsed.detail.mi };
    firstFireAt = nextOccurrence(kind, detail, now, tz);
  }
  const p = {
    text: draft.text, assigneeName: draft.assignee_name, assigneeUserId: draft.assignee_user_id,
    nagIntervals: JSON.parse(draft.nag_intervals), kind, detail, firstFireAt,
  };
  const { id, html } = await createReminder(env, chatId, p, senderName(msg.from), tz);
  await env.DB.prepare('DELETE FROM drafts WHERE id = ?').bind(draft.id).run();
  if (draft.wizard_msg_id) await editMessage(env, chatId, draft.wizard_msg_id, html);
  else await sendMessage(env, chatId, html);
  if (draft.prompt_msg_id) await deleteMessage(env, chatId, draft.prompt_msg_id);
  if (p.firstFireAt <= Date.now() + 500) {
    const row = await env.DB.prepare('SELECT * FROM reminders WHERE id = ?').bind(id).first();
    if (row) await fireReminder(env, row, Date.now(), tz);
  }
}

function scheduleFromCode(code, draft, now, tz) {
  const kind = draft.schedule_kind;
  const detail = JSON.parse(draft.schedule_detail);
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

async function cmdList(env, chatId, tz) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM reminders WHERE chat_id = ? ORDER BY id'
  ).bind(chatId).all();
  if (!results.length) return sendMessage(env, chatId, 'No reminders. Add one with /remind.');
  const lines = results.map((r) => {
    const who = r.assignee_name ? ` · ${esc(r.assignee_name)}` : '';
    const next = r.paused ? '⏸️ paused'
      : r.next_fire_at ? `next ${fmtLocal(r.next_fire_at, tz)}`
      : 'nagging now';
    return `#${r.display_num} <b>${esc(r.text)}</b> — ${describeSchedule(r)}${who} · ${next}`;
  });
  await sendMessage(env, chatId, lines.join('\n'));
}

async function findReminder(env, chatId, args) {
  const num = parseInt(String(args).replace('#', '').trim(), 10);
  if (!num) throw new ParseError('Give me a reminder number, e.g. /delete 3 (see /list).');
  const r = await env.DB.prepare(
    'SELECT * FROM reminders WHERE display_num = ? AND chat_id = ?'
  ).bind(num, chatId).first();
  if (!r) throw new ParseError(`No reminder #${num} here. See /list.`);
  return r;
}

async function cmdDelete(env, chatId, args) {
  const r = await findReminder(env, chatId, args);
  await env.DB.prepare("UPDATE firings SET state = 'expired', next_nag_at = NULL WHERE reminder_id = ? AND state = 'nagging'").bind(r.id).run();
  await env.DB.prepare('DELETE FROM reminders WHERE id = ?').bind(r.id).run();
  await sendMessage(env, chatId, `🗑️ Deleted #${r.display_num} <s>${esc(r.text)}</s>`);
  await updateDashboard(env, chatId);
}

async function cmdPauseResume(env, chatId, args, tz, pause) {
  const r = await findReminder(env, chatId, args);
  if (pause) {
    await env.DB.prepare('UPDATE reminders SET paused = 1 WHERE id = ?').bind(r.id).run();
    await sendMessage(env, chatId, `⏸️ Paused #${r.display_num} <b>${esc(r.text)}</b>. /resume ${r.display_num} to re-enable.`);
  } else {
    const next = nextOccurrence(r.schedule_kind, JSON.parse(r.schedule_detail), Date.now(), tz) || r.next_fire_at;
    await env.DB.prepare('UPDATE reminders SET paused = 0, next_fire_at = ? WHERE id = ?').bind(next, r.id).run();
    await sendMessage(env, chatId, `▶️ Resumed #${r.display_num} <b>${esc(r.text)}</b> — next ${fmtLocal(next, tz)}`);
  }
}

async function cmdSkip(env, chatId, args, tz) {
  const r = await findReminder(env, chatId, args);
  if (r.schedule_kind === 'once' || !r.next_fire_at) {
    throw new ParseError(`#${r.display_num} is a one-off — use /delete ${r.display_num} instead.`);
  }
  const next = nextOccurrence(r.schedule_kind, JSON.parse(r.schedule_detail), r.next_fire_at, tz);
  await env.DB.prepare('UPDATE reminders SET next_fire_at = ? WHERE id = ?').bind(next, r.id).run();
  await sendMessage(env, chatId, `⏭️ Skipping next <b>${esc(r.text)}</b> — next ${fmtLocal(next, tz)}`);
}

async function cmdDone(env, chatId, args, by, tz) {
  const r = await findReminder(env, chatId, args);
  const firing = await env.DB.prepare(
    "SELECT * FROM firings WHERE reminder_id = ? AND state = 'nagging' ORDER BY id DESC LIMIT 1"
  ).bind(r.id).first();
  if (!firing) throw new ParseError(`#${r.display_num} is not currently nagging.`);
  await completeFiring(env, firing, r, by, tz);
  await sendMessage(env, chatId, `😻 <b>${esc(r.text)}</b> — done by ${esc(by)}. Purrs all around.`);
}

async function cmdMakeStickers(env, chatId, msg) {
  const res = await createStickerSet(env, msg.from.id);
  if (res.ok) {
    const link = `https://t.me/addstickers/${res.name}`;
    await sendMessage(env, chatId, res.already
      ? (res.added
          ? `🐾 Added ${res.added} new sticker${res.added > 1 ? 's' : ''} to <a href="${link}">Latte &amp; Mocha</a>.`
          : `🐾 The pack already exists and is up to date: <a href="${link}">Latte &amp; Mocha</a>`)
      : `🎉 Sticker pack created: <a href="${link}">Latte &amp; Mocha</a>\n` +
        'Random cat stickers now accompany every nag. Tap the link to add them to your own sticker keyboard too!');
  } else {
    await sendMessage(env, chatId, `😿 Telegram refused: ${esc(res.description || 'unknown error')}`);
  }
}

async function cmdDelSticker(env, chatId, args) {
  const index = parseInt(args, 10);
  if (!index) throw new ParseError('Which one? e.g. /delsticker 3 (position in the pack, left to right).');
  const res = await deleteSticker(env, index);
  if (res.ok) {
    await sendMessage(env, chatId, `🗑️ Sticker ${index} removed — ${res.remaining} left in the pack.`);
  } else {
    await sendMessage(env, chatId, `😿 ${esc(res.description || 'Telegram refused.')}`);
  }
}

async function cmdTagSticker(env, chatId, args) {
  const m = args.trim().match(/^#?(\d+)\s+(latte|mocha|both)$/i);
  if (!m) throw new ParseError('Usage: /tagsticker 3 latte (or mocha, or both) — position in the active pack.');
  const res = await tagSticker(env, chatId, +m[1], m[2].toLowerCase());
  if (!res.ok) return sendMessage(env, chatId, `😿 ${esc(res.description)}`);
  const label = m[2].toLowerCase() === 'both' ? 'Latte &amp; Mocha' : m[2][0].toUpperCase() + m[2].slice(1).toLowerCase();
  await sendMessage(env, chatId, `🏷️ Sticker ${+m[1]} is ${label}. The nag lines will match.`);
}

async function cmdAutoTag(env, chatId, args = '') {
  const redo = /\bredo\b/i.test(args);
  await sendMessage(env, chatId, redo
    ? '🔎 Wiping old tags — the cats are re-inspecting the pack…'
    : '🔎 The cats are inspecting the sticker pack…');
  const res = await autoTagPack(env, chatId, { redo });
  if (!res.ok) return sendMessage(env, chatId, `😿 ${esc(res.description)}`);
  const c = res.counts;
  if (!res.processed && !c.skipped) {
    return sendMessage(env, chatId, '🏷️ Everything in the pack is already tagged.');
  }
  let msg = `🤖 Tagged ${res.processed} sticker${res.processed === 1 ? '' : 's'}: ` +
    `${c.latte} Latte, ${c.mocha} Mocha, ${c.both} both` +
    (c.skipped ? `, ${c.skipped} skipped` : '') + '.';
  if (res.remaining) msg += `\n${res.remaining} to go — run /autotag again.`;
  msg += '\nFix any misses with /tagsticker N latte (position in the pack).';
  await sendMessage(env, chatId, msg);
}

const CAT_LABEL = { latte: 'Latte 🥛', mocha: 'Mocha 🍫', both: 'Latte &amp; Mocha 🐈🐈' };

async function cmdTags(env, chatId, args) {
  const res = await listTags(env, chatId);
  if (!res.ok) return sendMessage(env, chatId, `😿 ${esc(res.description)}`);
  const n = parseInt(args, 10);
  if (n) {
    const e = res.entries.find((x) => x.pos === n);
    if (!e) throw new ParseError(`The pack has ${res.entries.length} stickers — pick 1 to ${res.entries.length}.`);
    await tg(env, 'sendSticker', { chat_id: chatId, sticker: e.fileId });
    return sendMessage(env, chatId,
      `☝️ Sticker ${n}: ${e.cat ? CAT_LABEL[e.cat] : 'untagged'} — change with /tagsticker ${n} latte|mocha|both`);
  }
  const lines = res.entries.map((e) => `${e.pos}. ${e.cat ? CAT_LABEL[e.cat] : '—'}`);
  await sendMessage(env, chatId,
    `🏷️ <b>${esc(res.name)}</b> (order as shown in the pack)\n${lines.join('\n')}\n` +
    'Peek at one with /tags N · fix with /tagsticker N latte');
}

async function cmdUsePack(env, chatId, args) {
  const raw = args.trim();
  if (!raw) {
    const row = await env.DB.prepare('SELECT sticker_set FROM settings WHERE chat_id = ?').bind(chatId).first();
    return sendMessage(env, chatId,
      `Current nag stickers: <code>${esc((row && row.sticker_set) || 'Latte & Mocha (default)')}</code>\n` +
      'Switch with /usepack &lt;pack link or name&gt; — get the link by tapping any sticker → the pack name → share.\n' +
      'Back to the cats: /usepack reset');
  }
  if (raw.toLowerCase() === 'reset') {
    await env.DB.prepare(
      'INSERT INTO settings (chat_id, sticker_set) VALUES (?, NULL) ON CONFLICT(chat_id) DO UPDATE SET sticker_set = NULL'
    ).bind(chatId).run();
    return sendMessage(env, chatId, '🐾 Back to the Latte &amp; Mocha pack.');
  }
  const pack = await lookupPack(env, raw);
  if (!pack.ok) {
    throw new ParseError(`Couldn't find a sticker pack called "${pack.name || raw}". Paste the t.me/addstickers/... link.`);
  }
  await env.DB.prepare(
    'INSERT INTO settings (chat_id, sticker_set) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET sticker_set = excluded.sticker_set'
  ).bind(chatId, pack.name).run();
  await sendMessage(env, chatId,
    `🐾 Nag stickers switched to <b>${esc(pack.title)}</b> (${pack.count} stickers).`);
}

async function cmdTz(env, chatId, args) {
  const tz = args.trim();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new ParseError('Not a valid timezone. Use an IANA name like America/New_York or Europe/London.');
  }
  await env.DB.prepare(
    'INSERT INTO settings (chat_id, tz) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET tz = excluded.tz'
  ).bind(chatId, tz).run();
  await sendMessage(env, chatId, `🌍 Timezone set to <code>${esc(tz)}</code>.`);
}

const STATS_MAX_PER_PERSON = 15;
const MEDALS = ['🥇', '🥈', '🥉'];

// Best-guess emoji for a chore, by keyword. Falls back to a paw.
const CHORE_EMOJI = [
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
  for (const [re, emoji] of CHORE_EMOJI) if (re.test(text)) return emoji;
  return '🐾';
}

// Fetches done-history and expired count for a window; shared by the weekly
// leaderboard, /stats all, and the Sunday recap.
export async function choreStats(env, chatId, since) {
  const expired = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM firings WHERE chat_id = ? AND state = 'expired' AND fired_at > ?"
  ).bind(chatId, since).first();
  const history = await env.DB.prepare(
    `SELECT f.done_by, f.done_at, COALESCE(f.reminder_text, r.text, '?') AS text
     FROM firings f LEFT JOIN reminders r ON r.id = f.reminder_id
     WHERE f.chat_id = ? AND f.state = 'done' AND f.done_at > ?
     ORDER BY f.done_at DESC`
  ).bind(chatId, since).all();
  const byPerson = new Map();
  for (const h of history.results) {
    const who = h.done_by || '?';
    if (!byPerson.has(who)) byPerson.set(who, []);
    byPerson.get(who).push(h);
  }
  const people = [...byPerson.entries()].sort((a, b) => b[1].length - a[1].length);
  return { people, expired: expired.n, total: history.results.length };
}

async function cmdStats(env, chatId, tz, args = '') {
  if (/^\s*all\b/i.test(args)) return statsAll(env, chatId, tz);

  const since = weekStart(Date.now(), tz);
  const s = await choreStats(env, chatId, since);
  if (!s.total && !s.expired) {
    return sendMessage(env, chatId,
      '🏆 Fresh week, empty board — first chore takes the lead! (Resets every Monday; /stats all for history.)');
  }

  const lines = [`🏆 <b>Weekly leaderboard</b> — week of ${fmtShort(since, tz).replace(/,.*$/, '')}`];
  s.people.forEach(([who, items], i) => {
    lines.push('');
    lines.push(`${MEDALS[i] || '•'} <b>${esc(who)}</b> — ${items.length} ✅`);
    for (const h of items.slice(0, STATS_MAX_PER_PERSON)) {
      lines.push(`  ${choreEmoji(h.text)} ${esc(h.text)} — ${fmtShort(h.done_at, tz)}`);
    }
    if (items.length > STATS_MAX_PER_PERSON) lines.push(`  …and ${items.length - STATS_MAX_PER_PERSON} more`);
  });
  if (s.expired) {
    lines.push('');
    lines.push(`🪦 Expired unclaimed this week: ${s.expired}`);
  }
  lines.push('');
  lines.push('Resets Monday · /stats all for the 6-month log');
  await sendMessage(env, chatId, lines.join('\n'));
}

async function statsAll(env, chatId, tz) {
  const since = Date.now() - 183 * 24 * 3600000; // ~6 months
  const expired = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM firings WHERE chat_id = ? AND state = 'expired' AND fired_at > ?"
  ).bind(chatId, since).first();
  const history = await env.DB.prepare(
    `SELECT f.done_by, f.done_at, COALESCE(f.reminder_text, r.text, '?') AS text
     FROM firings f LEFT JOIN reminders r ON r.id = f.reminder_id
     WHERE f.chat_id = ? AND f.state = 'done' AND f.done_at > ?
     ORDER BY f.done_at DESC`
  ).bind(chatId, since).all();

  if (!history.results.length && !expired.n) {
    return sendMessage(env, chatId, 'Nothing completed in the last 6 months yet. The cats are patient.');
  }

  // Group by person, most completions first.
  const byPerson = new Map();
  for (const h of history.results) {
    const who = h.done_by || '?';
    if (!byPerson.has(who)) byPerson.set(who, []);
    byPerson.get(who).push(h);
  }
  const people = [...byPerson.entries()].sort((a, b) => b[1].length - a[1].length);

  const lines = ['📜 <b>Chore log — last 6 months</b>'];
  for (const [who, items] of people) {
    lines.push('');
    lines.push(`<b>${esc(who)}</b> — ${items.length} ✅`);
    for (const h of items.slice(0, STATS_MAX_PER_PERSON)) {
      lines.push(`  ${choreEmoji(h.text)} ${esc(h.text)} — ${fmtShort(h.done_at, tz)}`);
    }
    if (items.length > STATS_MAX_PER_PERSON) {
      lines.push(`  …and ${items.length - STATS_MAX_PER_PERSON} more`);
    }
  }
  if (expired.n) {
    lines.push('');
    lines.push(`🪦 Expired unclaimed: ${expired.n}`);
  }
  await sendMessage(env, chatId, lines.join('\n'));
}

async function handleCallback(env, cb) {
  const wiz = (cb.data || '').match(/^w:(\d+):([a-z]+\d*)$/);
  if (wiz && cb.message) {
    const draft = await env.DB.prepare('SELECT * FROM drafts WHERE id = ? AND chat_id = ?')
      .bind(+wiz[1], cb.message.chat.id).first();
    if (!draft) return answerCallback(env, cb.id, 'That one expired — send /remind again.');
    const tz = await getTz(env, draft.chat_id);
    if (wiz[2] === 'custom') {
      const prompt = await sendMessage(env, draft.chat_id,
        `⏰ Reply to this message with a time for <b>${esc(draft.text)}</b> — e.g. <code>10am</code>, ` +
        '<code>tomorrow 9:30am</code>, <code>in 30m</code>, or <code>now</code>.',
        { force_reply: true, selective: true });
      if (prompt.ok) {
        await env.DB.prepare('UPDATE drafts SET prompt_msg_id = ? WHERE id = ?')
          .bind(prompt.result.message_id, draft.id).run();
      }
      return answerCallback(env, cb.id, 'Type the time as a reply ⏰');
    }
    const sched = scheduleFromCode(wiz[2], draft, Date.now(), tz);
    if (!sched) return answerCallback(env, cb.id, '');
    const { html } = await createReminder(env, draft.chat_id, {
      text: draft.text, assigneeName: draft.assignee_name, assigneeUserId: draft.assignee_user_id,
      nagIntervals: JSON.parse(draft.nag_intervals), ...sched,
    }, senderName(cb.from), tz);
    await env.DB.prepare('DELETE FROM drafts WHERE id = ?').bind(draft.id).run();
    await editMessage(env, draft.chat_id, cb.message.message_id, html);
    return answerCallback(env, cb.id, 'Scheduled 📝');
  }

  const m = (cb.data || '').match(/^([ds]):(\d+)$/);
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

  if (m[1] === 'd') {
    await completeFiring(env, firing, reminder, by, tz);
    return answerCallback(env, cb.id, 'Purrs 😻');
  }

  // Snooze
  if (firing.snoozes_used >= MAX_SNOOZES) {
    return answerCallback(env, cb.id, `No more snoozes 😈 (max ${MAX_SNOOZES})`);
  }
  await env.DB.prepare(
    'UPDATE firings SET snoozes_used = snoozes_used + 1, next_nag_at = ? WHERE id = ?'
  ).bind(Date.now() + 3600000, firing.id).run();
  return answerCallback(env, cb.id, `Snoozed 1h (${firing.snoozes_used + 1}/${MAX_SNOOZES}) 😴`);
}
