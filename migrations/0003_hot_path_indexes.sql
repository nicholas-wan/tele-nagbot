-- Indexes for the paths every tap and cron tick takes (8 Nov 2026). The data
-- is small, but each of these was a full scan in front of a reply.
--
-- A chore's live firing: the fire claim's stale sweep, Done from the board or
-- the Mini App, resume, pause, and every cover of a nested chore.
CREATE INDEX IF NOT EXISTS idx_firings_reminder_state ON firings (reminder_id, state);
-- The cron's expiry clause (fired_at <= now - 24h) over the live nags.
CREATE INDEX IF NOT EXISTS idx_firings_nagging_fired ON firings (fired_at) WHERE state = 'nagging';
-- Retiming a card, a kept command's OK, and the sweep's live-card check.
CREATE INDEX IF NOT EXISTS idx_sent_messages_message ON sent_messages (chat_id, message_id);
