# Operations

Configuration, deployment, admin endpoints, migrations, performance and
debugging in full. The [README](../README.md) has the short version of each;
the reasoning behind the bot's behaviour is in [design.md](design.md).

- [Configuration](#configuration)
- [Deploy](#deploy)
- [Mini App setup](#mini-app-setup)
- [Admin endpoints](#admin-endpoints)
- [Migrations](#migrations)
- [Webhook intake and recovery](#webhook-intake-and-recovery)
- [Performance](#performance)
- [Debugging](#debugging)

## Configuration

`wrangler.toml` vars (copy `wrangler.example.toml` to start):

| Var | Meaning |
|---|---|
| `ALLOWED_CHATS` | Chat ids the bot answers. Updates from any other chat, stranger DMs included, are ignored before touching D1 or AI. Missing config fails closed |
| `NICKNAMES` | Optional assignee shortcuts, `nic=@handle, yx=@handle`. Each value must be the person's roster spelling: `@username`, or the bare first name of a member without one |
| `MINI_APP_URL` | Optional. The Mini App's direct link from BotFather. With it the board's button is 🐾 Chores; without it, ⚙️ Manage |
| `EPHEMERAL` | Optional. `"0"` is the kill switch that makes every message public again |

Bindings: D1 as `DB`, Workers AI as `AI`, `public/` as static assets. Each
chat's timezone is stored in `settings` and defaults to `Asia/Singapore`.

Secrets: `BOT_TOKEN`, `WEBHOOK_SECRET` (Telegram's header only) and
`ADMIN_SECRET`. Keep local copies in `.dev.vars` (gitignored, and what
`wrangler dev` reads) rather than `%TEMP%`, which Windows cleans up. `/setup`
refuses to register a webhook while `WEBHOOK_SECRET` is unset: a secretless
webhook would fail the header check on every delivery.

The bot needs Pin Messages and Delete Messages, and admin status is also what
makes ephemeral sends possible. It runs with Group Privacy on.

## Deploy

```powershell
npm test
npm run db:migrate
npm run deploy
npx wrangler tail
```

- `npm run deploy` runs the tests first (`predeploy`); CI runs them on every push (`.github/workflows/test.yml`).
- Create the database with `--location weur`. Telegram delivers webhooks from Amsterdam, so the Worker executes there, and a database in another region charges every query a cross-region round trip (measured at ~200ms each on squashbot while its database lived in APAC). `[placement] region = "gcp:europe-west4"` keeps Mini App requests, which come from phones in Singapore, beside the database too.
- Wrangler is a local `devDependency` locked by `package-lock.json` (the range in `package.json` is a caret); the floating `npx` release broke once, so always run it through the project.
- Deploys take ~30s to propagate; re-run before concluding a change didn't work.
- Register the webhook and command menu after the first deploy, after changing the menu, and after any change to `allowed_updates` (`chat_member` is not delivered unless explicitly requested here):

```powershell
curl.exe -X POST -H "Authorization: Bearer <ADMIN_SECRET>" https://YOUR-WORKER.workers.dev/setup
```

## Mini App setup

@BotFather → `/newapp` → pick the bot, upload `assets/miniapp-photo.jpg` when it asks for a 640×360 photo (Latte and Mocha, cropped from `assets/nag-bot-avatar.jpg`), skip the GIF, give the URL `https://YOUR-WORKER.workers.dev/app/` and a short name such as `chores`. Put the direct link it gives in `[vars]` as `MINI_APP_URL = "https://t.me/<bot>/chores"`, deploy, then `POST /admin?board` to redraw the button (or wait for the next chore change). The page is served from `public/` by `[assets]`; the API is `/api/app/*`.

To preview the page without Telegram, serve `public/` on localhost (`python -m http.server 4191 --directory public`, open `http://localhost:4191/app/`): outside Telegram it draws sample chores and never reaches the bot.

## Admin endpoints

All `POST`, with `Authorization: Bearer <ADMIN_SECRET>`.

| Path | What it does |
|---|---|
| `/setup` | Registers the webhook and command menu |
| `/admin?info` | Webhook and registered commands, read back from Telegram |
| `/admin?diag[=<chat>][&user=<id>]` | Membership, admin rights, whether the chat id changed |
| `/admin?board` | Rebuilds and re-pins the board |
| `/admin?stickers&chat=<id>` | Lists sticker tags |
| `/admin?stickerimg=N&chat=<id>` | Fetches one sticker image |

- `?board` walks the pin stack because `getChat` only reports the topmost pin, and stops at the first pinned message a human *authored* (`pinned_message.from` is the author, not whoever pinned it — a bot message a human pinned is treated as the bot's). Telegram can serve a cached `getChat` right after an unpin, so a duplicate may survive a run — re-run it, or unpin by hand. `unpinAllChatMessages` is the guaranteed fix but destroys every pin in the group.

## Migrations

- Migrations live in `migrations/`, with the resulting schema mirrored in `schema.sql`. **Run `npm run db:migrate` before any deploy that adds one** — the Worker expects the schema it ships with, and a missing `webhook_updates` table turns every webhook into a 503. `0002_nested_chores.sql` adds `reminders.parent_id`; every Done reads it, so it must be applied before the Worker that uses it. `0001_adversarial_review.sql` repairs duplicate per-chat chore numbers (preserving the first owner), enforces uniqueness, and creates the webhook inbox. `0003_hot_path_indexes.sql` adds indexes only (a chore's live firing, the cron's expiry clause, a sent message by id), so the Worker runs with or without it. The live `nagbot-eu` has all three applied (0001 on 27 Sep, 0002 on 6 Nov, 0003 on 8 Nov 2026, tracked in `d1_migrations`); nothing is pending.

## Webhook intake and recovery

- Webhooks are persisted before acknowledgement and claimed once by `update_id`, in the same batch (so a delivery is never left stored but unstarted by the webhook itself). Cron still recovers `pending` rows — written by the earlier two-step intake, or by `enqueueUpdate`. A handler interrupted after starting is marked failed after 15 minutes and the requester is told to check `/list` before retrying; it is not replayed automatically because some mutations may have completed. Finished/failed inbox payloads are retained seven days for diagnosis. A database outage before persistence returns HTTP 503 so Telegram can retry.
- Early completion uses a D1 transaction for consuming the slot, recording credit, and stashing Undo. Chore numbers are allocated inside their INSERT, including restores. Assignment edits move the active card and future re-nags to the new recipient without changing the snooze or schedule.

## Performance

Speed rule: the data is tiny (SQL runs in under a millisecond), so every cost is a round trip — the Worker runs in Amsterdam beside Telegram (`[placement] region = "gcp:europe-west4"`, so a Mini App request from a phone in Singapore runs there too rather than in SIN), D1's primary is in Marseille, about 20ms a query. Keep them few and out of the way (8 Nov 2026):
- **One intake batch.** A webhook stores, claims and records the sender's `members` row in one D1 batch (`acceptUpdate`); a repeated delivery writes nothing. When this isolate's copies are stale, the chat's timezone, sticker pack and cat tags ride in it too (`chatReads` in context.js), so no later step — a Done's card, a typed `/chore` — waits on a read of its own. A batch that answers with an error is checked: a row carrying this claim's own timestamps was committed and is handled, no row means Telegram retries.
- **A tap is one round trip after the intake.** ✅ Done, 🤝 Done together, ✅ on the digest, 🗑 Delete and a snooze preset send their conditional write together with the reads they need (`doneClaim` in nag.js, `deleteTapped` in chores.js, `snoozeTapped` in handlers.js): the chat the tap came from, the owner of a private nag and the chore's existence are conditions of the write, and the rows read back only say why a lost write lost. 🗑's stash is built in SQL from the row it deletes (`REMINDER_COLUMNS`, which a test holds to the schema), and each later write in its batch is gated on the one before (`changes() = 1`). The ↩️ family, Restore, the wizard's time and a confirmation's ✅ read in one batch and write in a second. Help, stats tabs and editor navigation answer before reading anything.
- **Toast first.** A tap is answered the moment its outcome is decided — the `onClaim` hook on `completeFiring`, `completeEarly`, `completeNow`, `undoCompletion`, `undoEarly`, `removeReminder` and `deleteReminder` — and the answer rides the webhook's own response. The sticker, the cards, the delete log and the board follow, the ones that touch different messages together.
- **The Mini App answers from its gate.** The list and a chore's screen are one D1 batch (the board's own read, timezone included). A chore's POST reads the roster, settings, the chore and its live nag in the gate; an edit's write, an add's INSERT, a delete's removal, a skip's swap and the roster refresh ride in the batch the reply reads (`loadBoard`'s `before`), and so do a parent's cover writes (`withReply`: queued until that batch, their results handed back to the receipt, which waits for them after the reply). A pause reads its nag back in the flag's batch. A POST's gate also carries the chat's sticker reads when stale (`chatReads`). What Telegram has to show of a change — card edits, receipts, stickers, the delete log, an added chore's first fire — runs after the reply (`later(env, task)` in a `deferBoards(env, { afterReply: true })` scope); without that scope `later` runs the task at once. The page starts its first `/api/app/chores` fetch from an inline script before Telegram's SDK loads and uses it only if the SDK's `initData` matches.
- **One board redraw, last.** `updateDashboard` inside a webhook update, a Mini App request or a cron tick only notes the chat (`deferBoards`); `flushBoards` draws each board once when the work is done, and for the Mini App after the response. A caller that draws the pin itself (the editor living on it) says so with `boardDrawn`. The board's data is one batch (`loadBoard`).
- **Sweep records are written at the end.** Inside a scope, `recordForSweep` queues the row and `flushBoards` writes them all in one batch (a fire folds them into its last write). Nothing reads a record in the request that made it; `retimeSentMessage` re-times a queued one in the queue.
- **The cron.** A fire is three batches (the claim with the previous nag, roster and rotation tally; the new nag's writes; its card ids, a one-off's release and the records — the scope's whole queue, put back if that batch fails). A failed claim batch is not swapped back: a racing fire claims the same value. Re-nags read their chores with the due firings, and take the old card down while the new one goes out. The order is wake, fire, re-nag, boards, then digests (which leave out what this tick fired: `fired_at < now`), the weekly wrap, inbox recovery and housekeeping. The sweep deletes six at a time and drops its rows in one statement. The due check carries the inbox's recovery reads and the chat list (settings plus `ALLOWED_CHATS`, priming the timezone and sticker pack caches, and the cat tags when stale), so an idle tick is one round trip and a fire picks its sticker and its cat without a read.
- **Batch what goes together; parallelise what is independent.** A nested chore's cover reads beside the Done's claim and writes in one batch. Stickers, card edits and receipts that touch different things run in `Promise.all`. The tz, sticker packs, cat tags (the whole table, so an unseen sticker is no read either), the Mini App's launch key and membership answers are cached per isolate. chrono-node (only `/invite`) and the sticker images (only `/makestickers`) load on demand.
- `node bench/latency.mjs` replays the common flows on the real schema with 20ms D1 and 25ms Telegram calls and prints reply, first-message and total times (`TRACE=1 node bench/latency.mjs --one <scenario>` prints each call as it starts); `test/speed.test.js` pins the shapes above, counting round trips as waves of D1 calls. Its warm run is a fresh database binding, so the per-isolate caches keyed by it start cold, as they mostly are for a household that taps a few times an hour. Measured on 8 Nov 2026 (warm, reply): ✅ Done 657 → 123 → 43ms, 😴 Snooze 407 → 123 → 42ms, Mini App list 163 → 60 → 28ms, Mini App Done 780 → 248 → 70ms, idle cron tick 95 → 21ms, the wizard's card 1633 → 64ms (it no longer waits for the AI guess). The third pass, same day: 🗑 Delete 89 → 41ms, ✅ Done's card edited 87 → 40ms after the tap (all done 181 → 135ms), `/chore`'s reply 65 → 43ms, Mini App Done early on a parent 89 → 70ms, delete 67 → 48ms, skip 68 → 47ms, pause 88 → 68ms, a cron fire's first message 102 → 82ms. At 170ms a call, which is what a Mini App request paid from SIN before the placement: list 347 → 174ms and Done 1374 → 513ms from the code alone.

## Debugging

- Debug with `npx wrangler tail`, or by querying `firings` / `reminders` / `settings` in the live database; they explain almost every "the bot didn't do X" report. Always name the database: the npm scripts target `nagbot-eu`.
- Lost the pin (group upgraded, someone unpinned it)? `/list` rebuilds and re-pins it, as does `POST /admin?board`. A board edit that fails for a transient reason (network, a 429 that outlived the retry) keeps the existing board; only a "message not found" style error recreates it, so a blip no longer pins a duplicate.
- A group upgraded to a supergroup gets a **new chat id** and loses its pin. Rejected group chats are logged, so `wrangler tail` shows the new id immediately; update `ALLOWED_CHATS`, migrate the D1 rows, then `?board`.
- Tests: `test/fixes-*.test.js` are regression tests for specific past bugs (ephemeral editor, duplicate boards, postpone/pause accounting, roster); keep them when refactoring.
