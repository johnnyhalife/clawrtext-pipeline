-- =============================================================================
-- Migration 005: chunk_deals — N:M attribution of chunks to Pipedrive deals
-- =============================================================================
-- A chunk is attributed to ALL deals sharing its codename whose start_date
-- is closest to the chunk's deck_date (|deck_date - start_date| in days).
-- Ties get all tied deals. No nulls — every chunk gets at least one deal.
-- distance_days is stored for auditability and future re-weighting.
-- =============================================================================

CREATE TABLE chunk_deals (
    chunk_id        INTEGER     NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
    deal_id         INTEGER     NOT NULL REFERENCES pd_deals(id) ON DELETE CASCADE,
    distance_days   INTEGER     NOT NULL,
    PRIMARY KEY (chunk_id, deal_id)
);

CREATE INDEX idx_chunk_deals_deal_id  ON chunk_deals(deal_id);
CREATE INDEX idx_chunk_deals_chunk_id ON chunk_deals(chunk_id);
