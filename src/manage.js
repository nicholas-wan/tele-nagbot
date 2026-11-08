// Chore management UI: the ⚙️ Manage flow that runs inside the pinned
// dashboard (picker → per-chore actions) and the ✏️ editor it opens, which
// also serves /edit as its own message. Handles the m: and e: callbacks.

import { editMessage, editReplyMarkup, editRef, answerCallback, deleteMessage, deleteEphemeral, esc } from './tg.js';
import { nextOccurrence, localParts, zonedEpoch } from './time.js';
import { DEFAULT_NAGS } from './parse.js';
import { getTz, householdRoster, householdMembers, membersFrom, senderName, creditTogether, isScored } from './household.js';
import { completeFiring, editNag, firingCard, deleteNag, nagChat } from './nag.js';
import { updateDashboard, choreListHtml, buttonText, clip, describeSchedule, dashboardButtons,
         boardDrawn, loadBoard, fmtWhen } from './dashboard.js';
import { setReminderPaused, deleteReminder, completeEarly, chatPaused, redrawNag } from './chores.js';

export function editorText(r, tz) {
  const d = JSON.parse(r.schedule_detail);
  const nags = JSON.parse(r.nag_intervals).join('/');
  const assignee = r.assignee_name ? esc(r.assignee_name) : 'Anyone';
  const next = r.next_fire_at != null ? fmtWhen(r.next_fire_at, tz) : 'nagging now';
  return `✏️ <b>Edit: ${esc(r.text)}</b>\n` +
    `Schedule: ${esc(describeSchedule(r))}\n` +
    `Next: ${next}\n` +
    `Assigned: ${assignee}\n` +
    `Nag pace: ${nags} min\n` +
    `Rotation: ${d.rotate ? 'on' : 'off'}\n` +
    `Points: ${r.scored ? 'counts on the leaderboard' : 'no points'}${r.paused ? '\nStatus: paused' : ''}`;
}

