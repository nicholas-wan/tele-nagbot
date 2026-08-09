// Thin Telegram Bot API client.

export async function tg(env, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN.trim()}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) console.log(`telegram ${method} failed: ${JSON.stringify(data)}`);
  return data;
}

export function sendMessage(env, chatId, html, replyMarkup) {
  const body = { chat_id: chatId, text: html, parse_mode: 'HTML' };
  if (replyMarkup) body.reply_markup = replyMarkup;
  return tg(env, 'sendMessage', body);
}

export function editMessage(env, chatId, messageId, html, replyMarkup) {
  const body = { chat_id: chatId, message_id: messageId, text: html, parse_mode: 'HTML' };
  if (replyMarkup) body.reply_markup = replyMarkup;
  return tg(env, 'editMessageText', body);
}

export function answerCallback(env, callbackId, text) {
  return tg(env, 'answerCallbackQuery', { callback_query_id: callbackId, text });
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
