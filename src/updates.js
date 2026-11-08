import { handleUpdate, chatAllowed } from './handlers.js';
import { isMember, rememberMemberStatement } from './household.js';
import { replyCtx, sendPrivate } from './tg.js';
import { deferBoards, flushBoards } from './dashboard.js';

const updateChat = (update) => update.message?.chat || update.callback_query?.message?.chat
  || update.message_reaction?.chat || update.chat_member?.chat;
const updateFrom = (update) => update.message?.from || update.callback_query?.from
  || update.message_reaction?.user;

// Whether this update lets the household's roster learn its sender, exactly
// as handleUpdate would: group traffic from a person, except the updates that
// are themselves about someone leaving or a membership change.
function learnsSender(env, update) {
  const chat = updateChat(update);
  const from = updateFrom(update);
  return Boolean(chatAllowed(env, chat?.id) && from && !from.is_bot
    && !update.message?.left_chat_member && !update.chat_member);
}

// The household boundary, before any update payload is stored. Rejected group
// traffic is logged here, since it stops before handleUpdate ever sees it: the
// usual cause is a group upgraded to a supergroup, whose new chat id
// ALLOWED_CHATS doesn't name yet, and this line is how `wrangler tail` shows
// it. DMs stay unlogged; a household member's DM is kept for its one-line
// pointer back to the group.
async function admitted(env, update) {
  const chat = updateChat(update);
  const from = updateFrom(update);
  if (chatAllowed(env, chat?.id)) return true;
  if (chat && chat.id < 0) console.log(`rejected chat ${chat.id} (${chat.type}) "${chat.title || ''}"`);
  return Boolean(chat && chat.id > 0 && from && !from.is_bot && await isMember(env, from.id));
}

// A delivery is durable before Telegram gets its ACK. Only a pending update
// may start; replayed and concurrent deliveries cannot repeat a mutation.
// Kept for deliveries stored this way before acceptUpdate, which recoverUpdates
// still starts.
export async function enqueueUpdate(env, update) {
  if (!await admitted(env, update)) return false;
  await env.DB.prepare(
    `INSERT INTO webhook_updates (update_id, payload, received_at) VALUES (?, ?, ?)
     ON CONFLICT(update_id) DO NOTHING`
  ).bind(update.update_id, JSON.stringify(update), Date.now()).run();
  return true;
}

// The webhook's one round trip before handling: the delivery is stored and
// claimed in a single D1 batch (a transaction), together with the sender's
// roster row. Storing and claiming used to be two round trips and the roster
// write a third, every one of them in front of every tap's toast. The pair is
// as safe as before: a batch that fails stores nothing and Telegram is told to
// retry, and a copy of an update already stored claims nothing. The roster
// write rides only on a claim, so a repeated delivery changes nothing at all.
// Returns 'rejected' (not ours, nothing stored), 'duplicate' or 'claimed'.
export async function acceptUpdate(env, update) {
  if (!await admitted(env, update)) return 'rejected';
  const now = Date.now();
  const statements = [
    env.DB.prepare(
      `INSERT INTO webhook_updates (update_id, payload, received_at, state, started_at)
       VALUES (?, ?, ?, 'processing', ?) ON CONFLICT(update_id) DO NOTHING`
    ).bind(update.update_id, JSON.stringify(update), now, now),
  ];
  const learn = learnsSender(env, update);
  if (learn) statements.push(rememberMemberStatement(env, updateChat(update).id, updateFrom(update), now, { gated: true }));
  try {
    const [claim] = await env.DB.batch(statements);
    return claim.meta.changes ? 'claimed' : 'duplicate';
  } catch (e) {
    // A batch can commit and still answer with an error (the answer was lost
    // on the way back). Telegram's retry would then find the update stored,
    // claim nothing, and drop it — a tap that did nothing, with no trace
    // (squashbot lost updates this way). So the row is asked about: if it
    // carries this very claim's stamp, the claim is ours and the update is
    // handled now; if there is no row, nothing committed and Telegram is told
    // to retry, as before. A row stamped by another delivery is a duplicate.
    console.log(`intake batch failed, checking whether it committed: ${e}`);
    const row = await env.DB.prepare(
      'SELECT state, started_at, received_at FROM webhook_updates WHERE update_id = ?'
    ).bind(update.update_id).first();
    if (!row) throw e;
    if (row.state === 'processing' && row.started_at === now && row.received_at === now) {
      return { result: 'claimed', memberRecorded: learn };
    }
    return 'duplicate';
  }
}