export async function editorButtons(env, r) {
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

// `members` is the household as [{ userId, name }]; the assignee buttons carry
// the user_id, so a tap means the same person however the roster has changed
// since the menu was drawn — this menu sits on the shared pinned board and
// can be hours old. A list position shifted whenever anyone joined or left.
function editorSubmenu(kind, r, members = []) {
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
    members.slice(0, 8).forEach((m) => rows.push([b(m.name, String(m.userId))]));
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

// The editor lives on one of two surfaces: the shared pinned dashboard (always
// a public message, whose text is the chore list) or its own message from
// /edit, which is usually ephemeral. Only the ref knows which id space that
// second one belongs to — editing an ephemeral message with the public method
// silently does nothing, leaving a dead screen behind a "Updated ✓" toast.
// `onPin` and `loaded`, when the caller already knows where the editor is and
// has the board's rows in hand, spare the reads.
async function refreshEditor(env, cb, ctx, ref, r, tz, buttons = null, { onPin = null, loaded = null } = {}) {
  const markup = buttons || await editorButtons(env, r);
  if (onPin ?? await editorIsDashboard(env, cb)) {
    const html = await choreListHtml(env, r.chat_id, tz, loaded);
    const res = await editMessage(env, r.chat_id, cb.message.message_id, html, markup);
    // This edit is the board's redraw; the deferred one would close the editor.
    boardDrawn(env, r.chat_id);
    return res;
  }
  return editRef(env, ctx, r.chat_id, ref, editorText(r, tz), markup);
}

// Applies one e:set… tap. Returns null on success, or the toast to show
// instead. Every value is checked against what the buttons actually offer:
// callback data is not bound to the button it came from, and an unchecked
// nag pace of "zz" was stored as [null] — a zero interval that re-nagged the
// chore every minute, on every occurrence, until it was deleted.
//
// The writes to next_fire_at are compare-and-swaps on the value the editor
// read, like every other move of that column: the cron's fire claim moves it
// too, and an unconditional write here either resurrected a slot the cron had
// just consumed (a second fire the same evening) or cancelled a fire in
// flight. Losing the swap just means "that one just fired".
//
// A time is an hour from the buttons ("19") or an hour and minute from the
// Mini App's time field ("19:30").
export const JUST_FIRED = 'That one just fired — see its nag.';
export const NAG_PACES = ['10', 'default', '30', '60'];
export async function applyEditorChoice(env, r, kind, value, tz, { members = null } = {}) {
  return runPlan(env, await editorPlan(env, r, kind, value, tz, { members }));
}

// A change as the statements that make it, the refusal its answers may carry,
// and the Telegram work that follows: the chat sends the statements on their
// own (runPlan), and the Mini App inside the batch its reply reads, so the
// answer is the one round trip after its gate.
//   { problem }  — refused before anything is written
//   { statements, check(results) → problem | null, after() }
export async function runPlan(env, plan) {
  if (plan.problem) return plan.problem;
  const results = plan.statements.length ? await env.DB.batch(plan.statements) : [];
  const problem = plan.check(results);
  if (problem) return problem;
  await plan.after();
  return null;
}

const NOTHING_AFTER = async () => {};
const write = (statements, check = () => null, after = NOTHING_AFTER) => ({ statements, check, after });

export async function editorPlan(env, r, kind, value, tz, { members = null } = {}) {
  if (kind === 'time') {
    const clock = String(value).match(/^(\d{1,2})(?::(\d{2}))?$/);
    const hour = clock ? Number(clock[1]) : NaN;
    const minute = clock && clock[2] ? Number(clock[2]) : 0;
    if (!clock || hour > 23 || minute > 59) return { problem: 'Not a valid hour or time.' };
    const detail = { ...JSON.parse(r.schedule_detail), h: hour, mi: minute };
    let next;
    if (r.schedule_kind === 'once' || (r.schedule_kind === 'interval' && r.next_fire_at)) {
      // Anchored to a date rather than to a calendar rule: a one-off set for
      // next Friday stays on Friday, and an interval chore must not be pushed
      // a whole gap out. Keep the date (today, for a one-off with no date
      // left); if the new time has already passed on it, take the next slot.
      const f = localParts(r.next_fire_at || Date.now(), tz);
      next = zonedEpoch(f.y, f.mo, f.d, hour, minute, tz);
      if (next <= Date.now()) next = nextOccurrence('daily', { h: hour, mi: minute }, Date.now(), tz);
    } else {
      // daily / weekly / monthly regenerate their own next slot from the rule.
      next = nextOccurrence(r.schedule_kind, detail, Date.now(), tz);
    }
    return write([env.DB.prepare(
      'UPDATE reminders SET schedule_detail = ?, next_fire_at = ? WHERE id = ? AND next_fire_at IS ?'
    ).bind(JSON.stringify(detail), next, r.id, r.next_fire_at)], ([res]) => (res.meta.changes ? null : JUST_FIRED));
  }
  if (kind === 'schedule') {
    if (!['daily', 'weekdays', 'weekends'].includes(value)) return { problem: 'Not a schedule the editor offers.' };
    const old = JSON.parse(r.schedule_detail);
    const base = { h: old.h ?? 9, mi: old.mi ?? 0, ...(old.rotate ? { rotate: true } : {}) };
    const schedule = value === 'daily'
      ? { kind: 'daily', detail: base }
      : { kind: 'weekly', detail: { ...base, days: value === 'weekdays' ? [1, 2, 3, 4, 5] : [0, 6] } };
    const next = nextOccurrence(schedule.kind, schedule.detail, Date.now(), tz);
    return write([env.DB.prepare(
      'UPDATE reminders SET schedule_kind = ?, schedule_detail = ?, next_fire_at = ? WHERE id = ? AND next_fire_at IS ?'
    ).bind(schedule.kind, JSON.stringify(schedule.detail), next, r.id, r.next_fire_at)],
    ([res]) => (res.meta.changes ? null : JUST_FIRED));
  }
  if (kind === 'nag') {
    const minutes = Number(value);
    if (value !== 'default' && (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440)) {
      return { problem: 'Not a nag pace the editor offers.' };
    }
    const intervals = value === 'default' ? DEFAULT_NAGS : [minutes];
    return write([env.DB.prepare('UPDATE reminders SET nag_intervals = ? WHERE id = ?')
      .bind(JSON.stringify(intervals), r.id)]);
  }
  if (kind === 'assign') {
    const member = value === '0' ? null
      : (members || await householdMembers(env, r.chat_id)).find((m) => String(m.userId) === value);
    if (value !== '0' && !member) return { problem: 'That household member is no longer here.' };
    return write([env.DB.prepare('UPDATE reminders SET assignee_name = ?, assignee_user_id = ? WHERE id = ?')
      .bind(member ? member.name : null, member ? member.userId : null, r.id)], () => null,
    () => moveAssignedNag(env, { ...r, assignee_name: member ? member.name : null,
      assignee_user_id: member ? member.userId : null }, tz));
  }
  return write([]);
}

// Move the active occurrence too. Clearing its old reference first invalidates
// any cron/poke writer holding the previous recipient and message snapshot.
async function moveAssignedNag(env, r, tz) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const f = await env.DB.prepare(
      "SELECT * FROM firings WHERE reminder_id = ? AND state = 'nagging' ORDER BY id DESC LIMIT 1"
    ).bind(r.id).first();
    if (!f || (f.nag_user_id ?? null) === r.assignee_user_id) return;
    const claimed = await env.DB.prepare(
      `UPDATE firings SET nag_user_id = ?, nag_chat_id = NULL,
         last_message_id = NULL, last_message_ephemeral = 0, last_sticker_id = NULL
       WHERE id = ? AND state = 'nagging' AND last_message_id IS ? AND nag_user_id IS ?
         AND EXISTS (SELECT 1 FROM reminders WHERE id = ? AND assignee_user_id IS ?)`
    ).bind(r.assignee_user_id, f.id, f.last_message_id, f.nag_user_id ?? null, r.id, r.assignee_user_id).run();
    if (!claimed.meta.changes) continue;
    if (f.last_message_id) await deleteNag(env, f);
    if (f.last_sticker_id) await deleteMessage(env, nagChat(f), f.last_sticker_id);
    const moved = { ...f, nag_user_id: r.assignee_user_id, nag_chat_id: null,
      last_message_id: null, last_message_ephemeral: 0, last_sticker_id: null };
    const paused = r.paused || await chatPaused(env, r.chat_id);
    const [html, markup] = paused
      ? [`⏸️ <b>${esc(r.text)}</b>\nPaused.`, { inline_keyboard: [] }]
      : firingCard(r, moved, tz);
    await redrawNag(env, moved, html, markup);
    return;
  }
}

