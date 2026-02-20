-- ═══════════════════════════════════════════════════════════
-- CivicPulse — Phase 3 Migration: Accountability Engine
-- Safe to re-run (uses IF NOT EXISTS / IF EXISTS guards)
-- ═══════════════════════════════════════════════════════════

-- ── Extend reports with State Machine + SLA columns ─────────
ALTER TABLE reports
    ADD COLUMN IF NOT EXISTS state                 VARCHAR(30) DEFAULT 'SUBMITTED'
        CHECK (state IN ('SUBMITTED','VERIFIED','ASSIGNED','IN_PROGRESS','RESOLVED','MERGED')),
    ADD COLUMN IF NOT EXISTS verified_at           TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS assigned_at           TIMESTAMPTZ,   -- SLA timer starts here
    ADD COLUMN IF NOT EXISTS in_progress_at        TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS sla_level             INTEGER DEFAULT 0,
        -- 0 = on-track, 1 = L1 (72h), 2 = L2 (120h), 3 = L3 (168h)
    ADD COLUMN IF NOT EXISTS last_escalated_at     TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS assigned_officer_email VARCHAR(150),
    ADD COLUMN IF NOT EXISTS assigned_officer_phone VARCHAR(20);

-- Back-fill existing rows: map old status → new state
UPDATE reports SET state = 'MERGED'      WHERE state IS NULL AND status = 'merged';
UPDATE reports SET state = 'IN_PROGRESS' WHERE state IS NULL AND status = 'in_progress';
UPDATE reports SET state = 'RESOLVED'    WHERE state IS NULL AND status = 'resolved';
UPDATE reports SET state = 'SUBMITTED'   WHERE state IS NULL;

-- Index for escalation cron (scans ASSIGNED/IN_PROGRESS with low sla_level)
CREATE INDEX IF NOT EXISTS idx_reports_escalation
    ON reports (state, sla_level, assigned_at)
    WHERE state IN ('ASSIGNED', 'IN_PROGRESS') AND assigned_at IS NOT NULL;

-- ── Escalation Audit Log ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS escalation_log (
    id          SERIAL PRIMARY KEY,
    report_id   INTEGER REFERENCES reports(id) ON DELETE CASCADE,
    level       INTEGER NOT NULL,
    action      VARCHAR(50) NOT NULL,   -- 'email_l1', 'email_l2', 'sms_l2', 'email_l3'
    recipient   TEXT,
    sent_at     TIMESTAMPTZ DEFAULT NOW(),
    success     BOOLEAN DEFAULT TRUE,
    detail      TEXT                    -- preview URL (Ethereal) or error message
);

CREATE INDEX IF NOT EXISTS idx_escalation_log_report_id
    ON escalation_log (report_id);
