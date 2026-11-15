-- The quick-log pad (15 Nov 2026): a second pinned message of one-tap buttons
-- for jobs that are not scheduled chores ("vacuum", "laundry"). A tap logs a
-- done firing with reminder_id 0 (QUICK_TAP_ID), credited to whoever tapped.
CREATE TABLE IF NOT EXISTS quick_taps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
-- One button per job, whatever the case it was typed in.
CREATE UNIQUE INDEX IF NOT EXISTS idx_quick_taps_chat_text ON quick_taps (chat_id, text COLLATE NOCASE);
-- The pad's pinned message, beside dashboard_msg_id.
ALTER TABLE settings ADD COLUMN quick_msg_id INTEGER;
