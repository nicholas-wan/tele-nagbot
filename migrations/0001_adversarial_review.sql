-- Preserve the first owner of each existing number. Move only duplicates
-- above the old per-chat maximum before enforcing uniqueness. Safe to rerun.
WITH existing AS MATERIALIZED (
  SELECT id, chat_id, display_num,
    ROW_NUMBER() OVER (PARTITION BY chat_id, display_num ORDER BY id) AS duplicate_rank,
    MAX(display_num) OVER (PARTITION BY chat_id) AS old_max
  FROM reminders WHERE display_num IS NOT NULL
), replacements AS MATERIALIZED (
  SELECT id, old_max + ROW_NUMBER() OVER (PARTITION BY chat_id ORDER BY id) AS new_num
  FROM existing WHERE duplicate_rank > 1
)
UPDATE reminders SET display_num = (SELECT new_num FROM replacements WHERE replacements.id = reminders.id)
WHERE id IN (SELECT id FROM replacements);

CREATE UNIQUE INDEX IF NOT EXISTS idx_reminders_chat_number ON reminders (chat_id, display_num);
CREATE TABLE IF NOT EXISTS webhook_updates (
  update_id INTEGER PRIMARY KEY,
  payload TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  received_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_webhook_updates_state ON webhook_updates (state, received_at);