// The points flag is written into the nag itself — the "(reminder — no points)"
// line and the Delete button's wording both come from it — so flipping it in
// the database alone leaves the card on screen contradicting the editor until
// the next occurrence. Redraw the live card with the new answer.
//
// What is on screen is not always a nag, though, and the card must come back as
// whatever it already was — firingCard decides: a nag, the 😴 notice of a
// snooze still in force, or the ⏰ card of an overdue one-off (which this
// path once redrew as a nag, Snooze and all). There is no reply-markup-only
// edit for an ephemeral message, so the text is re-rendered along with the
// buttons either way. One state stops us: paused, per chore or household-wide,
// where the card reads "⏸️ Paused by …" with no buttons — redrawing it would
// revive a chore nobody resumed.
async function redrawLiveNag(env, r, scored, tz) {
  if (r.paused || await chatPaused(env, r.chat_id)) return;
  const firing = await env.DB.prepare(
    "SELECT * FROM firings WHERE reminder_id = ? AND state = 'nagging' ORDER BY id DESC LIMIT 1"
  ).bind(r.id).first();
  if (!firing || !firing.last_message_id) return;
  const live = { ...firing, scored };
  const [html, markup] = firingCard({ ...r, scored }, live, tz);
  await editNag(env, live, html, markup);
}

// Rotation and points, set to `on`. The editor's buttons flip whatever the
// row says now; the Mini App names the value it wants, so a screen drawn
// before somebody else's tap cannot flip it back. Setting what is already
// there changes nothing.
export async function setEditorFlag(env, r, kind, on, tz) {
  await runPlan(env, flagPlan(env, r, kind, on, tz));
}

export function flagPlan(env, r, kind, on, tz) {
  if (kind === 'rotate') {
    const detail = JSON.parse(r.schedule_detail);
    if (Boolean(detail.rotate) === Boolean(on)) return write([]);
    if (on) detail.rotate = true;
    else delete detail.rotate;
    return write([env.DB.prepare('UPDATE reminders SET schedule_detail = ? WHERE id = ?')
      .bind(JSON.stringify(detail), r.id)]);
  }
  const scored = on ? 1 : 0;
  if (Boolean(r.scored) === Boolean(scored)) return write([]);
  // A firing snapshots scored at fire time, so a nag already on screen
  // would keep its old "(reminder — no points)" line, its old button label
  // and its old credit until the next occurrence. Move the live one too.
  return write([
    env.DB.prepare('UPDATE reminders SET scored = ? WHERE id = ?').bind(scored, r.id),
    env.DB.prepare("UPDATE firings SET scored = ? WHERE reminder_id = ? AND state = 'nagging'").bind(scored, r.id),
  ], () => null, () => redrawLiveNag(env, r, scored, tz));
}

