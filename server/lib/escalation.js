/**
 * lib/escalation.js — CivicPulse Multi-Tier SLA Escalation Engine
 *
 * Runs via node-cron every 15 minutes.
 * Checks all ASSIGNED/IN_PROGRESS reports against SLA thresholds:
 *
 *   Level 1 — 72 hours:  Email Junior Engineer (ward officer)
 *   Level 2 — 120 hours: Email + SMS Executive Engineer, dashboard turns red
 *   Level 3 — 168 hours: Add to Commissioner weekly report email
 *
 * All escalations are idempotent — skip if already at that level.
 * Each action is logged in the escalation_log table.
 */

const cron = require('node-cron');
const pool = require('../db/pool');
const { sendEscalationEmail } = require('./mailer');
const { sendSMS, buildEscalationSMS } = require('./sms');

// SLA thresholds in hours
const SLA_HOURS = { L1: 72, L2: 120, L3: 168 };

/**
 * runEscalationCheck()
 * Queries DB for breached reports and escalates them.
 */
async function runEscalationCheck() {
    console.log('[Escalation] 🔍 Running SLA check…');

    try {
        // Fetch all ASSIGNED or IN_PROGRESS reports that have exceeded L1 threshold
        // and haven't yet reached L3 (L3 is the maximum level)
        const { rows: reports } = await pool.query(`
      SELECT
        r.id, r.category, r.description, r.location_text, r.state,
        r.gps_lat, r.gps_lon, r.supporter_count, r.sla_level,
        r.assigned_at, r.assigned_officer_email, r.assigned_officer_phone,
        r.last_escalated_at,
        w.ward_name, w.officer_name, w.officer_email, w.officer_phone
      FROM reports r
      LEFT JOIN city_wards w ON r.ward_id = w.ward_id
      WHERE r.state IN ('ASSIGNED', 'IN_PROGRESS')
        AND r.assigned_at IS NOT NULL
        AND r.sla_level < 3
        AND r.assigned_at < NOW() - INTERVAL '${SLA_HOURS.L1} hours'
      ORDER BY r.assigned_at ASC
    `);

        if (!reports.length) {
            console.log('[Escalation] ✅ No SLA breaches found');
            return;
        }

        console.log(`[Escalation] Found ${reports.length} report(s) requiring escalation`);

        for (const report of reports) {
            await escalateReport(report);
        }

    } catch (err) {
        console.error('[Escalation] Error during SLA check:', err.message);
    }
}

/**
 * escalateReport(report)
 * Determines the correct escalation level and fires notifications.
 */
