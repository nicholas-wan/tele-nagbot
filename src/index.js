// Cloudflare Worker entry point.
//  - fetch: Telegram webhook (validated with the secret token header)
//  - scheduled: every-minute cron that fires reminders and re-nags

import { handleUpdate } from './handlers.js';
import { runCron } from './cron.js';
import { listTags } from './stickers.js';
import { tg } from './tg.js';

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
    // One-time helper: GET /setup?key=<WEBHOOK_SECRET> makes the Worker
    // register its own webhook with Telegram, so the bot token never needs
    // to appear in a shell command.
    if (request.method === 'GET' && url.pathname === '/setup') {
      if (url.searchParams.get('key') !== env.WEBHOOK_SECRET) {
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
          allowed_updates: ['message', 'callback_query'],
        }),
      });
      const data = await res.json();
      // Register the "/" autocomplete menu while we're at it.
      const cmdRes = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN.trim()}/setMyCommands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Lean menu: daily drivers only. Every other command still works
        // when typed; /help lists them all.
        body: JSON.stringify({ commands: [
          { command: 'remind', description: 'New reminder — e.g. trash 7pm daily, dishes now' },
          { command: 'list', description: 'Active reminders' },
          { command: 'done', description: 'Mark a reminder done without the button' },
          { command: 'help', description: 'All commands and examples' },
        ] }),
      });
      const cmdData = await cmdRes.json();
      return new Response(
        data.ok ? `✅ Webhook registered. Command menu: ${cmdData.ok ? 'registered' : 'failed'}. The bot is fully live.`
                : `Telegram said: ${JSON.stringify(data)}`,
        { status: data.ok ? 200 : 500 }
      );
    }
    // Admin helper: GET /admin?key=<WEBHOOK_SECRET>&name=...&desc=...&short=...
    // updates the bot's display name / description via its own token.
    if (request.method === 'GET' && url.pathname === '/admin') {
      if (url.searchParams.get('key') !== env.WEBHOOK_SECRET) {
        return new Response('forbidden', { status: 403 });
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
        return new Response(JSON.stringify(await res.json(), null, 2), { status: 200 });
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
