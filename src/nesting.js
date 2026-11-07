// Nested chores: a chore can sit under another (reminders.parent_id), and
// doing the parent covers it. Washing the litter box empties the poop and
// levels the litter, so a wash done on time or early resets "clear poop" and
// "shake neakasa" too, and clearing the poop resets the shake.
//
// Covering a child does not complete it: no done row, no points, nothing on
// /stats. Its live nag, if any, is taken down as superseded (the same thing
// fireReminder does to a postponed nag its next occurrence overtakes), and an
// interval child restarts its gap from now, as a done-early would. A calendar
// child (weekly, monthly) keeps its slots; only a live nag goes. Paused and
// one-off children are left alone.
//
// What was changed is stashed in trash under the parent's firing id
// (`_cover`), so ↩️ Not done on the parent puts every child back: the old
// next_fire_at, and any nag that was taken down sent fresh. The trash is
// pruned after a day, which is also the undo window.

import { deleteMessage, esc } from './tg.js';
import { nextOccurrence, deferQuietHours } from './time.js';
import { deleteNag, nagChat, firingCard } from './nag.js';
import { redrawNag } from './chores.js';

// Every chore that sits under `parentId`, at any depth, in tier order. One
// read of the chat's nested chores, walked here: a query per tier used to put
// a D1 round trip per chore in the family in front of every Done's receipt.
export async function descendants(env, chatId, parentId) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM reminders WHERE chat_id = ? AND parent_id IS NOT NULL ORDER BY id'
  ).bind(chatId).all();
  return descendantsIn(results, parentId);
}

// The same walk over rows already in hand. The `seen` set guards against a
// cycle that slipped past the setter.
export function descendantsIn(reminders, parentId) {
  const kids = new Map();
  for (const r of [...reminders].sort((a, b) => a.id - b.id)) {
    if (r.parent_id == null) continue;
    if (!kids.has(r.parent_id)) kids.set(r.parent_id, []);
    kids.get(r.parent_id).push(r);
  }
  const out = [];
  const seen = new Set([parentId]);
  let level = [parentId];
  while (level.length) {
    const next = [];
    for (const id of level) {
      for (const r of kids.get(id) || []) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        out.push(r);
        next.push(r.id);
      }
    }
    level = next;
  }
  return out;
}

async function coverOne(env, r, now, tz) {
  if (r.paused || r.schedule_kind === 'once') return null;
  const { results: live } = await env.DB.prepare(
    "SELECT * FROM firings WHERE reminder_id = ? AND state = 'nagging'"
  ).bind(r.id).all();
  const removed = [];
  for (const f of live) {
    const gone = await env.DB.prepare("DELETE FROM firings WHERE id = ? AND state = 'nagging'").bind(f.id).run();
    if (!gone.meta.changes) continue;
    if (f.last_message_id) await deleteNag(env, f);
    if (f.last_sticker_id) await deleteMessage(env, nagChat(f), f.last_sticker_id);
    removed.push(f);
  }
  const detail = JSON.parse(r.schedule_detail);
  let after = null;
  if (r.schedule_kind === 'interval' && r.next_fire_at != null) {
    const restart = nextOccurrence('interval', detail, now, tz);
    // Never pulls a chore earlier: one already skipped or postponed past the
    // restart keeps its later slot.
    if (restart != null && restart > r.next_fire_at) {
      const moved = await env.DB.prepare('UPDATE reminders SET next_fire_at = ? WHERE id = ? AND next_fire_at = ?')
        .bind(restart, r.id, r.next_fire_at).run();
      if (moved.meta.changes) after = restart;
    }
  }
  if (!removed.length && after == null) return null;
  return { id: r.id, text: r.text, before: r.next_fire_at, after, firings: removed };
}

// Covers every chore under `parent` after its completion won. Returns the
// names of the chores it reset, for the receipt; [] when there are none.
// Never throws: the parent's Done has already been claimed, and a reset that
// failed must not leave that Done without its receipt.
export async function coverChildren(env, parent, parentFiringId, tz) {
  const covered = [];
  const now = Date.now();
  try {
    const children = await descendants(env, parent.chat_id, parent.id);
    for (const child of children) {
      const rec = await coverOne(env, child, now, tz);
      if (rec) covered.push(rec);
    }
  } catch (e) {
    console.log(`covering the chores under ${parent.id} failed: ${e.stack || e}`);
  }
  if (covered.length && parentFiringId) {
    try {
      await env.DB.prepare('INSERT INTO trash (chat_id, payload, created_at) VALUES (?, ?, ?)')
        .bind(parent.chat_id, JSON.stringify({ _cover: parentFiringId, at: now, children: covered }), now).run();
    } catch (e) {
      console.log(`stashing the reset under ${parent.id} failed: ${e.stack || e}`);
    }
  }
  return covered.map((c) => c.text);
}

