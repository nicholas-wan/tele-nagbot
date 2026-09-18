// The no-time wizard: a /remind without a time parks its parsed pieces as a
// draft and offers tap-to-choose times (plus one confirmed-only AI guess).
// Handles the w: callbacks and the typed custom-time replies.

import { sendPrivate, deleteMessage, esc, mentionHtml, editRef, deleteRef, msgRef,
         answerCallback, isPublicMessage, keepSourceMessage } from './tg.js';
import { nextOccurrence, advanceOccurrence, localParts, zonedEpoch, fmtShort, DAY_NAMES } from './time.js';
import { parseRemind, ParseError, NoTimeError, DEFAULT_NAGS } from './parse.js';
import { suggestSchedule } from './ai.js';
import { getTz, senderName, nicknames } from './household.js';
import { emptyKeyboard } from './nag.js';
import { createReminder, confirmNewChore, undoButtons, fireIfDue } from './chores.js';

// Bare /chore or /remind — the "/" autocomplete menu sends the command with
// no text. Ask what to nag about instead of erroring; the reply is parsed as
// the full command, and the time wizard follows if the reply has no time.
// An empty text marks the draft as awaiting the whole command.
export async function startTextPrompt(env, ctx, from, scored) {
  const res = await env.DB.prepare(
    `INSERT INTO drafts (chat_id, text, assignee_name, assignee_user_id, schedule_kind,
       schedule_detail, nag_intervals, created_at, scored, user_id)
     VALUES (?, '', NULL, NULL, 'once', '{}', ?, ?, ?, ?)`
  ).bind(ctx.chatId, JSON.stringify(DEFAULT_NAGS), Date.now(), scored ? 1 : 0, ctx.userId).run();
  const id = res.meta.last_row_id;
  // selective force_reply only auto-opens the reply box for a mentioned user.
  const mention = from.username
    ? `@${from.username}`
    : mentionHtml(from.first_name || 'you', from.id);
  const prompt = await sendPrivate(env, ctx,
    `🐾 ${mention} — what should Latte &amp; Mocha nag about? Reply with the chore, ` +
    'e.g. <code>trash 7pm daily</code>, <code>dishes now</code>, or <code>@jane plants mon 8am</code>.',
    { force_reply: true, selective: true });
  const pRef = msgRef(prompt);
  if (pRef) {
    await env.DB.prepare('UPDATE drafts SET prompt_msg_id = ?, prompt_msg_ephemeral = ? WHERE id = ?')
      .bind(pRef.id, pRef.ephemeral ? 1 : 0, id).run();
  }
}

// A reply to the "what should the cats nag about?" prompt carries the whole
// command. A time-less reply hands over to the time wizard rather than
// bouncing the person back to square one.
async function resolveTextPrompt(env, msg, ctx, draft) {
  const chatId = msg.chat.id;
  const now = Date.now();
  const tz = await getTz(env, chatId);
  const scored = Boolean(draft.scored);
  // The reply is the command here, and is kept like one: it stays until the
  // confirmation's ✅ OK, so a misread chore can be checked against it.
  const sourceMsgId = await keepSourceMessage(env, chatId, msg);
  let p;
  try {
    p = parseRemind(msg.text, msg.text, msg.entities || [], now, tz, nicknames(env));
  } catch (err) {
    if (err instanceof NoTimeError) {
      // Claim the prompt draft before opening the wizard, so a second reply
      // racing this one cannot spawn two wizards for the same ask.
      const claim = await env.DB.prepare('DELETE FROM drafts WHERE id = ? AND chat_id = ?')
        .bind(draft.id, chatId).run();
      if (!claim.meta.changes) return;
      const promptRef = draftRef(draft, 'prompt');
      if (promptRef) await deleteRef(env, ctx, chatId, promptRef);
      return startWizard(env, ctx, err.partial, msg.text, tz, scored, sourceMsgId);
    }
    // An unusable reply keeps the draft alive — replying to the prompt again
    // gets another try.
    if (err instanceof ParseError) return sendPrivate(env, ctx, esc(err.message));
    throw err;
  }
  p.scored = scored;
  p.sourceMsgId = sourceMsgId;
  const claim = await env.DB.prepare('DELETE FROM drafts WHERE id = ? AND chat_id = ?')
    .bind(draft.id, chatId).run();
  if (!claim.meta.changes) return;
  const promptRef = draftRef(draft, 'prompt');
  if (promptRef) await deleteRef(env, ctx, chatId, promptRef);
  const by = senderName(msg.from);
  const { id, html } = await createReminder(env, chatId, p, by, tz);
  await confirmNewChore(env, ctx, by, p, tz, id, html);
  await fireIfDue(env, id, tz);
}