async function escalateReport(report) {
    const hoursElapsed = Math.floor(
        (Date.now() - new Date(report.assigned_at).getTime()) / 3_600_000
    );

    let targetLevel;
    if (hoursElapsed >= SLA_HOURS.L3) targetLevel = 3;
    else if (hoursElapsed >= SLA_HOURS.L2) targetLevel = 2;
    else if (hoursElapsed >= SLA_HOURS.L1) targetLevel = 1;
    else return; // Not yet breached (shouldn't happen due to WHERE clause, but guard anyway)

    // Idempotent: skip if already at this level
    if (report.sla_level >= targetLevel) return;

    console.log(`[Escalation] Report #${report.id} → L${targetLevel} (${hoursElapsed}h elapsed)`);

    const actions = [];

    if (targetLevel === 1) {
        // ── Level 1: Email Junior Engineer (ward officer) ──────────
        const recipient = report.officer_email || report.assigned_officer_email;
        const recipientName = report.officer_name || 'Junior Engineer';

        if (recipient) {
            const result = await sendEscalationEmail({
                level: 1,
                report: { ...report, ward_name: report.ward_name },
                recipient,
                recipientName,
            });
            actions.push({ action: 'email_l1', recipient, ...result });
        } else {
            console.warn(`[Escalation] L1: No email for report #${report.id}`);
            actions.push({ action: 'email_l1', recipient: 'NONE', success: false, detail: 'No officer email' });
        }
    }

    if (targetLevel === 2) {
        // ── Level 2: Email + SMS Executive Engineer ────────────────
        const execEmail = process.env.EXEC_ENG_EMAIL || 'exec.engineer@mcd.gov.in';
        const execPhone = process.env.EXEC_ENG_PHONE || '+91-98100-00001';
        const execName = process.env.EXEC_ENG_NAME || 'Executive Engineer';

        // Also re-escalate L1 if jumping from L0 to L2
        const wardEmail = report.officer_email || report.assigned_officer_email;
        if (wardEmail) {
            const r1 = await sendEscalationEmail({ level: 1, report, recipient: wardEmail, recipientName: report.officer_name || 'Officer' });
            actions.push({ action: 'email_l1', recipient: wardEmail, ...r1 });
        }

        const r2 = await sendEscalationEmail({ level: 2, report, recipient: execEmail, recipientName: execName });
        actions.push({ action: 'email_l2', recipient: execEmail, ...r2 });

        const smsResult = await sendSMS(execPhone, buildEscalationSMS(2, report));
        actions.push({ action: 'sms_l2', recipient: execPhone, ...smsResult });
    }

    if (targetLevel === 3) {
        // ── Level 3: Email Commissioner + weekly report ────────────
        const commEmail = process.env.COMMISSIONER_EMAIL || 'commissioner@mcd.gov.in';
        const commName = process.env.COMMISSIONER_NAME || 'Commissioner';

        const r3 = await sendEscalationEmail({ level: 3, report, recipient: commEmail, recipientName: commName });
        actions.push({ action: 'email_l3', recipient: commEmail, ...r3 });

        const commPhone = process.env.COMMISSIONER_PHONE;
        if (commPhone) {
            const smsResult = await sendSMS(commPhone, buildEscalationSMS(3, report));
            actions.push({ action: 'sms_l3', recipient: commPhone, ...smsResult });
        }
    }

    // ── Update sla_level + log ──────────────────────────────────
    await pool.query(
        `UPDATE reports SET sla_level = $1, last_escalated_at = NOW() WHERE id = $2`,
        [targetLevel, report.id]
    );

    // Insert into audit log
    for (const action of actions) {
        await pool.query(
            `INSERT INTO escalation_log (report_id, level, action, recipient, success, detail)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
                report.id,
                targetLevel,
                action.action,
                action.recipient || null,
                action.success ?? true,
                action.previewUrl || action.error || action.mock ? '[mock]' : null,
            ]
        );
    }

    console.log(`[Escalation] Report #${report.id} escalated to L${targetLevel} ✅`);
}

/**
 * startCron()
 * Starts the escalation cron job.
 * Schedule: every 15 minutes.
 */
function startCron() {
    console.log('[Escalation] Cron started — checking SLA every 15 minutes');

    // Run once immediately on startup (helps dev testing)
    runEscalationCheck().catch(console.error);

    cron.schedule('*/15 * * * *', () => {
        runEscalationCheck().catch(console.error);
    });
}

/**
 * generateWeeklyPendingReport()
 * Returns all L3 reports — used by GET /api/reports/weekly-pending
 */
async function generateWeeklyPendingReport() {
    const { rows } = await pool.query(`
    SELECT
      r.id, r.category, r.description, r.location_text, r.state,
      r.sla_level, r.assigned_at, r.supporter_count, r.last_escalated_at,
      r.gps_lat, r.gps_lon,
      w.ward_name, w.zone, w.officer_name, w.officer_email
    FROM reports r
    LEFT JOIN city_wards w ON r.ward_id = w.ward_id
    WHERE r.sla_level >= 3
      AND r.state NOT IN ('RESOLVED', 'MERGED')
    ORDER BY r.assigned_at ASC
  `);
    return rows;
}

module.exports = { startCron, runEscalationCheck, generateWeeklyPendingReport };
