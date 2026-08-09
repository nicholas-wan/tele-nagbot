# Nag-Bot (Latte & Mocha ☕🐈)

A Telegram bot for household chores that **keeps nagging until someone taps ✅ Done** — voiced by the cats, illustrated with their sticker pack. Runs entirely on Cloudflare Workers' free tier: the bot, the every-minute scheduler, and the database all live in the cloud, so it works with every computer off.

Live at `https://nag-bot.lattemocha.workers.dev` · bot: [@TwoShotsNagBot](https://t.me/TwoShotsNagBot)

## Reminders

```
/remind take out trash 7pm daily
/remind @jane water plants every mon,thu 8am
/remind clear poop every 8 days 9am
/remind pay rent on the 1st 10am
/remind call the plumber tomorrow 9:30am
/remind check the oven in 20m
/remind feed the cats now            ← fires instantly
/remind trash 7pm daily nag:10m      ← custom re-nag pace
```

- **No time given?** The bot replies with tap-to-choose buttons (In 15 min / Tonight 7pm / Tomorrow 9am / …).
- **Nag loop:** sticker + message with `✅ Done` / `😴 Snooze 1h` buttons. Ignored nags re-send at 15 → 30 → 60-minute intervals (or the `nag:` pace), each striking through the previous one, escalating in tone. Snooze delays 1h, max 3. After 24h unacked: 🪦 expired, cats disappointed.
- **Mentions:** `@username` (or tap a name from autocomplete for users without one) assigns the reminder; every nag pings them. Anyone can still tap Done — the ack names who did it.
- **Numbers** are per-chat, start at 1, and reuse freed slots. Manage with:
  `/list` · `/delete N` · `/pause N` · `/resume N` · `/skip N` · `/done N` · `/stats` · `/tz Europe/London`

## Stickers

Every nag comes with a random sticker from the chat's pack, and the message names whichever cat is on it. Completions get a celebration sticker.

- `/usepack <t.me/addstickers/... link>` — use any public pack for this chat; `/usepack reset` returns to the bot's built-in pack; bare `/usepack` shows the current one.
- `/tags` — list which cat each sticker is tagged as (`/tags N` previews one).
- `/tagsticker N latte|mocha|both` — set a tag by hand (source of truth).
- `/autotag` — AI first-pass tagging of untagged stickers (`redo` wipes and starts over). The vision models are mediocre at telling the cats apart — always review with `/tags`.
- `/makestickers` — create/sync the bot's own pack from photos baked into `src/stickers-data.js` (regenerate with a 512×512 WEBP pipeline and redeploy to add more).
- `/delsticker N` — remove a sticker from the bot's own pack.

## Architecture

```
Telegram ──webhook──▶ Cloudflare Worker ──▶ D1 (SQLite)
                            ▲   ▲
      Cron (* * * * *) ─────┘   └── Workers AI (vision, /autotag)
```

| File | Purpose |
|---|---|
| `src/index.js` | fetch (webhook + `/setup` + `/admin`) and scheduled entry points |
| `src/handlers.js` | commands, wizard popup, Done/Snooze callbacks, nag copy |
| `src/cron.js` | fire due reminders, re-nag, expire, cleanup |
| `src/firing.js` | shared "fire one reminder" logic (cron + `/remind … now`) |
| `src/parse.js` | `/remind` argument parser |
| `src/time.js` | timezone math, next-occurrence computation |
| `src/stickers.js` | pack management, tagging, random/celebration sends |
| `src/tg.js` | Telegram API client |
| `schema.sql` | D1 tables: reminders, firings, drafts, settings, sticker_tags |

Secrets: `BOT_TOKEN`, `WEBHOOK_SECRET` (via `wrangler secret put`). The Worker registers its own webhook and command menu: visit `/setup?key=<WEBHOOK_SECRET>` once after deploy. `/admin?key=…` offers `info` (webhook status), `stickers`/`stickerimg` (tag inspection), and name/description updates.

## Deploying changes

```
npx wrangler deploy
```

Schema changes: `npx wrangler d1 execute nagbot --remote --file=schema.sql` (new tables) or an `ALTER TABLE` via `--command`. Logs: `npx wrangler tail`.
