/**
 * routes/push.js — Web Push Subscription Management
 *
 * GET  /api/push/vapid-public-key  — Return VAPID public key to browser
 * POST /api/push/subscribe          — Save a push subscription for a report
 * DELETE /api/push/unsubscribe      — Remove a push subscription by endpoint
 */

const express = require('express');
const webPush = require('web-push');
const pool = require('../db/pool');

const router = express.Router();

// ── Configure VAPID ────────────────────────────────────────────
webPush.setVapidDetails(
    process.env.VAPID_CONTACT || 'mailto:admin@civicpulse.gov.in',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
);

/* ═══════════════════════════════════════════════════════════════
   GET /api/push/vapid-public-key
   Returns the VAPID public key so the browser can create a
   PushSubscription via pushManager.subscribe({ applicationServerKey })
   ═══════════════════════════════════════════════════════════════ */
router.get('/vapid-public-key', (req, res) => {
    const key = process.env.VAPID_PUBLIC_KEY;
    if (!key) {
        return res.status(500).json({ error: 'VAPID keys not configured on server' });
    }
    res.json({ publicKey: key });
});

/* ═══════════════════════════════════════════════════════════════
   POST /api/push/subscribe
   Body: { endpoint, keys: { p256dh, auth }, reportId }
   Associates a push subscription with an existing report so we
   can notify when a duplicate is merged into it.
   ═══════════════════════════════════════════════════════════════ */
router.post('/subscribe', async (req, res) => {
    try {
        const { endpoint, keys, reportId } = req.body;

        if (!endpoint || !keys?.p256dh || !keys?.auth) {
            return res.status(400).json({
                error: 'endpoint and keys (p256dh, auth) are required',
            });
        }

        // Upsert: if this endpoint already exists, update the reportId association
        const upsertQuery = `
      INSERT INTO push_subscriptions (endpoint, p256dh, auth, report_id)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (endpoint)
      DO UPDATE SET report_id = EXCLUDED.report_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth
      RETURNING id;
    `;
        const result = await pool.query(upsertQuery, [
            endpoint,
            keys.p256dh,
            keys.auth,
            reportId || null,
        ]);

        console.log(`[Push] Subscription saved id=${result.rows[0].id} for report #${reportId || 'none'}`);
        res.status(201).json({ success: true, subscriptionId: result.rows[0].id });

    } catch (err) {
        console.error('[Push] POST /subscribe error:', err);
        res.status(500).json({ error: 'Failed to save subscription', detail: err.message });
    }
});

/* ═══════════════════════════════════════════════════════════════
   DELETE /api/push/unsubscribe
   Body: { endpoint }
   ═══════════════════════════════════════════════════════════════ */
router.delete('/unsubscribe', async (req, res) => {
    try {
        const { endpoint } = req.body;
        if (!endpoint) return res.status(400).json({ error: 'endpoint is required' });

        await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
        res.json({ success: true });

    } catch (err) {
        console.error('[Push] DELETE /unsubscribe error:', err);
        res.status(500).json({ error: 'Failed to remove subscription', detail: err.message });
    }
});

/* ═══════════════════════════════════════════════════════════════
   Exported helper: sendSupportNotification(parentReportId, supporterCount)
   Called from reports.js after a duplicate merge.
   ═══════════════════════════════════════════════════════════════ */
async function sendSupportNotification(parentReportId, supporterCount) {
    try {
        // Get all subscriptions watching this report
        const { rows } = await pool.query(
            'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE report_id = $1',
            [parentReportId]
        );

        if (!rows.length) return;

        const payload = JSON.stringify({
            title: 'CivicPulse 🏛️',
            body: `Another neighbor just supported your report! ${supporterCount} people now backing this issue.`,
            reportId: parentReportId,
            supporterCount,
        });

        const staleEndpoints = [];

        await Promise.allSettled(
            rows.map(async (sub) => {
                const subscription = {
                    endpoint: sub.endpoint,
                    keys: { p256dh: sub.p256dh, auth: sub.auth },
                };
                try {
                    await webPush.sendNotification(subscription, payload);
                    console.log(`[Push] Sent support notification to ${sub.endpoint.slice(0, 40)}…`);
                } catch (err) {
                    if (err.statusCode === 410 || err.statusCode === 404) {
                        // Subscription expired — remove it
                        staleEndpoints.push(sub.endpoint);
                        console.log(`[Push] Stale subscription removed: ${sub.endpoint.slice(0, 40)}…`);
                    } else {
                        console.error('[Push] sendNotification error:', err.message);
                    }
                }
            })
        );

        // Clean up expired subscriptions
        if (staleEndpoints.length > 0) {
            await pool.query(
                'DELETE FROM push_subscriptions WHERE endpoint = ANY($1)',
                [staleEndpoints]
            );
        }

    } catch (err) {
        console.error('[Push] sendSupportNotification error:', err.message);
        // Don't rethrow — push failure should NOT fail the report submission
    }
}

module.exports = router;
module.exports.sendSupportNotification = sendSupportNotification;
