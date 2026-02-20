/**
 * routes/workflow.js — State Machine Transition API + Dashboard Data
 *
 * PATCH /api/reports/:id/transition  — Apply a state machine transition
 * GET   /api/dashboard               — All reports with SLA metadata
 * GET   /api/reports/weekly-pending  — L3 reports for Commissioner
 */

const express = require('express');
const pool = require('../db/pool');
const { applyTransition, TRANSITIONS } = require('../lib/stateMachine');
const { generateWeeklyPendingReport } = require('../lib/escalation');

const router = express.Router();

/* ═══════════════════════════════════════════════════════════════
   PATCH /api/reports/:id/transition
   Body: { toState, officerLat?, officerLon?, officerEmail?, officerPhone? }

   Applies a strict state machine transition with guards.
   Returns 409 for invalid transitions, 403 if geo-fence fails.
   ═══════════════════════════════════════════════════════════════ */
router.patch('/reports/:id/transition', async (req, res) => {
    const { id } = req.params;
    const { toState, officerLat, officerLon, officerEmail, officerPhone } = req.body;

    if (!toState) {
        return res.status(400).json({ error: 'toState is required' });
    }

    // Validate toState is a known state
    const knownStates = Object.keys(TRANSITIONS);
    if (!knownStates.includes(toState)) {
        return res.status(400).json({
            error: `Unknown state '${toState}'. Valid states: ${knownStates.join(', ')}`,
        });
    }

    try {
        const result = await applyTransition(id, toState, {
            officerLat: officerLat != null ? parseFloat(officerLat) : null,
            officerLon: officerLon != null ? parseFloat(officerLon) : null,
            officerEmail,
            officerPhone,
        });

        // Build friendly message
        const stateEmojis = {
            VERIFIED: '✅',
            ASSIGNED: '👷',
            IN_PROGRESS: '🔧',
            RESOLVED: '🎉',
        };

        res.json({
            ...result,
            message: `${stateEmojis[toState] || '📋'} Report #${id} transitioned from ${result.transition.from} → ${result.transition.to}`,
        });

    } catch (err) {
        const status = err.status || 500;
        const response = {
            error: err.message,
            // Include distance info for geo-fence errors
            ...(err.distanceMetres != null && { distanceMetres: Math.round(err.distanceMetres) }),
        };
        if (status === 409) {
            response.validNextStates = TRANSITIONS[req.body.currentState] ?? [];
        }
        res.status(status).json(response);
    }
});

/* ═══════════════════════════════════════════════════════════════
   GET /api/dashboard
   Returns all non-MERGED reports enriched with SLA timing data.

   Each report includes:
     • sla_hours    — hours since assigned_at (or created_at if not yet assigned)
     • sla_deadline — target hours for next escalation level
     • is_breached  — true if sla_level >= 2 (dashboard turns report red)
     • state_label  — friendly display label
   ═══════════════════════════════════════════════════════════════ */
router.get('/dashboard', async (req, res) => {
    try {
        const { status = 'all', limit = 100 } = req.query;

        const query = `
      SELECT
        r.id, r.category, r.description, r.location_text, r.state,
        r.status, r.sla_level, r.supporter_count, r.image_url,
        r.gps_lat, r.gps_lon,
        r.assigned_at, r.verified_at, r.in_progress_at,
        r.last_escalated_at, r.created_at, r.updated_at,
        r.assigned_officer_email,
        w.ward_name, w.zone, w.officer_name, w.officer_email, w.officer_phone,
        EXTRACT(EPOCH FROM (NOW() - COALESCE(r.assigned_at, r.created_at))) / 3600
          AS hours_elapsed
      FROM reports r
      LEFT JOIN city_wards w ON r.ward_id = w.ward_id
      WHERE r.state NOT IN ('MERGED')
        AND r.parent_report_id IS NULL
        AND ($1 = 'all' OR r.state = $1)
      ORDER BY r.sla_level DESC, r.assigned_at ASC NULLS LAST, r.created_at DESC
      LIMIT $2;
    `;

        const { rows } = await pool.query(query, [status === 'all' ? 'all' : status, parseInt(limit)]);

        // Enrich each report with SLA metadata
        const enriched = rows.map((r) => {
            const hoursElapsed = parseFloat(r.hours_elapsed || 0);
            const slaLevel = r.sla_level || 0;

            // Deadline for NEXT escalation level
            let nextDeadlineHours = null;
            if (hoursElapsed < 72) nextDeadlineHours = 72;
            else if (hoursElapsed < 120) nextDeadlineHours = 120;
            else if (hoursElapsed < 168) nextDeadlineHours = 168;

            const hoursUntilNextEscalation = nextDeadlineHours
                ? Math.max(0, nextDeadlineHours - hoursElapsed)
                : 0;

            return {
                ...r,
                hours_elapsed: Math.round(hoursElapsed * 10) / 10,
                hours_until_escalation: Math.round(hoursUntilNextEscalation * 10) / 10,
                next_deadline_hours: nextDeadlineHours,
                is_breached: slaLevel >= 2,
                is_critical: slaLevel >= 3,
                sla_status:
                    slaLevel >= 3 ? 'CRITICAL'
                        : slaLevel >= 2 ? 'URGENT'
                            : slaLevel >= 1 ? 'WARNING'
                                : hoursElapsed >= 48 ? 'WATCH'
                                    : 'ON_TRACK',
            };
        });

        res.json({
            reports: enriched,
            count: enriched.length,
            summary: {
                total: enriched.length,
                on_track: enriched.filter(r => r.sla_status === 'ON_TRACK' || r.sla_status === 'WATCH').length,
                warning: enriched.filter(r => r.sla_status === 'WARNING').length,
                urgent: enriched.filter(r => r.sla_status === 'URGENT').length,
                critical: enriched.filter(r => r.sla_status === 'CRITICAL').length,
            },
        });

    } catch (err) {
        console.error('[API] GET /dashboard error:', err);
        res.status(500).json({ error: 'Failed to fetch dashboard data', detail: err.message });
    }
});

