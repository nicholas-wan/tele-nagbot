// Thin Telegram Bot API client.

export async function tg(env, method, body) {
  for (let attempt = 0; ; attempt++) {
    let data;
    try {
      const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN.trim()}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      // Telegram 5xx pages are HTML; degrade to {ok:false} instead of throwing.
      data = await res.json();
    } catch (e) {
      console.log(`telegram ${method} failed: ${e}`);
      return { ok: false, description: String(e) };
    }
    if (data.ok) return data;
    // Rate limited: honor retry_after once (capped, to fit Worker limits).
    if (data.error_code === 429 && attempt === 0) {
      const wait = Math.min((data.parameters && data.parameters.retry_after) || 1, 5);
      await new Promise((resolve) => setTimeout(resolve, wait * 1000));
      continue;
    }
    console.log(`telegram ${method} failed: ${JSON.stringify(data)}`);
    return data;
  }
}

// Telegram caps messages at 4096 chars; split on line boundaries (every
// message here is line-oriented HTML with no tags spanning lines).
const TG_MAX = 4096;
export async function sendLong(env, chatId, html, opts = {}) {
  if (html.length <= TG_MAX) return sendMessage(env, chatId, html, null, opts);
  let last;
  let chunk = '';
  for (let line of html.split('\n')) {
    while (line.length > TG_MAX) { // absurdly long single line: hard split
      last = await sendMessage(env, chatId, line.slice(0, TG_MAX), null, opts);
      line = line.slice(TG_MAX);
    }
    if (chunk && chunk.length + 1 + line.length > TG_MAX) {
      last = await sendMessage(env, chatId, chunk, null, opts);
      chunk = '';
    }
    chunk = chunk ? `${chunk}\n${line}` : line;
  }
  if (chunk) last = await sendMessage(env, chatId, chunk, null, opts);
  return last;
}

// Anything the bot says that carries no controls of its own gets a single OK,
// so the group can be cleared without hunting for a delete option. Messages
// with their own keyboard — the pinned board, nags, the wizard — keep theirs.
// opts.noOk opts out for the rare message that must not be dismissable.
const OK_ROW = { inline_keyboard: [[{ text: '✅ OK', callback_data: 'ok' }]] };
const withOk = (replyMarkup, opts) => replyMarkup || (opts.noOk ? null : OK_ROW);

