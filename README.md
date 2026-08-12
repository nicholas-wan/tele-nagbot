# Nag-Bot 🐈

Telegram chore bot that nags until someone marks a chore done. Cloudflare Workers + D1 + a one-minute cron. [@TwoShotsNagBot](https://t.me/TwoShotsNagBot) · Worker: `nag-bot.lattemocha.workers.dev` · household group `-435466607`, timezone Asia/Singapore.

## Use

```text
/chore trash 7pm daily        counts on the leaderboard
/remind pay tax friday        same syntax, no leaderboard points
/chore @jane dishes now       assignee · rotate = fair-share it
/list · /edit · /done · /pause · /resume · /skip · /delete    (by chore name)
/poke · /stats · /stats all · /pause all 14 · /resume all
```

Schedules: `7pm daily`, `every mon,thu 8am`, `every 8 days`, `every 2 weeks`, `every 3 months`, `on the 1st`, `weekdays`, `every other day`, `every morning`, `tomorrow 9:30am`, `from friday`, `in 20m`, `now`, `noon`, `nag:10m`. Omit the time for a guided picker (with a Workers-AI suggestion that only applies when tapped).

Nags carry Done / Done together / Snooze buttons; replying `done`, `done together`, `done with @jane`, or `snooze 2h` works, as does a 👍/✅ reaction. Max 3 snoozes, capped at expiry.

## Behavior

- Re-nags at 15/30/60 min (or `nag:` pace), one live nag per chore, first re-nag silent. Unclaimed 24h → 🪦 expired.
- Quiet hours 11pm–8am: bot-initiated re-nags and expiry notices wait for 8am. Scheduled fire times are honored as set.
- Pinned dashboard lists every chore (urgency-ordered, countdown first) with a ⚙️ Manage chores button; refreshed on every change and once each morning.
- Chores assigned to a member nag that member's DM once they press Start on the bot; the group keeps the dashboard, a silent done-receipt, and the tombstone.
- Daily digest 8am, weekly wrap Sunday 8pm, both silent. Streaks 🔥 for repeat weekly winners.
- Chore icons come from a keyword table in `handlers.js`; lead the chore text with your own emoji to override.
- Sticker on first nag and on Done, once a pack exists (`/makestickers` or `/usepack`). Tools: `/tags`, `/tagsticker`, `/autotag`, `/delsticker`.

## Code

| File | Purpose |
|---|---|
| `src/index.js` | webhook + `/setup` + `/admin` routes, cron entry |
| `src/handlers.js` | commands, wizard, callbacks, editor, dashboard, stats, nag copy |
| `src/cron.js` | fire/re-nag/expire, digest, weekly wrap, retention, vacation wake |
| `src/firing.js` | fire-one-reminder, DM routing, rotation |
| `src/parse.js` | `/remind` and `/chore` parser (200-char text cap) |
| `src/time.js` | timezone, next-occurrence, interval anchoring, quiet hours |
| `src/stickers.js` · `src/ai.js` · `src/tg.js` | packs/tagging · schedule suggestion · API client |

Concurrency rule: every state transition is a conditional `UPDATE … WHERE state = ?` (or a conditional draft delete) whose `meta.changes` is checked before side effects. Keep it that way — it is what prevents zombie nags, double fires, and duplicate reminders.

## Ops

```powershell
npm test
npx wrangler deploy
npx wrangler tail
```

- Secrets: `BOT_TOKEN` (never handle it — hand the user the command), `WEBHOOK_SECRET` (Telegram's header only), `ADMIN_SECRET`. Local copies: `%TEMP%\nagbot-webhook-secret.txt`, `%TEMP%\nagbot-admin-secret.txt`.
- Allowed chats live in `wrangler.toml` `[vars] ALLOWED_CHATS`; missing config fails closed. Bot needs Pin Messages and Delete Messages.
- Wrangler is pinned in `devDependencies` — the floating `npx` release broke once.
- Register webhook + command menu (also after changing the menu):

```powershell
curl.exe -X POST -H "Authorization: Bearer <ADMIN_SECRET>" https://nag-bot.lattemocha.workers.dev/setup
```

- Migrations: `npx wrangler d1 execute nagbot --remote --command "ALTER …"`, one statement at a time, and mirror it into `schema.sql`.
- Deploys take ~30s to propagate. Debug with `wrangler tail` or by querying `firings` / `reminders` / `settings` — they explain almost every "the bot didn't do X" report.
