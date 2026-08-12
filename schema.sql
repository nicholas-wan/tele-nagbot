CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  assignee_name TEXT,
  assignee_user_id INTEGER,
  display_num INTEGER,                  -- per-chat number shown to users (#1, #2, …)
  schedule_kind TEXT NOT NULL,          -- once | daily | weekly | monthly | interval
  schedule_detail TEXT NOT NULL,        -- JSON: {h, mi, days?, dom?}
  next_fire_at INTEGER,                 -- UTC ms; NULL once a one-off has fired
  nag_intervals TEXT NOT NULL,          -- JSON array of minutes, e.g. [15,30,60]
  paused INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  scored INTEGER NOT NULL DEFAULT 1      -- /chore = 1 (leaderboard points), /remind = 0
);

CREATE TABLE IF NOT EXISTS firings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reminder_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  reminder_text TEXT,                   -- snapshot; survives the reminder's deletion
  fired_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'nagging',  -- nagging | done | expired
  nag_count INTEGER NOT NULL DEFAULT 0,
  next_nag_at INTEGER,
  snoozes_used INTEGER NOT NULL DEFAULT 0,
  last_message_id INTEGER,
  last_sticker_id INTEGER,              -- sticker sent with the first nag, cleaned up later
  cat TEXT,                             -- which cat was on that sticker; re-nag lines match
  done_by TEXT,
  done_at INTEGER,
  nag_chat_id INTEGER,                  -- where the nag messages live (assignee DM); NULL = the group
  scored INTEGER NOT NULL DEFAULT 1     -- snapshot of the reminder's scored flag at fire time
);

-- Pending /remind commands that lacked a time; resolved via inline buttons.
CREATE TABLE IF NOT EXISTS drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  assignee_name TEXT,
  assignee_user_id INTEGER,
  schedule_kind TEXT NOT NULL,
  schedule_detail TEXT NOT NULL,
  nag_intervals TEXT NOT NULL,
  wizard_msg_id INTEGER,                -- the time-picker popup message
  prompt_msg_id INTEGER,                -- the "reply with a time" force-reply prompt
  -- Ephemeral message ids live in their own sequence and need their own
  -- edit/delete methods, so each stored id records which kind it is.
  wizard_msg_ephemeral INTEGER NOT NULL DEFAULT 0,
  prompt_msg_ephemeral INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  ai_json TEXT,                         -- validated Workers-AI schedule suggestion, applied only on tap
  scored INTEGER NOT NULL DEFAULT 1     -- carries the /chore vs /remind choice through the wizard
);

CREATE TABLE IF NOT EXISTS settings (
  chat_id INTEGER PRIMARY KEY,
  tz TEXT NOT NULL DEFAULT 'Asia/Singapore',
  sticker_set TEXT,                     -- NULL = the bot's own Latte & Mocha pack
  last_digest TEXT,                     -- local Y-M-D of the last morning digest sent
  last_weekly TEXT,                     -- local Y-M-D of the last Sunday recap sent
  dashboard_msg_id INTEGER,             -- pinned "outstanding chores" message
  paused_until INTEGER                  -- vacation mode: everything muted until this UTC ms
);

-- Group members seen by the bot; dm_ok means they opened a DM line (/start),
-- letting chores assigned to them nag their private chat instead of the group.
CREATE TABLE IF NOT EXISTS members (
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  username TEXT,
  first_name TEXT,
  dm_ok INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (chat_id, user_id)
);

-- Recently /delete-d reminders, kept for a day so Undo can restore them.
CREATE TABLE IF NOT EXISTS trash (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  payload TEXT NOT NULL,                -- JSON snapshot of the reminders row
  created_at INTEGER NOT NULL
);

-- Which cat appears in a given sticker (keyed by Telegram's stable file id).
CREATE TABLE IF NOT EXISTS sticker_tags (
  file_uid TEXT PRIMARY KEY,
  cat TEXT NOT NULL                     -- latte | mocha | both
);

CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders (next_fire_at) WHERE paused = 0;
CREATE INDEX IF NOT EXISTS idx_firings_nag ON firings (next_nag_at) WHERE state = 'nagging';
-- Stats, dashboard, digest, and recap all filter firings by chat + state.
CREATE INDEX IF NOT EXISTS idx_firings_chat ON firings (chat_id, state);