// No time given: park the parsed pieces as a draft and offer tap-to-choose
// times instead of an error. Workers AI gets one shot at guessing the intent;
// a valid guess becomes the top button — applied only if someone taps it.
// sourceMsgId is the public command the chore was typed in; it rides on the
// draft so the eventual confirmation's ✅ OK can remove it.
export async function startWizard(env, ctx, partial, rawArgs, tz, scored, sourceMsgId = null) {
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
  // A stated start date ("every month starting 31 jan") has to survive the
  // wizard, and drafts have no column for it — so it travels inside
  // schedule_detail as startDate and is stripped back out before the reminder
  // is created. Without it the anchor was simply dropped and the chore began
  // on whatever day the time was chosen.
  const detail = partial.date ? { ...partial.detail, startDate: partial.date } : partial.detail;
  // user_id is whose wizard this is: a bare typed time resolves only the
  // typer's own draft, and the wizard card (usually ephemeral to them) can
  // only be edited on their behalf.
  const res = await env.DB.prepare(
    `INSERT INTO drafts (chat_id, text, assignee_name, assignee_user_id, schedule_kind,
       schedule_detail, nag_intervals, ai_json, created_at, scored, source_msg_id, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    chatId, partial.text, partial.assigneeName, partial.assigneeUserId, partial.kind,
    JSON.stringify(detail), JSON.stringify(partial.nagIntervals),
    ai ? JSON.stringify(ai) : null, Date.now(), scored ? 1 : 0, sourceMsgId, ctx.userId
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

  // An interval is counted in months or in days; reading only .days rendered
  // a monthly chore as "every undefined days".
  const intervalNote = partial.detail.months
    ? `every ${partial.detail.months} month${partial.detail.months === 1 ? '' : 's'}`
    : `every ${partial.detail.days} days`;
  const kindNote = partial.kind === 'once' ? '' :
    ` (${partial.kind === 'weekly' ? 'every ' + partial.detail.days.map((i) => DAY_NAMES[i]).join(',') :
        partial.kind === 'monthly' ? 'on the ' + partial.detail.dom :
        partial.kind === 'interval' ? intervalNote : 'daily'})`;
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

// An assigned chore's confirmation is the wizard card itself, edited in place
// — the only confirmation it gets, since the group is not told about someone
// else's chore. If that edit fails (the card was swept, or it is ephemeral to
// somebody else) the chore used to exist with no confirmation and no Undo
// anywhere, so a failed edit falls back to a fresh private line.
async function confirmOnWizard(env, ctx, chatId, wizardRef, html, buttons) {
  const res = wizardRef ? await editRef(env, ctx, chatId, wizardRef, html, buttons) : null;
  if (res && res.ok) return res;
  return sendPrivate(env, ctx, html, buttons);
}

// Rebuild a stored { id, ephemeral } pair from a drafts row.
function draftRef(draft, field) {
  const id = draft[`${field}_msg_id`];
  return id ? { id, ephemeral: Boolean(draft[`${field}_msg_ephemeral`]) } : null;
}

// The draft's schedule, with the start-date passenger taken off: startDate is
// how the anchor rides in drafts.schedule_detail, and it must never reach a
// reminder row.
function draftSchedule(draft) {
  const { startDate, ...detail } = JSON.parse(draft.schedule_detail);
  return { detail, startDate: startDate || null };
}

// First fire for a draft that named a start date: that date at the chosen
// time. Already past, and it follows the same rule parse.js does — roll the
// cadence forward from the anchor rather than jumping a whole year.
function anchoredFirstFire(startDate, kind, detail, now, tz) {
  const p = localParts(now, tz);
  const mi = detail.mi || 0;
  const at = zonedEpoch(p.y, startDate.mon + 1, startDate.dom, detail.h, mi, tz);
  if (at > now) return at;
  if (kind === 'once') return zonedEpoch(p.y + 1, startDate.mon + 1, startDate.dom, detail.h, mi, tz);
  const next = kind === 'interval'
    ? advanceOccurrence('interval', detail, at, now, tz)
    : nextOccurrence(kind, detail, now, tz);
  return next != null ? next : at;
}

function scheduleFromCode(code, draft, now, tz) {
  const kind = draft.schedule_kind;
  const { detail, startDate } = draftSchedule(draft);
  const absolute = code.match(/^a(\d+)$/);
  if (absolute) {
    const firstFireAt = +absolute[1];
    return firstFireAt > now ? { kind: 'once', detail: {}, firstFireAt } : null;
  }
  if (code === 'r15' || code === 'r60') {
    return { kind: 'once', detail: {}, firstFireAt: now + (code === 'r15' ? 15 : 60) * 60000 };
  }
  if (code === 'd19') {
    const d = { h: 19, mi: 0 };
    return { kind: 'daily', detail: d, firstFireAt: nextOccurrence('daily', d, now, tz) };
  }
  const hm = code.match(/^h(\d+)$/);
  if (hm) {
    const d = { ...detail, h: +hm[1], mi: 0 };
    // A stated start date decides the first fire; otherwise an interval takes
    // the next h:mi slot, not a full gap out.
    const firstFireAt = startDate
      ? anchoredFirstFire(startDate, kind, d, now, tz)
      : kind === 'interval'
        ? nextOccurrence('daily', { h: d.h, mi: 0 }, now, tz)
        : nextOccurrence(kind, d, now, tz);
    return { kind, detail: d, firstFireAt };
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
    // An empty text marks a "what should the cats nag about?" prompt: the
    // reply is the whole command, not just a time.
    if (draft && !draft.text) return resolveTextPrompt(env, msg, ctx, draft);
  }
  if (!draft) {
    // The wizard invites "reply with a custom time", but not every client
    // makes replying obvious — so a message that is PURELY a time also counts
    // while the typer's own wizard is fresh (the parsed.text check below
    // rejects ambient chat). Their own: the newest draft in the chat used to
    // do, and with two wizards open, whoever typed "10am" next scheduled the
    // other person's chore, credited to themselves, and the other's card was
    // edited on the wrong person's behalf. Awaiting-text drafts are still
    // excluded: only a direct reply may resolve them, or any group chat with
    // a time in it would become a chore with no name.
    draft = await env.DB.prepare(
      `SELECT * FROM drafts WHERE chat_id = ? AND user_id = ? AND text <> ''
         AND created_at > ? ORDER BY id DESC LIMIT 1`
    ).bind(chatId, msg.from ? msg.from.id : null, now - 15 * 60000).first();
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
  const { detail: draftDetail, startDate } = draftSchedule(draft);
  if (kind === 'once' && draft.schedule_kind !== 'once' && parsed.detail.h != null) {
    kind = draft.schedule_kind;
    detail = { ...draftDetail, h: parsed.detail.h, mi: parsed.detail.mi };
    // Interval first occurrence: the next h:mi slot (the parser's rule) — an
    // interval nextOccurrence would put the FIRST fire a whole gap away.
    firstFireAt = kind === 'interval'
      ? nextOccurrence('daily', { h: detail.h, mi: detail.mi }, now, tz)
      : nextOccurrence(kind, detail, now, tz);
  }
  // A draft that named a start date starts on it, once the missing time
  // arrives — a typed clock time says when, not which day. A relative reply
  // ("in 30m", "now") carries no time of day and means exactly what it says,
  // so it keeps its own instant.
  if (startDate && parsed.detail.h != null) {
    firstFireAt = anchoredFirstFire(startDate, kind, detail, now, tz);
  }
  const p = {
    text: draft.text, assigneeName: draft.assignee_name, assigneeUserId: draft.assignee_user_id,
    nagIntervals: JSON.parse(draft.nag_intervals), kind, detail, firstFireAt, scored: draft.scored,
    sourceMsgId: draft.source_msg_id || null,
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
    await confirmOnWizard(env, ctx, chatId, wizardRef, html, undoButtons(id, p.sourceMsgId));
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
    const firstFireAt = ai.kind === 'once' ? ai.firstFireAt
      // Interval first occurrence: the next h:mi slot, not a full gap out.
      : ai.kind === 'interval'
        ? nextOccurrence('daily', { h: ai.detail.h, mi: ai.detail.mi }, Date.now(), tz)
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
    sourceMsgId: draft.source_msg_id || null,
  };
  const { id: newId, html } = await createReminder(env, draft.chat_id, wizP, wizBy, tz);
  if (wizP.assigneeName || wizP.assigneeUserId) {
    await confirmOnWizard(env, ctx, draft.chat_id, ref, html, undoButtons(newId, wizP.sourceMsgId));
  } else {
    await deleteRef(env, ctx, draft.chat_id, ref);
    await confirmNewChore(env, ctx, wizBy, wizP, tz, newId, html);
  }
  return answerCallback(env, cb.id, 'Scheduled 📝');
}
