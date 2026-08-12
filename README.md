# Nag-Bot 🐈

Telegram chore bot that nags until someone marks a chore done. Runs on Cloudflare Workers, D1, and a one-minute cron. [@TwoShotsNagBot](https://t.me/TwoShotsNagBot)

## Use

```text
/remind trash 7pm daily
/remind @jane dishes now
/remind plants every mon,thu 8am nag:10m
/list · /edit · /done · /pause · /resume · /skip · /delete
/poke · /stats · /pause all 14 · /resume all
```

Missing times open a guided picker. Nags support Done, Done together, Snooze, replies (`done`, `snooze 2h`), and 👍/✅ reactions. The pinned dashboard lists and manages every chore.

Nags repeat at 15/30/60 minutes, respect 11pm–8am quiet hours, and expire after 24 hours. Daily digest: 8am. Weekly wrap: Sunday 8pm. Default timezone: Singapore.

Chores assigned to a member nag their DM once they press Start on the bot (until then, the group). The group always keeps the dashboard, a silent done-receipt, and the 24h tombstone. Chore icons come from a keyword table; start the chore text with your own emoji to override.

Sticker tools: `/usepack`, `/makestickers`, `/tags`, `/tagsticker`, `/autotag`, `/delsticker`.

## Deploy

```powershell
npm test
npx wrangler deploy
```

Required secrets: `BOT_TOKEN`, `WEBHOOK_SECRET`, `ADMIN_SECRET`. Allowed chats are configured in `wrangler.toml`; missing configuration fails closed. The bot needs Pin Messages and Delete Messages permissions.

Register the webhook and command menu after first deployment:

```powershell
curl.exe -X POST -H "Authorization: Bearer <ADMIN_SECRET>" https://nag-bot.lattemocha.workers.dev/setup
```