// ⏭️ Skip next: the chore's upcoming slot goes by unnagged. Returns the new
// slot, 'once' for a chore with no next to skip to, or null when the cron
// fired it while we looked. Compare-and-swap against the cron's fire claim:
// a skip that read the slot just before it fired used to write the value the
// cron had already written and report a skip that changed nothing.
export async function skipNext(env, r, tz) {
  const plan = skipPlan(env, r, tz);
  if (plan === 'once') return 'once';
  const res = await plan.statement.run();
  if (!res.meta.changes) return null;
  await updateDashboard(env, r.chat_id);
  return plan.next;
}

// The skip's write, for a batch of the caller's own (the Mini App's answer):
// { next, statement }, or 'once' for a chore with no next slot to skip.
export function skipPlan(env, r, tz) {
  if (r.schedule_kind === 'once' || !r.next_fire_at) return 'once';
  const next = nextOccurrence(r.schedule_kind, JSON.parse(r.schedule_detail), r.next_fire_at, tz);
  return {
    next,
    statement: env.DB.prepare('UPDATE reminders SET next_fire_at = ? WHERE id = ? AND next_fire_at = ?')
      .bind(next, r.id, r.next_fire_at),
  };
}

// Done from the board or the Mini App, credited to `credit`: the live nag if
// there is one, else the upcoming occurrence, done early. Returns 'done',
// 'early', 'raced' when somebody else got there first, or 'idle' for a chore
// with nothing to complete (paused, or a one-off with nothing scheduled).
// `expect: 'now'` is a Done tapped on a nag the page showed as live: when the
// nag has gone meanwhile (finished from the chat, or the same tap twice) it is
// 'raced', not a Done early on the next occurrence.
// `live`: the chore's live firing, or null for none, when the caller read it
// in a batch of its own (the Mini App's gate).
// `onClaim(outcome)` runs the moment the Done is won — 'done' or 'early' —
// before the card, the receipt and the board: where a tap's toast goes.
// `onFiring(id)`: told the done firing's id when a Done is won, so the Mini App
// can offer ↩️ Not done as the receipt does.
export async function completeNow(env, r, credit, tz, { expect, live, onClaim, onFiring } = {}) {
  const firing = live !== undefined ? live : await env.DB.prepare(
    "SELECT * FROM firings WHERE reminder_id = ? AND state = 'nagging' ORDER BY id DESC LIMIT 1"
  ).bind(r.id).first();
  if (!firing) {
    if (expect === 'now') return 'raced';
    if (r.paused || r.next_fire_at == null) return 'idle';
    // A Done early that finds the chore has just fired finishes that nag
    // instead (completeEarly says which), and the toast says what happened.
    let outcome = 'early';
    const id = await completeEarly(env, r, credit, tz, {
      onClaim: (kind) => { outcome = kind || 'early'; return onClaim && onClaim(outcome); },
    });
    if (id && onFiring) onFiring(id);
    return id ? outcome : 'raced';
  }
  const won = await completeFiring(env, firing, r, credit, tz, { onClaim: onClaim && (() => onClaim('done')) });
  if (won && onFiring) onFiring(firing.id);
  return won ? 'done' : 'raced';
}

