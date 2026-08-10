# Nag-Bot (Latte & Mocha ☕🐈)

Telegram chore bot that nags until someone taps ✅ Done. Cloudflare Workers free tier: webhook + every-minute cron + D1. Bot: [@TwoShotsNagBot](https://t.me/TwoShotsNagBot) · Worker: `nag-bot.lattemocha.workers.dev`

## Commands

```
/remind trash 7pm daily · @jane dishes now · plumber in 20m
        every mon,thu 8am · every 8 days 9pm · every 2 weeks 7pm · on the 1st · tomorrow 9:30am · nag:10m
/list  /delete N  /pause N  /resume N  /skip N  /done N
/pause all 14     vacation mode: mute everything for N days (auto-resumes) · /resume all
/stats            weekly leaderboard (resets Monday) · /stats all = 6-month log
/usepack <link>   sticker pack for nags · /tags · /tagsticker N latte · /autotag · /makestickers · /delsticker N
```

No time given → inline time-picker (tap, or reply with a custom time). Reply `done` or `snooze 2h` to any nag (max 3 snoozes, capped at the 24h expiry). Creation confirmations have Undo.

## Behavior

- Nags re-send at 15/30/60 min (or `nag:` pace), deleting the previous nag — one live nag per chore. First re-nag silent, later ones ping. 24h unacked → expired 🪦.
- Sticker on first nag and on Done (once a pack exists via `/makestickers` or `/usepack`); nag lines name the cat on the sticker (per-sticker tags in D1).
- Pinned "Outstanding chores" dashboard, silently edited; needs bot admin with Pin messages.
- Daily 8am digest and Sunday 8pm weekly wrap, both silent. Default timezone Asia/Singapore.

## Code

| File | Purpose |
|---|---|
| `src/index.js` | webhook + `/setup` + `/admin` routes, cron entry |
| `src/handlers.js` | commands, wizard, callbacks, dashboard, nag copy |
| `src/cron.js` | fire/re-nag/expire, digest, weekly wrap |
| `src/firing.js` | fire-one-reminder (cron + `/remind … now`) |
| `src/parse.js` | /remind parser |
| `src/time.js` | timezone + next-occurrence math |
| `src/stickers.js` | packs, tagging, sticker sends |
| `src/tg.js` | Telegram API client |

## Ops

- Deploy: `npx wrangler deploy` · logs: `npx wrangler tail`
- Access: only chat ids in `ALLOWED_CHATS` (`wrangler.toml` `[vars]`) are served; all other chats are ignored.
- Secrets: `BOT_TOKEN`, `WEBHOOK_SECRET`. After first deploy, visit `/setup?key=<WEBHOOK_SECRET>` (registers webhook + command menu).
- Schema changes: `wrangler d1 execute nagbot --remote` with `--file=schema.sql` (new tables) or `--command "ALTER …"`.