// Everything the bot sends is tidied away after a day; only the pinned
// dashboard is kept (opts.keep). Telegram cannot list a bot's own messages,
// so each one is recorded at send time and a cron sweep deletes what is due.
// OK just gets there sooner; the sweep is the backstop nobody has to tap.
const SENT_TTL_MS = 86400000;
export async function recordSentMessage(env, chatId, res, { receiverUserId = null } = {}) {
  if (!env.DB || !res || !res.ok || !res.result) return res;
  const r = res.result;
  const ephemeral = Boolean(r.ephemeral_message_id);
  const id = ephemeral ? r.ephemeral_message_id : r.message_id;
  if (!id) return res;
  try {
    await env.DB.prepare(
      `INSERT INTO sent_messages (chat_id, receiver_user_id, message_id, is_ephemeral, delete_after, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(chatId, ephemeral ? receiverUserId : null, id, ephemeral ? 1 : 0,
      Date.now() + SENT_TTL_MS, Date.now()).run();
  } catch (e) {
    // A message that outlives its day is a nuisance, not a failure.
    console.log(`recordSentMessage failed: ${e}`);
  }
  return res;
}

export async function sendMessage(env, chatId, html, replyMarkup, opts = {}) {
  const body = { chat_id: chatId, text: html, parse_mode: 'HTML' };
  const markup = withOk(replyMarkup, opts);
  if (markup) body.reply_markup = markup;
  if (opts.silent) body.disable_notification = true;
  const res = await tg(env, 'sendMessage', body);
  if (!opts.keep) await recordSentMessage(env, chatId, res);
  return res;
}

export function deleteMessage(env, chatId, messageId) {
  return tg(env, 'deleteMessage', { chat_id: chatId, message_id: messageId });
}

export function editReplyMarkup(env, chatId, messageId, replyMarkup) {
  return tg(env, 'editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: replyMarkup });
}

export function editMessage(env, chatId, messageId, html, replyMarkup) {
  const body = { chat_id: chatId, message_id: messageId, text: html, parse_mode: 'HTML' };
  if (replyMarkup) body.reply_markup = replyMarkup;
  return tg(env, 'editMessageText', body);
}

export function answerCallback(env, callbackId, text) {
  return tg(env, 'answerCallbackQuery', { callback_query_id: callbackId, text });
}

// ---------------------------------------------------------------------------
// Ephemeral messages (Bot API 10.2, July 2026)
//
// An ephemeral message lives in the group but is visible only to one member.
// Telegram needs receiver_user_id to address it, and for 15 seconds after a
// button tap the callback_query_id is what authorizes reaching a user the bot
// has no other recent contact with. The bot must be a group administrator, and
// even then Telegram does not promise delivery to an offline user — so every
// private send falls back to a public one rather than dropping the reply.
//
// Ephemeral messages carry message_id 0 and a separate ephemeral_message_id,
// and they need their own edit/delete methods. A "ref" here is the pair
// { id, ephemeral } that says which id space a stored message id belongs to.
// ---------------------------------------------------------------------------

const CALLBACK_WINDOW_MS = 15000;

// Per-update context describing who a private reply is for. Built once in
// handleUpdate and threaded down; never module-level, because one Worker
// isolate serves concurrent updates from different users.
export function replyCtx(env, chatId, userId, opts = {}) {
  return {
    chatId,
    userId: userId || null,
    callbackQueryId: opts.callbackQueryId || null,
    replyEphemeralId: opts.replyEphemeralId || null,
    // EPHEMERAL=0 is the kill switch: one deploy reverts to all-public.
    ephemeral: String(env.EPHEMERAL ?? '1') !== '0' && Boolean(userId),
    at: Date.now(),
  };
}

// The callback id authorizes exactly one send, and only inside the window.
function takeCallbackId(ctx) {
  if (!ctx.callbackQueryId || Date.now() - ctx.at > CALLBACK_WINDOW_MS) return null;
  const id = ctx.callbackQueryId;
  ctx.callbackQueryId = null;
  return id;
}

// Where an outgoing message ended up, in whichever id space applies.
export function msgRef(res) {
  if (!res || !res.ok || !res.result) return null;
  const r = res.result;
  // Checked first: ephemeral results also carry message_id, always 0.
  if (r.ephemeral_message_id) return { id: r.ephemeral_message_id, ephemeral: true };
  return r.message_id ? { id: r.message_id, ephemeral: false } : null;
}

export async function sendPrivate(env, ctx, html, replyMarkup, opts = {}) {
  if (!ctx.ephemeral) return sendMessage(env, ctx.chatId, html, replyMarkup, opts);
  const body = {
    chat_id: ctx.chatId,
    receiver_user_id: ctx.userId,
    text: html,
    parse_mode: 'HTML',
  };
  const markup = withOk(replyMarkup, opts);
  if (markup) body.reply_markup = markup;
  if (opts.silent) body.disable_notification = true;
  const cbId = takeCallbackId(ctx);
  if (cbId) body.callback_query_id = cbId;
  if (ctx.replyEphemeralId) body.reply_parameters = { ephemeral_message_id: ctx.replyEphemeralId };
  const res = await tg(env, 'sendMessage', body);
  if (res.ok) return recordSentMessage(env, ctx.chatId, res, { receiverUserId: ctx.userId });
  console.log(`ephemeral send failed, falling back to public: ${res.description || ''}`);
  return sendMessage(env, ctx.chatId, html, replyMarkup, opts);
}

export function editEphemeral(env, ctx, ephemeralId, html, replyMarkup) {
  const body = {
    chat_id: ctx.chatId,
    receiver_user_id: ctx.userId,
    ephemeral_message_id: ephemeralId,
    text: html,
    parse_mode: 'HTML',
  };
  if (replyMarkup) body.reply_markup = replyMarkup;
  return tg(env, 'editEphemeralMessageText', body);
}

export function deleteEphemeral(env, ctx, ephemeralId) {
  return tg(env, 'deleteEphemeralMessage', {
    chat_id: ctx.chatId,
    receiver_user_id: ctx.userId,
    ephemeral_message_id: ephemeralId,
  });
}

// Edit/delete a stored message without the caller caring which kind it is.
export function editRef(env, ctx, chatId, ref, html, replyMarkup) {
  if (!ref) return Promise.resolve({ ok: false, description: 'no message ref' });
  if (ref.ephemeral) return editEphemeral(env, ctx, ref.id, html, replyMarkup);
  return editMessage(env, chatId, ref.id, html, replyMarkup);
}

export function deleteRef(env, ctx, chatId, ref) {
  if (!ref) return Promise.resolve({ ok: false, description: 'no message ref' });
  if (ref.ephemeral) return deleteEphemeral(env, ctx, ref.id);
  return deleteMessage(env, chatId, ref.id);
}

// The id of the message a callback came from, in its own id space.
export function callbackRef(cb) {
  if (!cb || !cb.message) return null;
  if (cb.message.ephemeral_message_id) {
    return { id: cb.message.ephemeral_message_id, ephemeral: true };
  }
  return cb.message.message_id ? { id: cb.message.message_id, ephemeral: false } : null;
}

// Pinning needs the bot to be a group admin with "Pin messages"; both calls
// fail quietly (logged) without it.
export function pinMessage(env, chatId, messageId) {
  return tg(env, 'pinChatMessage', { chat_id: chatId, message_id: messageId, disable_notification: true });
}

export function unpinMessage(env, chatId, messageId) {
  return tg(env, 'unpinChatMessage', { chat_id: chatId, message_id: messageId });
}

export function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Renders the assignee as a tapping mention. Users with a public @username get
// the plain @username (Telegram auto-links it); users without one get an
// inline text mention via tg://user, which requires their numeric id.
export function mentionHtml(name, userId) {
  if (userId) return `<a href="tg://user?id=${userId}">${esc(name)}</a>`;
  return esc(name);
}
