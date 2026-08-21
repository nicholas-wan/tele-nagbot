# Nag-Bot 🐈

Telegram chore bot that nags until someone marks a chore done. Cloudflare Workers + D1 + a one-minute cron. [@TwoShotsNagBot](https://t.me/TwoShotsNagBot) · Worker `nag-bot.lattemocha.workers.dev` · group `-1004418632524` · Asia/Singapore.

> **The live database is `nagbot-eu`.** `nagbot` is the retired APAC original, kept as the pre-migration backup and read by nothing — querying it by the old name returns plausible, wrong answers. Always name the database.

## Use

```text
/chore trash 7pm daily        counts on the leaderboard
/remind pay tax friday        same syntax, no leaderboard points
/chore @jane dishes now       assignee · rotate = fair-share it
/list · /edit · /done · /pause · /resume · /skip · /delete    (by chore name)
/poke · /stats · /stats all · /pause all 14 · /resume all
/invite bday lunch 13 sep 12pm at Fu Yuan, 80 Middle Rd    calendar file, tap to add
```

Schedules: `7pm daily`, `every mon,thu 8am`, `every 8 days`, `every 2 weeks`, `every other saturday`, `every 3 months`, `on the 1st`, `weekdays`, `starting 29 aug`, `tomorrow 9:30am`, `in 20m`, `now`, `noon`, `nag:10m`. Omit the time for a guided picker (with a Workers-AI suggestion that only applies when tapped).

Nags carry Done / Done together / Snooze / Delete. Replying `done`, `done together`, `done with @jane`, or `snooze 2h` works, as does a 👍/✅ reaction. Max 3 snoozes.

## Behavior

- Re-nags at 15/30/60 min (or `nag:` pace), one live nag per chore, first re-nag silent. Unclaimed 24h → 🪦 expired.
- Snooze offers 30m / 1h / 2h / 9pm, all clamped to that 24h expiry, plus **📅 Tomorrow** — a postponement, not a snooze: it carries `fired_at` forward so the expiry window moves with the nag. Both count against the 3-snooze cap.
- **One confirmation per new chore, never two.** Unassigned: a public "added" line carrying the Undo. Assigned: a private copy only, because announcing it would leak what its private nag hides.
- `/chore` scores, `/remind` does not, and they look identical otherwise — so a reminder is flagged `(reminder — no points)` on its nag and `· reminder` on the board. Chores are the default and stay unmarked. **Done together stays on both**: it records who did the work, points or not.
- Every message the bot sends is recorded in `sent_messages` and swept — a day for most, ~2h for done-receipts and celebration stickers (`RECEIPT_TTL_MS`). The pinned dashboard (`keep: true`) is the sole exception; ✅ OK just gets there sooner.
- Quiet hours 11pm–8am: bot-initiated re-nags and expiry notices wait for 8am. Scheduled fire times are honored as set.
- Pinned dashboard lists every chore, urgency-ordered, two short lines each so nothing wraps on a phone. Refreshed on every change and each morning.
- Manage, edit, and delete happen **in place on the pinned message** — only its `reply_markup` changes, never its text. So every button names the chore it acts on (`✏️ 💩 clear poop · Tue 9:00 PM`); internal numbers never appear in labels.
- Lost the pin (group upgraded, someone unpinned it)? `/list` rebuilds and re-pins it, as does `POST /admin?board`.
- The 8am digest speaks only when something was left nagging overnight — the board already carries the day's agenda. Weekly wrap Sunday 8pm. Both silent. Streaks 🔥 for repeat weekly winners.
- Chore icons come from a keyword table in `handlers.js`; lead the text with your own emoji to override.
- Sticker on first nag and on Done, once a pack exists (`/makestickers` or `/usepack`). Latte is the light calico, Mocha the dark tortie, and the nag line names whichever the sticker shows — so a wrong tag reads as the wrong cat. Fix with `/tagsticker N latte|mocha|both`; `/tags` lists them.

## Ephemeral messages (Bot API 10.2)

Replies are private to the sender; the command that asked for them is deleted the moment it is handled. The group only ever sees shared content.

| Private (ephemeral) | Public |
|---|---|
| Command replies, help, `/list`, `/stats` | Pinned dashboard and its ⚙️ Manage flow |
| Wizard, prompts, confirmations, errors | Unassigned nags, `/invite` files |
| **Nags for an assigned chore** | Done receipts, tombstones, vacation mode, welcomes |

Manage is deliberately **shared**: tapping ⚙️ swaps the pinned message's buttons in place, so either of you can pick up where the other left off. Only replies to a typed command are private.

- Commands are registered **without** `is_ephemeral`. An ephemeral command is never delivered to a bot with Group Privacy on, which is how this bot runs — commands simply vanished. So a command arrives as an ordinary group message, visible for the moment before `deleteMessage` clears it. Reply privacy is unaffected: it comes from `receiver_user_id` on the send. Verify with `POST /admin?info`.
- A private send needs `receiver_user_id`; within 15s of a tap it also carries `callback_query_id`, which is what lets the bot reach a member it has no other recent contact with. The bot must be a group admin, and delivery to an offline user is not guaranteed — `sendPrivate` falls back to public when Telegram refuses.
- Ephemeral messages report `message_id: 0` plus a separate `ephemeral_message_id`, and need `editEphemeralMessageText` / `deleteEphemeralMessage`. Stored ids travel as `{ id, ephemeral }` refs (`drafts.*_msg_ephemeral`, `firings.last_message_ephemeral` + `nag_user_id`). Guard any `deleteMessage` with `isPublicMessage()` — never call it with id 0.
- The nag lifecycle goes through `sendNag` / `editNag` / `deleteNag`; never touch `last_message_id` with the public helpers, or a private nag becomes unreachable. There is no reply-markup-only edit for ephemeral messages, so those paths re-render the text too.
- DM nag routing is **gone**. `nag_chat_id` is always NULL; `members.dm_ok` is vestigial.
- Kill switch: set `EPHEMERAL = "0"` in `wrangler.toml` `[vars]` and deploy to make everything public again.

## Code

| File | Purpose |
|---|---|
| `src/index.js` | webhook + `/setup` + `/admin` routes, cron entry |
| `src/handlers.js` | commands, wizard, callbacks, editor, dashboard, stats, nag copy |
| `src/cron.js` | fire/re-nag/expire, digest, weekly wrap, sweep, retention, vacation wake |
| `src/firing.js` | fire-one-reminder, assignee routing, rotation |
| `src/parse.js` | `/chore` and `/remind` parser — recurrence lives here (200-char cap) |
| `src/invite.js` | `/invite`: chrono-node dates, address detection, `.ics` builder |
| `src/time.js` | timezone, next-occurrence, interval anchoring, quiet hours |
| `src/stickers.js` · `src/ai.js` · `src/tg.js` | packs/tagging · schedule suggestion · API client |

Two parsers on purpose: `parse.js` owns recurrence, which chrono-node cannot do; `/invite` is always a one-off, so it uses chrono for far better natural-language dates. chrono reasons in the *system* timezone (UTC in a Worker), so it is handed a reference built from the chat's wall clock and its components are rebuilt with `zonedEpoch` — never trust its `Date` directly. Addresses stay hand-rolled: libpostal is a C library and cannot run in a Worker.

Concurrency rule: every state transition is a conditional `UPDATE … WHERE state = ?` (or a conditional draft delete) whose `meta.changes` is checked before side effects. Keep it that way — it prevents zombie nags, double fires, and duplicate reminders. `fireReminder` claims an occurrence before inserting its firing and releases the claim if anything throws in between; without that, a fire that failed mid-way advanced the schedule and lost the nag with no trace.

## Ops

```powershell
npm test
npx wrangler deploy
npx wrangler tail
```

- Secrets: `BOT_TOKEN` (never handle it — hand the user the command), `WEBHOOK_SECRET` (Telegram's header only), `ADMIN_SECRET`. Local copies in `%TEMP%\nagbot-webhook-secret.txt` and `%TEMP%\nagbot-admin-secret.txt`.
- Allowed chats live in `wrangler.toml` `[vars] ALLOWED_CHATS`; missing config fails closed. The bot needs Pin Messages and Delete Messages, and admin status is also what makes ephemeral sends possible.
- Wrangler is pinned in `devDependencies` — the floating `npx` release broke once.
- Register webhook + command menu (also after changing the menu):

```powershell
curl.exe -X POST -H "Authorization: Bearer <ADMIN_SECRET>" https://nag-bot.lattemocha.workers.dev/setup
```

- Other admin actions, same bearer token: `?info` (webhook + registered commands, read back from Telegram), `?diag[=<chat>][&user=<id>]` (membership, admin rights, whether the chat id changed), `?board` (rebuild and re-pin the dashboard), `?stickers&chat=<id>` and `?stickerimg=N&chat=<id>` (list tags, fetch one image).
- `?board` walks the pin stack because `getChat` only reports the topmost pin, and stops at the first pin a human made. Telegram can serve a cached `getChat` right after an unpin, so a duplicate may survive a run — re-run it, or unpin by hand. `unpinAllChatMessages` is the guaranteed fix but destroys every pin in the group.
- Migrations: `npx wrangler d1 execute nagbot-eu --remote --command "ALTER …"`, one statement at a time, mirrored into `schema.sql`.
- Deploys take ~30s to propagate — re-run before concluding a change didn't work. Debug with `wrangler tail`, or by querying `firings` / `reminders` / `settings` in `nagbot-eu`; they explain almost every "the bot didn't do X" report.
- A group upgraded to a supergroup gets a **new chat id** and loses its pin. Rejected group chats are logged, so `wrangler tail` shows the new id immediately; update `ALLOWED_CHATS`, migrate the D1 rows, then `?board`.
