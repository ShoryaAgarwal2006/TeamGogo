/**
 * routes/workflow.js — State Machine Transition API + Dashboard + Ward Performance
 */

const express = require('express');
const pool = require('../db/pool');
const { applyTransition, TRANSITIONS } = require('../lib/stateMachine');
const { generateWeeklyPendingReport } = require('../lib/escalation');

const router = express.Router();

/* ═══════════════════════════════════════════════════════════════
   PATCH /api/reports/:id/transition
   ═══════════════════════════════════════════════════════════════ */
router.patch('/reports/:id/transition', async (req, res) => {
    const { id } = req.params;
    const { toState, officerLat, officerLon, officerEmail, officerPhone } = req.body;

    if (!toState) return res.status(400).json({ error: 'toState is required' });

    const knownStates = Object.keys(TRANSITIONS);
    if (!knownStates.includes(toState)) {
        return res.status(400).json({ error: `Unknown state '${toState}'. Valid: ${knownStates.join(', ')}` });
    }

    try {
        const result = await applyTransition(id, toState, {
            officerLat: officerLat != null ? parseFloat(officerLat) : null,
            officerLon: officerLon != null ? parseFloat(officerLon) : null,
            officerEmail,
            officerPhone,
        });

        const stateEmojis = { VERIFIED: '✅', ASSIGNED: '👷', IN_PROGRESS: '🔧', RESOLVED: '🎉' };

        // Broadcast SSE
        if (global.sseClients && global.sseClients.size > 0) {
            const evt = JSON.stringify({ type: 'transition', reportId: parseInt(id), toState });
            global.sseClients.forEach(c => { try { c.write(`data: ${evt}\n\n`); } catch { } });
        }

        res.json({
            ...result,
            message: `${stateEmojis[toState] || '📋'} Report #${id} → ${result.transition.from} → ${result.transition.to}`,
        });

    } catch (err) {
        const status = err.status || 500;
        const response = { error: err.message };
        if (err.distanceMetres != null) response.distanceMetres = Math.round(err.distanceMetres);
        if (status === 409) response.validNextStates = TRANSITIONS[req.body.currentState] ?? [];
        res.status(status).json(response);
    }
});

/* ═══════════════════════════════════════════════════════════════
   GET /api/dashboard
   ═══════════════════════════════════════════════════════════════ */
router.get('/dashboard', async (req, res) => {
    try {
        const { status = 'all', limit = 100 } = req.query;

        const { rows } = await pool.query(`
            SELECT
                r.id, r.category, r.description, r.location_text, r.state,
                r.status, r.sla_level, r.supporter_count, r.image_url,
                r.severity_level, r.is_emergency, r.verification_count,
                r.gps_lat, r.gps_lon,
                r.assigned_at, r.verified_at, r.in_progress_at, r.resolved_at,
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
            ORDER BY r.is_emergency DESC, r.sla_level DESC, r.assigned_at ASC NULLS LAST, r.created_at DESC
            LIMIT $2
        `, [status === 'all' ? 'all' : status, parseInt(limit)]);

        const enriched = rows.map(r => {
            const hoursElapsed = parseFloat(r.hours_elapsed || 0);
            const slaLevel = r.sla_level || 0;

            let nextDeadlineHours = null;
            if (hoursElapsed < 72) nextDeadlineHours = 72;
            else if (hoursElapsed < 120) nextDeadlineHours = 120;
            else if (hoursElapsed < 168) nextDeadlineHours = 168;

            const hoursUntilNextEscalation = nextDeadlineHours
                ? Math.max(0, nextDeadlineHours - hoursElapsed) : 0;

            const sla_status =
                slaLevel >= 3 ? 'CRITICAL' :
                    slaLevel >= 2 ? 'URGENT' :
                        slaLevel >= 1 ? 'WARNING' :
                            hoursElapsed >= 48 ? 'WATCH' : 'ON_TRACK';

            return {
                ...r,
                hours_elapsed: Math.round(hoursElapsed * 10) / 10,
                hours_until_escalation: Math.round(hoursUntilNextEscalation * 10) / 10,
                next_deadline_hours: nextDeadlineHours,
                is_breached: slaLevel >= 2,
                is_critical: slaLevel >= 3,
                sla_status,
            };
        });

        const summary = {
            total: enriched.length,
            on_track: enriched.filter(r => r.sla_status === 'ON_TRACK' || r.sla_status === 'WATCH').length,
            warning: enriched.filter(r => r.sla_status === 'WARNING').length,
            urgent: enriched.filter(r => r.sla_status === 'URGENT').length,
            critical: enriched.filter(r => r.sla_status === 'CRITICAL').length,
            emergency: enriched.filter(r => r.is_emergency).length,
        };

        res.json({ reports: enriched, count: enriched.length, summary });

    } catch (err) {
        console.error('[API] GET /dashboard error:', err);
        res.status(500).json({ error: 'Failed to fetch dashboard data', detail: err.message });
    }
});

/* ═══════════════════════════════════════════════════════════════
   GET /api/ward-performance
   Per-ward stats: avg resolution time, on-time %, escalation rate
   ═══════════════════════════════════════════════════════════════ */
