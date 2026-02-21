/**
 * routes/verify.js — Citizen Verification (One-per-user per report)
 *
 * POST /api/reports/:id/verify
 * Body: { voter_token: string }
 *
 * Inserts into user_verifications (unique constraint prevents duplicates).
 * Increments supporter_count on the parent report.
 * If report is in SUBMITTED state, auto-transitions to VERIFIED.
 */

const express = require('express');
const pool = require('../db/pool');
const router = express.Router();

router.post('/reports/:id/verify', async (req, res) => {
    const { id } = req.params;
    const { voter_token } = req.body;

    if (!voter_token || voter_token.length < 8) {
        return res.status(400).json({ error: 'voter_token is required (min 8 chars)' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Fetch report
        const { rows: rr } = await client.query(
            'SELECT id, state, supporter_count, verification_count FROM reports WHERE id = $1 FOR UPDATE',
            [id]
        );
        if (!rr.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: `Report #${id} not found` });
        }
        const report = rr[0];

        // Check not already verified by this user
        const { rows: existing } = await client.query(
            'SELECT id FROM user_verifications WHERE report_id = $1 AND voter_token = $2',
            [id, voter_token]
        );
        if (existing.length) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'You have already verified this report', alreadyVerified: true });
        }

        // Insert verification
        await client.query(
            'INSERT INTO user_verifications (report_id, voter_token) VALUES ($1, $2)',
            [id, voter_token]
        );

        // Bump verification_count and supporter_count
        const { rows: updated } = await client.query(
            `UPDATE reports
             SET verification_count = verification_count + 1,
                 supporter_count    = supporter_count + 1,
                 state = CASE WHEN state = 'SUBMITTED' THEN 'VERIFIED' ELSE state END,
                 verified_at = CASE WHEN state = 'SUBMITTED' THEN NOW() ELSE verified_at END
             WHERE id = $1
             RETURNING id, state, verification_count, supporter_count`,
            [id]
        );

        await client.query('COMMIT');

        const result = updated[0];

        // Broadcast SSE
        if (global.sseClients) {
            const evt = JSON.stringify({ type: 'verify', reportId: parseInt(id), verificationCount: result.verification_count });
            global.sseClients.forEach(c => c.write(`data: ${evt}\n\n`));
        }

        res.json({
            success: true,
            autoVerified: result.state === 'VERIFIED',
            verificationCount: result.verification_count,
            supporterCount: result.supporter_count,
            message: result.state === 'VERIFIED'
                ? `✅ Verified! This report has been confirmed by ${result.verification_count} citizen(s) and promoted to Verified status.`
                : `👍 Thank you! ${result.verification_count} citizen(s) have verified this report.`,
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[Verify] POST error:', err.message);
        res.status(500).json({ error: 'Failed to verify report', detail: err.message });
    } finally {
        client.release();
    }
});

/* GET /api/reports/:id/verify/check — check if a voter_token has already verified */
router.get('/reports/:id/verify/check', async (req, res) => {
    const { id } = req.params;
    const { voter_token } = req.query;
    if (!voter_token) return res.status(400).json({ error: 'voter_token query param required' });

    try {
        const { rows } = await pool.query(
            'SELECT id FROM user_verifications WHERE report_id = $1 AND voter_token = $2',
            [id, voter_token]
        );
        res.json({ verified: rows.length > 0 });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
