import { handleUpdate, chatAllowed } from './handlers.js';
import { isMember } from './household.js';
import { replyCtx, sendPrivate } from './tg.js';

// A delivery is durable before Telegram gets its ACK. Only a pending update
// may start; replayed and concurrent deliveries cannot repeat a mutation.
export async function enqueueUpdate(env, update) {
  const chat = update.message?.chat || update.callback_query?.message?.chat
    || update.message_reaction?.chat || update.chat_member?.chat;
  const from = update.message?.from || update.callback_query?.from || update.message_reaction?.user;
  if (!chatAllowed(env, chat?.id)) {
    // Rejected group traffic is logged here, since it now stops before
    // handleUpdate ever sees it: the usual cause is a group upgraded to a
    // supergroup, whose new chat id ALLOWED_CHATS doesn't name yet, and this
    // line is how `wrangler tail` shows it. DMs stay unlogged.
    if (chat && chat.id < 0) console.log(`rejected chat ${chat.id} (${chat.type}) "${chat.title || ''}"`);
    // Preserve the household boundary before storing any update payload.
    if (!chat || chat.id < 0 || !from || from.is_bot || !await isMember(env, from.id)) return false;
  }
  await env.DB.prepare(
    `INSERT INTO webhook_updates (update_id, payload, received_at) VALUES (?, ?, ?)
     ON CONFLICT(update_id) DO NOTHING`
  ).bind(update.update_id, JSON.stringify(update), Date.now()).run();
  return true;
}

export async function processUpdate(env, update) {
  const claim = await env.DB.prepare(
    "UPDATE webhook_updates SET state = 'processing', started_at = ? WHERE update_id = ? AND state = 'pending'"
  ).bind(Date.now(), update.update_id).run();
  if (!claim.meta.changes) return false;
  try {
    await handleUpdate(env, update);
  } catch (e) {
    await env.DB.prepare(
      "UPDATE webhook_updates SET state = 'failed', finished_at = ? WHERE update_id = ? AND state = 'processing'"
    ).bind(Date.now(), update.update_id).run();
    throw e;
  }
  await env.DB.prepare(
    "UPDATE webhook_updates SET state = 'done', finished_at = ? WHERE update_id = ? AND state = 'processing'"
  ).bind(Date.now(), update.update_id).run();
  return true;
}

export async function recoverUpdates(env, now) {
  const pending = await env.DB.prepare(
    "SELECT payload FROM webhook_updates WHERE state = 'pending' AND received_at < ? ORDER BY received_at LIMIT 20"
  ).bind(now - 30000).all();
  for (const row of pending.results) {
    try { await processUpdate(env, JSON.parse(row.payload)); }
    catch (e) { console.log(`recover update failed: ${e.stack || e}`); }
  }
  // An interrupted handler may already have changed chores. Report it instead
  // of replaying a /delete, /done, or /chore with unknowable partial effects.
  const interrupted = await env.DB.prepare(
    "SELECT update_id, payload FROM webhook_updates WHERE state = 'processing' AND started_at < ? LIMIT 20"
  ).bind(now - 15 * 60000).all();
  for (const row of interrupted.results) {
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
  await env.DB.prepare(
    "DELETE FROM webhook_updates WHERE state IN ('done', 'failed') AND finished_at < ?"
  ).bind(now - 7 * 86400000).run();
}