// Handles an update this delivery has claimed, and records how it ended. The
// pinned board is redrawn once, after the work (deferBoards), and whatever
// happened: a handler that failed half way may still have changed a chore.
export async function runClaimedUpdate(env, update, { memberRecorded = false } = {}) {
  const scoped = deferBoards(env);
  try {
    await handleUpdate(scoped, update, { memberRecorded });
  } catch (e) {
    await flushBoards(scoped);
    await env.DB.prepare(
      "UPDATE webhook_updates SET state = 'failed', finished_at = ? WHERE update_id = ? AND state = 'processing'"
    ).bind(Date.now(), update.update_id).run();
    throw e;
  }
  await Promise.all([
    flushBoards(scoped),
    env.DB.prepare(
      "UPDATE webhook_updates SET state = 'done', finished_at = ? WHERE update_id = ? AND state = 'processing'"
    ).bind(Date.now(), update.update_id).run(),
  ]);
}

export async function processUpdate(env, update) {
  const claim = await env.DB.prepare(
    "UPDATE webhook_updates SET state = 'processing', started_at = ? WHERE update_id = ? AND state = 'pending'"
  ).bind(Date.now(), update.update_id).run();
  if (!claim.meta.changes) return false;
  await runClaimedUpdate(env, update);
  return true;
}

// Runs every minute and usually finds nothing, so its two reads ride in the
// cron's due check (recoveryStatements; `found` is their answers) and the
// week-old cleanup in the daily retention window (pruneOldUpdates). An
// interrupted handler is one that started over 15 minutes ago, so nothing the
// first loop starts can be in it.
export function recoveryStatements(env, now) {
  return [
    env.DB.prepare(
      "SELECT payload FROM webhook_updates WHERE state = 'pending' AND received_at < ? ORDER BY received_at LIMIT 20"
    ).bind(now - 30000),
    env.DB.prepare(
      "SELECT update_id, payload FROM webhook_updates WHERE state = 'processing' AND started_at < ? LIMIT 20"
    ).bind(now - 15 * 60000),
  ];
}

export function pruneOldUpdatesStatement(env, now) {
  return env.DB.prepare(
    "DELETE FROM webhook_updates WHERE state IN ('done', 'failed') AND finished_at < ?"
  ).bind(now - 7 * 86400000);
}

export async function recoverUpdates(env, now, found = null) {
  const [pending, interrupted] = found || await env.DB.batch(recoveryStatements(env, now));
  if (!(pending.results || []).length && !(interrupted.results || []).length) return;
  for (const row of pending.results || []) {
    try { await processUpdate(env, JSON.parse(row.payload)); }
    catch (e) { console.log(`recover update failed: ${e.stack || e}`); }
  }
  // An interrupted handler may already have changed chores. Report it instead
  // of replaying a /delete, /done, or /chore with unknowable partial effects.
  for (const row of interrupted.results || []) {
    const claim = await env.DB.prepare(
      "UPDATE webhook_updates SET state = 'failed', finished_at = ? WHERE update_id = ? AND state = 'processing' AND started_at < ?"
    ).bind(now, row.update_id, now - 15 * 60000).run();
    if (!claim.meta.changes) continue;
    console.log(`update ${row.update_id} interrupted; retained for inspection, not replayed`);
    const update = JSON.parse(row.payload);
    const msg = update.message || update.callback_query?.message;
    const from = update.message?.from || update.callback_query?.from;
    const allowed = String(env.ALLOWED_CHATS || '').split(',').map((s) => s.trim());
    if (msg && from && allowed.includes(String(msg.chat.id))) {
      await sendPrivate(env, replyCtx(env, msg.chat.id, from.id),
        '⚠️ A previous request was interrupted. Check /list before trying it again; it may have partly completed.');
    }
  }
}
