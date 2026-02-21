/**
 * lib/escalation.js — CivicPulse Multi-Tier SLA Escalation + Auto-Promotion Engine
 *
 * Phase 5 additions:
 *  • Auto-escalation: reports stuck in SUBMITTED/VERIFIED for >72h are auto-promoted
 *  • 3-day rule: SUBMITTED → auto VERIFIED after 72h, VERIFIED → auto ASSIGNED after 72h
 */

const cron = require('node-cron');
const pool = require('../db/pool');
const { sendEscalationEmail } = require('./mailer');
const { sendSMS, buildEscalationSMS } = require('./sms');

const SLA_HOURS = { L1: 72, L2: 120, L3: 168 };

/* ─────────────────────────────────────────────────────────────
   Auto-Promotion: SUBMITTED → VERIFIED (72h)
                   VERIFIED  → ASSIGNED  (72h further)
   ─────────────────────────────────────────────────────────────*/
async function runAutoPromotion() {
    console.log('[AutoPromotion] 🔄 Running auto-promotion check…');
    try {
        // SUBMITTED → VERIFIED (older than 72h, no one verified it)
        const { rowCount: verifiedCount } = await pool.query(`
            UPDATE reports
            SET state = 'VERIFIED',
                verified_at = NOW(),
                auto_escalated_at = NOW(),
                sla_level = GREATEST(sla_level, 1)
            WHERE state = 'SUBMITTED'
              AND parent_report_id IS NULL
              AND created_at < NOW() - INTERVAL '72 hours'
        `);
        if (verifiedCount > 0) {
            console.log(`[AutoPromotion] ✅ ${verifiedCount} SUBMITTED → VERIFIED`);
        }

        // VERIFIED → ASSIGNED (stuck verified for >72h, assign to ward officer)
        const { rows: verifiedReports } = await pool.query(`
            SELECT r.id, r.category, r.description, w.officer_email, w.officer_name, w.officer_phone, w.ward_name
            FROM reports r
            LEFT JOIN city_wards w ON r.ward_id = w.ward_id
            WHERE r.state = 'VERIFIED'
              AND r.parent_report_id IS NULL
              AND r.verified_at < NOW() - INTERVAL '72 hours'
        `);
        for (const r of verifiedReports) {
            await pool.query(`
                UPDATE reports
                SET state = 'ASSIGNED',
                    assigned_at = NOW(),
                    auto_escalated_at = NOW(),
                    assigned_officer_email = $2,
                    sla_level = GREATEST(sla_level, 1)
                WHERE id = $1
            `, [r.id, r.officer_email || null]);
            console.log(`[AutoPromotion] 👷 Report #${r.id} → ASSIGNED (72h auto)`);
        }

        // ASSIGNED → IN_PROGRESS (stuck assigned for >72h — send urgent notification but DO NOT geo-fence auto-start)
        const { rowCount: urgentCount } = await pool.query(`
            UPDATE reports
            SET sla_level = GREATEST(sla_level, 2),
                last_escalated_at = NOW()
            WHERE state = 'ASSIGNED'
              AND parent_report_id IS NULL
              AND assigned_at < NOW() - INTERVAL '120 hours'
              AND sla_level < 2
        `);
        if (urgentCount > 0) {
            console.log(`[AutoPromotion] 🔴 ${urgentCount} ASSIGNED reports marked URGENT`);
        }

    } catch (err) {
        console.error('[AutoPromotion] Error:', err.message);
    }
}

/* ─────────────────────────────────────────────────────────────
   SLA Escalation Check (for ASSIGNED/IN_PROGRESS reports)
   ─────────────────────────────────────────────────────────────*/
async function runEscalationCheck() {
    console.log('[Escalation] 🔍 Running SLA check…');
    try {
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
        for (const report of reports) await escalateReport(report);

    } catch (err) {
        console.error('[Escalation] Error during SLA check:', err.message);
    }
}

async function escalateReport(report) {
    const hoursElapsed = Math.floor(
        (Date.now() - new Date(report.assigned_at).getTime()) / 3_600_000
    );

    let targetLevel;
    if (hoursElapsed >= SLA_HOURS.L3) targetLevel = 3;
    else if (hoursElapsed >= SLA_HOURS.L2) targetLevel = 2;
    else if (hoursElapsed >= SLA_HOURS.L1) targetLevel = 1;
    else return;

    if (report.sla_level >= targetLevel) return;

    console.log(`[Escalation] Report #${report.id} → L${targetLevel} (${hoursElapsed}h elapsed)`);
    const actions = [];

    if (targetLevel === 1) {
        const recipient = report.officer_email || report.assigned_officer_email;
        const recipientName = report.officer_name || 'Junior Engineer';
        if (recipient) {
            const result = await sendEscalationEmail({ level: 1, report, recipient, recipientName });
            actions.push({ action: 'email_l1', recipient, ...result });
        } else {
            actions.push({ action: 'email_l1', recipient: 'NONE', success: false, detail: 'No officer email' });
        }
    }

    if (targetLevel === 2) {
        const execEmail = process.env.EXEC_ENG_EMAIL || 'exec.engineer@mcd.gov.in';
        const execPhone = process.env.EXEC_ENG_PHONE || '+91-98100-00001';
        const execName = process.env.EXEC_ENG_NAME || 'Executive Engineer';
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

    await pool.query(
        `UPDATE reports SET sla_level = $1, last_escalated_at = NOW() WHERE id = $2`,
        [targetLevel, report.id]
    );

    for (const action of actions) {
        await pool.query(
            `INSERT INTO escalation_log (report_id, level, action, recipient, success, detail)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
                report.id, targetLevel, action.action,
                action.recipient || null,
                action.success ?? true,
                action.previewUrl || action.error || action.mock ? '[mock]' : null,
            ]
        );
    }

    console.log(`[Escalation] Report #${report.id} escalated to L${targetLevel} ✅`);
}

function startCron() {
    console.log('[Escalation] Cron started — checking SLA every 15 min, auto-promote every 30 min');

    // Run immediately on startup
    runEscalationCheck().catch(console.error);
    runAutoPromotion().catch(console.error);

    // SLA escalation every 15 minutes
    cron.schedule('*/15 * * * *', () => {
        runEscalationCheck().catch(console.error);
    });

    // Auto-promotion every 30 minutes
    cron.schedule('*/30 * * * *', () => {
        runAutoPromotion().catch(console.error);
    });
}

async function generateWeeklyPendingReport() {
    const { rows } = await pool.query(`
        SELECT
            r.id, r.category, r.description, r.location_text, r.state,
            r.sla_level, r.assigned_at, r.supporter_count, r.last_escalated_at,
            r.gps_lat, r.gps_lon, r.severity_level,
            w.ward_name, w.zone, w.officer_name, w.officer_email
        FROM reports r
        LEFT JOIN city_wards w ON r.ward_id = w.ward_id
        WHERE r.sla_level >= 3
          AND r.state NOT IN ('RESOLVED', 'MERGED')
        ORDER BY r.assigned_at ASC
    `);
    return rows;
}

module.exports = { startCron, runEscalationCheck, runAutoPromotion, generateWeeklyPendingReport };
