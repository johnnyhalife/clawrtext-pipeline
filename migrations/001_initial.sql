-- Clawrtex schema v1
-- Run once against the clawrtex database.

CREATE EXTENSION IF NOT EXISTS vector;

-- Raw extracted slide content (append-only)
CREATE TABLE IF NOT EXISTS chunks (
  id          SERIAL PRIMARY KEY,
  codename    TEXT NOT NULL,
  source      TEXT NOT NULL,           -- 'decks' | 'email'
  deck_name   TEXT,
  deck_date   DATE,
  slide_index INTEGER,
  body        TEXT NOT NULL,
  embedding   vector(4096),             -- qwen3-embedding:8b actual output dim
  hash        TEXT UNIQUE,             -- md5 of image/content for dedup
  ingested_at TIMESTAMPTZ DEFAULT now()
);

-- NOTE: qwen3-embedding:8b outputs 4096 dims which exceeds HNSW's 4000-dim limit.
-- Exact cosine scan is fast enough at our scale (<10k chunks per codename).
-- Revisit with halfvec or dimension reduction when needed.
-- CREATE INDEX IF NOT EXISTS chunks_embedding_idx
--   ON chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS chunks_codename_date_idx
  ON chunks (codename, deck_date);

-- Evidence trail (one row per deck per codename, upsert-safe)
CREATE TABLE IF NOT EXISTS evidence_trail (
  id          SERIAL PRIMARY KEY,
  codename    TEXT NOT NULL,
  source      TEXT NOT NULL,           -- 'decks' | 'email'
  deck_name   TEXT,
  deck_date   DATE,
  model       TEXT,
  slide_count INTEGER,
  run_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE (codename, deck_name)         -- upsert key: re-runs are noops
);

CREATE INDEX IF NOT EXISTS evidence_trail_codename_date_idx
  ON evidence_trail (codename, deck_date);

-- Compiled truth (rewritten incrementally per codename)
CREATE TABLE IF NOT EXISTS compiled_truth (
  codename      TEXT PRIMARY KEY,
  narrative     TEXT,
  stack         TEXT,
  last_evidence TEXT,                  -- deck_name of last evidence incorporated
  updated_at    TIMESTAMPTZ DEFAULT now()
);

-- Project identity (HIL-fillable)
CREATE TABLE IF NOT EXISTS projects (
  codename          TEXT PRIMARY KEY,
  customer          TEXT,
  period_start      DATE,
  period_end        DATE,
  engagement_lead   TEXT,
  customer_rep      TEXT,
  deal_id           TEXT               -- FK to Pipedrive deal (future)
);
