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

export function sendMessage(env, chatId, html, replyMarkup, opts = {}) {
  const body = { chat_id: chatId, text: html, parse_mode: 'HTML' };
  if (replyMarkup) body.reply_markup = replyMarkup;
  if (opts.silent) body.disable_notification = true;
  return tg(env, 'sendMessage', body);
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
