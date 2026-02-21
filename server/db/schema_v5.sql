-- ═══════════════════════════════════════════════════════════
-- CivicPulse — Master Schema v5 (Idempotent)
-- Combines Phase 2 + Phase 3 + Phase 4 + Phase 5
-- Requires: PostgreSQL ≥ 12 + PostGIS
-- Run: psql -d civicpulse -f server/db/schema_v5.sql
-- ═══════════════════════════════════════════════════════════

-- Extensions
CREATE EXTENSION IF NOT EXISTS postgis;

-- ── City Wards ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS city_wards (
    ward_id       SERIAL PRIMARY KEY,
    ward_name     VARCHAR(100)   NOT NULL,
    zone          VARCHAR(50),
    officer_name  VARCHAR(100)   NOT NULL,
    officer_email VARCHAR(150),
    officer_phone VARCHAR(20),
    ward_geometry GEOMETRY(MultiPolygon, 4326) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wards_geometry
    ON city_wards USING GIST (ward_geometry);

-- ── Reports ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reports (
    id                       SERIAL PRIMARY KEY,
    category                 VARCHAR(50)    NOT NULL,
    description              TEXT           NOT NULL,
    location_text            VARCHAR(255),
    coordinates              GEOMETRY(Point, 4326),

    -- Ward assignment
    ward_id                  INTEGER REFERENCES city_wards(ward_id) ON DELETE SET NULL,

    -- Image
    image_url                TEXT,

    -- GPS / digital signature
    gps_lat                  DOUBLE PRECISION,
    gps_lon                  DOUBLE PRECISION,
    capture_timestamp        TIMESTAMPTZ,

    -- Duplicate merging
    parent_report_id         INTEGER REFERENCES reports(id) ON DELETE SET NULL,
    supporter_count          INTEGER DEFAULT 1,

    -- Phase 5: severity + emergency
    severity_level           VARCHAR(10) DEFAULT 'medium'
                             CHECK (severity_level IN ('low','medium','high','critical')),
    is_emergency             BOOLEAN DEFAULT FALSE,
    reporter_token           VARCHAR(100),            -- anonymous fingerprint from localStorage

    -- Phase 3: state machine
    state                    VARCHAR(20) DEFAULT 'SUBMITTED'
                             CHECK (state IN ('SUBMITTED','VERIFIED','ASSIGNED','IN_PROGRESS','RESOLVED','MERGED')),
    status                   VARCHAR(20) DEFAULT 'active'
                             CHECK (status IN ('active','in_progress','resolved','merged')),
    sla_level                INTEGER DEFAULT 0,       -- 0=ok, 1=L1 warn, 2=L2 urgent, 3=L3 critical
    assigned_officer_email   VARCHAR(150),
    assigned_officer_phone   VARCHAR(30),

    -- Phase 3: timestamps per state
    verified_at              TIMESTAMPTZ,
    assigned_at              TIMESTAMPTZ,
    in_progress_at           TIMESTAMPTZ,
    resolved_at              TIMESTAMPTZ,
    last_escalated_at        TIMESTAMPTZ,
    auto_escalated_at        TIMESTAMPTZ,            -- when system auto-promoted this report

    -- Phase 4: resolution proof + community acceptance
    accept_count             INTEGER DEFAULT 0,
    reject_count             INTEGER DEFAULT 0,
    resolution_accepted      BOOLEAN DEFAULT FALSE,
    verification_count       INTEGER DEFAULT 0,      -- Phase 5: number of citizens who verified

    created_at               TIMESTAMPTZ DEFAULT NOW(),
    updated_at               TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reports_coordinates  ON reports USING GIST (coordinates);
CREATE INDEX IF NOT EXISTS idx_reports_category_status
    ON reports (category, status) WHERE status = 'active' AND parent_report_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_reports_state        ON reports (state);
CREATE INDEX IF NOT EXISTS idx_reports_emergency    ON reports (is_emergency) WHERE is_emergency = TRUE;
CREATE INDEX IF NOT EXISTS idx_reports_severity     ON reports (severity_level);

-- Updated-at trigger
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reports_updated_at ON reports;
CREATE TRIGGER trg_reports_updated_at
    BEFORE UPDATE ON reports
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ── Push Subscriptions ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id           SERIAL PRIMARY KEY,
    endpoint     TEXT UNIQUE NOT NULL,
    p256dh       TEXT NOT NULL,
    auth         TEXT NOT NULL,
    report_id    INTEGER REFERENCES reports(id) ON DELETE CASCADE,
    created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_report_id
    ON push_subscriptions (report_id);

-- ── Escalation Log ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS escalation_log (
    id          SERIAL PRIMARY KEY,
    report_id   INTEGER REFERENCES reports(id) ON DELETE CASCADE,
    level       INTEGER NOT NULL,
    action      VARCHAR(50) NOT NULL,
    recipient   TEXT,
    sent_at     TIMESTAMPTZ DEFAULT NOW(),
    success     BOOLEAN DEFAULT TRUE,
    detail      TEXT
);
CREATE INDEX IF NOT EXISTS idx_escalation_log_report_id ON escalation_log (report_id);

-- ── Resolution Proofs (Phase 4) ──────────────────────────────
CREATE TABLE IF NOT EXISTS resolution_proofs (
    id              SERIAL PRIMARY KEY,
    report_id       INTEGER REFERENCES reports(id) ON DELETE CASCADE UNIQUE,
    after_image_url TEXT NOT NULL,
    officer_lat     DOUBLE PRECISION NOT NULL,
    officer_lon     DOUBLE PRECISION NOT NULL,
    distance_m      DOUBLE PRECISION NOT NULL,
    submitted_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_resolution_proofs_report_id ON resolution_proofs (report_id);

-- ── Acceptance Votes (Phase 4) ───────────────────────────────
CREATE TABLE IF NOT EXISTS acceptance_votes (
    id          SERIAL PRIMARY KEY,
    report_id   INTEGER REFERENCES reports(id) ON DELETE CASCADE,
    voter_token TEXT NOT NULL,
    vote        VARCHAR(10) NOT NULL CHECK (vote IN ('accept', 'reject')),
    voted_at    TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (report_id, voter_token)
);
CREATE INDEX IF NOT EXISTS idx_acceptance_votes_report_id ON acceptance_votes (report_id);

-- ── Phase 5: Citizen Verifications ──────────────────────────
-- One verification per browser token per report
CREATE TABLE IF NOT EXISTS user_verifications (
    id           SERIAL PRIMARY KEY,
    report_id    INTEGER REFERENCES reports(id) ON DELETE CASCADE,
    voter_token  VARCHAR(100) NOT NULL,
    verified_at  TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (report_id, voter_token)
);
CREATE INDEX IF NOT EXISTS idx_user_verifications_report ON user_verifications (report_id);

-- ── Phase 5: Per-Report Chat ─────────────────────────────────
CREATE TABLE IF NOT EXISTS report_chat (
    id           SERIAL PRIMARY KEY,
    report_id    INTEGER REFERENCES reports(id) ON DELETE CASCADE,
    sender_role  VARCHAR(20) NOT NULL CHECK (sender_role IN ('citizen','authority','system')),
    sender_name  VARCHAR(100) NOT NULL DEFAULT 'Anonymous',
    message      TEXT NOT NULL,
    sent_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_report_chat_report_id ON report_chat (report_id);
CREATE INDEX IF NOT EXISTS idx_report_chat_sent_at   ON report_chat (sent_at DESC);

-- ── Helper: auto-flag emergency ──────────────────────────────
CREATE OR REPLACE FUNCTION update_emergency_flag()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.supporter_count >= 10 OR NEW.severity_level = 'critical' THEN
        NEW.is_emergency = TRUE;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_emergency_flag ON reports;
CREATE TRIGGER trg_emergency_flag
    BEFORE INSERT OR UPDATE ON reports
    FOR EACH ROW
    EXECUTE FUNCTION update_emergency_flag();

-- ─────────────────────────────────────────────────────────────
-- Done. Run seed.sql next to populate ward boundaries.
-- ─────────────────────────────────────────────────────────────