// The names a parent's done reset, read back from its stash, for a receipt
// that is being redrawn (🤝 Together too).
export async function coveredNames(env, chatId, parentFiringId) {
  const row = await env.DB.prepare(
    "SELECT payload FROM trash WHERE chat_id = ? AND json_extract(payload, '$._cover') = ? ORDER BY id DESC LIMIT 1"
  ).bind(chatId, parentFiringId).first();
  return row ? JSON.parse(row.payload).children.map((c) => c.text) : [];
}

export function coverLine(names) {
  return names.length ? `\n↪️ Resets too: ${names.map(esc).join(', ')}` : '';
}

// Puts back what a parent's done changed, after ↩️ Not done on it won. Each
// step is a compare-and-swap on what cover wrote, so a child that fired,
// was edited or was done meanwhile keeps what happened to it since.
export async function uncoverChildren(env, chatId, parentFiringId, tz) {
  const row = await env.DB.prepare(
    "SELECT * FROM trash WHERE chat_id = ? AND json_extract(payload, '$._cover') = ? ORDER BY id DESC LIMIT 1"
  ).bind(chatId, parentFiringId).first();
  if (!row) return;
  const claim = await env.DB.prepare('DELETE FROM trash WHERE id = ?').bind(row.id).run();
  if (!claim.meta.changes) return;
  const now = Date.now();
  const stash = JSON.parse(row.payload);
  // The hours a nag spent taken down are given back: its 24h expiry counts
  // only the time it was actually on show.
  const hidden = Math.max(0, now - (stash.at ?? row.created_at));
  const settings = await env.DB.prepare('SELECT paused_until FROM settings WHERE chat_id = ?').bind(chatId).first();
  const vacation = Boolean(settings && settings.paused_until && settings.paused_until > now);
  for (const rec of stash.children) {
    if (rec.after != null) {
      await env.DB.prepare('UPDATE reminders SET next_fire_at = ? WHERE id = ? AND next_fire_at = ?')
        .bind(rec.before, rec.id, rec.after).run();
    }
    // Newest first, and at most one: a chore has one live nag.
    for (const f of [...rec.firings].sort((a, b) => b.id - a.id).slice(0, 1)) {
      const r = await env.DB.prepare('SELECT * FROM reminders WHERE id = ?').bind(rec.id).first();
      if (!r) continue;
      const intervals = JSON.parse(r.nag_intervals);
      const back = {
        ...f, state: 'nagging', last_message_id: null, last_message_ephemeral: 0, last_sticker_id: null,
        fired_at: f.fired_at + hidden,
        next_nag_at: f.next_nag_at > now ? f.next_nag_at : deferQuietHours(now + intervals[0] * 60000, tz),
      };
      // Put back only while the chore has no newer firing and no live one —
      // checked in the same statement, so a fire landing meanwhile wins.
      const cols = Object.keys(back);
      const put = await env.DB.prepare(
        `INSERT INTO firings (${cols.join(', ')}) SELECT ${cols.map(() => '?').join(', ')}
         WHERE NOT EXISTS (SELECT 1 FROM firings WHERE reminder_id = ? AND (id >= ? OR state = 'nagging'))`
      ).bind(...cols.map((c) => back[c]), rec.id, f.id).run();
      if (!put.meta.changes) continue;
      // A chore paused since, or a household on holiday, gets its nag back
      // without a card; resume or the next re-nag draws it.
      if (r.paused || vacation) continue;
      const [html, markup] = firingCard(r, back, tz, now);
      await redrawNag(env, back, html, markup);
    }
  }
}

// Which chores `r` may sit under: any other recurring chore in the chat that
// is not under `r` itself (that would be a loop).
export async function parentChoices(env, r) {
  if (r.schedule_kind === 'once') return [];
  const { results } = await env.DB.prepare('SELECT * FROM reminders WHERE chat_id = ?').bind(r.chat_id).all();
  return parentChoicesIn(results, r);
}

// The same choice over the chat's chores already in hand (the Mini App has
// them from the board), in the order the setter lists them.
export function parentChoicesIn(reminders, r) {
  if (r.schedule_kind === 'once') return [];
  const below = new Set(descendantsIn(reminders, r.id).map((c) => c.id));
  return reminders
    .filter((c) => c.id !== r.id && c.schedule_kind !== 'once' && !below.has(c.id))
    .sort((a, b) => (a.display_num ?? 0) - (b.display_num ?? 0) || a.id - b.id)
    .map((c) => ({ id: c.id, text: c.text }));
}

// Sets or clears the chore `r` sits under. Returns a refusal, or null.
export async function setParent(env, r, value) {
  const id = value === '' || value === '0' || value == null ? null : Number(value);
  if (id != null) {
    if (r.schedule_kind === 'once') return 'A one-off cannot sit under another chore.';
    const ok = (await parentChoices(env, r)).some((c) => c.id === id);
    if (!ok) return 'It cannot sit under that chore.';
  }
  await env.DB.prepare('UPDATE reminders SET parent_id = ? WHERE id = ?').bind(id, r.id).run();
  return null;
}
