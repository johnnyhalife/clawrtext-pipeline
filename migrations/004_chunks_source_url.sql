-- =============================================================================
-- Migration 004: Add source_url and fix deck_date on chunks
-- =============================================================================

ALTER TABLE chunks ADD COLUMN IF NOT EXISTS source_url TEXT;
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS source_page INTEGER;

-- source_type already exists as 'source' column — rename for clarity
-- (chunks.source is already 'decks' etc, keep as-is — source_url is the new field)

-- Index for citation lookups
CREATE INDEX IF NOT EXISTS idx_chunks_source_url ON chunks(source_url) WHERE source_url IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chunks_deck_date  ON chunks(deck_date)  WHERE deck_date  IS NOT NULL;
