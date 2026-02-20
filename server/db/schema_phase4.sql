-- ═══════════════════════════════════════════════════════════
-- CivicPulse — Phase 4 Migration: Transparency & Proof
-- Safe to re-run (IF NOT EXISTS guards)
-- ═══════════════════════════════════════════════════════════

-- ── Resolution Proof Photos ──────────────────────────────────
-- Stores the GPS-stamped "after" photo uploaded by the officer
-- when transitioning a report to RESOLVED state.
CREATE TABLE IF NOT EXISTS resolution_proofs (
    id              SERIAL PRIMARY KEY,
    report_id       INTEGER REFERENCES reports(id) ON DELETE CASCADE UNIQUE,
    after_image_url TEXT NOT NULL,
    officer_lat     DOUBLE PRECISION NOT NULL,
    officer_lon     DOUBLE PRECISION NOT NULL,
    distance_m      DOUBLE PRECISION NOT NULL,   -- Haversine dist from report GPS
    submitted_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_resolution_proofs_report_id
    ON resolution_proofs (report_id);

-- ── Citizen Acceptance Votes ─────────────────────────────────
-- Anonymous fingerprint-based voting — one vote per citizen per report.
CREATE TABLE IF NOT EXISTS acceptance_votes (
    id          SERIAL PRIMARY KEY,
    report_id   INTEGER REFERENCES reports(id) ON DELETE CASCADE,
    voter_token TEXT NOT NULL,                     -- SHA-like hash stored in localStorage
    vote        VARCHAR(10) NOT NULL CHECK (vote IN ('accept', 'reject')),
    voted_at    TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (report_id, voter_token)                -- one vote per browser per report
);

CREATE INDEX IF NOT EXISTS idx_acceptance_votes_report_id
    ON acceptance_votes (report_id);

-- ── Extend reports with resolution & acceptance tracking ─────
ALTER TABLE reports
    ADD COLUMN IF NOT EXISTS resolved_at          TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS accept_count         INTEGER DEFAULT 0,
    ADD COLUMN IF NOT EXISTS reject_count         INTEGER DEFAULT 0,
    ADD COLUMN IF NOT EXISTS resolution_accepted  BOOLEAN DEFAULT FALSE;

-- Index to efficiently query resolved reports for the public feed
CREATE INDEX IF NOT EXISTS idx_reports_resolved
    ON reports (state, resolved_at DESC)
    WHERE state = 'RESOLVED';
