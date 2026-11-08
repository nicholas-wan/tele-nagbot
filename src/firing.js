// Fires one reminder: expires any stale nag, sends sticker + nag message,
// schedules the next occurrence. Used by the cron loop and by /remind ... now.

import { sendMessage, sendPrivate, replyCtx, msgRef, deleteMessage, drainSweepStatements } from './tg.js';
import { advanceOccurrence, deferQuietHours, weekStart } from './time.js';
import { isScored, householdNamesFrom, canonName, CREDIT_SEP } from './household.js';
import { nagButtons, nagHtml, deleteNag, deleteNagRef, nagChat } from './nag.js';
import { updateDashboard } from './dashboard.js';
import { sendRandomSticker } from './stickers.js';

// How long a one-off's fire claim holds before an unfinished fire retries.
const ONCE_LEASE_MS = 5 * 60000;

export async function fireReminder(env, r, now, tz) {
  // Claim the occurrence atomically (advance next_fire_at) before any sends:
  // an overlapping cron tick or "/remind ... now" racing the cron loses the
  // compare-and-swap. Recurring kinds advance to their next slot, so a crash
  // mid-fire drops one nag but keeps the schedule. A one-off has no next slot
  // to fall back on — NULLing at claim would kill it permanently — so it
  // takes a short lease instead, and only a completed fire finalizes to NULL.
  const detail = JSON.parse(r.schedule_detail);
  const next = advanceOccurrence(r.schedule_kind, detail, r.next_fire_at, now, tz);
  const claimTo = next != null ? next : now + ONCE_LEASE_MS;
  const release = () => env.DB.prepare(
    'UPDATE reminders SET next_fire_at = ? WHERE id = ? AND next_fire_at = ?'
  ).bind(r.next_fire_at, r.id, claimTo).run();

  // A fire is three round trips: the claim with everything the fire reads
  // (the previous nag, the roster that resolves the assignee, the rotation's
  // tally), then the writes that make the new nag, then — after Telegram —
  // the card's ids, a one-off's release and the sweep records, together. It
  // used to be eight or nine one after another.
  // A claim batch that fails is not released: a racing fire of the same
  // occurrence claims the same value, so a swap back could undo *its* claim
  // and fire the occurrence twice. If this one committed before its answer was
  // lost, a one-off's lease runs out and it fires again; a recurring chore
  // drops that one nag, as a crash mid-fire always did.
  const [claim, stale, members, tally] = await env.DB.batch([
    env.DB.prepare('UPDATE reminders SET next_fire_at = ? WHERE id = ? AND next_fire_at = ?')
      .bind(claimTo, r.id, r.next_fire_at),
    env.DB.prepare("SELECT * FROM firings WHERE reminder_id = ? AND state = 'nagging'").bind(r.id),
    env.DB.prepare('SELECT user_id, username, first_name, last_seen FROM members WHERE chat_id = ?').bind(r.chat_id),
    ...(detail.rotate ? [rotationStatement(env, r.chat_id, tz)] : []),
  ]);
  if (!claim.meta.changes) return;
  const roster = members.results || [];

  // Everything from the claim to the firing row existing is the danger zone: a
  // throw in here advances the schedule with no nag to show for it, and the
  // occurrence is silently gone until the next slot — "cut nails" lost its
  // 14 Aug 17:00 this way, leaving no firing row and no trace of the cause.
  // Releasing the claim on failure lets the next cron tick simply try again.
  // The rotation pick and the stale-nag sweep are inside it too: both are
  // safe to repeat on the retry.
  let firingId;
  let superseded = [];
  try {
    const writes = [];
    // Rotation: this occurrence goes to whoever has the fewest ✅ this week.
    if (detail.rotate) {
      const who = rotationFrom(roster, tally.results || []);
      if (who) {
        writes.push(env.DB.prepare('UPDATE reminders SET assignee_name = ?, assignee_user_id = NULL WHERE id = ?')
          .bind(who, r.id));
        r.assignee_name = who;
        r.assignee_user_id = null;
      }
    }

    // A previous occurrence still nagging when the next one fires gets
    // quietly expired so only one live nag exists per reminder — unless it was
    // deliberately postponed. "📅 Tomorrow" carries fired_at forward, so a
    // still-nagging firing dated in the future is one the household moved past
    // this very occurrence; the nag it asked for is arriving right now. That is
    // superseded, not failed, so the row is removed outright instead of being
    // expired into /stats as "expired unclaimed". Each is claimed the usual
    // way (a Done landing mid-sweep wins and keeps its receipt), and read back
    // after, so the card that comes down is the one it holds now.
    const staleRows = stale.results || [];
    const staleAt = writes.length;
    for (const f of staleRows) {
      writes.push(f.fired_at <= now
        ? env.DB.prepare(
          "UPDATE firings SET state = 'expired', next_nag_at = NULL WHERE id = ? AND state = 'nagging' AND fired_at = ?"
        ).bind(f.id, f.fired_at)
        : env.DB.prepare("DELETE FROM firings WHERE id = ? AND state = 'nagging'").bind(f.id));
    }
    const intervals = JSON.parse(r.nag_intervals);
    const insertAt = writes.length;
    writes.push(env.DB.prepare(
      'INSERT INTO firings (reminder_id, chat_id, reminder_text, fired_at, next_nag_at, scored) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(r.id, r.chat_id, r.text, now, deferQuietHours(now + intervals[0] * 60000, tz),
      r.scored != null ? r.scored : 1));
    if (staleRows.length) {
      writes.push(env.DB.prepare(
        `SELECT * FROM firings WHERE id IN (${staleRows.map(() => '?').join(',')})`
      ).bind(...staleRows.map((f) => f.id)));
    }
    const out = await env.DB.batch(writes);
    firingId = out[insertAt].meta.last_row_id;
    const now2 = new Map(((staleRows.length ? out[out.length - 1].results : null) || []).map((f) => [f.id, f]));
    superseded = staleRows.filter((f, i) => out[staleAt + i].meta.changes).map((f) => now2.get(f.id) || f);
  } catch (e) {
    console.log(`fire for reminder ${r.id} failed before the nag existed, releasing claim: ${e.stack || e}`);
    await release();
    throw e;
  }

  // The superseded nag's card and sticker come down while the new one goes out.
  const cleanup = Promise.all(superseded.flatMap((f) => [
    f.last_message_id ? deleteNag(env, f) : null,
    f.last_sticker_id ? deleteMessage(env, nagChat(f), f.last_sticker_id) : null,
  ]));

  // An assigned chore nags only the person it is for: the message lives in the
  // group but Telegram shows it to that member alone. Unassigned chores are
  // everyone's problem and stay public.
  const who = assigneeUserIdFrom(r, roster);
  let sent = null;
  let ref = null;
  let s = { messageId: null, cat: 'both' };
  if (who) {
    const ctx = replyCtx(env, r.chat_id, who);
    // A sticker cannot be sent ephemerally, and a visible sticker beside an
    // invisible nag would announce the chore it is trying to keep private.
    sent = await sendPrivate(env, ctx, nagHtml(r, 0, 'both'), nagButtons(firingId, isScored(r)));
    ref = msgRef(sent);
  }
  // A private send that timed out may well have arrived; going public then
  // could hand the group the chore its nag was keeping private. The firing
  // stays with no card, and the next re-nag sends one.
  if (!ref && !(sent && sent.timedOut)) {
    s = await sendRandomSticker(env, r.chat_id, firingId);
    sent = await sendMessage(env, r.chat_id, nagHtml(r, 0, s.cat), nagButtons(firingId, isScored(r)));
    ref = msgRef(sent);
  }
  await cleanup;
  // The row was inserted with no message; only a still-nagging row with none
  // takes this one. A Done (from /done <chore>, or a reply) that landed in the
  // few ms since the insert has already ended the firing — its receipt was
  // drawn on no card, so the card just sent would stay live forever.
  // Fire completed: a one-off releases its lease and goes dormant, in the same
  // batch. If the lease expired mid-fire and a retry re-fired, the stale sweep
  // above has already replaced the earlier nag.
  const records = drainSweepStatements(env);
  let upd;
  try {
    [upd] = await env.DB.batch([
      env.DB.prepare(
        `UPDATE firings SET last_message_id = ?, last_message_ephemeral = ?, last_sticker_id = ?,
           cat = ?, nag_user_id = ? WHERE id = ? AND state = 'nagging' AND last_message_id IS NULL
           AND nag_user_id IS NULL`
      ).bind(ref ? ref.id : null, ref && ref.ephemeral ? 1 : 0, s.messageId, s.cat,
        ref && ref.ephemeral ? who : null, firingId),
      ...(next == null ? [env.DB.prepare(
        'UPDATE reminders SET next_fire_at = NULL WHERE id = ? AND next_fire_at = ?'
      ).bind(r.id, claimTo)] : []),
      ...records.statements,
    ]);
  } catch (e) {
    // The scope's other records go back on the queue for flushBoards.
    records.restore();
    throw e;
  }
  if (!upd.meta.changes) {
    const orphan = { chat_id: r.chat_id, nag_chat_id: null, nag_user_id: ref && ref.ephemeral ? who : null };
    await Promise.all([
      ref ? deleteNagRef(env, orphan, ref) : null,
      s.messageId ? deleteMessage(env, r.chat_id, s.messageId) : null,
    ]);
  }

  await updateDashboard(env, r.chat_id);
}

