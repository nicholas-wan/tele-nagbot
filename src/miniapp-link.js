// A link that opens the Mini App over the chat. A group cannot carry a web_app
// button, but a plain URL button to the app's direct link can, and startapp
// tells the app which group it was opened from — the launch data Telegram
// signs does not. The sheet opens compact, half height, so the chat it came
// from stays in view.
// Null until MINI_APP_URL holds the link BotFather gave, and then the board
// keeps its ⚙️ Manage button instead.
export function miniAppLink(env, chatId) {
  if (!env.MINI_APP_URL) return null;
  let link;
  try {
    link = new URL(env.MINI_APP_URL);
  } catch {
    console.log(`MINI_APP_URL is not a URL: ${env.MINI_APP_URL}`);
    return null;
  }
  link.searchParams.set('startapp', `g${chatId}`);
  link.searchParams.set('mode', 'compact');
  return link.toString();
}