router.get('/ward-performance', async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT
                w.ward_id,
                w.ward_name,
                w.zone,
                w.officer_name,
                COUNT(r.id) FILTER (WHERE r.parent_report_id IS NULL AND r.state != 'MERGED') AS total_reports,
                COUNT(r.id) FILTER (WHERE r.state = 'RESOLVED') AS resolved_count,
                COUNT(r.id) FILTER (WHERE r.state NOT IN ('RESOLVED','MERGED') AND r.parent_report_id IS NULL) AS pending_count,
                COUNT(r.id) FILTER (WHERE r.sla_level >= 1) AS escalated_count,
                COUNT(r.id) FILTER (WHERE r.is_emergency = TRUE) AS emergency_count,
                ROUND(AVG(
                    CASE WHEN r.state = 'RESOLVED' AND r.resolved_at IS NOT NULL AND r.assigned_at IS NOT NULL
                    THEN EXTRACT(EPOCH FROM (r.resolved_at - r.assigned_at)) / 3600
                    END
                )::numeric, 1) AS avg_resolution_hours,
                ROUND(AVG(
                    CASE WHEN r.state = 'RESOLVED' AND r.resolved_at IS NOT NULL
                    THEN EXTRACT(EPOCH FROM (r.resolved_at - r.created_at)) / 3600
                    END
                )::numeric, 1) AS avg_total_hours,
                ROUND(
                    (COUNT(r.id) FILTER (
                        WHERE r.state = 'RESOLVED'
                          AND r.resolved_at IS NOT NULL
                          AND r.assigned_at IS NOT NULL
                          AND EXTRACT(EPOCH FROM (r.resolved_at - r.assigned_at))/3600 <= 72
                    ) * 100.0) /
                    NULLIF(COUNT(r.id) FILTER (WHERE r.state = 'RESOLVED'), 0),
                1) AS on_time_pct,
                ROUND(
                    (COUNT(r.id) FILTER (WHERE r.sla_level >= 1) * 100.0) /
                    NULLIF(COUNT(r.id) FILTER (WHERE r.parent_report_id IS NULL AND r.state != 'MERGED'), 0),
                1) AS escalation_rate_pct
            FROM city_wards w
            LEFT JOIN reports r ON r.ward_id = w.ward_id
            GROUP BY w.ward_id, w.ward_name, w.zone, w.officer_name
            ORDER BY resolved_count DESC, total_reports DESC
        `);

        res.json({ wards: rows, count: rows.length });
    } catch (err) {
        console.error('[API] GET /ward-performance error:', err);
        res.status(500).json({ error: 'Failed to fetch ward performance', detail: err.message });
    }
});

/* ═══════════════════════════════════════════════════════════════
   GET /api/reports/weekly-pending
   ═══════════════════════════════════════════════════════════════ */
router.get('/reports/weekly-pending', async (req, res) => {
    try {
        const reports = await generateWeeklyPendingReport();
        res.json({
            generated_at: new Date().toISOString(),
            period: 'Weekly',
            report_title: 'CivicPulse — Critical Pending Issues',
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
   GET /api/reports/:id/timeline
   ═══════════════════════════════════════════════════════════════ */
router.get('/reports/:id/timeline', async (req, res) => {
    const { id } = req.params;
    try {
        const { rows: reportRows } = await pool.query(`
            SELECT r.id, r.category, r.state, r.sla_level, r.severity_level,
                   r.is_emergency, r.supporter_count, r.verification_count,
                   r.created_at, r.verified_at, r.assigned_at, r.in_progress_at,
                   r.resolved_at, r.updated_at,
                   r.gps_lat, r.gps_lon, r.description, r.location_text, r.image_url,
                   w.ward_name, w.officer_name
            FROM reports r
            LEFT JOIN city_wards w ON r.ward_id = w.ward_id
            WHERE r.id = $1
        `, [id]);

        if (!reportRows.length) return res.status(404).json({ error: `Report #${id} not found` });
        const report = reportRows[0];

        // Escalation log
        const { rows: escLogs } = await pool.query(
            `SELECT level, action, recipient, sent_at, success, detail
             FROM escalation_log WHERE report_id = $1 ORDER BY sent_at ASC`,
            [id]
        );

        // Build timeline
        const timeline = [];
        if (report.created_at) timeline.push({ state: 'SUBMITTED', at: report.created_at, label: 'Report submitted by citizen' });
        if (report.verified_at) timeline.push({ state: 'VERIFIED', at: report.verified_at, label: 'Verified by citizens/system' });
        if (report.assigned_at) timeline.push({ state: 'ASSIGNED', at: report.assigned_at, label: `Assigned to ${report.officer_name || 'officer'} — SLA timer started` });
        if (report.in_progress_at) timeline.push({ state: 'IN_PROGRESS', at: report.in_progress_at, label: 'Officer checked in at location' });
        if (report.resolved_at || report.state === 'RESOLVED') timeline.push({ state: 'RESOLVED', at: report.resolved_at || report.updated_at, label: 'Issue resolved' });

        res.json({ report, timeline, escalations: escLogs });
    } catch (err) {
        console.error('[API] GET /reports/:id/timeline error:', err);
        res.status(500).json({ error: 'Failed to fetch timeline', detail: err.message });
    }
});

/* ═══════════════════════════════════════════════════════════════
   GET /api/reports/:id — Single report detail
   ═══════════════════════════════════════════════════════════════ */
router.get('/reports/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const { rows } = await pool.query(`
            SELECT r.*, w.ward_name, w.zone, w.officer_name, w.officer_email, w.officer_phone,
                   (SELECT COUNT(*) FROM report_chat WHERE report_id = r.id) AS chat_count,
                   (SELECT COUNT(*) FROM user_verifications WHERE report_id = r.id) AS verification_count_live
            FROM reports r
            LEFT JOIN city_wards w ON r.ward_id = w.ward_id
            WHERE r.id = $1
        `, [id]);
        if (!rows.length) return res.status(404).json({ error: `Report #${id} not found` });
        res.json({ report: rows[0] });
    } catch (err) {
        console.error('[API] GET /reports/:id error:', err);
        res.status(500).json({ error: 'Failed to fetch report', detail: err.message });
    }
});

module.exports = router;