// The assignee's numeric id, which is what an ephemeral send addresses.
// Assignment stores a display name (the editor deliberately nulls the id), so
// the name is resolved back through members — the rows the claim's batch
// read. No dm_ok gate any more: the nag stays in the group, so the member
// never has to open a private chat first.
function assigneeUserIdFrom(r, roster) {
  if (!r.assignee_name && !r.assignee_user_id) return null;
  if (r.assignee_user_id) return r.assignee_user_id;
  // Stored names come from senderName: "@handle" for a member who has a
  // Telegram username, their plain first name for one who has not. So match
  // the column the name actually came from, fall back to username, and let the
  // most recently seen member win when a first name is shared.
  //
  // The comparison happens here rather than in SQL because D1 is plain SQLite,
  // whose lower() is ASCII-only: lower('Élodie') is still 'Élodie', which never
  // equalled the JS-lowercased name, so an accented member went unresolved and
  // their nag went public with a sticker beside it — the one thing an assigned
  // chore must never do. One pass over the chat's members covers both columns.
  const name = String(r.assignee_name).trim();
  const bare = name.replace(/^@/, '').toLowerCase();
  const rows = [...(roster || [])].sort((a, b) => (b.last_seen || 0) - (a.last_seen || 0));
  const match = (col) => rows.find((m) => String(m[col] || '').trim().toLowerCase() === bare);
  const row = name.startsWith('@')
    ? match('username')
    : match('first_name') || match('username');
  return row ? row.user_id : null;
}

