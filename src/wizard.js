// The no-time wizard: a /remind without a time parks its parsed pieces as a
// draft and offers tap-to-choose times (plus one confirmed-only AI guess).
// Handles the w: callbacks and the typed custom-time replies.

import { sendPrivate, deleteMessage, esc, mentionHtml, editRef, deleteRef, msgRef,
         answerCallback, isPublicMessage } from './tg.js';
import { nextOccurrence, localParts, zonedEpoch, fmtShort, DAY_NAMES } from './time.js';
import { parseRemind, ParseError } from './parse.js';
import { suggestSchedule } from './ai.js';
import { getTz, senderName } from './household.js';
import { emptyKeyboard } from './nag.js';
import { createReminder, confirmNewChore, undoButtons, fireIfDue } from './chores.js';

// No time given: park the parsed pieces as a draft and offer tap-to-choose
// times instead of an error. Workers AI gets one shot at guessing the intent;
// a valid guess becomes the top button — applied only if someone taps it.
export async function startWizard(env, ctx, partial, rawArgs, tz, scored) {
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

// A plain-text message resolving a pending draft: a reply to the wizard or
// prompt message, or (after "✏️ Type a time") a message that is purely a time.
export async function tryDraftTime(env, msg, ctx, replyRef) {
  const chatId = msg.chat.id;
  const now = Date.now();
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
  const promptRef = draftRef(draft, 'prompt');
  if (promptRef) await deleteRef(env, ctx, chatId, promptRef);
  if (isPublicMessage(msg)) await deleteMessage(env, chatId, msg.message_id);
  // The wizard message becomes the confirmation for an assigned chore; an
  // unassigned one is announced instead, so the wizard is cleared away.
  if (p.assigneeName || p.assigneeUserId) {
    if (wizardRef) await editRef(env, ctx, chatId, wizardRef, html, undoButtons(id));
    else await sendPrivate(env, ctx, html, undoButtons(id));
  } else {
    if (wizardRef) await deleteRef(env, ctx, chatId, wizardRef);
    await confirmNewChore(env, ctx, by, p, tz, id, html);
  }
  await fireIfDue(env, id, tz);
}

// The w: callback family: time-choice taps on the wizard message.
export async function handleWizardCallback(env, cb, ctx, ref) {
  const wiz = (cb.data || '').match(/^w:(\d+):([a-z]+\d*)$/);
  if (!wiz) return answerCallback(env, cb.id, '');
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
  if (wizP.assigneeName || wizP.assigneeUserId) {
    await editRef(env, ctx, draft.chat_id, ref, html, undoButtons(newId));
  } else {
    await deleteRef(env, ctx, draft.chat_id, ref);
    await confirmNewChore(env, ctx, wizBy, wizP, tz, newId, html);
  }
  return answerCallback(env, cb.id, 'Scheduled 📝');
}
