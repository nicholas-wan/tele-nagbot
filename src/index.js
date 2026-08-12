// Cloudflare Worker entry point.
//  - fetch: Telegram webhook (validated with the secret token header)
//  - scheduled: every-minute cron that fires reminders and re-nags

import { handleUpdate, updateDashboard } from './handlers.js';
import { runCron } from './cron.js';
import { listTags } from './stickers.js';
import { tg } from './tg.js';

function adminAuthorized(request, env) {
  if (!env.ADMIN_SECRET) return false;
  return request.headers.get('Authorization') === `Bearer ${env.ADMIN_SECRET}`;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/webhook') {
      if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) {
        return new Response('forbidden', { status: 403 });
      }
      let update;
      try {
        update = await request.json();
      } catch {
        return new Response('bad request', { status: 400 });
      }
      // Always 200 so Telegram doesn't retry a poison update forever.
      ctx.waitUntil(handleUpdate(env, update).catch((e) => console.log(`update failed: ${e.stack || e}`)));
      return new Response('ok');
    }
    // One-time helper: POST /setup with ADMIN_SECRET as a bearer token makes
    // the Worker register its own webhook with Telegram. WEBHOOK_SECRET is
    // reserved exclusively for Telegram's webhook-authentication header.
    if (url.pathname === '/setup') {
      if (request.method !== 'POST') {
        return new Response('method not allowed', { status: 405, headers: { Allow: 'POST' } });
      }
      if (!adminAuthorized(request, env)) {
        return new Response('forbidden', { status: 403 });
      }
      if (!env.BOT_TOKEN) {
        return new Response('BOT_TOKEN secret is not set — run: npx wrangler secret put BOT_TOKEN', { status: 500 });
      }
      const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN.trim()}/setWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: `${url.origin}/webhook`,
          secret_token: env.WEBHOOK_SECRET,
          // message_reaction needs the bot to be a group admin (it is, for pins).
          allowed_updates: ['message', 'callback_query', 'message_reaction'],
        }),
      });
      const data = await res.json();
      // Register the "/" autocomplete menu while we're at it.
      // Registered under both scopes: the default one covers DMs, and the
      // explicit group scope is the one that matters here, since an ephemeral
      // command only means anything in a chat with other people in it.
      // Telegram stores is_ephemeral under either, verified via getMyCommands.
      const commandScopes = [undefined, { type: 'all_group_chats' }];
      let cmdData = { ok: true };
      for (const scope of commandScopes) {
      const cmdRes = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN.trim()}/setMyCommands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Only entry points that nothing can tap its way to. Anything acting
        // on an existing chore — done, edit, delete, pause, resume, skip — is
        // a button on the nag or the dashboard item menu, and the sticker
        // commands are one-time setup. All stay typeable, just out of the menu.
        //
        // is_ephemeral means the command itself is invisible to the group: only
        // the sender and the bot see it, and the reply is private too. The
        // pinned dashboard and the nags stay public.
        body: JSON.stringify({
          commands: [
            { command: 'chore', description: 'New chore — counts on the leaderboard', is_ephemeral: true },
            { command: 'remind', description: 'Plain reminder — no points', is_ephemeral: true },
            { command: 'list', description: 'Active chores and reminders', is_ephemeral: true },
            { command: 'stats', description: 'Weekly leaderboard — add "all" for history', is_ephemeral: true },
            { command: 'help', description: 'Quick guide and more options', is_ephemeral: true },
          ],
          ...(scope ? { scope } : {}),
        }),
      });
        const res2 = await cmdRes.json();
        if (!res2.ok) cmdData = res2;
      }
      return new Response(
        data.ok ? `✅ Webhook registered. Command menu: ${cmdData.ok ? 'registered' : `failed ${JSON.stringify(cmdData)}`}. The bot is fully live.`
                : `Telegram said: ${JSON.stringify(data)}`,
        { status: data.ok ? 200 : 500 }
      );
    }
    // Admin helper: POST /admin?name=...&desc=...&short=... with ADMIN_SECRET
    // as a bearer token updates the bot profile via its own token.
    if (url.pathname === '/admin') {
      if (request.method !== 'POST') {
        return new Response('method not allowed', { status: 405, headers: { Allow: 'POST' } });
      }
      if (!adminAuthorized(request, env)) {
        return new Response('forbidden', { status: 403 });
      }
      if (!env.BOT_TOKEN) {
        return new Response('BOT_TOKEN secret is not set', { status: 500 });
      }
      const token = env.BOT_TOKEN.trim();
      // Tag inspection: &stickers&chat=<id> lists tags; &stickerimg=N&chat=<id>
      // proxies the Nth sticker image for review.
      const chatParam = url.searchParams.get('chat');
      if (url.searchParams.get('stickers') !== null && chatParam) {
        const res = await listTags(env, +chatParam);
        return new Response(JSON.stringify(res, null, 2), { status: 200 });
      }
      const imgN = url.searchParams.get('stickerimg');
      if (imgN && chatParam) {
        const res = await listTags(env, +chatParam);
        if (!res.ok) return new Response('no pack', { status: 404 });
        const e = res.entries.find((x) => x.pos === +imgN);
        if (!e) return new Response('no such sticker', { status: 404 });
        const f = await tg(env, 'getFile', { file_id: e.fileId });
        if (!f.ok) return new Response('getFile failed', { status: 500 });
        const img = await fetch(`https://api.telegram.org/file/bot${token}/${f.result.file_path}`);
        return new Response(img.body, {
          status: 200,
          headers: { 'Content-Type': 'image/webp' },
        });
      }
      if (url.searchParams.get('info') !== null) {
        const res = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
        const cmds = await fetch(`https://api.telegram.org/bot${token}/getMyCommands`);
        const groupCmds = await fetch(`https://api.telegram.org/bot${token}/getMyCommands`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scope: { type: 'all_group_chats' } }),
        });
        return new Response(JSON.stringify({
          webhook: await res.json(),
          commands_default: await cmds.json(),
          commands_groups: await groupCmds.json(),
        }, null, 2), { status: 200 });
      }
      // Diagnosis helper: is the bot still in the chat, did the chat migrate to
      // a supergroup (new id — ALLOWED_CHATS would then silently drop it), and
      // is privacy mode hiding group messages? Defaults to the first allowed chat.
      // Rebuild and re-pin the dashboard for every allowed chat. Recovery path
      // for a lost pin — a group upgrade drops it, and nothing else repins
      // until the next chore change or the morning refresh.
      if (url.searchParams.get('board') !== null) {
        const out = [];
        const me = await fetch(`https://api.telegram.org/bot${token}/getMe`).then((r) => r.json());
        const meId = me.ok ? me.result.id : null;
        for (const id of String(env.ALLOWED_CHATS || '').split(',').map((s) => s.trim()).filter(Boolean)) {
          const chatId = +id;
          await updateDashboard(env, chatId);
          const row = await env.DB.prepare('SELECT dashboard_msg_id FROM settings WHERE chat_id = ?')
            .bind(chatId).first();
          const current = row && row.dashboard_msg_id;
          // Retire boards the bot pinned earlier and lost track of — a group
          // upgrade orphans them and they look identical to the live one.
          // getChat only ever reports the TOP of the pin stack, so walk down by
          // unpinning each bot-authored pin in turn (including the live board,
          // re-pinned at the end) and stop at the first pin a human made.
          const call = (method, body) => fetch(`https://api.telegram.org/bot${token}/${method}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }).then((r) => r.json());
          let removed = 0;
          const seen = new Set();
          for (let i = 0; i < 12; i++) {
            const chat = await call('getChat', { chat_id: chatId });
            const pin = chat.ok && chat.result.pinned_message;
            if (!pin || seen.has(pin.message_id)) break;
            if (!meId || !pin.from || pin.from.id !== meId) break; // a human pinned this — leave it
            seen.add(pin.message_id);
            await call('unpinChatMessage', { chat_id: chatId, message_id: pin.message_id });
            if (pin.message_id !== current) {
              await call('deleteMessage', { chat_id: chatId, message_id: pin.message_id });
              removed++;
            }
          }
          if (current) {
            await call('pinChatMessage', {
              chat_id: chatId, message_id: current, disable_notification: true,
            });
          }
          out.push(`${chatId}: dashboard_msg_id=${current || 'none'}, stale boards removed=${removed}`);
        }
        return new Response(out.join('\n') || 'no allowed chats', { status: 200 });
      }
      if (url.searchParams.get('diag') !== null) {
        const id = url.searchParams.get('diag')
          || String(env.ALLOWED_CHATS || '').split(',')[0].trim();
        const call = async (method, params) => {
          const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params || {}),
          });
          return r.json();
        };
        const me = await call('getMe');
        const chat = await call('getChat', { chat_id: id });
        const member = me.ok
          ? await call('getChatMember', { chat_id: id, user_id: me.result.id })
          : null;
        // &user=<id> answers "why can't this person do X" — status and rights.
        const who = url.searchParams.get('user');
        const user = who ? await call('getChatMember', { chat_id: id, user_id: +who }) : null;
        return new Response(JSON.stringify({
          allowed_chats: env.ALLOWED_CHATS, probed_chat: id, me, chat, member, user,
        }, null, 2), { status: 200 });
      }
      const out = [];
      const calls = [
        ['name', 'setMyName', 'name'],
        ['desc', 'setMyDescription', 'description'],
        ['short', 'setMyShortDescription', 'short_description'],
      ];
      for (const [param, method, field] of calls) {
        const value = url.searchParams.get(param);
        if (value === null) continue;
        const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [field]: value }),
        });
        const data = await res.json();
        out.push(`${method}: ${data.ok ? 'ok' : JSON.stringify(data)}`);
      }
      return new Response(out.join('\n') || 'nothing to do', { status: 200 });
    }
    return new Response('nag-bot is running', { status: 200 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCron(env).catch((e) => console.log(`cron failed: ${e.stack || e}`)));
  },
};