// The e: callback family: editor navigation and value taps. The chore, where
// the editor is (the pin, or its own message) and, for the assignee picker,
// the roster are one round trip. Navigation is answered at once; a change is
// answered as soon as it is made, and the editor is redrawn after, from one
// more read (the board's, when the editor lives on it).
export async function handleEditorCallback(env, cb, ctx, ref) {
  const editNav = (cb.data || '').match(/^e:(menu|time|schedule|nag|assign|rotate|score|pause|close):(\d+)$/);
  const editSet = (cb.data || '').match(/^e:set(time|schedule|nag|assign):(\d+):([a-z0-9]+)$/);
  if (!editNav && !editSet) return answerCallback(env, cb.id, '');
  const reminderId = +(editNav ? editNav[2] : editSet[2]);
  const chatId = cb.message.chat.id;
  const roster = (editNav && editNav[1] === 'assign') || (editSet && editSet[1] === 'assign');
  const [rows, pin, people] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM reminders WHERE id = ? AND chat_id = ?').bind(reminderId, chatId),
    env.DB.prepare('SELECT dashboard_msg_id FROM settings WHERE chat_id = ?').bind(chatId),
    ...(roster ? [env.DB.prepare('SELECT user_id, username, first_name FROM members WHERE chat_id = ?').bind(chatId)] : []),
  ]);
  let r = (rows.results || [])[0] || null;
  if (!r) return answerCallback(env, cb.id, 'That chore is already gone.');
  const pinned = (pin.results || [])[0];
  const onPin = Boolean(cb.message.message_id && pinned && pinned.dashboard_msg_id === cb.message.message_id);
  const members = people ? membersFrom(people.results) : null;
  const tz = await getTz(env, r.chat_id);

  if (editNav) {
    const action = editNav[1];
    if (action === 'close') {
      await answerCallback(env, cb.id, 'Closed');
      if (ref && ref.ephemeral) await deleteEphemeral(env, ctx, ref.id);
      else if (onPin) await updateDashboard(env, r.chat_id);
      else await deleteMessage(env, r.chat_id, cb.message.message_id);
      return;
    }
    if (action === 'menu') {
      await answerCallback(env, cb.id, '');
      await refreshEditor(env, cb, ctx, ref, r, tz, null, { onPin });
      return;
    }
    if (['time', 'schedule', 'nag', 'assign'].includes(action)) {
      await answerCallback(env, cb.id, '');
      await refreshEditor(env, cb, ctx, ref, r, tz, editorSubmenu(action, r, members || []), { onPin });
      return;
    }
    if (action === 'rotate') {
      await setEditorFlag(env, r, 'rotate', !JSON.parse(r.schedule_detail).rotate, tz);
    } else if (action === 'score') {
      await setEditorFlag(env, r, 'score', !r.scored, tz);
    } else if (action === 'pause') {
      await setReminderPaused(env, r, !r.paused, tz, senderName(cb.from));
    }
  } else {
    const problem = await applyEditorChoice(env, r, editSet[1], editSet[3], tz, { members });
    if (problem) return answerCallback(env, cb.id, problem);
  }
  await answerCallback(env, cb.id, 'Updated ✓');

  // The chore as it now stands: from the board's own read when the editor is
  // the board, which the redraw needs anyway.
  let loaded = null;
  if (onPin) {
    loaded = await loadBoard(env, chatId);
    r = loaded.reminders.find((x) => x.id === r.id) || null;
  } else {
    r = await env.DB.prepare('SELECT * FROM reminders WHERE id = ?').bind(r.id).first();
  }
  if (!r) return;
  await updateDashboard(env, r.chat_id);
  await refreshEditor(env, cb, ctx, ref, r, tz, null, { onPin, loaded });
}

async function chorePickerMarkup(env, chatId, tz) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM reminders WHERE chat_id = ? ORDER BY display_num'
  ).bind(chatId).all();
  const rows = results.slice(0, 20).map((r) => [
    { text: `✏️ ${buttonText(r, tz)}`, callback_data: `m:item:${r.id}` },
  ]);
  if (results.length > 20) rows.push([{ text: '…use /list for the rest', callback_data: 'm:close' }]);
  rows.push([{ text: '✕ Close', callback_data: 'm:close' }]);
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
  // Not nagging yet but scheduled: doing it ahead of the nag still counts.
  else if (!r.paused && r.next_fire_at != null) rows.push([
    { text: '✅ Done early', callback_data: `m:done:${r.id}` },
    { text: '🤝 Together early', callback_data: `m:doneall:${r.id}` },
  ], [{ text: '👤 Done early by…', callback_data: `m:doneby:${r.id}` }]);
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

