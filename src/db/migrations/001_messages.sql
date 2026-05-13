-- STRATA_SPEC.md §3.1 — messages
--
-- The first layer of the two-layer data model. Every IM message a user or
-- assistant sends is appended here verbatim. raw_events references messages
-- (not the other way around), so this table is the bedrock everything else
-- traces back to.

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  channel TEXT NOT NULL,           -- 'telegram' | 'discord' | ...
  role TEXT NOT NULL,              -- 'user' | 'assistant' | 'system'
  content TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'text',
  turn_index INTEGER NOT NULL,
  received_at TEXT NOT NULL,       -- ISO 8601 with TZ

  -- Optional link to the semantic event derived from this message.
  raw_event_id INTEGER REFERENCES raw_events(id),
  raw_event_role TEXT,             -- 'primary' | 'context' | 'correction' | 'confirmation'

  -- sqlite-vec embedding (filled in async by the embedding worker).
  embedding BLOB,

  CHECK (role IN ('user', 'assistant', 'system')),
  CHECK (content_type IN ('text', 'image', 'audio', 'file', 'callback'))
);

CREATE INDEX idx_messages_session ON messages(session_id, turn_index);
CREATE INDEX idx_messages_time    ON messages(received_at);
CREATE INDEX idx_messages_raw_event ON messages(raw_event_id) WHERE raw_event_id IS NOT NULL;

-- FTS5 full-text search shadow table.
CREATE VIRTUAL TABLE messages_fts USING fts5(
  content,
  content='messages',
  content_rowid='id'
);

CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;

-- External-content FTS5 cannot be updated in place — the documented pattern
-- is delete-then-insert via the `messages_fts(messages_fts, rowid, content)`
-- command syntax. `STRATA_SPEC.md` §3.1 shows a naive `UPDATE messages_fts SET
-- content = ...` which corrupts the index on the first content edit
-- ("database disk image is malformed"). We follow the SQLite FTS5 manual
-- instead. See design.md D6.
CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;

CREATE TRIGGER messages_fts_update AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;