// Household members = the chat's roster, so someone who has never tapped Done
// still takes a turn at 0/0. Least ✅ this week wins the chore; ties go to the
// lower all-time count, then to the name. Combined credits ("nick & jane" from
// done-together) count for each person — but only for people still on the
// roster, so a mistyped "done with brian" cannot draw a rotation for a
// housemate who does not exist.
//
// Every completion counts here, points or not: fairness is about who did the
// work. Counting only scored ones left a rotating /remind chore at 0/0 for
// everyone, so the alphabetical tiebreak handed every occurrence to the same
// person. The leaderboard keeps its own scored filter in stats.js.
//
// The tally is counted in SQL, one row per distinct credit, rather than every
// done row of the last six months coming back to be counted here.
function rotationStatement(env, chatId, tz) {
  return env.DB.prepare(
    `SELECT done_by, COUNT(*) AS total, SUM(CASE WHEN done_at > ? THEN 1 ELSE 0 END) AS week
     FROM firings WHERE chat_id = ? AND state = 'done' AND done_by IS NOT NULL GROUP BY done_by`
  ).bind(weekStart(Date.now(), tz), chatId);
}

function rotationFrom(memberRows, tally) {
  const { roster, aliases } = householdNamesFrom(memberRows);
  if (!roster.size) return null;
  const stats = new Map();
  for (const name of roster) stats.set(name, { week: 0, total: 0 });
  for (const row of tally || []) {
    for (const p of String(row.done_by).split(CREDIT_SEP)) {
      if (!p.trim()) continue;
      // "jane" credited by hand is the roster's "@jane" (or "@janedoe" by first
      // name); an ambiguous spelling counts for nobody, and anyone else is a ghost.
      const s = stats.get(canonName(roster, p.trim(), aliases));
      if (!s) continue;
      s.total += Number(row.total) || 0;
      s.week += Number(row.week) || 0;
    }
  }
  const sorted = [...stats.entries()].sort((a, b) =>
    a[1].week - b[1].week || a[1].total - b[1].total || a[0].localeCompare(b[0]));
  return sorted[0][0];
}