/* ═══════════════════════════════════════════════════════════════
   GET /api/reports/weekly-pending
   Returns all L3 (Commissioner-level) pending reports.
   Used for the Mayor/Commissioner weekly digest.
   ═══════════════════════════════════════════════════════════════ */
router.get('/reports/weekly-pending', async (req, res) => {
    try {
        const reports = await generateWeeklyPendingReport();

        res.json({
            generated_at: new Date().toISOString(),
            period: 'Weekly',
            report_title: 'CivicPulse — Critical Pending Issues — Commissioner Review',
            count: reports.length,
            reports: reports.map(r => ({
                ...r,
                hours_pending: r.assigned_at
                    ? Math.floor((Date.now() - new Date(r.assigned_at).getTime()) / 3_600_000)
                    : null,
            })),
        });

    } catch (err) {
        console.error('[API] GET /weekly-pending error:', err);
        res.status(500).json({ error: 'Failed to generate weekly report', detail: err.message });
    }
});

/* ═══════════════════════════════════════════════════════════════
   GET /api/reports/:id/timeline  — State transition + escalation history
   ═══════════════════════════════════════════════════════════════ */
router.get('/reports/:id/timeline', async (req, res) => {
    const { id } = req.params;
    try {
        // Get report details
        const { rows: reportRows } = await pool.query(
            `SELECT r.id, r.category, r.state, r.sla_level,
                    r.created_at, r.verified_at, r.assigned_at, r.in_progress_at, r.updated_at,
                    w.ward_name, w.officer_name
             FROM reports r
             LEFT JOIN city_wards w ON r.ward_id = w.ward_id
             WHERE r.id = $1`,
            [id]
        );

        if (!reportRows.length) {
            return res.status(404).json({ error: `Report #${id} not found` });
        }

        const report = reportRows[0];

        // Get escalation log
        const { rows: escLogs } = await pool.query(
            `SELECT level, action, recipient, sent_at, success, detail
             FROM escalation_log WHERE report_id = $1 ORDER BY sent_at ASC`,
            [id]
        );

        // Build timeline from timestamps
        const timeline = [];
        if (report.created_at) timeline.push({ state: 'SUBMITTED', at: report.created_at, label: 'Report submitted by citizen' });
        if (report.verified_at) timeline.push({ state: 'VERIFIED', at: report.verified_at, label: 'Verified by system/moderator' });
        if (report.assigned_at) timeline.push({ state: 'ASSIGNED', at: report.assigned_at, label: `Assigned to ${report.officer_name || 'officer'} — SLA timer started` });
        if (report.in_progress_at) timeline.push({ state: 'IN_PROGRESS', at: report.in_progress_at, label: 'Officer checked in at location' });
        if (report.state === 'RESOLVED') timeline.push({ state: 'RESOLVED', at: report.updated_at, label: 'Issue resolved' });

        res.json({ report, timeline, escalations: escLogs });

    } catch (err) {
        console.error('[API] GET /reports/:id/timeline error:', err);
        res.status(500).json({ error: 'Failed to fetch timeline', detail: err.message });
    }
});

module.exports = router;
