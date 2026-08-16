# Nag-Bot 🐈

Telegram chore bot that nags until someone marks a chore done. Cloudflare Workers + D1 + a one-minute cron. [@TwoShotsNagBot](https://t.me/TwoShotsNagBot) · Worker: `nag-bot.lattemocha.workers.dev` · household group `-435466607`, timezone Asia/Singapore.

## Use

```text
/chore trash 7pm daily        counts on the leaderboard
/remind pay tax friday        same syntax, no leaderboard points
/chore @jane dishes now       assignee · rotate = fair-share it
/list · /edit · /done · /pause · /resume · /skip · /delete    (by chore name)
/poke · /stats · /stats all · /pause all 14 · /resume all
/invite dentist tomorrow 3pm at Mount E for 30m    calendar file, tap to add
```

Schedules: `7pm daily`, `every mon,thu 8am`, `every 8 days`, `every 2 weeks`, `every 3 months`, `on the 1st`, `weekdays`, `every other day`, `every morning`, `tomorrow 9:30am`, `from friday`, `in 20m`, `now`, `noon`, `nag:10m`. Omit the time for a guided picker (with a Workers-AI suggestion that only applies when tapped).

Nags carry Done / Done together / Snooze buttons; replying `done`, `done together`, `done with @jane`, or `snooze 2h` works, as does a 👍/✅ reaction. Max 3 snoozes, capped at expiry.

## Behavior

- Re-nags at 15/30/60 min (or `nag:` pace), one live nag per chore, first re-nag silent. Unclaimed 24h → 🪦 expired.
- 😴 Snooze offers 30m / 1h / 2h / 9pm, all clamped to that 24h expiry, plus **📅 Tomorrow**, which is a postponement rather than a snooze: it carries `fired_at` forward so the expiry window moves with the nag and the chore gets a fresh 24h when it returns. Both count against the 3-snooze cap.
- Every message the bot sends is recorded in `sent_messages` and deleted by a cron sweep — a day for most, ~2h for done-receipts and celebration stickers (`RECEIPT_TTL_MS`) — the pinned dashboard (`keep: true` on its send) is the sole exception. ✅ OK just gets there sooner. Stickers are recorded too; a message already dismissed simply makes Telegram refuse the delete and the row is dropped anyway.
- Quiet hours 11pm–8am: bot-initiated re-nags and expiry notices wait for 8am. Scheduled fire times are honored as set.
- Pinned dashboard lists every chore (urgency-ordered, countdown first) with a ⚙️ Manage chores button; refreshed on every change and once each morning.
- Manage, edit, and delete all happen **in place on the pinned message** — only its `reply_markup` changes, never its text. Because the text stays put, every management button names the chore it acts on (`✏️ 💩 clear poop · Tue 9:00 PM`, `🗑 Delete · clear poop`); internal numbers never appear in labels.
- Lost the pin (group upgraded, someone unpinned it)? `/list` rebuilds and re-pins the board, as does `POST /admin?board`.
- Chores assigned to a member nag **only that member, in the group** — the nag is an ephemeral message, so it sits in the group chat but nobody else can see it. No DM and no Start required. Unassigned chores stay public: they're everyone's problem. The group still gets a silent done-receipt and the tombstone, so completions and misses stay visible.
- The 8am digest speaks only when something was left nagging overnight — the refreshed pinned board already carries the day's agenda. Weekly wrap Sunday 8pm. Both silent. Streaks 🔥 for repeat weekly winners.
- Chore icons come from a keyword table in `handlers.js`; lead the chore text with your own emoji to override.
- Sticker on first nag and on Done, once a pack exists (`/makestickers` or `/usepack`). Tools: `/tags`, `/tagsticker`, `/autotag`, `/delsticker`.

## Ephemeral messages (Bot API 10.2)

Replies are private to the sender; the command that asked for them is deleted the moment it is handled. The group only ever sees shared content.

| Private (ephemeral) | Public |
|---|---|
| Command replies, help, `/list`, `/stats` | Pinned dashboard and its ⚙️ Manage flow |
| Wizard, prompts, confirmations, cancels | Unassigned nags |
| Success and error messages | Done receipts, tombstones, vacation mode |
| New-chore line for an **assigned** chore (suppressed) | New-chore line for an **unassigned** chore |
| **Nags for an assigned chore** | Welcomes |

Manage is deliberately a **shared** surface: tapping ⚙️ swaps the pinned message's buttons in place, so anyone in the household can pick up where another left off. Only replies to a command someone typed are private. A chore assigned to a member nags that member in the group, as an ephemeral message only they can see — no DM, and nothing for them to open first.

- Commands are registered **without** `is_ephemeral`, under both the default and `all_group_chats` scopes. An ephemeral command is never delivered to a bot running with Group Privacy on, which is how this bot is configured — commands simply vanished. So a command arrives as an ordinary group message, visible for the moment before `deleteMessage` clears it, guarded by `isPublicMessage()`. Reply privacy is unaffected: it comes from `receiver_user_id` on the send, not from this flag. Verify with `POST /admin?info`, which reads the registered commands back from Telegram.
- A private send needs `receiver_user_id`; within 15s of a tap it also carries `callback_query_id`, which is what lets the bot reach a member it has no other recent contact with. The bot must be a group admin, and delivery to an offline user is not guaranteed — `sendPrivate` falls back to a public message when Telegram refuses.
- Ephemeral messages report `message_id: 0` and a separate `ephemeral_message_id`, and need `editEphemeralMessageText` / `deleteEphemeralMessage`. Stored ids travel as `{ id, ephemeral }` refs; `drafts` records the flag in `wizard_msg_ephemeral` / `prompt_msg_ephemeral`, `firings` in `last_message_ephemeral` + `nag_user_id`. Guard any `deleteMessage` with `isPublicMessage()` — never call it with id 0.
- The nag lifecycle goes through `sendNag` / `editNag` / `deleteNag` in `handlers.js`; never touch `last_message_id` with the public helpers directly, or a private nag becomes unreachable. There is no reply-markup-only edit for ephemeral messages, so those paths re-render the text too.
- DM nag routing is **gone**. `nag_chat_id` survives only for pre-ephemeral rows and is always NULL; `members.dm_ok` is now vestigial.
- The pinned dashboard is never sent privately. Manage edits its reply markup in place and leaves its text alone; `updateDashboard` owns the text.
- Kill switch: set `EPHEMERAL = "0"` in `wrangler.toml` `[vars]` and deploy to make everything public again.

## Code

| File | Purpose |
|---|---|
| `src/index.js` | webhook + `/setup` + `/admin` routes, cron entry |
| `src/handlers.js` | commands, wizard, callbacks, editor, dashboard, stats, nag copy |
| `src/cron.js` | fire/re-nag/expire, digest, weekly wrap, retention, vacation wake |
| `src/firing.js` | fire-one-reminder, assignee routing, rotation |
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

- Other admin actions, same bearer token: `?info` (webhook + registered commands, read back from Telegram), `?diag[=<chat>]` (bot membership, admin rights, whether the chat id changed), `?board` (rebuild and re-pin the dashboard, retiring stale boards the bot pinned earlier).
- `?board` walks the pin stack because `getChat` only reports the topmost pin, and it stops at the first pin a human made. Telegram can serve a cached `getChat` right after an unpin, so a duplicate may survive a run — re-run it, or unpin the stale board by hand. `unpinAllChatMessages` is the guaranteed fix but destroys every pin in the group.
- Migrations: `npx wrangler d1 execute nagbot --remote --command "ALTER …"`, one statement at a time, and mirror it into `schema.sql`.
- Deploys take ~30s to propagate — re-run before concluding a change didn't work. Debug with `wrangler tail` or by querying `firings` / `reminders` / `settings` — they explain almost every "the bot didn't do X" report.
- A group upgraded to a supergroup gets a **new chat id** and loses its pin. Rejected group chats are logged, so `wrangler tail` shows the new id immediately; update `ALLOWED_CHATS`, migrate the D1 rows, then `?board`.
