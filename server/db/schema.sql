-- ═══════════════════════════════════════════════════════════
-- CivicPulse — Phase 2 Database Schema
-- Requires: PostgreSQL ≥ 12 with PostGIS extension
-- ═══════════════════════════════════════════════════════════

-- Enable PostGIS
CREATE EXTENSION IF NOT EXISTS postgis;

-- ── City Wards ──────────────────────────────────────────────
-- Each ward is a geographic polygon (MultiPolygon) with an assigned officer.
CREATE TABLE IF NOT EXISTS city_wards (
    ward_id       SERIAL PRIMARY KEY,
    ward_name     VARCHAR(100)   NOT NULL,
    zone          VARCHAR(50),
    officer_name  VARCHAR(100)   NOT NULL,
    officer_email VARCHAR(150),
    officer_phone VARCHAR(20),
    ward_geometry GEOMETRY(MultiPolygon, 4326) NOT NULL
);

-- Spatial index for fast ST_Contains lookups
CREATE INDEX IF NOT EXISTS idx_wards_geometry
    ON city_wards USING GIST (ward_geometry);

-- ── Reports ─────────────────────────────────────────────────
-- Every civic issue report. Supports self-referential merging via parent_report_id.
CREATE TABLE IF NOT EXISTS reports (
    id                SERIAL PRIMARY KEY,
    category          VARCHAR(50)    NOT NULL,
    description       TEXT           NOT NULL,
    location_text     VARCHAR(255),
    coordinates       GEOMETRY(Point, 4326),

    -- Ward assignment (populated by point-in-polygon)
    ward_id           INTEGER REFERENCES city_wards(ward_id) ON DELETE SET NULL,

    -- Image
    image_url         TEXT,

    -- Digital signature fields from EXIF
    gps_lat           DOUBLE PRECISION,
    gps_lon           DOUBLE PRECISION,
    capture_timestamp TIMESTAMPTZ,

    -- Duplicate merging
    parent_report_id  INTEGER REFERENCES reports(id) ON DELETE SET NULL,
    supporter_count   INTEGER DEFAULT 1,

    -- Status workflow
    status            VARCHAR(20) DEFAULT 'active'
                      CHECK (status IN ('active', 'in_progress', 'resolved', 'merged')),

    created_at        TIMESTAMPTZ DEFAULT NOW(),
    updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- Spatial index for 50m buffer duplicate detection (ST_DWithin)
CREATE INDEX IF NOT EXISTS idx_reports_coordinates
    ON reports USING GIST (coordinates);

-- Index for fast category + status lookups during dedup
CREATE INDEX IF NOT EXISTS idx_reports_category_status
    ON reports (category, status)
    WHERE status = 'active' AND parent_report_id IS NULL;

-- Updated-at trigger
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reports_updated_at
    BEFORE UPDATE ON reports
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ── Push Subscriptions ──────────────────────────────────────
-- Store Web Push subscriptions so we can notify original reporters
-- when a duplicate is detected ("Another neighbor supported your report!")
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id           SERIAL PRIMARY KEY,
    endpoint     TEXT UNIQUE NOT NULL,      -- Browser push endpoint URL
    p256dh       TEXT NOT NULL,             -- Browser public key (base64url)
    auth         TEXT NOT NULL,             -- Auth secret (base64url)
    report_id    INTEGER REFERENCES reports(id) ON DELETE CASCADE,
    created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_report_id
    ON push_subscriptions (report_id);
