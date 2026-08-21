// Chore management UI: the ⚙️ Manage flow that runs inside the pinned
// dashboard (picker → per-chore actions) and the ✏️ editor it opens, which
// also serves /edit as its own message. Handles the m: and e: callbacks.

import { editMessage, editReplyMarkup, answerCallback, deleteMessage, deleteEphemeral, esc } from './tg.js';
import { nextOccurrence, fmtLocal } from './time.js';
import { DEFAULT_NAGS } from './parse.js';
import { getTz, householdRoster, senderName, creditTogether } from './household.js';
import { completeFiring } from './nag.js';
import { updateDashboard, choreListHtml, buttonText, clip, describeSchedule, dashboardButtons } from './dashboard.js';
import { setReminderPaused, deleteReminder, completeEarly } from './chores.js';

export function editorText(r, tz) {
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

// The e: callback family: editor navigation and value taps.
export async function handleEditorCallback(env, cb, ctx, ref) {
  const editNav = (cb.data || '').match(/^e:(menu|time|schedule|nag|assign|rotate|score|pause|close):(\d+)$/);
  const editSet = (cb.data || '').match(/^e:set(time|schedule|nag|assign):(\d+):([a-z0-9]+)$/);
  if (!editNav && !editSet) return answerCallback(env, cb.id, '');
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
  // Not nagging yet but scheduled: doing it ahead of the nag still counts.
  else if (!r.paused && r.next_fire_at != null) rows.push([
    { text: '✅ Done early', callback_data: `m:done:${r.id}` },
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

// The m: callback family: the picker and per-chore actions on the pinned board.
export async function handleManageCallback(env, cb) {
  const manage = (cb.data || '').match(/^m:(list|close)$/);
  const manageItem = (cb.data || '').match(/^m:(item|edit|pause|resume|skip|done|doneall|delete|confirm):(\d+)$/);
  if (!manage && !manageItem) return answerCallback(env, cb.id, '');
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
    let credit = senderName(cb.from);
    if (action === 'doneall') credit = creditTogether(credit, [...await householdRoster(env, r.chat_id)]);
    if (!firing) {
      if (r.paused || r.next_fire_at == null) {
        return answerCallback(env, cb.id, 'This chore is not nagging now.');
      }
      const early = await completeEarly(env, r, credit, tz);
      return answerCallback(env, cb.id, early ? 'Done early 😻' : 'Already handled 👍');
    }
    const won = await completeFiring(env, firing, r, credit, tz);
    return answerCallback(env, cb.id, won ? 'Purrs 😻' : 'Already handled 👍');
  }
  return answerCallback(env, cb.id, '');
}
