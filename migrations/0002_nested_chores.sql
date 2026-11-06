-- Nested chores (src/nesting.js): the chore this one sits under. Doing that
-- one, on time or early, resets this one too. NULL = not nested.
ALTER TABLE reminders ADD COLUMN parent_id INTEGER;