// The m: callback family: the picker and per-chore actions on the pinned board.
export async function handleManageCallback(env, cb) {
  const manage = (cb.data || '').match(/^m:(list|close)$/);
  const manageItem = (cb.data || '').match(/^m:(item|edit|pause|resume|skip|done|doneall|doneby|delete|confirm):(\d+)$/)
    || (cb.data || '').match(/^m:(doneas):(\d+):(\d+)$/);
  if (!manage && !manageItem) return answerCallback(env, cb.id, '');
  // The pin check and the chore are one round trip.
  const [pin, picked] = await env.DB.batch([
    env.DB.prepare('SELECT dashboard_msg_id FROM settings WHERE chat_id = ?').bind(cb.message.chat.id),
    ...(manageItem ? [env.DB.prepare('SELECT * FROM reminders WHERE id = ? AND chat_id = ?')
      .bind(+manageItem[2], cb.message.chat.id)] : []),
  ]);
  const board = (pin.results || [])[0];
  if (!board || board.dashboard_msg_id !== cb.message.message_id) {
    return answerCallback(env, cb.id, 'That dashboard is no longer active.');
  }
  if (manage) {
    if (manage[1] === 'close') {
      await editReplyMarkup(env, cb.message.chat.id, cb.message.message_id, dashboardButtons(env, cb.message.chat.id));
    } else {
      const listTz = await getTz(env, cb.message.chat.id);
      await renderManager(env, cb, await chorePickerMarkup(env, cb.message.chat.id, listTz));
    }
    return answerCallback(env, cb.id, '');
  }

  const action = manageItem[1];
  const r = (picked.results || [])[0] || null;
  if (!r) {
    await updateDashboard(env, cb.message.chat.id);
    return answerCallback(env, cb.id, 'That chore is already gone.');
  }
  const tz = await getTz(env, r.chat_id);
  if (action === 'item') {
    await renderManager(env, cb, await choreActionsMarkup(env, r, tz));
    return answerCallback(env, cb.id, '');
  }
  if (action === 'edit') {
    await renderManager(env, cb, await editorButtons(env, r));
    return answerCallback(env, cb.id, `Editing ${r.text}`);
  }
  if (action === 'doneby') {
    // Done early by a housemate who isn't holding the phone: one button per
    // other member, keyed by user_id like the editor's assignee picker.
    const others = (await householdMembers(env, r.chat_id)).filter((m) => m.userId !== cb.from.id);
    if (!others.length) return answerCallback(env, cb.id, 'Nobody else has been seen in this chat yet.');
    await renderManager(env, cb, { inline_keyboard: [
      ...others.map((m) => [{ text: clip(`👤 ${m.name}`), callback_data: `m:doneas:${r.id}:${m.userId}` }]),
      [{ text: '← Back', callback_data: `m:item:${r.id}` }],
    ] });
    return answerCallback(env, cb.id, `Who did ${r.text}?`);
  }
  if (action === 'delete') {
    // The confirm button says exactly what it will delete — the board's text
    // is unchanged and cannot be relied on to say which chore this is.
    await renderManager(env, cb, { inline_keyboard: [
      [{ text: clip(`🗑 Delete · ${r.text}`), callback_data: `m:confirm:${r.id}` }],
      [{ text: '← Back', callback_data: `m:item:${r.id}` }],
    ] });
    return answerCallback(env, cb.id, 'This removes the chore for everyone.');
  }
  if (action === 'confirm') {
    // The toast once the chore is gone; the cards, the log and the board follow.
    const trashId = await deleteReminder(env, r, null, null, {
      onClaim: () => answerCallback(env, cb.id, 'Deleted 🗑 — tap ↩️ Undo in the chat if that was a slip.'),
    });
    if (trashId == null) return answerCallback(env, cb.id, 'Already gone.');
    return;
  }

  if (action === 'pause' || action === 'resume') {
    await setReminderPaused(env, r, action === 'pause', tz, senderName(cb.from));
    return answerCallback(env, cb.id, action === 'pause' ? 'Paused ⏸️' : 'Resumed ▶️');
  }
  if (action === 'skip') {
    const next = await skipNext(env, r, tz);
    if (next === 'once') return answerCallback(env, cb.id, 'One-off chores cannot be skipped.');
    if (next == null) return answerCallback(env, cb.id, JUST_FIRED);
    return answerCallback(env, cb.id, `Skipped ⏭️ — next ${fmtWhen(next, tz)}`);
  }
  if (action === 'done' || action === 'doneall' || action === 'doneas') {
    let credit = senderName(cb.from);
    if (action === 'doneall') credit = creditTogether(credit, [...await householdRoster(env, r.chat_id)]);
    if (action === 'doneas') {
      const member = (await householdMembers(env, r.chat_id)).find((m) => String(m.userId) === manageItem[3]);
      if (!member) return answerCallback(env, cb.id, 'That household member is no longer here.');
      credit = member.name;
    }
    const toasts = {
      done: 'Purrs 😻', early: 'Done early 😻', raced: 'Already handled 👍',
      idle: 'This chore is not nagging now.',
    };
    // A won Done is answered as soon as it is won; the card and receipt follow.
    const outcome = await completeNow(env, r, credit, tz, { onClaim: (won) => answerCallback(env, cb.id, toasts[won]) });
    if (outcome === 'raced' || outcome === 'idle') return answerCallback(env, cb.id, toasts[outcome]);
    return;
  }
  return answerCallback(env, cb.id, '');
}
