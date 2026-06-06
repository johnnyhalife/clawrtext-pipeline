-- =============================================================================
-- Migration 003: Pipedrive sync tables
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Labels — global registry, entity_type scopes id uniqueness
-- ---------------------------------------------------------------------------

CREATE TABLE pd_labels (
    id          INTEGER     NOT NULL,
    entity_type VARCHAR(16) NOT NULL CHECK (entity_type IN ('deal', 'org', 'person')),
    name        VARCHAR     NOT NULL,
    color       VARCHAR,
    PRIMARY KEY (entity_type, id)
);

-- ---------------------------------------------------------------------------
-- Organizations
-- ---------------------------------------------------------------------------

CREATE TABLE pd_orgs (
    id                  INTEGER         PRIMARY KEY,
    name                VARCHAR         NOT NULL,
    sector              VARCHAR,
    region              VARCHAR,
    industry            VARCHAR,
    annual_revenue      VARCHAR,
    employee_count      INTEGER,
    ownership_status    VARCHAR,
    year_founded        INTEGER,
    channel             VARCHAR,
    website             VARCHAR,
    linkedin            VARCHAR,
    state               VARCHAR,
    add_time            TIMESTAMPTZ,
    update_time         TIMESTAMPTZ
);

CREATE TABLE pd_org_labels (
    org_id      INTEGER     NOT NULL REFERENCES pd_orgs(id) ON DELETE CASCADE,
    label_id    INTEGER     NOT NULL,
    PRIMARY KEY (org_id, label_id)
    -- label_id integrity enforced at app layer (see sync-pipedrive.ts)
);

CREATE INDEX idx_pd_orgs_name     ON pd_orgs(name);
CREATE INDEX idx_pd_orgs_sector   ON pd_orgs(sector);
CREATE INDEX idx_pd_orgs_region   ON pd_orgs(region);
CREATE INDEX idx_pd_orgs_industry ON pd_orgs(industry);
CREATE INDEX idx_pd_orgs_channel  ON pd_orgs(channel);

-- ---------------------------------------------------------------------------
-- Persons
-- ---------------------------------------------------------------------------

CREATE TABLE pd_persons (
    id              INTEGER     PRIMARY KEY,
    name            VARCHAR     NOT NULL,
    first_name      VARCHAR,
    last_name       VARCHAR,
    email           VARCHAR,                -- primary email — cross-source join key
    phone           VARCHAR,
    org_id          INTEGER     REFERENCES pd_orgs(id) ON DELETE SET NULL,
    owner_user_id   INTEGER,
    job_title       VARCHAR,
    linkedin        VARCHAR,
    source          VARCHAR,
    tag             VARCHAR,
    add_time        TIMESTAMPTZ,
    update_time     TIMESTAMPTZ
);

CREATE TABLE pd_person_emails (
    id          SERIAL      PRIMARY KEY,
    person_id   INTEGER     NOT NULL REFERENCES pd_persons(id) ON DELETE CASCADE,
    email       VARCHAR     NOT NULL,
    label       VARCHAR,
    is_primary  BOOLEAN     NOT NULL DEFAULT FALSE,
    UNIQUE (person_id, email)
);

CREATE TABLE pd_person_labels (
    person_id   INTEGER     NOT NULL REFERENCES pd_persons(id) ON DELETE CASCADE,
    label_id    INTEGER     NOT NULL,
    PRIMARY KEY (person_id, label_id)
    -- label_id integrity enforced at app layer
);

CREATE INDEX idx_pd_persons_org_id        ON pd_persons(org_id);
CREATE INDEX idx_pd_persons_email         ON pd_persons(email);
CREATE INDEX idx_pd_person_emails_email   ON pd_person_emails(email);

-- ---------------------------------------------------------------------------
-- Deals
-- ---------------------------------------------------------------------------

CREATE TABLE pd_deals (
    id              INTEGER     PRIMARY KEY,
    title           VARCHAR     NOT NULL,
    opportunity_id  VARCHAR,
    codename        VARCHAR,
    description     TEXT,
    status          VARCHAR     NOT NULL,
    stage_id        INTEGER,
    pipeline_id     INTEGER,
    org_id          INTEGER     REFERENCES pd_orgs(id) ON DELETE SET NULL,
    owner_user_id   INTEGER,
    value           NUMERIC,
    currency        VARCHAR(8),
    contract_type   VARCHAR,
    cloud_provider  VARCHAR,
    supplier        VARCHAR,
    po_number       VARCHAR,
    ext_ref_id      VARCHAR,
    start_date      DATE,
    end_date        DATE,
    documents_url   TEXT,
    lost_reason     VARCHAR,
    sponsor_id      INTEGER,                -- deferred FK → zh_customers(id); no constraint yet
    won_time        TIMESTAMPTZ,
    lost_time       TIMESTAMPTZ,
    close_time      TIMESTAMPTZ,
    add_time        TIMESTAMPTZ,
    update_time     TIMESTAMPTZ
);

CREATE TABLE pd_deal_labels (
    deal_id     INTEGER     NOT NULL REFERENCES pd_deals(id) ON DELETE CASCADE,
    label_id    INTEGER     NOT NULL,
    PRIMARY KEY (deal_id, label_id)
    -- label_id integrity enforced at app layer
);

CREATE TABLE pd_deal_persons (
    deal_id     INTEGER     NOT NULL REFERENCES pd_deals(id) ON DELETE CASCADE,
    person_id   INTEGER     NOT NULL REFERENCES pd_persons(id) ON DELETE CASCADE,
    is_primary  BOOLEAN     NOT NULL DEFAULT FALSE,
    PRIMARY KEY (deal_id, person_id)
);

CREATE INDEX idx_pd_deals_org_id        ON pd_deals(org_id);
CREATE INDEX idx_pd_deals_status        ON pd_deals(status);
CREATE INDEX idx_pd_deals_codename      ON pd_deals(codename);
CREATE INDEX idx_pd_deals_opportunity   ON pd_deals(opportunity_id);
CREATE INDEX idx_pd_deals_contract_type ON pd_deals(contract_type);
CREATE INDEX idx_pd_deals_cloud         ON pd_deals(cloud_provider);
CREATE INDEX idx_pd_deals_start_date    ON pd_deals(start_date);
