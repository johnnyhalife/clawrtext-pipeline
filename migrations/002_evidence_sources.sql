-- Clawrtex schema v2
-- Adds: deck_hash + model to evidence_trail, model + evidence_cutoff to compiled_truth,
--       project_sources table, drops last_evidence from compiled_truth.

-- evidence_trail: add deck_hash + model; tighten unique key
ALTER TABLE evidence_trail
  ADD COLUMN IF NOT EXISTS deck_hash TEXT,
  ADD COLUMN IF NOT EXISTS model     TEXT;

-- Drop old unique constraint, replace with hash+model-aware key
ALTER TABLE evidence_trail DROP CONSTRAINT IF EXISTS evidence_trail_codename_deck_name_key;
-- New noop key: same deck + same model = same run, skip
-- Different hash OR different model = re-run (upsert replaces)
CREATE UNIQUE INDEX IF NOT EXISTS evidence_trail_noop_key
  ON evidence_trail (codename, deck_name, deck_hash, model);

-- compiled_truth: add model + evidence_cutoff, drop last_evidence
ALTER TABLE compiled_truth
  ADD COLUMN IF NOT EXISTS model            TEXT,
  ADD COLUMN IF NOT EXISTS evidence_cutoff  TIMESTAMPTZ;

ALTER TABLE compiled_truth
  DROP COLUMN IF EXISTS last_evidence;

-- project_sources: new table — replaces registry.json, multi-source ready
CREATE TABLE IF NOT EXISTS project_sources (
  id             SERIAL PRIMARY KEY,
  codename       TEXT NOT NULL REFERENCES projects (codename) ON DELETE CASCADE,
  source_type    TEXT NOT NULL,          -- 'sharepoint_decks' | 'email_dl' | 'slack_channel'
  config         JSONB NOT NULL,         -- source-specific config (site, folder, etc.)
  last_synced_at TIMESTAMPTZ,
  enabled        BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ DEFAULT now(),
  UNIQUE (codename, source_type)         -- one source per type per project for now
);

CREATE INDEX IF NOT EXISTS project_sources_codename_idx
  ON project_sources (codename);
