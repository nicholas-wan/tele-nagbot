# Nag-Bot 🐈

Telegram chore bot that nags until someone marks a chore done. Cloudflare Workers + D1 + a one-minute cron. [@TwoShotsNagBot](https://t.me/TwoShotsNagBot) · Worker `nag-bot.lattemocha.workers.dev` · group `-1004418632524` · Asia/Singapore.

> **The live database is `nagbot-eu`.** `nagbot` is the retired APAC original, kept as the pre-migration backup and read by nothing — querying it by the old name returns plausible, wrong answers. Always name the database.

## Use

```text
/chore trash 7pm daily        counts on the leaderboard
/remind pay tax friday        same syntax, no leaderboard points
/chore @jane dishes now       assignee · rotate = fair-share it
/list · /edit · /done · /pause · /resume · /skip · /delete    (by chore name)
/poke · /stats (tabs: This week · Last week · 6 months) · /pause all 14 · /resume all
/invite bday lunch 13 sep 12pm at Fu Yuan, 80 Middle Rd    calendar file, tap to add
```

Schedules: `7pm daily`, `every mon,thu 8am`, `every 8 days`, `every 2 weeks`, `every other saturday`, `every month`, `every 3 months`, `on the 1st`, `weekdays`, `starting 29 aug`, `tomorrow 9:30am` (`tmr` also works), `in 20m`, `now`, `noon`, `nag:10m`. Omit the time for a guided picker (with a Workers-AI suggestion that only applies when tapped); a bare time typed afterwards (`10am`, not as a reply) resolves only the typer's own draft (`drafts.user_id`), so two open wizards cannot take each other's time. A bare `/chore` or `/remind` — a menu tap — asks what to nag about; the reply is the rest of the command.

Common conversational filler at the edges of a task is removed automatically: `please remind me to buy milk tmr 9am thanks` creates `buy milk`. Words inside the meaningful task text are preserved.

Assign with `@username`, a text mention, or a configured shortcut: `NICKNAMES = "nic=@nicholaswan, yx=@Dodgerblueee"` in `wrangler.toml` makes `/chore nic clear poop 9pm` and `/remind cancel grab for yx tmr 10am` assign to those members (a leading `for` goes with the shortcut). Only a whole word counts, an explicit mention wins, and each value must be the person's roster spelling (`@username`, or the bare first name of a member without one) so the nag resolves through `members` like a mention does. `/help` → Scheduling examples lists the shortcuts in force.

A `/chore` or `/remind` is **not** deleted when it is handled. It stays in the group until the confirmation's ✅ OK, so a misread chore can be checked against what was actually typed and copied back after ↩️ Undo (which leaves the command standing). The daily sweep is the backstop if nobody taps. Every other command is still tidied away at once, as is a bare `/chore` from the menu — there is nothing in it to keep. Through the time wizard, the command's id rides on the draft (`drafts.source_msg_id`) so the eventual confirmation's OK still removes it.

Nags carry Done / Done together / Snooze / Delete. Replying `done`, `done together`, `done with @jane`, or `snooze 2h` works, as does a 👍/✅ reaction. Max 3 snoozes. The household roster (Done together, `done with`, the Assignee menu, rotation) is everyone currently in the chat that the bot has seen (`members`, pruned on `left_chat_member` / `chat_member` updates), spelled `@username` or first name. `done with jane` also matches `@janedoe` by first name — unless that spelling could mean two members (another `@jane`, or two Janes), in which case it matches nobody; a name that matches nobody is dropped with a private note rather than becoming a phantom housemate. Rotation only counts credits for names on that roster, so an old typo in `done_by` can no longer win a turn — and it counts every completion, `/remind` ones included, since fairness is about who did the work rather than who scored.

## Behavior

- Re-nags at 15/30/60 min (or `nag:` pace), one live nag per chore, first re-nag silent. After 24h, unfinished one-offs stop automatic re-nags and stay on the pinned board as ⏰ overdue until explicitly completed or deleted; their card is redrawn as ⏰ with Done and Delete only, and a snooze on one (tap or reply) is refused — there is no window left to snooze inside. Recurring occurrences still expire after 24h; their schedules remain.
- Snooze offers 30m / 1h / 2h / 9pm, all clamped to that 24h expiry, plus **📅 Tomorrow** — a postponement, not a snooze: it carries `fired_at` forward so the expiry window moves with the nag. Both count against the 3-snooze cap, and both record the chosen time in `firings.snoozed_until`. If the schedule's next occurrence arrives before a postponed nag returns, the postponed one is dropped as superseded — it is not counted as expired.
- `/pause` freezes a live nag: no re-nags, and no expiry either — `/resume` hands it a fresh 24h window, except a nag the household itself deferred (postponed with 📅 Tomorrow, or snoozed to a time still ahead), which keeps that and is redrawn as the 😴 snooze card. "Still ahead" means `next_nag_at` still equals `snoozed_until` (`isHouseholdDeferred`): once the cron has moved the nag on — a re-nag, or a quiet-hours push to 8am — the snooze has been honoured and spent, and the firing is the bot's to restamp. `snoozes_used` cannot say this; it is a cap and stays set. `/resume` on a chore that isn't paused changes nothing and says so. If the card it wants to redraw is gone (Telegram says so, not a transient error), resume sends a fresh one rather than leave the board saying "nagging now" with nothing to tap. Resume never moves a chore that is still due in the future, and an interval chore advances from its own anchor rather than a full gap from now. The cron's expiry claims bind the `fired_at` they decided on, so a resume racing the cron wins.
- Month intervals remember the intended day (`schedule_detail.dom`): "every month starting 31 jan" lands on the 28th in February and back on the 31st in March. A stated start date survives the no-time wizard too — it rides in the draft's `schedule_detail.startDate` and is stripped before the chore is created. Interval roll-forward is arithmetic, not hop-by-hop — a `starting <date>` far in the past costs microseconds, not the Worker's CPU budget.
- **One confirmation per new chore, never two.** Unassigned: a public "added" line carrying the Undo. Assigned: a private copy only, so the group is not pinged about someone else's chore. (The pinned board still lists it with its assignee — the privacy is about noise, not secrecy.)
- Doing a chore before it nags still counts: `/done <chore>` (or ✅ Done early in Manage) records the credit. Day intervals restart from the completion date (so an early `every 2 weeks` chore is next due two weeks later); other recurring schedules advance past the upcoming slot, and a one-off is spent outright.
- `/chore` scores, `/remind` does not, and they look identical otherwise — so a reminder is flagged `(reminder — no points)` on its nag and `· reminder` on the board. Chores are the default and stay unmarked. **Done together stays on both**: it records who did the work, points or not.
- Every message the bot sends is recorded in `sent_messages` and swept — a day for most, ~2h for done-receipts and celebration stickers (`RECEIPT_TTL_MS`). The pinned dashboard (`keep: true`) is the sole exception; ✅ OK just gets there sooner. The sweep also skips a card that is still some nagging firing's `last_message_id` (a paused, postponed, or overdue nag outlives its day); the row keeps coming due and goes with the pass after the firing ends or re-nags.
- Quiet hours 11pm–8am: bot-initiated re-nags and expiry notices wait for 8am. Scheduled fire times are honored as set.
- Pinned dashboard lists every chore, urgency-ordered, two short lines each so nothing wraps on a phone. Refreshed on every change and each morning.
- Manage, edit, and delete happen **in place on the pinned message** — only its `reply_markup` changes, never its text. So every button names the chore it acts on (`✏️ 💩 clear poop · Tue 9:00 PM`); internal numbers never appear in labels.
- Lost the pin (group upgraded, someone unpinned it)? `/list` rebuilds and re-pins it, as does `POST /admin?board`. A board edit that fails for a transient reason (network, a 429 that outlived the retry) keeps the existing board; only a "message not found" style error recreates it, so a blip no longer pins a duplicate.
- Toggling 🏆 Points in the editor also updates the chore's live nag and redraws it: a nagging card as a nag, a snoozed card as a 😴 snooze notice (re-attributed to "the household", since the snoozer's name isn't stored). A paused chore's card, or any card during vacation mode, is left alone.
- The 8am digest speaks only when something was left nagging overnight — the board already carries the day's agenda. Weekly wrap Sunday 8pm. Both silent. Streaks 🔥 for repeat weekly winners.
- Chore icons come from a keyword table in `dashboard.js`; lead the text with your own emoji to override.
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
- DM nag routing is **gone**. `nag_chat_id` is always NULL; `members.dm_ok` is vestigial and no longer written. A known member who DMs the bot gets one line pointing them back to the group; strangers are ignored.
- Every nag button (`d:`, `b:`, `s:`, `z:`, `x:`, `g:`) resolves its firing scoped to the chat the tap came from, so a forged callback id from another household is inert.
- Kill switch: set `EPHEMERAL = "0"` in `wrangler.toml` `[vars]` and deploy to make everything public again.

## Code

| File | Purpose |
|---|---|
| `src/index.js` | webhook + `/setup` + `/admin` routes, cron entry |
| `src/handlers.js` | command dispatcher, nag replies/reactions, callback router, help |
| `src/nag.js` | nag messages, buttons, completion/expiry state transitions |
| `src/chores.js` | chore actions: create, find, delete, pause, done-early, vacation wake |
| `src/dashboard.js` | pinned board rendering, schedule/emoji text helpers |
| `src/manage.js` | ⚙️ Manage and ✏️ editor flows (the `m:`/`e:` callbacks) |
| `src/wizard.js` | no-time drafts, time picker, custom-time replies (`w:` callbacks) |
| `src/stats.js` | leaderboard, 6-month log, winner streaks |
| `src/household.js` | settings, member tracking, names, combined credit |
| `src/cron.js` | fire/re-nag/expire, digest, weekly wrap, sweep, retention, vacation wake |
| `src/firing.js` | fire-one-reminder, assignee routing, rotation |
| `src/parse.js` | `/chore` and `/remind` parser — recurrence lives here (200-char cap) |
| `src/invite.js` | `/invite`: chrono-node dates, address detection, `.ics` builder |
| `src/time.js` | timezone, next-occurrence, interval anchoring, quiet hours |
| `src/stickers.js` · `src/sticker-commands.js` | runtime pack behavior · setup/tagging commands |
| `src/ai.js` · `src/tg.js` | schedule suggestion · API client, ephemeral refs, sweep bookkeeping |

Two parsers on purpose: `parse.js` owns recurrence, which chrono-node cannot do; `/invite` is always a one-off, so it uses chrono for far better natural-language dates. chrono reasons in the *system* timezone (UTC in a Worker), so it is handed a reference built from the chat's wall clock and its components are rebuilt with `zonedEpoch` — never trust its `Date` directly. Addresses stay hand-rolled: libpostal is a C library and cannot run in a Worker.

Concurrency rule: every state transition is a conditional `UPDATE … WHERE state = ?` (or a conditional draft delete) whose `meta.changes` is checked before side effects. Keep it that way — it prevents zombie nags, double fires, and duplicate reminders. `fireReminder` claims an occurrence before inserting its firing and releases the claim if anything throws in between; without that, a fire that failed mid-way advanced the schedule and lost the nag with no trace.

## Ops

```powershell
npm test
npx wrangler deploy
npx wrangler tail
```

- Secrets: `BOT_TOKEN` (never handle it — hand the user the command), `WEBHOOK_SECRET` (Telegram's header only), `ADMIN_SECRET`. Keep local copies in `.dev.vars` (gitignored, and what `wrangler dev` reads) rather than `%TEMP%`, which Windows cleans up. `/setup` refuses to register a webhook while `WEBHOOK_SECRET` is unset — a secretless webhook would fail the header check on every delivery.
- Allowed chats live in `wrangler.toml` `[vars] ALLOWED_CHATS`; missing config fails closed. The bot needs Pin Messages and Delete Messages, and admin status is also what makes ephemeral sends possible.
- Wrangler is a local `devDependency` locked by `package-lock.json` (the range in `package.json` is a caret) — the floating `npx` release broke once, so always run it through the project.
- Register webhook + command menu (also after changing the menu, and after any change to `allowed_updates` — `chat_member` is not delivered unless explicitly requested here):

```powershell
curl.exe -X POST -H "Authorization: Bearer <ADMIN_SECRET>" https://nag-bot.lattemocha.workers.dev/setup
```

- Other admin actions, same bearer token: `?info` (webhook + registered commands, read back from Telegram), `?diag[=<chat>][&user=<id>]` (membership, admin rights, whether the chat id changed), `?board` (rebuild and re-pin the dashboard), `?stickers&chat=<id>` and `?stickerimg=N&chat=<id>` (list tags, fetch one image).
- `?board` walks the pin stack because `getChat` only reports the topmost pin, and stops at the first pinned message a human *authored* (`pinned_message.from` is the author, not whoever pinned it — a bot message a human pinned is treated as the bot's). Telegram can serve a cached `getChat` right after an unpin, so a duplicate may survive a run — re-run it, or unpin by hand. `unpinAllChatMessages` is the guaranteed fix but destroys every pin in the group.
- Migrations: `npx wrangler d1 execute nagbot-eu --remote --command "ALTER …"`, one statement at a time, mirrored into `schema.sql`. Pending for the September 2026 review fixes, to run before deploying them: `ALTER TABLE firings ADD COLUMN snoozed_until INTEGER` and `ALTER TABLE drafts ADD COLUMN user_id INTEGER`.
- Tests: `test/fixes-*.test.js` are regression tests for specific past bugs (ephemeral editor, duplicate boards, postpone/pause accounting, roster); keep them when refactoring.
- Deploys take ~30s to propagate — re-run before concluding a change didn't work. Debug with `wrangler tail`, or by querying `firings` / `reminders` / `settings` in `nagbot-eu`; they explain almost every "the bot didn't do X" report.
- A group upgraded to a supergroup gets a **new chat id** and loses its pin. Rejected group chats are logged, so `wrangler tail` shows the new id immediately; update `ALLOWED_CHATS`, migrate the D1 rows, then `?board`.
